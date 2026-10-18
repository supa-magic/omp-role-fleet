/**
 * The post-dispatch ledger: read-only reports placed on disk and outcomes
 * appended to the run manifest from a settled `task` result.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistSettledRuns } from "../src/ledger.ts";
import { recordExpectedModels } from "../src/model-observed.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { renderRunList, renderRunReport } from "../src/report.ts";

test("a settled read-only seat places its report and appends its outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-ledger-"));
  const run = await runRoleFleet({ task: "audit the deps", cwd: dir });
  assert.equal(run.ok, true);
  recordExpectedModels(run.agents);

  const manifestPath = join(dir, ".role-fleet", run.plan!.runId!, "plan.json");
  const before = JSON.parse(await readFile(manifestPath, "utf8")) as { outcomes?: unknown[] };
  assert.deepEqual(before.outcomes, [], "the pre-dispatch manifest records intent only");

  const scout = run.agents.find((a) => a.role === "scout")!;
  const reviewer = run.agents.find((a) => a.role === "reviewer")!;
  const details = {
    results: [
      {
        index: 0,
        id: "job-1",
        agent: scout.agent,
        exitCode: 0,
        output: "ignored when a structured report exists",
        resolvedModel: "mock/scout:high",
        tokens: 120,
        requests: 3,
        durationMs: 1500,
        structuredOutput: { status: "valid", data: { summary: "headline", report: "FULL SCOUT REPORT", verdict: "pass" } },
      },
      {
        index: 1,
        id: "job-2",
        agent: reviewer.agent,
        exitCode: 0,
        output: "FULL REVIEWER REPORT",
        resolvedModel: "mock/reviewer",
        tokens: 80,
        requests: 2,
        durationMs: 900,
      },
    ],
  };

  const first = await persistSettledRuns(details);
  assert.equal(first.outcomes.length, 2);
  assert.equal(first.written.length, 2, `read-only seats must place their reports: ${first.written.join(", ")}`);
  assert.equal((await readFile(scout.artifact, "utf8")).trim(), "FULL SCOUT REPORT");
  assert.equal((await readFile(reviewer.artifact, "utf8")).trim(), "FULL REVIEWER REPORT");

  const after = JSON.parse(await readFile(manifestPath, "utf8")) as {
    outcomes: Array<{ agent: string; ran?: string; tokens?: number; verdict?: string; fallback: boolean }>;
  };
  assert.equal(after.outcomes.length, 2);
  const scoutOutcome = after.outcomes.find((o) => o.agent === scout.agent)!;
  assert.equal(scoutOutcome.ran, "mock/scout", "the thinking suffix is not part of the model id");
  assert.equal(scoutOutcome.tokens, 120);
  assert.equal(scoutOutcome.verdict, "pass");
  assert.equal(scoutOutcome.fallback, false);

  // A re-delivered envelope is not a second paid run.
  const second = await persistSettledRuns(details);
  assert.equal(second.outcomes.length, 0);
  const stable = JSON.parse(await readFile(manifestPath, "utf8")) as { outcomes: unknown[] };
  assert.equal(stable.outcomes.length, 2);

  const report = await renderRunReport(dir);
  assert.match(report, /Outcomes \(2\/2 settled\)/);
  assert.match(report, /120 tokens/);
  assert.match(report, /verdict pass/);
  assert.match(report, /audit the deps/);

  const list = await renderRunList(dir);
  assert.match(list, new RegExp(run.plan!.runId!));
  assert.match(list, /2\/2 settled/);
});