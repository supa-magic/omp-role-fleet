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

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

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
  depends_on: string[];
  tools: string[];
  effort: Effort;
  needs_vision: boolean;
  /** Where the worker writes its result. */
  artifact: string;
  /** An omp model selector or role alias such as "@smol". */
  model: string;
}

export interface RolePlan {
  task: string;
  cwd: string;
  roles: RoleSpec[];
  notes: string[];
  /** Which run produced this plan; emitted into agent files for prune scoping. */
  runId?: string;
}

/** The gate is binary by design: a plan either ships as-is or is refused with
 *  issues. There is no "amend" path — the caller fixes the task, not the plan. */
export type Verdict = "approve" | "reject";

export interface AdvisorVerdict {
  verdict: Verdict;
  reason: string;
  issues: string[];
  source: "static";
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
      (r.depends_on ?? []).every((d) => done.has(d) || !known.has(d)),
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
    for (const d of r.depends_on ?? []) {
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
    const seat = ridx.get(normalizeSeat(r.core));
    if (!seat) {
      notes.push(`role ${r.id}: seat "${r.core}" not in allowlist — keeping ${r.model}`);
      return r;
    }
    const n = ordinal.get(r.core) ?? 0;
    ordinal.set(r.core, n + 1);
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