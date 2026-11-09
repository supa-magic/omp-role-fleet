/**
 * Which MCP tools a read-only seat may call.
 *
 * The host has no read-only tier for MCP: every MCP tool is minted with
 * `approval = "write"` (`mcp/tool-bridge.ts`), and a definition's `tools:` list
 * governs built-ins only — MCP, extension and custom tools stay additive
 * (`docs/task-agent-discovery.md`). A seat declared read-only therefore still
 * holds every connected MCP tool, and a subagent runs with
 * `tools.approvalMode: "yolo"` (`task/executor.ts`), so a write-capable MCP
 * tool would execute unattended — behind a consent screen that said the seat
 * could not write.
 *
 * This module is the plugin-side half of that gap: a read-only seat may call
 * only the MCP tools the operator allowed by name. Everything else is refused
 * before it runs, with a reason the model can act on. A seat whose grant
 * cannot be read at all is refused too — a grant that cannot be shown to be
 * harmless is not a licence to hold every connected MCP tool.
 */
import { AGENT_PREFIX } from "./core.ts";

/** MCP tool names are minted `mcp__<server>_<tool>`. */
const MCP_TOOL_PREFIX = "mcp__";

/** Environment variable holding the allowed MCP tool prefixes, comma-separated. */
export const MCP_ALLOWLIST_ENV = "ROLE_FLEET_MCP_READONLY";

/**
 * Built-in tools whose approval tier is "read".
 *
 * Mirrors the host's own set (`task/read-only-policy.ts`): a seat is read-only
 * iff every tool it declares sits in this tier. Kept as a copy because the
 * plugin decides read-only-ness for seats it minted, and the host's constant is
 * not exported to extensions.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "wait",
  "grep",
  "glob",
  "find",
  "web_search",
  "ast_grep",
  "yield",
  "ask",
  "todo",
  "recall",
  "reflect",
  "retain",
  "memory_edit",
  "checkpoint",
  "rewind",
]);

/** Whether a tool name is an MCP tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Parse the allowlist: comma-separated tool-name prefixes.
 *
 * Prefixes rather than exact names because an MCP server's tool set is
 * discovered at connect time — the operator names the server (`mcp__codesearch_`)
 * and every tool it publishes is covered. Blank entries are dropped, and a
 * trailing comma is not an error.
 */
export function parseMcpAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The allowlist the operator configured, from the environment. */
export function mcpAllowlistFromEnv(env: Record<string, string | undefined>): string[] {
  return parseMcpAllowlist(env[MCP_ALLOWLIST_ENV]);
}

/** Whether a tool is covered by the allowlist. */
export function isAllowedMcpTool(toolName: string, allowlist: readonly string[]): boolean {
  return allowlist.some((prefix) => toolName.startsWith(prefix));
}

/**
 * Whether a seat's toolset is read-only.
 *
 * The same rule the host uses to label an agent read-only: a non-empty set of
 * declared tools, every one of them in the read tier. An empty set is not
 * read-only — a seat with no tools cannot be trusted to be harmless, and the
 * host treats the empty case as "no built-ins", not as "harmless".
 */
export function isReadOnlyToolset(tools: readonly string[] | undefined): boolean {
  return !!tools?.length && tools.every((tool) => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Whether a seat's grant lets it change the tree.
 *
 * The guard's question is narrower than the host's "is this seat read-only":
 * it is "may this seat write?". A seat that cannot — or whose grant could not
 * be read at all — is exactly the seat the guard exists for.
 */
export function seatMayWrite(tools: readonly string[] | undefined): boolean {
  return !!tools?.length && !isReadOnlyToolset(tools);
}

/** The decision the guard reaches for one tool call. */
export interface McpGuardVerdict {
  block: boolean;
  /** Why the call was refused — surfaced to the model as the tool error. */
  reason?: string;
}

/** The facts the guard needs about one call. */
export interface McpGuardInput {
  /** The tool being called. */
  toolName: string;
  /** The calling session's agent kind: `"main"` or `"sub"`. */
  agentKind: "main" | "sub";
  /** The calling agent's definition name, e.g. `rf-scout`. */
  agentName: string;
  /** The tools that seat was granted, when known. */
  seatTools?: readonly string[];
  /** The operator's allowlist of MCP tool prefixes. */
  allowlist: readonly string[];
}

/**
 * The refusal a seat sees, and how to lift it.
 *
 * The operator allows a tool by name, so the reason says exactly how the name
 * is spelled: the prefix is copied out of the seat's tool list, where the
 * server name is sanitized.
 */
function refusal(input: McpGuardInput, why: string): McpGuardVerdict {
  const allow = input.allowlist.length ? input.allowlist.join(", ") : "(none configured)";
  return {
    block: true,
    reason:
      `role-fleet: \`${input.toolName}\` is not available to the seat \`${input.agentName}\`. ` +
      `${why} MCP tools are write-tier to the host and seats run unattended, so a seat that may not ` +
      `write may only use the MCP tools the operator allowed (${allow}). Allow it with ` +
      `${MCP_ALLOWLIST_ENV}=<tool-prefix>[,<tool-prefix>…] — the prefix is the tool name as it ` +
      `appears in the seat's tool list (server names are lowercased and every character outside ` +
      `a-z0-9_ becomes _), e.g. \`${MCP_ALLOWLIST_ENV}=mcp__codesearch_\` for the codesearch ` +
      `server, or the exact tool name \`${input.toolName}\`. A seat that may write is not affected.`,
  };
}

/**
 * Whether one tool call may proceed.
 *
 * Only MCP calls in generated seats are ever refused. A writer seat keeps its
 * MCP tools (it may change the tree anyway) and the main session keeps its own
 * (the host's consent screen governs those).
 *
 * A seat whose grant cannot be read is refused rather than trusted: the run
 * record is gone and its definition file says nothing, so nothing proves the
 * seat may not write. Failing open there is how a "read-only" seat ends up
 * holding every connected MCP tool — the exact gap this guard closes.
 */
export function mcpGuardVerdict(input: McpGuardInput): McpGuardVerdict {
  if (!isMcpToolName(input.toolName)) return { block: false };
  if (input.agentKind !== "sub") return { block: false };
  // Hand-written agents are never this plugin's to police.
  if (!input.agentName.startsWith(AGENT_PREFIX)) return { block: false };
  // The operator allowed this tool by name: it passes for every seat.
  if (isAllowedMcpTool(input.toolName, input.allowlist)) return { block: false };
  if (!input.seatTools?.length) {
    return refusal(
      input,
      "Its tool grant could not be read, so it cannot be shown to be harmless.",
    );
  }
  if (seatMayWrite(input.seatTools)) return { block: false };
  return refusal(input, "It is read-only.");
}
