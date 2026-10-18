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
import { isCouncilMember, planWaves, READ_TOOLS } from "../src/core.ts";
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

test("UI work earns a designer on @designer, in the seat a tester would hold", () => {
  // UI plus a change verb: the interface is part of what ships, so the designer
  // is the seat a tester would have filled rather than a seat beside it. Adding
  // both would fan the run out for one artifact; the cast says so out loud.
  const plan = basePlan("build a landing page with a pricing section");
  const designer = plan.roles.find((r) => r.id === "designer");
  assert.ok(designer, `designer missing; cast is ${ids(plan).join(",")}`);
  assert.deepEqual(ids(plan), ["scout", "implementer", "reviewer", "designer"]);
  assert.ok(!ids(plan).includes("tester"), "the designer took that seat, it did not join it");
  assert.equal(designer!.model, "@designer");
  assert.ok(designer!.dependsOn.includes("scout"));
  assert.ok(plan.notes.some((n) => n.includes("designer takes the seat a tester would hold")));
});

test("a review-only ask mints no writer, even when the task names a UI", () => {
  // The exact shape that cost a write-capable seat on a code review: the task
  // text mentions "ui" (host UI, a file named render.ts, anything), and the
  // specialist tier answered by adding a designer holding `edit`.
  const plan = synthesizePlan({
    task: "review the code, its tests, and the UI in render.ts",
    cwd: "/tmp",
    workDir: "/tmp/w",
    reviewOnly: true,
    council: 3,
  });
  assert.ok(!plan.roles.some((r) => r.id === "designer"), `designer joined a review: ${ids(plan).join(",")}`);
  assert.ok(!plan.roles.some((r) => r.id === "implementer"), "a review must not implement");
  assert.ok(!plan.roles.some((r) => r.id === "tester"), "a review must not test");
  // Nothing in the plan can write a source file.
  for (const role of plan.roles) {
    assert.ok(!role.tools.includes("edit"), `${role.id} must not hold edit`);
    assert.ok(!role.tools.includes("write"), `${role.id} must not hold write`);
  }
  assert.ok(plan.roles.some((r) => isCouncilMember(r.id)), "the council is still the point");
  assert.ok(plan.notes.some((n) => n.includes("review-only")));
});

test("an explicit review ask is a signal without any review word", async () => {
  // Nothing in this prose says "review" or "audit", and "render.ts" hits the
  // image hint — the exact combination that minted a write-capable designer
  // into a council review. Naming the review models IS the request, so the cast
  // follows the parameters rather than a guess at the vocabulary.
  // Through the pipeline, which is where a named list becomes a council: this
  // call is exactly `--models (a,b) --consul c` from the command line.
  const plan = (
    await runRoleFleet({
      task: "the auth module in render.ts and its api surface",
      cwd: await mkdtemp(join(tmpdir(), "rf-struct-")),
      dryRun: true,
      models: ["xai/grok-4", "zai/glm-5"],
      consul: "anthropic/claude-opus-4-6",
    })
  ).plan!;
  assert.ok(!plan.roles.some((r) => r.id === "designer"), `designer joined: ${ids(plan).join(",")}`);
  assert.ok(!plan.roles.some((r) => r.id === "implementer"), "a named council is not an implementation ask");
  // The council is the point and it survived the ask: naming two models mints
  // two members, and the consul joins them.
  assert.deepEqual(plan.roles.filter((r) => isCouncilMember(r.id)).map((r) => r.id), ["reviewer-c1", "reviewer-c2"]);
  assert.ok(plan.roles.some((r) => r.id === "consul"), `no consul in ${ids(plan).join(",")}`);
  // Two tiers only: no seat in this cast holds `edit`, and no seat holds
  // `write` either. The reports reach the filesystem because the orchestrator
  // places them at their artifact paths, not because a review seat was handed a
  // write grant — a grant it could have aimed at a source file instead.
  for (const role of plan.roles) {
    assert.ok(!role.tools.includes("edit"), `${role.id} must not hold edit`);
    assert.ok(!role.tools.includes("write"), `${role.id} must not hold write`);
  }
});

test("a build verb alongside a council keeps the implementation seats", () => {
  // `--council` on a refactor is a refactor with a review. Without this escape
  // the structural signal would strip the very seats doing the work.
  const plan = synthesizePlan({
    task: "refactor the auth module and its ui",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 3,
  });
  assert.ok(plan.roles.some((r) => r.id === "implementer"), `implementer dropped: ${ids(plan).join(",")}`);
  assert.ok(plan.roles.some((r) => r.id === "designer"), "UI work still earns its seat when building");
});

test("an ordinary build run is unaffected by the council default", () => {
  // The pipeline always passes a council size, 0 for the common case. Treating
  // "present" as a review ask would drop the implementer from every build.
  const plan = synthesizePlan({ task: "fix the auth bug", cwd: "/tmp", workDir: "/tmp/w", council: 0 });
  assert.ok(plan.roles.some((r) => r.id === "implementer"), `implementer dropped: ${ids(plan).join(",")}`);
});

test("an audit-shaped task with UI wording does not get a writer back", () => {
  // The audit thinning drops implementer/tester; the specialist tier used to
  // re-add a designer one line later, defeating it.
  const plan = synthesizePlan({
    task: "audit the landing page ui for injection and csrf",
    cwd: "/tmp",
    workDir: "/tmp/w",
  });
  assert.ok(!plan.roles.some((r) => r.id === "implementer"), "the auditor must not be crowded out by a writer");
  assert.ok(!plan.roles.some((r) => r.id === "designer"), `designer re-added after thinning: ${ids(plan).join(",")}`);
  assert.ok(plan.roles.some((r) => r.id === "security-auditor"), "the auditor the task asked for is present");
  assert.ok(plan.notes.some((n) => n.includes("analysis-only plan")));
});

test("a pure UI task still gets the designer — it is the implementation", () => {
  // The other side of the rule: a task that never asked for code is not an
  // analysis plan, and the designer *is* the implementation there. Blocking on
  // "does a writer exist" killed this.
  const plan = synthesizePlan({ task: "design a new onboarding flow", cwd: "/tmp", workDir: "/tmp/w" });
  assert.deepEqual(ids(plan), ["scout", "designer"]);
  const designer = plan.roles.find((r) => r.id === "designer");
  assert.ok(designer, `designer missing; cast is ${ids(plan).join(",")}`);
  assert.ok(designer!.tools.includes("edit"), "the designer must be able to build the interface");

  // With a change verb the designer takes the seat a tester would have held, so
  // the cast still holds exactly one implementation seat.
  const withChange = synthesizePlan({ task: "build a landing page with a pricing section", cwd: "/tmp", workDir: "/tmp/w" });
  assert.deepEqual(ids(withChange), ["scout", "implementer", "reviewer", "designer"]);
});

test("security wording earns a read-only security auditor on @slow", () => {
  const plan = basePlan("audit the api for injection and csrf");
  const auditor = plan.roles.find((r) => r.id === "security-auditor");
  assert.ok(auditor);
  assert.equal(auditor!.model, "@slow");
  // The gate is the grant itself: a seat that can change code is not an auditor.
  assert.ok(!auditor!.tools.includes("edit") && !auditor!.tools.includes("write"), auditor!.tools.join(","));
  assert.deepEqual(auditor!.tools, READ_TOOLS);
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
  // The look verb vetoes `VOCAB.migration`: the task is research, so no change
  // verb minted the code cast, there is no implementer for the catalog seat to
  // stand in for, and the cast ships as the analysis ask it is.
  const plan = basePlan("research migration options for the framework upgrade docs");
  assert.deepEqual(ids(plan), ["scout", "docs-updater"], `cast is ${ids(plan).join(",")}`);
  assert.ok(plan.notes.some((n) => n.includes("migration-runner") && n.includes("skipped")));
  assert.ok(plan.analysisOnly, "the look verb makes this an analysis cast");
});

test("a migration that names no code vocabulary still gets the runner", () => {
  // The runner is the one catalog seat that stands in for the implementer, and
  // the tasks it exists for — "migrate off lodash", "upgrade the deps", "move
  // off webpack" — carry none of `CODE_HINT`'s words. So no implementer was
  // drafted, the replacement had nothing to replace, and the run shipped a scout
  // plus a reviewer whose mission was to review a change nobody made, while the
  // README promises the replacement. The shape is read off the catalog's own
  // pattern, so the seat that replaces the implementer is the one that decides.
  for (const task of [
    "migrate off lodash across several files",
    "upgrade the dependencies to the latest majors",
    "move off webpack to vite",
    // Words that look like research but name the subject of a migration:
    // rejecting the shape on `version`/`upstream` would re-create the
    // writer-less cast this rule exists to prevent. Both hit the catalog's own
    // migration pattern, so the veto is what decides them.
    "upgrade the framework to the latest version",
    "move off the vendored upstream fork",
  ]) {
    const plan = basePlan(task);
    assert.ok(ids(plan).includes("migration-runner"), `${task}: cast is ${ids(plan).join(",")}`);
    assert.ok(!ids(plan).includes("implementer"), `${task}: two writers on the same files`);
    assert.ok(plan.roles.find((r) => r.id === "migration-runner")!.tools.includes("edit"));
  }

  // A task phrased as an investigation is not one: the veto is a look verb, on
  // its own or alongside any wording the plan already reads as analysis.
  for (const task of [
    "research migration options for the upgrade path",
    "audit the migration plan before we migrate",
    "compare lodash and ramda before moving the codebase off lodash",
    // `VOCAB.migration` matches "migrating", the look verb decides the cast:
    // weighing a migration is not running one.
    "evaluate migrating off lodash",
  ]) {
    assert.ok(!ids(basePlan(task)).includes("migration-runner"), `${task}: a look minted a writer`);
  }
});

test("the migration runner waits on the plan that was written for it", () => {
  // The catalog entry depends on the scout, and the implementer it replaces
  // depends on the planner — so taking the catalog's edge dispatched the
  // migration beside the plan written for it, in the same wave: the plan nobody
  // read looked exactly like a plan that was followed.
  const plan = basePlan("migrate the api client off the old sdk across several files");
  const runner = plan.roles.find((r) => r.id === "migration-runner")!;
  assert.ok(ids(plan).includes("planner"), `fixture lost the planner: ${ids(plan).join(",")}`);
  assert.deepEqual(runner.dependsOn, ["planner"]);

  const waves = planWaves(plan.roles).map((w) => w.map((r) => r.id));
  assert.ok(
    waves.findIndex((w) => w.includes("migration-runner")) > waves.findIndex((w) => w.includes("planner")),
    `the runner must wait for its plan: ${JSON.stringify(waves)}`,
  );
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
  assert.deepEqual(designer.dependsOn, []);
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
    base.replace('"id":"x-auditor"', '"id":"security-auditor"'), // claims a library seat
    "not json at all",
    "[]",
    "1",
  ];
  for (const v of variants) assert.equal(parseProposal(v), null, `accepted: ${v.slice(0, 40)}`);
});

test("a grant that mixes a real tool with a rogue one is refused whole", () => {
  // Filtering the rogue tool out would make the element a valid role that holds
  // a tool it may not have, so the sandbox refuses the element instead, like a
  // wrong dependency. `eval` is the rogue here because a shell is *inside* the
  // builder grant: the rogue has to be a tool no seat may hold, not merely a
  // powerful one.
  const mixed = JSON.stringify([
    {
      id: "x-auditor",
      title: "X",
      mission: "Do the thing carefully",
      acceptance: ["a"],
      tools: ["read", "eval"],
      effort: "low",
      model: "@slow",
      dependsOn: [],
    },
  ]);
  assert.equal(parseProposal(mixed), null, "a mixed valid/rogue grant must be refused");

  // The all-valid grant of the same shape still passes, shell included.
  assert.equal(parseProposal(mixed.replace("eval", "grep"))?.length, 1);
  assert.equal(parseProposal(mixed.replace("eval", "bash"))?.length, 1);
});

test("a dependency that leaves the plan is reported, not dropped in silence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-sever-"));
  // The sandbox accepts a dependency on any reserved id, but a role the plan
  // does not contain cannot be waited on. Dropping the edge silently made the
  // proposed role run earlier than the proposal asked for.
  // Not a dry run: the tier is a paid model call, so `--dry-run` skips it and
  // the proposal under test would never be merged.
  const result = await runRoleFleet({
    task: "assess the regulatory exposure of our payment data pipeline",
    cwd: dir,
    maxRoles: 6,
    propose: async () =>
      JSON.stringify([
        // `implementer` is reserved but absent from an analysis-only plan.
        { id: "ledger-auditor", title: "L", mission: "Audit the ledger", acceptance: ["a"], tools: ["read"], effort: "low", model: "@slow", dependsOn: ["implementer"] },
      ]),
  });

  const auditor = result.plan!.roles.find((r) => r.id === "ledger-auditor");
  assert.ok(auditor, "the proposal itself is valid and must merge");
  assert.deepEqual(auditor.dependsOn, [], "the unresolvable edge cannot be honoured");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("ledger-auditor") && n.includes("implementer")),
    `the severed edge must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});

test("asking for the specialist tier on a host without side turns says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-noside-"));
  // The tier triggers on the task's own wording now — no flag to remember — so a
  // host that cannot run it has to say so, or the request is silently dropped.
  const result = await runRoleFleet({ task: "fix the auth bug, bring in a consultant", cwd: dir });
  assert.equal(result.ok, true);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `the skipped tier must be reported: ${result.plan!.notes.join(" | ")}`,
  );

  // A dry run on this same host reports the *capability* instead, because that
  // is the fact the user cannot discover any other way: "skipped, it is a paid
  // model call" would claim a saving that was never on offer here.
  const dry = await runRoleFleet({ task: "fix the auth bug, bring in a consultant", cwd: dir, dryRun: true });
  assert.ok(
    dry.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `an incapable host must be named even under a dry run: ${dry.plan!.notes.join(" | ")}`,
  );
  assert.ok(
    !dry.plan!.notes.some((n) => n.includes("dry run: specialist tier skipped")),
    `a dry run must not claim a saving this host could not make: ${dry.plan!.notes.join(" | ")}`,
  );

  // Without the ask there is nothing to report — the tier was never requested.
  const plain = await runRoleFleet({ task: "fix the auth bug", cwd: dir });
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
      task: "review with different providers, bring in a consultant",
      cwd: dir,
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
    task: "review with different providers, bring in a consultant",
    cwd: dir,
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

test("shouldPropose triggers on explicit asks, degenerate casts, and thin analysis plans", () => {
  const build = { degenerate: false, analysisOnly: false };
  const analysis = { degenerate: false, analysisOnly: true };
  // The user named a specialist outright: no cast inspection is needed.
  assert.equal(shouldPropose("use a specialist for the migration", build), true);
  // Nothing but an investigator — no shape the heuristics know (an unknown
  // verb, or another language). It carries `analysisOnly: false`, which is
  // exactly why the analysis flag alone could never catch it.
  assert.equal(shouldPropose("отрефактори модуль авторизации и проверь его", { degenerate: true, analysisOnly: false }), true);
  // A thin *analysis* plan keeps the old path: enough task text for a
  // specialist to be distinguishable from the generic scout.
  assert.equal(shouldPropose("assess the regulatory exposure of our data pipeline", analysis), true);
  // A build the static cast already serves pays nothing.
  assert.equal(shouldPropose("fix the bug", build), false);
  // A short vague task stays static: the model call would cost more than it adds.
  assert.equal(shouldPropose("help", analysis), false);
  assert.equal(shouldPropose("please research this", analysis), false);
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
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3);
  assert.ok(!plan.roles.some((r) => r.id === "reviewer"), "single reviewer must be replaced");
  const models = members.map((m) => m.model);
  assert.equal(new Set(models).size, 3, `aliases not distinct: ${models.join(",")}`);
  assert.ok(models.includes("@slow") && models.includes("@task") && models.includes("@plan"));
  // All members review the same upstream and share a wave.
  for (const m of members) assert.deepEqual(m.dependsOn, ["implementer"]);
  const waves = planWaves(plan.roles);
  const councilWave = waves.findIndex((w) => w.some((r) => r.id === "reviewer-c1"));
  assert.equal(waves[councilWave].filter((r) => isCouncilMember(r.id)).length, 3);
  assert.ok(plan.notes.some((n) => n.startsWith("council of 3")));
});

test("a council is capped by the alias pool", () => {
  const plan = synthesizePlan({ task: "fix the bug", cwd: "/tmp", workDir: "/tmp/w", council: 9 });
  assert.equal(plan.roles.filter((r) => isCouncilMember(r.id)).length, 3);
});

test("council members carry independent missions and separate artifacts", () => {
  const plan = synthesizePlan({ task: "fix the bug", cwd: "/tmp", workDir: "/w", council: 2 });
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
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
  const members = result.plan!.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3, "council wording must trigger the council");
});

test("an analysis-only council reviews after the scout", () => {
  const plan = synthesizePlan({
    task: "council review the migration plan",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 2,
  });
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
  assert.ok(members.length >= 1);
  for (const m of members) {
    assert.deepEqual(m.dependsOn, members[0].dependsOn, "council members share one upstream");
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
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3);
  for (const m of members) assert.deepEqual(m.dependsOn, ["scout"]);
  assert.deepEqual(members.map((m) => m.model).sort(), ["@plan", "@slow", "@task"]);
});

test("council wording reaches the pipeline from plain task text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-words-"));
  const result = await runRoleFleet({ task: "view with different providers", cwd: dir, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.plan!.roles.filter((r) => isCouncilMember(r.id)).length, 3);
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
  // Roster ids stay within the plugin's 32-character budget.
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

test("a proposed writer cannot enter an analysis-only plan", async () => {
  // M1: `--review-only` gated the proposal tier, but naming council models or
  // appointing a consul strips the implementer *without* setting that flag — and
  // the tier still ran. The sandbox accepts `edit` (legitimate for a build), the
  // merge applied no intent filter, and the gate has no tools policy, so
  // `/role-fleet --models (a,b) "review the payment pipeline"` on a host with
  // side turns shipped a seat holding `edit` under a plan that had just promised
  // no source changes. `applySpecialists` closes this for the static tier; the
  // dynamic tier has to close it for itself.
  const dir = await mkdtemp(join(tmpdir(), "rf-propwriter-"));
  // Not a dry run: the refusal lives in the merge, and `--dry-run` skips the
  // merge entirely.
  const result = await runRoleFleet({
    task: "review the payment pipeline for compliance gaps",
    cwd: dir,
    maxRoles: 8,
    models: ["xai/grok-4", "zai/glm-5"],
    propose: async () =>
      JSON.stringify([
        { id: "ledger-sweeper", title: "L", mission: "Sweep the ledger", acceptance: ["a"], tools: ["read", "edit"], effort: "low", model: "@slow", dependsOn: [] },
        { id: "ledger-reader", title: "R", mission: "Read the ledger", acceptance: ["a"], tools: ["read"], effort: "low", model: "@task", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  assert.ok(
    !result.plan!.roles.some((r) => r.id === "ledger-sweeper"),
    "a proposed edit holder merged into a plan that must not write",
  );
  assert.ok(
    result.plan!.roles.some((r) => r.id === "ledger-reader"),
    "refusing the writer must not throw away the whole tier",
  );
  assert.ok(
    result.plan!.notes.some((n) => n.includes("ledger-sweeper") && n.includes("analysis-only")),
    `the refusal must be reported: ${result.plan!.notes.join(" | ")}`,
  );
  assert.ok(
    !result.plan!.roles.some((r) => r.tools.includes("edit")),
    `an edit holder survived: ${result.plan!.roles.filter((r) => r.tools.includes("edit")).map((r) => r.id).join(",")}`,
  );
});

test("a build plan still accepts a proposed writer", async () => {
  // The counterpart, so the guard above is an intent rule and not a blanket ban:
  // with a writer in the cast, a proposed writer is allowed.
  const dir = await mkdtemp(join(tmpdir(), "rf-propok-"));
  const result = await runRoleFleet({
    task: "fix the auth bug and add a regression test, bring in a consultant",
    cwd: dir,
    maxRoles: 8,
    propose: async () =>
      JSON.stringify([
        { id: "crypto-hander", title: "C", mission: "Hand the keys", acceptance: ["a"], tools: ["read", "edit"], effort: "low", model: "@task", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.plan!.roles.some((r) => r.id === "crypto-hander"),
    `a legitimate proposed writer was refused: ${result.plan!.notes.join(" | ")}`,
  );
});

test("a writer under a non-implementer id is not mistaken for an analysis-only plan", async () => {
  // The pipeline used to answer "does this plan hold a writer?" by testing for
  // the id `implementer`. A migration task replaces that seat with
  // `migration-runner` and a UI task mints `designer` — both hold `edit` — so
  // the plan shipped a writer while the tier called it analysis-only and
  // refused a proposed writer for a reason that did not hold. The task text in
  // the test above cannot catch this: its writer really is named `implementer`,
  // so both the broken and the fixed pipeline accept the proposal.
  for (const [label, task, writerId] of [
    ["migration", "migrate the codebase from jest to vitest and fix the fallout", "migration-runner"],
    ["ui", "build a landing page with a pricing section", "designer"],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `rf-writerid-${label}-`));
    const result = await runRoleFleet({
      task: `${task} with a specialist expert`,
      cwd: dir,
      maxRoles: 8,
      propose: async () =>
        JSON.stringify([
          { id: "extra-tuner", title: "T", mission: "Tune the config", acceptance: ["a"], tools: ["read", "edit"], effort: "low", model: "@task", dependsOn: [] },
        ]),
    });
    assert.equal(result.ok, true);
    assert.ok(
      result.plan!.roles.some((r) => r.id === writerId),
      `${label}: the plan lost its writer; cast is ${result.plan!.roles.map((r) => r.id).join(",")}`,
    );
    assert.ok(
      result.plan!.roles.some((r) => r.id === "extra-tuner"),
      `${label}: a plan holding ${writerId} refused a proposed writer: ${result.plan!.notes.join(" | ")}`,
    );
    assert.ok(
      !result.plan!.notes.some((n) => n.includes("analysis-only") && n.includes("extra-tuner")),
      `${label}: reported analysis-only for a cast that writes: ${result.plan!.notes.join(" | ")}`,
    );
  }
});

test("the merge re-applies the role cap to what it adds", async () => {
  // The cap is a fan-out control, not a per-tier one: `synthesizePlan` trims the
  // static cast, and without re-applying it here a task that triggers the
  // proposal tier would ship a static cast plus every proposal on top of it.
  // The branch runs in ordinary use and had no assertion at all.
  //
  // The cap has to leave a slot open for the truncation itself to be the thing
  // under test. A build task fills the cap with its static cast, so both
  // proposals are dropped and the count assertion passes for the wrong reason.
  // This review-shaped task casts 3 seats under a cap of 4, so exactly one
  // proposal fits and the second is the one the cap must remove.
  const dir = await mkdtemp(join(tmpdir(), "rf-mergecap-"));
  const result = await runRoleFleet({
    task: "review the auth module for injection risks, consult a specialist expert",
    cwd: dir,
    maxRoles: 4,
    propose: async () =>
      JSON.stringify([
        { id: "tuner-a", title: "A", mission: "Tune", acceptance: ["a"], tools: ["read"], effort: "low", model: "@smol", dependsOn: [] },
        { id: "tuner-b", title: "B", mission: "Tune", acceptance: ["a"], tools: ["read"], effort: "low", model: "@smol", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  const cast = ids(result.plan!);
  assert.equal(cast.length, 4, `cap 4 not re-applied to the merged cast: ${cast.join(",")}`);
  assert.ok(cast.includes("tuner-a"), `the proposal inside the cap must survive: ${cast.join(",")}`);
  assert.ok(!cast.includes("tuner-b"), `a proposal past the cap must be dropped: ${cast.join(",")}`);
  const dropped = result.plan!.notes.find((n) => n.startsWith("role cap 4") && n.includes("tuner-b"));
  assert.ok(dropped, `the drop must be reported by id, not silent: ${result.plan!.notes.join(" | ")}`);
});

test("--review-only on a capable host does not claim the tier is missing", async () => {
  // C: the "specialist tier unavailable on this host" note is a statement about
  // the *machine*. `--review-only` suppresses the tier by choice, and the
  // else-branch only re-checked the task wording — so every review-only run on a
  // host that does have side turns told the user their host could not do the
  // thing it had just been turned off from doing.
  const dir = await mkdtemp(join(tmpdir(), "rf-reviewnote-"));
  const result = await runRoleFleet({
    task: "review the auth module for security issues and report findings",
    cwd: dir,
    reviewOnly: true,
    propose: async () => "[]",
  });
  assert.ok(
    !result.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `a suppressed tier was reported as missing: ${result.plan!.notes.join(" | ")}`,
  );

  // A dry run is suppressed by choice too, and says so with its own note — the
  // host-capability note stays reserved for a machine that cannot run the tier.
  const dry = await runRoleFleet({
    task: "review the auth module for security issues and report findings",
    cwd: dir,
    dryRun: true,
    propose: async () => "[]",
  });
  assert.ok(
    dry.plan!.notes.some((n) => n.includes("dry run: specialist tier skipped")),
    `a dry run must name the skip: ${dry.plan!.notes.join(" | ")}`,
  );
  assert.ok(
    !dry.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `a dry run must not be reported as a missing capability: ${dry.plan!.notes.join(" | ")}`,
  );

  // The same run without a proposer still says it: there the host genuinely
  // cannot run the tier, and that is the fact to report.
  const noHost = await runRoleFleet({
    task: "review the auth module for security issues and report findings",
    cwd: dir,
  });
  assert.ok(
    noHost.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `a host without side turns must still be told: ${noHost.plan!.notes.join(" | ")}`,
  );

  // Both facts can hold at once — a dry run on a host with no side turns — and
  // there the capability wins: "skipped, it is a paid model call" would claim a
  // saving that was never on offer, where the missing capability is something
  // the user cannot discover any other way.
  const both = await runRoleFleet({
    task: "review the auth module for security issues and report findings",
    cwd: dir,
    dryRun: true,
  });
  assert.ok(
    both.plan!.notes.some((n) => n.includes("specialist tier unavailable")),
    `an incapable host must be named even under a dry run: ${both.plan!.notes.join(" | ")}`,
  );
  assert.ok(
    !both.plan!.notes.some((n) => n.includes("dry run: specialist tier skipped")),
    `a dry run must not claim a saving this host could not make: ${both.plan!.notes.join(" | ")}`,
  );
});

test("a proposed seat holding only a shell is a writer, and refused where nothing may write", async () => {
  // `bash` is not a read tool: a shell can write any path it can name, so a
  // proposal that holds one is a writer even without `edit`. Reading the writer
  // test off `edit`/`write` alone would have merged it into a plan that had just
  // promised no source changes.
  const dir = await mkdtemp(join(tmpdir(), "rf-shellwriter-"));
  const result = await runRoleFleet({
    task: "audit the payment pipeline for compliance gaps",
    cwd: dir,
    maxRoles: 8,
    propose: async () =>
      JSON.stringify([
        { id: "shell-reader", title: "S", mission: "Read with a shell", acceptance: ["a"], tools: ["read", "bash"], effort: "low", model: "@slow", dependsOn: [] },
        { id: "plain-reader", title: "R", mission: "Read", acceptance: ["a"], tools: ["read"], effort: "low", model: "@task", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  assert.ok(
    !result.plan!.roles.some((r) => r.id === "shell-reader"),
    `a shell holder merged into an analysis-only plan: ${result.plan!.roles.map((r) => r.id).join(", ")}`,
  );
  assert.ok(result.plan!.roles.some((r) => r.id === "plain-reader"), "the read-only proposal still merges");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("analysis-only plan") && n.includes("shell-reader")),
    `the refusal must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});

test("a fanned-out plan refuses a proposed writer, and keeps the read-only proposals", async () => {
  // The fan-out is already every writer the run can keep apart, so a proposed
  // one would be a second implementation — the same defect as two writers on one
  // file. The refusal costs one seat, not the tier.
  const dir = await mkdtemp(join(tmpdir(), "rf-slicewriter-"));
  const result = await runRoleFleet({
    // "specialist" is what makes the tier run at all on a build task; the change
    // verb is what gives the fan-out an implementer to split.
    task: "fix the login bug with a specialist",
    cwd: dir,
    maxRoles: 8,
    slices: 2,
    propose: async () =>
      JSON.stringify([
        { id: "extra-writer", title: "W", mission: "Write more", acceptance: ["a"], tools: ["read", "edit"], effort: "low", model: "@task", dependsOn: [] },
        { id: "extra-reader", title: "R", mission: "Read more", acceptance: ["a"], tools: ["read"], effort: "low", model: "@smol", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  assert.ok(
    !result.plan!.roles.some((r) => r.id === "extra-writer"),
    `a fourth writer merged into a fanned-out plan: ${result.plan!.roles.map((r) => r.id).join(", ")}`,
  );
  assert.ok(result.plan!.roles.some((r) => r.id === "extra-reader"), "the read-only proposal still merges");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("fanned-out plan") && n.includes("extra-writer")),
    `the refusal must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});

test("a council plan still leaves a proposal slot", async () => {
  // Council members are exempt from the cap as one logical seat. Counting each
  // of them against `maxRoles` made `slots` zero on exactly the plan that paid
  // for the proposal tier, so the call succeeded and changed nothing.
  const dir = await mkdtemp(join(tmpdir(), "rf-councilslot-"));
  const result = await runRoleFleet({
    task: "review the auth module with a council of different providers and consult a specialist expert",
    cwd: dir,
    council: 3,
    maxRoles: 4,
    propose: async () =>
      JSON.stringify([
        { id: "threat-modeler", title: "T", mission: "Model threats", acceptance: ["a"], tools: ["read"], effort: "low", model: "@plan", dependsOn: [] },
      ]),
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.plan!.roles.some((r) => r.id === "threat-modeler"),
    `the council consumed every slot: ${result.plan!.notes.join(" | ")}`,
  );
});
