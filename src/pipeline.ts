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
import { isAbsolute, join } from "node:path";
import type { GateVerdict, Fleet, RolePlan, RoleSpec } from "./core.ts";
import { baseModel, expandHome, planWaves, VOCAB } from "./core.ts";
import { mergeProposals, isDegenerateCast, synthesizePlan } from "./synthesize.ts";
import { proposeSpecialists, shouldPropose, type RoleProposer } from "./generate.ts";
import { gatePlan } from "./gate.ts";
import { councilModelGroups, filterToSeats } from "./confirm.ts";
import { dispatchGroups, emitAgents, pruneRunDirs, writeRunManifest, type DispatchGroup, type EmittedAgent } from "./agents.ts";
import { agentsDir, RUN_DIR_RETENTION, runDir, runIdAt, runsRoot } from "./run-layout.ts";
import { registerRun } from "./seats.ts";

async function loadAllowlist(path: string): Promise<Fleet> {
  // `JSON.parse` reports the offset, not the file: `Unexpected token '}', "{…}"
  // is not valid JSON` names neither the file nor the flag that loaded it,
  // while every shape error below prefixes the path. One contract for both.
  let parsed: Partial<Fleet>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Fleet>;
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  /** Write seats to fan the implementation out across (`implementer-1` …). */
  slices?: number;
  /** Cheap model call for the dynamic tier; injected, absent = static only. */
  propose?: RoleProposer;
  /**
   * Resolve a selector or alias to the concrete `provider/id` it runs on.
   * Injected from the host (`ctx.models.resolve`) and absent = roles keep the
   * alias only. Display-only: `bindFleet` and the gate still reason about the
   * pinned selector.
   */
  resolveModel?: (spec: string) => string | undefined;
  /** Plugin version recorded in the run manifest, when the surface knows it. */
  pluginVersion?: string;
  /**
   * Ask before anything is written or dispatched. Receives the approved plan
   * and returns the seat ids to keep, or `null` to abandon the run. Absent — or
   * a host with no interactive UI — dispatches without asking.
   */
  confirm?: (plan: RolePlan) => Promise<ReadonlySet<string> | null>;
  /**
   * Whether the confirmation is a dialog a human answers or an automatic
   * acceptance. Only the wording of the note changes: a cast nobody was asked
   * about was auto-accepted, and saying "confirmed" for it claims a decision
   * that never happened.
   */
  confirmMode?: "ask" | "auto";
  /**
   * Hand the approved plan to the surface that dispatches it (the command sends
   * it to the main model; the tool has no dispatch step). Absent = emit only.
   * Called after the manifest is written, so a failure here leaves a complete
   * on-disk record and an explicit `dispatchError` rather than pretending the
   * run succeeded.
   */
  onDispatch?: (result: RunResult) => Promise<void> | void;
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
  /** Why the dispatch callback failed, when it did. */
  dispatchError?: string;
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

/** What both surfaces asked for, made usable once. */
interface Request {
  fleet?: Fleet;
  models: string[];
  consul?: string;
  councilSize: number;
  notes: string[];
}

/** A run that ends before anything is written. */
function stopped(verdict: GateVerdict, extra: Partial<RunResult> = {}): RunResult {
  return { plan: null, verdict, waves: [], agents: [], groups: [], agentDir: null, ok: false, ...extra };
}

/**
 * Load the allowlist and normalise the review-seat fields.
 *
 * The command normalises its list while parsing; the tool hands over a raw JSON
 * array. This is the one place both pass through, so the value rules live here:
 * blanks and exact duplicates drop, thinking-level variants of one model
 * collapse onto the first spelling (two members on one model is the
 * double-priced single review the list exists to avoid), and a blank consul is
 * no consul — the host cannot resolve it, and pinning it would claim a model
 * the seat never runs on.
 */
async function normalizeRequest(opts: RunOptions): Promise<Request> {
  const notes: string[] = [];
  // Expanded here, where the path is opened: the tool and the env var never go
  // through the flag parser. Relative paths resolve against the session cwd.
  //
  // A blank parameter is an absent one. The tool hands over a raw string, and
  // an empty or whitespace-only value is not nullish, so `??` kept it and it
  // won over `ROLE_FLEET_ALLOWLIST`: the operator's pinned run went out on
  // aliases with nothing said. The environment still applies.
  const asked = opts.allowlist?.trim();
  if (opts.allowlist !== undefined && !asked) {
    notes.push(
      process.env.ROLE_FLEET_ALLOWLIST
        ? "allowlist: a blank path was ignored — ROLE_FLEET_ALLOWLIST applies"
        : "allowlist: a blank path was ignored — no allowlist file is in effect",
    );
  }
  const raw = expandHome(asked ? asked : process.env.ROLE_FLEET_ALLOWLIST);
  const allowlist = raw && !isAbsolute(raw) ? join(opts.cwd, raw) : raw;
  const fleet = allowlist ? await loadAllowlist(allowlist) : undefined;

  const named = opts.models?.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()) ?? [];
  const seenBase: Record<string, string> = {};
  const models: string[] = [];
  for (const model of new Set(named)) {
    const key = baseModel(model);
    const prior = Object.hasOwn(seenBase, key) ? seenBase[key] : undefined;
    if (prior !== undefined) {
      notes.push(`review models: ${model} is ${prior} with a thinking-level suffix — dropped`);
      continue;
    }
    seenBase[key] = model;
    models.push(model);
  }
  const dropped = (opts.models?.length ?? 0) - models.length;
  if (dropped > 0) {
    notes.push(
      `review models: ${dropped} blank or duplicate entr${dropped > 1 ? "ies" : "y"} dropped${
        models.length ? ` (${models.length} left)` : ""
      }`,
    );
  }
  const consul = opts.consul?.trim() || undefined;
  if (opts.consul !== undefined && !consul) {
    notes.push("consul: a blank selector was ignored — the session model will synthesize");
  }
  // A named list is itself the ask for several eyes: one reviewer per named
  // model, never padded to the default three.
  const council = opts.council ?? (models.length ? models.length : VOCAB.council.test(opts.task) ? 3 : 0);
  return {
    ...(fleet ? { fleet } : {}),
    models,
    ...(consul ? { consul } : {}),
    councilSize: Math.max(council, models.length),
    notes,
  };
}

/**
 * The dynamic tier: when the static cast is clearly thin, one cheap call may
 * propose specialists. Any doubt keeps the static cast. Off for `--review-only`
 * (the user ruled extra seats out). "Unavailable on this host" is checked before
 * the dry-run skip: a dry run must not claim a saving that was never on offer.
 */
async function withProposals(opts: RunOptions, plan: RolePlan, runId: string): Promise<RolePlan> {
  // Read once, before the merge can strip roles: the static tier decided
  // structurally whether this task asks for analysis, and a cast can hold a
  // writer under an id that is not `implementer`.
  const analysisOnly = plan.analysisOnly ?? false;
  const scope = { degenerate: isDegenerateCast(plan.roles), analysisOnly };
  if (opts.reviewOnly || !shouldPropose(opts.task, scope)) return plan;
  const note = (text: string): RolePlan => ({ ...plan, notes: [...plan.notes, text] });
  if (!opts.propose) return note("specialist tier unavailable on this host — static cast kept");
  if (opts.dryRun) return note("dry run: specialist tier skipped — it is a paid model call");
  const proposed = await proposeSpecialists(opts.task, opts.propose);
  if (!proposed?.roles.length) return note("specialist proposal rejected — static cast kept");
  // On a degenerate cast the static tier's own verdict is worth nothing: it is
  // degenerate *because* it could not read the task, so it never decided
  // whether the tree may change — it only failed to. The proposer's reading is
  // the verdict that exists, so an "analysis" answer makes the plan
  // analysis-only and a proposed writer is refused exactly as it would be on a
  // cast the static tier had read. A "change" answer leaves the plan alone:
  // it cannot raise a verdict the static tier reached on its own.
  const readsAsAnalysis = scope.degenerate && proposed.intent === "analysis";
  const merged = mergeProposals(
    readsAsAnalysis ? { ...plan, analysisOnly: true } : plan,
    proposed.roles,
    {
      artifactDir: runDir(opts.cwd, runId),
      maxRoles: opts.maxRoles,
      analysisOnly: analysisOnly || readsAsAnalysis,
    },
  );
  if (!readsAsAnalysis) return merged;
  return { ...merged, notes: [...merged.notes, "specialist tier: the proposer read this task as analysis — no seat may change the code"] };
}

/**
 * Resolve one seat's selector against the host.
 *
 * The host's resolver is the only authority on which provider answers, so a
 * selector it cannot resolve is not a model at all: the seat runs on whatever
 * the parent session falls back to. A concrete selector somebody named — a
 * `--models` entry, a `--consul`, an allowlist pin — is a *claim* about a
 * model, so it is marked unresolved and the plan says so. An `@`-alias is only
 * a request; it keeps the wording it always had.
 */
function resolveSeat(role: RoleSpec, resolve: (spec: string) => string | undefined): RoleSpec {
  const concrete = resolve(role.model);
  if (concrete) return concrete === role.model ? role : { ...role, modelResolved: concrete };
  // A thinking level is not part of the model identity: `provider/id:high` is
  // the model `provider/id` at another effort, so a host that answers for the
  // bare selector has answered the question the suffix asked.
  const base = baseModel(role.model);
  if (base !== role.model) {
    const resolvedBase = resolve(base);
    if (resolvedBase) return { ...role, modelResolved: resolvedBase };
  }
  if (role.model.startsWith("@")) return role;
  return { ...role, modelUnresolved: true };
}

/**
 * Synthesize, propose, gate, and resolve: the cast the user is asked about.
 * Aliases are resolved before anything is shown, so the dialog can name the
 * models it is asking the user to pay for.
 */
async function planCast(
  opts: RunOptions,
  req: Request,
  runId: string,
): Promise<{ plan: RolePlan; verdict: GateVerdict } | { stop: RunResult }> {
  const synthesized = synthesizePlan({
    task: opts.task,
    cwd: opts.cwd,
    workDir: runDir(opts.cwd, runId),
    maxRoles: opts.maxRoles,
    council: req.councilSize,
    ...(req.models.length ? { models: req.models } : {}),
    ...(req.consul ? { consul: req.consul } : {}),
    ...(opts.reviewOnly ? { reviewOnly: true } : {}),
    ...(opts.slices && opts.slices > 1 ? { slices: opts.slices } : {}),
  });
  // The run id travels with the plan: agent files carry it, so a later run can
  // tell a finished run's stale file from one a concurrent run still uses.
  const plan = await withProposals(
    opts,
    { ...synthesized, notes: [...synthesized.notes, ...req.notes], runId },
    runId,
  );

  const gate = gatePlan(plan, req.fleet);
  if (!gate.ok || !gate.plan) return { stop: stopped(gate.verdict) };
  const notes = [...gate.plan.notes];

  if (req.fleet && req.models.length) {
    // The file wins for the seats it describes; name each seat it moved, with
    // both models. Only seats the named list itself set count as overridden.
    const before = new Map(plan.roles.map((r) => [r.id, r.model]));
    const moved = gate.plan.roles
      .filter((r) => r.core === "reviewer" && before.get(r.id) !== r.model && req.models.includes(before.get(r.id) ?? ""))
      .map((r) => `${r.id} ${before.get(r.id)} → ${r.model}`);
    if (moved.length) notes.push(`--models overridden by the allowlist: ${moved.join(", ")}`);
  }

  // The host's own resolution is the only authority on which provider answers;
  // a selector that resolves to nothing stays unresolved rather than guessed.
  const resolve = opts.resolveModel;
  const roles = resolve ? gate.plan.roles.map((r) => resolveSeat(r, resolve)) : gate.plan.roles;
  // A named selector the host cannot resolve is a promise the run cannot keep:
  // the seat rides the parent session's model, and the user is told that here
  // rather than discovering it from a fallback notice after the money is spent.
  for (const r of roles) {
    if (r.modelUnresolved) {
      notes.push(`model unresolved: ${r.model} — the seat runs on the session model`);
    }
  }

  // Resolution is the first point a collapsed council is knowable; this is the
  // last note before the spend.
  for (const [model, ids] of councilModelGroups(roles).groups) {
    if (ids.length < 2) continue;
    notes.push(`council independence: ${ids.join(", ")} all resolve to ${model} — ${ids.length} paid reviews share one model`);
  }
  return { plan: { ...gate.plan, roles, notes }, verdict: gate.verdict };
}

/**
 * Ask before anything is written or dispatched. A removed seat takes its
 * dependents with it, and the result is re-gated so a confirmation can never
 * emit what the gate would refuse. A dry run asks nothing — it writes and
 * dispatches nothing, so the dialog would be pure friction.
 */
async function confirmCast(
  opts: RunOptions,
  plan: RolePlan,
  verdict: GateVerdict,
): Promise<{ plan: RolePlan; verdict: GateVerdict } | { stop: RunResult }> {
  if (!opts.confirm || opts.dryRun) return { plan, verdict };
  const chosen = await opts.confirm(plan);
  if (chosen === null) {
    return {
      stop: stopped(
        { verdict: "reject", reason: "run abandoned at confirmation", issues: ["no seats were dispatched"] },
        { abandoned: true },
      ),
    };
  }
  const kept = filterToSeats(plan.roles, chosen);
  const dropped = plan.roles.filter((r) => !kept.includes(r)).map((r) => r.id);
  // No fleet: binding already ran and is idempotent on its own selectors, so
  // seat ordinals freeze at the first bind — dropping `reviewer-c1` leaves
  // `reviewer-c2` on its model rather than re-spreading the chain.
  const rechecked = gatePlan({ ...plan, roles: kept });
  if (!rechecked.ok || !rechecked.plan) return { stop: stopped(rechecked.verdict) };
  // The verdict travels with the cast it describes. A cast nobody was asked
  // about was auto-accepted, and calling that "confirmed" claims a decision
  // that never happened: the agent-driven path and `--yes` both land here.
  const wording = opts.confirmMode === "auto" ? "auto-accepted cast" : "confirmed cast";
  return {
    plan: {
      ...rechecked.plan,
      notes: [
        ...rechecked.plan.notes,
        dropped.length ? `${wording}: dropped ${dropped.join(", ")}` : `${wording}: all seats kept`,
      ],
    },
    verdict: rechecked.verdict,
  };
}

/**
 * Write the run: agent files, bounded run tree, manifest, seat registry, then
 * hand it to the surface that dispatches. A dispatch failure leaves a complete
 * on-disk record and an explicit `dispatchError`.
 */
async function materialize(opts: RunOptions, approved: RolePlan, verdict: GateVerdict, runId: string): Promise<RunResult> {
  const waves = planWaves(approved.roles);
  if (opts.dryRun) return { plan: approved, verdict, waves, agents: [], groups: [], agentDir: null, ok: true };

  const agentDir = agentsDir(opts.cwd);
  const emitted = await emitAgents(approved, agentDir);
  const plan = { ...approved, notes: [...approved.notes, ...emitted.notes] };
  const { agents } = emitted;
  // Prune before the manifest: prune spares the current run by construction.
  await pruneRunDirs(runsRoot(opts.cwd), runId, RUN_DIR_RETENTION);
  await writeRunManifest(runDir(opts.cwd, runId), {
    runId,
    task: opts.task,
    startedAt: runIdAt(runId),
    notes: plan.notes,
    agents,
    outcomes: [],
    ...(opts.pluginVersion ? { pluginVersion: opts.pluginVersion } : {}),
  });
  // Seats settle and call tools in their own sessions against this record;
  // registered before dispatch, so a fast seat cannot settle ahead of it.
  registerRun(opts.cwd, runId, agents);
  const result: RunResult = { plan, verdict, waves, agents, groups: dispatchGroups(agents), agentDir, ok: true };
  if (!opts.onDispatch) return result;
  try {
    await opts.onDispatch(result);
    return result;
  } catch (err) {
    return { ...result, ok: false, dispatchError: err instanceof Error ? err.message : String(err) };
  }
}

export async function runRoleFleet(opts: RunOptions): Promise<RunResult> {
  const req = await normalizeRequest(opts);
  const runId = nextRunId();
  const cast = await planCast(opts, req, runId);
  if ("stop" in cast) return cast.stop;
  const confirmed = await confirmCast(opts, cast.plan, cast.verdict);
  if ("stop" in confirmed) return confirmed.stop;
  return materialize(opts, confirmed.plan, confirmed.verdict, runId);
}