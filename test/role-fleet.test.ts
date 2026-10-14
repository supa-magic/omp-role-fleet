import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { aliasFor, bindFleet, planWaves, validatePlan, type Fleet, type RoleSpec } from "../src/core.ts";
import { synthesizePlan } from "../src/synthesize.ts";
import { gatePlan } from "../src/advisor.ts";
import { agentMarkdown, dispatchGroups, emitAgents } from "../src/agents.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderDispatch, renderPlan } from "../src/render.ts";

function planFor(task: string, maxRoles?: number) {
  return synthesizePlan({ task, cwd: "/tmp", workDir: "/tmp/wf", maxRoles });
}

// ── alias mapping ─────────────────────────────────────────────────────────────

test("every capability maps to an omp model-role alias", () => {
  assert.equal(aliasFor("scout"), "@smol");
  assert.equal(aliasFor("planner"), "@plan");
  assert.equal(aliasFor("implementer"), "@task");
  assert.equal(aliasFor("reviewer"), "@slow");
  assert.equal(aliasFor("tester"), "@smol", "running checks is mechanical; diagnosis is the implementer's job");
  assert.equal(aliasFor("security"), "@slow");
  // An unknown seat degrades to the general subagent role, never to a guess.
  assert.equal(aliasFor("unknown-seat"), "@task");
});

// ── plan synthesis ────────────────────────────────────────────────────────────

test("a code task plans implementer plus a dependent reviewer on @task/@slow", () => {
  const plan = planFor("fix the auth bug in src/auth.ts");
  const impl = plan.roles.find((r) => r.id === "implementer")!;
  const review = plan.roles.find((r) => r.id === "reviewer")!;
  assert.equal(impl.model, "@task");
  assert.equal(review.model, "@slow");
  assert.ok(review.depends_on.includes("implementer"));
  assert.deepEqual(validatePlan(plan), []);
});

test("recon is cheap: the scout rides @smol", () => {
  assert.equal(planFor("fix the bug").roles.find((r) => r.id === "scout")!.model, "@smol");
});

test("planning is reserved for multi-file work and rides @plan", () => {
  const plan = planFor("refactor the auth module across several files");
  const planner = plan.roles.find((r) => r.id === "planner");
  assert.ok(planner, "multi-file work earns a planner");
  assert.equal(planner!.model, "@plan");
  assert.ok(!planFor("fix the login bug").roles.some((r) => r.id === "planner"));
});

test("research-only tasks plan investigation, not implementation", () => {
  const plan = planFor("research and compare competitor pricing");
  assert.ok(plan.roles.some((r) => r.id === "scout"));
  assert.ok(!plan.roles.some((r) => r.id === "implementer"));
});

test("the role cap keeps the implementer and records what was dropped", () => {
  const plan = planFor("refactor the whole repo across several files and update the docs", 2);
  assert.equal(plan.roles.length, 2);
  assert.ok(plan.roles.some((r) => r.id === "implementer"));
  assert.ok(plan.notes.some((n) => n.startsWith("role cap")));
});

// ── waves ─────────────────────────────────────────────────────────────────────

test("waves are dependency-ordered and cover every role", () => {
  const plan = planFor("refactor across several files");
  const waves = planWaves(plan.roles);
  const seen = new Set<string>();
  for (const wave of waves) {
    for (const r of wave) {
      for (const d of r.depends_on) assert.ok(seen.has(d), `${r.id} ran before ${d}`);
      seen.add(r.id);
    }
  }
  assert.equal(waves.flat().length, plan.roles.length);
});

test("a dependency cycle still terminates in a final wave", () => {
  const base = planFor("x").roles[0];
  const a: RoleSpec = { ...base, id: "a", depends_on: ["b"] };
  const b: RoleSpec = { ...base, id: "b", depends_on: ["a"] };
  const waves = planWaves([a, b]);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].length, 2);
});

// ── gate ──────────────────────────────────────────────────────────────────────

test("the gate rejects plans with unknown dependencies and missing acceptance", () => {
  const plan = planFor("fix the bug");
  const tampered = { ...plan, roles: [{ ...plan.roles[0], depends_on: ["ghost"], acceptance: [] }] };
  const gate = gatePlan(tampered);
  assert.equal(gate.ok, false);
  assert.ok(gate.verdict.issues.some((i) => i.includes("unknown dependency")));
  assert.ok(gate.verdict.issues.some((i) => i.includes("acceptance")));
});

// ── allowlist exception ───────────────────────────────────────────────────────

const FLEET: Fleet = {
  models: [
    { selector: "fast/model", aliases: ["fast"], enabled: true },
    { selector: "smart/model", aliases: ["smart"], enabled: true },
    { selector: "off/model", aliases: [], enabled: false },
  ],
  roles: [
    {
      role: "scout",
      aliases: [],
      chain: ["fast/model"],
    },
  ],
};

test("an allowlist pins concrete selectors for seats it describes", () => {
  const plan = planFor("fix the bug");
  const gate = gatePlan(plan, FLEET);
  assert.equal(gate.ok, true);
  const scout = gate.plan!.roles.find((r) => r.id === "scout")!;
  assert.equal(scout.model, "fast/model");
});

test("a seat missing from the allowlist keeps its alias, with a note", () => {
  const notes: string[] = [];
  const roles = bindFleet(FLEET, planFor("fix the bug").roles, notes);
  const impl = roles.find((r) => r.id === "implementer")!;
  assert.equal(impl.model, "@task");
  assert.ok(notes.some((n) => n.includes("implementer")));
});

test("a disabled model is never picked from an allowlist", () => {
  const notes: string[] = [];
  const fleetOff = { ...FLEET, roles: [{ ...FLEET.roles[0], chain: ["off/model", "fast/model"] }] };
  const roles = bindFleet(fleetOff, planFor("fix the bug").roles, notes);
  assert.equal(roles.find((r) => r.id === "scout")!.model, "fast/model");
});

/** Three enabled models and one reviewer seat, the shape a council needs. */
const COUNCIL_FLEET: Fleet = {
  models: [
    { selector: "xai/grok-4", aliases: ["grok"], enabled: true },
    { selector: "minimax/m2", aliases: ["mm"], enabled: true },
    { selector: "zai/glm-5", aliases: ["glm"], enabled: true },
  ],
  roles: [
    {
      role: "reviewer",
      aliases: [],
      chain: ["xai/grok-4", "minimax/m2", "zai/glm-5"],
    },
  ],
};

test("an allowlist keeps a review council on distinct models", () => {
  const plan = synthesizePlan({
    task: "review with different providers",
    cwd: "/tmp",
    workDir: "/tmp/wf",
    council: 3,
  });
  const gate = gatePlan(plan, COUNCIL_FLEET);
  assert.equal(gate.ok, true);
  const members = gate.plan!.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3);
  assert.equal(
    new Set(members.map((m) => m.model)).size,
    3,
    `council collapsed onto one model: ${members.map((m) => m.model).join(", ")}`,
  );
});

test("a council keeps its own aliases when the file has too few models to spread", () => {
  const oneModel: Fleet = { ...COUNCIL_FLEET, roles: [{ ...COUNCIL_FLEET.roles[0], chain: ["zai/glm-5"] }] };
  const notes: string[] = [];
  const plan = synthesizePlan({ task: "review with different providers", cwd: "/tmp", workDir: "/tmp/wf", council: 3 });
  const roles = bindFleet(oneModel, plan.roles, notes);
  const members = roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(new Set(members.map((m) => m.model)).size, 3, "the spread must not silently collapse");
  assert.ok(notes.some((n) => n.includes("keeping")), "a shortfall must be reported");
});

test("an allowlist chain entry naming an alias emits the canonical selector", () => {
  const byAlias = { ...FLEET, roles: [{ ...FLEET.roles[0], chain: ["smart"] }] };
  const roles = bindFleet(byAlias, planFor("fix the bug").roles, []);
  assert.equal(roles.find((r) => r.id === "scout")!.model, "smart/model");
});

test("a chain entry resolves despite case and padding in a hand-edited file", () => {
  const sloppy = { ...FLEET, roles: [{ ...FLEET.roles[0], chain: [" Fast/Model "] }] };
  const roles = bindFleet(sloppy, planFor("fix the bug").roles, []);
  assert.equal(roles.find((r) => r.id === "scout")!.model, "fast/model");
});

test("a seat with no usable chain says so instead of claiming it is absent", () => {
  const notes: string[] = [];
  const deadChain = { ...FLEET, roles: [{ ...FLEET.roles[0], chain: ["off/model"] }] };
  const roles = bindFleet(deadChain, planFor("fix the bug").roles, notes);
  assert.equal(roles.find((r) => r.id === "scout")!.model, "@smol");
  const scoutNotes = notes.filter((n) => n.startsWith("role scout:"));
  assert.ok(
    scoutNotes.some((n) => n.includes("no enabled model")),
    `expected a chain-specific note, got: ${scoutNotes.join(" | ")}`,
  );
  assert.ok(
    !scoutNotes.some((n) => n.includes("not in allowlist")),
    "a seat the file does describe is never reported as absent",
  );
});

test("a malformed allowlist entry is refused with its path and index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-bad-fleet-"));
  const bad = join(dir, "fleet.json");
  await writeFile(bad, JSON.stringify({ models: [{ aliases: ["fast"] }], roles: [] }), "utf8");
  await assert.rejects(() => runRoleFleet({ task: "fix the bug", cwd: dir, allowlist: bad }), /models\[0\]/);
});

// ── agent emission ────────────────────────────────────────────────────────────

test("emitted agents are valid omp definitions with alias models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-agents-"));
  const plan = planFor("fix the auth bug in src/auth.ts and add tests");
  const agents = await emitAgents(plan, dir);

  assert.equal(agents.length, plan.roles.length);
  assert.equal((await readdir(dir)).length, plan.roles.length);
  // omp scans agents/*.md directly, so nothing may land in a subdirectory.
  assert.equal(dirname(agents[0].path), dir);

  const body = await readFile(agents[0].path, "utf8");
  assert.match(body, /^---\nname: /m);
  assert.match(body, /^model: "@/m);
  assert.match(body, /^thinking-level: /m);
  // Generated seats are namespaced so they never replace a bundled specialist.
  for (const a of agents) {
    assert.ok(a.agent.startsWith("rf-"), `unprefixed agent name: ${a.agent}`);
    assert.ok(a.path.endsWith(`${a.agent}.md`));
  }
});

test("dirty task text cannot break the frontmatter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-dirty-"));
  const task = 'do the thing with "quotes", --- dashes,\nand a newline';
  const result = await runRoleFleet({ task, cwd: dir });
  assert.equal(result.ok, true);
  for (const agent of result.agents) {
    const body = await readFile(agent.path, "utf8");
    const fm = body.split("---")[1] ?? "";
    // Every frontmatter line is a known key: task text lives only in the body.
    const known = new Set(["name", "description", "tools", "model", "thinking-level", "advisor"]);
    for (const line of fm.split("\n").filter(Boolean)) {
      assert.ok(known.has(line.trim().split(":")[0]), `stray frontmatter line: ${line.slice(0, 60)}`);
    }
    assert.match(fm, /^name: rf-/m);
    // The dirty text itself appears in the body, unharmed.
    assert.ok(body.includes("quotes"));
  }
});

test("a later plan prunes its own stale agents but never a hand-written one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-prune-"));
  await writeFile(join(dir, "mine.md"), "---\nname: mine\ndescription: hand written\n---\n", "utf8");

  await emitAgents(planFor("fix the auth bug"), dir);
  await emitAgents(planFor("update the readme and changelog"), dir);

  const files = await readdir(dir);
  assert.ok(files.includes("mine.md"), "hand-written agent was deleted");
  assert.ok(!files.some((f) => f.startsWith("rf-reviewer.")), "stale generated agent survived");
});

test("a hand-copied rename of a generated agent survives the next run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-rename-"));
  await emitAgents(planFor("fix the auth bug"), dir);
  const body = await readFile(join(dir, "rf-scout.md"), "utf8");
  await writeFile(join(dir, "rf-scout-copy.md"), body, "utf8");

  await emitAgents(planFor("update the readme and changelog"), dir);

  const files = await readdir(dir);
  assert.ok(files.includes("rf-scout-copy.md"), "a renamed copy is the user's file, not stale output");
  // The second plan is analysis-only, so its implementer file is genuinely stale.
  assert.ok(!files.includes("rf-implementer.md"), "the stale generated file itself must still go");
});

test("a vision seat asks for the host's default advisor, not a model pattern", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-vision-"));
  const plan = planFor("redesign the landing page");
  const designer = plan.roles.find((r) => r.id === "designer");
  assert.ok(designer, "the designer seat must be part of the plan");
  const emitted = await emitAgents(plan, dir);
  const body = await readFile(emitted.find((a) => a.role === "designer")!.path, "utf8");
  assert.match(body, /^advisor: true$/m);
  assert.ok(!body.includes('"@advisor"'), "a self-referential advisor pattern silently degrades in the host");
  // A generic blurb makes every generated seat indistinguishable in the picker.
  assert.match(body, /description: "Role-fleet designer:/);
});

test("a dependency cycle is dispatched sequentially, not as one parallel batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-cycle-"));
  const role = (id: string, depends_on: string[]): RoleSpec => ({
    id,
    title: id,
    mission: "m",
    acceptance: ["a finding with file:line"],
    core: "implementer",
    depends_on,
    tools: ["read"],
    effort: "low",
    needs_vision: false,
    artifact: join(dir, `${id}.md`),
    model: "@task",
  });
  const cycle = { task: "cycle", cwd: dir, roles: [role("alpha", ["beta"]), role("beta", ["alpha"])], notes: [] };
  const groups = dispatchGroups(await emitAgents(cycle, dir));

  assert.equal(groups.length, 1);
  assert.equal(groups[0].parallel, false, "a cycle released together is a conflict, not a batch");
  assert.equal(groups[0].conflicted, true);
  assert.match(renderDispatch(groups, dir), /dependency conflict/);
});

test("an audit-shaped council plan survives the gate", () => {
  const plan = synthesizePlan({
    task: "audit the API surface for security issues",
    cwd: "/tmp",
    workDir: "/tmp/wf",
    council: 3,
  });
  const errors = validatePlan(plan);
  assert.deepEqual(errors, [], `the audit thinning left dangling edges: ${errors.join("; ")}`);
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3);
});

test("dependents follow the specialist that replaced the implementer", () => {
  const plan = planFor("migrate the api client to the new sdk and fix the tests");
  const ids = new Set(plan.roles.map((r) => r.id));
  assert.ok(ids.has("migration-runner"), "the migration specialist must be in the plan");
  assert.ok(!ids.has("implementer"), "the specialist replaced the generic implementer");
  for (const role of plan.roles) {
    for (const dep of role.depends_on ?? []) {
      assert.ok(ids.has(dep), `${role.id} still waits on the removed ${dep}`);
    }
  }
});

test("agent markdown quotes the alias so YAML stays valid", () => {
  const role = planFor("fix the bug").roles[0];
  assert.ok(agentMarkdown(planFor("fix the bug"), role).includes(`model: "${role.model}"`));
});

test("dispatch groups mirror dependency waves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-groups-"));
  const groups = dispatchGroups(await emitAgents(planFor("fix the auth bug"), dir));
  const impl = groups.flatMap((g) => g.agents).find((a) => a.role === "implementer")!;
  const review = groups.flatMap((g) => g.agents).find((a) => a.role === "reviewer")!;
  assert.ok(review.wave > impl.wave);
  assert.match(renderDispatch(groups, dir), /parallel task batch/);
});

// ── end-to-end pipeline ───────────────────────────────────────────────────────

test("the pipeline runs with no configuration at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-pipe-"));
  const result = await runRoleFleet({ task: "fix the auth bug in src/auth.ts", cwd: dir });
  assert.equal(result.ok, true);
  assert.ok(result.plan && result.plan.roles.length > 0);
  assert.ok(result.plan!.roles.every((r) => r.model.startsWith("@")));
  const files = await readdir(join(dir, ".omp", "agents"));
  assert.equal(files.length, result.plan!.roles.length);
});

test("dry-run writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-dry-"));
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.agentDir, null);
  assert.equal(result.agents.length, 0);
  assert.ok(result.waves.length > 0);
  assert.match(renderPlan(result.plan!, result.waves), /@smol|@task/);
});

test("an explicit allowlist file pins the pipeline's models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-pin-"));
  const allowlist = join(dir, "fleet.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(allowlist, JSON.stringify(FLEET), "utf8");

  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir, allowlist });
  assert.equal(result.ok, true);
  assert.equal(result.plan!.roles.find((r) => r.id === "scout")!.model, "fast/model");
});

test("a malformed allowlist is refused, not ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-bad-"));
  const allowlist = join(dir, "fleet.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(allowlist, JSON.stringify({ models: [] }), "utf8");

  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir, allowlist }).then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(result);
  assert.match(result.message, /non-empty/);
});
test("the run directory exists as soon as agents are emitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-rundir-"));
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir });
  assert.equal(result.ok, true);
  // The plan's artifacts point into the run dir; reading any of their parents
  // must succeed the moment dispatch materializes the plan.
  const stat = await import("node:fs/promises");
  for (const role of result.plan!.roles) {
    await stat.access(dirname(role.artifact));
  }
});
