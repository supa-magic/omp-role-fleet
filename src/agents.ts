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
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RolePlan, RoleSpec } from "./core.ts";
import { AGENT_PREFIX, SEAT_PURPOSE, planWaves } from "./core.ts";

import { SPECIALIST_DESCRIPTIONS } from "./library.ts";

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
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
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
 */
const REPORT_SCHEMA_YAML = [
  "output:",
  "  properties:",
  "    summary:",
  "      type: string",
  "      metadata:",
  '        description: "One-paragraph headline of the outcome. Never the deliverable itself."',
  "    report:",
  "      type: string",
  "      metadata:",
  '        description: "The complete deliverable at full depth: every finding with file:line evidence,',
  '          per-item detail, tables, and the checks actually run with their real output."',
  "    verdict:",
  "      enum: [pass, fail, blocked]",
  "      metadata:",
  '        description: "Overall outcome of this seat\'s mission."',
].join("\n");

function frontmatter(role: RoleSpec): string {
  // Library seats carry their own copy, and a council member is the reviewer
  // seat with a number on it — without these two steps every generated seat
  // shipped the same placeholder and was indistinguishable in the agent picker.
  // Own properties only: a generated id such as `constructor` passes the id
  // regex and would otherwise resolve to an inherited Function, not a string.
  const description =
    (Object.hasOwn(SEAT_DESCRIPTION, role.id) ? SEAT_DESCRIPTION[role.id] : undefined) ??
    (Object.hasOwn(SPECIALIST_DESCRIPTIONS, role.id) ? SPECIALIST_DESCRIPTIONS[role.id] : undefined) ??
    (Object.hasOwn(SEAT_DESCRIPTION, role.core) ? SEAT_DESCRIPTION[role.core] : undefined) ??
    "Role-fleet generated seat.";
  // The authority line is appended from the grant, never baked into the static
  // description above: the description is keyed by seat, and one seat can hold
  // two different grants across two runs.
  const described = `${description}${grantNote(role.tools)}`;
  return [
    "---",
    `name: ${AGENT_PREFIX}${role.id}`,
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
    ...(role.needsVision ? ["advisor: true"] : []),
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

/** The agent body: mission, task, acceptance bar, and hard constraints. */
export function agentMarkdown(plan: RolePlan, role: RoleSpec): string {
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
      return dep.tools.some((t) => t === "write" || t === "edit")
        ? `- \`${dep.id}\` → ${dep.artifact}`
        : `- \`${dep.id}\` → ${dep.artifact} (read-only role — it returns the report, the orchestrator writes it here)`;
    })
    .filter(Boolean)
    .join("\n");

  // The markers go *after* the frontmatter: YAML frontmatter must open on line
  // one, or the agent file is not loaded and the role cannot be dispatched.
  // Pruning reads them from the body, so position is free.
  return [
    frontmatter(role),
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
    "- One writer per file; never edit files owned by another role in this plan.",
    "- Do not expand scope. Smallest correct change.",
    "- Report blockers with evidence. Never invent APIs or claim a check you did not run.",
    ...(role.tools.some((t) => t === "write" || t === "edit")
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
 * Remove agent files this plugin wrote for an earlier run.
 *
 * A file is ours only when it carries `GENERATED_MARKER` *and* its frontmatter
 * `name` matches its filename — a hand-written agent, and a hand-copied rename
 * of a generated one, both fail that identity check and are left alone. A file
 * stamped with a newer run id belongs to a run still in flight, so it stays too.
 */
export async function pruneGeneratedAgents(
  dir: string,
  keep: string[],
  currentRunId?: string,
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
      if (!body.includes(GENERATED_MARKER)) continue;
      const declared = declaredName(body);
      if (!declared || `${declared}.md` !== entry) continue;
      const owner = body.match(RUN_MARKER)?.[1];
      // Numeric, through the shared comparator — see `runIdAt`. Comparing the
      // ids as text here made this guard disagree with `pruneRunDirs`.
      if (currentRunId && owner && runIdAt(owner) > runIdAt(currentRunId)) continue;
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
  // kept, the rest go.
  for (const stale of runs.slice(Math.max(0, keep))) {
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
 */
export async function emitAgents(plan: RolePlan, dir: string): Promise<EmittedAgent[]> {
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
        artifact: role.artifact,
        dependsOn: [...(role.dependsOn ?? [])],
        writesOwnReport: role.tools.includes("write") || role.tools.includes("edit"),
      });
    }
  });

  await Promise.all(
    emitted.map(async (a) => {
      const role = plan.roles.find((r) => r.id === a.role)!;
      await writeFile(a.path, agentMarkdown(plan, role), "utf8");
    }),
  );

  await pruneGeneratedAgents(
    dir,
    emitted.map((a) => `${a.agent}.md`),
    plan.runId,
  );

  return emitted;
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