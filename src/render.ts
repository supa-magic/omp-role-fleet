/** Compact rendering of a plan, a verdict, and the dispatch groups. */
import { isCouncilMember } from "./core.ts";
import type { GateVerdict, RolePlan, RoleSpec } from "./core.ts";
import type { DispatchGroup, EmittedAgent } from "./agents.ts";

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

/**
 * One line per agent: roster id, role, and the model that runs it.
 *
 * The JSON batch the main model dispatches carries names only (the task tool
 * has no model field), so without this table the concrete model exists in the
 * run and nowhere in the output the user reads.
 */
function renderModelTable(agents: ReadonlyArray<EmittedAgent>, nameOf: Map<string, string>): string[] {
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

/** Markdown the main model acts on: one task batch per wave. */
export function renderDispatch(groups: DispatchGroup[], agentDir: string): string {
  if (!groups.length) return "No roles to dispatch.";
  const lines: string[] = [];
  // Allocated across every wave, not per wave: the roster id is how the main
  // model refers to an agent for the whole run, so uniqueness is a run-level
  // property even though each wave is its own dispatch batch.
  const everyAgent = groups.flatMap((g) => g.agents);
  const names = allocateRosterNames(everyAgent);
  const nameOf = new Map(everyAgent.map((a, i) => [a.agent, names[i]!]));
  groups.forEach((g, i) => {
    const label = g.conflicted
      ? " — dependency conflict: dispatch sequentially and reconcile"
      : g.parallel
        ? " — dispatch as ONE parallel task batch"
        : "";
    lines.push(`### Wave ${g.wave}${label}`, "");
    // `name` becomes the roster id; without it omp invents an AdjectiveNoun
    // name that says nothing about the role. `model` is deliberately absent:
    // the task tool has no such field — the agent definition pins the model,
    // and the roster shows the resolved one.
    lines.push(
      "```json",
      JSON.stringify(
        g.agents.map((a) => ({ name: nameOf.get(a.agent), agent: a.agent })),
        null,
        2,
      ),
      "```",
      "",
    );
    lines.push(`Agent definitions: \`${agentDir}\`.`);
    if (i < groups.length - 1) {
      lines.push(`Wait for wave ${g.wave} to settle before starting wave ${g.wave + 1}.`, "");
    }
  });
  lines.push(...renderModelTable(everyAgent, nameOf));
  // A read-only seat cannot write its own artifact, and the seat brief tells it
  // so — but the brief is written for the subagent, and the brief never reaches
  // the party that would have to act on it. The downstream briefs point at those
  // same paths ("Upstream artifacts"), so without this line the run depends on
  // the main model independently guessing that it is the orchestrator named in
  // the seat's instructions. Naming it here is what makes the contract a channel
  // instead of a convention.
  const readOnly = everyAgent.filter((a) => !a.writesOwnReport);
  if (readOnly.length) {
    lines.push(
      "Read-only seats cannot write their artifact path. After each of these settles,",
      "write its FULL returned `report` (not the summary) to the path below, before",
      "starting the next wave — a downstream seat is told to read that file:",
      "",
      ...readOnly.map((a) => `- \`${nameOf.get(a.agent)}\` → ${a.artifact}`),
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
    "grant, and thinking level are pinned in its file. Dispatch each wave with the",
    "task tool as a single batch, then wait for that wave before starting the next.",
    // The identity is the one part that must be passed through verbatim: the
    // roster `name` is what this table and every later wave address the seat by,
    // and the host's task tool takes no model field, so the pair is the whole
    // item. The host requires `task` on every item and declares `solutionSpace`
    // beside it, while the batch above renders neither — the identity is what
    // must not drift, so it is the only part rendered, and this is where a
    // dispatcher learns the rest of the item is theirs to fill.
    "Pass each item's `name` and `agent` exactly as given — the roster id is what",
    "the table above and every later wave address that seat by — and give it its own",
    "`task` text (the host rejects an item without one) plus a `solutionSpace` line",
    "describing how open-ended that slice is. Do NOT set model, tools, or effort on",
    "the task call: the task tool has no model field (the definition pins it),",
    "treats a tools field as eval-defined tools, and overriding the agent's own",
    "grant is what the definitions exist to prevent.",
    "",
  );
  return lines.join("\n");
}