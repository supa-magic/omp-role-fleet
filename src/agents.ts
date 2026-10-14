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
import { planWaves } from "./core.ts";
import { SPECIALIST_DESCRIPTIONS } from "./library.ts";

/** Marks a file as plugin-generated so stale runs can be pruned safely. */
const GENERATED_MARKER = "<!-- role-fleet:generated -->";

/** Which run wrote this file: `run-<epoch ms>`, so runs order lexicographically.
 *  Ids are strictly increasing (see `nextRunId`), which is what lets the prune
 *  guard tell "stale, finished run" from "newer run still in flight". */
const RUN_MARKER = /<!-- role-fleet:run (run-\d+) -->/;

function runStamp(runId: string | undefined): string {
  return `<!-- role-fleet:run ${runId ?? "run-0"} -->`;
}

/**
 * Prefix for every generated agent name.
 *
 * omp resolves an agent by name with project definitions replacing bundled
 * ones, so emitting `scout.md` would silently swap the bundled scout for this
 * plan's mission text for the whole session. Namespaced `rf-*` names keep the
 * generated seats and the bundled specialists independent.
 */
const AGENT_PREFIX = "rf-";

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
const SEAT_DESCRIPTION: Record<string, string> = {
  scout: "Role-fleet investigator: map where the task touches, with file:line evidence. Read-only.",
  planner: "Role-fleet planner: turn the investigation into a locked implementation plan. Read-only.",
  implementer: "Role-fleet implementer: execute the locked plan with the smallest correct change.",
  tester: "Role-fleet tester: run the focused checks and report real output.",
  reviewer: "Role-fleet reviewer: correctness, scope, and evidence review of the delivered change. Read-only.",
  "docs-updater": "Role-fleet docs updater: keep user-facing documentation true to shipped behavior.",
};

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
  return [
    "---",
    `name: ${AGENT_PREFIX}${role.id}`,
    `description: ${yamlString(description)}`,
    `tools: [${role.tools.join(", ")}]`,
    `model: ${yamlString(role.model)}`,
    `thinking-level: ${role.effort}`,
    // `advisor: true` asks the host for its default advisor-role model. The
    // string spelling ("@advisor") is a model pattern instead, and a
    // self-referential one trips the host's cycle guard and silently degrades
    // to the built-in priority list. Vision itself is not a frontmatter key —
    // a vision seat is a seat whose model alias resolves to a vision model.
    ...(role.needs_vision ? ["advisor: true"] : []),
    "---",
    "",
  ].join("\n");
}

/** The agent body: mission, task, acceptance bar, and hard constraints. */
export function agentMarkdown(plan: RolePlan, role: RoleSpec): string {
  const deps = (role.depends_on ?? []).filter(Boolean);
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
    "## Constraints",
    "",
    `- Stay inside your tool grant: ${role.tools.join(", ")}.`,
    "- One writer per file; never edit files owned by another role in this plan.",
    "- Do not expand scope. Smallest correct change.",
    "- Report blockers with evidence. Never invent APIs or claim a check you did not run.",
    // A role that cannot write must not be told to write. A read-only seat
    // (scout, reviewer, security-auditor) has no write tool, so an artifact
    // path in its brief is an instruction it cannot follow — the agent then
    // reports the blocked path instead of the findings, and the work is lost.
    // It returns the report; whoever runs the fleet puts it at that path.
    ...(role.tools.some((t) => t === "write" || t === "edit")
      ? [`- Write your report to \`${role.artifact}\`.`]
      : [
          `- You have no write access. Return your report as your final message — it belongs at \`${role.artifact}\`, and the orchestrator writes it there.`,
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
  artifact: string;
  dependsOn: string[];
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
      const declared = body.match(/^---\n(?:.*\n)*?^name: (.+)$/m)?.[1]?.trim();
      if (!declared || `${declared}.md` !== entry) continue;
      const owner = body.match(RUN_MARKER)?.[1];
      if (currentRunId && owner && owner > currentRunId) continue;
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
  const currentAt = Number(RUN_DIR.exec(currentRunId)?.[1] ?? Number.NaN);
  const runs = entries
    .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
    .map((e) => ({ name: e.name, at: Number(RUN_DIR.exec(e.name)![1]) }))
    // Numeric, not lexical: ordering must not depend on the epoch's digit count.
    .sort((a, b) => b.at - a.at)
    // Spare the current run and anything newer than it. Ids are strictly
    // increasing (`nextRunId`), so a newer directory belongs to a run still in
    // flight — the same invariant the agent prune keeps with `owner >
    // currentRunId`. Without it, one slow run finishing after a burst of eleven
    // would delete every one of those in-flight artifact directories.
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
  // The plan's artifacts live under the run directory; create it up front so a
  // worker never inherits a missing parent and an orchestrator reading the plan
  // does not chase a path that does not exist yet.
  await mkdir(dirname(plan.roles[0]?.artifact ?? dir), { recursive: true });
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
        artifact: role.artifact,
        dependsOn: [...(role.depends_on ?? [])],
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