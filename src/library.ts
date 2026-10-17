/**
 * Specialist catalog — hand-written seats beyond the base cast.
 *
 * The base cast (scout/planner/implementer/tester/reviewer/docs-updater) covers
 * generic engineering. These specialists exist for shapes where a generic seat
 * is measurably the wrong worker: UI work, security audit, dependency
 * migration. Deterministic, zero model calls, and each one is still just a
 * RoleSpec — the rest of the pipeline treats it like any other role.
 */
import type { Effort, RoleSpec } from "./core.ts";
import { READ_TOOLS, WRITE_TOOLS } from "./core.ts";

export interface Specialist {
  /** Matched against the task text; a specialist joins the plan when it hits. */
  match: RegExp;
  /** Replaces the implementer instead of adding a role (migration case). */
  replacesImplementer?: boolean;
  /** Static description for the emitted agent's frontmatter. */
  description: string;
  spec: Omit<RoleSpec, "dependsOn" | "artifact"> & { dependsOn?: string[] };
}

export const SPECIALISTS: Specialist[] = [
  {
    match: /\b(landing|ui|ux|design|mockup|wireframe|layout|frontend page|web page)\b/i,
    description:
      "Role-fleet designer: implement/refine the interface with accessibility and visual quality. Write access.",
    spec: {
      id: "designer",
      title: "Designer",
      core: "designer",
      mission: "Deliver the interface for this task: layout, states, accessibility, and visual polish.",
      acceptance: [
        "Interface renders correctly in the target surface",
        "Keyboard navigation and contrast checked",
        "No unrelated visual regressions",
      ],
      tools: WRITE_TOOLS,
      effort: "medium" as Effort,
      needsVision: true,
      // `@designer` is not a stock omp model role: it only resolves when the
      // user has a `modelRoles.designer` entry, and otherwise the host falls
      // back to the parent session's model. Documented in the README.
      model: "@designer",
      dependsOn: ["scout"],
    },
  },
  {
    match: /\b(security|vulnerab|pentest|injection|xss|csrf|exploit|threat model)\b/i,
    description:
      "Role-fleet security auditor: read-only vulnerability discovery over the target surface, with evidence.",
    spec: {
      id: "security-auditor",
      title: "Security auditor",
      core: "security",
      mission:
        "Audit the security of the surface this task touches: untrusted input paths, auth boundaries, secrets handling.",
      acceptance: [
        "Each finding names the vulnerability class and file:line",
        "Severity and a concrete remediation stated per finding",
        "No files modified",
      ],
      tools: READ_TOOLS,
      effort: "high" as Effort,
      needsVision: false,
      model: "@slow",
      dependsOn: [],
    },
  },
  {
    match: /\b(migrat\w*|port from|upgrade (the )?(deps|dependencies|framework)|move off)\b/i,
    replacesImplementer: true,
    description:
      "Role-fleet migration runner: execute a dependency/framework migration in ordered, verifiable steps.",
    spec: {
      id: "migration-runner",
      title: "Migration runner",
      core: "implementer",
      mission:
        "Run the migration in ordered steps: map usage, migrate, fix fallout, and prove parity with the focused checks.",
      acceptance: [
        "Every migrated call site listed",
        "Focused checks pass on the migrated code",
        "No behavior change beyond the migration",
      ],
      tools: WRITE_TOOLS,
      effort: "high" as Effort,
      needsVision: false,
      model: "@task",
      dependsOn: ["scout"],
    },
  },
];

/**
 * Wire specialists into a drafted plan.
 *
 * A specialist joins the cast only when its pattern hits; a `replacesImplementer`
 * specialist swaps the generic implementer out (a migration is implementation —
 * running both would double-write the same files). Dependencies drop silently
 * when their target is absent from the plan.
 */
export function applySpecialists(
  roles: RoleSpec[],
  task: string,
  workDir: string,
  notes: string[],
  has: (id: string) => boolean,
  /** The plan was deliberately reduced to analysis (`--review-only`, or an
   *  audit that dropped the writer). Write seats are then out of the question. */
  analysisOnly = false,
): RoleSpec[] {
  let next = [...roles];
  for (const specialist of SPECIALISTS) {
    if (!specialist.match.test(task)) continue;

    if (specialist.replacesImplementer) {
      const index = next.findIndex((r) => r.id === "implementer");
      if (index === -1) {
        notes.push(`${specialist.spec.id}: task has no implementer to replace; skipped`);
        continue;
      }
      next.splice(index, 1, toRole(specialist, workDir, has));
      // The tester, reviewer and docs updater still point at "implementer".
      // They now wait on the specialist that stands in for it — leaving the
      // removed id behind would fail validation for the whole plan.
      next = next.map((r) =>
        (r.dependsOn ?? []).includes("implementer")
          ? { ...r, dependsOn: (r.dependsOn ?? []).map((d) => (d === "implementer" ? specialist.spec.id : d)) }
          : r,
      );
      notes.push(`implementer replaced by ${specialist.spec.id}`);
      continue;
    }

    if (next.some((r) => r.id === specialist.spec.id)) continue;
    // A write-granting specialist needs a plan that may implement something.
    // A cast can be writer-free two different ways: a task that never asked
    // for code (a landing page — where the designer *is* the implementation and
    // must join), or a plan trimmed to analysis on purpose. Only the second
    // blocks a writer. Keying on "does a writer already exist" would have
    // defeated the audit thinning one line after it ran, and killed the
    // designer for exactly the task it exists to serve.
    const grants = specialist.spec.tools ?? [];
    if (analysisOnly && grants.some((t) => t === "write" || t === "edit")) {
      notes.push(`${specialist.spec.id}: analysis-only plan; no write seat added`);
      continue;
    }
    next.push(toRole(specialist, workDir, has));
    notes.push(`specialist ${specialist.spec.id} added`);
  }
  return next;
}

function toRole(specialist: Specialist, workDir: string, has: (id: string) => boolean): RoleSpec {
  const depends = (specialist.spec.dependsOn ?? []).filter(has);
  const { dependsOn: _dropped, ...rest } = specialist.spec;
  return { ...rest, dependsOn: depends, artifact: `${workDir}/${specialist.spec.id}.md` };
}

/** Static frontmatter descriptions for library seats (see agents.ts). */
export const SPECIALIST_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  SPECIALISTS.map((s) => [s.spec.id, s.description]),
);