/**
 * Static gate. omp's own advisor reviews the dispatch once the main model runs
 * it; this pass catches what must never reach the model: empty plans, unknown
 * dependencies, missing acceptance or artifacts. In allowlist mode `bindFleet`
 * has already swapped every described seat for a selector from the file; the
 * gate only checks what binding cannot express.
 */
import type { AdvisorVerdict, Fleet, RolePlan } from "./core.ts";
import { bindFleet, validatePlan } from "./core.ts";

export interface GateResult {
  plan: RolePlan | null;
  verdict: AdvisorVerdict;
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
      verdict: { verdict: "reject", reason: "plan failed static validation", issues: errors, source: "static" },
    };
  }
  return {
    plan: { ...checked, notes },
    ok: true,
    verdict: { verdict: "approve", reason: "static validation passed", issues: [], source: "static" },
  };
}