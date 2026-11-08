/**
 * Which model actually ran a seat, compared against the plan-time pin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observeSeat, plannedModel, renderObservation } from "../src/model-observed.ts";

test("the baseline is the resolution, else a concrete pin, never an alias", () => {
  assert.equal(plannedModel({ pinned: "@slow", resolved: "anthropic/claude-opus-4-6:high" }), "anthropic/claude-opus-4-6");
  // `--models`/`--consul`/allowlist pins carry no separate resolution.
  assert.equal(plannedModel({ pinned: "xai/grok-4" }), "xai/grok-4");
  // `@designer` with no modelRoles entry is not a model.
  assert.equal(plannedModel({ pinned: "@designer" }), undefined);
});

test("a seat running its planned model is not news, thinking suffix or not", () => {
  assert.equal(observeSeat({ agent: "rf-c1", ran: "anthropic/claude-opus-4-6:high", planned: "anthropic/claude-opus-4-6" }), undefined);
});

test("a divergence without a fallback still reports, as a model change", () => {
  const o = observeSeat({ agent: "rf-reviewer-c1", ran: "zai/glm-5", planned: "xai/grok-4" })!;
  assert.equal(o.fallback, false);
  assert.match(renderObservation(o), /planned `xai\/grok-4`, ran `zai\/glm-5`, model changed/);
});

test("an unresolved alias stays quiet on a plain run but reports a fallback", () => {
  assert.equal(observeSeat({ agent: "rf-designer", ran: "xai/grok-4", planned: undefined }), undefined);
  const o = observeSeat({ agent: "rf-designer", ran: "xai/grok-4", planned: undefined, fallbackFrom: "anthropic/claude-sonnet-4-6" })!;
  assert.equal(o.fallback, true);
  assert.match(renderObservation(o), /ran `xai\/grok-4` \(no plan-time baseline for this seat\), FALLBACK, from `anthropic\/claude-sonnet-4-6`/);
});

test("a fallback names the plan and what ran", () => {
  const o = observeSeat({
    agent: "rf-reviewer-c1",
    ran: "xai/grok-4:max",
    planned: "anthropic/claude-opus-4-6",
    fallbackFrom: "anthropic/claude-opus-4-6",
  })!;
  // The source equals the plan, so it is not repeated.
  assert.equal(renderObservation(o), "role-fleet: rf-reviewer-c1 — planned `anthropic/claude-opus-4-6`, ran `xai/grok-4`, FALLBACK");
});

test("no live model means nothing to compare", () => {
  assert.equal(observeSeat({ agent: "rf-scout", ran: undefined, planned: "xai/grok-4", fallbackFrom: "x/y" }), undefined);
});
