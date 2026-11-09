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
 *  - places a read-only seat's full `report` at the artifact path its downstream
 *    siblings are told to read, so the main model never re-types it;
 *  - appends the seat's outcome — model that ran, fallback, verdict, duration —
 *    to `plan.json`, so a finished run can be audited after the session is gone.
 *
 * A failed or aborted yield places nothing: a downstream seat reading an error
 * transcript as its upstream report is worse than a missing file the main model
 * is told to notice.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { baseModel, type RunOutcome } from "./core.ts";
import { observeSeat, plannedModel, type ModelObservation } from "./model-observed.ts";
import { artifactInsideRun, type SeatRecord } from "./seats.ts";

/** What one seat's session saw when the seat yielded. */
export interface SeatYield {
  /** The seat as its session first saw it — pinned, not looked up by name. */
  record: SeatRecord;
  /** `details` of the settled `yield` call: `{ data, status, error }`. */
  details: unknown;
  /** The session's live model (`provider/id`) at the yield. */
  ran?: string;
  /** The model a retry fallback replaced, when one was applied in this session. */
  fallbackFrom?: string;
  durationMs?: number;
}

export interface SettleResult {
  outcome?: RunOutcome;
  /** Artifact path written from a read-only seat's report. */
  written?: string;
  observation?: ModelObservation;
}

function yieldFields(details: unknown): { status?: string; error?: string; report?: string; verdict?: string } {
  if (typeof details !== "object" || details === null) return {};
  const d = details as { status?: unknown; error?: unknown; data?: unknown };
  const data = typeof d.data === "object" && d.data !== null ? (d.data as Record<string, unknown>) : {};
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const out: { status?: string; error?: string; report?: string; verdict?: string } = {};
  if (text(d.status)) out.status = d.status as string;
  if (text(d.error)) out.error = d.error as string;
  if (text(data.report)) out.report = data.report as string;
  if (text(data.verdict)) out.verdict = data.verdict as string;
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
 * Record one seat's yield: place its report when the seat cannot, append its
 * outcome, and return the model divergence (if any) for the caller to announce.
 * Never throws — a ledger failure must not fail the seat's own tool call.
 *
 * An incremental section (`type: [labels]`) is not the seat's result — the
 * host assembles sections after the last one — so it records nothing.
 */
export async function settleSeat(input: SeatYield): Promise<SettleResult> {
  const { record } = input;
  const { details } = input;
  if (typeof details === "object" && details !== null && "type" in details && Array.isArray(details.type)) return {};
  const fields = yieldFields(input.details);
  const aborted = fields.status === "aborted";

  let written: string | undefined;
  if (!aborted && !record.writesOwnReport && fields.report) {
    // The report goes where the run directory says, and nowhere else: a path
    // outside it came from a manifest someone edited, and writing there would
    // put a seat's report outside the tree that owns it.
    if (await artifactInsideRun(dirname(record.manifestPath), record.artifact)) {
      try {
        await mkdir(dirname(record.artifact), { recursive: true });
        await writeFile(record.artifact, fields.report.endsWith("\n") ? fields.report : `${fields.report}\n`, "utf8");
        written = record.artifact;
      } catch {
        // A path the run directory no longer owns is not worth failing the seat.
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
  const outcome: RunOutcome = {
    agent: record.agent,
    ...(planned ? { planned } : {}),
    ...(input.ran ? { ran: baseModel(input.ran) } : {}),
    fallback: input.fallbackFrom !== undefined,
    ...(input.fallbackFrom ? { route: `retry fallback from ${input.fallbackFrom}` } : {}),
    ...(aborted ? { aborted: true } : {}),
    ...(fields.error ? { error: fields.error } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(fields.verdict ? { verdict: fields.verdict } : {}),
    ...(written ? { artifact: written } : {}),
  };
  await appendOutcome(record.manifestPath, outcome);
  return { outcome, ...(written ? { written } : {}), ...(observation ? { observation } : {}) };
}
