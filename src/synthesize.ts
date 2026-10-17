/**
 * Role synthesis: task text → a small set of roles with omp model-role aliases.
 *
 * No configuration is consulted. The fan-out is deliberately conservative: a
 * task gets only the roles its shape implies, and the cap bounds the worst case
 * on a vague request.
 */
import { join } from "node:path";
import type { Capability, Effort, RolePlan, RoleSpec } from "./core.ts";
import { applySpecialists } from "./library.ts";
import { aliasFor, CAPABILITY_ID, DEFAULT_MAX_ROLES, isCouncilMember, READ_TOOLS, WRITE_TOOLS } from "./core.ts";

const CODE_HINT = /\b(code|bug|fix|refactor|implement|function|test|api|module|crate|rust|typescript|python)\b/i;
const RESEARCH_HINT = /\b(research|compare|market|competitor|docs?|upstream|library|version|price)\b/i;
const REVIEW_HINT = /\b(review|audit|security|check|verify|vulnerab)/i;
const MULTI_FILE_HINT = /\b(refactor|migrat|across|several files|multi-file|suite|whole repo)\b/i;
const IMAGE_HINT = /\b(screenshot|image|ui|ux|design|visual|layout|render)\b/i;
const DOCS_HINT = /\b(document|readme|changelog)\b/i;

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
  /**
   * Concrete models or aliases for the review seats, in order. Two or more
   * members imply a council; a single one retargets the reviewer that is
   * already there.
   */
  models?: string[];
  /**
   * Model that reconciles the council's reports. Absent — the default — the
   * session model does it itself.
   */
  consul?: string;
  /**
   * Read the change and judge it, nothing else: scout plus review seats only —
   * no implementer, tester, docs, or write-capable specialist. The deterministic
   * answer to a task text that mentions code, tests, and a UI at once, where
   * every keyword heuristic would otherwise add a seat.
   */
  reviewOnly?: boolean;
}

export function synthesizePlan(opts: PlanOptions): RolePlan {
  const { task, cwd, workDir } = opts;
  const maxRoles = opts.maxRoles ?? DEFAULT_MAX_ROLES;
  const notes: string[] = [];

  const wantsCode = CODE_HINT.test(task);
  const wantsPlan = wantsCode && MULTI_FILE_HINT.test(task);
  const wantsReview = REVIEW_HINT.test(task) || MULTI_FILE_HINT.test(task) || wantsCode;
  const needsVision = IMAGE_HINT.test(task);

  // Review-only is a cast, not a filter: the ask is explicit, so the seats are
  // chosen from the shape of the request rather than from its vocabulary. A
  // task that says "review the code, its tests, and the UI" would otherwise
  // mint an implementer, a tester, and a write-capable designer alongside the
  // reviewers — three paid seats, one of them holding `edit` on the code under
  // review.
  const caps: Capability[] = opts.reviewOnly
    ? ["scout", "review"]
    : wantsCode
      ? ["scout", ...(wantsPlan ? (["plan"] as Capability[]) : []), "code", "test"]
      : ["scout"];
  if (!opts.reviewOnly) {
    if (RESEARCH_HINT.test(task) && !wantsCode) caps.push("docs");
    if (wantsReview) caps.push("review");
    if (DOCS_HINT.test(task) && wantsCode) caps.push("docs");
  }
  // Not "nothing writes": appointing a consul gives the reviewers `write` so
  // their reports reach the filesystem for it to read. What review-only actually
  // guarantees is that no seat can change the code under review.
  if (opts.reviewOnly) notes.push("review-only: scout and review seats; no seat can edit code");

  const unique = [...new Set(caps)];
  const kept = [...unique]
    .sort((a, b) => KEEP_PRIORITY[a] - KEEP_PRIORITY[b])
    .slice(0, maxRoles)
    .sort((a, b) => unique.indexOf(a) - unique.indexOf(b));
  const dropped = unique.filter((c) => !kept.includes(c));
  if (dropped.length) notes.push(`role cap ${maxRoles}: dropped ${dropped.join(", ")}`);

  let drafts: RoleSpec[] = [];
  for (const cap of kept) {
    // Capability names differ from seat names in three places, so the seat id
    // and the fleet seat are one lookup rather than two copies of it.
    const id = CAPABILITY_ID[cap];
    const dep = (seat: string): string[] => (drafts.some((d) => d.id === seat) ? [seat] : []);
    const base = {
      core: id,
      model: aliasFor(id),
      effort: EFFORT[cap],
      needsVision: cap === "scout" ? needsVision : false,
    };
    const draft = {
      scout: {
        id,
        title: "Investigator",
        mission: `Locate every place this task touches and report current behavior with file:line evidence: ${task}`,
        acceptance: ["Affected files/symbols mapped with evidence", "No files modified"],
        dependsOn: [] as string[],
        tools: READ_TOOLS,
        artifact: `${workDir}/scout.md`,
      },
      plan: {
        id,
        title: "Planner",
        mission: "Turn the investigation into a locked implementation plan with exact files and ordered steps.",
        acceptance: ["Ordered steps naming exact files", "Open questions listed explicitly"],
        dependsOn: dep(CAPABILITY_ID.scout),
        tools: READ_TOOLS,
        artifact: `${workDir}/plan.md`,
      },
      code: {
        id,
        title: "Implementer",
        mission: "Implement the locked plan. Smallest correct change; do not expand scope.",
        acceptance: ["Requested behavior implemented", "Focused check executed and its real output reported"],
        dependsOn: dep(CAPABILITY_ID.plan).length ? [CAPABILITY_ID.plan] : dep(CAPABILITY_ID.scout),
        tools: WRITE_TOOLS,
        artifact: `${workDir}/implementation.md`,
      },
      test: {
        id,
        title: "Tester",
        mission: "Run the focused checks for the delivered change and report real output.",
        acceptance: ["Exact commands run", "Real pass/fail output", "Failures reproduced, not assumed"],
        dependsOn: dep(CAPABILITY_ID.code),
        tools: WRITE_TOOLS,
        artifact: `${workDir}/test-report.md`,
      },
      review: {
        id,
        title: "Reviewer",
        mission: "Review the delivered change for correctness, scope, and evidence. Read-only.",
        acceptance: ["Findings with file:line or explicit verdict", "No files modified"],
        dependsOn: dep(CAPABILITY_ID.code),
        tools: READ_TOOLS,
        artifact: `${workDir}/review.md`,
      },
      docs: {
        id,
        title: "Docs updater",
        mission: wantsCode
          ? "Update user-facing documentation to match the delivered behavior."
          : `Research and summarize: ${task}`,
        acceptance: wantsCode
          ? ["Docs match shipped behavior", "Documented commands verified against code"]
          : ["Every claim backed by a primary source"],
        dependsOn: wantsCode ? dep(CAPABILITY_ID.code) : [],
        tools: wantsCode ? WRITE_TOOLS : READ_TOOLS,
        artifact: `${workDir}/docs.md`,
      },
    }[cap];
    drafts.push({ ...draft, ...base } as RoleSpec);
  }

  if (wantsCode && !drafts.some((d) => d.id === "implementer")) {
    notes.push("role cap left no implementer; plan is analysis-only");
  }

  // Analysis intent: the task asks to look, not to change. Two sources, and the
  // first is structural rather than lexical — asking for a council, naming the
  // review models, or appointing a consul *is* the request. Reading it off the
  // parameters means the cast depends on what the caller actually asked for and
  // not on whether the prose happened to contain the word "review", which is
  // what makes the choice reliable instead of a coin flip on vocabulary.
  //
  // A build verb still wins: `--council` on "refactor the auth module" is a
  // refactor with a review, not a review of nothing.
  const SECURITY_SHAPE = /\b(security|vulnerab|pentest|injection|xss|csrf|exploit|threat model|audit)\b/i;
  const READ_SHAPE = /\b(audit|review|assess|inspect|verify|check)\b/i;
  const BUILD_VERB = /\b(fix|implement|write|add|build|refactor|migrat\w*|create|port|design)\b/i;
  // `> 1`, not "present": the pipeline always passes a council size, and 0 is
  // the ordinary single-reviewer run. Treating any value as a review ask would
  // make every task analysis and drop the implementer from a real build.
  const explicitReviewAsk = (opts.council ?? 0) > 1 || Boolean(opts.models?.length) || Boolean(opts.consul);
  const analysisIntent =
    Boolean(opts.reviewOnly) ||
    (!BUILD_VERB.test(task) && (explicitReviewAsk || SECURITY_SHAPE.test(task) || READ_SHAPE.test(task)));

  if (analysisIntent) {
    // The implementer and tester were drafted because words like "code", "api",
    // or "test" hit the code hint — in a task that only asks to look. Keeping
    // them spends two paid runs on seats the request never asked for, and at
    // the cap pushes out the reviewer or auditor the task exists for.
    const before = drafts.map((r) => r.id);
    const thinned = drafts.filter((r) => r.id !== "implementer" && r.id !== "tester");
    if (thinned.length !== before.length) {
      drafts = thinned;
      notes.push("analysis intent: implementer/tester dropped for the review seats");
    }
    // True of the static cast at this point, and `applySpecialists` below keeps
    // it true: no analysis-only plan gets a write-granting static specialist.
    // The consul block further down grants `write` to council members on purpose
    // and pushes its own note saying so — this line must not read as a promise
    // about the finished plan, or the two notes contradict each other on screen.
    notes.push("analysis-only intent: no seat will be given edit access");
  }

  // Specialist tier: hand-written seats for shapes the base cast serves poorly.
  // The cap applies after: a specialist never squeezes the implementer out.
  const drafted = applySpecialists(
    drafts,
    task,
    workDir,
    notes,
    (id) => drafts.some((d) => d.id === id),
    analysisIntent,
  );

  // A removed role takes the edges pointing at it along: the audit thinning and
  // a replacing specialist both drop a role other roles still wait on, and one
  // dangling edge makes `validatePlan` reject the entire plan — no agents, no
  // dispatch, no partial result. Dependents wait on the scout instead.
  const surviving = new Set(drafted.map((r) => r.id));
  drafted.forEach((r, i) => {
    const dangling = (r.dependsOn ?? []).filter((d) => !surviving.has(d));
    if (!dangling.length) return;
    // Edges that survived stay; only the dead ones are replaced, so a role
    // waiting on two things does not lose the one that is still planned.
    const kept = (r.dependsOn ?? []).filter((d) => surviving.has(d));
    const fallback = kept.length ? kept : surviving.has("scout") ? ["scout"] : [];
    notes.push(
      `role ${r.id}: dependency ${dangling.join(", ")} left the plan${fallback.length ? ` — waiting on ${fallback.join(", ")} instead` : ""}`,
    );
    // A replaced object, not a mutation of the one in the array: the council
    // and consul blocks below do write fields in place on objects they found,
    // but this one builds its role here and hands the caller the result, so the
    // drafts a few lines above must not be reachable from anywhere else. Copying
    // keeps that true if the pass is ever moved.
    drafted[i] = { ...r, dependsOn: fallback };
  });

  // Council: one change, several pairs of eyes from different providers. It
  // runs after the cast is final, so a member inherits an upstream that exists
  // rather than one a thinning pass deleted two lines ago. Reviewers with
  // distinct aliases ride the same wave, so the reviews are concurrent and
  // independent; synthesis is the main model's job, guided by the dispatch
  // prompt.
  // An explicit list may name more members than the alias fan-out has, so the
  // clamp follows the ask rather than the alias table.
  const council = Math.min(opts.council ?? 0, Math.max(COUNCIL_ALIAS.length, opts.models?.length ?? 0));
  // A single named model retargets the reviewer already in the plan instead of
  // minting a council of one: the seat exists, and a second reviewer on the same
  // work would be a duplicate review, not a wider one.
  if (council <= 1 && opts.models?.length === 1) {
    const reviewer = drafted.find((d) => d.core === "reviewer");
    if (reviewer) {
      const from = reviewer.model;
      reviewer.model = opts.models[0]!;
      notes.push(`reviewer on ${opts.models[0]} (was ${from})`);
    } else {
      // Nothing to retarget: saying so beats a silent no-op, since the user
      // asked for a specific model and none of their seats will run on it.
      notes.push(`--models ${opts.models[0]} had no reviewer seat to apply to`);
    }
  }
  if (council > 1) {
    const reviewer = drafted.find((d) => d.id === "reviewer");
    if (reviewer) {
      drafted.splice(drafted.indexOf(reviewer), 1);
    }
    // An analysis-only plan has no reviewer to replace — the council IS the
    // review, so its members join after the scout instead of being dropped
    // because "there was nothing to review". `dependsOn: []` is a real answer,
    // not a missing one, so the fallback keys off the length, never `??`.
    const upstream =
      reviewer?.dependsOn?.length
        ? reviewer.dependsOn
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
        // A copy per member: sharing one array across the council means any
        // later in-place edit of one member's dependencies edits them all.
        dependsOn: [...upstream],
        tools: READ_TOOLS,
        effort: "high",
        needsVision: false,
        model: opts.models?.[i] ?? COUNCIL_ALIAS[i],
        artifact: `${workDir}/review-c${i + 1}.md`,
      });
    }
    // A member past the end of the named list falls back to its alias, and says
    // so: `--models a,b --council 3` otherwise reads as three named reviews
    // when the third one is nobody's choice.
    const missing = (opts.models?.length ?? 0) > 0 ? council - opts.models!.length : 0;
    notes.push(
      `council of ${council}: ${Array.from({ length: council }, (_, i) => opts.models?.[i] ?? COUNCIL_ALIAS[i]).join(", ")}` +
        (missing > 0 ? ` (${missing} member${missing > 1 ? "s" : ""} past your list kept the default alias)` : ""),
    );
  }

  // A named consul takes over synthesis from the session model. Without it the
  // session model reads the council's reports itself — the default, and the
  // reason this seat is opt-in: an extra paid run the user did not ask for.
  //
  // The seat can only exist if the reviewers' reports reach the filesystem, and
  // today they do not: a read-only member returns its report as a yield payload
  // and `review-cN.md` is a path nobody writes. So the members gain `write` when
  // a consul is present — write only, no `edit` — and their acceptance changes
  // accordingly. Promoting them to writers is what turns a path into a file.
  if (opts.consul) {
    const members = drafted.filter((d) => isCouncilMember(d.id));
    if (!members.length) {
      notes.push(`--consul ${opts.consul} had no council members to read — the session model will synthesize`);
    } else {
      for (const member of members) {
        member.tools = [...READ_TOOLS, "write"];
        member.acceptance = [
          "Findings with file:line or an explicit verdict",
          `Your report is written to ${member.artifact}`,
          "No source file is modified",
        ];
      }
      // Announced, because the grant is repo-wide and the rest of the plan talks
      // in terms of what seats may write. `write` cannot edit an existing file
      // but can create or overwrite any path, so the user is told what the
      // consul actually costs them in authority, not only that it was appointed.
      notes.push(
        `consul ${opts.consul}: ${members.length} council member(s) granted repo-wide write so their reports reach ${workDir}/ — they cannot edit existing files but can overwrite any path`,
      );
      drafted.push({
        id: "consul",
        title: "Consul",
        core: "consul",
        mission:
          "Read every council report in full and reconcile them. State where the reviewers agree and where they " +
          "disagree, and adopt the most conservative finding as the verdict. Name the claims no reviewer backed.",
        acceptance: [
          "Every council report read in full, each cited by its reviewer",
          "Agreements and disagreements stated explicitly",
          "Verdict is the most conservative finding",
          "Claims only one reviewer raised, and claims none did, listed separately",
        ],
        dependsOn: members.map((m) => m.id),
        tools: [...READ_TOOLS, "write"],
        effort: "high",
        needsVision: false,
        model: opts.consul,
        artifact: `${workDir}/consul.md`,
      });
      notes.push(`consul on ${opts.consul}: reads ${members.length} council report(s)`);
    }
  }
  // Council members and the consul are one logical seat (they replaced the single
  // reviewer), so the cap never trades them away — dropping two of three
  // reviewers is not a smaller council, it is a broken one, and a dropped consul
  // would silently hand synthesis back to the session model.
  // Exempt on `core`, not on the id: `migration-runner` runs the implementer
  // seat under its own id. Today the two cannot disagree — a migration writer
  // replaces the implementer in place, so it always lands inside the kept
  // prefix, and the slice below never sees it — but the id test was correct only
  // by accident of that insertion order. Keying on the seat that carries the
  // authority is what makes it correct by construction; the cost is one word.
  const overflow = drafted
    .slice(maxRoles)
    .filter((r) => r.core !== "implementer" && r.core !== "consul" && !isCouncilMember(r.id));
  const roles = overflow.length ? drafted.filter((r) => !overflow.includes(r)) : drafted;
  if (overflow.length) notes.push(`role cap ${maxRoles}: dropped ${overflow.map((r) => r.id).join(", ")}`);
  // The exempt roles are kept on purpose, but "kept on purpose" is not the same
  // as "the cap was met": `--max-roles 2 --council 3` ships five roles, and the
  // plan said nothing. The real fan-out is what the reader budgets against.
  if (roles.length > maxRoles) {
    notes.push(`role cap ${maxRoles} exceeded: ${roles.length} roles (council and implementer are exempt)`);
  }

  // The structural intent travels with the plan so the pipeline gates the
  // dynamic tier on the same flag the static tier used, instead of asking the
  // shape of the finished cast a question the flags already answered.
  return { task, cwd, roles, notes, analysisOnly: analysisIntent };
}

export interface ProposalMergeOptions {
  /** Where the proposed artifacts are placed. */
  artifactDir: string;
  /** Cap on the finished cast, or the shared default when the caller names none. */
  maxRoles?: number;
  /** The plan holds no writer, so a proposed writer is refused. */
  analysisOnly: boolean;
}

/**
 * Merge validated proposals into a finished cast.
 *
 * Lives beside `synthesizePlan` rather than in the pipeline because it enforces
 * the same three invariants the static tier does — the cap, the resolved
 * dependency edges, and "no writer on an analysis-only plan". Two engines
 * merging roles into one plan is how those drift: a fix applied to the cap here
 * used to leave the identical arithmetic in the proposal tier untouched.
 *
 * Returns the plan unchanged (notes aside) when a proposal collides with an id
 * the plan already uses: `validatePlan` would refuse the whole plan over one bad
 * proposal, and the proposal is the optional part.
 */
export function mergeProposals(plan: RolePlan, proposed: RoleSpec[], opts: ProposalMergeOptions): RolePlan {
  const base = new Set(plan.roles.map((r) => r.id));
  // A proposal may not claim an id the plan already uses. The parser
  // refuses the static cast and the hand-written specialists, but the
  // council mints `reviewer-c1`… at synthesis time, so a proposal could
  // still collide — and `validatePlan` would then refuse the *whole plan*,
  // destroying a healthy run over one bad proposal. The proposal is the
  // optional part; it is the one that goes.
  const colliding = proposed.filter((r) => base.has(r.id)).map((r) => r.id);
  if (colliding.length) {
    plan.notes.push(`specialist proposal rejected — id already in use: ${colliding.join(", ")}`);
    return plan;
  }
  // An analysis-only plan may not gain a writer, whoever proposed it.
  // `--review-only` is not the only way to arrive here: naming council
  // models or appointing a consul strips the implementer and leaves the
  // proposal tier running, so a proposal holding `edit` would merge into
  // a plan that promised no code changes. `applySpecialists` closes this
  // for the static tier; the dynamic tier has to close it for itself, per
  // seat, so one bad proposal costs one seat instead of the whole tier.
  const writers = opts.analysisOnly
    ? proposed.filter((r) => r.tools.includes("edit") || r.tools.includes("write"))
    : [];
  const writable = writers.length ? proposed.filter((r) => !writers.includes(r)) : proposed;
  if (writers.length) {
    plan.notes.push(`proposed writer(s) refused on an analysis-only plan: ${writers.map((r) => r.id).join(", ")}`);
  }
  // The cap is a fan-out control, not a per-tier one: the static cast is
  // already trimmed, and without re-applying it here `--max-roles 2` on a
  // task that triggers the proposal tier would ship a static cast plus
  // three proposals on top of it.
  const maxRoles = opts.maxRoles ?? DEFAULT_MAX_ROLES;
  const slots = Math.max(0, maxRoles - plan.roles.length);
  const kept = writable.slice(0, slots);
  const dropped = writable.slice(slots).map((r) => r.id);
  // A proposed dependency on a seat the plan does not contain cannot
  // be honoured. Dropping it silently makes the role run earlier than
  // the proposal asked for — every other drop in this pipeline is
  // reported, so this one is too.
  const severed: string[] = [];
  const merged = [
    ...plan.roles,
    ...kept.map((r) => {
      const dependsOn = r.dependsOn.filter((d) => base.has(d) || kept.some((p) => p.id === d));
      for (const droppedDep of r.dependsOn.filter((d) => !dependsOn.includes(d))) {
        severed.push(`${r.id} → ${droppedDep}`);
      }
      return { ...r, artifact: join(opts.artifactDir, `${r.id}.md`), dependsOn };
    }),
  ];
  if (kept.length) {
    plan.notes.push(`generated specialists: ${kept.map((r) => r.id).join(", ")}`);
  }
  if (dropped.length) {
    plan.notes.push(`role cap ${maxRoles}: dropped ${dropped.join(", ")}`);
  }
  if (severed.length) {
    plan.notes.push(`dependency left the plan, role now waits on its remaining deps: ${severed.join(", ")}`);
  }
  return { ...plan, roles: merged };
}