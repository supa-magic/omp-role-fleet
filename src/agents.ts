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
import { isReadOnlyToolset, mcpAllowlistFromEnv, recordSeatToolset } from "./mcp-policy.ts";

/**
 * Ordering for run ids, in one place.
 *
 * Both prune guards — "is this agent file owned by a newer run?" and "which run
 * directories are stale?" — reason about the same ids and must agree, because
 * they implement one invariant. Comparing them as strings made the agent guard
 * disagree with the directory guard across a digit-count boundary (`run-999` vs
 * `run-1000`): the newer run sorted *older*, and the older run's prune deleted
 * the newer run's live agent files. Numeric, like the directory side, and like
 * the comment there already said ordering has to be.
 */
export function runIdAt(runId: string): number {
  return Number(/^run-(\d+)$/.exec(runId)?.[1] ?? Number.NaN);
}

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

/** Marks a file as plugin-generated so stale runs can be pruned safely. */
const GENERATED_MARKER = "<!-- role-fleet:generated -->";

/** Which run wrote this file: `run-<epoch ms>`, so runs order lexicographically.
 *  Ids are strictly increasing (see `nextRunId`), which is what lets the prune
 *  guard tell "stale, finished run" from "newer run still in flight". */
const RUN_MARKER = /<!-- role-fleet:run (run-\d+) -->/;

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
 * matters. The real answer is host-side (`model-observed.ts`) and is recorded
 * from the settled result rather than asked for.
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
    // Without this the seat has no `yield` tool and its last assistant turn is
    // the whole result: a paragraph, trimmed by the parent's own budget, which
    // is the summary-only failure this schema exists to remove.
    REPORT_SCHEMA_YAML,
    // `advisor: true` asks the host for its default advisor-role model. The
    // string spelling ("@advisor") is a model pattern instead, and a
    // self-referential one trips the host's cycle guard and silently degrades
    // to the built-in priority list. Vision itself is not a frontmatter key —
    // a vision seat is a seat whose model alias resolves to a vision model.
    //
    // Who earns it: the seats where being wrong is expensive and the work is
    // not already cross-checked. The planner decides the shape every later wave
    // follows, and a wrong plan poisons all of them; the implementer is the
    // longest-running seat and the one that declares the work done. Keyed on
    // `core`, so `migration-runner` and a proposed writer — the implementer seat
    // under other ids — are covered by the same rule. Review seats are excluded
    // on purpose: their value is independence *from* the cast, and a second
    // model reviewing the reviewer's own turns buys agreement, not a second
    // opinion. The grant is real but not free — the host pairs the seat's own
    // session with the advisor model, which passively reviews each of its turns,
    // so the cost scales with how long the seat runs and with whatever model the
    // `advisor` role points at. It is also inert without one: subagents default
    // to no advisor, this frontmatter is the opt-in, and the host's
    // `task.agentAdvisor` setting overrides it per seat (`{"rf-planner": "off"}`).
    ...(role.needsVision || role.core === "planner" || role.core === "implementer"
      ? ["advisor: true"]
      : []),
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
 */
function modelNote(model: string, resolved?: string): string {
  if (resolved) return ` → resolved to \`${resolved}\``;
  return model.startsWith("@") ? " (not resolved at plan time)" : "";
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
      // the report belongs: the agent returns it and the orchestrator places it
      // there. Saying "its final message" instead would name a channel the
      // downstream agent cannot read — it has no link to any other agent. A
      // writable dep writes the file itself and needs no such note.
      return dep.tools.some((t) => t === "write" || t === "edit" || t === "bash")
        ? `- \`${dep.id}\` → ${dep.artifact}`
        : `- \`${dep.id}\` → ${dep.artifact} (read-only role — it returns the report, the orchestrator writes it here)`;
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
    `Model: \`${role.model}\`${modelNote(role.model, role.modelResolved)}`,
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
          `- You have no write access. Yield your full report — it belongs at \`${role.artifact}\`, and the orchestrator writes it there.`,
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
  /**
   * Whether the seat can write its own artifact.
   *
   * False means nobody but the orchestrator places that file, which is a fact
   * the dispatch prompt has to carry: the seat's own brief promises the path and
   * cannot keep the promise.
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

/** A run directory this plugin created: `run-<epoch ms>`, nothing else. */
const RUN_DIR = /^run-(\d+)$/;

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
    .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
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

/**
 * Write one agent file per role, flat in `dir`.
 *
 * `dir` must be an omp agent-discovery root — the file has to sit directly in it.
 *
 * A target this run may not take is not written over: a hand-written file, and a
 * file owned by a newer run, both move this run's seat to the next free `-N`
 * name, so the user's content survives and the seat still dispatches. Names are
 * resolved for the whole cast before the first write, so a name that cannot be
 * resolved leaves nothing on disk. Anything left alone is appended to
 * `plan.notes` — a plan that silently ran a seat under a different name than the
 * one it printed would be the same failure the notes exist to prevent.
 */
export async function emitAgents(plan: RolePlan, dir: string): Promise<EmittedAgent[]> {
  // Validate the whole cast before the first write: a bad id must leave nothing
  // on disk, and the name is the one frontmatter scalar that is not quoted.
  for (const role of plan.roles) assertAgentName(`${AGENT_PREFIX}${role.id}`);
  await mkdir(dir, { recursive: true });
  // The plan's artifacts live under the run directory; create every parent up
  // front so a worker never inherits a missing one and an orchestrator reading
  // the plan does not chase a path that does not exist yet. Taking only the
  // first role's parent held while every artifact shared `workDir`, and would
  // quietly miss any plan that gave a seat its own directory.
  const artifactParents = [...new Set(plan.roles.map((r) => dirname(r.artifact)))];
  await Promise.all(artifactParents.map((parent) => mkdir(parent, { recursive: true })));
  const waves = planWaves(plan.roles);
  const emitted: EmittedAgent[] = [];

  waves.forEach((wave, i) => {
    for (const role of wave) {
      emitted.push({
        agent: `${AGENT_PREFIX}${role.id}`,
        role: role.id,
        path: join(dir, `${AGENT_PREFIX}${role.id}.md`),
        wave: i + 1,
        model: role.model,
        ...(role.modelResolved ? { modelResolved: role.modelResolved } : {}),
        effort: taskEffort(role.effort),
        artifact: role.artifact,
        dependsOn: [...(role.dependsOn ?? [])],
        writesOwnReport: grantsWrite(role.tools),
      });
    }
  });

  // Resolution pass: read the targets once, and decide for every seat whether
  // the name it wants is this run's to take.
  const entries = new Set(await readdir(dir).catch((): string[] => []));
  // Every seat's own base name is reserved before any suffix is handed out. A
  // proposed role whose literal id is `x-2` and a renamed seat looking for a
  // free `rf-x-2.md` would otherwise resolve to the same file, and the last
  // writer would silently run the other seat's brief.
  const reserved = new Set(emitted.map((a) => `${a.agent}.md`));
  const replacedForeign: string[] = [];
  const isLink = async (file: string): Promise<boolean> =>
    lstat(join(dir, file)).then((s) => s.isSymbolicLink()).catch(() => false);
  const kept: Array<{ file: string; as: string; why: string }> = [];
  for (const a of emitted) {
    const base = `${a.agent}.md`;
    if (!entries.has(base)) continue;
    const baseBody = await readFile(join(dir, base), "utf8").catch(() => undefined);
    // An unreadable file is left alone too — `undefined` falls through to the
    // suffix search rather than being treated as this run's to overwrite. A
    // symlink is never written through: the target is outside what this plugin
    // created, and `pruneGeneratedAgents` already removes the link, not the target.
    if (baseBody !== undefined && !(await isLink(base)) && oursToReplace(baseBody, base, plan.runId)) {
      const owner = baseBody.match(RUN_MARKER)?.[1];
      if (owner && owner !== plan.runId && recentlyActive(owner, plan.runId)) {
        replacedForeign.push(`${base} (${owner})`);
      }
      continue;
    }
    // Take the first suffix that is free *or ours to replace*. Stopping at the
    // first free one instead would climb a new name on every run for as long as
    // the hand-written file sits there, leaving a trail of near-duplicate seats.
    let as: string | undefined;
    for (let n = 2; n < 100 && as === undefined; n++) {
      const candidate = `${a.agent}-${n}.md`;
      if (reserved.has(candidate)) continue;
      if (!entries.has(candidate)) {
        as = `${a.agent}-${n}`;
        break;
      }
      if (await isLink(candidate)) continue;
      const body = await readFile(join(dir, candidate), "utf8").catch(() => undefined);
      if (body !== undefined && oursToReplace(body, candidate, plan.runId)) {
        const owner = body.match(RUN_MARKER)?.[1];
        if (owner && owner !== plan.runId && recentlyActive(owner, plan.runId)) {
          replacedForeign.push(`${candidate} (${owner})`);
        }
        as = `${a.agent}-${n}`;
      }
    }
    if (as === undefined) {
      throw new Error(
        `${base} is not this run's to replace, and ${dir} holds a hundred names based on it — move them out of the way and re-run`,
      );
    }
    const owner = baseBody?.match(RUN_MARKER)?.[1];
    kept.push({ file: base, as, why: owner ? `owned by ${owner}` : "hand-written" });
    entries.add(`${as}.md`);
    a.agent = as;
    a.path = join(dir, `${as}.md`);
  }
  const handWritten = kept.filter((k) => k.why === "hand-written");
  if (handWritten.length) {
    plan.notes.push(
      `kept hand-written agent file(s), seats run under a new name: ${handWritten
        .map((k) => `${k.file} → ${k.as}.md`)
        .join(", ")}`,
    );
  }
  if (replacedForeign.length) {
    plan.notes.push(
      `replaced agent file(s) from another run (${replacedForeign.join(", ")}); concurrent role-fleet runs in one working tree are not supported — use a worktree`,
    );
  }
  const foreign = kept.filter((k) => k.why !== "hand-written");
  if (foreign.length) {
    plan.notes.push(
      `kept agent file(s) belonging to another run (${foreign
        .map((k) => `${k.file} ${k.why}`)
        .join(", ")}); concurrent role-fleet runs in one working tree are not supported — use a worktree`,
    );
  }

  await Promise.all(
    emitted.map(async (a) => {
      const role = plan.roles.find((r) => r.id === a.role)!;
      await writeFile(a.path, agentMarkdown(plan, role, a.agent), "utf8");
    }),
  );

  // The toolsets of the seats this run minted, so a later MCP tool call can be
  // judged against the grant the seat actually got: a read-only seat holds
  // every connected MCP tool (MCP is additive to a definition's `tools:`), and
  // the host runs subagents unattended, so the plugin refuses the MCP calls a
  // read-only seat was not allowed.
  for (const a of emitted) {
    const role = plan.roles.find((r) => r.id === a.role)!;
    recordSeatToolset(a.agent, role.tools);
  }

  await pruneGeneratedAgents(
    dir,
    emitted.map((a) => `${a.agent}.md`),
    plan.runId,
    (path, owner) => {
      if (!recentlyActive(owner, plan.runId)) return;
      plan.notes.push(
        `removed agent file ${path} owned by ${owner}; concurrent role-fleet runs in one working tree are not supported — use a worktree`,
      );
    },
  );

  return emitted;
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
  const path = join(workDir, "plan.json");
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