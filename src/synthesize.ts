/**
 * Role synthesis: task text → a small set of roles with omp model-role aliases.
 *
 * No configuration is consulted. The fan-out is deliberately conservative: a
 * task gets only the roles its shape implies, and the cap bounds the worst case
 * on a vague request.
 */
import type { Effort, RolePlan, RoleSpec } from "./core.ts";
import { applySpecialists } from "./library.ts";
import { aliasFor } from "./core.ts";

const READ_TOOLS = ["read", "grep", "glob"];
const WRITE_TOOLS = ["read", "grep", "glob", "edit", "write"];

const CODE_HINT = /\b(code|bug|fix|refactor|implement|function|test|api|module|crate|rust|typescript|python)\b/i;
const RESEARCH_HINT = /\b(research|compare|market|competitor|docs?|upstream|library|version|price)\b/i;
const REVIEW_HINT = /\b(review|audit|security|check|verify|vulnerab)/i;
const MULTI_FILE_HINT = /\b(refactor|migrat|across|several files|multi-file|suite|whole repo)\b/i;
const IMAGE_HINT = /\b(screenshot|image|ui|ux|design|visual|layout|render)\b/i;
const DOCS_HINT = /\b(document|readme|changelog)\b/i;

type Capability = "scout" | "plan" | "code" | "test" | "review" | "docs";

/** Drop order when the cap bites: implementation is never dropped first. */
const KEEP_PRIORITY: Record<Capability, number> = {
  code: 0,
  scout: 1,
  review: 2,
  plan: 3,
  test: 4,
  docs: 5,
};

/**
 * Alias order for a review council.
 *
 * Distinct aliases mean distinct models in any sane `modelRoles` setup, and —
 * when those aliases are mapped to different providers — distinct providers too,
 * which is the point: the same blind spot is unlikely across providers.
 */
const COUNCIL_ALIAS = ["@slow", "@task", "@plan"];

const EFFORT: Record<Capability, Effort> = {
  scout: "low",
  plan: "high",
  code: "medium",
  test: "medium",
  review: "high",
  docs: "low",
};

export interface PlanOptions {
  task: string;
  cwd: string;
  /** Directory the role artifacts and briefs are written under. */
  workDir: string;
  maxRoles?: number;
  /**
   * Council size: replace the single reviewer with N reviewers on distinct
   * model-role aliases (and therefore, in a normal setup, distinct providers),
   * all reviewing the same change in one parallel wave.
   */
  council?: number;
}

export function synthesizePlan(opts: PlanOptions): RolePlan {
  const { task, cwd, workDir } = opts;
  const maxRoles = opts.maxRoles ?? 4;
  const notes: string[] = [];

  const wantsCode = CODE_HINT.test(task);
  const wantsPlan = wantsCode && MULTI_FILE_HINT.test(task);
  const wantsReview = REVIEW_HINT.test(task) || MULTI_FILE_HINT.test(task) || wantsCode;
  const needsVision = IMAGE_HINT.test(task);

  const caps: Capability[] = wantsCode
    ? ["scout", ...(wantsPlan ? (["plan"] as Capability[]) : []), "code", "test"]
    : ["scout"];
  if (RESEARCH_HINT.test(task) && !wantsCode) caps.push("docs");
  if (wantsReview) caps.push("review");
  if (DOCS_HINT.test(task) && wantsCode) caps.push("docs");

  const unique = [...new Set(caps)];
  const kept = [...unique]
    .sort((a, b) => KEEP_PRIORITY[a] - KEEP_PRIORITY[b])
    .slice(0, maxRoles)
    .sort((a, b) => unique.indexOf(a) - unique.indexOf(b));
  const dropped = unique.filter((c) => !kept.includes(c));
  if (dropped.length) notes.push(`role cap ${maxRoles}: dropped ${dropped.join(", ")}`);
  const has = (c: Capability): boolean => kept.includes(c);

  let drafts: RoleSpec[] = [];
  for (const cap of kept) {
    // Capability names differ from seat names in three places.
    const CORE: Record<Capability, string> = {
      scout: "scout",
      plan: "planner",
      code: "implementer",
      test: "tester",
      review: "reviewer",
      docs: "docs-updater",
    };
    const core = CORE[cap];
    const dep = (id: string): string[] => (drafts.some((d) => d.id === id) ? [id] : []);
    const base = {
      core,
      model: aliasFor(core),
      effort: EFFORT[cap],
      needs_vision: cap === "scout" ? needsVision : false,
    };
    const draft = {
      scout: {
        id: "scout",
        title: "Investigator",
        mission: `Locate every place this task touches and report current behavior with file:line evidence: ${task}`,
        acceptance: ["Affected files/symbols mapped with evidence", "No files modified"],
        depends_on: [] as string[],
        tools: READ_TOOLS,
        artifact: `${workDir}/scout.md`,
      },
      plan: {
        id: "planner",
        title: "Planner",
        mission: "Turn the investigation into a locked implementation plan with exact files and ordered steps.",
        acceptance: ["Ordered steps naming exact files", "Open questions listed explicitly"],
        depends_on: dep("scout"),
        tools: READ_TOOLS,
        artifact: `${workDir}/plan.md`,
      },
      code: {
        id: "implementer",
        title: "Implementer",
        mission: "Implement the locked plan. Smallest correct change; do not expand scope.",
        acceptance: ["Requested behavior implemented", "Focused check executed and its real output reported"],
        depends_on: dep("planner").length ? ["planner"] : dep("scout"),
        tools: WRITE_TOOLS,
        artifact: `${workDir}/implementation.md`,
      },
      test: {
        id: "tester",
        title: "Tester",
        mission: "Run the focused checks for the delivered change and report real output.",
        acceptance: ["Exact commands run", "Real pass/fail output", "Failures reproduced, not assumed"],
        depends_on: dep("implementer"),
        tools: WRITE_TOOLS,
        artifact: `${workDir}/test-report.md`,
      },
      review: {
        id: "reviewer",
        title: "Reviewer",
        mission: "Review the delivered change for correctness, scope, and evidence. Read-only.",
        acceptance: ["Findings with file:line or explicit verdict", "No files modified"],
        depends_on: dep("implementer"),
        tools: READ_TOOLS,
        artifact: `${workDir}/review.md`,
      },
      docs: {
        id: "docs-updater",
        title: "Docs updater",
        mission: wantsCode
          ? "Update user-facing documentation to match the delivered behavior."
          : `Research and summarize: ${task}`,
        acceptance: wantsCode
          ? ["Docs match shipped behavior", "Documented commands verified against code"]
          : ["Every claim backed by a primary source"],
        depends_on: wantsCode ? dep("implementer") : [],
        tools: wantsCode ? WRITE_TOOLS : READ_TOOLS,
        artifact: `${workDir}/docs.md`,
      },
    }[cap];
    drafts.push({ ...draft, ...base } as RoleSpec);
  }

  if (wantsCode && !drafts.some((d) => d.id === "implementer")) {
    notes.push("role cap left no implementer; plan is analysis-only");
  }

  // An audit-shaped task with no build verbs is analysis: the implementer and
  // tester were drafted only because words like "api" hit the code hint, and
  // keeping them would push the auditor out at the cap — the one role this
  // task exists for.
  const SECURITY_SHAPE = /\b(security|vulnerab|pentest|injection|xss|csrf|exploit|threat model|audit)\b/i;
  const BUILD_VERB = /\b(fix|implement|write|add|build|refactor|migrat\w*|create|port)\b/i;
  if (SECURITY_SHAPE.test(task) && !BUILD_VERB.test(task)) {
    const before = drafts.map((r) => r.id);
    const thinned = drafts.filter((r) => r.id !== "implementer" && r.id !== "tester");
    if (thinned.length !== before.length) {
      drafts = thinned;
      notes.push("audit-shaped task: implementer/tester dropped for the auditor");
    }
  }

  // Specialist tier: hand-written seats for shapes the base cast serves poorly.
  // The cap applies after: a specialist never squeezes the implementer out.
  const drafted = applySpecialists(
    drafts,
    task,
    workDir,
    notes,
    (id) => drafts.some((d) => d.id === id),
  );

  // A removed role takes the edges pointing at it along: the audit thinning and
  // a replacing specialist both drop a role other roles still wait on, and one
  // dangling edge makes `validatePlan` reject the entire plan — no agents, no
  // dispatch, no partial result. Dependents wait on the scout instead.
  const surviving = new Set(drafted.map((r) => r.id));
  for (const r of drafted) {
    const dangling = (r.depends_on ?? []).filter((d) => !surviving.has(d));
    if (!dangling.length) continue;
    // Edges that survived stay; only the dead ones are replaced, so a role
    // waiting on two things does not lose the one that is still planned.
    const kept = (r.depends_on ?? []).filter((d) => surviving.has(d));
    const fallback = kept.length ? kept : surviving.has("scout") ? ["scout"] : [];
    notes.push(
      `role ${r.id}: dependency ${dangling.join(", ")} left the plan${fallback.length ? ` — waiting on ${fallback.join(", ")} instead` : ""}`,
    );
    r.depends_on = fallback;
  }

  // Council: one change, several pairs of eyes from different providers. It
  // runs after the cast is final, so a member inherits an upstream that exists
  // rather than one a thinning pass deleted two lines ago. Reviewers with
  // distinct aliases ride the same wave, so the reviews are concurrent and
  // independent; synthesis is the main model's job, guided by the dispatch
  // prompt.
  const council = Math.min(opts.council ?? 0, COUNCIL_ALIAS.length);
  if (council > 1) {
    const reviewer = drafted.find((d) => d.id === "reviewer");
    if (reviewer) {
      drafted.splice(drafted.indexOf(reviewer), 1);
    }
    // An analysis-only plan has no reviewer to replace — the council IS the
    // review, so its members join after the scout instead of being dropped
    // because "there was nothing to review". `depends_on: []` is a real answer,
    // not a missing one, so the fallback keys off the length, never `??`.
    const upstream =
      reviewer?.depends_on?.length
        ? reviewer.depends_on
        : drafted.some((d) => d.id === "scout")
          ? ["scout"]
          : [];
    const baseMission =
      reviewer?.mission ??
      `Assess the subject of this task and report findings with evidence.`;
    for (let i = 0; i < council; i++) {
      drafted.push({
        id: `reviewer-c${i + 1}`,
        title: `Reviewer ${i + 1}`,
        core: "reviewer",
        mission: `${baseMission} Independent pass ${i + 1} of ${council}; the other reviewers do not see your report.`,
        acceptance: reviewer?.acceptance ?? [
          "Findings with file:line or an explicit verdict",
          "No files modified",
        ],
        depends_on: upstream,
        tools: READ_TOOLS,
        effort: "high",
        needs_vision: false,
        model: COUNCIL_ALIAS[i],
        artifact: `${workDir}/review-c${i + 1}.md`,
      });
    }
    notes.push(`council of ${council}: ${COUNCIL_ALIAS.slice(0, council).join(", ")}`);
  }

  // Council members are one logical seat (they replaced the single reviewer),
  // so the cap never trades them away — dropping two of three reviewers is not
  // a smaller council, it is a broken one.
  const overflow = drafted
    .slice(maxRoles)
    .filter((r) => r.id !== "implementer" && !/^reviewer-c\d$/.test(r.id));
  const roles = overflow.length ? drafted.filter((r) => !overflow.includes(r)) : drafted;
  if (overflow.length) notes.push(`role cap ${maxRoles}: dropped ${overflow.map((r) => r.id).join(", ")}`);

  return { task, cwd, roles, notes };
}