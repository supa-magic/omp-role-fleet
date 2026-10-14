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

/** Command context stub: records what the user would actually have been told. */
function commandCtx(cwd: string, idle = true): {
  ctx: Record<string, unknown>;
  notices: Array<{ text: string; level: string }>;
} {
  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd,
    agent: { name: "advisor" },
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
    isIdle: () => idle,
  };
  return { ctx, notices };
}

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

test("factory registers its commands, both tools, and the session hook", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  assert.deepEqual([...host.commands.keys()].sort(), ["role-fleet", "role-fleet-advisor"]);
  assert.deepEqual([...host.tools.keys()], ["role_fleet_plan"]);
  // tool_call is observed to surface the built-in advisor's notes.
  assert.deepEqual(host.events.sort(), ["session_start", "tool_call"]);
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

test("the command dispatches an approved plan to an idle session as a triggered turn", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const handler = host.commands.get("role-fleet")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const { ctx, notices } = commandCtx(dir, true);
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
  const { ctx } = commandCtx(dir, false);
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

test("the advisor command reports the buffer and clears on a new session", async () => {
  const host = stubHost();
  roleFleet(host.pi as never);
  const show = host.commands.get("role-fleet-advisor")!.handler as (
    args: string,
    ctx: unknown,
  ) => Promise<void>;

  const dir = await mkdtemp(join(tmpdir(), "rf-cmd-"));
  const empty = commandCtx(dir);
  await show("", empty.ctx);
  assert.ok(empty.notices.some((n) => n.text.includes("No advisor notes")));

  // Feed a note through the real tool_call handler the factory registered.
  const onToolCall = hostToolCall(host);
  onToolCall({ toolName: "advise", input: { note: "watch the gate", severity: "concern" } });
  const after = commandCtx(dir);
  await show("", after.ctx);
  assert.ok(after.notices.some((n) => n.text.includes("watch the gate")));

  // session_start resets process-level state; a new session starts empty.
  hostSessionStart(host);
  const reset = commandCtx(dir);
  await show("", reset.ctx);
  assert.ok(
    reset.notices.some((n) => n.text.includes("No advisor notes")),
    "advisor notes must not leak into the next session",
  );
});

/** Invoke the `tool_call` handler the factory registered on the stub host. */
function hostToolCall(host: StubHost): (event: { toolName: string; input: unknown }) => void {
  const entry = host.handlers.get("tool_call");
  assert.ok(entry, "the factory must register a tool_call observer");
  return (event) => entry(event, { agent: { kind: "sub", id: "advisor", name: "advisor" }, ui: { notify: () => {} } });
}

function hostSessionStart(host: StubHost): void {
  const entry = host.handlers.get("session_start");
  assert.ok(entry, "the factory must register a session_start hook");
  entry({}, { ui: { notify: () => {} } });
}

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
  for (const key of ["task", "maxRoles", "allowlist", "dryRun", "specialist", "council"]) {
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
  assert.ok(completions("cap")?.some((c) => c.value.startsWith("--max-roles")));
  assert.ok(completions("allow")?.some((c) => c.value.startsWith("--allowlist")));

  // A nonsense prefix yields null, not an empty list.
  assert.equal(completions("zzz"), null);
});