/**
 * Reading a finished run back.
 *
 * The manifest is the durable record; this module only renders it. It is
 * deliberately read-only and tolerant: an older run has no `outcomes`, a
 * truncated manifest is skipped rather than breaking the list, and a missing
 * field is printed as unknown instead of invented.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "./agents.ts";
import { runIdAt } from "./agents.ts";
import type { RunOutcome } from "./core.ts";

const RUN_DIR = /^run-\d+$/;

async function runDirs(cwd: string): Promise<string[]> {
  const root = join(cwd, ".role-fleet");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries.filter((name) => RUN_DIR.test(name)).sort((a, b) => runIdAt(b) - runIdAt(a));
}

async function loadManifest(cwd: string, runId: string): Promise<RunManifest> {
  const path = join(cwd, ".role-fleet", runId, "plan.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`no readable manifest for ${runId} at ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a run manifest`);
  }
  // Written by writeRunManifest and read back here; the shape is this plugin's
  // own, and the renderer narrows every field it prints.
  return parsed as RunManifest;
}

function modelLine(outcome: RunOutcome): string {
  const planned = outcome.planned ? `planned \`${outcome.planned}\`` : "no plan-time baseline";
  const ran = outcome.ran ? `ran \`${outcome.ran}\`` : "model unknown";
  return `${planned}, ${ran}${outcome.fallback ? " — FALLBACK" : ""}${outcome.route ? ` via ${outcome.route}` : ""}`;
}

function outcomeLine(outcome: RunOutcome): string {
  const bits = [modelLine(outcome)];
  if (outcome.verdict) bits.push(`verdict ${outcome.verdict}`);
  if (outcome.exitCode !== undefined && outcome.exitCode !== 0) bits.push(`exit ${outcome.exitCode}`);
  if (outcome.aborted) bits.push("aborted");
  if (outcome.error) bits.push(`error: ${outcome.error}`);
  if (outcome.tokens !== undefined) bits.push(`${outcome.tokens} tokens`);
  if (outcome.durationMs !== undefined) bits.push(`${Math.round(outcome.durationMs / 1000)}s`);
  return bits.join(" · ");
}

/** Render one run, newest by default. */
export async function renderRunReport(cwd: string, runId?: string): Promise<string> {
  const runs = await runDirs(cwd);
  if (!runs.length) return "No role-fleet runs in this repository yet.";
  const target = runId ?? runs[0]!;
  if (!runs.includes(target)) {
    return `No run ${target} under .role-fleet (have ${runs.slice(0, 5).join(", ")}${runs.length > 5 ? ", …" : ""}).`;
  }
  const manifest = await loadManifest(cwd, target);
  const outcomes = Array.isArray(manifest.outcomes) ? manifest.outcomes : [];
  const settled = new Set(outcomes.map((o) => o.agent));
  const lines = [
    `Run ${target}${manifest.startedAt ? ` — started ${new Date(manifest.startedAt).toISOString()}` : ""}`,
    `Task: ${manifest.task}`,
    "",
    `Cast (${manifest.agents.length} seat(s)):`,
    ...manifest.agents.map(
      (a) => `  • ${a.role} as \`${a.agent}\` on ${a.modelResolved ?? a.model}, wave ${a.wave}`,
    ),
    "",
    `Outcomes (${settled.size}/${manifest.agents.length} settled):`,
    ...(outcomes.length
      ? outcomes.map((o) => `  • ${o.agent}: ${outcomeLine(o)}${o.artifact ? ` → ${o.artifact}` : ""}`)
      : ["  (none recorded — the run may not have dispatched, or the host supplied no task result)"]),
  ];
  const missing = manifest.agents.filter((a) => !settled.has(a.agent)).map((a) => a.agent);
  if (missing.length) lines.push(`  ! no outcome: ${missing.join(", ")}`);
  const tokens = outcomes.reduce((sum, o) => sum + (o.tokens ?? 0), 0);
  const duration = outcomes.reduce((sum, o) => sum + (o.durationMs ?? 0), 0);
  if (tokens || duration) {
    lines.push("", `Totals: ${tokens} tokens, ${Math.round(duration / 1000)}s across ${outcomes.length} outcome(s)`);
  }
  if (manifest.notes.length) lines.push("", "Notes:", ...manifest.notes.map((n) => `  - ${n}`));
  return lines.join("\n");
}

/** List recent runs, newest first. */
export async function renderRunList(cwd: string): Promise<string> {
  const runs = await runDirs(cwd);
  if (!runs.length) return "No role-fleet runs in this repository yet.";
  const shown = runs.slice(0, 10);
  const rows: string[] = ["Recent role-fleet runs:"];
  for (const runId of shown) {
    try {
      const manifest = await loadManifest(cwd, runId);
      const settled = new Set((manifest.outcomes ?? []).map((o) => o.agent)).size;
      const when = manifest.startedAt ? new Date(manifest.startedAt).toISOString().slice(0, 16).replace("T", " ") : "?";
      rows.push(`  ${runId}  ${when}  ${settled}/${manifest.agents.length} settled  ${manifest.task}`);
    } catch {
      rows.push(`  ${runId}  (unreadable manifest)`);
    }
  }
  if (runs.length > shown.length) rows.push(`  … ${runs.length - shown.length} older run(s) pruned from this list`);
  rows.push("", "Use /role-fleet report run-<id> for one run.");
  return rows.join("\n");
}
/** A one-screen progress summary for the newest run. */
export async function renderRunStatus(cwd: string): Promise<string> {
  const runs = await runDirs(cwd);
  if (!runs.length) return "No role-fleet runs in this repository yet.";
  const runId = runs[0]!;
  const manifest = await loadManifest(cwd, runId);
  const outcomes = Array.isArray(manifest.outcomes) ? manifest.outcomes : [];
  const settled = new Set(outcomes.map((o) => o.agent));
  const failed = outcomes.filter(
    (o) => o.aborted || o.error || (o.exitCode !== undefined && o.exitCode !== 0) || o.verdict === "fail",
  );
  const fallbacks = outcomes.filter((o) => o.fallback);
  const missing = manifest.agents.filter((a) => !settled.has(a.agent)).map((a) => a.agent);
  const lines = [
    `Run ${runId}: ${settled.size}/${manifest.agents.length} settled`,
    `Task: ${manifest.task}`,
  ];
  if (fallbacks.length) lines.push(`Fallbacks: ${fallbacks.map((o) => o.agent).join(", ")}`);
  if (failed.length) lines.push(`Failed: ${failed.map((o) => o.agent).join(", ")}`);
  if (missing.length) lines.push(`No outcome yet: ${missing.join(", ")}`);
  if (!outcomes.length) lines.push("No seat has reported yet — the run may still be dispatching.");
  return lines.join("\n");
}
