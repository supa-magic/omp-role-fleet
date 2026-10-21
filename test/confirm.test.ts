/**
 * Cast confirmation — the pure half. The dialogs themselves were measured in a
 * live session (see `src/confirm.ts` for what that cost), so these tests cover
 * what the dialogs hand back: which presets exist, what each one keeps, and what
 * happens to a seat whose dependency was removed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { castPresets, filterToSeats, seatRows } from "../src/confirm.ts";
import { synthesizePlan } from "../src/synthesize.ts";
import { grantsWrite, isCouncilMember, planWaves } from "../src/core.ts";
import { runRoleFleet } from "../src/pipeline.ts";

function planFor(task: string, extra: Record<string, unknown> = {}) {
  // No default council: a cast is a function of the request, and a fixture that
  // silently carried a council of three would make every assertion a lie.
  return synthesizePlan({ task, cwd: "/tmp", workDir: "/tmp/w", ...extra });
}

const councilOf = (extra: Record<string, unknown> = {}) => planFor("review the auth module", { council: 3, ...extra });

test("the proposed cast is the recommended preset", () => {
  const plan = councilOf();
  const presets = castPresets(plan);
  assert.equal(presets[0]!.id, "as-planned");
  assert.deepEqual(presets[0]!.seats, plan.roles.map((r) => r.id));
  // The roster lives in the preview, one seat per line: the dialog folds line
  // breaks in a description away, so a description can never carry it.
  const lines = presets[0]!.preview.split("\n");
  assert.equal(lines.length, plan.roles.length, `one line per seat: ${JSON.stringify(lines)}`);
  assert.ok(!presets[0]!.preview.includes("reviewer-c1"), `internal ids leaked: ${presets[0]!.preview}`);
  assert.match(lines[0]!, /Investigator — maps where the task touches/);
  assert.match(lines[1]!, /Reviewer 1 — reviews the change/);
  assert.match(lines[1]!, /@slow/, lines[1]!);
  // The description says what the choice is, not who it runs.
  assert.match(presets[0]!.description, /exactly as planned/);
});

test("a preset is offered only when it changes something", () => {
  // No build verb in this text, so the cast is review-only: dropping the
  // writers would change nothing and the preset must not appear as a no-op.
  const review = councilOf();
  const reviewIds = new Set(castPresets(review).map((p) => p.id));
  assert.ok(!reviewIds.has("analysis-only"), "nothing writes in a review, so the preset would be a no-op");
  assert.ok(reviewIds.has("single-reviewer"), "a council of three can be trimmed to one");

  const build = planFor("fix the auth bug");
  const buildIds = new Set(castPresets(build).map((p) => p.id));
  assert.ok(buildIds.has("analysis-only"), "a build can be run as review-only");
  assert.ok(!buildIds.has("single-reviewer"), "one reviewer is already the shape");
});

test("the council preset keeps the first member and drops the rest", () => {
  const plan = councilOf();
  const preset = castPresets(plan).find((p) => p.id === "single-reviewer")!;
  const kept = new Set(preset.seats);
  assert.ok(kept.has("reviewer-c1"), "the first member stands in for the council");
  assert.ok(!kept.has("reviewer-c2"));
  assert.ok(!kept.has("reviewer-c3"));
  // The seats outside the council are untouched.
  assert.ok(kept.has("scout"));
  assert.match(preset.description, /one opinion instead of three/i);
  // And the preview names the reviewer that stayed.
  assert.match(preset.preview, /Reviewer 1 — reviews the change/);
  assert.ok(!preset.preview.includes("Reviewer 2"), `a dropped member still listed: ${preset.preview}`);
});

test("the single-reviewer preset counts the council in front of it", () => {
  // A named list seats two to five members, so the copy has to count the review
  // the user is looking at instead of asserting the default three: a two-model
  // council was offered "One reviewer instead of three".
  const two = planFor("review the auth module", { council: 2 });
  assert.equal(two.roles.filter((r) => isCouncilMember(r.id)).length, 2, "fixture must seat a council of two");
  const preset = castPresets(two).find((p) => p.id === "single-reviewer")!;
  assert.match(preset.label, /instead of two/);
  assert.match(preset.description, /one opinion instead of two/i);
});

test("a catalog seat is described by its own purpose, not its core's", () => {
  // `migration-runner` executes the implementer seat under its own id, and the
  // purpose lookup fell through id → core, so the checklist and the roster told
  // the user the migration seat "implements the plan with the smallest correct
  // change" — the implementer's sentence, on the one screen whose job is to say
  // what each seat does.
  const plan = planFor("migrate the api client to the new sdk and fix the tests");
  const rows = seatRows(plan, planWaves(plan.roles));
  const runner = rows.find((r) => r.id === "migration-runner")!;
  assert.match(runner.description, /migration/);
  assert.ok(!/smallest correct change/.test(runner.description), runner.description);
  assert.match(
    castPresets(plan).find((p) => p.id === "as-planned")!.preview,
    /Migration runner — runs a dependency or framework migration/,
  );
});

test("every seat row names its model and whether it writes", () => {
  const plan = planFor("fix the auth bug and review it");
  const rows = seatRows(plan, planWaves(plan.roles));
  assert.equal(rows.length, plan.roles.length);
  // Rows are labelled for a person, with the id kept off the label so it cannot
  // be mistaken for something they are choosing.
  const implementer = rows.find((r) => r.id === "implementer")!;
  assert.equal(implementer.label, "Implementer");
  // The row ends in the same authority phrase the roster line prints, and the
  // implementer's grant is the shell one now: a reader has to be able to see
  // that this seat can run commands, not only that it can edit.
  assert.match(implementer.description, /can change the code and run commands/);
  assert.match(implementer.preview, /wave \d/);
  assert.match(implementer.preview, /@task/, implementer.preview);
  assert.ok(implementer.description.length > 0, "a row must say what the seat does");

  const reviewer = rows.find((r) => r.id === "reviewer")!;
  assert.equal(reviewer.label, "Reviewer");
  assert.match(reviewer.description, /read-only/);
  assert.match(reviewer.preview, /@slow/);
});

test("an unresolved model says so instead of printing the alias as a provider", () => {
  // `@slow` is not a provider. A seat whose alias the host could not resolve
  // still runs — on whatever the session falls back to — and the row has to say
  // that rather than let a reader believe `@slow` is who answers.
  const plan = planFor("fix the auth bug and review it");
  const rows = seatRows(plan, planWaves(plan.roles));
  assert.match(rows.find((r) => r.id === "reviewer")!.preview, /@slow — unresolved/);
});

test("a seat whose dependency left is dropped with it", () => {
  // Unchecking an implementer cannot leave a tester waiting on a seat that is
  // no longer in the plan: the gate refuses a dangling edge for the whole plan,
  // so the dependent goes instead.
  const plan = planFor("fix the auth bug and review it");
  const roles = plan.roles;
  const tester = roles.find((r) => r.id === "tester");
  const reviewer = roles.find((r) => r.id === "reviewer");
  assert.ok(tester, "the fixture must have a tester");
  assert.ok((tester!.dependsOn ?? []).includes("implementer"), "precondition: the tester depends on it");

  const kept = filterToSeats(roles, new Set(roles.map((r) => r.id).filter((id) => id !== "implementer")));
  assert.ok(!kept.some((r) => r.id === "implementer"));
  assert.ok(!kept.some((r) => r.id === "tester"), "the tester goes with its implementer");
  // The reviewer waited on the implementer too, so it goes as well — dropping a
  // dependency does not silently re-point its dependents at something else.
  if (reviewer && (reviewer.dependsOn ?? []).includes("implementer")) {
    assert.ok(!kept.some((r) => r.id === "reviewer"), "the reviewer waited on the implementer as well");
  }
  assert.ok(kept.some((r) => r.id === "scout"));
});

test("declining confirmation dispatches nothing at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-confirm-"));
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    confirm: async () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.agents.length, 0);
  assert.equal(result.groups.length, 0);
  assert.match(result.verdict.reason, /abandoned/);
});

test("a confirmed cast is what gets emitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-confirm-yes-"));
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    // Keep the scout and drop the implementation chain: in a build the tester
    // and reviewer wait on the implementer, so only the scout survives.
    confirm: async (plan) => new Set(plan.roles.filter((r) => r.id === "scout").map((r) => r.id)),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.agents.map((a) => a.role), ["scout"]);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("confirmed cast")),
    `the confirmation must be recorded: ${result.plan!.notes.join(" | ")}`,
  );
  assert.ok(
    result.plan!.notes.some((n) => n.includes("dropped implementer")),
    `what left must be named: ${result.plan!.notes.join(" | ")}`,
  );
});

test("a host without a confirmation hook runs straight through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-noconfirm-"));
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir });
  assert.equal(result.ok, true);
  assert.ok(result.agents.length > 0, "the non-interactive path must not wait for a dialog that cannot appear");
  assert.ok(!result.plan!.notes.some((n) => n.includes("confirmed cast")));
});
test("the confirmation screen sees resolved models, not bare aliases", async () => {
  // The ordering bug this pins: the dialog used to be asked *before* aliases
  // were resolved, so every row read "@slow — unresolved" — the screen whose
  // whole job is answering "which provider" was the one place it could not.
  const dir = await mkdtemp(join(tmpdir(), "rf-order-"));
  let seenByTheDialog: Array<string | undefined> = [];
  const result = await runRoleFleet({
    task: "review the auth module",
    cwd: dir,
    council: 3,
    resolveModel: (spec) => (spec === "@smol" ? "xai-oauth/grok-4.5" : undefined),
    confirm: async (plan) => {
      seenByTheDialog = plan.roles.map((r) => r.modelResolved);
      return new Set(plan.roles.map((r) => r.id));
    },
  });
  assert.equal(result.ok, true);
  assert.ok(seenByTheDialog.includes("xai-oauth/grok-4.5"), `the dialog saw: ${JSON.stringify(seenByTheDialog)}`);
  // The seats whose alias did not resolve keep no value at all, so the screen
  // prints "@task — unresolved" rather than inventing a provider.
  assert.ok(!seenByTheDialog.some((m) => m === "@task"), `an alias leaked through: ${JSON.stringify(seenByTheDialog)}`);
  const scout = result.plan!.roles.find((r) => r.id === "scout")!;
  assert.equal(scout.modelResolved, "xai-oauth/grok-4.5");
});

test("the review-only preset keeps only seats that can still run", async () => {
  // Authority is three tiers, and this preset has to reason about all of them. A
  // council member used to gain `write` when a
  // consul was appointed, so its report could reach the filesystem; that grant is
  // gone, because the orchestrator places every read-only seat's report at its
  // artifact path before the next wave. So there is nothing about a council
  // member this preset has to drop — it is read-only like the scout — and the
  // copies below have to say so rather than describing a tier no seat holds.
  //
  // The other half is the dependency rule, and it cuts deeper than it looks: on a
  // *build* plan the reviewer waits on the implementer, so dropping the
  // implementer takes the reviewer with it — and the preset must say so instead
  // of promising a review nobody performs.
  //
  // Through the pipeline: a named model list becomes a council there, which is
  // how a run gets council members to read a roster line for.
  const buildPlan = (
    await runRoleFleet({
      task: "refactor the auth module",
      cwd: await mkdtemp(join(tmpdir(), "rf-readonly-")),
      dryRun: true,
      models: ["xai/grok-4", "zai/glm-5"],
      consul: "anthropic/claude-opus-4-6",
    })
  ).plan!;

  const build = castPresets(buildPlan).find((p) => p.id === "analysis-only");
  assert.ok(build, `a build plan must offer the review-only choice: ${castPresets(buildPlan).map((p) => p.id).join(",")}`);
  assert.ok(!build!.seats.includes("implementer"), `the implementer stayed: ${build!.seats.join(",")}`);
  // The reviewer goes with its implementer, and the choice says so by name
  // instead of quietly listing a seat that will not run.
  const buildReviewer = buildPlan.roles.find((r) => r.id === "reviewer-c1");
  if (buildReviewer && (buildReviewer.dependsOn ?? []).some((d) => build!.seats.length && d === "implementer")) {
    assert.ok(!build!.seats.includes("reviewer-c1"), `a dependent seat was promised: ${build!.seats.join(",")}`);
    assert.match(build!.description, /goes too|go too/, build!.description);
  }
  // Every seat it kept can be depended on by every other kept seat: this is
  // exactly what `filterToSeats` enforces, and a preset that breaks it would
  // emit a plan the gate refuses.
  const kept = buildPlan.roles.filter((r) => build!.seats.includes(r.id));
  assert.ok(
    kept.every((r) => (r.dependsOn ?? []).every((d) => build!.seats.includes(d))),
    "a promised seat is waiting on one the choice removed",
  );
  assert.ok(kept.every((r) => !grantsWrite(r.tools)), "a kept seat can still change the code");

  // On a plan that writes nothing there is no "look, don't touch" choice to
  // offer: every seat already qualifies, and a preset that changes nothing is
  // noise. What matters there is that the reviewers and the consul are present.
  const reviewPlan = (
    await runRoleFleet({
      task: "review the auth module",
      cwd: await mkdtemp(join(tmpdir(), "rf-readonly2-")),
      dryRun: true,
      models: ["xai/grok-4", "zai/glm-5"],
      consul: "anthropic/claude-opus-4-6",
    })
  ).plan!;
  const reviewPresets = castPresets(reviewPlan);
  assert.ok(
    !reviewPresets.some((p) => p.id === "analysis-only"),
    "a plan with nothing to drop must not offer the review-only choice",
  );
  const asPlanned = reviewPresets.find((p) => p.id === "as-planned")!;
  assert.ok(asPlanned.seats.includes("reviewer-c1"), `reviewers missing: ${asPlanned.seats.join(",")}`);
  assert.ok(asPlanned.seats.includes("consul"), `consul missing: ${asPlanned.seats.join(",")}`);

  // Authority is three tiers, and every surface that describes it says so. The
  // council's repo-wide grant is gone — the orchestrator places its report at
  // `review-cN.md` / `consul.md` itself — so a council member is read-only like
  // the scout. The roster preview is the first thing the user reads; the picker
  // row is the last. Both assertions are anchored at the end of the string: a row
  // that grew a third tier, or fell back to the seat brief's convention ("Writes
  // only its own report."), fails here rather than shipping.
  const rows = seatRows(reviewPlan, planWaves(reviewPlan.roles));
  const reviewerRow = rows.find((r) => r.id === "reviewer-c1")!;
  assert.match(reviewerRow.description, /read-only\.$/, reviewerRow.description);
  const scoutRow = rows.find((r) => r.id === "scout")!;
  assert.match(scoutRow.description, /read-only\.$/, scoutRow.description);
  // The other tiers on the picker row, from casts that have them: an editor that
  // cannot run commands, and the shell grant that is wider than either.
  const implementerRow = seatRows(buildPlan, planWaves(buildPlan.roles)).find((r) => r.id === "implementer")!;
  assert.match(implementerRow.description, /can change the code and run commands\.$/, implementerRow.description);
  const editorPlan = planFor("update the readme");
  const docsRow = seatRows(editorPlan, planWaves(editorPlan.roles)).find((r) => r.id === "docs-updater")!;
  assert.match(docsRow.description, /can change the code\.$/, docsRow.description);

  // The roster line itself is `<title> — <purpose> (<model>) — <authority>`, and
  // a council member's line ends in the same tier as everyone else's here. The
  // writer phrases are collected once, because the roster and the picker are two
  // surfaces printing one decision.
  const writerLine = /— can change the code(?: and run commands)?$/;
  const reviewerLine = asPlanned.preview.split("\n").find((l) => l.startsWith("Reviewer 1"))!;
  assert.match(reviewerLine, /^Reviewer 1 — .+ \(xai\/grok-4\) — read-only$/, reviewerLine);
  for (const line of asPlanned.preview.split("\n")) {
    assert.match(line, /— (read-only|can change the code|can change the code and run commands)$/, `no authority on a roster line: ${line}`);
  }
  // A reader counting the writers off this cast gets zero — the review cast has
  // no seat that can change anything, and the consult question prints that as
  // `no seat can change the code`, which the preset copy agrees with.
  assert.equal(
    asPlanned.preview.split("\n").filter((l) => writerLine.test(l)).length,
    0,
    asPlanned.preview,
  );
  assert.match(build!.description, /no seat can change the code/, build!.description);

  // A cast that does have such a seat still discloses it, by name, on the roster:
  // the implementer is the only line that can, so the count a reader gets off the
  // first screen is one and the screen says which seat it is — shell included,
  // since that is the wider half of its grant.
  const buildAsPlanned = castPresets(buildPlan).find((p) => p.id === "as-planned")!;
  const writers = buildAsPlanned.preview.split("\n").filter((l) => writerLine.test(l));
  assert.equal(writers.length, 1, buildAsPlanned.preview);
  assert.match(writers[0]!, /^Implementer — /, writers[0]!);
  assert.match(writers[0]!, /and run commands$/, writers[0]!);
});


test("a catalog seat shows its purpose, not its core name", () => {
  // `security-auditor` carries `core: "security"`, which is not a key in
  // SEAT_PURPOSE — the purpose is keyed by seat id. Keying the lookup on the
  // core alone printed the raw string `security` to the user, and every other
  // fixture here has `id === core`, so only this one reaches the broken path.
  const plan = planFor("audit the api for injection and csrf");
  const preview = castPresets(plan)[0]!.preview;
  const line = preview.split("\n").find((l) => l.startsWith("Security auditor"));
  assert.ok(line, `the security seat never reached the roster: ${preview}`);
  assert.match(line!, /audits the surface for vulnerabilities/);
  assert.ok(!line!.includes("— security —"), `the core name leaked as the purpose: ${line}`);
});

test("a dry run never asks", async () => {
  // `--dry-run` means "show me the cast without spending anything". A dialog
  // there contradicts the flag, and on the tool surface it parks a model's
  // planning call on a human. Declining also used to surface as an error, which
  // made the one thing the user asked for look like a failure.
  let asked = 0;
  const dir = await mkdtemp(join(tmpdir(), "rf-dryconf-"));
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    dryRun: true,
    confirm: async () => {
      asked++;
      return null;
    },
  });
  assert.equal(asked, 0, "a dry run must not open a confirmation");
  assert.equal(result.ok, true);
  assert.ok(result.plan!.roles.length > 0, "and it must still return the plan");
});

test("a confirmation that is asked still blocks a real run", async () => {
  // The other side of the same seam: skipping the dialog under `--dry-run` must
  // not have quietly skipped it everywhere.
  let asked = 0;
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: await mkdtemp(join(tmpdir(), "rf-realconf-")),
    confirm: async () => {
      asked++;
      return null;
    },
  });
  assert.equal(asked, 1);
  assert.equal(result.ok, false);
  assert.equal(result.agents.length, 0);
});

test("--yes accepts the recommended cast without a dialog", async () => {
  // An agent (or a scripted /role-fleet --yes) must not hang on a menu nobody
  // answers. The confirmer returns every planned seat — same as "Run all of them".
  let asked = 0;
  const dir = await mkdtemp(join(tmpdir(), "rf-yes-"));
  // Simulate what makeConfirmer does under autoAccept: return all seat ids.
  const result = await runRoleFleet({
    task: "fix the auth bug",
    cwd: dir,
    confirm: async (plan) => {
      asked++;
      return new Set(plan.roles.map((r) => r.id));
    },
  });
  assert.equal(asked, 1);
  assert.equal(result.ok, true);
  assert.ok(result.agents.length > 0);
  assert.ok(
    result.plan!.notes.some((n) => n.includes("confirmed cast") && n.includes("all seats kept")),
    `auto-accept must record a full cast: ${result.plan!.notes.join(" | ")}`,
  );
});
