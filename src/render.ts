/** Compact rendering of a plan, a verdict, and the dispatch groups. */
import { isCouncilMember, isSliceSeat, type TaskEffort } from "./core.ts";
import type { GateVerdict, RolePlan, RoleSpec } from "./core.ts";
import type { DispatchGroup } from "./agents.ts";

/**
 * Model label for a role: the concrete `provider/id` when the host resolved
 * the alias, the selector itself otherwise.
 *
 * The alias alone (`@slow`) says nothing about which model actually answers:
 * the same alias points at a different model per provider, and the host may
 * fall back to another one mid-run. A readable label carries the concrete id;
 * the roster id and the run table both use it.
 */
function modelLabel(a: { model: string; modelResolved?: string }): string {
  return a.modelResolved ?? a.model;
}

export function renderPlan(plan: RolePlan, waves: RoleSpec[][]): string {
  const lines: string[] = [`Task: ${plan.task}`, ""];
  waves.forEach((wave, i) => {
    lines.push(`Wave ${i + 1}${wave.length > 1 ? ` (parallel x${wave.length})` : ""}:`);
    for (const r of wave) {
      const deps = r.dependsOn?.length ? ` ← ${r.dependsOn.join(", ")}` : "";
      const model = r.modelResolved ? `${r.modelResolved} (${r.model})` : r.model;
      lines.push(`  • ${r.id} ${model}${deps}`);
      lines.push(`      ${r.mission}`);
    }
  });
  if (plan.notes.length) lines.push("", "Notes:", ...plan.notes.map((n) => `  - ${n}`));
  return lines.join("\n");
}

export function renderVerdict(v: GateVerdict): string {
  const lines = [`Gate: ${v.verdict}`];
  if (v.reason) lines.push(`  ${v.reason}`);
  for (const i of v.issues) lines.push(`  ! ${i}`);
  return lines.join("\n");
}

/** `payment-domain-a` → `PaymentDomainA`. */
function camel(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Short model token for the roster id: the model id without its provider and
 * version noise — `xai/grok-4` → `Grok4`, `anthropic/claude-sonnet-4-6` →
 * `ClaudeSonnet46`. A roster id is capped at 32 characters, so the bare
 * `provider/id` never fits; the full selector is one line above the roster.
 */
function shortModel(selector: string): string {
  const id = selector.includes("/") ? selector.slice(selector.lastIndexOf("/") + 1) : selector;
  return camel(id);
}

/**
 * Human-readable roster id: role plus the model it rides.
 *
 * With a resolved model the concrete token replaces the alias, so the id reads
 * `ReviewerC1 Grok4` rather than `ReviewerC1 Slow` — the alias is two different
 * things (`@slow` may be one model today and another after a `/model` switch),
 * and the roster is what the main model reports back to the user. Unresolved
 * agents keep the alias label, so the id is never half-empty.
 */
function rosterName(a: { role: string; model: string; modelResolved?: string }): string {
  const role = camel(a.role);
  if (a.modelResolved) {
    const model = shortModel(a.modelResolved);
    return model && model !== role ? `${role} ${model}` : role;
  }
  const alias = a.model.startsWith("@") ? camel(a.model.slice(1)) : shortModel(a.model);
  return alias && alias !== role ? `${role} ${alias}` : role;
}

/**
 * The roster id budget. The `task` tool *declares* `name: CamelCase ≤32` in its
 * own prompt but enforces only presence, effort, and case-insensitive
 * uniqueness, so this cap is ours to keep and nothing upstream would catch a
 * longer id.
 */
const ROSTER_LIMIT = 32;

/**
 * Roster ids for a whole run, allocated once so no two agents share one.
 *
 * The id is the thing the main model addresses agents by, so truncation that
 * makes two of them equal is worse than a longer id: two generated roles
 * sharing a long prefix on the same alias would both become `PaymentDomainA…`,
 * and the reviewer would have no way to say which is which. Collisions get a
 * numeric suffix and a tighter truncation rather than a silent duplicate.
 */
function allocateRosterNames(agents: ReadonlyArray<{ role: string; model: string; modelResolved?: string }>): string[] {
  const used = new Set<string>();
  return agents.map((a) => {
    const base = rosterName(a).slice(0, ROSTER_LIMIT);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = `${rosterName(a).slice(0, ROSTER_LIMIT - suffix.length)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  });
}

/** One dispatchable seat, with the run-level roster name the main model uses. */
export interface DispatchItem {
  name: string;
  agent: string;
  role: string;
  model: string;
  modelResolved?: string;
  /** Task-tool `lo`|`med`|`hi` — must ride the spawn so seat effort wins over modelRoles. */
  effort: TaskEffort;
  artifact: string;
  dependsOn: string[];
  /** Roster names this seat waits on: it starts once every one has delivered. */
  after: string[];
  writesOwnReport: boolean;
}

export interface DispatchPlanGroup {
  wave: number;
  parallel: boolean;
  conflicted: boolean;
  agents: DispatchItem[];
}

/**
 * The machine-readable dispatch plan, with the roster names allocated once
 * across the run. `wave` is the dependency depth, kept for display; the
 * scheduling contract is each item's `after`: a seat starts when every seat it
 * lists has delivered, not when its whole wave has. Tool callers get this in
 * `details` so they do not have to parse prose for renames or artifact paths.
 */
export function dispatchPlan(groups: DispatchGroup[]): DispatchPlanGroup[] {
  const everyAgent = groups.flatMap((g) => g.agents);
  const names = allocateRosterNames(everyAgent);
  const nameOfRole = new Map(everyAgent.map((a, i) => [a.role, names[i]!]));
  let next = 0;
  return groups.map((g) => ({
    wave: g.wave,
    parallel: g.parallel,
    conflicted: g.conflicted === true,
    agents: g.agents.map((a) => ({
      name: names[next++]!,
      agent: a.agent,
      role: a.role,
      model: a.model,
      ...(a.modelResolved ? { modelResolved: a.modelResolved } : {}),
      effort: a.effort,
      artifact: a.artifact,
      dependsOn: [...a.dependsOn],
      after: a.dependsOn.map((d) => nameOfRole.get(d)).filter((n): n is string => n !== undefined),
      writesOwnReport: a.writesOwnReport,
    })),
  }));
}

/**
 * One line per agent: roster id, role, and the model that runs it.
 *
 * The JSON batch carries `name`/`agent`/`effort` only (the task tool has no
 * model field), so without this table the concrete model exists in the run and
 * nowhere in the output the user reads.
 */
function renderModelTable(
  agents: ReadonlyArray<{ agent: string; role: string; model: string; modelResolved?: string }>,
  nameOf: Map<string, string>,
): string[] {
  return [
    "Models in this run (roster id → role → model):",
    "",
    ...agents.map((a) => {
      const label = modelLabel(a);
      // An allowlist pins a concrete selector, so echoing it back as the pinned
      // value would just repeat the line.
      const pinned = a.model !== label ? ` (pinned as \`${a.model}\`)` : "";
      return `- \`${nameOf.get(a.agent)}\` — ${a.role} on \`${label}\`${pinned}`;
    }),
    "",
  ];
}

/**
 * Markdown the main model acts on: seats start as soon as their own
 * dependencies have delivered, not when a whole wave has.
 *
 * A wave barrier makes a seat wait on unrelated siblings of its dependency: a
 * reviewer that needs only the scout sat behind a ten-minute security audit in
 * the same wave. Readiness per seat is the critical path the plan actually
 * has. Seats that become ready together still go out as one batch.
 */
export function renderDispatch(groups: DispatchGroup[], agentDir: string): string {
  if (!groups.length) return "No roles to dispatch.";
  const lines: string[] = [];
  // Allocated across the run: the roster id is how the main model refers to a
  // seat for the whole run, and dependencies are stated in roster ids.
  const planned = dispatchPlan(groups);
  const everyAgent = planned.flatMap((g) => g.agents);
  const nameOf = new Map(everyAgent.map((a) => [a.agent, a.name]));
  const conflicted = planned.filter((g) => g.conflicted).flatMap((g) => g.agents);
  const scheduled = everyAgent.filter((a) => !conflicted.includes(a));
  const now = scheduled.filter((a) => a.after.length === 0);
  const later = scheduled.filter((a) => a.after.length > 0);

  // `name` becomes the roster id; `model` is absent (the definition pins it);
  // `effort` is present because only a caller effort beats a modelRoles suffix.
  const block = (seats: DispatchItem[]): string[] => [
    "```json",
    JSON.stringify(seats.map((a) => ({ name: a.name, agent: a.agent, effort: a.effort })), null, 2),
    "```",
    "",
  ];
  const batchLabel = (seats: DispatchItem[]): string => (seats.length > 1 ? " — dispatch as ONE parallel task batch" : "");
  lines.push(`### Start now${batchLabel(now)}`, "", ...block(now));
  if (later.length) {
    // Seats waiting on the same set become ready at the same moment, so they
    // share one batch. Results auto-deliver per seat (`wait` returns on the
    // FIRST settled seat), so readiness is checked as each result arrives.
    const byAfter = new Map<string, DispatchItem[]>();
    for (const a of later) {
      const key = a.after.join("\u0000");
      byAfter.set(key, [...(byAfter.get(key) ?? []), a]);
    }
    lines.push(
      "### Then, as dependencies deliver",
      "",
      "Start each batch below as soon as every seat it names has delivered its result —",
      "do not hold it for seats it does not name, and do not wait for a whole wave.",
      "",
    );
    for (const seats of byAfter.values()) {
      lines.push(`#### After ${seats[0]!.after.map((n) => `\`${n}\``).join(", ")}${batchLabel(seats)}`, "", ...block(seats));
    }
  }
  if (conflicted.length) {
    lines.push(
      "### Seats in a dependency conflict — dispatch sequentially and reconcile",
      "",
      "These seats wait on each other; start them one at a time after every seat above has delivered:",
      "",
      ...block(conflicted),
    );
  }
  lines.push(`Agent definitions: \`${agentDir}\`.`, "");
  lines.push(...renderModelTable(everyAgent, nameOf));
  // The plugin places a read-only seat's report from the seat's own session
  // when it yields, so the main model never re-types a full report between
  // waves — that was one output-bound turn per read-only seat on the critical
  // path. The fallback stays named, because a seat that failed to yield the
  // schema leaves no file and its downstream seats are told to read one.
  const readOnly = everyAgent.filter((a) => !a.writesOwnReport);
  if (readOnly.length) {
    lines.push(
      "Read-only seats cannot write their artifact path; the plugin writes each one's full",
      "`report` there when the seat yields. Do not copy reports yourself. Only if a path below",
      "is still missing after its seat settled, write that seat's FULL `report` there",
      "before dispatching the seats that wait on it:",
      "",
      ...readOnly.map((a) => `- \`${nameOf.get(a.agent)}\` → ${a.artifact}`),
      "",
    );
  }
  // A fanned-out implementation needs the partition named item by item, and only
  // the orchestrator can name it: the file map arrives with the scout's report,
  // which is read before the wave is dispatched. Two writer seats on one file is
  // the defect the cast is arranged to avoid, so the assignment is stated rather
  // than left to the seats to negotiate.
  const sliceSeats = everyAgent.filter((a) => isSliceSeat(a.role));
  if (sliceSeats.length > 1) {
    lines.push(
      `This run fans the implementation out across ${sliceSeats.length} writer seats:`,
      ...sliceSeats.map((a) => `- \`${nameOf.get(a.agent)}\``),
      "",
      "Give each one the exact files it owns — from the scout's map — and tell it to touch",
      "no path outside that set. They start together: two seats that were not told",
      "apart will edit the same files.",
      "",
    );
  }
  // Every generated agent declares this schema, so a report that arrives
  // without `report` did not fail to run — it came back as a summary, which is
  // exactly the case where the council cannot reach a decision on its own.
  lines.push(
    "Read each agent's FULL returned report before concluding anything: its",
    "`report` field is the complete deliverable (findings, evidence, per-item",
    "detail) and `summary` is a headline, never a substitute. When a result",
    "arrives as a truncated `<preview>` with `full-output: agent://<id>`, read",
    "that URI instead of the preview.",
    "",
  );
  // Synthesis guidance belongs to the run that has something to synthesize; on a
  // single-scout plan it only invites reasoning about reviewers that do not exist.
  const hasCouncil = groups.some((g) => g.agents.some((a) => isCouncilMember(a.role)));
  if (hasCouncil) {
    const hasConsul = groups.some((g) => g.agents.some((a) => a.role === "consul"));
    lines.push(
      ...(hasConsul
        ? [
            // With a consul seat the synthesis is a dispatched agent's job, and
            // a second opinion from the session model would undercut the very
            // independence the council exists for.
            "A `consul` seat reconciles the council's reports and writes the verdict:",
            "do not synthesize the verdict yourself from their reports. Read its",
            "`consul.md` once it settles, and report what it decided.",
            "",
          ]
        : [
            "When the review council reports arrive, read every one before concluding:",
            "surface agreements and disagreements explicitly, and treat the most conservative",
            "finding as the verdict — a risk one reviewer saw is a risk, even if the others missed it.",
            "",
          ]),
    );
  }
  // The guardrails live here rather than in the command's wrapper because both
  // surfaces render their batch through this function: the command hands the
  // text to the main model, and the model tool's caller *is* the main model —
  // the party most likely to add a `model:` to a task call. Two surfaces
  // differing in what they warn about is the asymmetry this closes.
  lines.push(
    "Every agent above already exists as an omp agent definition whose model, tool",
    "grant, and thinking level are pinned in its file. Dispatch with the task tool,",
    "one batch per set of seats that are ready together. Seat results are delivered",
    "to you automatically as each seat finishes — do not poll `wait` for them (a",
    "`wait` call returns on the FIRST settled seat and each call re-renders the same",
    "\"waiting on N jobs\" panel). Call `wait` only when you are completely blocked and",
    "have nothing else to do. A seat starts once every seat it lists has delivered",
    "its result.",
    // Identity + effort must pass through verbatim. The host requires `task` on
    // every item and declares `solutionSpace` beside it; `effort` is the only
    // spawn field that can beat a modelRoles thinking suffix, so it is rendered
    // in the batch and must not be invented or dropped.
    "Pass each item's `name`, `agent`, and `effort` exactly as given — the roster",
    "id is what the table above and every later batch address that seat by, and",
    "`effort` is the seat's thinking budget (`lo`/`med`/`hi`) the host applies over",
    "modelRoles suffixes. Give each item its own `task` text (the host rejects an",
    "item without one) plus a `solutionSpace` line describing how open-ended that",
    "slice is. Do NOT set model or tools on the task call: the task tool has no",
    "model field (the definition pins it), treats a tools field as eval-defined",
    "tools, and overriding the agent's own grant is what the definitions exist to",
    "prevent. Do NOT invent or omit `effort` — copy the value from the batch.",
    "",
  );
  return lines.join("\n");
}