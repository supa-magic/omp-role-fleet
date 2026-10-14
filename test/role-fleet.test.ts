import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { aliasFor, bindFleet, planWaves, validatePlan, type Fleet, type RoleSpec } from "../src/core.ts";
import { synthesizePlan } from "../src/synthesize.ts";
import { gatePlan } from "../src/gate.ts";
import { agentMarkdown, dispatchGroups, emitAgents, pruneRunDirs, type DispatchGroup } from "../src/agents.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderDispatch, renderPlan, renderVerdict } from "../src/render.ts";

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

test("a model name with a newline cannot inject frontmatter keys", () => {
  // The only frontmatter value that can arrive from outside this file is the
  // model, selected from a user's allowlist. A newline inside it would close
  // the scalar and let the remainder inject arbitrary keys.
  const role = { ...planFor("fix the bug").roles[0], model: '@task"\ntools: [write, bash]' };
  const fm = agentMarkdown(planFor("fix the bug"), role).split("---")[1] ?? "";

  const known = new Set(["name", "description", "tools", "model", "thinking-level", "advisor"]);
  for (const line of fm.split("\n").filter(Boolean)) {
    assert.ok(known.has(line.trim().split(":")[0]), `stray frontmatter line: ${line.slice(0, 60)}`);
  }
  assert.equal((fm.match(/^tools:/gm) ?? []).length, 1, "tools key must not be injected twice");
});

test("a generated id that names a prototype member still yields a valid agent", () => {
  // `constructor` passes the id regex and is not a reserved seat, so the
  // description lookup must not resolve to an inherited Function.
  const plan = planFor("fix the bug");
  const role = { ...plan.roles[0], id: "constructor", title: "odd seat", model: "@task" };
  const fm = agentMarkdown(plan, role).split("---")[1] ?? "";

  assert.match(fm, /^description: "Role-fleet /m);
  assert.match(fm, /^name: rf-constructor$/m);
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

test("a seat spelled two ways still spreads a council across distinct models", () => {
  // "reviewer" and "Reviewer" normalize to one seat, so they must share one
  // ordinal counter too: independent counters give both chain[0] and collapse
  // the multi-model spread the ordinal exists to guarantee.
  const councilFleet: Fleet = {
    models: [
      { selector: "fast/model", aliases: ["fast"] },
      { selector: "slow/model", aliases: ["slow"] },
    ],
    roles: [{ role: "reviewer", chain: ["fast", "slow"] }],
  };
  const base = planFor("fix the auth bug").roles[0];
  const notes: string[] = [];
  const bound = bindFleet(
    councilFleet,
    [
      { ...base, id: "reviewer-c1", core: "reviewer" },
      { ...base, id: "reviewer-c2", core: "Reviewer" },
    ],
    notes,
  );
  assert.equal(bound[0].model, "fast/model");
  assert.equal(bound[1].model, "slow/model");
});

test("council members do not share one depends_on array", () => {
  // One shared instance meant any in-place edit of one member's dependencies
  // edited all of them — a hazard the moment anything mutates a plan.
  const plan = synthesizePlan({
    task: "review with different providers",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 3,
  });
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3);
  assert.equal(new Set(members.map((m) => m.depends_on)).size, 3, "each member needs its own array");

  // And mutating one really does leave the others alone.
  members[0]!.depends_on.push("scout");
  assert.deepEqual(members[1]!.depends_on, ["scout"]);
});

test("roster ids stay unique and within budget even when truncation collides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-roster-"));
  const plan = synthesizePlan({ task: "fix the bug", cwd: dir, workDir: dir });
  // Ids identical for far longer than the 32-character budget, so truncation
  // alone collapses them to one string.
  const twin = (id: string) => ({
    agent: `rf-${id}`,
    role: id,
    path: "",
    wave: 2,
    model: "@task",
    artifact: "",
    dependsOn: [],
  });
  const groups: DispatchGroup[] = [
    {
      wave: 1,
      parallel: true,
      conflicted: false,
      agents: [
        twin("payment-domain-consistency-audit-of-the-ledger-alpha"),
        twin("payment-domain-consistency-audit-of-the-ledger-beta"),
      ],
    },
  ];

  const text = renderDispatch(groups, dir);
  const names = [...text.matchAll(/"name": "([^"]+)"/g)].map((m) => m[1]!);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2, `roster ids must be unique: ${names.join(" | ")}`);
  for (const n of names) assert.ok(n.length <= 32, `roster id over budget: ${n}`);
});

test("a council exempt from the cap still reports the real fan-out", () => {
  const plan = synthesizePlan({
    task: "fix the auth bug",
    cwd: "/tmp",
    workDir: "/tmp/wf",
    maxRoles: 2,
    council: 3,
  });
  assert.ok(plan.roles.length > 2, "the council is deliberately exempt from the cap");
  assert.ok(
    plan.notes.some((n) => n.includes("exceeded") && n.includes(String(plan.roles.length))),
    `the plan must say it shipped more roles than the cap: ${plan.notes.join(" | ")}`,
  );
});

test("a read-only role is told to return its report, not to write a file", () => {
  const plan = planFor("fix the auth bug");
  const scout = plan.roles.find((r) => r.id === "scout")!;
  const impl = plan.roles.find((r) => r.id === "implementer")!;
  assert.ok(!scout.tools.includes("write"), "the scout seat must be read-only");

  // A brief that orders a write the grant cannot perform is an instruction the
  // agent must fail: it reports the blocked path instead of the findings.
  const scoutBody = agentMarkdown(plan, scout);
  assert.ok(!scoutBody.includes("- Write your report to"), "a read-only role must not be told to write");
  assert.match(scoutBody, /[Rr]eturn your report as your final message/);
  // The artifact path stays in the brief and names who writes it: the report
  // belongs at that path either way, and a downstream agent has no way to read
  // any other agent's message.
  assert.match(scoutBody, /scout\.md/, "the read-only role must still name its artifact path");

  // A writer still gets its artifact path — that is how the run collects it.
  assert.match(agentMarkdown(plan, impl), /Write your report to `.*implementation\.md`/);
});

test("an upstream read-only dependency names its path and who writes it", () => {
  const plan = planFor("fix the auth bug");
  const impl = plan.roles.find((r) => r.id === "implementer")!;
  const scoutArtifact = plan.roles.find((r) => r.id === "scout")!.artifact;

  // The tester waits on the implementer, a read-only dep waits on the scout.
  const tester = { ...plan.roles.find((r) => r.id === "tester")!, depends_on: ["scout"] };
  const body = agentMarkdown(plan, tester);

  assert.ok(body.includes("## Upstream artifacts"), "the section must be present");
  assert.match(
    body,
    new RegExp(`\`scout\` → ${scoutArtifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "a read-only dependency must still name its artifact path",
  );
  assert.match(body, /orchestrator writes it here/, "and must say who puts it there");

  // A writable dependency needs no such explanation. The tester waits on the
  // implementer, which writes its own artifact — while the implementer's own
  // brief still carries the note, because it waits on the read-only planner.
  const testerBrief = agentMarkdown(plan, plan.roles.find((r) => r.id === "tester")!);
  assert.ok(
    !testerBrief.includes("orchestrator writes it here"),
    "a writable upstream role writes its own report",
  );
});

test("the run artifact tree is bounded, keeping the newest runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-runs-"));
  const root = join(dir, ".role-fleet");
  const runs = [1000, 2000, 3000, 4000].map((ms) => `run-${ms}`);
  for (const r of runs) {
    await mkdir(join(root, r), { recursive: true });
    await writeFile(join(root, r, "scout.md"), "report", "utf8");
  }
  // Not ours: a sibling note, a file, and a differently-shaped directory.
  await writeFile(join(root, "notes.md"), "keep me", "utf8");
  await mkdir(join(root, "run-notanumber"), { recursive: true });

  // Retention, with the current run the newest so nothing is spared as
  // in-flight: keeping 2 leaves the newest two and prunes the rest.
  await pruneRunDirs(root, "run-4000", 2);
  assert.deepEqual(
    (await readdir(root)).sort(),
    ["notes.md", "run-3000", "run-4000", "run-notanumber"].sort(),
    "anything the plugin did not name stays, and only the oldest runs go",
  );

  // A missing tree is not an error.
  assert.deepEqual(await pruneRunDirs(join(dir, "nope"), "run-1", 5), []);
});

test("the run prune orders by value, not by the id's text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-runs-num-"));
  const root = join(dir, ".role-fleet");
  for (const ms of [99, 4000, 1000, 3000]) await mkdir(join(root, `run-${ms}`), { recursive: true });

  // `run-99` sorts *after* `run-4000` as text, so a lexical order would keep it
  // and delete the newest run. The numeric order keeps `run-4000`.
  await pruneRunDirs(root, "run-4000", 2);
  const survivors = await readdir(root);
  assert.ok(survivors.includes("run-4000"), "the newest run must never be pruned");
  assert.ok(!survivors.includes("run-99"), "the numerically oldest run is the one to go");
});

test("a real run prunes its own stale run directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-runs-real-"));
  for (let i = 0; i < 3; i++) await runRoleFleet({ task: `fix bug ${i}`, cwd: dir });
  const runs = (await readdir(join(dir, ".role-fleet"))).filter((f) => f.startsWith("run-"));
  assert.ok(runs.length >= 2, "each run leaves its artifact directory");

  // Drive it past the retention window with a long burst.
  for (let i = 0; i < 12; i++) await runRoleFleet({ task: `fix bug ${i}`, cwd: dir });
  const after = (await readdir(join(dir, ".role-fleet"))).filter((f) => f.startsWith("run-"));
  assert.ok(after.length <= 10, `the run tree must stay bounded, found ${after.length}`);
});

test("the run prune never touches a run newer than the one doing the pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-runs-newer-"));
  const root = join(dir, ".role-fleet");
  // The current run finishes late, after a burst of newer runs has started.
  // Their artifact directories belong to runs still in flight.
  const current = "run-1000";
  for (const ms of [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000]) {
    await mkdir(join(root, `run-${ms}`), { recursive: true });
  }

  // Retention of 1 among the eligible (older-or-current) runs, while the ten
  // newer ones are spared as in-flight.
  await pruneRunDirs(root, current, 1);

  const survivors = (await readdir(root)).sort();
  for (const ms of [2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000]) {
    assert.ok(survivors.includes(`run-${ms}`), `a newer, in-flight run dir was pruned: run-${ms}`);
  }
  assert.ok(survivors.includes(current), "the current run's own directory must survive");
  // Only the genuinely older ones go, bounded by the retention window.
  assert.ok(!survivors.includes("run-500"), "the oldest eligible run should have been pruned");

  // Nothing eligible at all: every other run is newer, so retention cannot be
  // reached and nothing may be deleted. This is the discriminating case — drop
  // the guard and this very setup deletes ten in-flight directories.
  const onlyNewer = await mkdtemp(join(tmpdir(), "rf-runs-none-"));
  const root2 = join(onlyNewer, ".role-fleet");
  for (const ms of [2000, 3000, 4000, 5000]) await mkdir(join(root2, `run-${ms}`), { recursive: true });
  await pruneRunDirs(root2, "run-1000", 2);
  assert.deepEqual(
    (await readdir(root2)).sort(),
    ["run-2000", "run-3000", "run-4000", "run-5000"],
    "with nothing older to prune, every in-flight run must survive",
  );

  // A malformed current id yields NaN, and nothing compares `<= NaN`: fail
  // safe, deleting nothing, rather than guessing which runs are stale.
  const odd = await mkdtemp(join(tmpdir(), "rf-runs-nan-"));
  const root3 = join(odd, ".role-fleet");
  for (const ms of [1000, 2000, 3000]) await mkdir(join(root3, `run-${ms}`), { recursive: true });
  assert.deepEqual(await pruneRunDirs(root3, "not-a-run-id", 1), []);
  assert.equal((await readdir(root3)).length, 3, "an unparseable run id must prune nothing");
});

test("the gate refuses a malformed plan and names every issue", () => {
  // Defensive by construction: synthesizePlan, the proposal sandbox and
  // bindFleet all emit valid shapes, so this branch is unreachable from the
  // command and the tool. It is tested here directly so a generator that
  // starts emitting bad shapes fails loudly instead of shipping a broken plan.
  const broken = {
    task: "fix the auth bug",
    cwd: "/tmp",
    roles: [
      { ...planFor("fix the auth bug").roles[0], id: "scout", acceptance: [] },
      { ...planFor("fix the auth bug").roles[0], id: "scout", artifact: "" },
      { ...planFor("fix the auth bug").roles[0], id: "docs", depends_on: ["ghost"] },
    ],
    notes: [],
  };

  const gate = gatePlan(broken);
  assert.equal(gate.ok, false);
  assert.equal(gate.plan, null, "a refused plan must not be handed on");
  assert.equal(gate.verdict.verdict, "reject");
  assert.deepEqual(gate.verdict.issues, [
    "role scout: no acceptance criteria",
    "duplicate role id scout",
    "role scout: no artifact path",
    "role docs: unknown dependency ghost",
  ]);
  assert.match(renderVerdict(gate.verdict), /Gate: reject/);

  // An empty plan is refused too, rather than dispatching nothing.
  assert.equal(gatePlan({ ...broken, roles: [] }).ok, false);
});

test("a verdict names its outcome and lists every issue", () => {
  // The verdict is what the user reads when a plan is refused; an issue that
  // does not appear here is an issue they are never told about.
  const rejected = renderVerdict({
    verdict: "reject",
    reason: "plan failed static validation",
    issues: ["duplicate role id db-auditor", "role scout: no acceptance criteria"],
  });
  assert.match(rejected, /reject/);
  assert.match(rejected, /duplicate role id db-auditor/);
  assert.match(rejected, /no acceptance criteria/);
  assert.ok(!rejected.includes("undefined"), "an absent reason must not print as undefined");

  const approved = renderVerdict({
    verdict: "approve",
    reason: "static validation passed",
    issues: [],
  });
  assert.match(approved, /approve/);
  assert.ok(!approved.includes("!"), "an approval lists no issues");
});

test("same-millisecond runs get strictly increasing ids, so ordering is decidable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-monotonic-"));
  // Concurrent calls land in the same millisecond often enough; the ids must
  // still be strictly increasing, because the prune guard compares them with
  // `owner > currentRunId` and equal ids make that comparison false.
  const ids = (await Promise.all([0, 1, 2, 3, 4].map(() =>
    runRoleFleet({ task: "fix the auth bug", cwd: dir }),
  ))).map((r) => r.plan!.runId!);

  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(", ")}`);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, `ids must increase in issue order: ${ids.join(", ")}`);
  assert.ok(ids.every((id) => /^run-\d+$/.test(id)), `ids must stay numeric: ${ids.join(", ")}`);
});

test("an older run's prune spares a newer, still-running run's agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-concurrent-"));
  // Two runs issued back to back land in the same millisecond often enough, and
  // must still be strictly ordered — that ordering is what the prune guard
  // reads. `older` is deliberately the *narrower* plan, so the sentinel below
  // is a file it does not write.
  const older = await runRoleFleet({ task: "update the readme and changelog", cwd: dir });
  const newer = await runRoleFleet({ task: "fix the auth bug", cwd: dir });
  assert.ok(
    Number(newer.plan!.runId!.slice(4)) > Number(older.plan!.runId!.slice(4)),
    `back-to-back runs must still be ordered: ${older.plan!.runId} then ${newer.plan!.runId}`,
  );

  // Emit the newer run first, then replay the older plan: the newer run's
  // files are exactly the ones agents.ts must spare.
  const agentsDir = join(dir, ".omp", "agents");
  await emitAgents(newer.plan!, agentsDir);
  await emitAgents(older.plan!, agentsDir);

  // The sentinel must be a role only the newer run has. A file both runs write
  // would survive via the `keepSet` short-circuit, so the guard would never be
  // reached and the test would pass even with the guard deleted.
  const newerOnly = newer.plan!.roles
    .map((r) => `rf-${r.id}.md`)
    .find((f) => !older.plan!.roles.some((r) => `rf-${r.id}.md` === f));
  assert.ok(newerOnly, "the older plan must be narrower, or nothing is at risk");

  const files = await readdir(agentsDir);
  assert.ok(
    files.includes(newerOnly),
    `a newer run's in-flight agent (${newerOnly}) must survive an older run's prune`,
  );
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
