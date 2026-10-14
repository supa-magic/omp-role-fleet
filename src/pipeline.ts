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
import { synthesizePlan } from "./synthesize.ts";
import { proposeSpecialists, shouldPropose, type RoleProposer } from "./generate.ts";
import { gatePlan } from "./gate.ts";
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
  /** Force the dynamic specialist tier regardless of the heuristic. */
  specialist?: boolean;
  /** Review council size (default 3 when triggered). */
  council?: number;
  /** Cheap model call for the dynamic tier; injected, absent = static only. */
  propose?: RoleProposer;
}

export interface RunResult {
  plan: RolePlan | null;
  verdict: GateVerdict;
  waves: RoleSpec[][];
  agents: EmittedAgent[];
  groups: DispatchGroup[];
  agentDir: string | null;
  ok: boolean;
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
  const council = opts.council ?? (councilWords.test(opts.task) ? 3 : 0);

  let plan = synthesizePlan({
    task: opts.task,
    cwd: opts.cwd,
    workDir: join(opts.cwd, ".role-fleet", runId),
    maxRoles: opts.maxRoles,
    council,
  });
  // The run id travels with the plan: the agent files carry it, so a later run
  // can tell "stale file from a finished run" from "file a concurrent run is
  // still using" and leave the latter alone.
  plan = { ...plan, runId };

  // Dynamic tier: when the static cast is clearly thin for this task, one
  // cheap call may propose specialists. Any doubt keeps the static cast —
  // the proposal is an upgrade, never a dependency.
  if (opts.propose) {
    const analysisOnly = !plan.roles.some((r) => r.id === "implementer");
    if (opts.specialist || shouldPropose(opts.task, analysisOnly)) {
      const proposed = await proposeSpecialists(opts.task, opts.propose);
      if (!proposed?.length) {
        plan.notes.push("specialist proposal rejected — static cast kept");
      } else {
        const base = new Set(plan.roles.map((r) => r.id));
        // A proposal may not claim an id the plan already uses. The parser
        // refuses the static cast and the hand-written specialists, but the
        // council mints `reviewer-c1`… at synthesis time, so a proposal could
        // still collide — and `validatePlan` would then refuse the *whole plan*,
        // destroying a healthy run over one bad proposal. The proposal is the
        // optional part; it is the one that goes.
        const colliding = proposed.filter((r) => base.has(r.id)).map((r) => r.id);
        if (colliding.length) {
          plan.notes.push(`specialist proposal rejected — id already in use: ${colliding.join(", ")}`);
        } else {
          // The cap is a fan-out control, not a per-tier one: the static cast is
          // already trimmed, and without re-applying it here `--max-roles 2
          // --specialist` would ship a static cast plus three proposals.
          const slots = Math.max(0, (opts.maxRoles ?? 4) - plan.roles.length);
          const kept = proposed.slice(0, slots);
          const dropped = proposed.slice(slots).map((r) => r.id);
          // A proposed dependency on a seat the plan does not contain cannot
          // be honoured. Dropping it silently makes the role run earlier than
          // the proposal asked for — every other drop in this pipeline is
          // reported, so this one is too.
          const severed: string[] = [];
          const merged = [...plan.roles, ...kept.map((r) => {
            const depends_on = r.depends_on.filter((d) => base.has(d) || kept.some((p) => p.id === d));
            for (const droppedDep of r.depends_on.filter((d) => !depends_on.includes(d))) {
              severed.push(`${r.id} → ${droppedDep}`);
            }
            return { ...r, artifact: `${join(opts.cwd, ".role-fleet", runId, r.id)}.md`, depends_on };
          })];
          if (kept.length) {
            plan.notes.push(`generated specialists: ${kept.map((r) => r.id).join(", ")}`);
          }
          if (dropped.length) {
            plan.notes.push(`role cap ${opts.maxRoles ?? 4}: dropped ${dropped.join(", ")}`);
          }
          if (severed.length) {
            plan.notes.push(`dependency left the plan, role now waits on its remaining deps: ${severed.join(", ")}`);
          }
          plan = { ...plan, roles: merged };
        }
      }
    }
  } else if (opts.specialist) {
    // Asked for explicitly and cannot run: a host without side turns makes
    // `--specialist` a silent no-op, so the user is told rather than left
    // wondering why the extra roles never appeared.
    plan.notes.push("specialist tier unavailable on this host — static cast kept");
  }

  const gate = gatePlan(plan, fleet);
  if (!gate.ok || !gate.plan) {
    return { plan: null, verdict: gate.verdict, waves: [], agents: [], groups: [], agentDir: null, ok: false };
  }

  const approved = gate.plan;
  const waves = planWaves(approved.roles);
  if (opts.dryRun) {
    return { plan: approved, verdict: gate.verdict, waves, agents: [], groups: [], agentDir: null, ok: true };
  }

  const agentDir = join(opts.cwd, ".omp", "agents");
  const agents = await emitAgents(approved, agentDir);
  // Every run creates a directory under `.role-fleet/`, so the tree is bounded
  // here rather than left to grow one directory per run forever.
  await pruneRunDirs(join(opts.cwd, ".role-fleet"), runId, RUN_DIR_RETENTION);
  return {
    plan: approved,
    verdict: gate.verdict,
    waves,
    agents,
    groups: dispatchGroups(agents),
    agentDir,
    ok: true,
  };
}