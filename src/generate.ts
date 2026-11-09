/**
 * LLM-proposed specialists — the dynamic tier.
 *
 * When a task fits none of the hand-written seats well, one cheap ephemeral
 * model call proposes up to three specialist roles as JSON. Everything the
 * proposal claims is then re-checked against hard constraints before a single
 * role is accepted; on any doubt the caller falls back to the static cast and
 * the plan still ships. A proposal can never invent a model (aliases only),
 * a tool outside the grant list, a dependency that does not resolve, or a role
 * count past the cap.
 *
 * The reply carries one more thing: the proposer's own reading of the task —
 * `analysis` or `change`. The tier exists for a cast the static heuristics
 * could not read, and on such a cast that reading is the only verdict there
 * is, so it decides whether a proposed writer may join.
 */
import type { Effort, RoleSpec } from "./core.ts";
import { BUILD_TOOLS, grantsWrite, SEAT_CATALOG, VOCAB } from "./core.ts";
import { SPECIALISTS } from "./library.ts";

/** One cheap model call; injected so tests run without a provider. */
export type RoleProposer = (task: string) => Promise<string>;

// The aliases a proposal may name: the base cast's own aliases, plus the two
// the catalog does not seat — the designer's, and the vision seat's.
const PROPOSED_ALIAS = [
  SEAT_CATALOG.base.scout.alias,
  SEAT_CATALOG.base.code.alias,
  SEAT_CATALOG.base.review.alias,
  SEAT_CATALOG.base.plan.alias,
  "@designer",
  "@vision",
];
// Derived, not a third copy: the sandbox may grant a proposed role exactly the
// tools a hand-written builder seat gets — a shell included, since a proposed
// implementer that cannot run a check is a builder that cannot report one — so
// the two can never drift apart.
const ALLOWED_TOOLS: readonly string[] = BUILD_TOOLS;
const ALLOWED_EFFORT = new Set<Effort>(["minimal", "low", "medium", "high", "xhigh"]);

const PROMPT = [
  "You propose specialist agent roles for one task. Reply with ONLY a JSON object, no prose:",
  "{\"intent\":\"analysis|change\",\"roles\":[ ...roles... ]}",
  "\"intent\" is \"analysis\" when the task asks to look at, explain or judge something,",
  "and \"change\" when it asks for the tree to change. It is required: a reply without",
  "it is refused whole.",
  "Each role: {\"id\":\"kebab-case-id\",\"title\":\"...\",\"mission\":\"one sentence\",",
  "\"acceptance\":[\"check 1\",\"check 2\"],\"tools\":[...subset of " + JSON.stringify(ALLOWED_TOOLS) + "],",
  "\"effort\":\"one of minimal|low|medium|high|xhigh\",\"model\":\"one of " + JSON.stringify(PROPOSED_ALIAS) + "\",",
  "\"dependsOn\":[\"ids of other proposed roles, usually empty\"]}",
  "At most 3 roles. Read-only analysis gets [\"read\",\"grep\",\"glob\"].",
].join("\n");

interface RawRole {
  id?: unknown;
  title?: unknown;
  mission?: unknown;
  acceptance?: unknown;
  tools?: unknown;
  effort?: unknown;
  model?: unknown;
  dependsOn?: unknown;
}

function validString(value: unknown, maxLen: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLen ? value.trim() : null;
}

function parseRaw(raw: RawRole, declared: Set<string>): RoleSpec | null {
  const id = validString(raw.id, 40);
  const mission = validString(raw.mission, 400);
  if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !mission) return null;
  const title = validString(raw.title, 80) ?? id;
  if (BASE_CAST.has(id)) return null; // never overwrite a built-in seat

  const acceptance = Array.isArray(raw.acceptance)
    ? raw.acceptance
        .map((a) => validString(a, 200))
        .filter((a): a is string => a !== null)
    : [];
  if (acceptance.length < 1) return null;

  // A tool outside the grant list invalidates the element, it is not silently
  // dropped: filtering made `["read","bash"]` a valid read-only role, so a
  // proposal could ask for a tool it may not have and still be accepted — the
  // very thing the sandbox exists to refuse. Same rule as a wrong dependency.
  if (!Array.isArray(raw.tools) || raw.tools.some((t) => typeof t !== "string" || !ALLOWED_TOOLS.includes(t))) {
    return null;
  }
  const tools: string[] = raw.tools;
  if (!tools.length) return null;

  const model = typeof raw.model === "string" && PROPOSED_ALIAS.includes(raw.model) ? raw.model : null;
  if (!model) return null;

  const effort =
    typeof raw.effort === "string" && ALLOWED_EFFORT.has(raw.effort as Effort)
      ? (raw.effort as Effort)
      : "medium";

  // A dependency that does not resolve invalidates the role, it is not
  // silently dropped: a proposal claiming a wrong dependency is a proposal
  // that misunderstood the plan shape.
  if (raw.dependsOn !== undefined && !Array.isArray(raw.dependsOn)) return null;
  const dependsOn: string[] = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((d): d is string => typeof d === "string")
    : [];
  if (Array.isArray(raw.dependsOn) && dependsOn.length !== raw.dependsOn.length) return null;
  if (dependsOn.some((d) => !declared.has(d) && !BASE_CAST.has(d))) return null;

  return {
    id,
    title,
    mission,
    acceptance,
    dependsOn,
    tools: [...new Set(tools)],
    effort,
    needsVision: model === "@vision",
    // A real seat, not a literal "task": allowlist mode routes by seat, so a
    // seat no file can name means the role keeps its alias even in a pinned run.
    // A shell counts as a writer: it is a grant that can change the tree, so a
    // proposal holding one must be refused on a plan that promised it would not.
    core: grantsWrite(tools) ? "implementer" : "reviewer",
    model,
    artifact: "", // the caller assigns the run directory
  };
}

/** IDs the proposal must never claim for itself: the static cast, and the
 *  library specialists — a duplicate id makes `validatePlan` reject the whole
 *  plan, so a colliding proposal must not be able to reach the merge at all.
 *
 *  The specialist half is derived from `SPECIALISTS` rather than copied: a
 *  hand-synced list is correct only until the catalog grows, and the failure is
 *  silent (a proposal that claims `designer` is refused instead of merged). */
const BASE_CAST = new Set([
  ...Object.values(SEAT_CATALOG.base).map((seat) => seat.id),
  ...SPECIALISTS.map((s) => s.spec.id),
]);

/**
 * Whether the proposal's own dependencies form a cycle, or a role depends on
 * itself.
 *
 * A dependency on a static-cast seat is a leaf here: the static cast has its
 * own shape, and the proposal only adds to it. A cycle among the proposed
 * roles, though, is a plan that can never be scheduled — the seats would wait
 * on each other, and the core's conflict wave would ship briefs pointing at
 * artifacts nobody ever writes.
 */
function hasDependencyCycle(roles: readonly RoleSpec[]): boolean {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const open = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (open.has(id)) return true;
    if (done.has(id)) return false;
    open.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      if (visit(dep)) return true;
    }
    open.delete(id);
    done.add(id);
    return false;
  };
  return roles.some((role) => visit(role.id));
}

/**
 * What the proposer says the task is: an ask to look, or an ask to change.
 *
 * The static tier reads the task with a vocabulary of English words, so a task
 * it cannot read leaves a degenerate cast — one investigator — with no verdict
 * on the tree at all. The proposer is the only thing that can look at such a
 * task and say which kind it is, and the answer decides whether a proposed
 * writer may join.
 */
export type ProposalIntent = "analysis" | "change";

/** A proposal that survived every check: the proposer's reading, and its roles. */
export interface ParsedProposal {
  /** The proposer's own reading of the task. */
  intent: ProposalIntent;
  /** The proposed roles, already validated against every hard constraint. */
  roles: RoleSpec[];
}

/**
 * The JSON bodies a reply may carry: the fenced block, or the object the
 * prose is wrapped around.
 *
 * Both are tried, because a model that answers with a sentence around the
 * object is answering correctly — the fence is a convenience, not a contract.
 */
function jsonBodies(reply: string): string[] {
  const bodies: string[] = [];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]?.trim()) bodies.push(fenced[1].trim());
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) bodies.push(reply.slice(first, last + 1));
  return bodies;
}

/**
 * Validate the roles of a proposal. Returns null on any doubt — the caller
 * treats that as "keep the static cast", never as an error worth surfacing.
 */
function parseRoles(items: unknown): RoleSpec[] | null {
  if (!Array.isArray(items) || !items.length || items.length > 3) return null;

  const declared = new Set<string>();
  const ids = new Set<string>();
  for (const item of items) {
    const id = (item as RawRole).id;
    if (typeof id === "string" && id) declared.add(id);
  }
  // A proposal that names the same id twice must be discarded whole, not merged
  // into the static cast: `validatePlan` rejects duplicate role ids, so both
  // elements would survive every per-element check only to fail the gate and
  // take a perfectly good static cast down with them. Same all-or-nothing rule
  // as every other constraint here.
  for (const item of items) {
    const id = (item as RawRole).id;
    if (typeof id !== "string" || !id) continue;
    if (ids.has(id)) return null;
    ids.add(id);
  }

  const roles: RoleSpec[] = [];
  for (const item of items) {
    const role = parseRaw(item as RawRole, declared);
    if (!role) return null; // one bad element invalidates the whole proposal
    roles.push(role);
  }
  // A cycle among the proposed roles — or a role that waits on itself — is a
  // plan that can never run. Refused whole, like every other broken
  // constraint here.
  if (hasDependencyCycle(roles)) return null;
  return roles;
}

/**
 * Parse and validate a proposal. Returns null on any doubt — the caller treats
 * that as "keep the static cast", never as an error worth surfacing.
 *
 * The intent is part of the contract, not a nicety: a reply without one is
 * refused whole, exactly like a reply with a bad tool. The tier exists to
 * cover a cast the static heuristics could not read, and a proposal that does
 * not say what kind of task it is cannot be trusted with a writer — the
 * question it answers is the one that decides whether a seat may write.
 */
export function parseProposal(reply: string): ParsedProposal | null {
  for (const body of jsonBodies(reply)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as { intent?: unknown; roles?: unknown };
    if (record.intent !== "analysis" && record.intent !== "change") continue;
    const roles = parseRoles(record.roles);
    if (!roles) continue;
    return { intent: record.intent, roles };
  }
  return null;
}

/** What the static cast looks like to the tier that may have to cover for it. */
export interface ProposalScope {
  /**
   * Nothing but an investigator: the task matched no shape the static
   * heuristics know — an unknown verb, or another language.
   */
  degenerate: boolean;
  /** The task asks to look, not to change (the static tier's own verdict). */
  analysisOnly: boolean;
}

/**
 * Whether the static cast is weak enough to justify a model call.
 *
 * The tier exists to cover what the heuristics cannot see, so the trigger is
 * "the cast cannot serve this task" — keyed on the *cast*, not on the analysis
 * flag alone. That inversion is the whole point: a degenerate cast carries
 * `analysisOnly: false` (nothing matched a look-verb either), so the tier could
 * never fire on it, and `add a dark mode toggle`, `build a settings page` and
 * every task phrased in another language shipped one investigator with no
 * second chance. A thin *analysis* cast keeps the old path: enough task text
 * for a specialist to be distinguishable from the generic scout.
 */
export function shouldPropose(task: string, scope: ProposalScope): boolean {
  if (VOCAB.specialistAsk.test(task)) return true;
  if (scope.degenerate) return true;
  return scope.analysisOnly && task.split(/\s+/).length >= 5;
}

/**
 * Fetch and validate a proposal. Any failure — proposer unavailable, malformed
 * reply, constraint violation — yields null and the static cast stands.
 */
export async function proposeSpecialists(
  task: string,
  propose: RoleProposer,
): Promise<ParsedProposal | null> {
  let reply: string;
  try {
    reply = await propose(`${PROMPT}\n\nTask: ${task}`);
  } catch {
    return null;
  }
  return parseProposal(reply);
}