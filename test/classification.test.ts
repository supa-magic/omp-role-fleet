/**
 * The task→cast decision layer: what a task text is worth, seat for seat.
 *
 * `synthesizePlan` is the one place a task becomes a plan, and every
 * misclassification it shipped in 1.3.6 was a missing row here: `add a dark mode
 * toggle` — a build task by any reading — shipped a cast of one investigator,
 * `explore the api surface` minted an implementer and a tester off a noun, and
 * `update the readme` could not reach the docs seat at all. Each row below pins
 * one of those defects by its task text, and its `why` names the defect, so a
 * future rewrite of the vocabulary fails reporting the reason the row exists
 * rather than a diff of ids.
 *
 * The expectations are hand-vetted against the current `VOCAB`-driven cast. A
 * row that fails after a deliberate classification change gets re-vetted; it is
 * never relaxed until it passes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RolePlan } from "../src/core.ts";
import { grantsWrite, VOCAB } from "../src/core.ts";
import { isDegenerateCast, synthesizePlan } from "../src/synthesize.ts";

/** The cast a task text mints at the cap a real run uses. */
function cast(task: string, extra: Record<string, unknown> = {}): RolePlan {
  return synthesizePlan({ task, cwd: "/tmp", workDir: "/tmp/w", maxRoles: 4, ...extra });
}

/** The seat ids, in plan order — what every row below states its expectation in. */
function ids(plan: RolePlan): string[] {
  return plan.roles.map((r) => r.id);
}

interface CastRow {
  task: string;
  expected: string[];
  /** Named only where the row is pinning the flag itself; an omitted row makes
   *  no claim about it, so a row stays exactly as wide as its reason. */
  analysisOnly?: boolean;
  why: string;
}

// ── the cast table ────────────────────────────────────────────────────────────

const CASES: CastRow[] = [
  {
    task: "add a dark mode toggle",
    expected: ["scout", "implementer", "reviewer", "designer"],
    why: "`add` is a change verb, and this shipped one investigator: `wantsCode` knew a verb set the build-verb list vetoing analysis did not",
  },
  {
    task: "build a settings page",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`build` mints the code cast; `page` is a subject and mints nobody",
  },
  {
    task: "create a CLI for this",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`create` mints the code cast; `CLI` is a subject and mints nobody",
  },
  {
    task: "write a parser for the config format",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`writ\\w*` mints the code cast; `parser` is a subject and mints nobody",
  },
  {
    task: "port the app to vite",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`port` alone is a plain change verb — only the `port from` shape is a migration, so the implementer stays and the migration runner does not join",
  },
  {
    task: "build a landing page with a pricing section",
    expected: ["scout", "implementer", "reviewer", "designer"],
    why: "`build` is a change verb on a UI ask: the designer takes the seat a tester would hold, so no tester is minted",
  },
  {
    task: "fix the login bug",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`fix` mints the code cast; `bug` is a subject and mints nobody",
  },
  {
    task: "refactor the auth module across several files and review it",
    expected: ["scout", "planner", "implementer", "reviewer"],
    why: "`across several files` earns the planner and the cap 4 spends the tester — never the implementer",
  },
  {
    task: "improve the checkbox styling on settings",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "`improve` is a change verb; `\\bcheck` used to match \"checkbox\" and buy a seat off a word nobody typed",
  },
  {
    task: "render the checkerboard pattern",
    expected: ["scout", "designer"],
    why: "a UI ask with no change verb: the designer *is* the cast, and no tester is minted for it",
  },
  {
    task: "design a new onboarding flow",
    expected: ["scout", "designer"],
    why: "a pure UI ask with no change verb: the designer is the whole cast",
  },
  {
    task: "design a threat model for the payment flow",
    expected: ["scout", "reviewer", "security-auditor"],
    analysisOnly: true,
    why: "`threat model` is a security shape and no verb asks to change anything, so the auditor joins and the designer — a write seat — is refused",
  },
  {
    task: "audit the design of the login flow",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`audit` is a look verb and `design` hits the image vocabulary, but an analysis plan has no room for a write seat",
  },
  {
    task: "review the design of the api",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "a look verb with one code noun: `api` must not mint a builder for a task that asked nobody to build",
  },
  {
    task: "inspect the design tokens",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`inspect` is a look verb; the image vocabulary it trips mints nothing once the plan is analysis-only",
  },
  {
    task: "investigate the bug in the payment module",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`bug` and `module` are code nouns, and a noun must not mint a builder",
  },
  {
    task: "explore the api surface",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "a look verb with code nouns: reading verbs and nouns as one list is what minted an implementer and a tester here",
  },
  {
    task: "analyse the module structure",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`module` is a subject, not a change ask",
  },
  {
    task: "explain how the api module works",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`explain` is a look verb; `api` and `module` are subjects and mint nobody",
  },
  {
    task: "test the payment checkout flow",
    expected: ["scout", "tester"],
    analysisOnly: false,
    why: "an ask to run the checks is a verifier's work, not an implementation: no implementer, and the tester keeps `edit` so the plan is not analysis-only",
  },
  {
    task: "review the test suite across several files",
    expected: ["scout", "tester", "reviewer"],
    analysisOnly: true,
    why: "the look verb vetoes the code cast while `suite` earns the reviewer and `test` keeps the verifier — a shell-capable seat, so no \"no seat can change the code\" note follows even though the flag is set",
  },
  {
    task: "audit the deps",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "`deps` is a code noun; the look verb makes this a review of them, not a change to them",
  },
  {
    task: "assess the security posture of the repo",
    expected: ["scout", "reviewer", "security-auditor"],
    analysisOnly: true,
    why: "a security word vetoes the tree change and earns the auditor; `repo` is a subject and mints nobody",
  },
  {
    task: "research migration options",
    expected: ["scout", "docs-updater"],
    analysisOnly: true,
    why: "a look-verb vetoes the migration writer, and `research` reaches the docs seat — the one that reports rather than edits",
  },
  {
    task: "evaluate migrating off lodash",
    expected: ["scout", "reviewer"],
    analysisOnly: true,
    why: "a look-verb vetoes the migration writer: the catalog pattern matches, `VOCAB.look` is what refuses the cast",
  },
  {
    task: "migrate off lodash",
    expected: ["scout", "planner", "migration-runner", "reviewer"],
    why: "a migration is a change when nothing asks to look: the catalog pattern drives it (no `VOCAB.changeStrong` verb is there to), `migrat\\w*` earns the planner, and the cap 4 spends the tester",
  },
  {
    task: "upgrade the deps",
    expected: ["scout", "migration-runner", "tester", "reviewer"],
    why: "migration vocabulary with no plain change verb: without the catalog pattern this shipped a scout and a reviewer with nothing to review",
  },
  {
    task: "move off webpack",
    expected: ["scout", "migration-runner", "tester", "reviewer"],
    why: "`move off` is a migration shape rather than a change verb — the runner replaces the implementer in place",
  },
  {
    task: "update the readme",
    expected: ["scout", "docs-updater"],
    why: "a docs ask with no code noun and no UI is a docs cast even though `updat\\w*` is a change verb: the verb applies to the document, not the tree, so no implementer and no tester",
  },
  {
    task: "write the changelog",
    expected: ["scout", "docs-updater"],
    why: "`writ\\w*` on a document is still a docs cast: the docs seat was reachable only through a code or research shape, so this shipped one investigator",
  },
  {
    task: "document the api",
    expected: ["scout", "docs-updater"],
    why: "`document` is the ask and `api` the subject — this used to ship an implementer for the one code word in it",
  },
  {
    task: "document how auth works",
    expected: ["scout", "docs-updater"],
    why: "a docs ask with no code noun and no UI: the docs seat, not an implementer",
  },
  {
    task: "translate the docs to russian",
    expected: ["scout", "docs-updater"],
    why: "the docs noun carries the shape; no change verb is needed to ask for a document",
  },
  {
    task: "отрефактори модуль авторизации и проверь его",
    expected: ["scout"],
    why: "the vocabulary cannot read Cyrillic, so the static cast is one investigator — the degenerate cast the dynamic tier is keyed on is the only thing that rescues this task, and `analysisOnly` is false here too, which is why the tier cannot key on the flag instead",
  },
  {
    task: "исправь баг в логине",
    expected: ["scout"],
    why: "a verb the vocabulary does not carry leaves the static cast at one investigator; a degenerate cast is what the dynamic tier is keyed on",
  },
  {
    task: "profile the write path in the sqlite layer and tell me why inserts slow down at 10k rows",
    expected: ["scout", "tester"],
    analysisOnly: true,
    why: "`write` is a noun here and `profile` is a look verb: the ambiguous change word must not mint a shell-holding implementer for a measurement",
  },
  {
    task: "compare the read path with the write path",
    expected: ["scout", "docs-updater"],
    analysisOnly: true,
    why: "`compare` vetoes the ambiguous `write`; the docs seat researches, and no writer joins",
  },
  {
    task: "migrate the test suite to vitest",
    expected: ["scout", "planner", "migration-runner", "reviewer"],
    why: "the migration shape is a change, so `test` cannot flip it to a verify cast; the runner replaces the implementer and the cap spends the tester",
  },
  {
    task: "the review page shows stale data",
    expected: ["scout", "implementer", "tester", "reviewer"],
    analysisOnly: false,
    why: "`review` names a product surface and `stale` reports a defect: a bug report must not be thinned to a read-only cast",
  },
  {
    task: "update the api docs",
    expected: ["scout", "docs-updater"],
    why: "the docs noun carries the ask; an ambiguous `update` must not mint a code cast that then drops the docs seat at the cap",
  },
  {
    task: "log every 401",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "a change verb outside the old closed list must still mint the code cast; otherwise the cast is one investigator",
  },
  {
    task: "add a comment explaining the loop",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "a code comment is not a docs deliverable; `docs` must not capture an implementation ask",
  },
  {
    task: "fix the bug and update the api docs",
    expected: ["scout", "implementer", "tester", "reviewer"],
    why: "the mirror of the docs rule: a strong change verb on a code subject keeps the code cast, and the cap reports the docs seat it spends",
  },
  {
    task: "test the build",
    expected: ["scout", "implementer", "tester", "reviewer"],
    analysisOnly: false,
    why: "accepted tradeoff: `build` is noun-ambiguous and `test` alone does not veto it without a look verb; the code cast is pinned so the residual is a decision, not drift",
  },
];

for (const row of CASES) {
  test(`cast: ${row.task}`, () => {
    const plan = cast(row.task);
    assert.deepEqual(ids(plan), row.expected, row.why);
    if (row.analysisOnly !== undefined) {
      assert.equal(plan.analysisOnly, row.analysisOnly, row.why);
    }
    // A one-scout cast is the degenerate cast, and that is the whole signal the
    // dynamic tier reads: keying it on `analysisOnly` would have left exactly
    // these plans with no second chance, since a cast this thin carries
    // `analysisOnly: false` — one token in the table is not a plan.
    if (row.expected.join() === "scout") {
      assert.ok(isDegenerateCast(plan.roles), `${row.why} — cast ${ids(plan).join(",")}`);
      assert.equal(plan.analysisOnly, false, row.why);
    }
  });
}

// ── flag-shaped rules ─────────────────────────────────────────────────────────

test("--review-only reads the change and judges it: nothing else", () => {
  const plan = cast("review the auth fix", { reviewOnly: true });
  assert.deepEqual(ids(plan), ["scout", "reviewer"]);
  assert.ok(plan.notes.some((n) => n.includes("review-only")), `notes: ${plan.notes.join(" | ")}`);
});

test("a docs ask picks the docs seat, not an implementer", () => {
  // The verb in "update the readme" asks for a document to change, so the seat
  // that changes it is the docs seat. An implementer here is the defect the
  // docs cast was split out for.
  const plan = cast("update the readme");
  assert.deepEqual(ids(plan), ["scout", "docs-updater"]);
  assert.ok(!ids(plan).includes("implementer"), "docs work is not implementation");
  assert.ok(!ids(plan).includes("tester"), "there is nothing to test in a document edit");
});

test("a docs seat asked to write holds `edit`; one asked to research does not", () => {
  // The seat's grant comes from what the task asked for, not from the seat's
  // name: "update the readme" writes, "research migration options" reports.
  const writing = cast("document the api").roles.find((r) => r.id === "docs-updater");
  assert.ok(writing, "the docs seat must be in the cast");
  assert.ok(writing!.tools.includes("edit"), `docs-updater tools: ${writing!.tools.join("|")}`);
  assert.ok(writing!.tools.includes("write"), `docs-updater tools: ${writing!.tools.join("|")}`);

  const researching = cast("research migration options").roles.find((r) => r.id === "docs-updater");
  assert.ok(researching, "the researching docs seat must be in the cast");
  assert.ok(!researching!.tools.includes("edit"), `research holds no edit: ${researching!.tools.join("|")}`);
});

test("a UI task hands the tester's seat to the designer, and says so", () => {
  const plan = cast("build a landing page with a pricing section");
  assert.ok(ids(plan).includes("designer"), `cast: ${ids(plan).join(",")}`);
  assert.ok(!ids(plan).includes("tester"), "the designer's acceptance covers the interface; a tester would be a duplicate");
  assert.ok(
    plan.notes.includes("ui task: the designer takes the seat a tester would hold"),
    `notes: ${plan.notes.join(" | ")}`,
  );
});

test("a verify cast ships a tester and no implementer", () => {
  const plan = cast("test the payment checkout flow");
  assert.deepEqual(ids(plan), ["scout", "tester"]);
  assert.ok(!ids(plan).includes("implementer"), "an ask to run the checks is not an implementation");
  // The verifier is editor-capable, so the plan is not analysis-only and the
  // guarantee note stays away: it states what the cast cannot do, and this cast
  // can run commands.
  assert.equal(plan.analysisOnly, false);
  assert.ok(
    !plan.notes.some((n) => n.includes("no seat in this cast can change the code")),
    `notes: ${plan.notes.join(" | ")}`,
  );
});

test("an analysis-only cast states the guarantee, and only when it holds", () => {
  // A look-ask with nothing but read seats says so; `review the test suite
  // across several files` is the counterexample — the flag is set, but the
  // verifier holds `edit`, so the claim would be false and is not made.
  const readOnly = cast("audit the deps");
  assert.equal(readOnly.analysisOnly, true);
  assert.ok(
    readOnly.notes.includes("analysis-only intent: no seat in this cast can change the code"),
    `notes: ${readOnly.notes.join(" | ")}`,
  );
  assert.ok(!readOnly.roles.some((r) => grantsWrite(r.tools)), "no seat in an analysis cast can change the code");

  const withEditor = cast("review the test suite across several files");
  assert.equal(withEditor.analysisOnly, true);
  assert.ok(
    !withEditor.notes.some((n) => n.includes("no seat in this cast can change the code")),
    `notes: ${withEditor.notes.join(" | ")}`,
  );
});

// ── the vocabulary's own structural rules ─────────────────────────────────────

test("every VOCAB entry is \\b-delimited at both ends", () => {
  // The rule is what keeps `\bcheck` out of "checkbox": an entry matched inside
  // a longer word buys a seat for a word nobody typed.
  for (const [name, entry] of Object.entries(VOCAB)) {
    assert.ok(entry instanceof RegExp, `${name} must be a pattern`);
    assert.ok(entry.source.startsWith("\\b("), `${name} must open with \\b( — got ${entry.source}`);
    assert.ok(entry.source.endsWith(")\\b"), `${name} must close with )\\b — got ${entry.source}`);
  }
});

// ── the shell grant ───────────────────────────────────────────────────────────

test("the seats that must run something carry a shell, and the ones that only read do not", () => {
  // The tester's acceptance is "exact commands run" and the implementer's is
  // "focused check executed": neither is satisfiable by a grant with no execution
  // tool, which is what the read and write grants are.
  const build = cast("fix the login bug");
  for (const id of ["implementer", "tester"]) {
    const role = build.roles.find((r) => r.id === id)!;
    assert.ok(role.tools.includes("bash"), `${id} cannot run the check its acceptance asks for`);
    assert.ok(grantsWrite(role.tools), `${id} can change the tree by way of the shell`);
  }
  for (const id of ["scout", "reviewer"]) {
    assert.ok(!build.roles.find((r) => r.id === id)!.tools.includes("bash"), `${id} has no mission that needs a shell`);
  }
  // An editor without a shell is still a writer — the docs seat maintains files —
  // but the two grants are not the same authority and the consent screen says so.
  const docs = cast("update the readme").roles.find((r) => r.id === "docs-updater")!;
  assert.ok(grantsWrite(docs.tools), "the docs seat writes the document");
  assert.ok(!docs.tools.includes("bash"), "and does not need a shell to do it");
});

test("a migration runs its checks with the implementer's shell", () => {
  const runner = cast("migrate off lodash").roles.find((r) => r.id === "migration-runner")!;
  assert.ok(runner.tools.includes("bash"), "the runner's acceptance is that the checks pass on the migrated code");
  const designer = cast("design a new onboarding flow").roles.find((r) => r.id === "designer")!;
  assert.ok(!designer.tools.includes("bash"), "the designer was not given a shell; only the implementer seat's stand-ins were");
});

// ── slice fan-out ─────────────────────────────────────────────────────────────

test("--slices replaces the implementer with the seats everything downstream waits on", () => {
  const plan = cast("fix the login bug", { slices: 3 });
  assert.deepEqual(
    ids(plan),
    ["scout", "implementer-1", "implementer-2", "implementer-3", "tester", "reviewer"],
    "three writer seats, and the seats that report on the change come after them",
  );
  const sliceIds = ["implementer-1", "implementer-2", "implementer-3"];
  for (const id of ["tester", "reviewer"]) {
    // A seat waiting on the first slice alone would start before the rest of the
    // change existed, and judge a third of it.
    assert.deepEqual(plan.roles.find((r) => r.id === id)!.dependsOn, sliceIds, `${id} must wait on every slice`);
  }
  // Every slice seat writes; the tester does too, which is why the count is not
  // the fan-out's size.
  assert.ok(
    plan.roles.filter((r) => r.id.startsWith("implementer-")).every((r) => r.tools.includes("edit")),
    "every slice seat can change the code",
  );
  assert.ok(plan.notes.some((n) => n.includes("slices: 3")), "the fan-out is stated on the plan");
});

test("a fan-out is one seat at the cap, not one per writer file", () => {
  // Spending a slot per file dropped the tester and the reviewer first — the
  // opposite of what a change written by several seats needs.
  const plan = cast("fix the login bug", { slices: 4 });
  assert.ok(ids(plan).includes("tester"), `the tester survives a fan-out: ${ids(plan).join(", ")}`);
  assert.ok(ids(plan).includes("reviewer"), `the reviewer survives a fan-out: ${ids(plan).join(", ")}`);
});

test("--slices is bounded, and refused where there is nothing to fan out", () => {
  const ceiling = cast("fix the login bug", { slices: 99 });
  assert.equal(ids(ceiling).filter((id) => id.startsWith("implementer-")).length, 4, "the ceiling holds at 4");
  assert.deepEqual(ids(cast("fix the login bug")), ["scout", "implementer", "tester", "reviewer"], "one slice is the ordinary cast");
  // A migration is one writer by design, and a docs cast has no implementer at
  // all: both say so rather than quietly ignoring the flag.
  for (const task of ["update the readme", "migrate off lodash"]) {
    const plan = cast(task, { slices: 2 });
    assert.ok(!ids(plan).some((id) => id.startsWith("implementer-")), `${task}: nothing to fan out`);
    assert.ok(
      plan.notes.some((n) => n.includes("no implementer seat to fan out")),
      `${task}: the refusal is reported, not silent`,
    );
  }
});

test("migration wording is not a strong change verb", () => {
  // A migration is a change only when nothing asks to look, so no migration
  // word may sit in `VOCAB.changeStrong`: that list wins the look-veto. The
  // ambiguous list may carry `upgrade`/`move` — those are ordinary change words
  // on their own — but the veto still decides, so "evaluate migrating off
  // lodash" cannot mint the writer it exists to refuse. `port` is deliberately
  // absent from this list: it is a plain change verb ("port the app to vite" is
  // a change cast), and only "port from" is a migration shape.
  const migrationOnly = [
    "migrate off lodash",
    "migrating off lodash",
    "migration plan",
    "upgrade the deps",
    "upgrade the dependencies",
    "upgrade the framework",
    "upgrade the libraries",
    "move off webpack",
  ];
  for (const phrasing of migrationOnly) {
    assert.ok(VOCAB.migration.test(phrasing), `${phrasing} must read as a migration shape`);
    assert.ok(!VOCAB.changeStrong.test(phrasing), `${phrasing} must not be a strong change verb — the look-veto depends on it`);
  }
});

test("a reviewer waits on the seat that produced what it reviews", () => {
  // With no implementer in the cast, the reviewer used to carry an empty
  // dependency and landed in wave 1 beside the scout it was supposed to review.
  const plan = cast("review the test suite across several files");
  const reviewer = plan.roles.find((r) => r.id === "reviewer")!;
  assert.deepEqual(reviewer.dependsOn, ["tester"], `reviewer deps: ${reviewer.dependsOn?.join(",")}`);
});

test("a role cap below two is raised, because a cast needs a worker and an investigator", () => {
  const plan = cast("fix the login bug", { maxRoles: 1 });
  assert.deepEqual(ids(plan), ["scout", "implementer"]);
  assert.ok(
    plan.notes.some((n) => n.includes("raised to 2")),
    `the raised floor must be reported: ${plan.notes.join(" | ")}`,
  );
});
