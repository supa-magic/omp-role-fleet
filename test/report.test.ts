/**
 * Reading a run back.
 *
 * The manifest is the durable record of a run, and it is read long after the
 * session that wrote it is gone: by a person asking what happened, and by the
 * next run's tooling. So the reader has to survive a manifest that is
 * incomplete, a directory that is not a run at all, and a newest run whose
 * file was truncated by something else.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderRunList, renderRunReport, renderRunStatus } from "../src/report.ts";

/** Write one run's manifest, and return the directory it went into. */
async function writeRun(cwd: string, runId: string, manifest: unknown): Promise<string> {
  const dir = join(cwd, ".role-fleet", runId);
  await mkdir(dir, { recursive: true });
  const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  await writeFile(join(dir, "plan.json"), body, "utf8");
  return dir;
}

test("a manifest without agents or notes is read, not thrown at", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rf-report-"));
  await writeRun(cwd, "run-1000", { task: "audit the deps" });

  const report = await renderRunReport(cwd);
  assert.match(report, /Task: audit the deps/);
  assert.match(report, /Cast \(0 seat\(s\)\)/);
  assert.match(report, /Outcomes \(0\/0 settled\)/);

  const status = await renderRunStatus(cwd);
  assert.match(status, /0\/0 settled/);
  assert.match(status, /Task: audit the deps/);

  const list = await renderRunList(cwd);
  assert.match(list, /run-1000/);
  assert.match(list, /0\/0 settled/);
});

test("a file named like a run is not a run", async () => {
  // `run-123` as a plain file is somebody else's file in the runs directory.
  // Reading it as a run is how a stray file turns into an unreadable manifest.
  const cwd = await mkdtemp(join(tmpdir(), "rf-report-"));
  await mkdir(join(cwd, ".role-fleet"), { recursive: true });
  await writeFile(join(cwd, ".role-fleet", "run-123"), "not a run", "utf8");

  assert.match(await renderRunList(cwd), /No role-fleet runs in this repository yet/);
  assert.match(await renderRunStatus(cwd), /No role-fleet runs in this repository yet/);
  assert.match(await renderRunReport(cwd), /No role-fleet runs in this repository yet/);
});

test("an unreadable newest manifest is named, and the next readable run is shown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rf-report-"));
  await writeRun(cwd, "run-1000", { task: "the older run", agents: [], notes: [] });
  await writeRun(cwd, "run-2000", "{ truncated");

  const status = await renderRunStatus(cwd);
  assert.match(status, /run-2000/);
  assert.match(status, /unreadable manifest/);
  assert.match(status, /Run run-1000/);
  assert.match(status, /Task: the older run/);
});

test("a seat that was blocked is a failed seat", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rf-report-"));
  await writeRun(cwd, "run-1000", {
    task: "audit the deps",
    startedAt: 0,
    notes: [],
    agents: [{ agent: "rf-scout", role: "scout", artifact: "scout.md", wave: 1 }],
    outcomes: [{ agent: "rf-scout", fallback: false, verdict: "blocked" }],
  });

  const status = await renderRunStatus(cwd);
  assert.match(status, /Failed: rf-scout/);
  // A seat that fell back is named as one.
  await writeRun(cwd, "run-2000", {
    task: "audit the deps",
    startedAt: 0,
    notes: [],
    agents: [{ agent: "rf-reviewer", role: "reviewer", artifact: "reviewer.md", wave: 1 }],
    outcomes: [{ agent: "rf-reviewer", fallback: true, ran: "xai/grok-4", route: "retry fallback from mock/role-slow" }],
  });
  const withFallback = await renderRunStatus(cwd);
  assert.match(withFallback, /Fallbacks: rf-reviewer/);
});
