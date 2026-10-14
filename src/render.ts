/** Compact rendering of a plan, a verdict, and the dispatch groups. */
import type { AdvisorVerdict, RolePlan, RoleSpec } from "./core.ts";
import type { DispatchGroup } from "./agents.ts";

export function renderPlan(plan: RolePlan, waves: RoleSpec[][]): string {
  const lines: string[] = [`Task: ${plan.task}`, ""];
  waves.forEach((wave, i) => {
    lines.push(`Wave ${i + 1}${wave.length > 1 ? ` (parallel x${wave.length})` : ""}:`);
    for (const r of wave) {
      const deps = r.depends_on?.length ? ` ← ${r.depends_on.join(", ")}` : "";
      lines.push(`  • ${r.id} ${r.model}${deps}`);
      lines.push(`      ${r.mission}`);
    }
  });
  if (plan.notes.length) lines.push("", "Notes:", ...plan.notes.map((n) => `  - ${n}`));
  return lines.join("\n");
}

export function renderVerdict(v: AdvisorVerdict): string {
  const lines = [`Gate (${v.source}): ${v.verdict}`];
  if (v.reason) lines.push(`  ${v.reason}`);
  for (const i of v.issues) lines.push(`  ! ${i}`);
  return lines.join("\n");
}

/** Human-readable roster id: role plus the model-role alias it rides. */
function rosterName(a: { role: string; model: string }): string {
  const alias = a.model
    .replace("@", "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const role = a.role
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${role} ${alias}`.slice(0, 32);
}

/** Markdown the main model acts on: one task batch per wave. */
export function renderDispatch(groups: DispatchGroup[], agentDir: string): string {
  if (!groups.length) return "No roles to dispatch.";
  const lines: string[] = [];
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
        g.agents.map((a) => ({ name: rosterName(a), agent: a.agent })),
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
  // Synthesis guidance belongs to the run that has something to synthesize; on a
  // single-scout plan it only invites reasoning about reviewers that do not exist.
  const hasCouncil = groups.some((g) => g.agents.some((a) => /^reviewer-c\d$/.test(a.role)));
  if (hasCouncil) {
    lines.push(
      "When the review council reports arrive, read every one before concluding:",
      "surface agreements and disagreements explicitly, and treat the most conservative",
      "finding as the verdict — a risk one reviewer saw is a risk, even if the others missed it.",
      "",
    );
  }
  return lines.join("\n");
}