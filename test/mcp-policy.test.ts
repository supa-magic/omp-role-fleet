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
import {
  isAllowedMcpTool,
  isMcpToolName,
  isReadOnlyToolset,
  mcpAllowlistFromEnv,
  mcpGuardVerdict,
  parseMcpAllowlist,
  MCP_ALLOWLIST_ENV,
} from "../src/mcp-policy.ts";
import { BUILD_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../src/core.ts";

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

test("the shipped grants sit on the right side of the read-only line", () => {
  // The fixtures above are local copies; the guard has to agree with the grants
  // the cast actually hands out, or a read seat loses its MCP guard (or a writer
  // gets policed) the day either list grows.
  assert.equal(isReadOnlyToolset(READ_TOOLS), true);
  assert.equal(isReadOnlyToolset(WRITE_TOOLS), false);
  assert.equal(isReadOnlyToolset(BUILD_TOOLS), false);
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

test("a hand-written agent is never policed, whatever its grant", () => {
  // README promise: generated agents are `rf-*` only and hand-written agents
  // are never touched — a read-only hand-written agent keeps its MCP tools.
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "sub",
    agentName: "my-reviewer",
    seatTools: READ_ONLY_SEAT,
    allowlist: [],
  });
  assert.equal(verdict.block, false);
});

test("a seat whose grant cannot be read is guarded, not trusted", () => {
  // Fail closed: a run record that is gone and a definition that says nothing
  // leave nothing to prove the seat may not write. Leaving it alone is how a
  // "read-only" seat ends up holding every connected MCP tool.
  const verdict = mcpGuardVerdict({
    toolName: "mcp__linear_create_issue",
    agentKind: "sub",
    agentName: "rf-scout",
    seatTools: undefined,
    allowlist: [],
  });
  assert.equal(verdict.block, true);
  assert.match(verdict.reason ?? "", /rf-scout/);
  assert.match(verdict.reason ?? "", /ROLE_FLEET_MCP_READONLY/);
});

test("an allowed MCP tool passes even when the grant cannot be read", () => {
  // The operator allowed the tool by name: that is the way through the guard.
  const verdict = mcpGuardVerdict({
    toolName: "mcp__codesearch_search",
    agentKind: "sub",
    agentName: "rf-scout",
    seatTools: undefined,
    allowlist: ["mcp__codesearch_"],
  });
  assert.equal(verdict.block, false);
});
