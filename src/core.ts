/**
 * Types and pure logic for dynamic role plans.
 *
 * Version A — zero configuration: a role's model is an omp model-role alias
 * (`@smol`, `@plan`, `@task`, `@slow`, `@vision`, plus `@designer` for the UI
 * seat — which is not a stock omp role and only resolves if the user has a
 * `modelRoles.designer` entry), resolved by omp
 * at launch exactly the way hand-written agents resolve theirs. Which concrete
 * model fills each alias is the user's existing `/model` configuration, not a
 * second fleet to maintain here.
 *
 * An explicit allowlist file (`ROLE_FLEET_ALLOWLIST` or `--allowlist`) remains
 * as an exception for pinning: when present, every model the file describes is
 * taken from it, and `bindFleet` enforces that. A seat the file does not
 * describe keeps its alias with a note — the file constrains, it does not have
 * to describe the whole world.
 */

/** What a seat is for, keyed by the words the synthesis heuristics match on. */
export type Capability = "scout" | "plan" | "code" | "test" | "review" | "docs";

/**
 * The seat id each capability mints.
 *
 * In `core` because two modules need it and neither owns it: `synthesizePlan`
 * drafts its seats from it, and the proposal sandbox (`generate.parseProposal`)
 * must refuse exactly these ids. A hand-synced copy there is correct only until
 * this map changes, and the failure is silent — a proposal that claims
 * `designer` is refused rather than merged.
 */
export const CAPABILITY_ID: Record<Capability, string> = {
  scout: "scout",
  plan: "planner",
  code: "implementer",
  test: "tester",
  review: "reviewer",
  docs: "docs-updater",
};

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

/**
 * Tool grants. One definition each, here: the static cast, the specialist
 * catalog and the proposal sandbox all draw from these, so a grant change is
 * one edit rather than three that must agree. A grant list is a security
 * boundary — the proposal sandbox in particular is only as tight as this array.
 */
export const READ_TOOLS = ["read", "grep", "glob"];
export const WRITE_TOOLS = ["read", "grep", "glob", "edit", "write"];

/**
 * Prefix for every generated agent name.
 *
 * omp resolves an agent by name with project definitions replacing bundled
 * ones, so emitting `scout.md` would silently swap the bundled scout for this
 * plan's mission text for the whole session. Namespaced `rf-*` names keep the
 * generated seats and the bundled specialists independent.
 *
 * It lives here rather than beside the emitter because the settled-result
 * observer matches it too: two copies drifting apart would switch the whole
 * model-observation feature off without a sound.
 */
export const AGENT_PREFIX = "rf-";

/**
 * Default cap on generated roles, when the caller names none.
 *
 * One definition, because the cap is a fan-out promise the user reads on the
 * flag help, the tool schema and the notes: three copies of `4` drift the
 * moment one of them is changed. `MAX_ROLES` in the extension entry is the hard
 * ceiling and stays separate — this is the *default*, not the limit.
 */
export const DEFAULT_MAX_ROLES = 4;

/**
 * Council member ids: `reviewer-c1`, `reviewer-c2`, …
 *
 * The pattern is matched in five places (council detection, cap exemptions,
 * roster filtering, dispatch guidance), and a member past the ninth must still
 * count as a member — hence `\d+`, not `\d`. Council size is bounded by
 * `MAX_COUNCIL` in the extension entry, so a copy drifting past that would be a
 * defect; a regex that silently stops matching is the same defect earlier.
 */
export function isCouncilMember(id: string): boolean {
  return /^reviewer-c\d+$/.test(id);
}

/**
 * One line per seat, in the words a person uses.
 *
 * The seat id is machinery (`reviewer-c1`); this is what the seat is *for*, and
 * it is the only thing that can make a cast reviewable by a human: "Reviewer 2"
 * says nothing, "independent review of the change on its own model" says who
 * is paying and what comes back. Lives here rather than beside the emitter
 * because three surfaces read it — the agent picker, the cast confirmation, and
 * the dispatch table — and three copies of the same sentence would drift.
 */
export const SEAT_PURPOSE: Record<string, string> = {
  scout: "maps where the task touches, with file:line evidence",
  planner: "turns the investigation into a locked implementation plan",
  implementer: "implements the plan with the smallest correct change",
  tester: "runs the focused checks and reports their real output",
  reviewer: "reviews the change for correctness, scope, and evidence",
  consul: "reconciles the council's reports into one verdict",
  "docs-updater": "keeps user-facing documentation true to shipped behavior",
  designer: "builds and polishes the interface, accessibility included",
  "security-auditor": "audits the surface for vulnerabilities, with evidence",
  "db-migration-auditor": "reviews the schema change and its rollback path",
};

/** A model an allowlist can pin to: `selector` names it, `aliases` add lookup
 *  names, `enabled: false` takes it out of every chain. */
export interface FleetModel {
  selector: string;
  aliases?: string[];
  enabled?: boolean;
}

/** A seat the allowlist pins. Only these fields are read: `role` names the
 *  seat, `chain` lists models in preference order, `aliases` adds lookup
 *  names for the seat. Anything else a file carries is ignored. */
export interface FleetRole {
  role: string;
  aliases?: string[];
  chain?: string[];
}

export interface Fleet {
  models: FleetModel[];
  roles: FleetRole[];
}

export interface RoleSpec {
  id: string;
  title: string;
  mission: string;
  acceptance: string[];
  /** Fleet seat this executes as (documentation and allowlist-mode routing). */
  core: string;
  dependsOn: string[];
  tools: string[];
  effort: Effort;
  needsVision: boolean;
  /** Where the worker writes its result. */
  artifact: string;
  /** An omp model selector or role alias such as "@smol". */
  model: string;
  /**
   * Concrete `provider/id` resolved from `model` at plan time when the host
   * can answer. Display-only: frontmatter still pins `model` so role aliases
   * and host fallback chains keep working. Absent when unresolved.
   */
  modelResolved?: string;
}

export interface RolePlan {
  task: string;
  cwd: string;
  roles: RoleSpec[];
  notes: string[];
  /** Which run produced this plan; emitted into agent files for prune scoping. */
  runId?: string;
  /**
   * The task asked to look, not to change — so no seat may gain write access.
   *
   * Set by `synthesizePlan` from the structural intent it already computes, and
   * read by the pipeline to gate the dynamic tier. It is carried on the plan
   * rather than recomputed there because "does this cast hold a writer" is not
   * the same question: `migration-runner` and `designer` write under ids that
   * are not `implementer`, so an id test called a plan that ships a writer
   * analysis-only and refused proposed writers for a reason that did not hold.
   * Optional only so a hand-built plan literal typechecks; a real plan always
   * carries it.
   */
  analysisOnly?: boolean;
}

/** The gate is binary by design: a plan either ships as-is or is refused with
 *  issues. There is no "amend" path — the caller fixes the task, not the plan. */
export type Verdict = "approve" | "reject";

export interface GateVerdict {
  verdict: Verdict;
  reason: string;
  issues: string[];
}

/**
 * Role → omp model-role alias.
 *
 * The mapping mirrors what each kind of work needs, not which vendor is cheap:
 * recon wants fast and inexpensive (`@smol`), implementation takes the general
 * subagent role (`@task`) — the planner already did the heavy thinking, and an
 * executor of a locked plan does not need a premium seat — while review and
 * security want the strongest reasoning (`@slow`). The tester runs focused
 * checks and reports real output, which is mechanical, so it rides `@smol`;
 * diagnosing a failure it finds is the implementer's job, not its own.
 * Users retarget a whole class of work by moving one alias in `/model` — no
 * plugin configuration involved.
 */
export const ROLE_ALIAS: Record<string, string> = {
  scout: "@smol",
  planner: "@plan",
  implementer: "@task",
  tester: "@smol",
  reviewer: "@slow",
  security: "@slow",
  "docs-updater": "@smol",
};

export function aliasFor(core: string): string {
  return ROLE_ALIAS[core] ?? "@task";
}

/**
 * Dependency-ordered waves; roles inside a wave run in parallel.
 * A cycle releases the blocked roles together in a final wave so the dispatcher
 * reports the conflict instead of waiting forever.
 */
export function planWaves(roles: RoleSpec[]): RoleSpec[][] {
  const known = new Set(roles.map((r) => r.id));
  const done = new Set<string>();
  const waves: RoleSpec[][] = [];
  const remaining = [...roles];

  while (remaining.length) {
    const wave = remaining.filter((r) =>
      (r.dependsOn ?? []).every((d) => done.has(d) || !known.has(d)),
    );
    if (!wave.length) {
      waves.push(remaining.splice(0, remaining.length));
      break;
    }
    for (const r of wave) {
      done.add(r.id);
      remaining.splice(remaining.indexOf(r), 1);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * Static plan validation. Allowlist enforcement (when a file is in play) lives
 * in `bindFleet`; this pass checks what must hold in every mode.
 */
export function validatePlan(plan: RolePlan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const declared = new Set(plan.roles.map((r) => r.id));

  if (!plan.roles.length) errors.push("plan has no roles");
  for (const r of plan.roles) {
    if (ids.has(r.id)) errors.push(`duplicate role id ${r.id}`);
    ids.add(r.id);
    if (!r.model) errors.push(`role ${r.id}: no model`);
    if (!r.acceptance.length) errors.push(`role ${r.id}: no acceptance criteria`);
    if (!r.artifact) errors.push(`role ${r.id}: no artifact path`);
    for (const d of r.dependsOn ?? []) {
      if (!declared.has(d)) errors.push(`role ${r.id}: unknown dependency ${d}`);
    }
  }
  return errors;
}

/**
 * Lookup key for seats and models: trimmed, case-folded, punctuation-folded.
 *
 * One normalizer for both indexes on purpose. A hand-edited allowlist with a
 * trailing space or a different slash spelling must resolve, not silently fall
 * through to "seat not in allowlist" and leave an alias in a pinned run.
 */
export function normalizeSeat(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function modelIndex(fleet: Fleet): Map<string, FleetModel> {
  const idx = new Map<string, FleetModel>();
  for (const m of fleet.models) {
    idx.set(normalizeSeat(m.selector), m);
    for (const a of m.aliases ?? []) idx.set(normalizeSeat(a), m);
  }
  return idx;
}

function roleIndex(fleet: Fleet): Map<string, FleetRole> {
  const idx = new Map<string, FleetRole>();
  for (const r of fleet.roles) {
    idx.set(normalizeSeat(r.role), r);
    for (const a of r.aliases ?? []) idx.set(normalizeSeat(a), r);
  }
  return idx;
}

/**
 * Allowlist mode: replace aliases with concrete selectors from the file.
 *
 * A role whose seat is absent from the file keeps its alias and a note — the
 * file constrains, it does not have to describe the whole world.
 *
 * Several roles can share one seat (a review council is three seats called
 * `reviewer`), so binding is ordinal per seat: member N takes the Nth usable
 * model of that seat's chain. Binding them all to the first entry would turn
 * "review with different providers" into three copies of one model at triple
 * the cost — the shared blind spot the council exists to avoid.
 */
export function bindFleet(fleet: Fleet, roles: RoleSpec[], notes: string[]): RoleSpec[] {
  const ridx = roleIndex(fleet);
  const midx = modelIndex(fleet);
  const ordinal = new Map<string, number>();
  return roles.map((r) => {
    const seatKey = normalizeSeat(r.core);
    const seat = ridx.get(seatKey);
    if (!seat) {
      notes.push(`role ${r.id}: seat "${r.core}" not in allowlist — keeping ${r.model}`);
      return r;
    }
    // The ordinal must be keyed by the *normalized* seat, exactly like the
    // lookup above: "Reviewer" and "reviewer" resolve to one seat, so they must
    // also share one counter — otherwise both take chain[0] and the multi-model
    // spread this whole mechanism exists for collapses.
    const n = ordinal.get(seatKey) ?? 0;
    ordinal.set(seatKey, n + 1);
    const chain = (seat.chain ?? [])
      .map((token) => midx.get(normalizeSeat(token)))
      .filter((m): m is FleetModel => !!m && m.enabled !== false);
    if (!chain.length) {
      notes.push(`role ${r.id}: seat "${r.core}" has no enabled model in its chain — keeping ${r.model}`);
      return r;
    }
    if (n >= chain.length) {
      // The file describes fewer distinct models than this seat has members.
      // Reusing one would quietly undo the spread the seat exists for, so the
      // member keeps its own alias and the plan says the run is partly unpinned.
      notes.push(
        `role ${r.id}: seat "${r.core}" offers ${chain.length} enabled model(s) — keeping ${r.model}`,
      );
      return r;
    }
    return { ...r, model: chain[n].selector };
  });
}