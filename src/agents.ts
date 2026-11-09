/**
 * Roles → real omp agent definitions.
 *
 * Each role becomes an omp agent Markdown file with YAML frontmatter, exactly
 * as documented in `docs/subagent-authoring`. The model is a role alias, so omp
 * resolves it through the user's `modelRoles` at launch — retargeting a whole
 * class of work happens in `/model`, not here.
 *
 * omp scans `agents/*.md` directly and never descends into subdirectories, so
 * the files land flat in one agents root; per-run isolation comes from
 * rewriting the same names, and stale generated files are pruned.
 */
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RolePlan, RoleSpec, RunOutcome, TaskEffort } from "./core.ts";
import { AGENT_PREFIX, grantsWrite, SEAT_PURPOSE, planWaves, taskEffort } from "./core.ts";
import { isReadOnlyToolset, mcpAllowlistFromEnv } from "./mcp-policy.ts";
import { MANIFEST_FILE, RUN_ID, runIdAt } from "./run-layout.ts";
import { GENERATED_MARKER, RUN_MARKER } from "./seats.ts";

/** How recent a foreign run must be for its files to plausibly still be in use.
 *  Sequential runs reuse seat names by design; warning on every stale file from
 *  yesterday would turn the concurrency note into noise on run two. */
const IN_FLIGHT_WINDOW_MS = 5 * 60 * 1000;

function recentlyActive(owner: string | undefined, currentRunId: string | undefined): boolean {
  if (!owner || !currentRunId) return false;
  const ownerAt = runIdAt(owner);
  const currentAt = runIdAt(currentRunId);
  return Number.isFinite(ownerAt) && Number.isFinite(currentAt) && currentAt >= ownerAt && currentAt - ownerAt <= IN_FLIGHT_WINDOW_MS;
}

function runStamp(runId: string | undefined): string {
  return `<!-- role-fleet:run ${runId ?? "run-0"} -->`;
}

// `AGENT_PREFIX` is defined once in core.ts: the settled-result observer
// matches generated names by the same prefix, and a private copy here could
// drift without either side noticing.

/**
 * YAML-safe scalar: quoted, with backslashes and quotes escaped.
 *
 * Newlines collapse to a space: a value carrying one would close the scalar and
 * let the rest of it inject arbitrary frontmatter keys. The only frontmatter
 * value that can come from outside this file is `model`, selected from the
 * user's own allowlist, so this is defence in depth rather than a live hole.
 */
function yamlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    // Remaining C0 controls (tab excepted) are invalid inside a YAML
    // double-quoted scalar; a hand-edited allowlist selector carrying one would
    // otherwise emit an agent file the host silently refuses to load.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")}"`;
}

/**
 * One static description per seat, deliberately free of task text.
 *
 * Task text in a YAML scalar is an injection surface: a `---` inside it closes
 * the frontmatter, a newline splits the scalar. The mission and the task
 * belong to the body, which is plain markdown and safe.
 */
const SEAT_DESCRIPTION: Record<string, string> = Object.fromEntries(
  Object.entries(SEAT_PURPOSE).map(([seat, purpose]) => [seat, `Role-fleet ${seat}: ${purpose}.`]),
);

/**
 * The write authority a seat's own grant gives it, for the agent description.
 *
 * Read off `role.tools` rather than a hardcoded list of seat ids. The set said
 * "read-only" for `reviewer` — and a council member *is* the reviewer seat, so
 * on a consul run, where members are granted `write` so their reports reach the
 * consul, the description told the user the exact opposite of the grant in the
 * very line they would check. Three copies of "who can write" (`core.ts` grants,
 * `confirm.ts`, and that set) drifted apart; this one now derives from the
 * single definition.
 */
function grantNote(tools: string[]): string {
  // The shell is named first and on its own line because it is the widest grant
  // here: it can write any path it can name, delete what it can reach, and run
  // anything else on the machine. Calling it "can change code" would hide the
  // one thing a reader checking this file needs to know.
  if (tools.includes("bash")) return " Can change the code and run commands: the shell reaches any path.";
  if (tools.includes("edit")) return " Can change code.";
  if (tools.includes("write")) return " Holds repo-wide write: cannot edit existing files, can create or overwrite any path.";
  return " Read-only.";
}

/**
 * Output schema every generated seat declares.
 *
 * `report` is required and carries the complete deliverable; `summary` is a
 * headline the parent can scan. Without a schema a read-only seat's result
 * reaches the main model as whatever prose it happened to end with — and a
 * council then decides on a paragraph instead of on the findings. A required
 * `report` makes the short answer a non-answer: the host's validator rejects it
 * and the agent is sent back for the full one.
 *
 * There is deliberately no "which model did you run on" field. The subagent
 * prompt carries no model name, so the only thing a seat could fill it with is
 * the brief's pinned selector — which a fallback invalidates exactly when it
 * matters. The real answer is the seat session's live model at its yield,
 * which the plugin records (`ledger.ts`) rather than asks for.
 * Every field carries a `description` and every field is listed in `required`,
 * because the two formats the host accepts read the same YAML differently. A
 * root with `properties` and no `type` parses as JTD, whose `properties` are
 * required members — but the conversion rebuilds each node from JTD keywords
 * alone and drops `metadata`, so the descriptions never reach the model. Naming
 * `type: object` and `required` takes the JSON-Schema branch instead, where both
 * survive; leaving `required` out of *that* branch would require nothing at all,
 * which is the anti-summary guarantee this schema exists for.
 */
const REPORT_SCHEMA_YAML = [
  "output:",
  "  type: object",
  "  properties:",
  "    summary:",
  "      type: string",
  '      description: "One-paragraph headline of the outcome. Never the deliverable itself."',
  "    report:",
  "      type: string",
  // Presence is not delivery: the required list rejects a yield that omits the
  // field, and this rejects one that satisfies it with an empty string — the
  // same non-answer in a different shape. The host's validator enforces it
  // ("must be at least 1 characters") and the keyword survives normalization.
  "      minLength: 1",
  '      description: "The complete deliverable at full depth: every finding with file:line evidence,',
  '        per-item detail, tables, and the checks actually run with their real output."',
  "    verdict:",
  "      type: string",
  "      enum: [pass, fail, blocked]",
  '      description: "Overall outcome of this seat\'s mission."',
  '  required: ["summary", "report", "verdict"]',
  "  additionalProperties: false",
].join("\n");

/** The charset an omp agent name may take. Everything this plugin mints already
 *  matches it; the assert is the boundary check that keeps a future producer
 *  from turning an id into an arbitrary frontmatter key or path segment. */
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

function assertAgentName(name: string): void {
  if (!AGENT_NAME.test(name)) {
    throw new Error(`refusing to write agent definition "${name}": names are lowercase letters, digits and hyphens`);
  }
}

function frontmatter(role: RoleSpec, name: string): string {
  assertAgentName(name);
  // The id first, then the seat it executes as: one role carries two names, and
  // a council member is the reviewer seat with a number on it — without both
  // steps every generated seat shipped the same placeholder and was
  // indistinguishable in the agent picker. Every seat that can be minted has an
  // entry of its own: the catalog seats' purposes live in `SEAT_PURPOSE` beside
  // the rest, because a description kept in the catalog alone was shadowed by
  // those two lookups and never reached the picker at all.
  // Own properties only: a generated id such as `constructor` passes the id
  // regex and would otherwise resolve to an inherited Function, not a string.
  const description =
    (Object.hasOwn(SEAT_DESCRIPTION, role.id) ? SEAT_DESCRIPTION[role.id] : undefined) ??
    (Object.hasOwn(SEAT_DESCRIPTION, role.core) ? SEAT_DESCRIPTION[role.core] : undefined) ??
    "Role-fleet generated seat.";
  // The authority line is appended from the grant, never baked into the static
  // description above: the description is keyed by seat, and one seat can hold
  // two different grants across two runs.
  const described = `${description}${grantNote(role.tools)}`;
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlString(described)}`,
    // `tools` and `thinking-level` go through the same quoting as `model`. Every
    // producer today constrains them (the grant arrays in core.ts, the effort
    // enum, the proposal sandbox), so this is not a live hole — but the grant
    // list is a security boundary per this file's own header, and a producer that
    // reached these values from outside would otherwise inject frontmatter here
    // while `model` is defended. Quoting costs nothing and removes the class.
    `tools: [${role.tools.map(yamlString).join(", ")}]`,
    `model: ${yamlString(role.model)}`,
    `thinking-level: ${yamlString(role.effort)}`,
    // Without `structured: true` the seat has no `yield` tool on a host with
    // `task.structured` off (the default): the schema below is ignored and the
    // last assistant turn becomes the whole result — the summary-only failure
    // this schema exists to remove, and the ledger has no report to place.
    "structured: true",
    REPORT_SCHEMA_YAML,
    // `advisor: true` asks the host for its default advisor-role model. The
    // string spelling ("@advisor") is a model pattern instead, and a
    // self-referential one trips the host's cycle guard and silently degrades
    // to the built-in priority list. Vision itself is not a frontmatter key —
    // a vision seat is a seat whose model alias resolves to a vision model.
    //
    // Who earns it: the planner, whose plan every later wave follows — a wrong
    // plan poisons all of them — and vision seats. Not the implementer: it is
    // the longest-running seat on the critical path, and an advisor pass on
    // every one of its turns paces the whole run, while the tester and
    // reviewers already cross-check its work. Review seats are excluded on
    // purpose: their value is independence *from* the cast. The host's
    // `task.agentAdvisor` setting overrides this per seat.
    ...(role.needsVision || role.core === "planner" ? ["advisor: true"] : []),
    "---",
    "",
  ].join("\n");
}

/**
 * Plan-time resolution note for the seat brief, or "" when the pin already is
 * the model.
 *
 * `modelResolved` is recorded only when the host's resolution differs from the
 * pin, so a concrete pin that resolved to itself gets no note — the pin already
 * names the model, and "(not resolved at plan time)" would claim a resolver
 * failure that did not happen. Only an `@`-alias left unresolved is honestly
 * "not resolved".
 *
 * A concrete selector the host could not resolve is a different case: it was
 * named by somebody — a `--models` entry, a `--consul`, an allowlist pin — and
 * the seat will run on the parent session's model instead of it. The brief
 * says so rather than letting the pin read as the model that answers.
 */
function modelNote(role: RoleSpec): string {
  if (role.modelResolved) return ` → resolved to \`${role.modelResolved}\``;
  if (role.modelUnresolved) return " (unresolved at plan time — the seat runs on the session model)";
  return role.model.startsWith("@") ? " (not resolved at plan time)" : "";
}

/**
 * The MCP tools a read-only seat may call, stated in the brief.
 *
 * The host treats every MCP tool as write-tier and gives them to every seat,
 * and seats run unattended — so the plugin refuses the calls this seat was not
 * allowed. The seat is told the rule up front rather than discovering it by
 * having a tool call refused.
 */
function mcpGrantLine(): string {
  const allowlist = mcpAllowlistFromEnv(process.env);
  if (!allowlist.length) {
    return "- No MCP tool is available to you: this seat is read-only and the operator allowed none. Use your own tools.";
  }
  return `- MCP tools are available to you only when their name starts with ${allowlist
    .map((prefix) => `\`${prefix}\``)
    .join(", ")}; any other MCP tool call is refused.`;
}

/**
 * The agent body: mission, task, acceptance bar, and hard constraints.
 *
 * `name` is the name the seat dispatches under, which is the seat id unless the
 * run had to step around a file it does not own (`rf-<id>-2`). It has to reach
 * the frontmatter: the prune identifies a generated file by its frontmatter name
 * matching its filename, so a file written as `rf-scout-2.md` that still says
 * `name: rf-scout` is one the plugin can never recognise again — not as its own
 * to replace, and not as stale enough to delete.
 */
export function agentMarkdown(plan: RolePlan, role: RoleSpec, name = `${AGENT_PREFIX}${role.id}`): string {
  const deps = (role.dependsOn ?? []).filter(Boolean);
  const upstream = deps
    .map((d) => {
      const dep = plan.roles.find((r) => r.id === d);
      if (!dep) return null;
      // A read-only dep cannot write its own artifact, but the path is still where
      // the report belongs: the plugin places it there when the seat yields.
      return grantsWrite(dep.tools)
        ? `- \`${dep.id}\` → ${dep.artifact}`
        : `- \`${dep.id}\` → ${dep.artifact} (read-only role — the plugin writes its report here)`;
    })
    .filter(Boolean)
    .join("\n");

  // The markers go *after* the frontmatter: YAML frontmatter must open on line
  // one, or the agent file is not loaded and the role cannot be dispatched.
  // Pruning reads them from the body, so position is free.
  return [
    frontmatter(role, name),
    GENERATED_MARKER,
    runStamp(plan.runId),
    "",
    `# ${role.title}`,
    "",
    // The pinned selector is the intent; this is what the host resolved it to
    // at plan time. The seat is told both so a reader knows which model was
    // asked for. It is NOT asked which model it is running on: the subagent
    // prompt carries no model name, so the only answer it could give is this
    // very line — which a fallback has already invalidated. The host reports
    // the model that actually served the run from the settled result instead.
    `Model: \`${role.model}\`${modelNote(role)}`,
    "",
    "## Mission",
    "",
    role.mission,
    "",
    "## Task",
    "",
    plan.task,
    "",
    "## Acceptance",
    "",
    ...role.acceptance.map((a) => `- [ ] ${a}`),
    "",
    ...(upstream ? ["## Upstream artifacts", "", "Read these before you start:", "", upstream, ""] : []),
    "## Report contract",
    "",
    // The schema is declared in the frontmatter; this is what the fields mean
    // for this seat. Without it a seat satisfies `report` with one sentence and
    // the council downstream has nothing to weigh.
    "- Yield the complete result through the `yield` tool. Your `report` field carries",
    "  the full deliverable: every finding with `file:line` evidence, per-item detail, the",
    "  exact commands you ran with their real output, and everything a reader would need to",
    "  act without re-running your work.",
    "- `summary` is a headline for the parent to scan — never a shortened copy of the report,",
    "  and never the deliverable. A parent that reads only `summary` cannot decide anything,",
    "  so the report must stand on its own.",
    "- `verdict` is `pass`, `fail`, or `blocked`; `blocked` means you could not finish, and",
    "  the report must then say exactly what stopped you and what you tried.",
    "",
    "## Constraints",
    "",
    `- Stay inside your tool grant: ${role.tools.join(", ")}.`,
    // The host hands every connected MCP tool to every seat, whatever the
    // grant says, so a read-only seat is told which MCP tools it may actually
    // use — and that the rest are refused. Without the line the seat discovers
    // the refusal by calling the tool.
    ...(isReadOnlyToolset(role.tools) ? [mcpGrantLine()] : []),
    "- One writer per file; never edit files owned by another role in this plan.",
    "- Do not expand scope. Smallest correct change.",
    "- Report blockers with evidence. Never invent APIs or claim a check you did not run.",
    ...(grantsWrite(role.tools)
      ? [`- Write your report to \`${role.artifact}\` as well as yielding it: the full report, not a summary.`]
      : [
          `- You have no write access. Yield your full report — the plugin writes it to \`${role.artifact}\`.`,
        ]),
    "",
  ].join("\n");
}

export interface EmittedAgent {
  /** The dispatchable agent name (`rf-<role>`), distinct from the role id. */
  agent: string;
  role: string;
  path: string;
  wave: number;
  model: string;
  /** Concrete `provider/id` behind `model`, when the host resolved it. */
  modelResolved?: string;
  /**
   * Coarse task-tool effort derived from the seat's thinking effort.
   * Dispatch must pass this: host `effort` beats modelRoles `:suffix`, which
   * otherwise erases agent-frontmatter `thinking-level`.
   */
  effort: TaskEffort;
  artifact: string;
  dependsOn: string[];
  /** The built-in grant the definition pins; the MCP guard judges against it. */
  tools: string[];
  /**
   * Whether the seat can write its own artifact.
   *
   * False means the plugin places that file when the seat yields, and the
   * dispatch prompt names it so the main model can fill a gap if the seat
   * failed to yield.
   */
  writesOwnReport: boolean;
}

/**
 * The `name` an agent file declares in its frontmatter, or "" when it declares none.
 *
 * A bounded scan rather than `/^---\n(?:.*\n)*?^name: (.+)$/m`: that lazy nested
 * quantifier is quadratic in file size, ran over every `.md` in a directory this
 * plugin does not own, and — because the match can start at the *closing* `---` —
 * would read a `name:` line out of a hand-written body and then delete that file
 * on a match. Reading the frontmatter block means the identity check can only
 * ever see what the host itself would load.
 */
function declaredName(body: string): string {
  const end = body.indexOf("\n---", 3);
  const front = body.startsWith("---\n") ? (end === -1 ? body : body.slice(0, end)) : "";
  return /^name: (.+)$/m.exec(front)?.[1]?.trim() ?? "";
}

/**
 * Is this file the current run's to replace?
 *
 * One predicate, two callers, opposite ends of the same invariant: `emitAgents`
 * overwrites exactly the files `pruneGeneratedAgents` deletes, and clobbers
 * nothing prune would spare. It is false for three kinds of file, each for its
 * own reason:
 *
 *  - no `GENERATED_MARKER` — a hand-written agent. `emitAgents` used to write
 *    over it unconditionally, which lost user content and then *deleted* it on a
 *    later run, since by then it carried the marker and matched its filename.
 *  - a frontmatter `name` that does not match the filename — a hand-copied
 *    rename of a generated seat, which prune already left alone.
 *  - an owner run id greater than ours — the files of a run emitted after this
 *    one, which may still be dispatching its waves.
 *
 * The owner comparison is numeric through `runIdAt`, the shared comparator:
 * comparing the ids as text made this guard disagree with `pruneRunDirs` across
 * a digit-count boundary.
 */
function oursToReplace(body: string, entry: string, currentRunId?: string): boolean {
  if (!body.includes(GENERATED_MARKER)) return false;
  const declared = declaredName(body);
  if (!declared || `${declared}.md` !== entry) return false;
  const owner = body.match(RUN_MARKER)?.[1];
  return !(currentRunId && owner && runIdAt(owner) > runIdAt(currentRunId));
}

/**
 * Remove agent files this plugin wrote for an earlier run.
 *
 * A file is ours only when `oursToReplace` says so — a hand-written agent, a
 * hand-copied rename of a generated one, and a file stamped with a newer run id
 * (a run still in flight) are all left alone.
 */
export async function pruneGeneratedAgents(
  dir: string,
  keep: string[],
  currentRunId?: string,
  onForeignRemoved?: (path: string, owner: string) => void,
): Promise<string[]> {
  const keepSet = new Set(keep);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (keepSet.has(entry)) continue;
    const target = join(dir, entry);
    try {
      const body = await readFile(target, "utf8");
      if (!oursToReplace(body, entry, currentRunId)) continue;
      const owner = body.match(RUN_MARKER)?.[1];
      if (owner && owner !== currentRunId) onForeignRemoved?.(target, owner);
      await unlink(target);
      removed.push(target);
    } catch {
      // Unreadable or already gone: leave it alone.
    }
  }
  return removed;
}

/**
 * Keep the per-run artifact tree bounded: delete all but the newest `keep`
 * run directories under `root`.
 *
 * Every non-dry run creates `<repo>/.role-fleet/run-<id>/`, so without this the
 * tree grows by one directory per run forever. Retention is by count rather
 * than age, because count is what bounds the damage: an age rule deletes the run
 * you still want from yesterday's session while leaving an afternoon's burst of
 * two hundred runs untouched. Keeping more than one matters too — a reviewer
 * reads the scout's artifact from an earlier wave of the same run.
 *
 * Only `run-<digits>` directories are touched, never a symlink, never the
 * current run, never a *newer* one, and never anything else in `.role-fleet/`.
 * Anything the plugin did not name, it does not delete.
 */
export async function pruneRunDirs(root: string, currentRunId: string, keep: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const currentAt = runIdAt(currentRunId);
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
    .map((e) => ({ name: e.name, at: runIdAt(e.name) }))
    // Numeric, not lexical: ordering must not depend on the epoch's digit count.
    // Same comparator the agent-file guard uses, so the two halves of the
    // invariant cannot drift apart again.
    .sort((a, b) => b.at - a.at)
    // Spare the current run and anything newer than it. Ids are strictly
    // increasing (`nextRunId`), so a newer directory belongs to a run still in
    // flight. Without it, one slow run finishing after a burst of eleven would
    // delete every one of those in-flight artifact directories.
    .filter((r) => r.at <= currentAt);

  const removed: string[] = [];
  // `keep` counts the current run: the newest `keep` eligible directories are
  // kept, the rest go. The floor is one — the current run always survives — so a
  // caller passing zero cannot delete the directory whose manifest is about to
  // be written.
  const effectiveKeep = Math.max(1, keep);
  for (const stale of runs.slice(effectiveKeep)) {
    try {
      await rm(join(root, stale.name), { recursive: true, force: true });
      removed.push(join(root, stale.name));
    } catch {
      // Already gone, or not ours to remove: leave it.
    }
  }
  return removed;
}

/** One file in the agents directory, as the name resolver sees it. */
export interface SeatFileState {
  /** The file's body, when it could be read. */
  body?: string;
  /** Whether the path is a symlink; a link is never written through. */
  isLink: boolean;
}

/** The agent names a plan's seats got, and what the resolver left alone. */
export interface SeatNameResolution {
  /** The name each seat dispatches under, in the order the seats were given. */
  names: string[];
  /** Notes about the files this run did not take over. */
  notes: string[];
  /** The seat file that has no free name beside it, when it has none. */
  conflict?: string;
}

/**
 * The agent name each seat gets, given the files already in the directory.
 *
 * Pure: it decides from the directory state it is handed and never touches the
 * disk. A seat takes its plain `rf-<id>.md` name unless that file belongs to
 * somebody else — a hand-written agent, a hand-copied rename of a generated
 * one, or a run that is still in flight — and then takes the first `-2`, `-3`,
 * … name that is free or that this run owns, so the user's file survives and
 * the seat still dispatches.
 *
 * `seats` is the order the seats are decided in; the caller passes them in
 * dispatch order, and the names and notes come out in that order too.
 */
export function resolveSeatNames(
  plan: RolePlan,
  existing: Map<string, SeatFileState>,
  seats: readonly RoleSpec[] = planWaves(plan.roles).flat(),
): SeatNameResolution {
  const names: string[] = [];
  const notes: string[] = [];
  // Every seat's own base name is reserved before any suffix is handed out. A
  // proposed role whose literal id is `x-2` and a renamed seat looking for a
  // free `rf-x-2.md` would otherwise resolve to the same file, and the last
  // writer would silently run the other seat's brief.
  const reserved = new Set(seats.map((r) => `${AGENT_PREFIX}${r.id}.md`));
  // Names this run has already claimed, so a later seat does not take one.
  const claimed = new Set<string>();
  const replacedForeign: string[] = [];
  const kept: Array<{ file: string; as: string; why: string }> = [];

  for (const role of seats) {
    const base = `${AGENT_PREFIX}${role.id}`;
    const baseFile = `${base}.md`;
    const state = existing.get(baseFile);
    if (!state) {
      names.push(base);
      continue;
    }
    const baseBody = state.body;
    // An unreadable file is left alone too — `undefined` falls through to the
    // suffix search rather than being treated as this run's to overwrite. A
    // symlink is never written through: the target is outside what this plugin
    // created, and `pruneGeneratedAgents` already removes the link, not the target.
    if (baseBody !== undefined && !state.isLink && oursToReplace(baseBody, baseFile, plan.runId)) {
      const owner = baseBody.match(RUN_MARKER)?.[1];
      if (owner && owner !== plan.runId && recentlyActive(owner, plan.runId)) {
        replacedForeign.push(`${baseFile} (${owner})`);
      }
      names.push(base);
      continue;
    }
    // Take the first suffix that is free *or ours to replace*. Stopping at the
    // first free one instead would climb a new name on every run for as long as
    // the hand-written file sits there, leaving a trail of near-duplicate seats.
    let as: string | undefined;
    for (let n = 2; n < 100 && as === undefined; n++) {
      const candidate = `${base}-${n}.md`;
      if (reserved.has(candidate)) continue;
      const candidateState = existing.get(candidate);
      if (!candidateState && !claimed.has(candidate)) {
        as = `${base}-${n}`;
        break;
      }
      if (candidateState?.isLink) continue;
      const body = candidateState?.body;
      if (body === undefined || !oursToReplace(body, candidate, plan.runId)) continue;
      const owner = body.match(RUN_MARKER)?.[1];
      if (owner && owner !== plan.runId && recentlyActive(owner, plan.runId)) {
        replacedForeign.push(`${candidate} (${owner})`);
      }
      as = `${base}-${n}`;
    }
    if (as === undefined) {
      return { names, notes: [], conflict: baseFile };
    }
    const owner = baseBody?.match(RUN_MARKER)?.[1];
    kept.push({ file: baseFile, as, why: owner ? `owned by ${owner}` : "hand-written" });
    claimed.add(`${as}.md`);
    names.push(as);
  }

  const handWritten = kept.filter((k) => k.why === "hand-written");
  if (handWritten.length) {
    notes.push(
      `kept hand-written agent file(s), seats run under a new name: ${handWritten
        .map((k) => `${k.file} → ${k.as}.md`)
        .join(", ")}`,
    );
  }
  if (replacedForeign.length) {
    notes.push(
      `replaced agent file(s) from another run (${replacedForeign.join(", ")}); concurrent role-fleet runs in one working tree are not supported — use a worktree`,
    );
  }
  const foreign = kept.filter((k) => k.why !== "hand-written");
  if (foreign.length) {
    notes.push(
      `kept agent file(s) belonging to another run (${foreign
        .map((k) => `${k.file} ${k.why}`)
        .join(", ")}); concurrent role-fleet runs in one working tree are not supported — use a worktree`,
    );
  }

  return { names, notes };
}

/**
 * Read the directory state the name resolver needs: which files exist, what
 * their bodies say, and which of them are symlinks.
 *
 * One `readdir` and one concurrent pass over the bodies that matter, instead of
 * a round trip per seat.
 */
async function readSeatFiles(dir: string, seats: readonly RoleSpec[]): Promise<Map<string, SeatFileState>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return new Map();
  }
  const present = new Set(entries);
  const wanted = new Set<string>();
  for (const role of seats) {
    const base = `${AGENT_PREFIX}${role.id}`;
    if (present.has(`${base}.md`)) wanted.add(`${base}.md`);
    for (let n = 2; n < 100; n++) {
      const candidate = `${base}-${n}.md`;
      if (present.has(candidate)) wanted.add(candidate);
    }
  }
  const states = new Map<string, SeatFileState>();
  await Promise.all(
    [...wanted].map(async (file) => {
      const path = join(dir, file);
      const [body, isLink] = await Promise.all([
        readFile(path, "utf8").catch(() => undefined),
        lstat(path).then((s) => s.isSymbolicLink()).catch(() => false),
      ]);
      states.set(file, { body, isLink });
    }),
  );
  return states;
}

/**
 * Write one agent file per role, flat in `dir`.
 *
 * `dir` must be an omp agent-discovery root — the file has to sit directly in it.
 *
 * A target this run may not take is not written over: a hand-written file, and a
 * file owned by a newer run, both move this run's seat to the next free `-N`
 * name, so the user's content survives and the seat still dispatches. Names are
 * resolved for the whole cast before the first write, so a name that cannot be
 * resolved leaves nothing on disk.
 *
 * The plan is not touched: the notes about the files this run left alone come
 * back with the seats, for the caller to record — a plan that silently ran a
 * seat under a different name than the one it printed would be the same failure
 * the notes exist to prevent.
 */
export async function emitAgents(
  plan: RolePlan,
  dir: string,
): Promise<{ agents: EmittedAgent[]; notes: string[] }> {
  // Validate the whole cast before the first write: a bad id must leave nothing
  // on disk, and the name is the one frontmatter scalar that is not quoted.
  for (const role of plan.roles) assertAgentName(`${AGENT_PREFIX}${role.id}`);
  await mkdir(dir, { recursive: true });
  // The plan's artifacts live under the run directory; create every parent up
  // front so a worker never inherits a missing one and an orchestrator reading
  // the plan does not chase a path that does not exist yet.
  const artifactParents = [...new Set(plan.roles.map((r) => dirname(r.artifact)))];
  await Promise.all(artifactParents.map((parent) => mkdir(parent, { recursive: true })));
  const waves = planWaves(plan.roles);
  const seats = waves.flat();

  const existing = await readSeatFiles(dir, seats);
  const resolution = resolveSeatNames(plan, existing, seats);
  if (resolution.conflict) {
    throw new Error(
      `${resolution.conflict} is not this run's to replace, and ${dir} holds a hundred names based on it — move them out of the way and re-run`,
    );
  }

  const emitted: EmittedAgent[] = [];
  let seat = 0;
  waves.forEach((wave, i) => {
    for (const role of wave) {
      const agent = resolution.names[seat++];
      emitted.push({
        agent,
        role: role.id,
        path: join(dir, `${agent}.md`),
        wave: i + 1,
        model: role.model,
        ...(role.modelResolved ? { modelResolved: role.modelResolved } : {}),
        effort: taskEffort(role.effort),
        artifact: role.artifact,
        dependsOn: [...(role.dependsOn ?? [])],
        writesOwnReport: grantsWrite(role.tools),
        tools: [...role.tools],
      });
    }
  });

  const notes = [...resolution.notes];

  await Promise.all(
    emitted.map(async (a) => {
      const role = plan.roles.find((r) => r.id === a.role)!;
      await writeFile(a.path, agentMarkdown(plan, role, a.agent), "utf8");
    }),
  );

  await pruneGeneratedAgents(
    dir,
    emitted.map((a) => `${a.agent}.md`),
    plan.runId,
    (path, owner) => {
      if (!recentlyActive(owner, plan.runId)) return;
      notes.push(
        `removed agent file ${path} owned by ${owner}; concurrent role-fleet runs in one working tree are not supported — use a worktree`,
      );
    },
  );

  return { agents: emitted, notes };
}

/** What a run left behind, for a reader who arrives after the session ends. */
export interface RunManifest {
  runId?: string;
  task: string;
  /** Epoch ms the run id was minted from, so the start time comes from the id
   *  itself rather than from a second clock read that could disagree with it. */
  startedAt: number;
  notes: string[];
  agents: EmittedAgent[];
  /** Appended by the settled-result hook; absent before the first seat settles. */
  outcomes?: RunOutcome[];
  /** When the manifest was last updated by the ledger. */
  updatedAt?: number;
  /** Plugin version that produced the run, for post-hoc audit. */
  pluginVersion?: string;
}

/**
 * The run's own record: what was planned, on which model, in which wave.
 *
 * The artifact tree holds seat reports and nothing that says which run produced
 * them or what the cast was. The dispatch record lived in chat notes and the
 * model-observation baseline in process memory — both gone by the next session —
 * so a finished run could not be audited at all. This is that record, written
 * where the artifacts already are.
 */
export async function writeRunManifest(workDir: string, manifest: RunManifest): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const path = join(workDir, MANIFEST_FILE);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Dispatch payload: one entry per role, grouped into waves. The main model
 * passes these to omp's own `task` tool, which runs each wave's entries
 * concurrently and preserves their per-agent models.
 */
export interface DispatchGroup {
  wave: number;
  parallel: boolean;
  /** Members of this wave wait on each other: a dependency cycle, not a batch. */
  conflicted?: boolean;
  agents: EmittedAgent[];
}

export function dispatchGroups(agents: EmittedAgent[]): DispatchGroup[] {
  const waves = [...new Set(agents.map((a) => a.wave))].sort((a, b) => a - b);
  return waves.map((wave) => {
    const group = agents.filter((a) => a.wave === wave);
    // A wave where members wait on each other is the cycle escape from
    // `planWaves` — roles released together only because nothing else could be
    // released. Telling the main model to fire them as one parallel batch would
    // hide the conflict it exists to surface.
    const conflicted = group.some((a) => group.some((b) => a.dependsOn.includes(b.role)));
    return { wave, parallel: group.length > 1 && !conflicted, conflicted, agents: group };
  });
}