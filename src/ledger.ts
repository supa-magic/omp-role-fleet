/**
 * The post-dispatch ledger, run from the seat's own session.
 *
 * The plan manifest records intent before anything runs. A seat closes the loop
 * when it yields: the host hands the extension the yielded payload
 * (`tool_execution_end` for `yield`) in the seat's session, whatever the parent's
 * `async.enabled` says — the parent's own `task` result carries no seat results
 * when seats run as background jobs, which is the host default. From there the
 * ledger:
 *
 *  - places every seat's full `report` at the artifact path its downstream
 *    siblings are told to read, so the main model never re-types it;
 *  - appends the seat's outcome — model that ran, fallback, verdict, duration —
 *    to `plan.json`, so a finished run can be audited after the session is gone.
 *
 * A failed or aborted yield places nothing: a downstream seat reading an error
 * transcript as its upstream report is worse than a missing file the main model
 * is told to notice. A successful yield that carries no report is the same
 * absence, and it is recorded as one: the outcome says the seat yielded no
 * report, no artifact is claimed, and the main session is warned — a report
 * that silently vanished left `/role-fleet status` showing a healthy run.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baseModel, type RunOutcome } from "./core.ts";
import { observeSeat, plannedModel, type ModelObservation } from "./model-observed.ts";
import { artifactInsideRun, notify, type SeatRecord } from "./seats.ts";

/** The report and verdict a seat yielded in pieces. */
export interface SeatSections {
  report?: string;
  verdict?: string;
}

/** What one seat's session saw when the seat yielded. */
export interface SeatYield {
  /** The seat as its session first saw it — pinned, not looked up by name. */
  record: SeatRecord;
  /** `details` of the settled `yield` call: `{ data, status, error }`. */
  details: unknown;
  /** The sections the seat yielded so far, when its report arrived in pieces. */
  sections?: SeatSections;
  /** The session's live model (`provider/id`) at the yield. */
  ran?: string;
  /** The seat's model before its own retry fallback replaced it. */
  fallbackFrom?: string;
  durationMs?: number;
}

export interface SettleResult {
  outcome?: RunOutcome;
  /** Artifact path written from the seat's report. */
  written?: string;
  observation?: ModelObservation;
  /** False when the outcome could not be appended to the run manifest. */
  recorded?: boolean;
}

/** A non-empty string, or undefined: a blank field is no field. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The report and verdict one payload carries, in the object shape. */
function payloadFields(data: unknown): { report?: string; verdict?: string } {
  if (typeof data !== "object" || data === null) return {};
  const d = data as { report?: unknown; verdict?: unknown };
  const out: { report?: string; verdict?: string } = {};
  const report = text(d.report);
  if (report) out.report = report;
  const verdict = text(d.verdict);
  if (verdict) out.verdict = verdict;
  return out;
}

function yieldFields(details: unknown): { status?: string; error?: string; report?: string; verdict?: string } {
  if (typeof details !== "object" || details === null) return {};
  const d = details as { status?: unknown; error?: unknown; data?: unknown };
  const out: { status?: string; error?: string; report?: string; verdict?: string } = {};
  const status = text(d.status);
  if (status) out.status = status;
  const error = text(d.error);
  if (error) out.error = error;
  const fields = payloadFields(d.data);
  if (fields.report) out.report = fields.report;
  if (fields.verdict) out.verdict = fields.verdict;
  return out;
}

/**
 * The fields one incremental section carried, read by its label.
 *
 * An incremental section (`type: ["report"]`) carries the value of the field it
 * names: the report text under `report`, the verdict under `verdict`. The host
 * assembles the sections into the seat's result after the last one, and the
 * terminal yield can arrive with no data at all — so the plugin has to keep
 * the sections itself, or the report is lost with them.
 *
 * Undefined when the payload is not a section at all: the terminal yield is
 * the seat's result, and the caller settles on it.
 */
export function sectionFields(details: unknown): SeatSections | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const d = details as { type?: unknown; data?: unknown };
  if (!Array.isArray(d.type)) return undefined;
  const labels = d.type.filter((label): label is string => typeof label === "string");
  const out: SeatSections = {};
  if (labels.includes("report")) {
    const report = text(d.data);
    if (report) out.report = report;
  }
  if (labels.includes("verdict")) {
    const verdict = text(d.data);
    if (verdict) out.verdict = verdict;
  }
  // A section whose payload is an object carries the fields themselves.
  const fields = payloadFields(d.data);
  if (!out.report && fields.report) out.report = fields.report;
  if (!out.verdict && fields.verdict) out.verdict = fields.verdict;
  return out;
}

/** Appends per manifest run one at a time: seats of one wave settle together. */
const appendQueue = new Map<string, Promise<unknown>>();
let tempSeq = 0;

/**
 * Append one outcome to the manifest it belongs to.
 *
 * Read-modify-write through a unique temp file and a rename, so a crash leaves
 * the previous complete file; serialized per path, so two seats settling at
 * once cannot drop each other's line. Every yield is one row: a revived seat
 * that yields again is a second, real outcome.
 *
 * False means the outcome is not on disk — the manifest was unreadable, or the
 * write failed. The caller says so rather than letting the run look settled.
 */
function appendOutcome(path: string, outcome: RunOutcome): Promise<boolean> {
  const prior = appendQueue.get(path) ?? Promise.resolve();
  const next = prior.then(async () => {
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      manifest = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const existing = Array.isArray(manifest.outcomes) ? (manifest.outcomes as RunOutcome[]) : [];
    const temp = `${path}.${process.pid}.${++tempSeq}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...manifest, outcomes: [...existing, outcome], updatedAt: Date.now() }, null, 2)}\n`, "utf8");
    await rename(temp, path);
    return true;
  });
  const settled = next.catch(() => false);
  appendQueue.set(path, settled);
  void settled.then(() => {
    if (appendQueue.get(path) === settled) appendQueue.delete(path);
  });
  return settled;
}

/**
 * Record one seat's yield: place its report, append its outcome, and return the
 * model divergence (if any) for the caller to announce. Never throws — a ledger
 * failure must not fail the seat's own tool call.
 *
 * An incremental section (`type: [labels]`) is not the seat's result — the
 * host assembles sections after the last one — so it records nothing; the
 * caller folds it into the sections it hands back with the terminal yield.
 *
 * The report is placed for every seat, writer or not: a writer's own write to
 * the run directory is refused by the host sandbox, so a seat that could write
 * its artifact never did. A yield with no report, and a write that fails, are
 * both recorded as failures and warned about — the alternative is a run whose
 * status says everything is fine and whose artifact is missing.
 */
export async function settleSeat(input: SeatYield): Promise<SettleResult> {
  const { record } = input;
  const { details } = input;
  if (typeof details === "object" && details !== null && "type" in details && Array.isArray(details.type)) return {};
  const fields = yieldFields(input.details);
  // The report may have arrived in pieces: the terminal yield's own field wins,
  // the section the seat folded earlier is the fallback.
  const report = fields.report ?? input.sections?.report;
  const verdict = fields.verdict ?? input.sections?.verdict;
  const aborted = fields.status === "aborted";

  let written: string | undefined;
  let failure: string | undefined;
  if (!aborted) {
    const body = text(report);
    if (!body) {
      failure = "seat yielded no report";
    } else if (!(await artifactInsideRun(dirname(record.manifestPath), record.artifact))) {
      // The report goes where the run directory says, and nowhere else: a path
      // outside it came from a manifest someone edited, and writing there would
      // put a seat's report outside the tree that owns it.
      failure = `report path ${record.artifact} is outside the run directory`;
    } else {
      try {
        await mkdir(dirname(record.artifact), { recursive: true });
        await writeFile(record.artifact, body.endsWith("\n") ? body : `${body}\n`, "utf8");
        written = record.artifact;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const planned = plannedModel(record);
  const observation = observeSeat({
    agent: record.agent,
    ran: input.ran,
    planned,
    ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
  });
  const error = fields.error ?? failure;
  const outcome: RunOutcome = {
    agent: record.agent,
    ...(planned ? { planned } : {}),
    ...(input.ran ? { ran: baseModel(input.ran) } : {}),
    fallback: input.fallbackFrom !== undefined,
    ...(input.fallbackFrom ? { route: `retry fallback from ${input.fallbackFrom}` } : {}),
    ...(aborted ? { aborted: true } : {}),
    ...(error ? { error } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(verdict ? { verdict } : {}),
    ...(written ? { artifact: written } : {}),
  };
  const recorded = await appendOutcome(record.manifestPath, outcome);
  if (failure) {
    notify(
      failure === "seat yielded no report"
        ? `role-fleet: ${record.agent} yielded no report — nothing was placed at ${record.artifact}.`
        : `role-fleet: ${record.agent} — its report could not be written: ${failure}`,
      "warning",
    );
  }
  if (!recorded) {
    notify(
      `role-fleet: ${record.agent} — its outcome could not be recorded in ${record.manifestPath}.`,
      "warning",
    );
  }
  return { outcome, ...(written ? { written } : {}), ...(observation ? { observation } : {}), recorded };
}
