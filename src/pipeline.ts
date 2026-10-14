/**
 * Single pipeline: task → role plan → static gate → agent emission.
 *
 * Default: zero configuration. Role models are omp model-role aliases resolved
 * by the host at launch.
 * Exception: an explicit allowlist file (`--allowlist` or
 * `ROLE_FLEET_ALLOWLIST`) pins concrete selectors for every seat the file
 * describes; a seat it does not describe keeps its `@` alias with a note.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdvisorVerdict, Fleet, RolePlan, RoleSpec } from "./core.ts";
import { planWaves } from "./core.ts";
import { synthesizePlan } from "./synthesize.ts";
import { proposeSpecialists, shouldPropose, type RoleProposer } from "./generate.ts";
import { gatePlan } from "./advisor.ts";
import { dispatchGroups, emitAgents, type DispatchGroup, type EmittedAgent } from "./agents.ts";

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
  verdict: AdvisorVerdict;
  waves: RoleSpec[][];
  agents: EmittedAgent[];
  groups: DispatchGroup[];
  agentDir: string | null;
  ok: boolean;
}

export async function runRoleFleet(opts: RunOptions): Promise<RunResult> {
  const allowlist = opts.allowlist ?? process.env.ROLE_FLEET_ALLOWLIST;
  const fleet = allowlist ? await loadAllowlist(allowlist) : undefined;

  const runId = `run-${Date.now()}`;
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
      if (proposed?.length) {
        const base = new Set(plan.roles.map((r) => r.id));
        // The cap is a fan-out control, not a per-tier one: the static cast is
        // already trimmed, and without re-applying it here `--max-roles 2
        // --specialist` would ship a static cast plus three proposals.
        const slots = Math.max(0, (opts.maxRoles ?? 4) - plan.roles.length);
        const kept = proposed.slice(0, slots);
        const dropped = proposed.slice(slots).map((r) => r.id);
        const merged = [...plan.roles, ...kept.map((r) => ({
          ...r,
          artifact: `${join(opts.cwd, ".role-fleet", runId, r.id)}.md`,
          depends_on: r.depends_on.filter((d) => base.has(d) || kept.some((p) => p.id === d)),
        }))];
        if (kept.length) {
          plan.notes.push(`generated specialists: ${kept.map((r) => r.id).join(", ")}`);
        }
        if (dropped.length) {
          plan.notes.push(`role cap ${opts.maxRoles ?? 4}: dropped ${dropped.join(", ")}`);
        }
        plan = { ...plan, roles: merged };
      } else {
        plan.notes.push("specialist proposal rejected — static cast kept");
      }
    }
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