/**
 * Role synthesis: task text → a small set of roles with omp model-role aliases.
 *
 * No configuration is consulted. The fan-out is deliberately conservative: a
 * task gets only the roles its shape implies, and the cap bounds the worst case
 * on a vague request.
 *
 * The work is a sequence of small passes over the plan, each one pure: it reads
 * what the previous pass produced and returns the next state. The order the
 * passes run in is the order the seats and the notes appear in, so the plan a
 * task gets is the same whichever pass is read.
 */
import { join } from "node:path";
import type { Capability, RolePlan, RoleSpec } from "./core.ts";
import { applySpecialists, isUiTask, SPECIALISTS } from "./library.ts";
import {
  BUILD_TOOLS,
  DEFAULT_MAX_ROLES,
  grantsWrite,
  isCouncilMember,
  isSliceSeat,
  MAX_SLICES,
  READ_TOOLS,
  SEAT_CATALOG,
  VOCAB,
  WRITE_TOOLS,
} from "./core.ts";

/**
 * Alias order for a review council.
 *
 * Distinct aliases mean distinct models in any sane `modelRoles` setup, and —
 * when those aliases are mapped to different providers — distinct providers too,
 * which is the point: the same blind spot is unlikely across providers.
 */
const COUNCIL_ALIAS = [
  SEAT_CATALOG.base.review.alias,
  SEAT_CATALOG.base.code.alias,
  SEAT_CATALOG.base.plan.alias,
];

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
  /**
   * Fan the implementation out across N writer seats (`implementer-1` … `-N`)
   * instead of the single implementer. The partition itself is not the
   * plugin's to decide: the file map arrives with the scout's report, so the
   * orchestrator names each seat's files in its dispatch item, and the cast is
   * arranged so no other seat is a second writer.
   */
  slices?: number;
}

/**
 * The static cast is the floor this pipeline can ship: nothing but an
 * investigator.
 *
 * It means the task matched no shape the vocabulary knows — a verb it does not
 * carry, or a language it cannot read at all — so the cast cannot serve the task
 * it was built from. That is the signal the dynamic tier is keyed on: a cast
 * this thin is exactly the one worth a cheap model call to improve, and keying
 * the tier on `analysisOnly` instead left these plans with no second chance,
 * since a cast this thin carries `analysisOnly: false` too.
 */
export function isDegenerateCast(roles: ReadonlyArray<Pick<RoleSpec, "core">>): boolean {
  return roles.length === 1 && roles[0]!.core === "scout";
}

/**
 * What the task text and the flags imply about the work.
 *
 * Every classification reads `core.VOCAB`; the regexes that used to live here
 * were the divergence that table removes.
 */
interface Intent {
  /** The task asks for checks to be run rather than for a change. */
  verifyAsk: boolean;
  /** The task asks for documentation. */
  docsAsk: boolean;
  /** The docs seat writes rather than reads. */
  docsWrites: boolean;
  /** The cast needs an implementer. */
  wantsCode: boolean;
  /** The cast needs a planner: broad-scope work earns one more serial wave. */
  wantsPlan: boolean;
  /** The cast needs a vision seat. */
  needsVision: boolean;
  /** The task asks to look, not to change: no seat in the cast may write. */
  analysisIntent: boolean;
  /** The cast needs a reviewer. */
  wantsReview: boolean;
}

/**
 * Read the task's shape.
 *
 * A migration that names no code vocabulary is still a change: "migrate off
 * lodash", "upgrade the deps", "move off webpack" carry no unconditional
 * `VOCAB.changeStrong` verb. Reading the shape off the catalog pattern is what
 * keeps the README's promise ("a migration is implementation, so the runner
 * replaces the implementer"); without it the specialist is skipped for want of
 * an implementer to replace, and a task that asked to change the tree ships a
 * scout and a reviewer that reviews nothing. What vetoes it is a look-verb —
 * "research migration options" is a look at a migration, not a migration, and
 * it must not mint a writer. The veto is a verb list and never a noun list:
 * "upgrade the library to the latest version" is a migration that `library`
 * and `version` would otherwise veto, naming a subject as often as a task.
 *
 * The verb sets are split by ambiguity: `fix`/`add`/`refactor` are verbs and
 * always mint the code cast, while `build`/`update`/`write` are also ordinary
 * nouns and mint it only when nothing asks to look. Reading them as one list
 * is what let "profile the write path" and "compare the read path with the
 * write path" ship a shell-holding implementer for a measurement.
 * "review" is both the verb and the name of a product surface. When it names a
 * subject and the sentence reports a defect, the defect wins: the review page
 * showing stale data is a bug to fix, not a read-only review of the codebase.
 */
function classifyIntent(task: string, opts: PlanOptions): Intent {
  const looks = VOCAB.look.test(task) && !(VOCAB.reviewSubject.test(task) && VOCAB.defect.test(task));
  const migrationShape = SPECIALISTS.some((s) => s.replacesImplementer && s.match(task));
  const changesTree =
    VOCAB.changeStrong.test(task) ||
    (VOCAB.changeAmbiguous.test(task) && !looks) ||
    (VOCAB.defect.test(task) && !looks) ||
    (migrationShape && !looks);
  // An ask to run the checks is a verifier's work, not an implementation: "test
  // the checkout flow" wants the tester, and used to get an implementer beside
  // it because "test" is also a code subject. This reads `changesTree`, not the
  // raw verb list: a migration may name a test suite ("migrate the test suite
  // to vitest") and still be a change, and re-testing the weaker predicate here
  // dropped its writer.
  const verifyAsk = VOCAB.verify.test(task) && !changesTree;
  // Documentation is a shape of its own. "update the readme" and "write the
  // changelog" shipped one investigator, because the docs seat was reachable
  // only through a code or a research shape; "document the api" shipped an
  // implementer for the one code word in it.
  //
  // A docs ask is a docs cast when the change verb is one of the ambiguous ones
  // (`update`/`write`) or when no code subject is named. "update the api docs"
  // used to mint a full code cast and then drop the docs seat at the cap — the
  // one seat the ask named. A strong verb on a code subject ("add docs to the
  // api module") still asks for both.
  const docsAsk = VOCAB.docs.test(task);
  const uiTask = isUiTask(task);
  const docsOnly = docsAsk && !uiTask && (!VOCAB.codeNoun.test(task) || !VOCAB.changeStrong.test(task));
  /** The docs seat writes when asked for documentation, or when there is a
   *  delivered change to document; it reads when the ask is to find out. */
  const docsWrites = docsAsk || changesTree;
  const wantsCode = changesTree && !docsOnly && !verifyAsk;
  const wantsPlan = wantsCode && VOCAB.multiFile.test(task);
  const needsVision = uiTask;

  // Analysis intent: the task asks to look, not to change. Two sources, and the
  // first is structural rather than lexical — asking for a council, naming the
  // review models, or appointing a consul *is* the request. Reading it off the
  // parameters means the cast depends on what the caller actually asked for and
  // not on whether the prose happened to contain the word "review", which is
  // what makes the choice reliable instead of a coin flip on vocabulary.
  //
  // A change verb still wins: `--council` on "refactor the auth module" is a
  // refactor with a review, not a review of nothing.
  const explicitReviewAsk = (opts.council ?? 0) > 1 || Boolean(opts.models?.length) || Boolean(opts.consul);
  const analysisIntent =
    Boolean(opts.reviewOnly) ||
    (!changesTree && (explicitReviewAsk || VOCAB.security.test(task) || looks));
  const wantsReview =
    VOCAB.review.test(task) || wantsCode || (VOCAB.multiFile.test(task) && !looks);

  return {
    verifyAsk,
    docsAsk,
    docsWrites,
    wantsCode,
    wantsPlan,
    needsVision,
    analysisIntent,
    wantsReview,
  };
}

/** The seats the task's shape implies, before the cap is applied. */
function pickCapabilities(intent: Intent, task: string, reviewOnly: boolean): { caps: Capability[]; notes: string[] } {
  const notes: string[] = [];
  const codeCast: Capability[] = ["scout", ...(intent.wantsPlan ? (["plan"] as Capability[]) : []), "code"];
  // A UI task seats the designer over a separate tester (see the note below).
  if (!intent.needsVision) codeCast.push("test");
  const caps: Capability[] = reviewOnly
    ? ["scout", "review"]
    : intent.wantsCode
      ? codeCast
      : intent.verifyAsk
        ? ["scout", "test"]
        : ["scout"];
  if (!reviewOnly) {
    if (intent.docsAsk || (VOCAB.research.test(task) && !intent.wantsCode)) caps.push("docs");
    if (intent.wantsReview) caps.push("review");
    // A UI task's designer *is* its implementation — the seat's own acceptance
    // covers the interface, its states and its accessibility — so the designer
    // takes the seat and the separate tester is the one the cap can spend. The
    // other order ships an implementer and a tester for a page nobody was asked
    // to design.
    if (intent.needsVision && intent.wantsCode) {
      notes.push("ui task: the designer takes the seat a tester would hold");
    }
    // An analysis cast has to be able to answer the task it was thinned for: a
    // look-ask with no other seat would ship one investigator whose report
    // nobody reads. A cast that already answers it (a researcher, an auditor)
    // needs no addition.
    if (intent.analysisIntent && !caps.includes("review") && caps.length === 1) caps.push("review");
  }
  if (reviewOnly) notes.push("review-only: scout and review seats; no seat can change the code");
  return { caps, notes };
}

/**
 * The cap: which seats survive, in which order, and which are dropped.
 *
 * Drop order when the cap bites: implementation is never dropped first.
 */
function applyCap(caps: Capability[], maxRoles: number): { kept: Capability[]; dropped: Capability[]; notes: string[] } {
  const unique = [...new Set(caps)];
  const kept = [...unique]
    .sort((a, b) => SEAT_CATALOG.base[a].keepPriority - SEAT_CATALOG.base[b].keepPriority)
    .slice(0, maxRoles)
    .sort((a, b) => unique.indexOf(a) - unique.indexOf(b));
  const dropped = unique.filter((c) => !kept.includes(c));
  return {
    kept,
    dropped,
    notes: dropped.length ? [`role cap ${maxRoles}: dropped ${dropped.join(", ")}`] : [],
  };
}

/** What the draft builder needs to know about the task. */
interface DraftContext {
  task: string;
  workDir: string;
  analysisIntent: boolean;
  needsVision: boolean;
  verifyAsk: boolean;
  docsWrites: boolean;
  wantsCode: boolean;
}

/**
 * Draft one seat per capability.
 *
 * Capability names differ from seat names, so the seat id comes from the
 * catalog rather than from a second copy of the mapping.
 */
function draftRoles(kept: Capability[], ctx: DraftContext): RoleSpec[] {
  const drafts: RoleSpec[] = [];
  for (const cap of kept) {
    const seat = SEAT_CATALOG.base[cap];
    const id = seat.id;
    const dep = (target: string): string[] => (drafts.some((d) => d.id === target) ? [target] : []);
    const base = {
      core: id,
      model: seat.alias,
      // The single reviewer that gates a delivered change runs at medium
      // effort: it is the last seat standing in the final wave, so its
      // thinking budget paces the whole run. A run whose deliverable *is* the
      // review — analysis intent, or security wording — keeps it high, as do
      // council members and the consul.
      effort:
        cap === "review" && !ctx.analysisIntent && !VOCAB.security.test(ctx.task) ? "medium" : seat.effort,
      needsVision: cap === "scout" ? ctx.needsVision : false,
    };
    const draft = {
      scout: {
        id,
        title: seat.title,
        mission: `Locate every place this task touches and report current behavior with file:line evidence: ${ctx.task}`,
        acceptance: ["Affected files/symbols mapped with evidence", "No files modified"],
        dependsOn: [] as string[],
        tools: READ_TOOLS,
        artifact: `${ctx.workDir}/scout.md`,
      },
      plan: {
        id,
        title: seat.title,
        mission: "Turn the investigation into a locked implementation plan with exact files and ordered steps.",
        acceptance: ["Ordered steps naming exact files", "Open questions listed explicitly"],
        dependsOn: dep(SEAT_CATALOG.base.scout.id),
        tools: READ_TOOLS,
        artifact: `${ctx.workDir}/plan.md`,
      },
      code: {
        id,
        title: seat.title,
        mission: "Implement the locked plan. Smallest correct change; do not expand scope.",
        acceptance: ["Requested behavior implemented", "Focused check executed and its real output reported"],
        dependsOn: dep(SEAT_CATALOG.base.plan.id).length ? [SEAT_CATALOG.base.plan.id] : dep(SEAT_CATALOG.base.scout.id),
        // A shell, because the acceptance line asks for a check *executed*: the
        // edit/write pair cannot run one.
        tools: BUILD_TOOLS,
        artifact: `${ctx.workDir}/implementation.md`,
      },
      test: {
        id,
        // A verifier, when the task asked for checks rather than for a change:
        // "test the checkout flow" is not an implementation, and the seat it
        // wants is the one that runs things and reports output.
        title: ctx.verifyAsk ? "Verifier" : seat.title,
        mission: ctx.verifyAsk
          ? "Run the checks this task asks for and report their real output with evidence."
          : "Run the focused checks for the delivered change and report real output.",
        acceptance: ctx.verifyAsk
          ? ["Exact commands run", "Real pass/fail output", "Each claim backed by the output that shows it"]
          : ["Exact commands run", "Real pass/fail output", "Failures reproduced, not assumed"],
        dependsOn: ctx.verifyAsk ? dep(SEAT_CATALOG.base.scout.id) : dep(SEAT_CATALOG.base.code.id),
        // Same grant as the implementer: "exact commands run" needs a shell.
        tools: BUILD_TOOLS,
        artifact: `${ctx.workDir}/test-report.md`,
      },
      review: {
        id,
        title: seat.title,
        // No authority claim in the mission: the grant decides it, and the
        // frontmatter's grant note and the brief's `## Upstream artifacts` line
        // say what this seat may write, from `role.tools`, so a second copy here
        // would be a second thing to keep in step.
        mission: "Review the delivered change for correctness, scope, and evidence.",
        acceptance: ["Findings with file:line or explicit verdict", "No files modified"],
        // A reviewer waits on the seat that produced what it reviews. With no
        // implementer in the cast, an empty edge put it in wave 1 beside the
        // scout it is supposed to review, so it judged an empty tree. The same
        // fallback the council uses one stage later: code, else the verifier,
        // else the docs seat, else the scout.
        dependsOn: dep(SEAT_CATALOG.base.code.id).length
          ? dep(SEAT_CATALOG.base.code.id)
          : dep(SEAT_CATALOG.base.test.id).length
            ? dep(SEAT_CATALOG.base.test.id)
            : dep(SEAT_CATALOG.base.docs.id).length
              ? dep(SEAT_CATALOG.base.docs.id)
              : dep(SEAT_CATALOG.base.scout.id),
        tools: READ_TOOLS,
        artifact: `${ctx.workDir}/review.md`,
      },
      docs: {
        id,
        title: seat.title,
        // A writer when the ask is a documentation change or a code change to
        // document, a researcher when the ask is to find something out:
        // "research the library docs" needs a finding, not a licence to edit.
        mission: ctx.docsWrites
          ? ctx.wantsCode
            ? "Update user-facing documentation to match the delivered behavior."
            : "Write the documentation this task asks for."
          : `Research and summarize: ${ctx.task}`,
        acceptance: ctx.docsWrites
          ? ["Docs written and internally consistent", "Documented commands verified against code"]
          : ["Every claim backed by a primary source"],
        dependsOn: ctx.docsWrites
          ? ctx.wantsCode
            ? dep(SEAT_CATALOG.base.code.id)
            : dep(SEAT_CATALOG.base.scout.id)
          : [],
        tools: ctx.docsWrites ? WRITE_TOOLS : READ_TOOLS,
        artifact: `${ctx.workDir}/docs.md`,
      },
    }[cap];
    drafts.push({ ...draft, ...base } as RoleSpec);
  }
  return drafts;
}

/**
 * Thin an analysis cast: drop the seats the task never asked for.
 *
 * The implementer and tester were drafted because words like "code", "api",
 * or "test" hit the vocabulary — in a task that only asks to look. Keeping
 * them spends two paid runs on seats the request never asked for, and at the
 * cap pushes out the reviewer or auditor the task exists for. The tester
 * stays when the task asked for checks: that seat *is* the answer there, and
 * dropping it would remove the only one that could give it.
 */
function thinForAnalysis(drafts: RoleSpec[], verifyAsk: boolean): { roles: RoleSpec[]; notes: string[] } {
  const before = drafts.map((r) => r.id);
  const thinned = drafts.filter(
    (r) => r.id !== SEAT_CATALOG.base.code.id && !(r.id === SEAT_CATALOG.base.test.id && !verifyAsk),
  );
  if (thinned.length === before.length) return { roles: drafts, notes: [] };
  const gone = before.filter((id) => !thinned.some((r) => r.id === id));
  return {
    roles: thinned,
    notes: [`analysis intent: ${gone.join("/")} dropped for the review seats`],
  };
}

/**
 * Replace edges that point at a role the plan no longer holds.
 *
 * The audit thinning and a replacing specialist both drop a role other roles
 * still wait on, and one dangling edge makes `validatePlan` reject the entire
 * plan — no agents, no dispatch, no partial result. Dependents wait on the
 * scout instead.
 */
function repairDependencies(roles: RoleSpec[]): { roles: RoleSpec[]; notes: string[] } {
  const notes: string[] = [];
  const surviving = new Set(roles.map((r) => r.id));
  const repaired = roles.map((r) => {
    const dangling = (r.dependsOn ?? []).filter((d) => !surviving.has(d));
    if (!dangling.length) return r;
    // Edges that survived stay; only the dead ones are replaced, so a role
    // waiting on two things does not lose the one that is still planned.
    const kept = (r.dependsOn ?? []).filter((d) => surviving.has(d));
    const fallback = kept.length ? kept : surviving.has(SEAT_CATALOG.base.scout.id) ? [SEAT_CATALOG.base.scout.id] : [];
    notes.push(
      `role ${r.id}: dependency ${dangling.join(", ")} left the plan${fallback.length ? ` — waiting on ${fallback.join(", ")} instead` : ""}`,
    );
    return { ...r, dependsOn: fallback };
  });
  return { roles: repaired, notes };
}

/**
 * Fan the implementation out across several writers, when asked for.
 *
 * It runs after the specialists so that a migration — one writer by design,
 * since two writers on the same files is a defect rather than a feature — has
 * already taken the implementer's place and refuses the split here, and after
 * the edge repair so the seats that waited on `implementer` are the ones
 * rewritten below.
 */
function fanOutSlices(roles: RoleSpec[], requested: number, workDir: string): { roles: RoleSpec[]; notes: string[] } {
  const slices = Math.min(requested, MAX_SLICES);
  if (slices <= 1) return { roles, notes: [] };
  const at = roles.findIndex((r) => r.id === SEAT_CATALOG.base.code.id);
  const split = roles[at];
  if (at === -1 || split === undefined) {
    return {
      roles,
      notes: [`--slices ${slices}: no implementer seat to fan out — the cast is ${roles.map((r) => r.id).join(", ")}`],
    };
  }
  const sliceSeats: RoleSpec[] = [];
  for (let i = 1; i <= slices; i++) {
    sliceSeats.push({
      ...split,
      id: `implementer-${i}`,
      title: `Implementer ${i}`,
      // Which files these are is not knowable here: the map arrives with the
      // scout's report, which the orchestrator reads before dispatching. So
      // the seat is told the shape of its authority, and the dispatch tells
      // the orchestrator to name the files in the item.
      mission:
        "Implement the slice your dispatch item assigns you, and only that slice: own exactly the files it names, change nothing outside them, and report what you changed and what you checked.",
      acceptance: [
        "The assigned slice implemented",
        "No file outside the assigned slice touched",
        "Focused check executed and its real output reported",
      ],
      artifact: `${workDir}/implementation-${i}.md`,
    });
  }
  // Everything that waited on the single implementer waits on every slice:
  // a seat that waited on the first one alone would start before the rest of
  // the change existed.
  const ids = sliceSeats.map((r) => r.id);
  const fanned = roles.flatMap((r, i) => (i === at ? sliceSeats : [r])).map((r) =>
    (r.dependsOn ?? []).includes(SEAT_CATALOG.base.code.id)
      ? {
          ...r,
          dependsOn: (r.dependsOn ?? []).flatMap((d) => (d === SEAT_CATALOG.base.code.id ? ids : [d])),
        }
      : r,
  );
  return {
    roles: fanned,
    notes: [
      `slices: ${slices} implementer seats on one implementation (${ids.join(", ")}) — the file partition comes from the scout's map, so the orchestrator names each seat's files in its dispatch item`,
    ],
  };
}

/**
 * The review council: one change, several pairs of eyes from different
 * providers.
 *
 * It runs after the cast is final, so a member inherits an upstream that
 * exists rather than one a thinning pass deleted two lines ago. Reviewers with
 * distinct aliases ride the same wave, so the reviews are concurrent and
 * independent; synthesis is the main model's job, guided by the dispatch
 * prompt.
 * An explicit list may name more members than the alias fan-out has, so the
 * clamp follows the ask rather than the alias table.
 */
function applyCouncil(roles: RoleSpec[], opts: PlanOptions, workDir: string): { roles: RoleSpec[]; notes: string[] } {
  const notes: string[] = [];
  const council = Math.min(opts.council ?? 0, Math.max(COUNCIL_ALIAS.length, opts.models?.length ?? 0));
  let next = roles;
  // A single named model retargets the reviewer already in the plan instead of
  // minting a council of one: the seat exists, and a second reviewer on the same
  // work would be a duplicate review, not a wider one.
  if (council <= 1 && opts.models?.length === 1) {
    const reviewer = next.find((d) => d.core === SEAT_CATALOG.base.review.core);
    if (reviewer) {
      const from = reviewer.model;
      next = next.map((r) => (r === reviewer ? { ...r, model: opts.models![0]! } : r));
      notes.push(`reviewer on ${opts.models[0]} (was ${from})`);
    } else {
      // Nothing to retarget: saying so beats a silent no-op, since the user
      // asked for a specific model and none of their seats will run on it.
      notes.push(`--models ${opts.models[0]} had no reviewer seat to apply to`);
    }
  }
  if (council > 1) {
    const reviewer = next.find((d) => d.id === SEAT_CATALOG.base.review.id);
    const withoutReviewer = reviewer ? next.filter((r) => r !== reviewer) : next;
    // An analysis-only plan has no reviewer to replace — the council IS the
    // review, so its members join after the scout instead of being dropped
    // because "there was nothing to review". `dependsOn: []` is a real answer,
    // not a missing one, so the fallback keys off the length, never `??`.
    const upstream =
      reviewer?.dependsOn?.length
        ? reviewer.dependsOn
        : withoutReviewer.some((d) => d.id === SEAT_CATALOG.base.scout.id)
          ? [SEAT_CATALOG.base.scout.id]
          : [];
    const baseMission = reviewer?.mission ?? `Assess the subject of this task and report findings with evidence.`;
    const members: RoleSpec[] = [];
    for (let i = 0; i < council; i++) {
      members.push({
        id: `reviewer-c${i + 1}`,
        title: `Reviewer ${i + 1}`,
        core: SEAT_CATALOG.base.review.core,
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
    next = [...withoutReviewer, ...members];
    // A member past the end of the named list falls back to its alias, and says
    // so: `--models a,b --council 3` otherwise reads as three named reviews
    // when the third one is nobody's choice.
    const missing = (opts.models?.length ?? 0) > 0 ? council - opts.models!.length : 0;
    notes.push(
      `council of ${council}: ${Array.from({ length: council }, (_, i) => opts.models?.[i] ?? COUNCIL_ALIAS[i]).join(", ")}` +
        (missing > 0 ? ` (${missing} member${missing > 1 ? "s" : ""} past your list kept the default alias)` : ""),
    );
  }
  return { roles: next, notes };
}

/**
 * A named consul takes over synthesis from the session model. Without it the
 * session model reads the council's reports itself — the default, and the
 * reason this seat is opt-in: an extra paid run the user did not ask for.
 *
 * The members' reports have to reach the filesystem for the consul to read
 * them, and the channel for that already exists: a read-only seat returns its
 * report as a yield payload and the plugin writes it to the seat's artifact
 * path before the next wave. Granting the members `write` to make that file
 * themselves is redundant authority — `write` takes any path in the repo, and
 * the seat's own acceptance line is a convention, not a boundary — so the
 * council keeps its read-only grant and the path is filled the same way the
 * scout's and the planner's already are.
 */
function applyConsul(roles: RoleSpec[], opts: PlanOptions, workDir: string): { roles: RoleSpec[]; notes: string[] } {
  if (!opts.consul) return { roles, notes: [] };
  const members = roles.filter((d) => isCouncilMember(d.id));
  if (!members.length) {
    return {
      roles,
      notes: [`--consul ${opts.consul} had no council members to read — the session model will synthesize`],
    };
  }
  return {
    roles: [
      ...roles,
      {
        id: "consul",
        title: SEAT_CATALOG.catalog.consul.title,
        core: SEAT_CATALOG.catalog.consul.core,
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
        tools: READ_TOOLS,
        effort: "high",
        needsVision: false,
        model: opts.consul,
        artifact: `${workDir}/consul.md`,
      },
    ],
    notes: [
      `consul ${opts.consul}: reads ${members.length} council report(s), placed at ${workDir}/ by the plugin`,
    ],
  };
}

/**
 * Apply the cap to the finished cast.
 *
 * Council members, the consul and the slice seats are one logical seat each —
 * the council replaced the single reviewer, the fan-out replaced the single
 * implementer — so the cap never trades them away: dropping two of three
 * reviewers is not a smaller council but a broken one, and spending a slot per
 * writer *file* would drop the tester and the reviewer first, leaving a
 * fanned-out change unreviewed.
 * Exempt on `core`, not on the id: `migration-runner` runs the implementer
 * seat under its own id. Today the two cannot disagree — a migration writer
 * replaces the implementer in place, so it always lands inside the kept
 * prefix, and the slice below never sees it — but the id test was correct only
 * by accident of that insertion order. Keying on the seat that carries the
 * authority is what makes it correct by construction; the cost is one word.
 * The position the cap reads is taken over a list where the fan-out occupies
 * its single slot, so seats after it are measured where they really sit.
 */
function applySeatCap(roles: RoleSpec[], maxRoles: number): { roles: RoleSpec[]; notes: string[] } {
  const notes: string[] = [];
  const firstSliceAt = roles.findIndex((r) => isSliceSeat(r.id));
  const perSeat = roles.filter((r, i) => !isSliceSeat(r.id) || i === firstSliceAt);
  const overflowIds = new Set(
    perSeat
      .slice(maxRoles)
      .filter(
        (r) =>
          r.core !== SEAT_CATALOG.base.code.core && r.core !== SEAT_CATALOG.catalog.consul.core && !isCouncilMember(r.id),
      )
      .map((r) => r.id),
  );
  const overflow = roles.filter((r) => overflowIds.has(r.id));
  // A seat that waited on a dropped one keeps waiting on the rest of its list;
  // an edge to a seat that is not in the plan would fail validation.
  const kept = overflow.length
    ? roles
        .filter((r) => !overflowIds.has(r.id))
        .map((r) =>
          (r.dependsOn ?? []).some((d) => overflowIds.has(d))
            ? { ...r, dependsOn: r.dependsOn.filter((d) => !overflowIds.has(d)) }
            : r,
        )
    : roles;
  if (overflow.length) notes.push(`role cap ${maxRoles}: dropped ${overflow.map((r) => r.id).join(", ")}`);
  // The exempt roles are kept on purpose, but "kept on purpose" is not the same
  // as "the cap was met": `--max-roles 2 --council 3` ships five roles, and the
  // plan said nothing. The real fan-out is what the reader budgets against.
  if (kept.length > maxRoles) {
    notes.push(
      `role cap ${maxRoles} exceeded: ${kept.length} roles (council members, slice seats and the consul are exempt)`,
    );
  }
  return { roles: kept, notes };
}

export function synthesizePlan(opts: PlanOptions): RolePlan {
  const { task, cwd, workDir } = opts;
  const requestedCap = opts.maxRoles ?? DEFAULT_MAX_ROLES;
  // A change cast needs at least an investigator and a worker. At a cap of one
  // the priority order kept the implementer and dropped the scout, so the seat
  // told to "implement the locked plan" had no plan and no investigation; the
  // floor is two, and the caller is told when the ask was raised.
  const maxRoles = Math.max(2, requestedCap);
  const notes: string[] = [];
  if (requestedCap < maxRoles) {
    notes.push(`role cap ${requestedCap} raised to ${maxRoles}: a cast needs a worker and an investigator`);
  }

  const intent = classifyIntent(task, opts);
  const picked = pickCapabilities(intent, task, Boolean(opts.reviewOnly));
  notes.push(...picked.notes);
  const capped = applyCap(picked.caps, maxRoles);
  notes.push(...capped.notes);

  let drafts = draftRoles(capped.kept, {
    task,
    workDir,
    analysisIntent: intent.analysisIntent,
    needsVision: intent.needsVision,
    verifyAsk: intent.verifyAsk,
    docsWrites: intent.docsWrites,
    wantsCode: intent.wantsCode,
  });

  // Only the cap can leave a change-shaped task without an implementer: every
  // other way an implementer is absent was decided above, and blaming "role cap"
  // for the cast `--review-only` asked for reports a cap that never bit.
  if (intent.wantsCode && capped.dropped.includes("code")) {
    notes.push(`role cap ${maxRoles} left no implementer; plan is analysis-only`);
  }

  if (intent.analysisIntent) {
    const thinned = thinForAnalysis(drafts, intent.verifyAsk);
    drafts = thinned.roles;
    notes.push(...thinned.notes);
  }

  // Specialist tier: hand-written seats for shapes the base cast serves poorly.
  // The cap applies after: a specialist never squeezes the implementer out.
  const specialistNotes: string[] = [];
  const drafted = applySpecialists(
    drafts,
    task,
    workDir,
    specialistNotes,
    (id) => drafts.some((d) => d.id === id),
    intent.analysisIntent,
  );
  notes.push(...specialistNotes);

  const repaired = repairDependencies(drafted);
  notes.push(...repaired.notes);
  const sliced = fanOutSlices(repaired.roles, opts.slices ?? 1, workDir);
  notes.push(...sliced.notes);
  const counciled = applyCouncil(sliced.roles, opts, workDir);
  notes.push(...counciled.notes);
  const consulted = applyConsul(counciled.roles, opts, workDir);
  notes.push(...consulted.notes);
  const cappedAgain = applySeatCap(consulted.roles, maxRoles);
  notes.push(...cappedAgain.notes);
  const roles = cappedAgain.roles;

  // Stated from the cast that ships rather than promised earlier in the pass:
  // the answer is the grant rule itself now — `edit`, `write` or a shell — so a
  // seat that can run commands cannot leave a cast claiming nothing changes.
  // `--review-only` already said this in its own words.
  if (intent.analysisIntent && !opts.reviewOnly && !roles.some((r) => grantsWrite(r.tools))) {
    notes.push("analysis-only intent: no seat in this cast can change the code");
  }

  // The structural intent travels with the plan so the pipeline gates the
  // dynamic tier on the same flag the static tier used, instead of asking the
  // shape of the finished cast a question the flags already answered.
  return { task, cwd, roles, notes, analysisOnly: intent.analysisIntent };
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
  const notes = [...plan.notes];
  // A proposal may not claim an id the plan already uses. The parser
  // refuses the static cast and the hand-written specialists, but the
  // council mints `reviewer-c1`… at synthesis time, so a proposal could
  // still collide — and `validatePlan` would then refuse the *whole plan*,
  // destroying a healthy run over one bad proposal. The proposal is the
  // optional part; it is the one that goes.
  const colliding = proposed.filter((r) => base.has(r.id)).map((r) => r.id);
  if (colliding.length) {
    notes.push(`specialist proposal rejected — id already in use: ${colliding.join(", ")}`);
    return { ...plan, notes };
  }
  // A plan that may not write refuses a proposed writer — and so does one whose
  // implementation is already fanned out across slice seats: that cast has every
  // writer it can keep apart, and a proposed one would be a second
  // implementation, which is the same defect as two writers on one file.
  // `--review-only` is not the only way to arrive here: naming council models or
  // appointing a consul strips the implementer and leaves the proposal tier
  // running, so a proposal holding `edit` would merge into a plan that promised
  // no code changes. `applySpecialists` closes this for the static tier; the
  // dynamic tier has to close it for itself, per seat, so one bad proposal costs
  // one seat instead of the whole tier.
  const refusing = opts.analysisOnly
    ? "an analysis-only plan"
    : plan.roles.some((r) => isSliceSeat(r.id))
      ? "a fanned-out plan"
      : null;
  const writers = refusing ? proposed.filter((r) => grantsWrite(r.tools)) : [];
  const writable = writers.length ? proposed.filter((r) => !writers.includes(r)) : proposed;
  if (writers.length) {
    notes.push(`proposed writer(s) refused on ${refusing}: ${writers.map((r) => r.id).join(", ")}`);
  }
  // The cap is a fan-out control, not a per-tier one: the static cast is
  // already trimmed, and without re-applying it here `--max-roles 2` on a
  // task that triggers the proposal tier would ship a static cast plus
  // three proposals on top of it.
  const maxRoles = Math.max(2, opts.maxRoles ?? DEFAULT_MAX_ROLES);
  // The cap counts logical seats exactly as the static pass does: every plain
  // role costs one, a slice fan-out costs one (only its first seat stands for
  // the group), a council costs one (only its first member stands for the
  // group), and the consul costs one even though it is never dropped. Excluding
  // the implementer or every council member made a full build cast look like it
  // had a free slot, so a proposal silently shipped five roles at a cap of four.
  const firstSliceAt = plan.roles.findIndex((r) => isSliceSeat(r.id));
  const hasCouncil = plan.roles.some((r) => isCouncilMember(r.id));
  const usedSeats =
    plan.roles.filter(
      (r, i) => (!isSliceSeat(r.id) || i === firstSliceAt) && !isCouncilMember(r.id),
    ).length + (hasCouncil ? 1 : 0);
  const slots = Math.max(0, maxRoles - usedSeats);
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
    notes.push(`generated specialists: ${kept.map((r) => r.id).join(", ")}`);
  }
  if (dropped.length) {
    notes.push(`role cap ${maxRoles}: dropped ${dropped.join(", ")}`);
  }
  if (severed.length) {
    notes.push(`dependency left the plan, role now waits on its remaining deps: ${severed.join(", ")}`);
  }
  // The static pass already reports an exempt overrun; a merge can add a seat
  // after that note was written, so the final cast gets the same sentence.
  if (merged.length > maxRoles) {
    notes.push(
      `role cap ${maxRoles} exceeded: ${merged.length} roles (council members, slice seats and the consul are exempt)`,
    );
  }
  return { ...plan, roles: merged, notes };
}
