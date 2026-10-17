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
 */
import type { Effort, RoleSpec } from "./core.ts";
import { CAPABILITY_ID, WRITE_TOOLS } from "./core.ts";
import { SPECIALISTS } from "./library.ts";

/** One cheap model call; injected so tests run without a provider. */
export type RoleProposer = (task: string) => Promise<string>;

const PROPOSED_ALIAS = ["@smol", "@task", "@slow", "@plan", "@designer", "@vision"];
// Derived, not a third copy: the sandbox may grant a proposed role exactly the
// tools a hand-written writer seat gets, so the two can never drift apart.
const ALLOWED_TOOLS: readonly string[] = WRITE_TOOLS;
const ALLOWED_EFFORT = new Set<Effort>(["minimal", "low", "medium", "high", "xhigh"]);

const PROMPT = [
  "You propose specialist agent roles for one task. Reply with ONLY a JSON array, no prose.",
  "Each element: {\"id\":\"kebab-case-id\",\"title\":\"...\",\"mission\":\"one sentence\",",
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
    core: tools.some((t) => t === "edit" || t === "write") ? "implementer" : "reviewer",
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
  ...Object.values(CAPABILITY_ID),
  ...SPECIALISTS.map((s) => s.spec.id),
]);

/**
 * Parse and validate a proposal. Returns null on any doubt — the caller treats
 * that as "keep the static cast", never as an error worth surfacing.
 */
export function parseProposal(reply: string): RoleSpec[] | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : reply.slice(reply.indexOf("["), reply.lastIndexOf("]") + 1);
  if (!body.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 3) return null;

  const declared = new Set<string>();
  const ids = new Set<string>();
  for (const item of parsed) {
    const id = (item as RawRole).id;
    if (typeof id === "string" && id) declared.add(id);
  }
  // A proposal that names the same id twice must be discarded whole, not merged
  // into the static cast: `validatePlan` rejects duplicate role ids, so both
  // elements would survive every per-element check only to fail the gate and
  // take a perfectly good static cast down with them. Same all-or-nothing rule
  // as every other constraint here.
  for (const item of parsed) {
    const id = (item as RawRole).id;
    if (typeof id !== "string" || !id) continue;
    if (ids.has(id)) return null;
    ids.add(id);
  }

  const roles: RoleSpec[] = [];
  for (const item of parsed) {
    const role = parseRaw(item as RawRole, declared);
    if (!role) return null; // one bad element invalidates the whole proposal
    roles.push(role);
  }
  return roles;
}

/** Decide whether the static plan is weak enough to justify a model call. */
export function shouldPropose(task: string, planIsAnalysisOnly: boolean): boolean {
  if (/\b(specialist|expert|consultant)\b/i.test(task)) return true;
  // Thin analysis plans earn a proposal once there is enough task text for a
  // specialist to be distinguishable from the generic scout.
  return planIsAnalysisOnly && task.split(/\s+/).length >= 5;
}

/**
 * Fetch and validate a proposal. Any failure — proposer unavailable, malformed
 * reply, constraint violation — yields null and the static cast stands.
 */
export async function proposeSpecialists(
  task: string,
  propose: RoleProposer,
): Promise<RoleSpec[] | null> {
  let reply: string;
  try {
    reply = await propose(`${PROMPT}\n\nTask: ${task}`);
  } catch {
    return null;
  }
  return parseProposal(reply);
}