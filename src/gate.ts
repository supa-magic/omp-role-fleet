/**
 * Static gate — the plan's own pass/fail check before anything is written.
 *
 * Named `gate`, not `advisor`, because oh-my-pi's built-in advisor is a
 * different thing entirely; that one is observed in `advisor-watch.ts`. This
 * module validates the plan and returns a verdict. Nothing else.
 *
 * omp's own advisor reviews the dispatch once the main model runs it; this pass
 * catches what must never reach the model: empty plans, unknown dependencies,
 * missing acceptance or artifacts. In allowlist mode `bindFleet` has already
 * swapped every described seat for a selector from the file; the gate only
 * checks what binding cannot express.
 *
 * The reject branch is defensive by design. Every plan reaching it comes from
 * `synthesizePlan`, the proposal sandbox or `bindFleet`, all of which emit
 * already-valid shapes — so `validatePlan` finding an error there means a
 * generator regressed, not that a user asked for something impossible. It is
 * tested here directly; it is not reachable from the command or the tool.
 */
import type { GateVerdict, Fleet, RolePlan } from "./core.ts";
import { bindFleet, validatePlan } from "./core.ts";

export interface GateResult {
  plan: RolePlan | null;
  verdict: GateVerdict;
  ok: boolean;
}

export function gatePlan(plan: RolePlan, fleet?: Fleet): GateResult {
  let checked = plan;
  const notes = [...plan.notes];

  if (fleet) {
    checked = { ...checked, roles: bindFleet(fleet, checked.roles, notes) };
  }

  const errors = validatePlan(checked);
  if (errors.length) {
    return {
      plan: null,
      ok: false,
      verdict: { verdict: "reject", reason: "plan failed static validation", issues: errors },
    };
  }
  return {
    plan: { ...checked, notes },
    ok: true,
    verdict: { verdict: "approve", reason: "static validation passed", issues: [] },
  };
}