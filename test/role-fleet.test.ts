/**
 * End-to-end behaviour of the fleet: alias mapping, synthesis, the gate,
 * council and consul seating, the flag parser, agent emission and dispatch
 * rendering.
 *
 * The largest file here on purpose — these are whole-run assertions across the
 * pipeline, and splitting them by module would put each test next to an
 * implementation it is meant to be independent of. The specialist tiers have
 * their own file; the confirmation screen and the settled-run observer have
 * theirs.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { aliasFor, bindFleet, isCouncilMember, planWaves, validatePlan, type Fleet, type RolePlan, type RoleSpec } from "../src/core.ts";
import { synthesizePlan } from "../src/synthesize.ts";
import { gatePlan } from "../src/gate.ts";
import { agentMarkdown, dispatchGroups, emitAgents, pruneGeneratedAgents, pruneRunDirs, type DispatchGroup } from "../src/agents.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { parseFlags } from "../src/index.ts";
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
  assert.ok(review.dependsOn.includes("implementer"));
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
      for (const d of r.dependsOn) assert.ok(seen.has(d), `${r.id} ran before ${d}`);
      seen.add(r.id);
    }
  }
  assert.equal(waves.flat().length, plan.roles.length);
});

test("a dependency cycle still terminates in a final wave", () => {
  const base = planFor("x").roles[0];
  const a: RoleSpec = { ...base, id: "a", dependsOn: ["b"] };
  const b: RoleSpec = { ...base, id: "b", dependsOn: ["a"] };
  const waves = planWaves([a, b]);
  assert.equal(waves.length, 1);
  assert.equal(waves[0].length, 2);
});

// ── gate ──────────────────────────────────────────────────────────────────────

test("the gate rejects plans with unknown dependencies and missing acceptance", () => {
  const plan = planFor("fix the bug");
  const tampered = { ...plan, roles: [{ ...plan.roles[0], dependsOn: ["ghost"], acceptance: [] }] };
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

test("a named model list runs one council member per model, in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-models-flag-"));
  const result = await runRoleFleet({
    task: "review the auth refactor",
    cwd: dir,
    models: ["xai/grok-4", "zai/glm-5", "anthropic/claude-opus-4-6"],
  });
  assert.equal(result.ok, true);
  const members = result.plan!.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3, "the list itself is the ask for several eyes — no --council needed");
  assert.deepEqual(members.map((m) => m.model), ["xai/grok-4", "zai/glm-5", "anthropic/claude-opus-4-6"]);
  // The run survives the gate with concrete selectors rather than aliases.
  assert.deepEqual(validatePlan(result.plan!), []);
  for (const agent of result.agents.filter((a) => isCouncilMember(a.role))) {
    const body = await readFile(agent.path, "utf8");
    assert.ok(body.includes(`model: "${agent.model}"`), `${agent.role} must pin the named model`);
  }
});

test("a two-model list still runs a council, and a one-model list retargets the reviewer", async () => {
  const two = await runRoleFleet({
    task: "review the auth refactor",
    cwd: await mkdtemp(join(tmpdir(), "rf-two-")),
    models: ["xai/grok-4", "zai/glm-5"],
  });
  assert.deepEqual(
    two.plan!.roles.filter((r) => isCouncilMember(r.id)).map((m) => m.model),
    ["xai/grok-4", "zai/glm-5"],
  );

  const one = await runRoleFleet({
    task: "review the auth refactor",
    cwd: await mkdtemp(join(tmpdir(), "rf-one-")),
    models: ["xai/grok-4"],
  });
  // A council of one would be the same review twice; the reviewer already in the
  // plan is retargeted instead.
  assert.equal(one.plan!.roles.filter((r) => isCouncilMember(r.id)).length, 0);
  const reviewer = one.plan!.roles.find((r) => r.id === "reviewer")!;
  assert.equal(reviewer.model, "xai/grok-4");
  assert.ok(
    one.plan!.notes.some((n) => n.includes("xai/grok-4") && n.includes("@slow")),
    `the retarget must be stated: ${one.plan!.notes.join(" | ")}`,
  );
});

test("a list shorter than the council says which members fell back to an alias", async () => {
  const result = await runRoleFleet({
    task: "review with a council",
    cwd: await mkdtemp(join(tmpdir(), "rf-short-")),
    council: 3,
    models: ["xai/grok-4", "zai/glm-5"],
  });
  const members = result.plan!.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3);
  assert.equal(members[2]!.model, "@plan", "the unnamed member keeps its alias");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("past your list")),
    `the unnamed member must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});

test("a named list on an analysis-only plan says there is no reviewer to retarget", async () => {
  const result = await runRoleFleet({
    task: "explain how the adapter layer works",
    cwd: await mkdtemp(join(tmpdir(), "rf-analysis-")),
    models: ["xai/grok-4"],
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("--models") && n.includes("no reviewer")),
    `a silent no-op is the failure here: ${result.plan!.notes.join(" | ")}`,
  );
});

test("an allowlist outranks a named list, and the plan says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-conflict-"));
  const file = join(dir, "fleet.json");
  await writeFile(
    file,
    JSON.stringify({
      models: [{ selector: "pinned/model", aliases: ["pinned"] }],
      roles: [{ role: "reviewer", chain: ["pinned", "pinned", "pinned"] }],
    }),
    "utf8",
  );
  const result = await runRoleFleet({ task: "review it", cwd: dir, allowlist: file, models: ["xai/grok-4", "zai/glm-5"] });
  const members = result.plan!.roles.filter((r) => isCouncilMember(r.id));
  assert.ok(members.every((m) => m.model === "pinned/model"), "the file constrains the seats it describes");
  assert.ok(
    result.plan!.notes.some((n) => n.includes("--models") && n.includes("allowlist")),
    `the override must be visible: ${result.plan!.notes.join(" | ")}`,
  );
});

test("--consul adds a deciding seat after the council, and members can hand it reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-consul-"));
  const result = await runRoleFleet({
    task: "review the auth refactor",
    cwd: dir,
    models: ["xai/grok-4", "zai/glm-5"],
    consul: "anthropic/claude-opus-4-6",
  });
  assert.equal(result.ok, true);
  const consul = result.plan!.roles.find((r) => r.id === "consul");
  assert.ok(consul, "the deciding seat must exist");
  assert.equal(consul!.model, "anthropic/claude-opus-4-6");
  assert.deepEqual(consul!.dependsOn.sort(), ["reviewer-c1", "reviewer-c2"]);
  // It waits for every member, and lands in a later wave than all of them.
  const waveOf = (id: string) => result.waves.findIndex((w) => w.some((r) => r.id === id));
  for (const member of ["reviewer-c1", "reviewer-c2"]) {
    assert.ok(waveOf("consul") > waveOf(member), `${member} must settle before the consul runs`);
  }

  // The reports have to exist as files for the consul to read them: a read-only
  // member returns its report as a yield payload, and `review-cN.md` would be a
  // path nobody ever writes.
  const members = result.agents.filter((a) => isCouncilMember(a.role));
  assert.ok(members.every((m) => m.model), "members exist");
  for (const role of result.plan!.roles.filter((r) => isCouncilMember(r.id))) {
    assert.ok(role.tools.includes("write"), `${role.id} must be able to write its report`);
    assert.ok(!role.tools.includes("edit"), `${role.id} must not gain source-file edits`);
    assert.ok(role.acceptance.some((a) => a.includes(role.artifact)), `${role.id} must be told where to write`);
  }
  // The written path is the one the consul is told to read.
  assert.match(consul!.mission, /Read every council report in full/);
  assert.match(consul!.acceptance.join(" "), /Every council report read in full/);

  // The dispatch hands synthesis to the seat instead of asking the session to
  // second-guess it.
  const dispatch = renderDispatch(result.groups, result.agentDir!);
  assert.match(dispatch, /`consul` seat reconciles/);
  assert.ok(!dispatch.includes("treat the most conservative"), "the session must not synthesize as well");
});

test("without --consul the session model keeps the synthesis, unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-no-consul-"));
  const result = await runRoleFleet({ task: "review the auth refactor", cwd: dir, models: ["xai/grok-4", "zai/glm-5"] });
  assert.equal(result.plan!.roles.some((r) => r.id === "consul"), false);
  // The status quo is the main model reading the council itself.
  assert.match(renderDispatch(result.groups, result.agentDir!), /treat the most conservative/);
});

test("--consul without a council says the session model will synthesize", async () => {
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: await mkdtemp(join(tmpdir(), "rf-consul-none-")),
    consul: "anthropic/claude-opus-4-6",
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan!.roles.some((r) => r.id === "consul"), false);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("--consul") && n.includes("session model")),
    `a silent no-op is the failure: ${result.plan!.notes.join(" | ")}`,
  );
});

test("the role cap never drops the consul", async () => {
  const result = await runRoleFleet({
    task: "refactor the auth module and review it",
    cwd: await mkdtemp(join(tmpdir(), "rf-consul-cap-")),
    maxRoles: 2,
    models: ["xai/grok-4", "zai/glm-5"],
    consul: "anthropic/claude-opus-4-6",
  });
  // A dropped consul would silently hand synthesis back to the session model,
  // so the run would look successful while doing the thing the user turned off.
  assert.ok(result.plan!.roles.some((r) => r.id === "consul"), "the deciding seat is exempt from the cap");
});

test("--consul refuses a follower that is task text and says how to spell it", () => {
  const eaten = parseFlags(["--consul", "fix", "the", "login", "bug"]);
  assert.equal(eaten.flags.consul, undefined);
  // The refusal names the two accepted spellings rather than just rejecting: a
  // bare id like `sonnet` is legitimate, it simply cannot be told apart from the
  // task's first word in the spaced form. Pointing at `--consul=sonnet` is what
  // makes the rejection actionable instead of a dead end.
  assert.match(eaten.problems[0] ?? "", /--consul needs @alias or provider\/id/);
  assert.match(eaten.problems[0] ?? "", /--consul=NAME/);
  // The deciding seat stays on the session model, and the word is not lost.
  assert.match(eaten.problems[0] ?? "", /session model/);
  assert.equal(eaten.task, "fix the login bug");

  const inline = parseFlags(["--consul=xai/grok-4", "fix the bug"]);
  assert.equal(inline.flags.consul, "xai/grok-4");
  assert.deepEqual(inline.problems, []);

  // A model is `@alias` or `provider/id`, structurally. The earlier test was
  // "contains @, /, or a digit", which accepted `/fix` and `v2` — task words that
  // happen to carry one — and pinned them as selectors the host cannot resolve, so
  // the seat ran on the parent's model while the plan claimed a provider it never
  // had. A bare id is therefore refused in the spaced form, and the word stays in
  // the task.
  const bare = parseFlags(["--consul", "glm-5", "fix the bug"]);
  assert.equal(bare.flags.consul, undefined);
  assert.equal(bare.task, "glm-5 fix the bug", "the refused word must not vanish");

  const digitWord = parseFlags(["--consul", "v2", "of the api", "is", "stale"]);
  assert.equal(digitWord.flags.consul, undefined, "a task word carrying a digit is not a model");

  // The same ids are reachable through the `=` form, where the user separated the
  // value themselves — which is what closes the old asymmetry against `--models`,
  // whose bracketed list has always taken `sonnet`.
  for (const spelling of ["sonnet", "glm-5", "anthropic/claude-opus-4-6", "@slow"]) {
    const via = parseFlags([`--consul=${spelling}`, "fix the bug"]);
    assert.equal(via.flags.consul, spelling, `--consul=${spelling} was not taken`);
    assert.deepEqual(via.problems, []);
    assert.equal(via.task, "fix the bug");
  }

  // An alias is unambiguous, so the spaced form keeps working for it.
  const aliased = parseFlags(["--consul", "@slow", "fix the bug"]);
  assert.equal(aliased.flags.consul, "@slow");
  assert.equal(aliased.task, "fix the bug");
  // A leading slash is a path-shaped word, not a provider/id pair: the old
  // "contains /" test accepted `/fix` and pinned a selector that resolves to
  // nothing, which put the deciding seat on the parent's model while the plan
  // named a provider it never had.
  const slashWord = parseFlags(["--consul", "/fix", "the", "login", "bug"]);
  assert.equal(slashWord.flags.consul, undefined, "a leading slash is not provider/id");
  assert.equal(slashWord.task, "/fix the login bug");

  // Quotes survive the host's whitespace-only split, so they must be stripped
  // rather than pinned verbatim into the agent frontmatter.
  const quoted = parseFlags(["--consul", '"xai/grok-4"', "fix the bug"]);
  assert.equal(quoted.flags.consul, "xai/grok-4", `quotes leaked: ${JSON.stringify(quoted.flags.consul)}`);
  assert.equal(quoted.task, "fix the bug");

  // A blank value is the one thing that must never be pinned. `Boolean(" ")` is
  // true, so a quoted `--consul=" "` would mint the deciding seat on a selector
  // the host cannot resolve, and synthesis sees a truthy string and adds no note
  // — the deciding seat then silently runs on the parent model, which is the
  // exact outcome every other refusal in this parser exists to prevent.
  for (const blank of ["--consul=", "--consul=   ", `--consul="${"  "}"`]) {
    const empty = parseFlags([blank, "fix the bug"]);
    assert.equal(empty.flags.consul, undefined, `a blank value was pinned: ${JSON.stringify(blank)}`);
    assert.equal(empty.problems.length, 1, `no refusal reported for ${JSON.stringify(blank)}`);
    assert.match(empty.problems[0] ?? "", /--consul needs @alias or provider\/id/);
    assert.equal(empty.task, "fix the bug");
  }
});

test("--consul takes a nested provider path in either spelling", () => {
  // A router selector is more than one segment deep, and the spaced form
  // accepted exactly one: `openrouter/anthropic/claude-4` was refused there and
  // accepted through `--consul=`, so the same selector worked or failed
  // depending on how it was typed.
  const spaced = parseFlags(["--consul", "openrouter/anthropic/claude-4", "audit the api"]);
  assert.equal(spaced.flags.consul, "openrouter/anthropic/claude-4");
  assert.deepEqual(spaced.problems, []);
  assert.equal(spaced.task, "audit the api", "the selector must not become task text");

  // The shape test is still a shape test: a task word with a leading slash is
  // not a model, and a bare name is still told to use the `=` form.
  const word = parseFlags(["--consul", "/fix", "the bug"]);
  assert.equal(word.flags.consul, undefined);
  assert.match(word.problems[0] ?? "", /needs @alias or provider\/id/);
});

test("--models refuses a list with a bracket left inside an entry", () => {
  // `(a,b))` unwraps to `a, b)`. Splitting it anyway pinned a selector of `b)`,
  // which the host cannot resolve — the seat then ran on the parent's model
  // while the plan and the roster both claimed a provider it never had.
  const cut = parseFlags(["--models=(a,b))", "fix the bug"]);
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /malformed entries/);
  assert.equal(cut.task, "fix the bug", "the task must survive the refusal");

  // A well-formed list of the same length is still accepted.
  const good = parseFlags(["--models=(a/1,b/2)", "fix the bug"]);
  assert.deepEqual(good.flags.models, ["a/1", "b/2"]);
  assert.deepEqual(good.problems, []);
});

test("the review model list is made usable before it reaches a seat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-models-"));
  const base = { task: "fix the auth bug", cwd: dir, dryRun: true };

  // An empty entry used to reach `validatePlan` and reject the whole run with
  // "role reviewer: no model" — opaque, and a run the flag path would have
  // planned for the same list. A whitespace entry was worse in the other
  // direction: it passed validation and was pinned into the agent file, so the
  // seat ran on the parent's model while the plan claimed it named one.
  for (const models of [[""], ["  "]]) {
    const result = await runRoleFleet({ ...base, models });
    assert.equal(result.ok, true, `a blank entry rejected the run: ${JSON.stringify(models)}`);
    assert.equal(
      result.plan!.roles.find((r) => r.core === "reviewer")!.model,
      "@slow",
      "the reviewer must keep its alias rather than a blank selector",
    );
    assert.ok(
      result.plan!.notes.some((n) => n.includes("blank or duplicate")),
      `the drop was not reported: ${result.plan!.notes.join(" | ")}`,
    );
  }

  // Duplicates collapse to one reviewer per named model, exactly as the flag
  // path does: two members on one model is the double-priced single review the
  // README says this feature exists to avoid.
  const dupes = await runRoleFleet({ ...base, models: ["xai/grok-4", "xai/grok-4"] });
  const members = dupes.plan!.roles.filter((r) => r.core === "reviewer");
  assert.equal(members.length, 1, `a duplicate was seated twice: ${JSON.stringify(members)}`);
  assert.equal(members[0]!.model, "xai/grok-4");

  // A blank consul is no consul. Seating one on a blank selector would mint the
  // deciding seat on a model the host cannot resolve *and* grant every council
  // member repo-wide write so their reports reach it.
  const blank = await runRoleFleet({ ...base, council: 3, consul: "  " });
  assert.ok(!blank.plan!.roles.some((r) => r.id === "consul"), "a blank consul was seated");
  assert.ok(blank.plan!.notes.some((n) => n.includes("blank selector was ignored")));
  assert.ok(
    !blank.plan!.notes.some((n) => n.includes("repo-wide write")),
    `no consul means no write grant: ${blank.plan!.notes.join(" | ")}`,
  );
});

test("an allowlist keeps a review council on distinct models", () => {
  const plan = synthesizePlan({
    task: "review with different providers",
    cwd: "/tmp",
    workDir: "/tmp/wf",
    council: 3,
  });
  const gate = gatePlan(plan, COUNCIL_FLEET);
  assert.equal(gate.ok, true);
  const members = gate.plan!.roles.filter((r) => isCouncilMember(r.id));
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
  const members = roles.filter((r) => isCouncilMember(r.id));
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
    // Every top-level frontmatter key is a known one: task text lives only in
    // the body, and the nested `output:` schema block is indented, so a
    // zero-indent line is always a top-level key.
    const known = new Set(["name", "description", "tools", "model", "thinking-level", "advisor", "output"]);
    for (const line of fm.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l))) {
      assert.ok(known.has(line.split(":")[0]), `stray frontmatter line: ${line.slice(0, 60)}`);
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

  const known = new Set(["name", "description", "tools", "model", "thinking-level", "advisor", "output"]);
  for (const line of fm.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l))) {
    assert.ok(known.has(line.split(":")[0]), `stray frontmatter line: ${line.slice(0, 60)}`);
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

test("council members do not share one dependsOn array", () => {
  // One shared instance meant any in-place edit of one member's dependencies
  // edited all of them — a hazard the moment anything mutates a plan.
  const plan = synthesizePlan({
    task: "review with different providers",
    cwd: "/tmp",
    workDir: "/tmp/w",
    council: 3,
  });
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3);
  assert.equal(new Set(members.map((m) => m.dependsOn)).size, 3, "each member needs its own array");

  // And mutating one really does leave the others alone.
  members[0]!.dependsOn.push("scout");
  assert.deepEqual(members[1]!.dependsOn, ["scout"]);
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
    writesOwnReport: false,
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

test("the plan names the concrete model behind every alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-models-"));
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    resolveModel: (spec) => `mock/${spec.replace("@", "role-")}`,
  });
  assert.equal(result.ok, true);
  // `@slow` says which class of work the seat is for; `provider/id` says what
  // actually answers. A user who has to guess which one ran cannot tell a
  // fallback from the intended model.
  const impl = result.plan!.roles.find((r) => r.id === "implementer")!;
  assert.equal(impl.model, "@task", "the pinned selector must stay an alias");
  assert.equal(impl.modelResolved, "mock/role-task");
  const text = renderPlan(result.plan!, result.waves);
  assert.match(text, /implementer mock\/role-task \(@task\)/);
  for (const agent of result.agents) {
    assert.equal(agent.modelResolved, `mock/${agent.model.replace("@", "role-")}`);
  }
});

test("a selector the host cannot resolve keeps its alias and claims nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-unresolved-"));
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    // Only one seat resolves: a `@designer` with no modelRoles entry is the real
    // case, and a guessed model there would be a fabrication.
    resolveModel: (spec) => (spec === "@task" ? "mock/fast-1" : undefined),
  });
  const impl = result.plan!.roles.find((r) => r.id === "implementer")!;
  assert.equal(impl.modelResolved, "mock/fast-1");
  const review = result.plan!.roles.find((r) => r.id === "reviewer")!;
  assert.equal(review.modelResolved, undefined, "an unresolved seat must not carry a guess");

  const text = renderPlan(result.plan!, result.waves);
  assert.match(text, /reviewer @slow/, "an unresolved seat keeps the alias label");
  assert.ok(!text.includes("reviewer undefined"));
});

test("the roster and the run table carry the concrete model, not the tier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-roster-models-"));
  const agentsDir = join(dir, "agents");
  const result = await runRoleFleet({
    task: "review with different providers",
    cwd: dir,
    council: 3,
    resolveModel: (spec) => `mock/${spec.replace("@", "role-")}-7`,
  });
  const text = renderDispatch(result.groups, agentsDir);

  // The tier names alone tell the user nothing about which model answered.
  assert.ok(!/"name": "ReviewerC\d+ (Slow|Task|Plan)"/.test(text), `roster still shows tiers: ${text}`);
  assert.match(text, /"name": "ReviewerC1 RoleSlow7"/);
  // The full selector is one line above the roster: the plugin caps roster ids
  // at 32 characters, so the bare `provider/id` cannot live inside the name.
  assert.match(text, /- `ReviewerC1 RoleSlow7` — reviewer-c1 on `mock\/role-slow-7` \(pinned as `@slow`\)/);

  for (const m of text.matchAll(/"name": "([^"]+)"/g)) {
    assert.ok(m[1]!.length <= 32, `name over budget: ${m[1]}`);
  }
});

test("dispatch tells the main model to read the whole report, not the headline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-full-report-"));
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir });
  const text = renderDispatch(result.groups, join(dir, "agents"));
  // The host previews a long result and points at `agent://<id>`; deciding on
  // the preview is how a council concludes on half a review.
  assert.match(text, /FULL returned report/);
  assert.match(text, /`summary` is a headline/);
  assert.match(text, /agent:\/\/<id>/);
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

test("a read-only role is told to yield its report, not to write a file", () => {
  const plan = planFor("fix the auth bug");
  const scout = plan.roles.find((r) => r.id === "scout")!;
  const impl = plan.roles.find((r) => r.id === "implementer")!;
  assert.ok(!scout.tools.includes("write"), "the scout seat must be read-only");

  // A brief that orders a write the grant cannot perform is an instruction the
  // agent must fail: it reports the blocked path instead of the findings.
  const scoutBody = agentMarkdown(plan, scout);
  assert.ok(!scoutBody.includes("- Write your report to"), "a read-only role must not be told to write");
  assert.match(scoutBody, /Yield your full report/);
  // The artifact path stays in the brief and names who writes it: the report
  // belongs at that path either way, and a downstream agent has no way to read
  // any other agent's message.
  assert.match(scoutBody, /scout\.md/, "the read-only role must still name its artifact path");

  // A writer still gets its artifact path — that is how the run collects it.
  assert.match(agentMarkdown(plan, impl), /Write your report to `.*implementation\.md`/);
});

test("every seat ships a report schema, so a bare summary cannot pass as a report", () => {
  const plan = planFor("fix the auth bug");
  for (const role of plan.roles) {
    const fm = agentMarkdown(plan, role).split("---")[1] ?? "";
    // The host validates yields against this schema: a result without a
    // required `report` is rejected and the seat is sent back for the full
    // deliverable. Without it a council member's paragraph is what the
    // synthesizer weighs, which is the failure this closes.
    assert.match(fm, /^output:/m, `${role.id} declares no output schema`);
    assert.match(fm, /^ {4}report:$/m, `${role.id} has no report field`);
    // The spelling is load-bearing, and both halves of it are: the host reads a
    // root with `properties` and no `type` as JTD, where `properties` are
    // required members — but the conversion rebuilds each node from JTD keywords
    // alone and drops `metadata`, so the field descriptions never reach the
    // model. Naming `type: object` takes the JSON-Schema branch the host keeps
    // intact, and *that* branch requires nothing unless `required` says so.
    assert.match(fm, /^ {2}type: object$/m, `${role.id} must declare a JSON-Schema root`);
    assert.match(
      fm,
      /^ {2}required: \["summary", "report", "verdict"\]$/m,
      `${role.id} must require all three fields`,
    );
    assert.match(fm, /^ {6}description: "One-paragraph headline/m, `${role.id} must describe its fields`);
    // Presence is not delivery: `report: ""` satisfies a required list, so the
    // deliverable field carries its own floor. The host enforces `minLength`.
    assert.match(fm, /^ {6}minLength: 1$/m, `${role.id} must reject an empty report`);
    // No self-reported model field: a seat is told only which model it was
    // pinned to, so asking it what ran is asking the question that a fallback
    // invalidates. The host result carries the truth (model-observed.ts).
    assert.ok(!fm.includes("model_used"), `${role.id} must not self-report the model it ran on`);
    const body = agentMarkdown(plan, role);
    assert.match(body, /`summary` is a headline/, `${role.id} does not separate summary from report`);
  }
});

test("a seat states the model it was pinned to and the one it resolved to", () => {
  const plan = planFor("fix the auth bug");
  const scout = plan.roles.find((r) => r.id === "scout")!;
  const unresolved = agentMarkdown(plan, scout);
  assert.match(unresolved, /Model: `@smol` \(not resolved/, "an unresolved seat must not claim a model");

  // A concrete pin records `modelResolved` only when the resolution differs
  // from it, so a pin that resolved to itself must not read as a failure.
  const pinned = agentMarkdown(plan, { ...scout, model: "xai/grok-4" });
  assert.match(pinned, /Model: `xai\/grok-4`$/m, "a concrete pin that resolved to itself is not a resolution failure");

  const resolved = agentMarkdown(plan, { ...scout, modelResolved: "minimax/MiniMax-M3" });
  assert.match(resolved, /Model: `@smol` → resolved to `minimax\/MiniMax-M3`/);
});

test("an upstream read-only dependency names its path and who writes it", () => {
  const plan = planFor("fix the auth bug");
  const impl = plan.roles.find((r) => r.id === "implementer")!;
  const scoutArtifact = plan.roles.find((r) => r.id === "scout")!.artifact;

  // The tester waits on the implementer, a read-only dep waits on the scout.
  const tester = { ...plan.roles.find((r) => r.id === "tester")!, dependsOn: ["scout"] };
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
      { ...planFor("fix the auth bug").roles[0], id: "docs", dependsOn: ["ghost"] },
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

test("the advisor rides the seats whose mistakes cost the whole wave", async () => {
  // `advisor: true` pairs that seat's own session with the host's advisor-role
  // model, which passively reviews each of its turns — the host's version of a
  // stronger model at decision points. It is emitted for the planner, whose plan
  // every later wave follows, and for the implementer seat including
  // `migration-runner`, which runs that seat under its own id (`core`, not id, so
  // a proposed writer is covered by the same rule). Review seats are excluded:
  // their value is independence from the cast, so an advisor reviewing the
  // reviewer's own turns buys agreement rather than a second opinion. And
  // mechanical seats keep their cost — the host reviews every turn of an advised
  // seat at the advisor model's rates, and nothing here is free.
  const dir = await mkdtemp(join(tmpdir(), "rf-advisor-"));
  const plan = planFor("migrate the api client off the old sdk across several files");
  const advised: string[] = [];
  for (const agent of await emitAgents(plan, dir)) {
    if (/^advisor: true$/m.test(await readFile(agent.path, "utf8"))) advised.push(agent.role);
  }
  assert.deepEqual(advised.sort(), ["migration-runner", "planner"]);

  // A vision seat keeps the flag it already had: the seat's model handles the
  // images, and the advisor is the host's own pairing, not a vision key.
  const visionDir = await mkdtemp(join(tmpdir(), "rf-advisor-vision-"));
  const vision: string[] = [];
  for (const agent of await emitAgents(planFor("redesign the landing page"), visionDir)) {
    if (/^advisor: true$/m.test(await readFile(agent.path, "utf8"))) vision.push(agent.role);
  }
  assert.ok(vision.includes("designer"), `the vision seat lost its advisor: ${vision.join(",")}`);
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

test("a catalog seat's description comes from its own purpose, once", async () => {
  // Two maps used to describe the same seats — the purpose table and a copy in
  // the catalog — and the purpose table won every lookup, so the catalog's three
  // entries were unreachable. One source per voice now: the catalog names the
  // seat's match and grant, `SEAT_PURPOSE` says in the picker and the roster what
  // it is for.
  const dir = await mkdtemp(join(tmpdir(), "rf-catalogdesc-"));
  const plan = planFor("migrate the api client to the new sdk and fix the tests");
  const emitted = await emitAgents(plan, dir);
  const body = await readFile(emitted.find((a) => a.role === "migration-runner")!.path, "utf8");
  assert.match(body, /^description: "Role-fleet migration-runner: runs a dependency or framework migration/m);
  assert.match(body, /Can change code\./, "the description still states the grant");
});

test("a dependency cycle is dispatched sequentially, not as one parallel batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-cycle-"));
  const role = (id: string, dependsOn: string[]): RoleSpec => ({
    id,
    title: id,
    mission: "m",
    acceptance: ["a finding with file:line"],
    core: "implementer",
    dependsOn,
    tools: ["read"],
    effort: "low",
    needsVision: false,
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
  const members = plan.roles.filter((r) => isCouncilMember(r.id));
  assert.equal(members.length, 3);
});

test("dependents follow the specialist that replaced the implementer", () => {
  const plan = planFor("migrate the api client to the new sdk and fix the tests");
  const ids = new Set(plan.roles.map((r) => r.id));
  assert.ok(ids.has("migration-runner"), "the migration specialist must be in the plan");
  assert.ok(!ids.has("implementer"), "the specialist replaced the generic implementer");
  for (const role of plan.roles) {
    for (const dep of role.dependsOn ?? []) {
      assert.ok(ids.has(dep), `${role.id} still waits on the removed ${dep}`);
    }
  }
});

test("agent markdown quotes the alias so YAML stays valid", () => {
  const role = planFor("fix the bug").roles[0];
  assert.ok(agentMarkdown(planFor("fix the bug"), role).includes(`model: "${role.model}"`));
});

test("a consul run's reviewer brief does not claim it cannot write", () => {
  // A consul turns each member into a writer so its report exists as a file —
  // and the member's mission was copied from the static reviewer, which ended
  // "Read-only." So the emitted brief told the seat it could not write in the
  // one line it reads first, while the same file's frontmatter granted repo-wide
  // `write`: the brief contradicting its own grant, on the seat whose authority
  // the consent screen exists to state.
  const plan = synthesizePlan({
    task: "audit the api for injection risks",
    cwd: "/tmp",
    workDir: "/tmp/wf",
    council: 3,
    consul: "zai/glm-5",
  });
  const member = plan.roles.find((r) => isCouncilMember(r.id))!;
  assert.ok(member.tools.includes("write"), "the consul reads reports that must exist as files");
  const body = agentMarkdown(plan, member);
  assert.match(body, /tools: \["read", "grep", "glob", "write"\]/, body.slice(0, 400));
  assert.ok(!body.includes("Read-only"), `the brief denies the grant it was given: ${body.slice(0, 500)}`);
});

test("dispatch instructions state the item contract, not just the identity", async () => {
  // The batch carries `name` and `agent` only — that pair is what must not
  // drift — while the host rejects an item without `task` and declares
  // `solutionSpace` beside it. This text is where a dispatcher learns the rest
  // of the item is theirs to fill, and it lives in the renderer so both
  // surfaces state it.
  const dir = await mkdtemp(join(tmpdir(), "rf-guard-"));
  const dispatch = renderDispatch(dispatchGroups(await emitAgents(planFor("fix the auth bug"), dir)), dir);
  assert.match(dispatch, /Pass each item's `name` and `agent` exactly as given/);
  assert.match(dispatch, /`task` text/);
  assert.match(dispatch, /solutionSpace/);
  assert.match(dispatch, /Do NOT/);
  assert.ok(!/"model"/.test(dispatch), "the batch must not carry a model field");
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

test("a syntax error in an allowlist names the file, like every shape error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-badjson-"));
  const allowlist = join(dir, "broken.json");
  await writeFile(allowlist, '{ "models": [ },', "utf8");

  // `JSON.parse` reports the offset and quotes the document, so the message
  // named neither the file nor the flag that opened it — the one failure a user
  // can trigger by typing got the least actionable error in the plugin.
  const err = await runRoleFleet({ task: "fix the auth bug", cwd: dir, dryRun: true, allowlist }).then(
    () => null,
    (thrown: unknown) => thrown as Error,
  );
  assert.ok(err, "a malformed file must be refused, not planned unpinned");
  assert.ok(err.message.startsWith(`${allowlist}: `), `the file must be named: ${err.message}`);
});

test("the allowlist does not claim to have overridden a list it never touched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-override-"));

  // A file that describes no review seat leaves every named model in place, so
  // there is nothing to report: the note used to fire on the mere presence of
  // both inputs and described a run that did not happen.
  const untouchedPath = join(dir, "untouched.json");
  await writeFile(untouchedPath, JSON.stringify({ models: [{ selector: "a/one" }], roles: [] }), "utf8");
  const untouched = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    dryRun: true,
    models: ["x/1", "y/2"],
    allowlist: untouchedPath,
  });
  assert.deepEqual(
    untouched.plan!.roles.filter((r) => r.core === "reviewer").map((r) => r.model),
    ["x/1", "y/2"],
    "the named models must survive a file that describes no review seat",
  );
  assert.ok(
    !untouched.plan!.notes.some((n) => n.includes("overridden")),
    `an untouched list was reported as overridden: ${untouched.plan!.notes.join(" | ")}`,
  );

  // A file that does describe the seat wins for it, and says so.
  const winningPath = join(dir, "winning.json");
  await writeFile(
    winningPath,
    JSON.stringify({ models: [{ selector: "b/two" }], roles: [{ role: "reviewer", chain: ["b/two"] }] }),
    "utf8",
  );
  const winning = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    dryRun: true,
    models: ["x/1"],
    allowlist: winningPath,
  });
  assert.equal(winning.plan!.roles.find((r) => r.core === "reviewer")!.model, "b/two");
  const note = winning.plan!.notes.find((n) => n.includes("overridden"))!;
  assert.ok(note, `the file won and never said so: ${winning.plan!.notes.join(" | ")}`);
  // Named seat by seat, because the council line above it was composed before
  // binding: a bare "overridden" leaves the reader to guess which of the two model
  // lists the run used.
  assert.match(note, /reviewer x\/1 → b\/two/, note);
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

test("the dispatch tells the orchestrator where to place read-only reports", async () => {
  // B: a read-only seat is told its report "belongs at <artifact>, and the
  // orchestrator writes it there", and every downstream brief points at that same
  // path — but nothing ever said this to the orchestrator. The instruction lived
  // in a brief the main model never reads, so the dependency edge the pipeline
  // itself created resolved to a file that only appeared if the parent guessed.
  // Observed directly: a run directory with five agent files and no report in it.
  const dir = await mkdtemp(join(tmpdir(), "rf-channel-"));
  const result = await runRoleFleet({
    task: "review the auth module for security issues",
    cwd: dir,
    models: ["xai/grok-4", "zai/glm-5"],
  });
  assert.equal(result.ok, true);

  const dispatch = renderDispatch(result.groups, result.agentDir!);
  assert.match(dispatch, /Read-only seats cannot write their artifact/, "the channel must be stated");
  // Every read-only seat's declared path is named, so there is nothing to infer.
  const readOnly = result.agents.filter((a) => !a.writesOwnReport);
  assert.ok(readOnly.length, "a review plan must contain a read-only seat");
  for (const seat of readOnly) {
    assert.ok(
      dispatch.includes(seat.artifact),
      `${seat.role}'s artifact path is missing from the dispatch:\n${dispatch.slice(0, 500)}`,
    );
  }
  // And a seat that does hold write is not in the list — it writes its own file.
  for (const writer of result.agents.filter((a) => a.writesOwnReport)) {
    const line = dispatch.split("\n").find((l) => l.includes(writer.artifact));
    assert.ok(!line || !/read-only/i.test(line), `${writer.role} listed as read-only while it holds write`);
  }
});

test("the agent-file prune orders run ids numerically, like the directory prune", async () => {
  // E: both prune guards implement one invariant — never delete a file a newer
  // run is still using — and they compared the same ids two different ways.
  // `pruneRunDirs` parses the digits and says why; the agent guard used a string
  // comparison. Across a digit-count boundary (`run-999` vs `run-1000`) the newer
  // run sorts *older*, so an older run's prune deleted a live run's agent
  // definition — the exact failure `nextRunId`'s monotonic bump exists to prevent.
  //
  // Today's `Date.now()` is 13 digits, so the case cannot arise in production; it
  // is pinned because the guard is the riskier half of the invariant (it deletes
  // agent files, not scratch directories) and had no test at all.
  const dir = await mkdtemp(join(tmpdir(), "rf-order-"));
  const agents = join(dir, ".omp", "agents");
  await mkdir(agents, { recursive: true });
  const written = (runId: string) =>
    [
      "---",
      "name: rf-scout",
      'description: "x"',
      "tools: [read]",
      'model: "@smol"',
      "thinking-level: high",
      "---",
      "",
      "<!-- role-fleet:generated -->",
      `<!-- role-fleet:run ${runId} -->`,
      "",
      "# body",
    ].join("\n");

  await writeFile(join(agents, "rf-scout.md"), written("run-1000"), "utf8");
  const kept = await pruneGeneratedAgents(agents, [], "run-999");
  assert.deepEqual(kept, [], "a newer run's live agent file was deleted");

  await writeFile(join(agents, "rf-scout.md"), written("run-998"), "utf8");
  const stale = await pruneGeneratedAgents(agents, [], "run-999");
  assert.equal(stale.length, 1, "a stale generated file was left behind");
});

test("a hostile grant list cannot inject frontmatter keys", () => {
  // R9: `model` went through `yamlString` while `tools` and `thinking-level` were
  // interpolated raw, safe only because every producer constrained them. The
  // grant list is a security boundary by this module's own header, so the escape
  // has to be unconditional — otherwise the next producer that reaches these
  // values from outside is the injection the line above already defends against.
  const base = synthesizePlan({ task: "fix the bug", cwd: "/tmp", workDir: "/tmp/w" }).roles[0]!;
  const role = {
    ...base,
    tools: ['read", "x", "model', "evil"],
    effort: "high\ninjected: true" as never,
  };
  const text = agentMarkdown({ task: "t", cwd: "/tmp", roles: [role], notes: [] }, role);
  const front = text.slice(4, text.indexOf("\n---", 4));
  assert.ok(!/^injected: true$/m.test(front), "the effort value added a frontmatter key");
  assert.ok(!/^model: evil/m.test(front), "the grant list broke out of its flow sequence");
});

test("the returned verdict describes the cast that actually ships", async () => {
  // C2: the run returned the pre-confirmation gate verdict on the success path
  // and the post-confirmation one on the failure path, so the same field meant
  // two different things — and after a confirmation that dropped seats it
  // reported the reason for a plan nobody ran.
  const dir = await mkdtemp(join(tmpdir(), "rf-verdict-"));
  let askedPlan: RolePlan | null = null;
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    confirm: async (plan) => {
      askedPlan = plan;
      return new Set(plan.roles.filter((r) => r.id !== "tester").map((r) => r.id));
    },
  });
  assert.equal(result.ok, true);
  assert.ok(askedPlan, "the confirmation must have been asked");
  assert.ok(!result.plan!.roles.some((r) => r.id === "tester"), "the dropped seat still shipped");
  // The verdict is about the shipped cast, and the confirmation is part of it.
  assert.match(result.verdict.reason, /./);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("confirmed cast") && n.includes("tester")),
    `the dropped seat must be reported: ${result.plan!.notes.join(" | ")}`,
  );
});
