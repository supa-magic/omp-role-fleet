/**
 * Model observation — the host's settled `task` result is the only trustworthy
 * answer to "which model actually ran". These tests pin the narrowing (task
 * details only, this plugin's seats only), the fallback/mismatch rule, and the
 * thinking-level suffix that is not part of the model id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeSettledRuns,
  readTaskResults,
  recordExpectedModels,
  renderObservation,
  resetExpectedModels,
} from "../src/model-observed.ts";

/** One settled fleet result, as the host's `TaskToolDetails.results[]` carries it. */
function settled(over: Record<string, unknown>) {
  return { index: 0, id: "job-1", agent: "rf-reviewer-c1", exitCode: 0, output: "", ...over };
}

test("a payload that is not a task result yields no runs", () => {
  // Every other tool's `details` arrives on the same event; mistaking one for a
  // fleet result would report models for a bash call.
  assert.deepEqual(readTaskResults(undefined), []);
  assert.deepEqual(readTaskResults({ exitCode: 0 }), []);
  assert.deepEqual(readTaskResults({ results: "nope" }), []);
  assert.deepEqual(observeSettledRuns({ stderr: "hi" }), []);
});

test("a settled seat running its planned model is not news", () => {
  resetExpectedModels();
  recordExpectedModels([
    { agent: "rf-reviewer-c1", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" },
    { agent: "rf-reviewer-c2", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" },
    { agent: "rf-reviewer-c3", model: "@slow", modelResolved: "zai/glm-5" },
  ]);

  assert.deepEqual(observeSettledRuns({ results: [settled({ resolvedModel: "anthropic/claude-opus-4-6" })] }), []);
  // A thinking level is a suffix on the same model, not a different one.
  // The seat must be a fresh one: `observeSettledRuns` records every settled
  // `rf-` agent it sees, so replaying the seat above would return [] from the
  // dedupe entry rather than from the suffix comparison — the assertion would
  // pass with `baseModel` returning its input untouched, which is the opposite
  // of what it claims to pin.
  assert.deepEqual(
    observeSettledRuns({ results: [settled({ agent: "rf-reviewer-c2", resolvedModel: "anthropic/claude-opus-4-6:high" })] }),
    [],
  );
  // And the same seat genuinely diverging is news, so the empty result above is
  // the suffix rule and not a seat that can never report.
  assert.equal(
    observeSettledRuns({ results: [settled({ agent: "rf-reviewer-c3", resolvedModel: "anthropic/claude-opus-4-6:high" })] }).length,
    1,
  );
});

test("a fallback reports the model that ran and the one the plan expected", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" }]);

  const observed = observeSettledRuns({
    results: [settled({ resolvedModel: "xai/grok-4:max", resolvedModelIsFallback: true })],
  });
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], {
    agent: "rf-reviewer-c1",
    ran: "xai/grok-4",
    planned: "anthropic/claude-opus-4-6",
    fallback: true,
  });
  // The whole point: "expected X, ran Y" is stated, not inferred from the brief.
  assert.match(renderObservation(observed[0]!), /planned `anthropic\/claude-opus-4-6`, ran `xai\/grok-4`/);
  assert.match(renderObservation(observed[0]!), /FALLBACK/);
});

test("a run that diverges from the plan without a fallback flag still reports", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-implementer", model: "@task", modelResolved: "zai/glm-5" }]);

  const observed = observeSettledRuns({ results: [settled({ agent: "rf-implementer", resolvedModel: "minimax/m2" })] });
  assert.equal(observed[0]?.fallback, false);
  assert.equal(observed[0]?.ran, "minimax/m2");
  assert.match(renderObservation(observed[0]!), /model changed/);
});

test("an unresolved plan still reports a host-flagged fallback", () => {
  resetExpectedModels();
  // `@designer` with no `modelRoles.designer` entry resolves to nothing at plan
  // time. Silence here is exactly the hole: the user would have no way to learn
  // the seat ran on some other model entirely.
  const observed = observeSettledRuns({
    results: [settled({ agent: "rf-designer", resolvedModel: "anthropic/claude-sonnet-4-6", resolvedModelIsFallback: true })],
  });
  assert.equal(observed[0]?.planned, undefined);
  assert.match(renderObservation(observed[0]!), /ran `anthropic\/claude-sonnet-4-6` \(no plan-time baseline for this seat\)/);
});

test("another agent's fallback is not this run's business", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-scout", model: "@smol", modelResolved: "xai/grok-4" }]);

  assert.deepEqual(
    observeSettledRuns({ results: [settled({ agent: "scout", resolvedModel: "zai/glm-5", resolvedModelIsFallback: true })] }),
    [],
  );
});

test("a seat pinned to a concrete model reports a divergence instead of passing in silence", () => {
  resetExpectedModels();
  // `--models xai/grok-4` pins a selector and never records `modelResolved`
  // (the plan notes a resolution only when it differs from the pin). Reading
  // `resolved` alone left every seat this release added with no baseline, so a
  // pinned reviewer that ran elsewhere looked like a clean run.
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "xai/grok-4" }]);

  const observed = observeSettledRuns({ results: [settled({ resolvedModel: "zai/glm-5" })] });
  assert.equal(observed.length, 1, "a pinned seat must not diverge unnoticed");
  assert.equal(observed[0]?.planned, "xai/grok-4");
  assert.equal(observed[0]?.fallback, false);
  assert.match(renderObservation(observed[0]!), /planned `xai\/grok-4`, ran `zai\/glm-5`, model changed/);

  // Running its own pin, with or without a thinking level, stays quiet.
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "xai/grok-4" }]);
  assert.deepEqual(observeSettledRuns({ results: [settled({ resolvedModel: "xai/grok-4:high" })] }), []);
});

test("an unresolved alias is not a baseline, so a plain run stays quiet", () => {
  resetExpectedModels();
  // `@designer` with no `modelRoles.designer` entry resolves to nothing, and an
  // alias is never a `provider/id`. Comparing a concrete run against it would
  // report "model changed" on every ordinary dispatch of that seat — a
  // false-positive flood that would train the user to ignore the warning.
  recordExpectedModels([{ agent: "rf-designer", model: "@designer" }]);

  assert.deepEqual(
    observeSettledRuns({ results: [settled({ agent: "rf-designer", resolvedModel: "xai/grok-4" })] }),
    [],
  );

  // A host-flagged fallback is still news with no usable baseline: that is the
  // host's own statement, not an inference from the alias.
  const observed = observeSettledRuns({
    results: [settled({ agent: "rf-designer", resolvedModel: "xai/grok-4", resolvedModelIsFallback: true })],
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.planned, undefined);
  assert.match(renderObservation(observed[0]!), /no plan-time baseline for this seat/);
});

test("the host's routing note is carried into the line when it gives one", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-scout", model: "@smol", modelResolved: "minimax-code/m3" }]);

  const observed = observeSettledRuns({
    results: [
      settled({
        agent: "rf-scout",
        resolvedModel: "xai/grok-4",
        resolvedModelIsFallback: true,
        resolvedModelRoute: "model-pools: minimax primary unavailable",
      }),
    ],
  });
  assert.match(renderObservation(observed[0]!), /via model-pools: minimax primary unavailable/);
});

test("a re-delivered result is reported once", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" }]);
  const details = { results: [settled({ resolvedModel: "xai/grok-4", resolvedModelIsFallback: true })] };

  assert.equal(observeSettledRuns(details).length, 1);
  // The task envelope re-renders on follow-up turns; a second notification for
  // the same settled seat would train the user to ignore the one that matters.
  assert.deepEqual(observeSettledRuns(details), []);
});

test("a quiet settle does not mute a later rescue on a different model", () => {
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" }]);

  // First settle: the planned model, nothing to say.
  assert.deepEqual(observeSettledRuns({ results: [settled({ resolvedModel: "anthropic/claude-opus-4-6" })] }), []);

  // The seat stalls and the main model re-dispatches it; the retry lands on a
  // fallback. Marking a seat as seen on *sight* would swallow this — the one
  // line the user asked to be told about.
  const rescued = observeSettledRuns({
    results: [settled({ resolvedModel: "xai/grok-4", resolvedModelIsFallback: true })],
  });
  assert.equal(rescued.length, 1, "a second, genuinely different settle must report");
  assert.equal(rescued[0]?.fallback, true);

  // And that one is itself reported once, not on every re-render.
  assert.deepEqual(
    observeSettledRuns({ results: [settled({ resolvedModel: "xai/grok-4", resolvedModelIsFallback: true })] }),
    [],
  );
});

test("a second run in the same session is reported, not swallowed by the first", () => {
  resetExpectedModels();
  const details = { results: [settled({ resolvedModel: "xai/grok-4", resolvedModelIsFallback: true })] };

  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "@slow", modelResolved: "anthropic/claude-opus-4-6" }]);
  assert.equal(observeSettledRuns(details).length, 1);

  // Agent names are reused across runs, so the dedupe entry from the first run
  // must not silence the second — that would make the fallback warning work
  // exactly once per session.
  recordExpectedModels([{ agent: "rf-reviewer-c1", model: "@slow", modelResolved: "zai/glm-5" }]);
  const second = observeSettledRuns(details);
  assert.equal(second.length, 1, "the second run's fallback must still be reported");
  assert.equal(second[0]?.planned, "zai/glm-5");
});

test("a new session does not inherit the previous run's expectations", () => {
  recordExpectedModels([{ agent: "rf-scout", model: "@smol", modelResolved: "xai/grok-4" }]);
  resetExpectedModels();
  recordExpectedModels([{ agent: "rf-scout", model: "@smol", modelResolved: "zai/glm-5" }]);

  const observed = observeSettledRuns({ results: [settled({ agent: "rf-scout", resolvedModel: "minimax/m2" })] });
  assert.equal(observed[0]?.planned, "zai/glm-5", "the stale baseline must not resurface");
});