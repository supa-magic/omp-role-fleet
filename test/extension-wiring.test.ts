/**
 * Extension wiring: the factory must register its command and tools against the
 * documented ExtensionAPI surface. Exercised with a stub host so the check needs
 * no provider, no session, and no credentials.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import roleFleet from "../src/index.ts";
import { runRoleFleet } from "../src/pipeline.ts";
import { DEFAULT_MAX_ROLES } from "../src/core.ts";

interface StubHost {
  pi: {
    zod: unknown;
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void;
    registerCommand: (name: string, spec: Record<string, unknown>) => void;
    registerTool: (spec: Record<string, unknown>) => void;
    sendMessage: (message: string, opts?: unknown) => void;
    /** Present because the command's catch block logs through it. */
    logger: { error: (message: string) => void };
  };
  commands: Map<string, Record<string, unknown>>;
  tools: Map<string, Record<string, unknown>>;
  events: string[];
  /** The registered event handlers, so wiring can be exercised, not just listed. */
  handlers: Map<string, (event: unknown, ctx: unknown) => void>;
  /** What the host was asked to send, with the dispatch options it was given. */
  sent: Array<{ message: string; opts: unknown }>;
  /** What the extension logged through `pi.logger`. */
  errors: string[];
}

/** Minimal zod stand-in: enough shape for `parameters` to be built.
 *
 *  Constraints are recorded on the returned object rather than discarded, so a
 *  test can assert a bound the plugin actually declared — `min(1)` on `task`
 *  is a real contract, and a stub that swallowed it could not tell a declared
 *  bound from a missing one. */
function zodStub(): unknown {
  const chain = (): Record<string, unknown> => {
    const api: Record<string, unknown> = {
      describe: () => api,
      optional: () => api,
      int: () => api,
      min: (value: number) => {
        api.min = value;
        return api;
      },
      max: (value: number) => {
        api.max = value;
        return api;
      },
    };
    return api;
  };
  return {
    // `keys` exists so a test can see which parameters the tool actually
    // declared: a schema that omits a key its execute reads is invisible
    // otherwise, and the parameter silently arrives as undefined. `shape` keeps
    // the per-parameter schemas so a declared bound can be asserted.
    object: (shape: Record<string, unknown>) => ({ ...chain(), keys: Object.keys(shape ?? {}), shape }),
    string: chain,
    number: chain,
    boolean: chain,
    // `array` records its item schema and its bound for the same reason
    // `chain` records `min`/`max`: a list parameter the model cannot fill
    // safely is a silent failure otherwise.
    array: (item: unknown) => {
      const api: Record<string, unknown> = {
        ...chain(),
        item,
        min: (value: number) => {
          api.min = value;
          return api;
        },
      };
      return api;
    },
  };
}

function stubHost(opts: { sendMessageThrows?: boolean } = {}): StubHost {
  const commands = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  const sent: Array<{ message: string; opts: unknown }> = [];
  const errors: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  return {
    commands,
    tools,
    events,
    handlers,
    sent,
    errors,
    pi: {
      zod: zodStub(),
      on: (event, handler) => {
        events.push(event);
        handlers.set(event, handler);
      },
      registerCommand: (name, spec) => commands.set(name, spec),
      registerTool: (spec) => tools.set(String(spec.name), spec),
      sendMessage: (message: string, sendOpts?: unknown) => {
        if (opts.sendMessageThrows) throw new Error("host refused the message");
        sent.push({ message, opts: sendOpts });
      },
      logger: { error: (message: string) => errors.push(message) },
    },
  };
}

/** One item of the cast dialog, in the shape `askDialog` receives. */
interface DialogItem {
  id: string;
  question: string;
  options: Array<{ label: string; description: string; preview?: string }>;
}

/** What a stubbed host answers with; `null` stands for a dismissed dialog. */
type DialogAnswer = { kind: string; results: Array<{ id: string; selectedOptions: string[] }> } | null;

/**
 * Command context stub: records what the user would actually have been told,
 * including the status line — a loader that never fires is invisible here unless
 * the calls are recorded.
 *
 * `ask` installs a real `askDialog`, which is what makes the confirmation path
 * testable at all: without it the context models a headless host that dispatches
 * without asking, and the preset/picker decision mapping has no coverage. The
 * shape is declared here rather than re-asserted at every call site.
 */
function commandCtx(
  cwd: string,
  opts: {
    idle?: boolean;
    ask?: (items: DialogItem[]) => DialogAnswer;
    /** `sub` models a subagent session, which the extension must treat differently. */
    kind?: string;
    /** The host's `ctx.models`, when the test wants plan-time resolution. */
    models?: { resolve(spec: string): { provider: string; id: string } };
  } = {},
): {
  ctx: {
    cwd: string;
    agent: { kind: string; name: string };
    ui: {
      notify(text: string, level: string): void;
      setStatus(key: string, text: string | undefined): void;
      setWorkingMessage(message?: string): void;
      askDialog?(items: DialogItem[], opts: Record<string, unknown>): Promise<DialogAnswer>;
    };
    models?: { resolve(spec: string): { provider: string; id: string } };
    isIdle(): boolean;
  };
  notices: Array<{ text: string; level: string }>;
  statuses: Array<[string, string | undefined]>;
  /** The items the extension asked about, in call order. */
  asked: DialogItem[][];
} {
  const notices: Array<{ text: string; level: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const asked: DialogItem[][] = [];
  const ctx = {
    cwd,
    agent: { kind: opts.kind ?? "main", name: opts.kind === "sub" ? "task" : "main" },
    ui: {
      notify: (text: string, level: string) => notices.push({ text, level }),
      setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      setWorkingMessage: (message?: string) => statuses.push(["working", message]),
      ...(opts.ask
        ? {
            askDialog: async (items: DialogItem[]): Promise<DialogAnswer> => {
              asked.push(items);
              return opts.ask!(items);
            },
          }
        : {}),
    },
    ...(opts.models ? { models: opts.models } : {}),
    isIdle: () => opts.idle ?? true,
  };
  return { ctx, notices, statuses, asked };
}

/**
 * One seat's own session. The host rebinds the factory for every session,
 * subagents included, so a fresh stub host bound to the same factory stands in
 * for it; module state (the seat registry, the notifier) is shared, as it is in
 * the host's single process.
 */
function seatSession(name: string, cwd: string) {
  const host = stubHost();
  roleFleet(host.pi as never);
  const ctx = (model?: { provider: string; id: string }) => ({ agent: { kind: "sub", name }, cwd, ...(model ? { model } : {}) });
  const call = (event: string, payload: unknown, model?: { provider: string; id: string }) =>
    host.handlers.get(event)?.(payload, ctx(model)) as unknown;
  return {
    host,
    start: async () => void (await call("agent_start", { type: "agent_start" })),
    toolCall: async (toolName: string) =>
      (await call("tool_call", { type: "tool_call", toolCallId: "call-1", toolName, input: {} })) as
        | { block?: boolean; reason?: string }
        | undefined,
    fallback: async (from: string, to: string) => void (await call("retry_fallback_applied", { type: "retry_fallback_applied", from, to, role: "default" })),
    yielded: async (details: unknown, model?: { provider: string; id: string }) =>
      void (await call("tool_execution_end", { type: "tool_execution_end", toolCallId: "y", toolName: "yield", isError: false, result: { content: [], details } }, model)),
  };
}

/** The main session's start: registers where seat news is shown. */
function mainSession(host: StubHost): Array<{ text: string; level: string }> {
  const notices: Array<{ text: string; level: string }> = [];
  host.handlers.get("session_start")!({}, { agent: { kind: "main", name: "main" }, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } });
  return notices;
}

test("a seat's yield in its own session places its report and announces a fallback in the main session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-observer-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const notices = mainSession(host);
  const resolver = { resolve: (spec: string) => ({ provider: "mock", id: spec.replace("@", "role-") }) };
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("fix the auth bug", commandCtx(dir, { models: resolver }).ctx);
  const runId = (await readdir(join(dir, ".role-fleet")))[0]!;
  const manifest = async () =>
    JSON.parse(await readFile(join(dir, ".role-fleet", runId, "plan.json"), "utf8")) as {
      agents: Array<{ agent: string; artifact: string }>;
      outcomes: Array<{ agent: string; ran?: string; fallback: boolean; verdict?: string }>;
    };
  const reviewer = (await manifest()).agents.find((a) => a.agent === "rf-reviewer")!;

  const seat = seatSession("rf-reviewer", dir);
  await seat.start();
  await seat.fallback("mock/role-slow", "xai/grok-4");
  notices.length = 0;
  await seat.yielded({ data: { summary: "s", report: "FULL REVIEW", verdict: "fail" }, status: "success" }, { provider: "xai", id: "grok-4" });

  assert.equal((await readFile(reviewer.artifact, "utf8")).trim(), "FULL REVIEW");
  const [outcome] = (await manifest()).outcomes;
  assert.equal(outcome?.agent, "rf-reviewer");
  assert.equal(outcome?.ran, "xai/grok-4");
  assert.equal(outcome?.fallback, true);
  assert.equal(outcome?.verdict, "fail");
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(notices[0]!.level, "warning");
  assert.match(notices[0]!.text, /rf-reviewer — planned `mock\/role-slow`, ran `xai\/grok-4`, FALLBACK/);

  // A yield in a session that is not a generated seat is none of the ledger's business.
  const other = seatSession("explore", dir);
  await other.yielded({ data: { report: "X" }, status: "success" });
  assert.equal((await manifest()).outcomes.length, 1);
});

test("a read-only seat may not call an MCP tool the operator did not allow", async () => {
  // MCP tools are minted write-tier, a definition's `tools:` list governs
  // built-ins only, and seats run unattended — so a read-only seat still holds
  // every connected MCP tool. The guard is installed in that seat's session.
  const dir = await mkdtemp(join(tmpdir(), "rf-mcp-guard-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("fix the auth bug", commandCtx(dir).ctx);

  const before = process.env.ROLE_FLEET_MCP_READONLY;
  delete process.env.ROLE_FLEET_MCP_READONLY;
  try {
    const scout = seatSession("rf-scout", dir);
    await scout.start();
    const refused = await scout.toolCall("mcp__linear_create_issue");
    assert.equal(refused?.block, true, `a read-only seat's MCP call must be refused: ${JSON.stringify(refused)}`);
    assert.match(refused?.reason ?? "", /rf-scout/);
    assert.match(refused?.reason ?? "", /ROLE_FLEET_MCP_READONLY/);

    process.env.ROLE_FLEET_MCP_READONLY = "mcp__codesearch_";
    assert.equal(await scout.toolCall("mcp__codesearch_search"), undefined, "an allowed MCP tool must pass");
    assert.equal((await scout.toolCall("mcp__linear_create_issue"))?.block, true, "other servers stay refused");
    assert.equal(await scout.toolCall("read"), undefined, "a built-in call is never touched");

    // A seat that may write keeps its MCP tools and gets no guard at all.
    const implementer = seatSession("rf-implementer", dir);
    await implementer.start();
    assert.ok(!implementer.host.events.includes("tool_call"));

    // A hand-written agent's session is never this plugin's to police.
    const handWritten = seatSession("my-reviewer", dir);
    await handWritten.start();
    assert.ok(!handWritten.host.events.includes("tool_call"));
  } finally {
    if (before === undefined) delete process.env.ROLE_FLEET_MCP_READONLY;
    else process.env.ROLE_FLEET_MCP_READONLY = before;
  }
});

test("a running seat keeps its own run when a newer run reuses its name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-pinned-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("audit the deps", commandCtx(dir).ctx);
  const [first] = (await readdir(join(dir, ".role-fleet"))).sort();

  // Run A's scout starts, then run B is emitted under the same `rf-scout` name.
  const scout = seatSession("rf-scout", dir);
  await scout.start();
  await handler("audit the deps again", commandCtx(dir).ctx);
  const runs = (await readdir(join(dir, ".role-fleet"))).sort();
  assert.equal(runs.length, 2);

  await scout.yielded({ data: { summary: "s", report: "RUN A REPORT", verdict: "pass" }, status: "success" });
  const manifest = async (run: string) =>
    JSON.parse(await readFile(join(dir, ".role-fleet", run, "plan.json"), "utf8")) as { outcomes: unknown[] };
  assert.equal((await manifest(first!)).outcomes.length, 1, "the outcome belongs to the run the seat started in");
  assert.equal((await manifest(runs[1]!)).outcomes.length, 0, "the newer run must not inherit it");
  assert.equal((await readFile(join(dir, ".role-fleet", first!, "scout.md"), "utf8")).trim(), "RUN A REPORT");
});

test("a read-only seat cannot plan a fleet; a writer seat can", async () => {
  // The plan tool writes and prunes agent definitions, and extension tools
  // reach every seat whatever its grant.
  const dir = await mkdtemp(join(tmpdir(), "rf-nested-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("fix the auth bug", commandCtx(dir).ctx);

  const call = async (name: string) => {
    const seat = seatSession(name, dir);
    await seat.start();
    const execute = seat.host.tools.get("role_fleet_plan")!.execute as (...a: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    return execute("id", { task: "review the auth bug", dryRun: true }, null, null, { cwd: dir, agent: { kind: "sub", name } });
  };
  const refused = await call("rf-scout");
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /not available to the read-only seat `rf-scout`/);
  assert.notEqual((await call("rf-implementer")).isError, true);
});

test("the --review-only flag reaches the pipeline, not just the parser", async () => {
  // A flag that parses but is never passed down is invisible to the unit tests
  // on both sides of the seam, so it is pinned end to end: the command path must
  // produce a cast with nothing that writes.
  const dir = await mkdtemp(join(tmpdir(), "rf-reviewonly-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const { ctx, notices } = commandCtx(dir);
  await handler("--review-only fix the auth bug and review it", ctx);

  const dispatched = host.sent.at(-1)?.message ?? "";
  assert.match(dispatched, /reviewer/, "the review seats are the point");
  assert.ok(!dispatched.includes("rf-implementer"), `a writer was dispatched: ${dispatched.slice(0, 300)}`);
  assert.ok(!dispatched.includes("rf-tester"), "a tester is not part of a review");
  assert.ok(notices.some((n) => n.text.includes("review-only")), "the plan must say it is review-only");
});

test("the tool refuses a broken allowlist instead of planning unpinned", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const tool = host.tools.get("role_fleet_plan")!;
  const execute = tool.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: null,
    onUpdate: null,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details: { agentDir: string | null } }>;

  const dir = await mkdtemp(join(tmpdir(), "rf-tool-"));

  // A throw inside the run must come back as a tool error, not an unhandled
  // rejection the model sees as a broken plugin.
  const thrown = await execute("id", { task: "fix the auth bug", allowlist: join(dir, "missing.json") }, null, null, {
    cwd: dir,
  });
  assert.equal(thrown.isError, true, "a failing run must surface as isError");
  assert.match(thrown.content[0].text, /role_fleet_plan failed:/);

  // A malformed allowlist is refused at load, before any plan exists — so it
  // surfaces as a tool error naming the offending entry, never as a plan.
  await writeFile(join(dir, "bad.json"), JSON.stringify({ models: [] }), "utf8");
  const malformed = await execute("id", { task: "fix the auth bug", allowlist: join(dir, "bad.json") }, null, null, {
    cwd: dir,
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.content[0].text, /"models" must be a non-empty array/);

  // The happy path is a plan plus dispatch instructions, and it writes.
  const ok = await execute("id", { task: "fix the auth bug" }, null, null, { cwd: dir });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /"agent": "rf-scout"/);
  assert.ok(ok.details.agentDir, "a non-dry run must report where the agents landed");
});

test("the tool surface applies the same review-model rules as the flag path", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: null,
    onUpdate: null,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const dir = await mkdtemp(join(tmpdir(), "rf-toolmodels-"));
  const at = { cwd: dir };

  // The flag path collapses duplicates because two members on one model is the
  // double-priced single review this feature exists to avoid. The tool hands over
  // a raw array, and the rule lived in the command-line parser — so the same list
  // bought three identical reviewers here.
  const dupes = await execute("id", { task: "review the auth fix", models: ["xai/grok-4", "xai/grok-4"], dryRun: true }, null, null, at);
  assert.equal(dupes.isError, undefined);
  assert.match(dupes.content[0].text, /• reviewer xai\/grok-4/, dupes.content[0].text.slice(0, 300));
  assert.ok(!/reviewer-c\d/.test(dupes.content[0].text), `a duplicate member was seated: ${dupes.content[0].text}`);

  // A blank entry must not fail the run either: it used to reach the gate and
  // reject the whole plan with "role reviewer: no model".
  const blank = await execute("id", { task: "fix the auth bug", models: ["  "], dryRun: true }, null, null, at);
  assert.equal(blank.isError, undefined, "a blank entry must not fail the run");
  assert.ok(!/rejected/.test(blank.content[0].text), `a blank entry rejected the run: ${blank.content[0].text}`);
  assert.match(blank.content[0].text, /blank or duplicate/, "the dropped entry must be reported");

  // A blank consul is no consul. The old guard here asserted the council was not
  // handed `repo-wide write`; that tier is gone, so the assertion could no longer
  // fail. What the screen still owes the user is the note, the same way a blank
  // model entry is reported above.
  const consul = await execute("id", { task: "review the auth fix", council: 3, consul: "  ", dryRun: true }, null, null, at);
  assert.ok(!/\bConsul\b/.test(consul.content[0].text), `a blank consul was seated: ${consul.content[0].text}`);
  assert.match(consul.content[0].text, /blank selector was ignored/, "the dropped selector must be reported");
});

test("the tool's dispatch instructions carry the batch guardrails", async () => {
  // The tool's consumer is the main model itself — the party most likely to add
  // a `model:` to a task call — and it used to receive the batch with none of the
  // instructions the command path states before dispatching.
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: null,
    onUpdate: null,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
  const dir = await mkdtemp(join(tmpdir(), "rf-toolguard-"));
  const result = await execute("id", { task: "fix the auth bug" }, null, null, { cwd: dir });
  const text = result.content[0].text;
  assert.match(text, /Pass each item's `name`, `agent`, and `effort` exactly as given/);
  assert.match(text, /`task` text/);
  assert.match(text, /solutionSpace/);
  assert.match(text, /Do NOT invent or omit `effort`/);
  assert.match(text, /"effort": "lo"/);
});

test("the plan tool returns the dispatch batches as data", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: null,
    onUpdate: null,
    ctx: unknown,
  ) => Promise<{ isError?: boolean; details: unknown }>;
  const dir = await mkdtemp(join(tmpdir(), "rf-tooldetails-"));
  const result = await execute("id", { task: "fix the auth bug" }, null, null, { cwd: dir });
  assert.equal(result.isError, undefined);
  const details = result.details;
  assert.ok(typeof details === "object" && details !== null, "the tool must return details");
  assert.ok("runId" in details && typeof details.runId === "string", "details must name the run");
  assert.ok("groups" in details && Array.isArray(details.groups), "details must carry dispatch groups");
  assert.ok(details.groups.length > 0, "a build plan has dispatch groups");
  const first = details.groups[0];
  assert.ok(typeof first === "object" && first !== null && "agents" in first && Array.isArray(first.agents));
  const seat = first.agents[0];
  assert.ok(typeof seat === "object" && seat !== null);
  assert.ok("name" in seat && typeof seat.name === "string" && seat.name.length > 0, "each item carries its roster name");
  assert.ok("agent" in seat && typeof seat.agent === "string" && seat.agent.startsWith("rf-"));
  assert.ok("effort" in seat && (seat.effort === "lo" || seat.effort === "med" || seat.effort === "hi"), "each item carries task effort");
  assert.ok("artifact" in seat && typeof seat.artifact === "string");
  assert.ok("wave" in first && first.wave === 1);
});

test("the tool schema refuses a blank task, as the command already does", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const parameters = host.tools.get("role_fleet_plan")!.parameters;
  assert.ok(
    parameters !== null &&
      typeof parameters === "object" &&
      "keys" in parameters &&
      "shape" in parameters,
    "the tool must declare a parameters object",
  );
  assert.ok((parameters.keys as string[]).includes("task"));
  // The stub records declared bounds, so this asserts a real contract rather
  // than the presence of a method.
  const shape = (parameters as { shape: Record<string, Record<string, unknown>> }).shape;
  assert.equal(shape.task.min, 1, "task must declare min(1), as the command path enforces");
});

test("an allowlist from the environment pins the run when no flag is given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-env-"));
  const file = join(dir, "fleet.json");
  await writeFile(
    file,
    JSON.stringify({
      models: [{ selector: "env/model", aliases: ["env"] }],
      roles: [{ role: "scout", chain: ["env"] }],
    }),
    "utf8",
  );

  const host = stubHost();
  roleFleet(host.pi as never);
  const tool = host.tools.get("role_fleet_plan")!;
  const execute = tool.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: null,
    onUpdate: null,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: { roles: Array<{ id: string; model: string }> } }>;

  const previous = process.env.ROLE_FLEET_ALLOWLIST;
  process.env.ROLE_FLEET_ALLOWLIST = file;
  try {
    const result = await execute("id", { task: "fix the auth bug", dryRun: true }, null, null, { cwd: dir });
    const scout = result.details.roles.find((r) => r.id === "scout");
    assert.equal(scout?.model, "env/model", "the env var must pin the run with no flag passed");
  } finally {
    if (previous === undefined) delete process.env.ROLE_FLEET_ALLOWLIST;
    else process.env.ROLE_FLEET_ALLOWLIST = previous;
  }
});

test("a tilde path resolves on the tool surface too, not only via the flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-tilde-"));
  const file = join(homedir(), `rf-tilde-${process.pid}.json`);
  await writeFile(
    file,
    JSON.stringify({
      models: [{ selector: "home/model", aliases: ["home"] }],
      roles: [{ role: "scout", chain: ["home"] }],
    }),
    "utf8",
  );

  try {
    // The tool takes a raw string from a model and never passes through
    // `parseFlags`, so expansion must live at the point the path is opened.
    const result = await runRoleFleet({
      task: "fix the auth bug",
      cwd: dir,
      allowlist: `~/rf-tilde-${process.pid}.json`,
      dryRun: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan!.roles.find((r) => r.id === "scout")!.model, "home/model");
  } finally {
    await rm(file, { force: true });
  }
});

test("a relative allowlist path resolves against the session cwd, not the process cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-relcwd-"));
  await writeFile(
    join(dir, "fleet.json"),
    JSON.stringify({
      models: [{ selector: "rel/model", aliases: ["rel"] }],
      roles: [{ role: "scout", chain: ["rel"] }],
    }),
    "utf8",
  );

  // Agent files and artifacts already resolve against `cwd`; the allowlist must
  // too, or a session started outside the project opens the wrong file (or
  // none). The suite runs from the package root, so a bare relative name here
  // would ENOENT against the process cwd.
  const result = await runRoleFleet({ task: "fix the auth bug", cwd: dir, allowlist: "fleet.json", dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.plan!.roles.find((r) => r.id === "scout")!.model, "rel/model");
});

test("a malformed allowlist names the offending entry, never just the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-shape-"));
  const cases: Array<[unknown, RegExp]> = [
    [{ models: "nope" }, /"models" must be a non-empty array/],
    [{ models: [{ aliases: ["fast"] }] }, /models\[0\] needs a non-empty "selector"/],
    [{ models: [{ selector: "a/m", aliases: [1] }] }, /models\[0\]\.aliases must be an array of strings/],
    [{ models: [{ selector: "a/m", enabled: "yes" }] }, /models\[0\]\.enabled must be true or false/],
    [{ models: [{ selector: "a/m" }], roles: {} }, /"roles" must be an array/],
    [{ models: [{ selector: "a/m" }], roles: [{ chain: ["a"] }] }, /roles\[0\] needs a non-empty "role"/],
    [{ models: [{ selector: "a/m" }], roles: [{ role: "scout", chain: "a" }] }, /roles\[0\]\.chain must be an array/],
    // Seat aliases reach the same lookup as model aliases, so they get the
    // same check instead of a bare `value.trim is not a function`.
    [{ models: [{ selector: "a/m" }], roles: [{ role: "scout", aliases: [1] }] }, /roles\[0\]\.aliases must be an array of strings/],
  ];

  for (const [body, expected] of cases) {
    const file = join(dir, "fleet.json");
    await writeFile(file, JSON.stringify(body), "utf8");
    await assert.rejects(
      () => runRoleFleet({ task: "fix the auth bug", cwd: dir, allowlist: file }),
      expected,
      `shape error not reported for ${JSON.stringify(body)}`,
    );
  }
});

test("the main session holds no tool lifecycle hook", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  assert.deepEqual([...host.commands.keys()], ["role-fleet"]);
  assert.deepEqual([...host.tools.keys()], ["role_fleet_plan"]);
  // The host refuses speculative task launch in any session where an extension
  // holds `tool_call` or `tool_result`; registering either at load would slow
  // every task batch the user runs, fleet or not.
  assert.ok(!host.events.includes("tool_call"), host.events.join(", "));
  assert.ok(!host.events.includes("tool_result"), host.events.join(", "));
});

test("the command reports the version and prints usage for an empty task", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const version = commandCtx(dir);
  await handler("--version", version.ctx);
  assert.ok(
    version.notices.some((n) => n.text.includes("omp-role-fleet")),
    "--version must answer without planning",
  );
  assert.equal(host.sent.length, 0, "--version must not dispatch anything");

  // No task: show usage, still write nothing and dispatch nothing.
  const empty = commandCtx(dir);
  await handler("", empty.ctx);
  assert.ok(
    empty.notices.some((n) => n.text.includes("usage:")),
    "an empty task must produce usage, not an opaque failure",
  );
  assert.equal(host.sent.length, 0);
});

test("a task that opens with the word version is planned, not answered", async () => {
  // The version subcommand matched on the first word alone, so "version the api
  // endpoints" printed the plugin version and could never be planned — with no
  // way for the user to tell the command had swallowed their task.
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const dir = await mkdtemp(join(tmpdir(), "rf-versionword-"));
  const { ctx, notices } = commandCtx(dir);
  await handler("version the api endpoints and document them", ctx);

  assert.ok(
    !notices.some((n) => n.text.includes("omp-role-fleet ")),
    `the version was printed for a task: ${JSON.stringify(notices)}`,
  );
  assert.equal(host.sent.length, 1, "the task must be planned and dispatched");
  assert.match(host.sent[0]!.message, /version the api endpoints/);
});

test("the command dispatches an approved plan to an idle session as a triggered turn", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const { ctx, notices } = commandCtx(dir, { idle: true });
  await handler("fix the auth bug", ctx);

  assert.equal(host.sent.length, 1, "an approved plan must reach the host exactly once");
  // An idle session never executes a plain sendMessage, so the turn must be
  // triggered; without this the batch sits in history and nothing runs.
  assert.deepEqual(host.sent[0].opts, { triggerTurn: true });
  assert.match(host.sent[0].message, /User task: fix the auth bug/);
  assert.match(host.sent[0].message, /"agent": "rf-scout"/);
  assert.ok(notices.some((n) => n.level === "info"), "the plan itself must be shown to the user");
});

test("the command steers the running turn instead of queueing behind it", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const { ctx } = commandCtx(dir, { idle: false });
  await handler("fix the auth bug", ctx);

  assert.deepEqual(host.sent[0].opts, { deliverAs: "steer" });
});

test("a dry run plans and shows the plan without dispatching or writing agents", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const { ctx, notices } = commandCtx(dir);
  await handler("fix the auth bug --dry-run", ctx);

  assert.ok(
    notices.some((n) => n.text.includes("Wave 1")),
    "a dry run still shows the plan it would have shipped",
  );
  assert.equal(host.sent.length, 0, "--dry-run must not dispatch");
  assert.equal(
    existsSync(join(dir, ".omp", "agents")),
    false,
    "--dry-run must write nothing to disk",
  );
});

test("a rejected plan is reported as an error and never dispatched", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  // A malformed allowlist is the one failure a user can trigger by typing.
  await writeFile(join(dir, "fleet.json"), JSON.stringify({ models: [] }), "utf8");
  const { ctx, notices } = commandCtx(dir);
  await handler("fix the auth bug --allowlist ./fleet.json", ctx);

  assert.ok(
    notices.some((n) => n.level === "error"),
    "a refused plan must surface as an error, not an info dump",
  );
  assert.equal(host.sent.length, 0, "a rejected plan must never be dispatched");
});

/** The plan tool's `execute`, in the shape every tool test drives it. */
type PlanToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal: null,
  onUpdate: null,
  ctx: unknown,
) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
  details?: {
    verdict?: { verdict: string; reason: string; issues: string[] };
    notes?: string[];
    roles?: Array<{ id: string; model: string }>;
    agentDir?: string | null;
  };
}>;

test("the plan tool tells the model not to dispatch a declined or refused cast", async () => {
  // The tool's caller is a model that will dispatch whatever it is handed, so
  // the two no-run branches must each say so in words and carry the verdict.
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as PlanToolExecute;
  const run = async (ask: (items: DialogItem[]) => DialogAnswer) => {
    const dir = await mkdtemp(join(tmpdir(), "rf-tool-confirm-"));
    const { ctx } = commandCtx(dir, { ask });
    return execute("id", { task: "fix the auth bug", autoConfirm: false }, null, null, ctx);
  };

  // A dismissed dialog is a human decision: not dispatched, and not a fault.
  const dismissed = await run(() => null);
  assert.notEqual(dismissed.isError, true, "a declined cast is not a tool failure");
  assert.match(dismissed.content[0]!.text, /^Role run not dispatched\./);
  assert.match(dismissed.content[0]!.text, /Do not dispatch; report this outcome instead\./);
  assert.equal(dismissed.details?.verdict?.verdict, "reject");
  assert.match(dismissed.details?.verdict?.reason ?? "", /abandoned at confirmation/);

  // An empty checklist is the same decline, never "run everything".
  const unchecked = await run((items) =>
    items.some((i) => i.id === "seats") ? submit("seats", []) : submit("cast", ["Choose each seat yourself"]),
  );
  assert.match(unchecked.content[0]!.text, /^Role run not dispatched\./);
  assert.match(unchecked.details?.verdict?.reason ?? "", /abandoned at confirmation/);

  // Keeping only a seat whose upstream was unchecked leaves no seat at all:
  // the re-gate refuses that, and the model is told it was rejected.
  const orphaned = await run((items) => {
    const seats = items.find((i) => i.id === "seats");
    if (!seats) return submit("cast", ["Choose each seat yourself"]);
    return submit("seats", seats.options.filter((o) => /review/i.test(o.label)).map((o) => o.label));
  });
  assert.match(orphaned.content[0]!.text, /^Role plan rejected\./, orphaned.content[0]!.text);
  assert.match(orphaned.content[0]!.text, /Do not dispatch; report this outcome instead\./);
  assert.equal(orphaned.details?.verdict?.verdict, "reject");
  assert.doesNotMatch(orphaned.details?.verdict?.reason ?? "", /abandoned/);
  assert.equal(host.sent.length, 0, "the tool never dispatches by itself");
});

test("a host side turn proposes specialists through the sandbox, with no tools and a token cap", async () => {
  // `makeProposer` is the only bridge from the host's ephemeral turn to the
  // dynamic tier; a stub that never reaches it leaves the tier untested.
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as PlanToolExecute;
  const turns: Array<Record<string, unknown>> = [];
  const run = async (replyText: string) => {
    const dir = await mkdtemp(join(tmpdir(), "rf-proposer-"));
    const ctx = {
      cwd: dir,
      runEphemeralTurn: async (request: Record<string, unknown>) => {
        turns.push(request);
        return { replyText };
      },
    };
    return execute("id", { task: "ask a threat modelling expert to review the auth flow" }, null, null, ctx);
  };

  const proposal = JSON.stringify([
    {
      id: "threat-modeler",
      title: "Threat modeler",
      mission: "Map the auth flow's trust boundaries.",
      acceptance: ["every boundary cites file:line"],
      tools: ["read", "grep", "glob"],
      effort: "high",
      model: "@slow",
      dependsOn: [],
    },
  ]);
  const accepted = await run(proposal);
  assert.equal(turns.length, 1, "the proposer must reach the host's side turn exactly once");
  const [turn] = turns;
  assert.equal(turn!.tools, false, "the side turn must run with tools disabled");
  assert.equal(turn!.maxTokens, 800);
  assert.equal(turn!.minimizeEffort, true);
  assert.match(String(turn!.promptText), /Reply with ONLY a JSON array/);
  assert.match(String(turn!.promptText), /Task: ask a threat modelling expert/);
  const modeler = accepted.details?.roles?.find((r) => r.id === "threat-modeler");
  assert.ok(modeler, `the sandbox-accepted proposal must join the cast: ${JSON.stringify(accepted.details?.roles)}`);
  assert.equal(modeler.model, "@slow");

  // A reply the sandbox refuses (a tool outside the grant) keeps the static cast.
  const refused = await run(proposal.replace('"glob"', '"glob","web_fetch"'));
  assert.equal(turns.length, 2);
  assert.ok(!refused.details?.roles?.some((r) => r.id === "threat-modeler"), "a refused proposal must not be seated");
  assert.ok(
    refused.details?.notes?.some((n) => n.includes("specialist proposal rejected")),
    `the refusal must be noted: ${JSON.stringify(refused.details?.notes)}`,
  );
});

test("a read-only seat's brief states the MCP grant the operator configured", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const execute = host.tools.get("role_fleet_plan")!.execute as PlanToolExecute;
  const brief = async (seat: string) => {
    const dir = await mkdtemp(join(tmpdir(), "rf-mcp-brief-"));
    const result = await execute("id", { task: "fix the auth bug" }, null, null, { cwd: dir });
    return readFile(join(result.details!.agentDir!, `${seat}.md`), "utf8");
  };
  const before = process.env.ROLE_FLEET_MCP_READONLY;
  try {
    delete process.env.ROLE_FLEET_MCP_READONLY;
    assert.match(await brief("rf-scout"), /No MCP tool is available to you: this seat is read-only and the operator allowed none\./);

    process.env.ROLE_FLEET_MCP_READONLY = "mcp__codesearch_,mcp__docs_";
    const allowed = await brief("rf-scout");
    assert.match(allowed, /MCP tools are available to you only when their name starts with `mcp__codesearch_`, `mcp__docs_`; any other MCP tool call is refused\./);
    assert.doesNotMatch(allowed, /No MCP tool is available/);

    // A seat that may write keeps its MCP tools; its brief carries no grant line.
    assert.doesNotMatch(await brief("rf-implementer"), /MCP tool/);
  } finally {
    if (before === undefined) delete process.env.ROLE_FLEET_MCP_READONLY;
    else process.env.ROLE_FLEET_MCP_READONLY = before;
  }
});


test("registered surfaces carry the fields omp requires", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  const command = host.commands.get("role-fleet")!;
  assert.equal(typeof command.handler, "function");
  assert.equal(typeof command.description, "string");

  for (const spec of host.tools.values()) {
    assert.equal(typeof spec.name, "string");
    assert.equal(typeof spec.label, "string");
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.parameters, "tool must declare parameters");
    assert.equal(typeof spec.execute, "function");
  }
});

test("a failed dispatch is reported as emitted-but-not-dispatched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-nodispatch-"));
  const host = stubHost({ sendMessageThrows: true });
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const { ctx, notices } = commandCtx(dir);
  await handler("fix the auth bug", ctx);
  assert.ok(
    notices.some((n) => n.level === "error" && n.text.includes("dispatch failed")),
    `a failed send must surface: ${JSON.stringify(notices)}`,
  );
  assert.ok(notices.some((n) => n.text.includes("emitted")), "the error must say definitions exist");
});

test("report and runs read the manifest, and report-the-word is still a task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-reportcmd-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;

  const planned = commandCtx(dir);
  await handler("audit the deps", planned.ctx);
  assert.ok(planned.notices.some((n) => n.text.includes("Gate: approve")), "the run must plan");

  const report = commandCtx(dir);
  await handler("report", report.ctx);
  assert.ok(report.notices.some((n) => /^Run run-\d+/.test(n.text)), JSON.stringify(report.notices));
  assert.ok(report.notices.some((n) => n.text.includes("Outcomes (0/")), "a fresh run has no outcomes yet");

  const list = commandCtx(dir);
  await handler("runs", list.ctx);
  assert.ok(list.notices.some((n) => n.text.includes("Recent role-fleet runs")), JSON.stringify(list.notices));

  const status = commandCtx(dir);
  await handler("status", status.ctx);
  assert.ok(status.notices.some((n) => /0\/\d+ settled/.test(n.text)), JSON.stringify(status.notices));

  const doctor = commandCtx(dir);
  await handler("doctor", doctor.ctx);
  assert.ok(doctor.notices.some((n) => n.text.includes("specialist tier")), JSON.stringify(doctor.notices));

  // "report the bug" is a task, not the subcommand: the word only acts as a
  // subcommand alone or followed by a run id.
  const task = commandCtx(dir);
  await handler("report the bug", task.ctx);
  assert.ok(task.notices.some((n) => n.text.includes("Gate: approve")), JSON.stringify(task.notices));
});

test("the plan tool declares every parameter its execute reads", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  const params = host.tools.get("role_fleet_plan")!.parameters;
  const declared: string[] =
    typeof params === "object" && params !== null && "keys" in params && Array.isArray(params.keys)
      ? params.keys.map(String)
      : [];
  // Every key the execute body reads. Kept in step with the schema by hand, which
  // is the point: a parameter that is read but not declared arrives as undefined
  // at runtime and fails silently, so this list is the guard against that.
  for (const key of [
    "task",
    "maxRoles",
    "allowlist",
    "dryRun",
    "council",
    "models",
    "consul",
    "reviewOnly",
    "slices",
    "autoConfirm",
  ]) {
    assert.ok(declared.includes(key), `role_fleet_plan does not declare "${key}": ${declared.join(", ")}`);
  }
});

test("the lockfile agrees with the published package", () => {
  // The banner reads package.json at load; a lockfile left behind on a bump or
  // a rename makes `npm ci` install this package under another identity.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string }>;
  };
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""]?.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""]?.name, pkg.name);
});

test("flag completions are self-describing and match label words", () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const completions = host.commands.get("role-fleet")!.getArgumentCompletions as (
    prefix: string,
  ) => Array<{ value: string; label: string }> | null;

  // Every label carries its flag: the host may render only the label.
  for (const c of completions("--") ?? []) {
    assert.ok(c.label.startsWith(c.value.split(" ")[0]), `label hides the flag: ${c.label}`);
  }

  // Word matching: "dry", "cap", and "allow" find their entries.
  assert.equal(completions("--dry-run")?.[0].value, "--dry-run");
  assert.ok(completions("dry")?.some((c) => c.value === "--dry-run"));
  // The default is single-sourced (`DEFAULT_MAX_ROLES`), but nothing held its
  // value: every cap test passes an explicit number, so changing the default
  // would have stayed green. Asserted as a literal — comparing against
  // `DEFAULT_MAX_ROLES` would be tautological, since the completion string is
  // templated from that very constant.
  assert.ok(completions("cap")?.some((c) => c.value === "--max-roles 4"), "the advertised default cap changed");
  assert.equal(DEFAULT_MAX_ROLES, 4);
  assert.ok(completions("allow")?.some((c) => c.value.startsWith("--allowlist")));

  // A nonsense prefix yields null, not an empty list.
  assert.equal(completions("zzz"), null);
});
test("the command says something while it plans, and clears it afterwards", async () => {
  // Planning can include a model call for extra roles. Without a message the
  // session looks frozen for several seconds and a dropped keypress and a slow
  // run look identical — so both the status line and the spinner text are set,
  // and both are cleared on the way out, including when the run throws.
  const dir = await mkdtemp(join(tmpdir(), "rf-progress-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;

  const run = commandCtx(dir);
  await handler("fix the auth bug", run.ctx);

  assert.ok(
    run.statuses.some(([key, text]) => key === "role-fleet" && typeof text === "string" && text.length > 0),
    `the status line must carry progress: ${JSON.stringify(run.statuses)}`,
  );
  assert.ok(
    run.statuses.some(([key, text]) => key === "working" && typeof text === "string" && text.length > 0),
    "the spinner text must carry progress too",
  );
  // Cleared, not left behind: a stale status line outlives the run that set it.
  const cleared = run.statuses.map(([, text]) => text);
  assert.equal(cleared.at(-1), undefined, `the indicator must be cleared last: ${JSON.stringify(cleared)}`);

  // And a failing run clears it too, rather than stranding the line. A context
  // built without `ask` has no dialog at all, which is the headless path.
  const broken = commandCtx(dir);
  await handler("fix the auth bug", broken.ctx).catch(() => {});
  assert.equal(broken.statuses.at(-1)?.[1], undefined);
});

/**
 * Drive the command with a host that can ask.
 *
 * Every other test here runs without `askDialog`, which is the negative path
 * only — so the whole decision mapping (preset label → preset → seat ids,
 * picker label → seat id, empty selection → decline) was untested, and the cast
 * screen is the one place a user actually chooses what gets paid for.
 */
async function runWithDialog(
  args: string,
  ask: (items: DialogItem[]) => DialogAnswer,
  models?: { resolve(spec: string): { provider: string; id: string } },
): Promise<{ sent: string; notices: Array<{ text: string; level: string }> }> {
  const dir = await mkdtemp(join(tmpdir(), "rf-dialog-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const base = commandCtx(dir, { ask, ...(models ? { models } : {}) });
  await handler(args, base.ctx);
  return { sent: host.sent.at(-1)?.message ?? "", notices: base.notices };
}
const submit = (id: string, labels: string[]) => ({
  kind: "submit",
  results: [{ id, selectedOptions: labels }],
});

test("the preset screen hands the pipeline the seats that preset names", async () => {
  // Picking "Look, don't touch" has to reach the run as that preset's seat ids.
  // The dialog returns a *label*, so the mapping is a lookup by human text — the
  // one place a renamed or duplicated label silently selects a different cast.
  const { sent } = await runWithDialog("refactor the auth module", (items) => {
    const cast = items.find((i) => i.id === "cast")!;
    const preset = cast.options.find((o) => o.label === "Look, don't touch");
    return submit("cast", [preset?.label ?? cast.options[0]!.label]);
  });
  assert.ok(sent.length, "the run must dispatch");
  assert.ok(!sent.includes("rf-implementer"), `the implementer was dispatched anyway:\n${sent.slice(0, 400)}`);
});

test("the consent question names a collapsed council", async () => {
  // Plan notes print after the dialog, so a warning there cannot inform the
  // spend decision. Aliases that all resolve to one model must say so on the
  // screen where the user approves N paid runs.
  const asked: string[] = [];
  await runWithDialog(
    "review the auth module --council 3",
    (items) => {
      const cast = items.find((i) => i.id === "cast")!;
      asked.push(cast.question);
      return submit("cast", [cast.options[0]!.label]);
    },
    { resolve: () => ({ provider: "mock", id: "one-model" }) },
  );
  assert.match(asked[0] ?? "", /1 distinct model across 3 reviewers/, asked[0] ?? "");
});

test("the seat picker maps labels back to ids and an empty choice abandons", async () => {
  const { sent } = await runWithDialog("refactor the auth module", (items) => {
    const seats = items.find((i) => i.id === "seats");
    if (!seats) return submit("cast", ["Choose each seat yourself"]);
    return submit("seats", seats.options.slice(0, 2).map((o) => o.label));
  });
  const dispatched = [...sent.matchAll(/"agent": "rf-([^"]+)"/g)].map((m) => m[1]);
  assert.equal(dispatched.length, 2, `picker selection not honoured: ${JSON.stringify(dispatched)}`);
  assert.ok(dispatched.includes("scout"), `the checked seat must run: ${dispatched.join(",")}`);

  // An empty checklist is a decline, not "run everything".
  const declined = await runWithDialog("refactor the auth module", (items) => {
    const seats = items.find((i) => i.id === "seats");
    if (!seats) return submit("cast", ["Choose each seat yourself"]);
    return submit("seats", []);
  });
  assert.equal(declined.sent, "", "an empty selection dispatched anyway");
  const last = declined.notices.at(-1);
  assert.equal(last?.level, "info", `a decline must not read as a failure: ${JSON.stringify(last)}`);
  assert.match(last?.text ?? "", /abandoned/, last?.text ?? "");
});

test("--yes skips the cast dialog and keeps every planned seat", async () => {
  // Automation path: a human is not watching, so the recommended cast must ship
  // without askDialog. Opening a menu here is how agent-driven fleets hang.
  let asked = 0;
  const dir = await mkdtemp(join(tmpdir(), "rf-yes-cmd-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const { ctx, notices } = commandCtx(dir, {
    ask: () => {
      asked++;
      return { kind: "submit", results: [] };
    },
  });
  await handler("--yes fix the auth bug", ctx);
  assert.equal(asked, 0, "askDialog must not open under --yes");
  assert.ok(host.sent.length >= 1, "the run must dispatch");
  assert.ok(
    notices.some((n) => /auto-accepted recommended cast/i.test(n.text)),
    `auto-accept notice missing: ${JSON.stringify(notices)}`,
  );
  // Full cast for a build task includes implementer + reviewer at minimum.
  const msg = host.sent.at(-1)?.message ?? "";
  assert.match(msg, /rf-implementer|rf-scout/);
});

test("the cast screen names who can write before anything is spent", async () => {
  // Authority is two tiers now: only `edit` can change a file, and a council
  // member holds nothing extra. That fact used to be invisible on the screen
  // asking for consent — the roster showed models only, and per-seat authority
  // sat one dialog deeper, on the deliberately non-default path.
  const asked: string[] = [];
  const lines: string[] = [];
  await runWithDialog(
    "refactor the auth module --models (xai/grok-4,zai/glm-5) --consul anthropic/claude-opus-4-6",
    (items) => {
      const cast = items.find((i) => i.id === "cast")!;
      asked.push(cast.question, ...cast.options.flatMap((o) => [o.description, o.preview ?? ""]));
      for (const o of cast.options) lines.push(...(o.preview ?? "").split("\n").filter(Boolean));
      return submit("cast", [cast.options[0]!.label]);
    },
  );
  const screen = asked.join("\n");
  // Two seats of the six can change the code (implementer and tester — a bare
  // "refactor the auth module" earns no planner), and both hold a shell, so the
  // question names both facts before anything is spent rather than folding the
  // shell into the editor count.
  assert.match(
    screen,
    /\b2 of 6 seat\(s\) can change the code, 2 of them with a shell/,
    `the dialog hid who can write:\n${screen}`,
  );
  // Every roster line names its own tier, and the line is the last word on it:
  // a reader who never opens the picker still learns who changes files.
  for (const line of lines) {
    assert.match(
      line,
      /— (read-only|can change the code|can change the code and run commands)$/,
      `no authority on a roster line: ${line}`,
    );
  }
  assert.ok(
    lines.some((l) => l.endsWith("— can change the code and run commands")) && lines.some((l) => l.endsWith("— read-only")),
    `both tiers must be named: ${lines.join(" | ")}`,
  );

  // The zero branch of the same sentence: a cast where nobody edits must not
  // read as "0 of N seat(s)", which implies an editor exists.
  const review: string[] = [];
  await runWithDialog("review the auth module --council 2", (items) => {
    const cast = items.find((i) => i.id === "cast")!;
    review.push(cast.question);
    return submit("cast", [cast.options[0]!.label]);
  });
  assert.match(review.join("\n"), /no seat can change the code/, `the dialog hid who can write:\n${review.join("\n")}`);
});

test("a dry run shows the cast without asking", async () => {
  // The flag means "I would rather read than answer", and the dialog used to
  // fire anyway — so declining a run that writes nothing was reported as an
  // error, and the one screen that cannot change anything still demanded a click.
  const dir = await mkdtemp(join(tmpdir(), "rf-dryrun-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const base = commandCtx(dir, { ask: (items) => submit(items[0]!.id, []) });
  await handler("--dry-run refactor the auth module", base.ctx);
  assert.equal(base.asked.length, 0, "a dry run must not demand an answer");
  assert.ok(
    base.notices.some((n) => n.text.toLowerCase().includes("scout")),
    `the cast must still be shown: ${JSON.stringify(base.notices.map((n) => n.text.slice(0, 60)))}`,
  );
});
