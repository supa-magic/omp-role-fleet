/**
 * Extension wiring: the factory must register its command and tools against the
 * documented ExtensionAPI surface. Exercised with a stub host so the check needs
 * no provider, no session, and no credentials.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import roleFleet, { parseFlags } from "../src/index.ts";
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

function stubHost(): StubHost {
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
      sendMessage: (message: string, opts?: unknown) => sent.push({ message, opts }),
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

/** Invoke the `tool_result` handler the factory registered on the stub host. */
function hostToolResult(
  host: StubHost,
  event: { toolName: string; details: unknown },
  agent: { kind: string } = { kind: "main" },
): Array<{ text: string; level: string }> {
  const entry = host.handlers.get("tool_result");
  assert.ok(entry, "the factory must register a tool_result observer");
  const notices: Array<{ text: string; level: string }> = [];
  entry(event, { agent, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } });
  return notices;
}

test("the tool_result observer turns a settled fallback into a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-observer-"));
  const host = stubHost();
  roleFleet(host.pi as never);

  // Plan and emit through the real tool path, which records the expectation
  // baseline the observer compares against.
  const tool = host.tools.get("role_fleet_plan")!;
  const execute = tool.execute as (
    id: string,
    params: Record<string, unknown>,
    a: unknown,
    b: unknown,
    ctx: unknown,
  ) => Promise<{ isError?: boolean }>;
  assert.equal((await execute("id", { task: "fix the auth bug" }, null, null, { cwd: dir })).isError, undefined);

  const settled = {
    results: [
      {
        index: 0,
        id: "job-1",
        agent: "rf-reviewer-c1",
        exitCode: 0,
        output: "",
        resolvedModel: "xai/grok-4:high",
        resolvedModelIsFallback: true,
      },
    ],
  };

  const warned = hostToolResult(host, { toolName: "task", details: settled });
  assert.equal(warned.length, 1, `a fallback must notify: ${JSON.stringify(warned)}`);
  assert.equal(warned[0]!.level, "warning", "a fallback is not an info line");
  assert.match(warned[0]!.text, /rf-reviewer-c1/);
  assert.match(warned[0]!.text, /ran `xai\/grok-4`/);
  assert.match(warned[0]!.text, /FALLBACK/);

  // A non-task tool carrying the same payload is not a fleet result.
  assert.deepEqual(hostToolResult(host, { toolName: "bash", details: settled }), []);

  // A subagent session's own task calls are not the parent's fleet.
  assert.deepEqual(hostToolResult(host, { toolName: "task", details: settled }, { kind: "sub" }), []);

  // The same settled seat is not re-notified within one dispatch.
  assert.deepEqual(hostToolResult(host, { toolName: "task", details: settled }), []);
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

  // A blank consul is no consul — and with no consul there is no reason to hand
  // the council repo-wide write.
  const consul = await execute("id", { task: "review the auth fix", council: 3, consul: "  ", dryRun: true }, null, null, at);
  assert.ok(!/\bConsul\b/.test(consul.content[0].text), `a blank consul was seated: ${consul.content[0].text}`);
  assert.ok(!/repo-wide write/.test(consul.content[0].text), "no consul means no write grant");
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
  assert.match(text, /Pass each item's `name` and `agent` exactly as given/);
  assert.match(text, /`task` text/);
  assert.match(text, /solutionSpace/);
  assert.match(text, /Do NOT/);
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

test("factory registers its command, its tool, and the session hooks", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  assert.deepEqual([...host.commands.keys()], ["role-fleet"]);
  assert.deepEqual([...host.tools.keys()], ["role_fleet_plan"]);
  // session_start scopes the observation baseline; tool_result reads the model
  // each settled seat actually ran on, which the plan alone cannot say.
  assert.deepEqual(host.events.sort(), ["session_start", "tool_result"]);
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

test("a child session must not wipe the parent's model baseline; a new session must", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rf-reset-"));
  const host = stubHost();
  roleFleet(host.pi as never);

  // Plan through the real command path with a host that resolves aliases, so a
  // concrete baseline exists to lose.
  const resolver = { resolve: (spec: string) => ({ provider: "mock", id: spec.replace("@", "role-") }) };
  const { ctx, notices } = commandCtx(dir, { models: resolver });
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("fix the auth bug", ctx);
  assert.equal(notices.length > 0, true, "the command must have planned");

  const diverged = (model: string) => ({
    results: [{ index: 0, id: "job-1", agent: "rf-reviewer", exitCode: 0, output: "", resolvedModel: model }],
  });

  // Extension factories rebind to every subagent session, and each of those
  // fires `session_start`. A reset from a child would hand the parent a run with
  // no baseline mid-flight, silencing every later divergence.
  host.handlers.get("session_start")!({}, { agent: { kind: "sub", name: "task" }, ui: { notify: () => {} } });
  assert.equal(hostToolResult(host, { toolName: "task", details: diverged("other-a/model") }).length, 1);

  // A real new session starts clean: the previous run's plan is not this run's
  // expectation, and reporting against it would be a false alarm.
  host.handlers.get("session_start")!({}, { agent: { kind: "main", name: "main" }, ui: { notify: () => {} } });
  assert.deepEqual(hostToolResult(host, { toolName: "task", details: diverged("other-b/model") }), []);
});

test("a child session planning must not overwrite the parent's baseline", async () => {
  // The `session_start` and `tool_result` hooks both carry the sub-agent guard, and
  // the record path did not. A council member that holds the plan tool — a write
  // grant is exactly what makes that likely — clears the parent's baseline
  // mid-flight, and every later divergence for the parent's seats degrades to
  // "no plan-time baseline for this seat".
  const dir = await mkdtemp(join(tmpdir(), "rf-child-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const resolve = { resolve: (spec: string) => ({ provider: "mock", id: spec.replace("@", "role-") }) };

  const parent = commandCtx(dir, { models: resolve });
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  await handler("fix the auth bug", parent.ctx);

  // The child plans its own fleet in the same process.
  const child = commandCtx(dir, { models: resolve, kind: "sub" });
  await handler("review the auth bug", child.ctx);

  // `rf-implementer` is in the parent's build plan and in no review-only plan, so
  // the seat is only still measured if the child left the baseline alone. A seat
  // both plans share (`rf-reviewer`) cannot tell the two cases apart: the child's
  // own record would re-establish a baseline and hide the clobber.
  const diverged = {
    results: [{ index: 0, id: "job-1", agent: "rf-implementer", exitCode: 0, output: "", resolvedModel: "other/model" }],
  };

  // A parent seat settling on a different model is still measured against the
  // parent's plan, so it reports a named baseline instead of losing it.
  const notices = hostToolResult(host, { toolName: "task", details: diverged });
  assert.equal(notices.length, 1, "the parent's divergence went unreported");
  assert.ok(!notices[0]!.text.includes("no plan-time baseline"), notices[0]!.text);
  assert.match(notices[0]!.text, /planned `mock\/role-/, notices[0]!.text);
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
  for (const key of ["task", "maxRoles", "allowlist", "dryRun", "council", "models", "consul", "reviewOnly"]) {
    assert.ok(declared.includes(key), `role_fleet_plan does not declare "${key}": ${declared.join(", ")}`);
  }
});

test("the banner version is the published version", () => {
  // PLUGIN_VERSION is a hand-kept copy of package.json#version, and it is what
  // `/role-fleet --version` and the session banner show. When the two drift, the
  // first thing a user reports is "the plugin says it is a different version".
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const declared = /PLUGIN_VERSION = "([^"]+)"/.exec(src)?.[1];
  assert.ok(declared, "src/index.ts must declare PLUGIN_VERSION");
  assert.equal(declared, pkg.version);

  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
    packages: Record<string, { name?: string; version?: string }>;
  };
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""]?.version, pkg.version);
  // A rename that misses the lockfile leaves `npm ci` installing this package
  // under its old name, which then disagrees with every artifact it builds.
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""]?.name, pkg.name);
});

test("a non-numeric flag is reported instead of silently becoming NaN", () => {
  // NaN council switches the feature off; NaN role cap empties the plan into an
  // opaque "plan has no roles" rejection. Both must be visible to the user.
  const bad = parseFlags(["--council=abc", "--max-roles", "zero", "fix the bug"]);
  assert.equal(bad.flags.council, undefined);
  assert.equal(bad.flags.maxRoles, undefined);
  assert.equal(bad.problems.length, 2);
  // The bad value is refused, not silently deleted from what the user typed: a
  // word that is not a number is task text, and losing it would plan against a
  // task the user never gave. The two problems above are what says "I did not
  // understand --max-roles".
  assert.equal(bad.task, "zero fix the bug");

  const good = parseFlags(["--council", "--max-roles=6", "fix the bug"]);
  assert.equal(good.flags.council, 3);
  assert.equal(good.flags.maxRoles, 6);
  assert.deepEqual(good.problems, []);
});

test("a trailing valueless flag names the missing value, not an empty string", () => {
  // `--max-roles` as the last word has no value at all. Reporting it through the
  // numeric path printed `(got "")` — quoting an argument the user never typed
  // and sending them hunting for one they had already decided not to write —
  // and it said so twice for a single flag.
  const trailing = parseFlags(["fix the bug", "--max-roles"]);
  assert.equal(trailing.flags.maxRoles, undefined);
  assert.equal(trailing.problems.length, 1, `one flag, one problem: ${trailing.problems.join(" | ")}`);
  assert.match(trailing.problems[0]!, /--max-roles needs a positive whole number/);
  assert.ok(!trailing.problems[0]!.includes('""'), `must not quote an empty string: ${trailing.problems[0]}`);
  assert.equal(trailing.task, "fix the bug");

  // A word after the flag is named verbatim, and stays task text — the other
  // half of the same rule.
  const follower = parseFlags(["--max-roles", "zero", "fix the bug"]);
  assert.equal(follower.problems.length, 1, `one flag, one problem: ${follower.problems.join(" | ")}`);
  assert.match(follower.problems[0]!, /got "zero"/);
  assert.equal(follower.task, "zero fix the bug");
});

test("flag values are consumed, not left to contaminate the task text", () => {
  // `--council 5` used to leave `5` in the task, and the task lands in every
  // emitted agent body and in the keyword heuristics.
  const council = parseFlags(["--council", "5", "fix", "the", "bug"]);
  assert.equal(council.flags.council, 3, "council size is capped at the alias pool");
  assert.equal(council.task, "fix the bug");
  assert.equal(council.problems.length, 1, "clamping is visible, not silent");

  // A value must never eat the next flag: swallowing `--dry-run` here means the
  // run writes agent files the user explicitly asked not to write.
  const dryRun = parseFlags(["--max-roles", "--dry-run", "fix", "the", "bug"]);
  assert.equal(dryRun.flags.dryRun, true);
  assert.equal(dryRun.flags.maxRoles, undefined);
  assert.equal(dryRun.problems.length, 1);
  assert.equal(dryRun.task, "fix the bug");

  // Out-of-range is clamped, not honoured.
  const capped = parseFlags(["--max-roles=500", "fix", "the", "bug"]);
  assert.equal(capped.flags.maxRoles, 8);
  assert.equal(capped.problems.length, 1);
});

test("--models takes a bracketed list in order, task text stays intact", () => {
  const listed = parseFlags(["--models", "(xai/grok-4,zai/glm-5,@slow)", "fix", "the", "bug"]);
  assert.deepEqual(listed.flags.models, ["xai/grok-4", "zai/glm-5", "@slow"]);
  assert.equal(listed.task, "fix the bug", "the model list must not leak into the task");
  assert.deepEqual(listed.problems, []);

  // The task can sit anywhere, including last, which is how it reads best:
  // `/role-fleet --council --models (a,b) refactor the auth module`.
  // The host splits on whitespace, so a spaced list arrives as three words and
  // must be read until the brackets balance.
  const spaced = parseFlags(["--models", "(xai/grok-4,", "zai/glm-5,", "anthropic/claude-opus-4-6)", "fix the bug"]);
  assert.deepEqual(spaced.flags.models, ["xai/grok-4", "zai/glm-5", "anthropic/claude-opus-4-6"]);
  assert.equal(spaced.task, "fix the bug");
  assert.deepEqual(spaced.problems, []);

  const promptLast = parseFlags(["--council", "--models", "(xai/grok-4, zai/glm-5)", "refactor the auth module"]);
  assert.deepEqual(promptLast.flags.models, ["xai/grok-4", "zai/glm-5"], "spaces inside the brackets are trimmed");
  assert.equal(promptLast.task, "refactor the auth module");
  assert.deepEqual(promptLast.problems, []);

  // Quotes survive the host's whitespace-only split, so they have to be stripped.
  const quoted = parseFlags(["--models", '"(a/1,@task)"', "fix the bug"]);
  assert.deepEqual(quoted.flags.models, ["a/1", "@task"]);
  assert.equal(quoted.task, "fix the bug");

  const inline = parseFlags(["--models=(xai/grok-4,zai/glm-5)", "fix the bug"]);
  assert.deepEqual(inline.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.deepEqual(inline.problems, []);

  // A bare id has no `,`, `/`, or `@` to identify it, and the brackets say
  // where the list ends instead — the reason the form exists.
  const bare = parseFlags(["--models", "(glm-5)", "fix the bug"]);
  assert.deepEqual(bare.flags.models, ["glm-5"]);
  assert.deepEqual(bare.problems, []);
});

test("--models never eats a word that is not bracketed", () => {
  // The brackets are the safety mechanism: without them, deciding whether the
  // next word is the list or the first word of the task is a guess, and
  // `--models fix the login bug` would put reviewers on a model called `fix`
  // and drop the task's first word. An unbracketed follower is left alone.
  const eaten = parseFlags(["--models", "fix", "the", "login", "bug"]);
  assert.equal(eaten.flags.models, undefined);
  // The wording names what was actually wrong. With no bracket anywhere the scan
  // walked the whole rest of the line, so echoing `collected` would throw the
  // user's entire task back at them as if it were a malformed list; the no-bracket
  // case names the one word that was not a list, and the partial-bracket case
  // below reports the list it really did see.
  assert.match(eaten.problems[0] ?? "", /--models needs a bracketed list like \(a,b,c\), got "fix"/);
  assert.ok(!(eaten.problems[0] ?? "").includes("login"), `the whole task was echoed: ${eaten.problems[0]}`);
  assert.equal(eaten.task, "fix the login bug", "nothing the user typed may disappear");

  // A value must never eat the next flag.
  const nextFlag = parseFlags(["--models", "--dry-run", "fix the bug"]);
  assert.equal(nextFlag.flags.models, undefined);
  assert.equal(nextFlag.flags.dryRun, true);
  assert.equal(nextFlag.problems.length, 1);
  assert.equal(nextFlag.task, "fix the bug");

  const bare = parseFlags(["--models", "fix the bug"]);
  assert.equal(bare.flags.models, undefined);
  assert.equal(bare.problems.length, 1);
  assert.equal(bare.task, "fix the bug");

  // An unclosed bracket is not a list: nothing is consumed and the words stay
  // task text, with the reason reported.
  const unclosed = parseFlags(["--models", "(a,b", "fix the bug"]);
  assert.equal(unclosed.flags.models, undefined);
  assert.equal(unclosed.task, "(a,b fix the bug");
  assert.match(unclosed.problems[0] ?? "", /balanced bracketed list/);

  const empty = parseFlags(["--models=()", "fix the bug"]);
  assert.equal(empty.flags.models, undefined);
  assert.match(empty.problems[0] ?? "", /nothing usable/);
  assert.equal(empty.task, "fix the bug");

  // Inline, the brackets are optional — so an unbalanced one is the only
  // signal that the list was cut short. Splitting it anyway would pin a
  // selector like `(a` the host cannot resolve, and the seat would silently
  // ride the parent model instead.
  const cut = parseFlags(["--models=(a,b", "fix the bug"]);
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /unbalanced bracket list/);
  assert.equal(cut.task, "fix the bug");
});

test("--models=(a, b) finishes the list the host split in two", () => {
  // The host splits on whitespace, so a bracketed value in the `=` form arrives
  // as two words — `--models=(a,` and `b)`. Reading only the first refused the
  // list *and* left `b)` in the task text, while the spaced spelling of the same
  // list planned fine: the flag's meaning depended on how it was typed.
  const split = parseFlags(["--models=(xai/grok-4,", "zai/glm-5)", "fix the bug"]);
  assert.deepEqual(split.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.equal(split.task, "fix the bug", "the rest of the list must not become task text");
  assert.deepEqual(split.problems, []);

  // A bracket no later word closes is a list cut short, not one the host split:
  // the value is the single word, and the refusal names the bracket.
  const cut = parseFlags(["--models=(xai/grok-4,", "fix", "the", "bug"]);
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /unbalanced bracket list/);
  assert.equal(cut.task, "fix the bug", "nothing the user typed may disappear");
});

test("--models collapses duplicates and caps the list", () => {
  // Two council members on one model is the double-priced single review this
  // feature exists to avoid; spawning it silently would read as two opinions.
  const dupes = parseFlags(["--models", "(xai/grok-4,xai/grok-4,zai/glm-5)", "fix the bug"]);
  assert.deepEqual(dupes.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.match(dupes.problems[0] ?? "", /duplicates dropped/);

  const many = parseFlags(["--models", "(a/1,b/2,c/3,d/4,e/5,f/6)", "fix the bug"]);
  assert.equal(many.flags.models?.length, 5);
  assert.match(many.problems[0] ?? "", /capped at 5/);
});

test("an allowlist without a usable path is refused instead of falling through", () => {
  // Falling through to ROLE_FLEET_ALLOWLIST would pin a file the user never
  // named; falling through to nothing would silently run unpinned.
  const bare = parseFlags(["fix", "the", "bug", "--allowlist"]);
  assert.equal(bare.flags.allowlist, undefined);
  assert.equal(bare.problems.length, 1);
  assert.equal(bare.task, "fix the bug");

  const empty = parseFlags(["fix", "the", "bug", "--allowlist="]);
  assert.equal(empty.flags.allowlist, undefined);
  assert.equal(empty.problems.length, 1);

  // A prompt is not a shell, so `~` is expanded here — `readFile` cannot.
  const good = parseFlags(["fix", "the", "bug", "--allowlist", "~/fleet.json"]);
  assert.equal(good.flags.allowlist, join(homedir(), "fleet.json"));
  assert.deepEqual(good.problems, []);

  const inline = parseFlags(["fix", "the", "bug", "--allowlist=~/fleet.json"]);
  assert.equal(inline.flags.allowlist, join(homedir(), "fleet.json"));
});

test("a numeric flag with no number leaves the task text intact", () => {
  // `--max-roles fix the bug` used to swallow "fix" as the cap: the cap was
  // then rejected as non-numeric and the task lost its first word, so the user
  // was warned about a correct flag and the plan ran on a mutilated task.
  const missing = parseFlags(["--max-roles", "fix", "the", "bug"]);
  assert.equal(missing.flags.maxRoles, undefined);
  assert.equal(missing.task, "fix the bug");
  assert.equal(missing.problems.length, 1);

  // A real number is still consumed, not left in the task.
  const real = parseFlags(["fix", "the", "bug", "--max-roles", "3"]);
  assert.equal(real.flags.maxRoles, 3);
  assert.equal(real.task, "fix the bug");
  assert.deepEqual(real.problems, []);

  // Same rule for the council: a bare `--council` still means 3, but a
  // non-numeric follower is the task, not a council size.
  const bare = parseFlags(["review", "the", "auth", "code", "--council"]);
  assert.equal(bare.flags.council, 3);
  assert.equal(bare.task, "review the auth code");

  // A typo must not silently become the largest council the plugin can run.
  const worded = parseFlags(["review", "the", "auth", "code", "--council", "loudly"]);
  assert.equal(worded.flags.council, 3, "the default council still runs");
  assert.equal(worded.task, "review the auth code loudly");
  assert.ok(
    worded.problems.some((p) => p.includes("--council") && p.includes("loudly")),
    `a mistyped council size must be reported: ${worded.problems.join(" | ")}`,
  );

  // And the cap reports the word it choked on, not an empty string.
  const capWord = parseFlags(["fix", "the", "bug", "--max-roles", "four"]);
  assert.ok(
    capWord.problems.some((p) => p.includes("four")),
    `the cap error must name the word: ${capWord.problems.join(" | ")}`,
  );
  assert.equal(capWord.task, "fix the bug four", "the word stays task text");
});

test("an unknown flag is reported, not silently absorbed into the task", () => {
  // A typo'd `--dryrun` used to become task text and reached the brief of every
  // emitted agent. It must still be reported; the word is kept so nothing the
  // user typed disappears.
  const typo = parseFlags(["fix", "the", "bug", "--dryrun"]);
  assert.equal(typo.flags.dryRun, false);
  assert.equal(typo.task, "fix the bug --dryrun");
  assert.ok(
    typo.problems.some((p) => p.includes("--dryrun")),
    `an unknown flag must be reported: ${typo.problems.join(" | ")}`,
  );

  // A known flag is not reported as unknown.
  assert.ok(!parseFlags(["fix", "the", "bug", "--dry-run"]).problems.some((p) => p.includes("unknown")));
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
): Promise<{ sent: string; notices: Array<{ text: string; level: string }> }> {
  const dir = await mkdtemp(join(tmpdir(), "rf-dialog-"));
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (args: string, ctx: unknown) => Promise<void>;
  const base = commandCtx(dir, { ask });
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

test("the cast screen names who can write before anything is spent", async () => {
  // A `--consul` run grants the council repo-wide write so their reports reach
  // the deciding seat. That grant used to be invisible on the screen asking for
  // consent: the roster showed models only, and per-seat authority sat one
  // dialog deeper, on the deliberately non-default path.
  const asked: string[] = [];
  await runWithDialog(
    "refactor the auth module --models (xai/grok-4,zai/glm-5) --consul anthropic/claude-opus-4-6",
    (items) => {
      const cast = items.find((i) => i.id === "cast")!;
      asked.push(cast.question, ...cast.options.flatMap((o) => [o.description, o.preview ?? ""]));
      return submit("cast", [cast.options[0]!.label]);
    },
  );
  const screen = asked.join("\n");
  assert.match(screen, /repo-wide write/, `the dialog hid the write grant:\n${screen}`);
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
