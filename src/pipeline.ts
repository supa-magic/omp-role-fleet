/**
 * Single pipeline: task → role plan → static gate → agent emission.
 *
 * Default: zero configuration. Role models are omp model-role aliases resolved
 * by the host at launch.
 * Exception: an explicit allowlist file (`--allowlist` or
 * `ROLE_FLEET_ALLOWLIST`) pins concrete selectors for every seat the file
 * describes; a seat it does not describe keeps its `@` alias with a note.
 */
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GateVerdict, Fleet, RolePlan, RoleSpec } from "./core.ts";
import { planWaves } from "./core.ts";
import { mergeProposals, synthesizePlan } from "./synthesize.ts";
import { proposeSpecialists, shouldPropose, type RoleProposer } from "./generate.ts";
import { gatePlan } from "./gate.ts";
import { filterToSeats } from "./confirm.ts";
import { dispatchGroups, emitAgents, pruneRunDirs, type DispatchGroup, type EmittedAgent } from "./agents.ts";

/** Run directories kept under `<repo>/.role-fleet/`. Enough for a multi-wave
 *  run plus recent history, without letting the tree grow without bound. */
const RUN_DIR_RETENTION = 10;

/** A prompt is not a shell, so `~` arrives literally and `readFile` cannot
 *  resolve it. Exported so the command flag parser expands once, early, and
 *  this is the backstop for every other caller. */
export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function loadAllowlist(path: string): Promise<Fleet> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Fleet>;
  if (!Array.isArray(parsed.models) || !parsed.models.length) {
    throw new Error(`${path}: "models" must be a non-empty array`);
  }
  // Shape checks here, with the path and index, because the alternative is a
  // bare TypeError from deep inside binding — `undefined.toLowerCase()` on a
  // model with no selector, or a role entry with no name to normalize.
  parsed.models.forEach((m, i) => {
    if (!m || typeof m.selector !== "string" || !m.selector.trim()) {
      throw new Error(`${path}: models[${i}] needs a non-empty "selector"`);
    }
    if (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.some((a) => typeof a !== "string"))) {
      throw new Error(`${path}: models[${i}].aliases must be an array of strings`);
    }
    if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
      throw new Error(`${path}: models[${i}].enabled must be true or false`);
    }
  });
  if (parsed.roles !== undefined && !Array.isArray(parsed.roles)) {
    throw new Error(`${path}: "roles" must be an array`);
  }
  parsed.roles?.forEach((r, i) => {
    if (!r || typeof r.role !== "string" || !r.role.trim()) {
      throw new Error(`${path}: roles[${i}] needs a non-empty "role"`);
    }
    if (r.chain !== undefined && (!Array.isArray(r.chain) || r.chain.some((c) => typeof c !== "string"))) {
      throw new Error(`${path}: roles[${i}].chain must be an array of model selectors or aliases`);
    }
    // Seat aliases reach the same `normalizeSeat` lookup as model aliases, so
    // they get the same check: without it a numeric alias surfaced as
    // `value.trim is not a function` from inside binding, with no path or index.
    if (r.aliases !== undefined && (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== "string"))) {
      throw new Error(`${path}: roles[${i}].aliases must be an array of strings`);
    }
  });
  return {
    models: parsed.models.map((m) => ({
      ...m,
      aliases: m.aliases ?? [],
      enabled: m.enabled ?? true,
    })),
    roles: parsed.roles ?? [],
  };
}

export interface RunOptions {
  task: string;
  cwd: string;
  /** Plan only — no files written. */
  dryRun?: boolean;
  maxRoles?: number;
  /** Explicit allowlist path; defaults to `ROLE_FLEET_ALLOWLIST` when set. */
  allowlist?: string;
  /** Review council size (default 3 when triggered). */
  council?: number;
  /**
   * Explicit review models, in order. Two or more imply a council; a single one
   * retargets the reviewer the plan already has.
   */
  models?: string[];
  /** Model that reconciles the council's reports; absent = the session model. */
  consul?: string;
  /** Scout + review seats only; suppresses the code cast and the proposal tier. */
  reviewOnly?: boolean;
  /** Cheap model call for the dynamic tier; injected, absent = static only. */
  propose?: RoleProposer;
  /**
   * Resolve a selector or alias to the concrete `provider/id` it runs on.
   * Injected from the host (`ctx.models.resolve`) and absent = roles keep the
   * alias only. Display-only: `bindFleet` and the gate still reason about the
   * pinned selector.
   */
  resolveModel?: (spec: string) => string | undefined;
  /**
   * Ask before anything is written or dispatched. Receives the approved plan
   * and returns the seat ids to keep, or `null` to abandon the run. Absent — or
   * a host with no interactive UI — dispatches without asking.
   */
  confirm?: (plan: RolePlan) => Promise<ReadonlySet<string> | null>;
}

export interface RunResult {
  plan: RolePlan | null;
  verdict: GateVerdict;
  waves: RoleSpec[][];
  agents: EmittedAgent[];
  groups: DispatchGroup[];
  agentDir: string | null;
  ok: boolean;
  /**
   * The user said no at the confirmation dialog.
   *
   * Not a failure: nothing broke and nothing is wrong with the plan. Rendering it
   * through the error channel reports a considered decision as a plugin fault, so
   * the surface asks for an info-level notice instead.
   */
  abandoned?: boolean;
}

/**
 * Last millisecond handed out, so ids stay strictly increasing.
 *
 * The prune guard spares a file only when its owner sorts *greater* than the
 * current run (`owner > currentRunId`). That makes ordering, not uniqueness, the
 * property that matters: two same-millisecond runs sharing an id compare equal,
 * so the guard does not fire and each deletes the other's in-flight agents. A
 * random suffix would break the tie but leave the order a coin flip — the
 * lexically larger id still deletes the other's files. A monotonic bump fixes
 * both: ids stay numeric, stay ordered, and stay unique.
 */
let lastRunMs = 0;
function nextRunId(): string {
  const now = Date.now();
  const ms = now > lastRunMs ? now : lastRunMs + 1;
  lastRunMs = ms;
  return `run-${ms}`;
}

export async function runRoleFleet(opts: RunOptions): Promise<RunResult> {
  // Expansion belongs here, at the one place a path is actually opened: the
  // tool takes a raw string from a model and the env var comes from whatever
  // set it, and neither goes through the command flag parser. A relative path
  // resolves against the session's `cwd`, like agent files and artifacts do —
  // not the process working directory, which is wherever omp happened to start.
  const raw = expandHome(opts.allowlist ?? process.env.ROLE_FLEET_ALLOWLIST);
  const allowlist = raw && !isAbsolute(raw) ? join(opts.cwd, raw) : raw;
  const fleet = allowlist ? await loadAllowlist(allowlist) : undefined;

  const runId = nextRunId();
  // A council is worth its cost when the user asks for it or the task says
  // "council"/"different providers" explicitly; otherwise one reviewer stands.
  const councilWords = /\b(council|different (models|providers)|multi-model|cross-model)\b/i;
  // A named list is itself the ask for several eyes: `--models a,b` with no
  // `--council` runs exactly two reviewers, because one reviewer per named model
  // is what the list means — padding it to the default three would spend runs
  // the user never asked for on models they did not name.
  const council =
    opts.council ??
    (opts.models?.length ? opts.models.length : councilWords.test(opts.task) ? 3 : 0);
  const councilSize = Math.max(council, opts.models?.length ?? 0);

  let plan = synthesizePlan({
    task: opts.task,
    cwd: opts.cwd,
    workDir: join(opts.cwd, ".role-fleet", runId),
    maxRoles: opts.maxRoles,
    council: councilSize,
    ...(opts.models?.length ? { models: opts.models } : {}),
    ...(opts.consul ? { consul: opts.consul } : {}),
    ...(opts.reviewOnly ? { reviewOnly: true } : {}),
  });
  // The run id travels with the plan: the agent files carry it, so a later run
  // can tell "stale file from a finished run" from "file a concurrent run is
  // still using" and leave the latter alone.
  plan = { ...plan, runId };

  // Dynamic tier: when the static cast is clearly thin for this task, one
  // cheap call may propose specialists. Any doubt keeps the static cast —
  // the proposal is an upgrade, never a dependency.
  // A review-only ask is explicit about its cast, so the proposal tier is off:
  // a model proposing extra specialists would add seats the user just ruled
  // out, and a proposed writer in a plan that must not write is the exact hole
  // `applySpecialists` now closes for the static tier.
  //
  // Whether the cast holds a writer is read once, here, for both branches: the
  // merge below can strip roles, so recomputing it further down would answer a
  // different question than the one the merge was asked.
  const analysisOnly = !plan.roles.some((r) => r.id === "implementer");
  if (opts.propose && !opts.reviewOnly) {
    if (shouldPropose(opts.task, analysisOnly)) {
      const proposed = await proposeSpecialists(opts.task, opts.propose);
      if (!proposed?.length) {
        plan.notes.push("specialist proposal rejected — static cast kept");
      } else {
        plan = mergeProposals(plan, proposed, {
          artifactDir: join(opts.cwd, ".role-fleet", runId),
          maxRoles: opts.maxRoles,
          analysisOnly,
        });
      }
    }
  } else if (!opts.reviewOnly && shouldPropose(opts.task, analysisOnly)) {
    // The task asks for specialists and this host has no side turns, so the tier
    // cannot run. Saying so beats a silent skip: the user asked for something the
    // plan is quietly not going to do.
    //
    // `--review-only` is excluded because this is a statement about the *host*.
    // A run that suppressed the tier by flag has a host that could run it, and
    // reporting a missing capability there describes the machine incorrectly.
    plan.notes.push("specialist tier unavailable on this host — static cast kept");
  }

  const gate = gatePlan(plan, fleet);
  if (!gate.ok || !gate.plan) {
    return { plan: null, verdict: gate.verdict, waves: [], agents: [], groups: [], agentDir: null, ok: false };
  }
  // Follows the plan: the confirmation re-gates, and the verdict must describe the
  // cast that actually ships rather than the one that was proposed.
  let verdict = gate.verdict;

  let approved = gate.plan;
  if (fleet && opts.models?.length) {
    // Both retarget the review seats. Binding already ran, so the file wins for
    // the seats it describes; saying so beats a plan whose models silently
    // differ from the ones the user typed.
    approved.notes.push(`--models overridden by the allowlist for the seats it describes`);
  }

  // Resolve aliases before anything is shown to anyone. A confirmation screen
  // that lists `@slow — unresolved` for every seat is answering the question
  // "who is answering" with the one string that cannot: asking first and
  // resolving after meant the dialog could only ever print aliases, which is
  // exactly what it is for. Binding has already run, so an allowlist selector
  // and an `@slow` alias both land here, and the host's own resolution is the
  // only authority on which provider answered. A selector that resolves to
  // nothing stays unresolved rather than being reported as a guess.
  const resolved = opts.resolveModel
    ? {
        ...approved,
        roles: approved.roles.map((r) => {
          const concrete = opts.resolveModel!(r.model);
          return concrete && concrete !== r.model ? { ...r, modelResolved: concrete } : r;
        }),
      }
    : approved;
  approved = resolved;

  // Confirmation happens here: after the gate has approved the shape and the
  // models are known, before any file is written and before the main model is
  // told to dispatch. A seat the user removes takes its dependents with it, and
  // the plan is re-validated so a confirmation can never emit something the gate
  // would have refused.
  //
  // A dry run asks nothing: it writes no file and dispatches nothing, so the
  // dialog is pure friction — and declining one reported a plugin failure for a
  // run that was never going to happen. `--dry-run` means "show me the cast
  // without asking", and asking there contradicts the flag.
  if (opts.confirm && !opts.dryRun) {
    const chosen = await opts.confirm(approved);
    if (chosen === null) {
      return {
        plan: null,
        verdict: {
          verdict: "reject",
          reason: "run abandoned at confirmation",
          issues: ["no seats were dispatched"],
        },
        waves: [],
        agents: [],
        groups: [],
        agentDir: null,
        ok: false,
        abandoned: true,
      };
    }
    const kept = filterToSeats(approved.roles, chosen);
    const dropped = approved.roles.filter((r) => !kept.includes(r)).map((r) => r.id);
    const rechecked = gatePlan({ ...approved, roles: kept });
    if (!rechecked.ok || !rechecked.plan) {
      return {
        plan: null,
        verdict: rechecked.verdict,
        waves: [],
        agents: [],
        groups: [],
        agentDir: null,
        ok: false,
      };
    }
    approved = rechecked.plan;
    // The verdict travels with the plan it describes. Leaving it on the
    // pre-confirmation gate would report "static validation passed" for a cast
    // the user had since changed — and the same field would mean pre-confirm on
    // the success path and post-confirm on the failure path above.
    verdict = rechecked.verdict;
    approved.notes.push(dropped.length ? `confirmed cast: dropped ${dropped.join(", ")}` : "confirmed cast: all seats kept");
  }
  const waves = planWaves(approved.roles);
  if (opts.dryRun) {
    return { plan: approved, verdict, waves, agents: [], groups: [], agentDir: null, ok: true };
  }

  const agentDir = join(opts.cwd, ".omp", "agents");
  const agents = await emitAgents(approved, agentDir);
  // Every run creates a directory under `.role-fleet/`, so the tree is bounded
  // here rather than left to grow one directory per run forever.
  await pruneRunDirs(join(opts.cwd, ".role-fleet"), runId, RUN_DIR_RETENTION);
  return {
    plan: approved,
    verdict,
    waves,
    agents,
    groups: dispatchGroups(agents),
    agentDir,
    ok: true,
  };
}