import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Types and pure logic for dynamic role plans.
 *
 * Version A — zero configuration: a role's model is an omp model-role alias
 * (`@smol`, `@plan`, `@task`, `@slow`, `@vision`, plus `@designer` for the UI
 * seat — which is not a stock omp role and only resolves if the user has a
 * `modelRoles.designer` entry), resolved by omp
 * at launch exactly the way hand-written agents resolve theirs. Which concrete
 * model fills each alias is the user's existing `/model` configuration, not a
 * second fleet to maintain here.
 *
 * An explicit allowlist file (`ROLE_FLEET_ALLOWLIST` or `--allowlist`) remains
 * as an exception for pinning: when present, every model the file describes is
 * taken from it, and `bindFleet` enforces that. A seat the file does not
 * describe keeps its alias with a note — the file constrains, it does not have
 * to describe the whole world.
 */

/** What a seat is for, keyed by the words the synthesis heuristics match on. */
export type Capability = "scout" | "plan" | "code" | "test" | "review" | "docs";

/**
 * The seat id each capability mints.
 *
 * In `core` because two modules need it and neither owns it: `synthesizePlan`
 * drafts its seats from it, and the proposal sandbox (`generate.parseProposal`)
 * must refuse exactly these ids. A hand-synced copy there is correct only until
 * this map changes, and the failure is silent — a proposal that claims
 * `designer` is refused rather than merged.
 */
export const CAPABILITY_ID: Record<Capability, string> = {
  scout: "scout",
  plan: "planner",
  code: "implementer",
  test: "tester",
  review: "reviewer",
  docs: "docs-updater",
};

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

/**
 * Tool grants. One definition each, here: the static cast, the specialist
 * catalog and the proposal sandbox all draw from these, so a grant change is
 * one edit rather than three that must agree. A grant list is a security
 * boundary — the proposal sandbox in particular is only as tight as this array.
 *
 * The list is also the seat's *whole* toolset: a definition's `tools` replaces
 * the default set rather than extending it, and the host treats an agent as
 * read-only exactly when every declared tool sits in its own read tier. So
 * `find` and `ast_grep` belong here — both are in that tier, and a seat whose
 * mission is to locate where a task touches cannot do it with `read`, `grep` and
 * `glob` alone: `find` is the behaviour search and `ast_grep` the structural one.
 */
export const READ_TOOLS = ["read", "grep", "glob", "find", "ast_grep"];
/** Read plus edits: a seat that changes files without a shell. */
export const WRITE_TOOLS = [...READ_TOOLS, "edit", "write"];
/**
 * Read, edits and a shell: the seats that have to *run* something.
 *
 * The tester's "exact commands run" and the implementer's "focused check
 * executed and its real output reported" are not satisfiable with the edit/write
 * pair, and nothing in the read tier can execute anything either. A shell is also
 * strictly wider authority than either: it can write any path it can name, delete
 * what it can reach, and start anything else on the machine — so it is its own
 * grant, given only to the seats whose mission needs it, and the consent screen
 * names it separately rather than counting it as an editor.
 */
export const BUILD_TOOLS = [...WRITE_TOOLS, "bash"];

/**
 * Whether a grant can change the tree.
 *
 * A predicate rather than an `includes("edit")`, because `bash` writes: every
 * rule that asks "may this seat change the code?" — the analysis-only guarantee,
 * the proposal merge, the consent screen's authority line, the grant note on the
 * emitted definition — has to answer the same way, and the one that read `edit`
 * alone is how a shell-capable seat would slip past a promise that nothing
 * writes.
 */
export function grantsWrite(tools: readonly string[]): boolean {
  return tools.some((tool) => tool === "edit" || tool === "write" || tool === "bash");
}

/**
 * The task vocabulary: one table, one spelling per concept.
 *
 * Every classification in this plugin reads from these entries — the cast
 * (`synthesizePlan`), the specialist catalog (`library.SPECIALISTS`), the
 * dynamic tier (`generate.shouldPropose`) and the council wording read off the
 * task text (`runRoleFleet`). They used to be six independent regexes plus a
 * second spelling of the migration and security words in the catalog, and
 * nothing checked them against each other: `wantsCode` knew a verb set that the
 * build-verb list vetoing analysis did not, so `add a dark mode toggle` — a
 * build task by any reading — shipped a cast of one investigator.
 *
 * Two rules hold here, by construction rather than by test:
 *
 *  - Verbs are kept apart from nouns. `api`, `module`, `test` name a *subject*;
 *    `add`, `fix`, `refactor` ask for a change. Reading them as one list is what
 *    made `explore the api surface` mint an implementer and a tester.
 *  - Every entry is `\b`-delimited at both ends. `\bcheck` matched "checkbox",
 *    which bought a review seat for `improve the checkbox styling`.
 *
 * A word two seats share belongs in one entry both read (`image` drives both the
 * vision cast and the designer seat; `security` both the analysis veto and the
 * security seat), never in two lists that must be kept in step.
 */
export const VOCAB = {
  /**
   * Asks for the tree to change, in words that are unambiguous verbs.
   *
   * Migration vocabulary is deliberately absent: a migration is a change *when
   * nothing asks to look* (see `VOCAB.migration` and the veto in
   * `synthesizePlan`), and carrying `migrat*` here would make "evaluate
   * migrating off lodash" mint the writer the veto exists to refuse.
   */
  changeStrong:
    /\b(fix\w*|refactor\w*|implement\w*|add|create\w*|rewrite\w*|remove\w*|delet\w*|rename\w*|improv\w*|redesign\w*)\b/i,
  /**
   * Change words that are also ordinary nouns: `build`, `update`, `write`,
   * `patch`, `change`. They mint the code cast only when nothing in the text
   * asks to look — otherwise "profile the write path" and "compare the read
   * path with the write path" buy a shell-holding implementer for a task whose
   * only imperative is to measure and explain.
   */
  changeAmbiguous:
    /\b(build\w*|updat\w*|upgrad\w*|writ\w*|port|convert\w*|drop|replac\w*|patch\w*|change|memoiz\w*|optimi[sz]\w*|speed up|enable\w*|disable\w*|bump\w*|sort\w*|cach\w*|log(?:s|ged|ging)?|handl\w*|support\w*|allow\w*|prevent\w*|guard\w*|validat\w*|sanitiz\w*|expos\w*|simplif\w*|consolidat\w*|extract\w*|split\w*|move\w*|align\w*)\b/i,
  /**
   * Reported defects. A bug report is a change ask even when it carries no
   * change verb: "the review page shows stale data" is not a request to look,
   * and must not be thinned to a read-only cast. A look-verb still wins —
   * "audit for stale data" is an investigation.
   */
  defect:
    /\b(bug|bugs|broken|crash\w*|fail(?:s|ed|ing)?|failure|stale|incorrect|wrong|regression|error\w*|doesn't work|not working|slow\w*)\b/i,
  /** Asks to look at something rather than to change it. */
  look:
    /\b(research\w*|investigat\w*|compar\w*|evaluat\w*|survey\w*|explor\w*|analy[sz]\w*|assess\w*|audit\w*|review\w*|inspect\w*|verif\w*|check(?:s|ed|ing)?|explain\w*|understand|figur\w*|find|locate|search\w*|profil\w*|measur\w*|look at|walk through|trace through)\b/i,
  /** Asks for checks to be run: a verifier's work, not a builder's. */
  verify: /\b(test(?:s|ed|ing)?|verif\w*|check(?:s|ed|ing)?|repro\w*|reproduc\w*|regress\w*|benchmark\w*|measur\w*|profil\w*)\b/i,
  /** Names code as the subject without asking to change it. */
  codeNoun:
    /\b(code|bug\w*|api|module\w*|function\w*|crate|rust|typescript|javascript|python|schema\w*|endpoint\w*|service\w*|middleware|packag\w*|deps?|dependenc\w*|librar\w*|repo\w*|codebase|script\w*|parser\w*|cli|sdk|database|quer\w*|sql|css|html|frontend|backend|server\w*|client\w*)\b/i,
  /** Broad-scope work: earns a planner. */
  multiFile:
    /\b(refactor\w*|migrat\w*|across|several files|multi-file|whole repo|entire repo|all files|every file|suite|codemod\w*)\b/i,
  /** UI and visual work: a vision seat, and the designer seat. */
  image:
    /\b(screenshot\w*|image\w*|ui|ux|design\w*|visual\w*|layout\w*|render\w*|mockup\w*|wireframe\w*|frontend page|web page|landing page|css|stylesheet\w*|theme|dark mode)\b/i,
  /** An ask for documentation output. Code comments are code-adjacent, not a
   *  docs ask: "add a comment explaining the loop" must mint the implementer,
   *  not a docs-updater that leaves the loop alone. */
  docs: /\b(docs?|document\w*|readme|changelog|guide|tutorial)\b/i,
  /**
   * Finding out about the world, rather than about this tree.
   *
   * `compare`, `library` and `version` are here because the old research hint
   * carried them and "compare the two libraries" is a research ask that must
   * still reach the read-only docs seat. The nouns are safe now: the migration
   * veto reads the verb-only `VOCAB.look`, and the docs seat this drives is only
   * pushed for a task that changes nothing, so "upgrade the library to the
   * latest version" cannot re-open the writer-less cast the old hint's comment
   * worried about.
   */
  research:
    /\b(research\w*|compar\w*|market|competitor\w*|benchmark\w*|survey\w*|upstream|librar\w*|version\w*|pricing|price\w*|trade-?offs?|options)\b/i,
  /** Security-shaped work: the analysis veto, and the security seat. */
  security: /\b(security|vulnerab\w*|pentest|injection|xss|csrf|exploit\w*|threat model)\b/i,
  /** Asks for a review seat (a look-ask does not always). */
  review: /\b(review\w*|audit\w*|assess\w*|check(?:s|ed|ing)?|verif\w*|inspect\w*)\b/i,
  /** `review` as the name of a product surface, not an ask to review it:
   *  "the review page shows stale data" is a defect report about that page. */
  reviewSubject:
    /\b(review\w*\s+(?:page|flow|screen|view|panel|dashboard|process|queue|table|component|endpoint|api|service|system|module|feature))\b/i,
  /** Council wording taken off the task text. */
  council: /\b(council|different (?:models|providers)|multi-model|cross-model|several models)\b/i,
  /** The user named a specialist outright. */
  specialistAsk: /\b(specialist|expert|consultant)\b/i,
  /** Migration shapes: a migration is a change, and the catalog seat that
   *  stands in for the implementer reads the same words. */
  migration: /\b(migrat\w*|port from|upgrade (?:the )?(?:deps|dependencies|framework|libs?|libraries)|move off)\b/i,
} as const;

/**
 * Prefix for every generated agent name.
 *
 * omp resolves an agent by name with project definitions replacing bundled
 * ones, so emitting `scout.md` would silently swap the bundled scout for this
 * plan's mission text for the whole session. Namespaced `rf-*` names keep the
 * generated seats and the bundled specialists independent.
 *
 * It lives here rather than beside the emitter because the settled-result
 * observer matches it too: two copies drifting apart would switch the whole
 * model-observation feature off without a sound.
 */
export const AGENT_PREFIX = "rf-";

/**
 * Default cap on generated roles, when the caller names none.
 *
 * One definition, because the cap is a fan-out promise the user reads on the
 * flag help, the tool schema and the notes: three copies of `4` drift the
 * moment one of them is changed. `MAX_ROLES` in `src/flags.ts` is the hard
 * ceiling and stays separate — this is the *default*, not the limit.
 */
export const DEFAULT_MAX_ROLES = 4;

/**
 * Most write seats one `--slices` run may fan the implementation out across.
 *
 * Every slice seat is a concurrent paid writer, and the count is also what the
 * orchestrator has to keep apart: past a handful, no dispatch item is likely to
 * get a genuinely disjoint file set, and two writers on one file is the defect
 * the cast exists to avoid. The flag path and the tool schema share this bound
 * so neither can ask for a fan-out the other refuses.
 */
export const MAX_SLICES = 4;

/**
 * Council member ids: `reviewer-c1`, `reviewer-c2`, …
 *
 * The pattern is matched in five places (council detection, cap exemptions,
 * roster filtering, dispatch guidance), and a member past the ninth must still
 * count as a member — hence `\d+`, not `\d`. Council size is bounded by
 * `MAX_COUNCIL` in `src/flags.ts`, so a copy drifting past that would be a
 * defect; a regex that silently stops matching is the same defect earlier.
 */
export function isCouncilMember(id: string): boolean {
  return /^reviewer-c\d+$/.test(id);
}

/**
 * Implementer seats of a fan-out: `implementer-1`, `implementer-2`, …
 *
 * `--slices N` replaces the single implementer with N of these, so the seats
 * that used to wait on `implementer` learn to wait on all of them, the dispatch
 * tells the orchestrator to name each one's files, and the proposal merge knows
 * the implementation is already fanned out. One pattern, three readers — the
 * same reason `isCouncilMember` lives here rather than at its first call site.
 */
export function isSliceSeat(id: string): boolean {
  return /^implementer-\d+$/.test(id);
}

/**
 * One line per seat, in the words a person uses.
 *
 * The seat id is machinery (`reviewer-c1`); this is what the seat is *for*, and
 * it is the only thing that can make a cast reviewable by a human: "Reviewer 2"
 * says nothing, "independent review of the change on its own model" says who
 * is paying and what comes back. Lives here rather than beside the emitter
 * because three surfaces read it — the agent picker, the cast confirmation, and
 * the dispatch table — and three copies of the same sentence would drift.
 */
export const SEAT_PURPOSE: Record<string, string> = {
  scout: "maps where the task touches, with file:line evidence",
  planner: "turns the investigation into a locked implementation plan",
  implementer: "implements the plan with the smallest correct change",
  tester: "runs the focused checks and reports their real output",
  reviewer: "reviews the change for correctness, scope, and evidence",
  consul: "reconciles the council's reports into one verdict",
  "docs-updater": "keeps user-facing documentation true to shipped behavior",
  designer: "builds and polishes the interface, accessibility included",
  "security-auditor": "audits the surface for vulnerabilities, with evidence",
  "migration-runner": "runs a dependency or framework migration in ordered, verifiable steps",
  "db-migration-auditor": "reviews the schema change and its rollback path",
};

/** A model an allowlist can pin to: `selector` names it, `aliases` add lookup
 *  names, `enabled: false` takes it out of every chain. */
export interface FleetModel {
  selector: string;
  aliases?: string[];
  enabled?: boolean;
}

/** A seat the allowlist pins. Only these fields are read: `role` names the
 *  seat, `chain` lists models in preference order, `aliases` adds lookup
 *  names for the seat. Anything else a file carries is ignored. */
export interface FleetRole {
  role: string;
  aliases?: string[];
  chain?: string[];
}

export interface Fleet {
  models: FleetModel[];
  roles: FleetRole[];
}

export interface RoleSpec {
  id: string;
  title: string;
  mission: string;
  acceptance: string[];
  /** Fleet seat this executes as (documentation and allowlist-mode routing). */
  core: string;
  dependsOn: string[];
  tools: string[];
  effort: Effort;
  needsVision: boolean;
  /** Where the worker writes its result. */
  artifact: string;
  /** An omp model selector or role alias such as "@smol". */
  model: string;
  /**
   * Concrete `provider/id` resolved from `model` at plan time when the host
   * can answer. Display-only: frontmatter still pins `model` so role aliases
   * and host fallback chains keep working. Absent when unresolved.
   */
  modelResolved?: string;
}

export interface RolePlan {
  task: string;
  cwd: string;
  roles: RoleSpec[];
  notes: string[];
  /** Which run produced this plan; emitted into agent files for prune scoping. */
  runId?: string;
  /**
   * The task asked to look, not to change — so no seat may gain write access.
   *
   * Set by `synthesizePlan` from the structural intent it already computes, and
   * read by the pipeline to gate the dynamic tier. It is carried on the plan
   * rather than recomputed there because "does this cast hold a writer" is not
   * the same question: `migration-runner` and `designer` write under ids that
   * are not `implementer`, so an id test called a plan that ships a writer
   * analysis-only and refused proposed writers for a reason that did not hold.
   * Optional only so a hand-built plan literal typechecks; a real plan always
   * carries it.
   */
  analysisOnly?: boolean;
}

/** What one settled seat did, as the host reported it. Written into the run
 *  manifest after dispatch; absent fields mean the host did not supply them. */
export interface RunOutcome {
  agent: string;
  /** Model the plan pinned, when the plan-time baseline is still known. */
  planned?: string;
  /** Concrete model the host reports for the settled run. */
  ran?: string;
  fallback: boolean;
  route?: string;
  exitCode?: number;
  error?: string;
  aborted?: boolean;
  retryFailure?: unknown;
  tokens?: number;
  requests?: number;
  durationMs?: number;
  /** The seat's own `verdict` field, when it yielded the declared schema. */
  verdict?: string;
  /** Where the full report was placed, if the plugin persisted it. */
  artifact?: string;
}

/** The gate is binary by design: a plan either ships as-is or is refused with
 *  issues. There is no "amend" path — the caller fixes the task, not the plan. */
export type Verdict = "approve" | "reject";

export interface GateVerdict {
  verdict: Verdict;
  reason: string;
  issues: string[];
}

/**
 * Role → omp model-role alias.
 *
 * The mapping mirrors what each kind of work needs, not which vendor is cheap:
 * recon wants fast and inexpensive (`@smol`), implementation takes the general
 * subagent role (`@task`) — the planner already did the heavy thinking, and an
 * executor of a locked plan does not need a premium seat — while review and
 * security want the strongest reasoning (`@slow`). The tester runs focused
 * checks and reports real output, which is mechanical, so it rides `@smol`;
 * diagnosing a failure it finds is the implementer's job, not its own.
 * Users retarget a whole class of work by moving one alias in `/model` — no
 * plugin configuration involved.
 */
export const ROLE_ALIAS: Record<string, string> = {
  scout: "@smol",
  planner: "@plan",
  implementer: "@task",
  tester: "@smol",
  reviewer: "@slow",
  security: "@slow",
  "docs-updater": "@smol",
};

export function aliasFor(core: string): string {
  return ROLE_ALIAS[core] ?? "@task";
}

/** Coarse task-tool effort. Host precedence: caller `effort` > model `:suffix` > agent `thinking-level`. */
export type TaskEffort = "lo" | "med" | "hi";

/**
 * Map a seat's thinking effort onto the task tool's `lo` | `med` | `hi`.
 *
 * The host resolves modelRoles suffixes (e.g. `@smol` → `provider/id:auto`) with
 * `explicitThinkingLevel`, which beats agent-frontmatter `thinking-level`. The only
 * override that wins over that is per-spawn `effort` on the task call — so dispatch
 * must carry this value or modelRoles silently erase the seat's planned effort.
 */
export function taskEffort(effort: Effort): TaskEffort {
  switch (effort) {
    case "off":
    case "minimal":
    case "low":
      return "lo";
    case "high":
    case "xhigh":
    case "max":
      return "hi";
    default:
      // medium, auto, and any future value the type has not named yet
      return "med";
  }
}

/**
 * Dependency-ordered waves; roles inside a wave run in parallel.
 * A cycle releases the blocked roles together in a final wave so the dispatcher
 * reports the conflict instead of waiting forever.
 */
export function planWaves(roles: RoleSpec[]): RoleSpec[][] {
  const known = new Set(roles.map((r) => r.id));
  const done = new Set<string>();
  const waves: RoleSpec[][] = [];
  const remaining = [...roles];

  while (remaining.length) {
    const wave = remaining.filter((r) =>
      (r.dependsOn ?? []).every((d) => done.has(d) || !known.has(d)),
    );
    if (!wave.length) {
      waves.push(remaining.splice(0, remaining.length));
      break;
    }
    for (const r of wave) {
      done.add(r.id);
      remaining.splice(remaining.indexOf(r), 1);
    }
    waves.push(wave);
  }
  return waves;
}

/**
 * Static plan validation. Allowlist enforcement (when a file is in play) lives
 * in `bindFleet`; this pass checks what must hold in every mode.
 */
export function validatePlan(plan: RolePlan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const declared = new Set(plan.roles.map((r) => r.id));

  if (!plan.roles.length) errors.push("plan has no roles");
  for (const r of plan.roles) {
    if (ids.has(r.id)) errors.push(`duplicate role id ${r.id}`);
    ids.add(r.id);
    if (!r.model) errors.push(`role ${r.id}: no model`);
    if (!r.acceptance.length) errors.push(`role ${r.id}: no acceptance criteria`);
    if (!r.artifact) errors.push(`role ${r.id}: no artifact path`);
    for (const d of r.dependsOn ?? []) {
      if (!declared.has(d)) errors.push(`role ${r.id}: unknown dependency ${d}`);
    }
  }
  return errors;
}

/**
 * Lookup key for seats and models: trimmed, case-folded, punctuation-folded.
 *
 * One normalizer for both indexes on purpose. A hand-edited allowlist with a
 * trailing space or a different slash spelling must resolve, not silently fall
 * through to "seat not in allowlist" and leave an alias in a pinned run.
 */
/**
 * `~` in a path that arrives from a prompt, a flag, or an env var.
 *
 * A prompt is not a shell, so `~` arrives literally and `readFile` cannot
 * resolve it. One implementation for the flag parser, the pipeline backstop and
 * the command surface; living in the domain kernel keeps `flags.ts` from
 * importing the whole orchestration graph for four lines.
 */
export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Thinking-level names that may suffix a concrete model: `provider/id:high`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/**
 * `provider/id:high` → `provider/id`: the suffix is a thinking level, not part
 * of the model identity. Used by both the ledger and the observer, so the two
 * cannot disagree about whether a seat changed models.
 */
export function baseModel(value: string): string {
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return value;
  return THINKING_LEVELS.includes(value.slice(colon + 1)) ? value.slice(0, colon) : value;
}

export function normalizeSeat(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function modelIndex(fleet: Fleet): Map<string, FleetModel> {
  const idx = new Map<string, FleetModel>();
  for (const m of fleet.models) {
    idx.set(normalizeSeat(m.selector), m);
    for (const a of m.aliases ?? []) idx.set(normalizeSeat(a), m);
  }
  return idx;
}

function roleIndex(fleet: Fleet): Map<string, FleetRole> {
  const idx = new Map<string, FleetRole>();
  for (const r of fleet.roles) {
    idx.set(normalizeSeat(r.role), r);
    for (const a of r.aliases ?? []) idx.set(normalizeSeat(a), r);
  }
  return idx;
}

/**
 * Allowlist mode: replace aliases with concrete selectors from the file.
 *
 * A role whose seat is absent from the file keeps its alias and a note — the
 * file constrains, it does not have to describe the whole world.
 *
 * Several roles can share one seat (a review council is three seats called
 * `reviewer`), so binding is ordinal per seat: member N takes the Nth usable
 * model of that seat's chain. Binding them all to the first entry would turn
 * "review with different providers" into three copies of one model at triple
 * the cost — the shared blind spot the council exists to avoid.
 */
export function bindFleet(fleet: Fleet, roles: RoleSpec[], notes: string[]): RoleSpec[] {
  const ridx = roleIndex(fleet);
  const midx = modelIndex(fleet);
  const ordinal = new Map<string, number>();
  return roles.map((r) => {
    const seatKey = normalizeSeat(r.core);
    const seat = ridx.get(seatKey);
    if (!seat) {
      notes.push(`role ${r.id}: seat "${r.core}" not in allowlist — keeping ${r.model}`);
      return r;
    }
    // The ordinal must be keyed by the *normalized* seat, exactly like the
    // lookup above: "Reviewer" and "reviewer" resolve to one seat, so they must
    // also share one counter — otherwise both take chain[0] and the multi-model
    // spread this whole mechanism exists for collapses.
    const n = ordinal.get(seatKey) ?? 0;
    ordinal.set(seatKey, n + 1);
    const chain = (seat.chain ?? [])
      .map((token) => midx.get(normalizeSeat(token)))
      .filter((m): m is FleetModel => !!m && m.enabled !== false);
    if (!chain.length) {
      notes.push(`role ${r.id}: seat "${r.core}" has no enabled model in its chain — keeping ${r.model}`);
      return r;
    }
    if (n >= chain.length) {
      // The file describes fewer distinct models than this seat has members.
      // Reusing one would quietly undo the spread the seat exists for, so the
      // member keeps its own alias and the plan says the run is partly unpinned.
      notes.push(
        `role ${r.id}: seat "${r.core}" offers ${chain.length} enabled model(s) — keeping ${r.model}`,
      );
      return r;
    }
    return { ...r, model: chain[n].selector };
  });
}