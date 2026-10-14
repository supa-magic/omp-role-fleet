/**
 * Extension wiring: the factory must register its command and tools against the
 * documented ExtensionAPI surface. Exercised with a stub host so the check needs
 * no provider, no session, and no credentials.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import roleFleet, { parseFlags } from "../src/index.ts";

interface StubHost {
  pi: {
    zod: unknown;
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void;
    registerCommand: (name: string, spec: Record<string, unknown>) => void;
    registerTool: (spec: Record<string, unknown>) => void;
    sendMessage: (message: string) => void;
  };
  commands: Map<string, Record<string, unknown>>;
  tools: Map<string, Record<string, unknown>>;
  events: string[];
}

/** Minimal zod stand-in: enough shape for `parameters` to be built. */
function zodStub(): unknown {
  const chain = (): Record<string, unknown> => {
    const api: Record<string, unknown> = {
      describe: () => api,
      optional: () => api,
      int: () => api,
      min: () => api,
      max: () => api,
    };
    return api;
  };
  return {
    // `keys` exists so a test can see which parameters the tool actually
    // declared: a schema that omits a key its execute reads is invisible
    // otherwise, and the parameter silently arrives as undefined.
    object: (shape: Record<string, unknown>) => ({ ...chain(), keys: Object.keys(shape ?? {}) }),
    string: chain,
    number: chain,
    boolean: chain,
  };
}

function stubHost(): StubHost {
  const commands = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, Record<string, unknown>>();
  const events: string[] = [];
  return {
    commands,
    tools,
    events,
    pi: {
      zod: zodStub(),
      on: (event) => events.push(event),
      registerCommand: (name, spec) => commands.set(name, spec),
      registerTool: (spec) => tools.set(String(spec.name), spec),
      sendMessage: () => {},
    },
  };
}

test("factory registers its commands, both tools, and the session hook", () => {
  const host = stubHost();
  roleFleet(host.pi as never);

  assert.deepEqual([...host.commands.keys()].sort(), ["role-fleet", "role-fleet-advisor"]);
  assert.deepEqual([...host.tools.keys()], ["role_fleet_plan"]);
  // tool_call is observed to surface the built-in advisor's notes.
  assert.deepEqual(host.events.sort(), ["session_start", "tool_call"]);
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
  assert.equal(bad.task, "fix the bug");

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

  const good = parseFlags(["fix", "the", "bug", "--allowlist", "~/fleet.json"]);
  assert.equal(good.flags.allowlist, "~/fleet.json");
  assert.deepEqual(good.problems, []);
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