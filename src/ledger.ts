/**
 * The post-dispatch ledger.
 *
 * The plan manifest records intent before anything runs. This module closes the
 * loop from the one place the host tells the truth about a settled seat: the
 * `task` tool's `tool_result`. It does two things the plan cannot do for itself:
 *
 *  - places a read-only seat's full report at the artifact path its downstream
 *    siblings are told to read, instead of relying on the main model to copy it;
 *  - appends the seat's outcome — actual model, fallback, exit state, tokens,
 *    duration, verdict — to `plan.json`, so a finished run can be audited after
 *    the notification is gone.
 *
 * Every function here is best-effort: a missing manifest, an unreadable file, or
 * a host that omits a field narrows what is recorded and never fails the hook.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunOutcome } from "./core.ts";
import { AGENT_PREFIX, baseModel } from "./core.ts";
import { expectedFor, readTaskResults } from "./model-observed.ts";

export interface PersistResult {
  /** Outcomes newly appended (re-delivered envelopes are ignored). */
  outcomes: RunOutcome[];
  /** Artifact paths written from a read-only seat's report. */
  written: string[];
}

interface SettledRun {
  agent?: unknown;
  output?: unknown;
  resolvedModel?: unknown;
  resolvedModelIsFallback?: unknown;
  resolvedModelRoute?: unknown;
  exitCode?: unknown;
  error?: unknown;
  aborted?: unknown;
  retryFailure?: unknown;
  tokens?: unknown;
  requests?: unknown;
  durationMs?: unknown;
  structuredOutput?: unknown;
}

function structuredFields(run: SettledRun): { report?: string; verdict?: string } {
  const structured = run.structuredOutput;
  if (typeof structured !== "object" || structured === null || !("data" in structured)) return {};
  const data = structured.data;
  if (typeof data !== "object" || data === null) return {};
  const report = "report" in data && typeof data.report === "string" && data.report.trim() ? data.report : undefined;
  const verdict = "verdict" in data && typeof data.verdict === "string" ? data.verdict : undefined;
  return { ...(report ? { report } : {}), ...(verdict ? { verdict } : {}) };
}

/** The seat's deliverable: its structured `report`, else the full output text. */
function reportText(run: SettledRun): string | undefined {
  const report = structuredFields(run).report;
  if (report) return report;
  return typeof run.output === "string" && run.output.trim() ? run.output : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Append outcomes to the manifest they belong to.
 *
 * The manifest is read-modify-written with a rename, so a crash between the two
 * writes leaves the previous complete file rather than a half one. Repeated
 * envelopes are deduped on `(agent, ran, exitCode)`; a rescue re-dispatch on a
 * different model is a different outcome and is kept.
 */
async function appendOutcomes(manifestPath: string, incoming: RunOutcome[]): Promise<RunOutcome[]> {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    manifest = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const existing = Array.isArray(manifest.outcomes) ? manifest.outcomes : [];
  const keyOf = (o: RunOutcome): string => `${o.agent}\u0000${o.ran ?? ""}\u0000${o.exitCode ?? ""}`;
  const seen = new Set(
    existing.map((o) =>
      typeof o === "object" && o !== null && "agent" in o && typeof o.agent === "string"
        ? `${o.agent}\u0000${"ran" in o && typeof o.ran === "string" ? o.ran : ""}\u0000${
            "exitCode" in o && typeof o.exitCode === "number" ? o.exitCode : ""
          }`
        : "",
    ),
  );
  const fresh = incoming.filter((o) => {
    const key = keyOf(o);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!fresh.length) return [];
  const next = { ...manifest, outcomes: [...existing, ...fresh], updatedAt: Date.now() };
  const temp = `${manifestPath}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temp, manifestPath);
  } catch {
    return [];
  }
  return fresh;
}

/**
 * Read one `task` tool result: place read-only reports, append outcomes.
 *
 * Only generated seats (`rf-` prefix) are considered; the parent session runs
 * other task calls whose results are not this plugin's business. A seat with no
 * recorded expectation is skipped rather than guessed at: without the artifact
 * path there is nothing to write, and without the pin there is no baseline.
 */
export async function persistSettledRuns(details: unknown): Promise<PersistResult> {
  const written: string[] = [];
  const byManifest = new Map<string, RunOutcome[]>();
  const all: RunOutcome[] = [];

  for (const raw of readTaskResults(details)) {
    const run = raw as SettledRun;
    if (typeof run.agent !== "string" || !run.agent.startsWith(AGENT_PREFIX)) continue;
    const expected = expectedFor(run.agent);
    if (!expected) continue;

    const report = reportText(run);
    const artifact = expected.artifact;
    let artifactPlaced = false;
    if (artifact && expected.writesOwnReport === false && report) {
      try {
        await mkdir(dirname(artifact), { recursive: true });
        await writeFile(artifact, report.endsWith("\n") ? report : `${report}\n`, "utf8");
        written.push(artifact);
        artifactPlaced = true;
      } catch {
        // A path the run directory no longer owns is not worth failing a hook.
      }
    }

    const ran = asString(run.resolvedModel);
    const planned =
      expected.resolved ?? (expected.pinned.startsWith("@") ? undefined : expected.pinned);
    const route = asString(run.resolvedModelRoute);
    const exitCode = asNumber(run.exitCode);
    const tokens = asNumber(run.tokens);
    const requests = asNumber(run.requests);
    const durationMs = asNumber(run.durationMs);
    const verdict = structuredFields(run).verdict;
    const outcome: RunOutcome = {
      agent: run.agent,
      ...(planned ? { planned: baseModel(planned) } : {}),
      ...(ran ? { ran: baseModel(ran) } : {}),
      fallback: run.resolvedModelIsFallback === true,
      ...(route ? { route } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(asString(run.error) ? { error: asString(run.error)! } : {}),
      ...(run.aborted === true ? { aborted: true } : {}),
      ...(run.retryFailure !== undefined ? { retryFailure: run.retryFailure } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(requests !== undefined ? { requests } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(verdict ? { verdict } : {}),
      ...(artifactPlaced && artifact ? { artifact } : {}),
    };
    all.push(outcome);
    if (artifact) {
      const manifestPath = join(dirname(artifact), "plan.json");
      const list = byManifest.get(manifestPath) ?? [];
      list.push(outcome);
      byManifest.set(manifestPath, list);
    }
  }

  const persisted: RunOutcome[] = [];
  for (const [manifestPath, outcomes] of byManifest) {
    persisted.push(...(await appendOutcomes(manifestPath, outcomes)));
  }
  return { outcomes: persisted, written };
}