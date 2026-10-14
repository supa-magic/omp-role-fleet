/**
 * Built-in advisor integration.
 *
 * oh-my-pi exposes **no** advisor API to extensions: there is no way to trigger a
 * review, read advisor status, or register a reviewer (`ExtensionAPI` has no
 * advisor method, `ExtensionEvent` has no advisor member, and `src/advisor/` is
 * not re-exported from the package root).
 *
 * What *is* documented is the one touchpoint: an advisor's own tool calls reach
 * the session's `tool_call` / `tool_result` handlers carrying the identity
 * `{ kind: "sub", id: "advisor", name: "advisor", depth: 0 }`. The advisor's only
 * output channel is its `advise` tool, whose arguments carry a `severity` of
 * `nit` | `concern` | `blocker`.
 *
 * So this module observes what it can and refuses to pretend it can do more:
 * it records notes raised against this session and escalates blockers loudly.
 */

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorNote {
  severity: AdvisorSeverity;
  note: string;
  advisor: string;
  at: number;
}

/** Severity ordering used when a single run must report the worst note. */
const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };

export function isAdvisorySeverity(value: unknown): value is AdvisorSeverity {
  return value === "nit" || value === "concern" || value === "blocker";
}

/** Identity the host assigns to an advisor's tool calls. */
export interface ExtensionAgentIdentity {
  kind?: string;
  id?: string;
  name?: string;
}

export function isAdvisorAgent(agent: ExtensionAgentIdentity | undefined): boolean {
  return agent?.id === "advisor" || agent?.name === "advisor";
}

/** Pull `{note, severity}` out of an `advise` tool call's arguments. */
export function readAdvise(args: unknown): { note: string; severity: AdvisorSeverity } | null {
  if (typeof args !== "object" || args === null) return null;
  const a = args as { note?: unknown; severity?: unknown; guidance?: unknown };
  if (typeof a.note !== "string") return null;
  return {
    note: a.note,
    severity: isAdvisorySeverity(a.severity) ? a.severity : "nit",
  };
}

const MAX_NOTES = 50;

/** Session-scoped note buffer; one per extension load. */
const notes: AdvisorNote[] = [];

export function recordNote(note: AdvisorNote): AdvisorNote[] {
  notes.push(note);
  if (notes.length > MAX_NOTES) notes.shift();
  return [...notes];
}

export function recentNotes(limit = 10): AdvisorNote[] {
  return notes.slice(-limit).reverse();
}

/** Clear the buffer — a new session must not inherit the previous one's notes. */
export function resetNotes(): void {
  notes.length = 0;
}

export function worstSeverity(list = notes): AdvisorSeverity | null {
  let worst: AdvisorSeverity | null = null;
  for (const n of list) {
    if (!worst || SEVERITY_RANK[n.severity] > SEVERITY_RANK[worst]) worst = n.severity;
  }
  return worst;
}

export function renderNotes(list = recentNotes()): string {
  if (!list.length) return "No advisor notes recorded in this session.";
  return [
    `Advisor notes (${list.length}, worst ${worstSeverity(list)}):`,
    ...list.map((n) => `  [${n.severity}] ${n.advisor}: ${n.note} · ${new Date(n.at).toLocaleTimeString()}`),
  ].join("\n");
}