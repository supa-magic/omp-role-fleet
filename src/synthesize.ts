/**
 * Role synthesis: task text → a small set of roles with omp model-role aliases.
 *
 * No configuration is consulted. The fan-out is deliberately conservative: a
 * task gets only the roles its shape implies, and the cap bounds the worst case
 * on a vague request.
 */
import { join } from "node:path";
import type { Capability, Effort, RolePlan, RoleSpec } from "./core.ts";
import { applySpecialists, SPECIALISTS } from "./library.ts";
import { aliasFor, BUILD_TOOLS, CAPABILITY_ID, DEFAULT_MAX_ROLES, grantsWrite, isCouncilMember, isSliceSeat, MAX_SLICES, READ_TOOLS, VOCAB, WRITE_TOOLS } from "./core.ts";

/** Every classification below reads `core.VOCAB`. The six regexes that used to
 *  live here were the divergence that table removes; it carries the two rules
 *  (verbs apart from nouns, `\b` on both sides) and the reason for each entry. */

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

export function synthesizePlan(opts: PlanOptions): RolePlan {
  const { task, cwd, workDir } = opts;
  const requestedCap = opts.maxRoles ?? DEFAULT_MAX_ROLES;
  // A change cast needs at least an investigator and a worker. At a cap of one
  // the priority order kept the implementer and dropped the scout, so the seat
  // told to "implement the locked plan" had no plan and no investigation; the
  // floor is two, and the caller is told when the ask was raised.
  const maxRoles = Math.max(2, requestedCap);
  const notes: string[] = [];
  if (requestedCap < maxRoles) notes.push(`role cap ${requestedCap} raised to ${maxRoles}: a cast needs a worker and an investigator`);

  // A migration that names no code vocabulary is still a change: "migrate off
  // lodash", "upgrade the deps", "move off webpack" carry no unconditional
  // `VOCAB.changeStrong` verb. Reading the shape off the catalog pattern is what keeps the
  // README's promise ("a migration is implementation, so the runner replaces the
  // implementer"); without it the specialist is skipped for want of an
  // implementer to replace, and a task that asked to change the tree ships a
  // scout and a reviewer that reviews nothing. What vetoes it is a look-verb —
  // "research migration options" is a look at a migration, not a migration, and
  // it must not mint a writer. The veto is a verb list and never a noun list:
  // "upgrade the library to the latest version" is a migration that `library`
  // and `version` would otherwise veto, naming a subject as often as a task.
  //
  // The verb sets are split by ambiguity: `fix`/`add`/`refactor` are verbs and
  // always mint the code cast, while `build`/`update`/`write` are also ordinary
  // nouns and mint it only when nothing asks to look. Reading them as one list
  // is what let "profile the write path" and "compare the read path with the
  // write path" ship a shell-holding implementer for a measurement.
  // "review" is both the verb and the name of a product surface. When it names a
  // subject and the sentence reports a defect, the defect wins: the review page
  // showing stale data is a bug to fix, not a read-only review of the codebase.
  const looks = VOCAB.look.test(task) && !(VOCAB.reviewSubject.test(task) && VOCAB.defect.test(task));
  const migrationShape = SPECIALISTS.some((s) => s.replacesImplementer && s.match.test(task));
  const changesTree =
    VOCAB.changeStrong.test(task) ||
    (VOCAB.changeAmbiguous.test(task) && !looks) ||
    (VOCAB.defect.test(task) && !looks) ||
    (migrationShape && !looks);
  // An ask to run the checks is a verifier's work, not an implementation: "test
  // the checkout flow" wants the tester, and used to get an implementer beside
  // it because "test" is also a code subject. This reads `changesTree`, not the
  // raw verb list: a migration may name a test suite ("migrate the test suite to
  // vitest") and still be a change, and re-testing the weaker predicate here
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
  const docsOnly =
    docsAsk && !VOCAB.image.test(task) && (!VOCAB.codeNoun.test(task) || !VOCAB.changeStrong.test(task));
  /** The docs seat writes when asked for documentation, or when there is a
   *  delivered change to document; it reads when the ask is to find out. */
  const docsWrites = docsAsk || changesTree;
  const wantsCode = changesTree && !docsOnly && !verifyAsk;
  const wantsPlan = wantsCode && VOCAB.multiFile.test(task);
  const needsVision = VOCAB.image.test(task);

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

  const codeCast: Capability[] = ["scout", ...(wantsPlan ? (["plan"] as Capability[]) : []), "code"];
  // A UI task seats the designer over a separate tester (see the note below).
  if (!needsVision) codeCast.push("test");
  const caps: Capability[] = opts.reviewOnly
    ? ["scout", "review"]
    : wantsCode
      ? codeCast
      : verifyAsk
        ? ["scout", "test"]
        : ["scout"];
  if (!opts.reviewOnly) {
    if (docsAsk || (VOCAB.research.test(task) && !wantsCode)) caps.push("docs");
    if (wantsReview) caps.push("review");
    // A UI task's designer *is* its implementation — the seat's own acceptance
    // covers the interface, its states and its accessibility — so the designer
    // takes the seat and the separate tester is the one the cap can spend. The
    // other order ships an implementer and a tester for a page nobody was asked
    // to design.
    if (needsVision && wantsCode) notes.push("ui task: the designer takes the seat a tester would hold");
    // An analysis cast has to be able to answer the task it was thinned for: a
    // look-ask with no other seat would ship one investigator whose report
    // nobody reads. A cast that already answers it (a researcher, an auditor)
    // needs no addition.
    if (analysisIntent && !caps.includes("review") && caps.length === 1) caps.push("review");
  }
  if (opts.reviewOnly) notes.push("review-only: scout and review seats; no seat can change the code");

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
        // A shell, because the acceptance line asks for a check *executed*: the
        // edit/write pair cannot run one.
        tools: BUILD_TOOLS,
        artifact: `${workDir}/implementation.md`,
      },
      test: {
        id,
        // A verifier, when the task asked for checks rather than for a change:
        // "test the checkout flow" is not an implementation, and the seat it
        // wants is the one that runs things and reports output.
        title: verifyAsk ? "Verifier" : "Tester",
        mission: verifyAsk
          ? "Run the checks this task asks for and report their real output with evidence."
          : "Run the focused checks for the delivered change and report real output.",
        acceptance: verifyAsk
          ? ["Exact commands run", "Real pass/fail output", "Each claim backed by the output that shows it"]
          : ["Exact commands run", "Real pass/fail output", "Failures reproduced, not assumed"],
        dependsOn: verifyAsk ? dep(CAPABILITY_ID.scout) : dep(CAPABILITY_ID.code),
        // Same grant as the implementer: "exact commands run" needs a shell.
        tools: BUILD_TOOLS,
        artifact: `${workDir}/test-report.md`,
      },
      review: {
        id,
        title: "Reviewer",
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
        dependsOn: dep(CAPABILITY_ID.code).length
          ? dep(CAPABILITY_ID.code)
          : dep(CAPABILITY_ID.test).length
            ? dep(CAPABILITY_ID.test)
            : dep(CAPABILITY_ID.docs).length
              ? dep(CAPABILITY_ID.docs)
              : dep(CAPABILITY_ID.scout),
        tools: READ_TOOLS,
        artifact: `${workDir}/review.md`,
      },
      docs: {
        id,
        title: "Docs updater",
        // A writer when the ask is a documentation change or a code change to
        // document, a researcher when the ask is to find something out:
        // "research the library docs" needs a finding, not a licence to edit.
        mission: docsWrites
          ? wantsCode
            ? "Update user-facing documentation to match the delivered behavior."
            : "Write the documentation this task asks for."
          : `Research and summarize: ${task}`,
        acceptance: docsWrites
          ? ["Docs written and internally consistent", "Documented commands verified against code"]
          : ["Every claim backed by a primary source"],
        dependsOn: docsWrites ? (wantsCode ? dep(CAPABILITY_ID.code) : dep(CAPABILITY_ID.scout)) : [],
        tools: docsWrites ? WRITE_TOOLS : READ_TOOLS,
        artifact: `${workDir}/docs.md`,
      },
    }[cap];
    drafts.push({ ...draft, ...base } as RoleSpec);
  }

  // Only the cap can leave a change-shaped task without an implementer: every
  // other way an implementer is absent was decided above, and blaming "role cap"
  // for the cast `--review-only` asked for reports a cap that never bit.
  if (wantsCode && dropped.includes("code")) {
    notes.push(`role cap ${maxRoles} left no implementer; plan is analysis-only`);
  }

  if (analysisIntent) {
    // The implementer and tester were drafted because words like "code", "api",
    // or "test" hit the vocabulary — in a task that only asks to look. Keeping
    // them spends two paid runs on seats the request never asked for, and at the
    // cap pushes out the reviewer or auditor the task exists for. The tester
    // stays when the task asked for checks: that seat *is* the answer there, and
    // dropping it would remove the only one that could give it.
    const before = drafts.map((r) => r.id);
    const thinned = drafts.filter((r) => r.id !== "implementer" && !(r.id === "tester" && !verifyAsk));
    if (thinned.length !== before.length) {
      const gone = before.filter((id) => !thinned.some((r) => r.id === id));
      drafts = thinned;
      notes.push(`analysis intent: ${gone.join("/")} dropped for the review seats`);
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

  // Slice fan-out: one implementation across several writers, when asked for.
  // It runs after the specialists so that a migration — one writer by design,
  // since two writers on the same files is a defect rather than a feature — has
  // already taken the implementer's place and refuses the split here, and after
  // the edge repair so the seats that waited on `implementer` are the ones
  // rewritten below.
  const slices = Math.min(opts.slices ?? 1, MAX_SLICES);
  if (slices > 1) {
    const at = drafted.findIndex((r) => r.id === CAPABILITY_ID.code);
    const split = drafted[at];
    if (at === -1 || split === undefined) {
      notes.push(`--slices ${slices}: no implementer seat to fan out — the cast is ${drafted.map((r) => r.id).join(", ")}`);
    } else {
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
      drafted.splice(at, 1, ...sliceSeats);
      // Everything that waited on the single implementer waits on every slice:
      // a seat that waited on the first one alone would start before the rest of
      // the change existed.
      const ids = sliceSeats.map((r) => r.id);
      drafted.forEach((r, i) => {
        if (!(r.dependsOn ?? []).includes(CAPABILITY_ID.code)) return;
        drafted[i] = {
          ...r,
          dependsOn: (r.dependsOn ?? []).flatMap((d) => (d === CAPABILITY_ID.code ? ids : [d])),
        };
      });
      notes.push(
        `slices: ${slices} implementer seats on one implementation (${ids.join(", ")}) — the file partition comes from the scout's map, so the orchestrator names each seat's files in its dispatch item`,
      );
    }
  }

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
  // The members' reports have to reach the filesystem for the consul to read
  // them, and the channel for that already exists: a read-only seat returns its
  // report as a yield payload and the orchestrator writes it to the seat's
  // artifact path before the next wave (`render.renderDispatch` says so, and
  // every downstream brief in every run depends on it). Granting the members
  // `write` to make that file themselves is redundant authority — `write` takes
  // any path in the repo, and the seat's own acceptance line is a convention,
  // not a boundary — so the council keeps its read-only grant and the path is
  // filled the same way the scout's and the planner's already are.
  if (opts.consul) {
    const members = drafted.filter((d) => isCouncilMember(d.id));
    if (!members.length) {
      notes.push(`--consul ${opts.consul} had no council members to read — the session model will synthesize`);
    } else {
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
        tools: READ_TOOLS,
        effort: "high",
        needsVision: false,
        model: opts.consul,
        artifact: `${workDir}/consul.md`,
      });
      notes.push(
        `consul ${opts.consul}: reads ${members.length} council report(s), placed at ${workDir}/ by the orchestrator`,
      );
    }
  }
  // Council members, the consul and the slice seats are one logical seat each —
  // the council replaced the single reviewer, the fan-out replaced the single
  // implementer — so the cap never trades them away: dropping two of three
  // reviewers is not a smaller council but a broken one, and spending a slot per
  // writer *file* would drop the tester and the reviewer first, leaving a
  // fanned-out change unreviewed.
  // Exempt on `core`, not on the id: `migration-runner` runs the implementer
  // seat under its own id. Today the two cannot disagree — a migration writer
  // replaces the implementer in place, so it always lands inside the kept
  // prefix, and the slice below never sees it — but the id test was correct only
  // by accident of that insertion order. Keying on the seat that carries the
  // authority is what makes it correct by construction; the cost is one word.
  // The position the cap reads is taken over a list where the fan-out occupies
  // its single slot, so seats after it are measured where they really sit.
  const firstSliceAt = drafted.findIndex((r) => isSliceSeat(r.id));
  const perSeat = drafted.filter((r, i) => !isSliceSeat(r.id) || i === firstSliceAt);
  const overflowIds = new Set(
    perSeat
      .slice(maxRoles)
      .filter((r) => r.core !== "implementer" && r.core !== "consul" && !isCouncilMember(r.id))
      .map((r) => r.id),
  );
  const overflow = drafted.filter((r) => overflowIds.has(r.id));
  const roles = overflow.length ? drafted.filter((r) => !overflowIds.has(r.id)) : drafted;
  if (overflow.length) notes.push(`role cap ${maxRoles}: dropped ${overflow.map((r) => r.id).join(", ")}`);
  // The exempt roles are kept on purpose, but "kept on purpose" is not the same
  // as "the cap was met": `--max-roles 2 --council 3` ships five roles, and the
  // plan said nothing. The real fan-out is what the reader budgets against.
  if (roles.length > maxRoles) {
    notes.push(`role cap ${maxRoles} exceeded: ${roles.length} roles (council members, slice seats and the consul are exempt)`);
  }

  // Stated from the cast that ships rather than promised earlier in the pass:
  // the answer is the grant rule itself now — `edit`, `write` or a shell — so a
  // seat that can run commands cannot leave a cast claiming nothing changes.
  // `--review-only` already said this in its own words.
  if (analysisIntent && !opts.reviewOnly && !roles.some((r) => grantsWrite(r.tools))) {
    notes.push("analysis-only intent: no seat in this cast can change the code");
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
  const refusing = opts.analysisOnly ? "an analysis-only plan" : plan.roles.some((r) => isSliceSeat(r.id)) ? "a fanned-out plan" : null;
  const writers = refusing ? proposed.filter((r) => grantsWrite(r.tools)) : [];
  const writable = writers.length ? proposed.filter((r) => !writers.includes(r)) : proposed;
  if (writers.length) {
    plan.notes.push(`proposed writer(s) refused on ${refusing}: ${writers.map((r) => r.id).join(", ")}`);
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
    plan.notes.push(`generated specialists: ${kept.map((r) => r.id).join(", ")}`);
  }
  if (dropped.length) {
    plan.notes.push(`role cap ${maxRoles}: dropped ${dropped.join(", ")}`);
  }
  if (severed.length) {
    plan.notes.push(`dependency left the plan, role now waits on its remaining deps: ${severed.join(", ")}`);
  }
  // The static pass already reports an exempt overrun; a merge can add a seat
  // after that note was written, so the final cast gets the same sentence.
  if (merged.length > maxRoles) {
    plan.notes.push(
      `role cap ${maxRoles} exceeded: ${merged.length} roles (council members, slice seats and the consul are exempt)`,
    );
  }
  return { ...plan, roles: merged };
}