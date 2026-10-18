/**
 * Which model actually ran each seat — read from the host, not self-reported.
 *
 * A seat's brief tells it which model it was *pinned* to. That is intent, and
 * it is exactly what a fallback replaces: the host switches models on a provider
 * failure, and the subagent system prompt carries no model name at all (there is
 * none to read). A seat asked "which model are you?" answers from the one line
 * it was given, so a self-reported model cannot distinguish the intended model
 * from the one that actually produced the report.
 *
 * The ground truth is host-side: every settled `SingleResult` from the `task`
 * tool carries `resolvedModel` (`provider/id[:level]`), `resolvedModelIsFallback`,
 * and `resolvedModelRoute`. This module pairs that with the plan-time resolution
 * recorded when the run dispatched, so the user gets "planned X, ran Y" instead
 * of a guess.
 */
import { AGENT_PREFIX } from "./core.ts";

export interface ExpectedModel {
  /** The selector pinned in the agent file: an alias or a concrete id. */
  pinned: string;
  /** Concrete `provider/id` resolved at plan time, when the host could answer. */
  resolved?: string;
  /** Where this seat's report belongs, and whether the seat can write it. */
  artifact?: string;
  writesOwnReport?: boolean;
}

/** One settled seat whose model differs from what the run expected. */
export interface ModelObservation {
  agent: string;
  /** Concrete model the host reports for the settled run. */
  ran: string;
  /** Plan-time resolution, when the plugin had one. */
  planned?: string;
  /** Host flagged the settled model as the target of a retry fallback. */
  fallback: boolean;
  /** Host routing note (`resolvedModelRoute`), when it gave one. */
  route?: string;
}

/** Run-scoped expectations, keyed by agent definition name (`rf-<role>`). */
let expected = new Map<string, ExpectedModel>();

/**
 * Settled (seat, model) pairs already reported, so a re-delivered envelope is
 * not notified twice.
 *
 * The model is part of the key on purpose. Keying on the seat alone would mute a
 * second, genuinely different settle of that seat — the rescue path re-dispatches
 * `rf-reviewer-c1` and the retry lands on a fallback model, which is precisely
 * the news worth printing, and it would be swallowed by the first quiet settle.
 */
const seen = new Set<string>();

/** Dedupe key for one settled seat running one model. */
function settleKey(agent: string, ran: string): string {
  return `${agent}\u0000${ran}`;
}

/**
 * Record what this run expects, replacing any previous baseline.
 *
 * A dispatch starts a new set of settled runs, and agent names are reused across
 * runs (`rf-reviewer-c1` exists in every one). Both maps must be rebuilt: a kept
 * `seen` entry would silence this run's fallback — the warning would work once
 * per session — and a kept expectation would compare a seat against a model it
 * was never pinned to.
 *
 * `subSession` refuses the write. The baseline is process state shared by every
 * run in it, so a subagent invoking the plan tool would clear the parent's
 * baseline mid-council and the parent's fallbacks would degrade to "no plan-time
 * baseline" — the observation the whole feature exists to make. The other two
 * hook sites already carry this guard; the write path needed it too.
 *
 * Residual, not fixable here: two overlapping *main*-session runs still share one
 * baseline, because a settled `task` result carries an agent name and no run id,
 * so there is nothing in the payload to tell plan A's seat from plan B's. The
 * last dispatch wins and the earlier run's fallbacks are reported without a
 * baseline rather than not at all.
 */
export function recordExpectedModels(
  agents: ReadonlyArray<{
    agent: string;
    model: string;
    modelResolved?: string;
    artifact?: string;
    writesOwnReport?: boolean;
  }>,
  opts: { subSession?: boolean } = {},
): void {
  if (opts.subSession) return;
  seen.clear();
  expected.clear();
  for (const a of agents) {
    expected.set(a.agent, {
      pinned: a.model,
      ...(a.modelResolved ? { resolved: a.modelResolved } : {}),
      ...(a.artifact ? { artifact: a.artifact } : {}),
      ...(a.writesOwnReport !== undefined ? { writesOwnReport: a.writesOwnReport } : {}),
    });
  }
}

/** The expectation recorded for a generated seat, if this process has one. */
export function expectedFor(agent: string): ExpectedModel | undefined {
  return expected.get(agent);
}

/** A new session must not inherit the previous run's expectations. */
export function resetExpectedModels(): void {
  expected = new Map();
  seen.clear();
}

/**
 * `provider/id:high` → `provider/id`: the suffix is a thinking level, not a model.
 *
 * Matched against the level names rather than by position. Comparing the colon and
 * slash indexes looked equivalent and was not: a selector whose id carries a colon
 * before its slash lost everything after that colon and was compared against a
 * model that never existed — a false divergence report on every settle. A suffix
 * that is not one of the level names is part of the id.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
export function baseModel(value: string): string {
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return value;
  return THINKING_LEVELS.includes(value.slice(colon + 1)) ? value.slice(0, colon) : value;
}

interface SettledRun {
  agent?: unknown;
  resolvedModel?: unknown;
  resolvedModelIsFallback?: unknown;
  resolvedModelRoute?: unknown;
}

/**
 * Read the settled fleet results out of a `task` tool_result payload.
 *
 * The host's `details` is `TaskToolDetails` on a task call and an unrelated
 * shape for every other tool, so this narrows structurally instead of trusting
 * the event's tool name alone: a missing `results` array is "not a task result",
 * never "a task with no agents".
 */
export function readTaskResults(details: unknown): SettledRun[] {
  if (typeof details !== "object" || details === null) return [];
  const results = (details as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.filter((r): r is SettledRun => typeof r === "object" && r !== null);
}

/**
 * Compare settled runs against the plan.
 *
 * Only seats this plugin emitted are considered (`rf-` prefix): the parent
 * session runs other task calls, and a fallback in an unrelated agent is not
 * this run's news.
 */
export function observeSettledRuns(details: unknown): ModelObservation[] {
  const observations: ModelObservation[] = [];
  for (const run of readTaskResults(details)) {
    if (typeof run.agent !== "string" || !run.agent.startsWith(AGENT_PREFIX)) continue;
    if (typeof run.resolvedModel !== "string" || !run.resolvedModel) continue;

    const fallback = run.resolvedModelIsFallback === true;
    // The baseline is the resolved model when the host gave one, else the
    // pinned selector — but only when that selector is itself a concrete model.
    // Seats pinned by `--models`, `--consul`, or an allowlist have no
    // `modelResolved` (it is recorded only when it differs from the pin), and
    // reading `resolved` alone left them with no baseline at all: a seat that
    // ran somewhere else passed in silence. An *unresolved alias* is the other
    // side of that: `@designer` is not a model, so treating it as a baseline
    // would report "model changed" on every plain run of that seat.
    const expectation = expected.get(run.agent);
    const planned =
      expectation?.resolved ??
      (expectation?.pinned && !expectation.pinned.startsWith("@") ? expectation.pinned : undefined);
    const ran = baseModel(run.resolvedModel);
    // A fallback the host already flagged, or any model that is not the one the
    // plan recorded. With no usable record there is nothing to disagree with,
    // so a flagged fallback still reports and a plain run does not.
    if (!fallback && (planned === undefined || baseModel(planned) === ran)) continue;

    // Dedupe what would be *reported*, after the divergence test. Marking a
    // seat as seen on sight would let a first quiet settle mute the rescue
    // re-dispatch that follows it — the second, genuinely different model is
    // exactly the news, and it would be swallowed.
    const key = settleKey(run.agent, ran);
    if (seen.has(key)) continue;
    seen.add(key);

    observations.push({
      agent: run.agent,
      ran,
      ...(planned ? { planned: baseModel(planned) } : {}),
      fallback,
      ...(typeof run.resolvedModelRoute === "string" && run.resolvedModelRoute
        ? { route: run.resolvedModelRoute }
        : {}),
    });
  }
  return observations;
}

/** One user-facing line per divergence: what was planned, what actually ran. */
export function renderObservation(o: ModelObservation): string {
  const seats = [
    // With a baseline the line names both sides. Without one the seat has no
    // recorded expectation — an unresolved alias, or a seat this run never
    // dispatched — and blaming "plan time" for either would be a false claim
    // about a resolver failure that did not happen.
    o.planned
      ? `planned \`${o.planned}\`, ran \`${o.ran}\``
      : `ran \`${o.ran}\` (no plan-time baseline for this seat)`,
    o.fallback ? "FALLBACK" : "model changed",
    o.route ? `via ${o.route}` : "",
  ].filter(Boolean);
  return `role-fleet: ${o.agent} — ${seats.join(", ")}`;
}