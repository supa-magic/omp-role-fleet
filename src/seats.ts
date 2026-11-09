/**
 * The seat registry: what each generated seat was granted, pinned to, and owes.
 *
 * One record per `rf-*` agent, filled once by the pipeline right after the run
 * is emitted, and read from the seat's own session when it settles or calls a
 * tool. Subagent sessions run in the parent's process and share this module, so
 * the in-memory record is the normal path; a seat from a run this process did
 * not emit (a restart, a revived subagent) is rebuilt from its agent file and
 * the run's `plan.json`, which hold the same facts durably.
 */
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENT_PREFIX } from "./core.ts";
import { agentsDir, manifestPath, runDir } from "./run-layout.ts";

/** Marks a file as plugin-generated so stale runs can be pruned safely. */
export const GENERATED_MARKER = "<!-- role-fleet:generated -->";

/** Which run wrote an agent file: `run-<epoch ms>`. */
export const RUN_MARKER = /<!-- role-fleet:run (run-\d+) -->/;

export interface SeatRecord {
  agent: string;
  runId: string;
  /** The run's `plan.json`, where this seat's outcome is appended. */
  manifestPath: string;
  /** Where the seat's full report belongs. */
  artifact: string;
  /** The built-in grant the seat's definition pins. */
  tools: string[];
  /** The selector pinned in the agent file: an alias or a concrete id. */
  pinned: string;
  /** Concrete `provider/id` resolved at plan time, when the host could answer. */
  resolved?: string;
}

/** The emitted-seat fields a record is built from (`EmittedAgent` carries them). */
export interface EmittedSeat {
  agent: string;
  artifact: string;
  tools: string[];
  model: string;
  modelResolved?: string;
}

/**
 * The registry key: one working tree, one seat name.
 *
 * Agent names are reused across projects and across runs, so the name alone
 * is not an identity — a process that serves two trees would hand the second
 * project's record to the first project's seat.
 */
function seatKey(cwd: string, agent: string): string {
  return `${cwd}\u0000${agent}`;
}

const seats = new Map<string, SeatRecord>();

type Notify = (text: string, level: "info" | "warning") => void;
let notifier: Notify | undefined;

/**
 * Is `artifact` inside the run directory `runDir`?
 *
 * A manifest is a file on disk that anyone can edit, so the path it names for
 * a seat's report is untrusted input: a hand-edited `plan.json` could point a
 * report at `/tmp/x` or at another repository. The plugin writes that report
 * itself, so the path has to stay inside the run's own directory.
 *
 * Two spellings of one directory are one directory: a project reached through
 * a symlink is still that project, so the real paths are compared when the
 * plain comparison fails.
 */
export async function artifactInsideRun(runDir: string, artifact: string): Promise<boolean> {
  const base = resolve(runDir);
  const target = resolve(artifact);
  if (within(base, target)) return true;
  try {
    const realBase = await realpath(base);
    const realParent = await realpath(dirname(target));
    return within(realBase, resolve(realParent, basename(target)));
  } catch {
    return false;
  }
}

/** Is `target` strictly below `base`? */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function recordOf(cwd: string, runId: string, a: EmittedSeat): SeatRecord {
  return {
    agent: a.agent,
    runId,
    manifestPath: manifestPath(cwd, runId),
    artifact: a.artifact,
    tools: [...a.tools],
    pinned: a.model,
    ...(a.modelResolved ? { resolved: a.modelResolved } : {}),
  };
}

/**
 * Record the seats a run just emitted. Agent names are reused across runs and
 * across projects, and the emitter has just overwritten their files on disk, so
 * the newest run in this tree wins here exactly as it does there.
 */
export function registerRun(cwd: string, runId: string, agents: readonly EmittedSeat[]): void {
  for (const a of agents) seats.set(seatKey(cwd, a.agent), recordOf(cwd, runId, a));
}

/** Drop every in-memory record (tests; the disk record stays authoritative). */
export function forgetSeats(): void {
  seats.clear();
}

/**
 * Where seat news goes: the main session's UI. A seat settles in its own
 * session, whose UI nobody watches, so the main session registers its sink
 * when it starts.
 */
export function setNotifier(notify: Notify): void {
  notifier = notify;
}

/** Drop the sink if it is still this one: a session that ends takes its UI along. */
export function clearNotifier(notify: Notify): void {
  if (notifier === notify) notifier = undefined;
}

export function notify(text: string, level: "info" | "warning"): void {
  notifier?.(text, level);
}

/**
 * The record for a generated seat, or undefined for any other agent.
 *
 * The prefix test comes first and is the scope rule: a hand-written agent is
 * never this plugin's to judge, and costs no disk read.
 */
export async function seatRecord(agent: string, cwd: string): Promise<SeatRecord | undefined> {
  if (!agent.startsWith(AGENT_PREFIX)) return undefined;
  return seats.get(seatKey(cwd, agent)) ?? (await seatFromDisk(agent, cwd));
}

/** Parse a definition's `tools: [...]` line (always written as a JSON array). */
function toolsFromDefinition(body: string): string[] | undefined {
  const match = /^tools:\s*(\[[^\]]*\])/m.exec(body);
  if (!match) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The grant a seat's own definition file declares.
 *
 * The run record is the authority on what a seat may do, but it is not always
 * there: a run directory that was removed, or a definition left behind by a run
 * this process did not emit, still says what the seat may do. This is the
 * fallback the MCP guard reads when the record cannot be resolved — a seat
 * whose grant cannot be read at all is guarded, not trusted.
 */
export async function seatToolsFromDefinition(agent: string, cwd: string): Promise<string[] | undefined> {
  try {
    return toolsFromDefinition(await readFile(join(agentsDir(cwd), `${agent}.md`), "utf8"));
  } catch {
    return undefined;
  }
}

async function seatFromDisk(agent: string, cwd: string): Promise<SeatRecord | undefined> {
  let body: string;
  try {
    body = await readFile(join(agentsDir(cwd), `${agent}.md`), "utf8");
  } catch {
    return undefined;
  }
  if (!body.includes(GENERATED_MARKER)) return undefined;
  const runId = RUN_MARKER.exec(body)?.[1];
  if (!runId) return undefined;
  let entry: Partial<EmittedSeat> | undefined;
  try {
    const manifest = JSON.parse(await readFile(manifestPath(cwd, runId), "utf8")) as { agents?: unknown };
    entry = Array.isArray(manifest.agents)
      ? (manifest.agents as Array<Partial<EmittedSeat>>).find((a) => a?.agent === agent)
      : undefined;
  } catch {
    return undefined;
  }
  const tools = Array.isArray(entry?.tools) ? entry.tools : toolsFromDefinition(body);
  if (!entry || typeof entry.artifact !== "string" || typeof entry.model !== "string" || !tools) return undefined;
  // The manifest is a file on disk: its artifact path is only as trustworthy
  // as the file itself. A path outside the run directory is refused, and no
  // record is built for it — the seat would otherwise write its report
  // wherever a hand-edited plan.json points.
  if (!(await artifactInsideRun(runDir(cwd, runId), entry.artifact))) return undefined;
  const record = recordOf(cwd, runId, {
    agent,
    artifact: entry.artifact,
    tools,
    model: entry.model,
    ...(typeof entry.modelResolved === "string" ? { modelResolved: entry.modelResolved } : {}),
  });
  seats.set(seatKey(cwd, agent), record);
  return record;
}
