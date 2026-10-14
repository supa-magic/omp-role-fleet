/**
 * The two specialist tiers: a hand-written library (deterministic) and an
 * LLM-proposed dynamic tier (validated, silently discarded on any doubt).
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SPECIALISTS, applySpecialists } from "../src/library.ts";
import { parseProposal, proposeSpecialists, shouldPropose } from "../src/generate.ts";
import { synthesizePlan } from "../src/synthesize.ts";
import { planWaves } from "../src/core.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderDispatch } from "../src/render.ts";
import { dispatchGroups, emitAgents } from "../src/agents.ts";

function basePlan(task: string) {
  return synthesizePlan({ task, cwd: "/tmp", workDir: "/tmp/w" });
}

function ids(plan: ReturnType<typeof basePlan>): string[] {
  return plan.roles.map((r) => r.id);
}

// ── library tier ──────────────────────────────────────────────────────────────

test("UI work earns a designer on @designer", () => {
  const plan = basePlan("build a landing page with a pricing section");
  const designer = plan.roles.find((r) => r.id === "designer");
  assert.ok(designer, `designer missing; cast is ${ids(plan).join(",")}`);
  assert.equal(designer!.model, "@designer");
  assert.ok(designer!.depends_on.includes("scout"));
  assert.ok(plan.notes.some((n) => n.includes("designer")));
});

test("security wording earns a read-only security auditor on @slow", () => {
  const plan = basePlan("audit the api for injection and csrf");
  const auditor = plan.roles.find((r) => r.id === "security-auditor");
  assert.ok(auditor);
  assert.equal(auditor!.model, "@slow");
  assert.deepEqual(auditor!.tools, ["read", "grep", "glob"]);
});

test("a migration replaces the implementer instead of doubling the writes", () => {
  const plan = basePlan("migrate the codebase from jest to vitest and fix fallout");
  assert.ok(!ids(plan).includes("implementer"), "migration must replace the implementer");
  const runner = plan.roles.find((r) => r.id === "migration-runner");
  assert.ok(runner);
  assert.ok(runner!.tools.includes("edit"));
  assert.ok(plan.notes.some((n) => n.includes("replaced")));
});

test("a migration with no implementer to replace is skipped with a note", () => {
  const plan = basePlan("research migration options for the framework upgrade docs");
  assert.ok(!ids(plan).includes("migration-runner"));
  assert.ok(plan.notes.some((n) => n.includes("migration-runner")));
});

test("plain engineering work gets no specialists", () => {
  const plan = basePlan("fix the off-by-one in the pagination helper");
  const specialistIds = new Set(SPECIALISTS.map((s) => s.spec.id));
  assert.deepEqual(ids(plan).filter((id) => specialistIds.has(id)), []);
});

test("the specialist never squeezes the implementer out at the cap", () => {
  const plan = synthesizePlan({
    task: "fix the bug and audit the api for injection",
    cwd: "/tmp",
    workDir: "/tmp/w",
    maxRoles: 2,
  });
  assert.ok(ids(plan).includes("implementer"), "cap dropped the implementer for a specialist");
});

test("applySpecialists drops dependencies on roles absent from the plan", () => {
  const roles = applySpecialists(
    basePlan("fix the bug").roles,
    "redesign the landing page",
    "/tmp/w",
    [],
    (id) => id === "reviewer", // scout absent
  );
  const designer = roles.find((r) => r.id === "designer")!;
  assert.deepEqual(designer.depends_on, []);
});

// ── dynamic tier ──────────────────────────────────────────────────────────────

const GOOD_REPLY = `
Sure, here are the roles:
\`\`\`json
[
  {
    "id": "db-migration-auditor",
    "title": "DB migration auditor",
    "mission": "Check the migration for lock risks and rollback gaps",
    "acceptance": ["Every DDL statement classified", "Rollback path stated"],
    "tools": ["read", "grep"],
    "effort": "high",
    "model": "@slow",
    "dependsOn": []
  }
]
\`\`\`
`;

test("a valid fenced proposal is accepted with constraints applied", () => {
  const roles = parseProposal(GOOD_REPLY);
  assert.ok(roles);
  assert.equal(roles!.length, 1);
  assert.equal(roles![0].id, "db-migration-auditor");
  assert.equal(roles![0].model, "@slow");
  assert.deepEqual(roles![0].tools, ["read", "grep"]);
});

test("an invented model, tool, or dependency invalidates the whole proposal", () => {
  const base = JSON.stringify([
    {
      id: "x-auditor",
      title: "X",
      mission: "Do the thing carefully",
      acceptance: ["a"],
      tools: ["read"],
      effort: "low",
      model: "@slow",
      dependsOn: [],
    },
  ]);
  const variants = [
    base.replace('"@slow"', '"gpt-9"'),          // unknown alias
    base.replace('"read"', '"rm -rf"'),          // tool outside the grant
    base.replace('"dependsOn":[]', '"dependsOn":["ghost"]'), // unresolvable dep
    base.replace('"id":"x-auditor"', '"id":"scout"'),        // claims a built-in seat
    "not json at all",
    "[]",
    "1",
  ];
  for (const v of variants) assert.equal(parseProposal(v), null, `accepted: ${v.slice(0, 40)}`);
});

test("more than three proposed roles is refused outright", () => {
  const one = { id: "a-one", title: "A", mission: "Do it", acceptance: ["x"], tools: ["read"], effort: "low", model: "@smol", dependsOn: [] };
  const many = JSON.stringify([one, { ...one, id: "b-two" }, { ...one, id: "c-three" }, { ...one, id: "d-four" }]);
  assert.equal(parseProposal(many), null);
  assert.equal(parseProposal(JSON.stringify([one, { ...one, id: "b-two" }]))?.length, 2);
});

test("shouldPropose triggers on explicit asks and thin analysis plans", () => {
  assert.equal(shouldPropose("use a specialist for the migration", false), true);
  assert.equal(shouldPropose("assess the regulatory exposure of our data pipeline", true), true);
  assert.equal(shouldPropose("fix the bug", false), false);
  // A short vague task stays static: the model call would cost more than it adds.
  assert.equal(shouldPropose("help", true), false);
  assert.equal(shouldPropose("please research this", true), false);
});

test("a throwing proposer degrades to the static cast, not an error", async () => {
  const proposed = await proposeSpecialists("audit the thing", async () => {
    throw new Error("no side turns here");
  });
  assert.equal(proposed, null);
});

// ── pipeline integration ──────────────────────────────────────────────────────

test("the pipeline merges an accepted proposal into the plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-gen-"));
  const result = await runRoleFleet({
    task: "audit the exotic schema for this specialist task",
    cwd: dir,
    specialist: true,
    propose: async () => GOOD_REPLY,
  });
  assert.equal(result.ok, true);
  assert.ok(ids(result.plan!).includes("db-migration-auditor"));
  assert.ok(result.plan!.notes.some((n) => n.includes("generated specialists")));
  // The generated role rides the same emission path as everything else.
  assert.ok(result.agents.some((a) => a.agent === "rf-db-migration-auditor"));
});

test("a rejected proposal keeps the static cast and notes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-genbad-"));
  const result = await runRoleFleet({
    task: "audit the exotic schema for this specialist task",
    cwd: dir,
    specialist: true,
    propose: async () => "garbage reply, no json",
  });
  assert.equal(result.ok, true);
  assert.ok(!ids(result.plan!).includes("db-migration-auditor"));
  assert.ok(result.plan!.notes.some((n) => n.includes("static cast kept")));
});

test("no proposer means the tier never runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-noprop-"));
  const result = await runRoleFleet({
    task: "audit the exotic schema for this specialist task",
    cwd: dir,
    specialist: true,
  });
  assert.equal(result.ok, true);
  assert.ok(!result.plan!.notes.some((n) => n.includes("specialist proposal")));
});
// ── review council ────────────────────────────────────────────────────────────

test("a council replaces the reviewer with distinct-alias members in one wave", () => {
  const plan = synthesizePlan({
    task: "fix the auth bug and review it",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 3,
  });
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3);
  assert.ok(!plan.roles.some((r) => r.id === "reviewer"), "single reviewer must be replaced");
  const models = members.map((m) => m.model);
  assert.equal(new Set(models).size, 3, `aliases not distinct: ${models.join(",")}`);
  assert.ok(models.includes("@slow") && models.includes("@task") && models.includes("@plan"));
  // All members review the same upstream and share a wave.
  for (const m of members) assert.deepEqual(m.depends_on, ["implementer"]);
  const waves = planWaves(plan.roles);
  const councilWave = waves.findIndex((w) => w.some((r) => r.id === "reviewer-c1"));
  assert.equal(waves[councilWave].filter((r) => /^reviewer-c\d$/.test(r.id)).length, 3);
  assert.ok(plan.notes.some((n) => n.startsWith("council of 3")));
});

test("a council is capped by the alias pool", () => {
  const plan = synthesizePlan({ task: "fix the bug", cwd: "/tmp", workDir: "/tmp/w", council: 9 });
  assert.equal(plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id)).length, 3);
});

test("council members carry independent missions and separate artifacts", () => {
  const plan = synthesizePlan({ task: "fix the bug", cwd: "/tmp", workDir: "/w", council: 2 });
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  const artifacts = members.map((m) => m.artifact);
  assert.equal(new Set(artifacts).size, 2);
  for (const m of members) assert.match(m.mission, /Independent pass/);
});

test("without the flag there is exactly one reviewer", () => {
  const plan = basePlan("fix the auth bug");
  assert.equal(plan.roles.filter((r) => r.id.startsWith("reviewer")).length, 1);
});

test("council wording in the task auto-triggers three reviewers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-council-"));
  const result = await runRoleFleet({
    task: "fix the auth bug, then review with different providers",
    cwd: dir,
  });
  const members = result.plan!.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3, "council wording must trigger the council");
});

test("an analysis-only council reviews after the scout", () => {
  const plan = synthesizePlan({
    task: "council review the migration plan",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 2,
  });
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.ok(members.length >= 1);
  for (const m of members) {
    assert.deepEqual(m.depends_on, members[0].depends_on, "council members share one upstream");
  }
});


test("council wording fires on an analysis-only plan with no reviewer to replace", () => {
  // The exact user case: the words say "different providers", the task shape
  // earns no reviewer. The council must join after the scout, not vanish.
  const plan = synthesizePlan({
    task: "view with different providers",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 3,
  });
  const members = plan.roles.filter((r) => /^reviewer-c\d$/.test(r.id));
  assert.equal(members.length, 3);
  for (const m of members) assert.deepEqual(m.depends_on, ["scout"]);
  assert.deepEqual(members.map((m) => m.model).sort(), ["@plan", "@slow", "@task"]);
});

test("council wording reaches the pipeline from plain task text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-words-"));
  const result = await runRoleFleet({ task: "view with different providers", cwd: dir, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.plan!.roles.filter((r) => /^reviewer-c\d$/.test(r.id)).length, 3);
});

test("dispatch guidance mentions the council only when one ran", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-guidance-"));
  // The paragraph keys off the groups' agent names: use the real emitter.
  const plan = synthesizePlan({ task: "fix the bug", cwd: dir, workDir: dir, council: 3 });
  const dir2 = await mkdtemp(join(tmpdir(), "rf-guidance2-"));
  const emitted = await emitAgents(plan, join(dir2, "agents"));
  const groups = dispatchGroups(emitted);
  assert.match(renderDispatch(groups, dir2), /review council/);

  const plain = await emitAgents(
    synthesizePlan({ task: "fix the bug", cwd: dir, workDir: dir }),
    join(dir2, "agents2"),
  );
  assert.ok(!renderDispatch(dispatchGroups(plain), dir2).includes("review council"));
});

test("dispatch items carry roster names and no phantom model field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-names-"));
  const plan = synthesizePlan({ task: "fix the bug", cwd: dir, workDir: dir, council: 3 });
  const agentsDir = join(dir, "agents");
  const text = renderDispatch(dispatchGroups(await emitAgents(plan, agentsDir)), agentsDir);

  assert.match(text, /"name": "Scout Smol"/);
  assert.match(text, /"name": "Implementer Task"/);
  assert.match(text, /"name": "ReviewerC1 Slow"/);
  // The task tool has no model field; emitting one invites schema errors.
  assert.ok(!text.includes('"model"'));
  // Roster ids stay within the task tool's 32-character budget.
  for (const m of text.matchAll(/"name": "([^"]+)"/g)) {
    assert.ok(m[1]!.length <= 32, `name too long: ${m[1]}`);
  }
});
test("a proposal's seat is derived, never echoed: write tools mean implementer, read-only means reviewer", () => {
  // G19: the generated role must carry a real seat, because allowlist mode
  // routes by seat — a literal or attacker-chosen core would silently un-pin
  // a pinned run.
  const writer = parseProposal(
    JSON.stringify([
      { id: "db-migrator", title: "DB", mission: "Migrate the schema carefully", acceptance: ["a"], tools: ["read", "edit"], effort: "low", model: "@task", dependsOn: [] },
    ]),
  );
  const reader = parseProposal(
    JSON.stringify([
      { id: "db-auditor", title: "DB", mission: "Audit the schema carefully", acceptance: ["a"], tools: ["read", "grep"], effort: "low", model: "@slow", dependsOn: [] },
    ]),
  );
  assert.equal(writer![0].core, "implementer", "write grant must map to the implementer seat");
  assert.equal(reader![0].core, "reviewer", "read-only grant must map to the reviewer seat");

  // Neither seat may come from the proposal itself, whatever it claims.
  const claimer = parseProposal(
    JSON.stringify([
      { id: "sneaky-seat", title: "S", mission: "Claim a seat that is not mine", acceptance: ["a"], tools: ["read"], effort: "low", model: "@smol", dependsOn: [], core: "planner" },
    ]),
  );
  assert.equal(claimer![0].core, "reviewer", "an echoed core must be overwritten by the derived one");
});
