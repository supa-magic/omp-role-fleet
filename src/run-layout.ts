/**
 * Where a run lives on disk, in one place.
 *
 * The emitter, the ledger, the seat registry, the run reports and the MCP guard
 * all address the same tree; a literal copied into each of them is a layout
 * that can drift apart one file at a time.
 */
import { join } from "node:path";

/** Per-repo artifact root: `<cwd>/.role-fleet/run-<id>/…`. */
const RUNS_DIR = ".role-fleet";
/** The run's durable record inside its directory. */
export const MANIFEST_FILE = "plan.json";
/** Run directories kept under `RUNS_DIR`. */
export const RUN_DIR_RETENTION = 10;

/** A run id this plugin mints: `run-<epoch ms>`. */
export const RUN_ID = /^run-(\d+)$/;

export function runsRoot(cwd: string): string {
  return join(cwd, RUNS_DIR);
}

export function runDir(cwd: string, runId: string): string {
  return join(cwd, RUNS_DIR, runId);
}

export function manifestPath(cwd: string, runId: string): string {
  return join(cwd, RUNS_DIR, runId, MANIFEST_FILE);
}

/** The omp agent-discovery root generated seats are written into. */
export function agentsDir(cwd: string): string {
  return join(cwd, ".omp", "agents");
}

/**
 * Ordering for run ids. Numeric, never lexical: both prune guards compare
 * these, and string order flips across a digit-count boundary (`run-999` vs
 * `run-1000`), which once let an older run delete a newer run's live files.
 */
export function runIdAt(runId: string): number {
  return Number(RUN_ID.exec(runId)?.[1] ?? Number.NaN);
}
