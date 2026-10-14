/**
 * Advisor observation — the one advisor surface extensions can see. These tests
 * pin the identity check, the `advise` payload parsing, and the severity
 * handling, without any shared module state between cases.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAdvisorAgent,
  isAdvisorySeverity,
  readAdvise,
  renderNotes,
  worstSeverity,
  type AdvisorNote,
} from "../src/advisor-watch.ts";

test("advisor tool calls are identified by the documented agent identity", () => {
  assert.equal(isAdvisorAgent({ kind: "sub", id: "advisor", name: "advisor", depth: 0 } as never), true);
  assert.equal(isAdvisorAgent({ kind: "sub", id: "child", name: "scout" } as never), false);
  assert.equal(isAdvisorAgent(undefined), false);
});

test("advise arguments parse into a note with a severity", () => {
  assert.deepEqual(readAdvise({ note: "check the fallback chain", severity: "concern" }), {
    note: "check the fallback chain",
    severity: "concern",
  });
  // A missing severity is a nit, matching the advisor's own default.
  assert.deepEqual(readAdvise({ note: "tidy up" }), { note: "tidy up", severity: "nit" });
  assert.equal(readAdvise({ severity: "blocker" }), null);
  assert.equal(readAdvise("not an object"), null);
});

test("severity values are validated strictly", () => {
  for (const v of ["nit", "concern", "blocker"]) assert.equal(isAdvisorySeverity(v), true);
  for (const v of ["warning", "BLOCKER", 1, null]) assert.equal(isAdvisorySeverity(v), false);
});

test("the worst severity wins and empty history reports none", () => {
  const notes: AdvisorNote[] = [
    { severity: "nit", note: "a", advisor: "advisor", at: 1 },
    { severity: "blocker", note: "b", advisor: "advisor", at: 2 },
    { severity: "concern", note: "c", advisor: "advisor", at: 3 },
  ];
  assert.equal(worstSeverity(notes), "blocker");
  assert.equal(worstSeverity([]), null);
  assert.match(renderNotes(notes.reverse()), /\[blocker\] advisor: b/);
  assert.match(renderNotes([]), /No advisor notes/);
});