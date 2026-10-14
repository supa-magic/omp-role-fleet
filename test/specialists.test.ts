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

test("a grant that mixes a real tool with a rogue one is refused whole", () => {
  // Filtering the rogue tool out made `["read","bash"]` a valid read-only role,
  // so a proposal could request a tool it may not have and still be accepted.
  // The sandbox refuses the element instead, like a wrong dependency.
  const mixed = JSON.stringify([
    {
      id: "x-auditor",
      title: "X",
      mission: "Do the thing carefully",
      acceptance: ["a"],
      tools: ["read", "bash"],
      effort: "low",
      model: "@slow",
      dependsOn: [],
    },
  ]);
  assert.equal(parseProposal(mixed), null, "a mixed valid/rogue grant must be refused");

  // The all-valid grant of the same shape still passes.
  assert.equal(parseProposal(mixed.replace("bash", "grep"))?.length, 1);
});

test("a dependency that leaves the plan is reported, not dropped in silence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-sever-"));
  // The sandbox accepts a dependency on any reserved id, but a role the plan
  // does not contain cannot be waited on. Dropping the edge silently made the
  // proposed role run earlier than the proposal asked for.
  const result = await runRoleFleet({
    task: "assess the regulatory exposure of our payment data pipeline",
    cwd: dir,
    dryRun: true,
    specialist: true,
    maxRoles: 6,
    propose: async () =>
      JSON.stringify([
        // `implementer` is reserved but absent from an analysis-only plan.
        { id: "ledger-auditor", title: "L", mission: "Audit the ledger", acceptance: ["a"], tools: ["read"], effort: "low", model: "@slow", dependsOn: ["implementer"] },
      ]),
  });

  const auditor = result.plan!.roles.find((r) => r.id === "ledger-auditor");
  assert.ok(auditor, "the proposal itself is valid and must merge");
  assert.deepEqual(auditor.depends_on, [], "the unresolvable edge cannot be honoured");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("ledger-auditor") && n.includes("implementer")),
    `the severed edge must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});

test("asking for the specialist tier on a host without side turns says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-noside-"));
  // `--specialist` on such a host is a silent no-op unless the plan says why.
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir, dryRun: true, specialist: true });
  assert.equal(result.ok, true);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `the skipped tier must be reported: ${result.plan!.notes.join(" | ")}`,
  );

  // Without the flag there is nothing to report — the tier was never asked for.
  const plain = await runRoleFleet({ task: "fix the auth bug", cwd: dir, dryRun: true });
  assert.ok(!plain.plan!.notes.some((n) => n.includes("unavailable")));
});

test("a proposal claiming an id the plan already uses is discarded, not merged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-collide-"));
  const propose = async (id: string) => async () =>
    JSON.stringify([
      { id, title: "F", mission: "Hijack the seat", acceptance: ["a"], tools: ["read"], effort: "low", model: "@slow", dependsOn: [] },
    ]);

  // The council mints `reviewer-c1`… after the parser's reserved list is
  // built, so the parser alone cannot see the collision. Merging it made
  // `validatePlan` refuse the whole plan and destroyed a healthy council run.
  for (const id of ["reviewer-c1", "reviewer-c3"]) {
    const result = await runRoleFleet({
      task: "review with different providers",
      cwd: dir,
      dryRun: true,
      specialist: true,
      maxRoles: 8,
      propose: await propose(id),
    });
    assert.equal(result.ok, true, `a colliding proposal must not take down the run (${id})`);
    assert.ok(
      result.plan!.notes.some((n) => n.includes(id) && n.includes("already in use")),
      `the collision must be reported: ${result.plan!.notes.join(" | ")}`,
    );
  }

  // A non-colliding proposal on the same run still merges.
  const merged = await runRoleFleet({
    task: "review with different providers",
    cwd: dir,
    dryRun: true,
    specialist: true,
    maxRoles: 8,
    propose: await propose("threat-modeler"),
  });
  assert.ok(merged.plan!.roles.some((r) => r.id === "threat-modeler"), "a clean proposal must still be merged");
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
test("a proposal naming the same id twice is discarded whole", () => {
  // Two elements with one id each pass every per-element check, then merge into
  // a plan `validatePlan` rejects as a duplicate — taking a healthy static cast
  // down with them. The proposal is not an upgrade the run depends on, so any
  // doubt keeps the static cast.
  const dupes = parseProposal(
    JSON.stringify([
      { id: "db-auditor", title: "A", mission: "Audit the schema", acceptance: ["a"], tools: ["read"], effort: "low", model: "@slow", dependsOn: [] },
      { id: "db-auditor", title: "B", mission: "Audit it again", acceptance: ["a"], tools: ["grep"], effort: "low", model: "@task", dependsOn: [] },
    ]),
  );
  assert.equal(dupes, null, "a duplicate id must invalidate the proposal, not the plan");
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
