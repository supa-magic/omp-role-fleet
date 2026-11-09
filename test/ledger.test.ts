/**
 * The post-dispatch ledger, driven the way the host drives it: one seat's
 * `yield` settling in that seat's own session.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { settleSeat } from "../src/ledger.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderRunList, renderRunReport, renderRunStatus } from "../src/report.ts";
import { clearNotifier, forgetSeats, seatRecord, setNotifier } from "../src/seats.ts";

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

test("a writer seat's report is placed by the plugin as well", async () => {
  // A writer's own write to the run directory is refused by the host sandbox,
  // so the seat that could write its artifact never did — the plugin places
  // every seat's report, whoever yielded it.
  const { dir, run } = await emittedRun("fix the login bug");
  const implementer = run.agents.find((a) => a.role === "implementer")!;
  assert.equal(implementer.mayWrite, true);
  const settled = await settleSeat({ record: (await seatRecord(implementer.agent, dir))!, details: yielded("IMPL") });
  assert.equal(settled.written, implementer.artifact);
  assert.equal((await readFile(implementer.artifact, "utf8")).trim(), "IMPL");
});

test("a seat that yields no report is recorded as a failure, not as a placed report", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  const notices: Array<{ text: string; level: string }> = [];
  const sink = (text: string, level: "info" | "warning") => notices.push({ text, level });
  setNotifier(sink);
  try {
    // No report at all, and a report that is only whitespace: both are the
    // same absence, and both must be visible.
    for (const details of [
      { data: { summary: "s", verdict: "pass" }, status: "success" },
      { data: { summary: "s", report: "   ", verdict: "pass" }, status: "success" },
    ]) {
      const settled = await settleSeat({ record: (await seatRecord(scout.agent, dir))!, details });
      assert.equal(settled.written, undefined);
      assert.equal(settled.outcome?.error, "seat yielded no report");
      assert.equal(settled.outcome?.artifact, undefined);
    }
  } finally {
    clearNotifier(sink);
  }
  await assert.rejects(access(scout.artifact), "nothing may be placed where the report should be");
  const recorded = await outcomes();
  assert.equal(recorded.length, 2);
  assert.ok(recorded.every((o) => o.error === "seat yielded no report"));
  assert.match(await renderRunStatus(dir), new RegExp(`Failed: ${scout.agent}`));
  assert.ok(
    notices.some((n) => n.level === "warning" && /yielded no report/.test(n.text)),
    `the main session must be warned: ${JSON.stringify(notices)}`,
  );
});

test("a report that cannot be written is recorded as an error, not as a placed report", async () => {
  const { dir, run, outcomes } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  // The artifact path is a directory: the write cannot succeed.
  await mkdir(scout.artifact, { recursive: true });
  const settled = await settleSeat({ record: (await seatRecord(scout.agent, dir))!, details: yielded("REPORT") });
  assert.equal(settled.written, undefined);
  assert.ok(settled.outcome?.error, "the failed write must be recorded");
  assert.equal(settled.outcome?.artifact, undefined);
  const [outcome] = await outcomes();
  assert.ok(outcome!.error);
});

test("a report yielded in sections is placed when the terminal yield arrives", async () => {
  const { dir, run } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  const record = (await seatRecord(scout.agent, dir))!;
  // The section is not the seat's result: it records nothing on its own.
  const section = await settleSeat({ record, details: { data: "PARTIAL", status: "success", type: ["report"] } });
  assert.equal(section.outcome, undefined);
  // The terminal yield carries no data at all: the report is the section the
  // seat folded on the way.
  const settled = await settleSeat({
    record,
    details: { data: undefined, status: "success", type: "result" },
    sections: { report: "FULL REPORT", verdict: "pass" },
  });
  assert.equal(settled.written, scout.artifact);
  assert.equal((await readFile(scout.artifact, "utf8")).trim(), "FULL REPORT");
  assert.equal(settled.outcome?.verdict, "pass");
});

test("an outcome that cannot be recorded is reported, not dropped in silence", async () => {
  const { dir, run } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  // The manifest is unreadable: the outcome cannot be appended to it.
  await writeFile(join(dir, ".role-fleet", run.plan!.runId!, "plan.json"), "{ truncated", "utf8");
  const notices: string[] = [];
  const sink = (text: string) => notices.push(text);
  setNotifier(sink);
  try {
    const settled = await settleSeat({ record: (await seatRecord(scout.agent, dir))!, details: yielded("REPORT") });
    assert.equal(settled.recorded, false);
  } finally {
    clearNotifier(sink);
  }
  assert.ok(
    notices.some((n) => /could not be recorded/.test(n)),
    `a lost outcome must be reported: ${JSON.stringify(notices)}`,
  );
});

test("seats of one wave settling together keep every outcome", async () => {
  const { dir, run, outcomes } = await emittedRun("refactor the adapter and review it --council");
  const readOnly = run.agents.filter((a) => !a.mayWrite);
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

test("two projects in one process keep their own seat records", async () => {
  // Seat names are reused across projects, so the name alone is not an
  // identity: the second project's run must not hand its record to the
  // first project's seat.
  const a = await emittedRun("audit the deps");
  const b = await emittedRun("audit the deps");
  const scoutA = a.run.agents.find((x) => x.role === "scout")!;
  const scoutB = b.run.agents.find((x) => x.role === "scout")!;
  assert.equal(scoutA.agent, scoutB.agent, "both projects use the same seat name");

  const recordA = await seatRecord(scoutA.agent, a.dir);
  const recordB = await seatRecord(scoutB.agent, b.dir);
  assert.equal(recordA?.artifact, scoutA.artifact, "project A's seat must point at project A's artifact");
  assert.equal(recordB?.artifact, scoutB.artifact, "project B's seat must point at project B's artifact");
  assert.notEqual(recordA?.manifestPath, recordB?.manifestPath, "the two projects must not share a manifest");
});

test("a manifest whose artifact leaves the run directory builds no seat record", async () => {
  const { dir, run } = await emittedRun("audit the deps");
  const scout = run.agents.find((a) => a.role === "scout")!;
  const manifestPath = join(dir, ".role-fleet", run.plan!.runId!, "plan.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    agents: Array<{ agent: string; artifact: string }>;
  };
  manifest.agents = manifest.agents.map((a) => (a.agent === scout.agent ? { ...a, artifact: "/tmp/x" } : a));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  forgetSeats();

  // The path is on disk and points anywhere the manifest says: the plugin
  // writes that report itself, so it writes nothing outside its own run.
  assert.equal(await seatRecord(scout.agent, dir), undefined);
});

test("a run over a manifest with unsettled seats says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-unsettled-"));
  const first = await runRoleFleet({ task: "audit the deps", cwd: dir });
  assert.equal(first.ok, true);
  // The first run's seats never settled: its manifest records intent only.
  const manifest = JSON.parse(
    await readFile(join(dir, ".role-fleet", first.plan!.runId!, "plan.json"), "utf8"),
  ) as { agents: unknown[]; outcomes: unknown[] };
  assert.equal(manifest.outcomes.length, 0);

  const second = await runRoleFleet({ task: "audit the deps again", cwd: dir });
  assert.ok(
    second.plan!.notes.some((n) => n.includes(first.plan!.runId!) && /without an outcome/.test(n)),
    `the unsettled run must be named: ${second.plan!.notes.join(" | ")}`,
  );
});
