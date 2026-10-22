/**
 * The MCP guard: which MCP tools a read-only seat may call.
 *
 * The host has no read-only tier for MCP — every MCP tool is minted
 * write-tier, a definition's `tools:` list governs built-ins only, and
 * subagents run unattended (`approvalMode: "yolo"`). So a seat the consent
 * screen called read-only still holds every connected MCP tool, and the
 * plugin's job is to refuse the ones the operator did not allow.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedMcpTool,
  isMcpToolName,
  isReadOnlyToolset,
  mcpAllowlistFromEnv,
  mcpGuardVerdict,
  parseMcpAllowlist,
  recordSeatToolset,
  resetSeatToolsets,
  seatToolset,
  MCP_ALLOWLIST_ENV,
} from "../src/mcp-policy.ts";

const READ_ONLY_SEAT = ["read", "grep", "glob", "find", "ast_grep"];
const WRITER_SEAT = ["read", "grep", "glob", "find", "ast_grep", "edit", "write", "bash"];

test("an MCP tool name is recognised by its minted prefix", () => {
  assert.equal(isMcpToolName("mcp__codesearch_search"), true);
  assert.equal(isMcpToolName("read"), false);
  assert.equal(isMcpToolName("find"), false);
});

test("the allowlist is comma-separated prefixes", () => {
  assert.deepEqual(parseMcpAllowlist("mcp__codesearch_,mcp__linear_"), ["mcp__codesearch_", "mcp__linear_"]);
  assert.deepEqual(parseMcpAllowlist(" mcp__a_ , ,mcp__b_ "), ["mcp__a_", "mcp__b_"]);
  assert.deepEqual(parseMcpAllowlist(undefined), []);
  assert.deepEqual(parseMcpAllowlist(""), []);
});

test("the allowlist comes from the environment the operator set", () => {
  assert.deepEqual(mcpAllowlistFromEnv({ [MCP_ALLOWLIST_ENV]: "mcp__codesearch_" }), ["mcp__codesearch_"]);
  assert.deepEqual(mcpAllowlistFromEnv({}), []);
  assert.equal(isAllowedMcpTool("mcp__codesearch_search", ["mcp__codesearch_"]), true);
  assert.equal(isAllowedMcpTool("mcp__linear_create_issue", ["mcp__codesearch_"]), false);
});

test("a seat is read-only when every tool it declares is read-tier", () => {
  assert.equal(isReadOnlyToolset(READ_ONLY_SEAT), true);
  assert.equal(isReadOnlyToolset(WRITER_SEAT), false);
  // An empty grant is not "harmless" — the host reads it as "no built-ins".
  assert.equal(isReadOnlyToolset([]), false);
  assert.equal(isReadOnlyToolset(undefined), false);
});

test("a read-only seat may not call an MCP tool the operator did not allow", () => {
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "sub",
    agentName: "rf-scout",
    seatTools: READ_ONLY_SEAT,
    allowlist: ["mcp__codesearch_"],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason ?? "", /rf-scout/);
  assert.match(verdict.reason ?? "", /ROLE_FLEET_MCP_READONLY/);
  // The reason has to say how the name is spelled: the operator copies the
  // prefix out of the seat's tool list, where the server name is sanitized.
  assert.match(verdict.reason ?? "", /as it appears in the seat's tool list/);
  assert.match(verdict.reason ?? "", /mcp__codesearch_/);
});

test("an allowed MCP tool passes a read-only seat's guard", () => {
  const verdict = mcpGuardVerdict({
    toolName: "mcp__codesearch_search",
    agentKind: "sub",
    agentName: "rf-scout",
    seatTools: READ_ONLY_SEAT,
    allowlist: ["mcp__codesearch_"],
  });
  assert.equal(verdict.block, false);
});

test("a seat that may write keeps its MCP tools", () => {
  // The guard is about read-only seats: a writer seat may change the tree
  // anyway, so refusing its MCP tools would buy nothing.
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "sub",
    agentName: "rf-implementer",
    seatTools: WRITER_SEAT,
    allowlist: [],
  });
  assert.equal(verdict.block, false);
});

test("the main session keeps its own MCP tools", () => {
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "main",
    agentName: "main",
    seatTools: READ_ONLY_SEAT,
    allowlist: [],
  });
  assert.equal(verdict.block, false);
});

test("a built-in call is never touched by the MCP guard", () => {
  const verdict = mcpGuardVerdict({
    toolName: "read",
    agentKind: "sub",
    agentName: "rf-scout",
    seatTools: READ_ONLY_SEAT,
    allowlist: [],
  });
  assert.equal(verdict.block, false);
});

test("an unknown seat is left alone rather than guessed at", () => {
  // No toolset means no grant to judge: a guard that guesses blocks seats it
  // knows nothing about, which is the worse failure.
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "sub",
    agentName: "some-other-agent",
    seatTools: undefined,
    allowlist: [],
  });
  assert.equal(verdict.block, false);
});

test("a seat's toolset is read from the run that minted it", async () => {
  resetSeatToolsets();
  recordSeatToolset("rf-scout", READ_ONLY_SEAT);
  assert.deepEqual(await seatToolset("rf-scout", "/nonexistent"), READ_ONLY_SEAT);
  resetSeatToolsets();
  assert.equal(await seatToolset("rf-scout", "/nonexistent"), undefined);
});

test("a seat minted by an earlier run is read from its definition file", async () => {
  // A restarted session has no in-process record of the cast; the definition
  // file is the only thing that says what the seat was granted.
  resetSeatToolsets();
  const dir = await mkdtemp(join(tmpdir(), "rf-mcp-def-"));
  await mkdir(join(dir, ".omp", "agents"), { recursive: true });
  await writeFile(
    join(dir, ".omp", "agents", "rf-reviewer-c1.md"),
    ["---", 'name: "rf-reviewer-c1"', 'tools: ["read", "grep", "glob", "find", "ast_grep"]', "---", "", "body"].join("\n"),
    "utf8",
  );
  assert.deepEqual(await seatToolset("rf-reviewer-c1", dir), READ_ONLY_SEAT);
  // And a writer seat reads as writable.
  await writeFile(
    join(dir, ".omp", "agents", "rf-implementer.md"),
    ["---", 'name: "rf-implementer"', 'tools: ["read", "grep", "edit", "write", "bash"]', "---"].join("\n"),
    "utf8",
  );
  const writer = await seatToolset("rf-implementer", dir);
  assert.equal(isReadOnlyToolset(writer), false);
});
