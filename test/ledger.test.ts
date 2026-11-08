/**
 * The post-dispatch ledger, driven the way the host drives it: one seat's
 * `yield` settling in that seat's own session.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { settleSeat } from "../src/ledger.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderRunList, renderRunReport, renderRunStatus } from "../src/report.ts";
import { forgetSeats, seatRecord } from "../src/seats.ts";

const yielded = (report: string, verdict = "pass") => ({ data: { summary: "headline", report, verdict }, status: "success" });

async function emittedRun(task: string) {
  const dir = await mkdtemp(join(tmpdir(), "rf-ledger-"));
  const run = await runRoleFleet({ task, cwd: dir });
  assert.equal(run.ok, true);
  const manifestPath = join(dir, ".role-fleet", run.plan!.runId!, "plan.json");
  const outcomes = async () =>
    (JSON.parse(await readFile(manifestPath, "utf8")) as { outcomes: Array<Record<string, unknown>> }).outcomes;
  return { dir, run, outcomes };
}

test("a read-only seat's yield places its full report and appends its outcome", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  assert.deepEqual(await outcomes(), [], "the pre-dispatch manifest records intent only");
  const scout = run.agents.find((a) => a.role === "scout")!;

  const record = (await seatRecord(scout.agent, dir))!;
  const settled = await settleSeat({
    record,
    details: yielded("FULL SCOUT REPORT"),
    ran: "mock/scout:high",
    durationMs: 1500,
  });
  assert.equal(settled.written, scout.artifact);
  assert.equal((await readFile(scout.artifact, "utf8")).trim(), "FULL SCOUT REPORT");
  const [outcome] = await outcomes();
  assert.equal(outcome!.agent, scout.agent);
  assert.equal(outcome!.ran, "mock/scout", "the thinking suffix is not part of the model id");
  assert.equal(outcome!.verdict, "pass");
  assert.equal(outcome!.fallback, false);
  assert.equal(outcome!.durationMs, 1500);
  // An unresolved alias is no baseline: a plain run is not "model changed".
  assert.equal(settled.observation, undefined);

  // A seat that yields again (revived, re-prompted) is a second real outcome.
  await settleSeat({ record, details: yielded("REVISED SCOUT REPORT", "fail"), ran: "mock/scout" });
  assert.deepEqual((await outcomes()).map((o) => o.verdict), ["pass", "fail"]);
  assert.equal((await readFile(scout.artifact, "utf8")).trim(), "REVISED SCOUT REPORT");

  // An incremental section is not the seat's result and records nothing.
  await settleSeat({ record, details: { data: "partial", status: "success", type: ["report"] } });
  assert.equal((await outcomes()).length, 2);

  const report = await renderRunReport(dir);
  assert.match(report, /Outcomes \(1\/\d+ settled\)/, "two outcomes of one seat are one settled seat");
  assert.match(report, /verdict pass/);
  assert.match(await renderRunList(dir), new RegExp(`${run.plan!.runId!}.*1/\\d+ settled`));
});

test("an aborted yield places nothing and is recorded as a failure", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  const settled = await settleSeat({
    record: (await seatRecord(scout.agent, dir))!,
    details: { data: undefined, status: "aborted", error: "provider down" },
  });
  assert.equal(settled.written, undefined);
  await assert.rejects(access(scout.artifact), "a failure transcript must not pose as the upstream report");
  const [outcome] = await outcomes();
  assert.equal(outcome!.aborted, true);
  assert.equal(outcome!.error, "provider down");
  assert.match(await renderRunStatus(dir), new RegExp(`Failed: ${scout.agent}`));
});

test("a writer seat writes its own report; the ledger does not overwrite it", async () => {
  const { dir, run } = await emittedRun("fix the login bug");
  const implementer = run.agents.find((a) => a.role === "implementer")!;
  assert.equal(implementer.writesOwnReport, true);
  const settled = await settleSeat({ record: (await seatRecord(implementer.agent, dir))!, details: yielded("IMPL") });
  assert.equal(settled.written, undefined);
  await assert.rejects(access(implementer.artifact));
});

test("seats of one wave settling together keep every outcome", async () => {
  const { dir, run, outcomes } = await emittedRun("refactor the adapter and review it --council");
  const readOnly = run.agents.filter((a) => !a.writesOwnReport);
  assert.ok(readOnly.length >= 2);
  await Promise.all(
    readOnly.map(async (a) => settleSeat({ record: (await seatRecord(a.agent, dir))!, details: yielded(`REPORT ${a.agent}`) })),
  );
  assert.deepEqual(
    (await outcomes()).map((o) => o.agent).sort(),
    readOnly.map((a) => a.agent).sort(),
  );
});

test("a fallback in the seat's session is recorded and announced against the plan", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  const settled = await settleSeat({
    record: (await seatRecord(scout.agent, dir))!,
    details: yielded("R"),
    ran: "xai/grok-4",
    fallbackFrom: "anthropic/claude-haiku-4-5",
  });
  assert.equal(settled.observation?.fallback, true);
  assert.equal(settled.observation?.ran, "xai/grok-4");
  const [outcome] = await outcomes();
  assert.equal(outcome!.fallback, true);
  assert.match(String(outcome!.route), /anthropic\/claude-haiku-4-5/);
});

test("a seat from a run this process did not emit is rebuilt from disk", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  forgetSeats();
  const record = await seatRecord(scout.agent, dir);
  assert.equal(record?.artifact, scout.artifact);
  assert.deepEqual(record?.tools, scout.tools);
  await settleSeat({ record: record!, details: yielded("AFTER RESTART") });
  assert.equal((await readFile(scout.artifact, "utf8")).trim(), "AFTER RESTART");
  assert.equal((await outcomes()).length, 1);
});

test("an agent the plugin did not generate has no seat record", async () => {
  const { dir } = await emittedRun("audit the deps");
  assert.equal(await seatRecord("my-reviewer", dir), undefined);
  forgetSeats();
  await rm(join(dir, ".role-fleet"), { recursive: true });
  // The agent file survives but its run manifest is gone: nothing to settle against.
  assert.equal(await seatRecord("rf-scout", dir), undefined);
});
