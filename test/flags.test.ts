/**
 * The command-line flag parser: where a flag may sit, what it does, and the
 * task text it leaves.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_SLICES } from "../src/core.ts";
import { parseFlags } from "../src/flags.ts";

test("a flag-shaped word inside the task is task text", () => {
  // The bug this grammar exists for: `/role-fleet add a --dry-run flag to the
  // deploy script` planned a dry run and cut the words out of the task. A
  // flag in the middle of the task is a word of the task.
  const dryRun = parseFlags("add a --dry-run flag to the deploy script");
  assert.equal(dryRun.flags.dryRun, false, "a dry run nobody asked for");
  assert.equal(dryRun.task, "add a --dry-run flag to the deploy script");
  assert.deepEqual(dryRun.problems, [], "task text is not a flag problem");

  // `--yes` in the middle must not skip the consent dialog either.
  const yes = parseFlags("add a -y option");
  assert.equal(yes.flags.yes, undefined, "the consent dialog must still ask");
  assert.equal(yes.task, "add a -y option");

  // `--allowlist` used to eat the next word wherever it stood.
  const allowlist = parseFlags("add a --allowlist fleet.json to the deploy script");
  assert.equal(allowlist.flags.allowlist, undefined);
  assert.equal(allowlist.task, "add a --allowlist fleet.json to the deploy script");

  // A council is three paid reviewers: it must not be switched on by a word.
  const council = parseFlags("document the --council flag in the readme");
  assert.equal(council.flags.council, undefined);
  assert.equal(council.task, "document the --council flag in the readme");

  // The same words at the two edges are flags, and always were.
  assert.equal(parseFlags("--dry-run fix the bug").flags.dryRun, true);
  assert.equal(parseFlags("fix the bug --dry-run").flags.dryRun, true);
  assert.equal(parseFlags("--council fix x --max-roles 3").flags.maxRoles, 3);
  assert.equal(parseFlags("--council fix x --max-roles 3").flags.council, 3);
});

test("flags are read from the two edges of the command", () => {
  // The leading run stops at the first word of the task: what follows it is
  // the task, even when it looks like a flag.
  const leading = parseFlags("--yes --dry-run fix the bug");
  assert.equal(leading.flags.yes, true);
  assert.equal(leading.flags.dryRun, true);
  assert.equal(leading.task, "fix the bug");
  assert.deepEqual(leading.problems, []);

  // The trailing run reaches back for the value of its own flags and no
  // further: a flag that takes a value takes it inside the run.
  const trailing = parseFlags("fix bug --max-roles 3");
  assert.equal(trailing.flags.maxRoles, 3);
  assert.equal(trailing.task, "fix bug");
  assert.deepEqual(trailing.problems, []);

  // Both edges at once.
  const both = parseFlags("--review-only fix the bug --council 2");
  assert.equal(both.flags.reviewOnly, true);
  assert.equal(both.flags.council, 2);
  assert.equal(both.task, "fix the bug");
  assert.deepEqual(both.problems, []);

  // A value flag whose value is not there is reported and its word stays in
  // the task — nothing the user typed disappears.
  const typo = parseFlags("fix the bug --max-roles four");
  assert.equal(typo.flags.maxRoles, undefined);
  assert.equal(typo.task, "fix the bug four");
  assert.ok(
    typo.problems.some((p) => p.includes("four")),
    `the cap error must name the word: ${typo.problems.join(" | ")}`,
  );

  // The run goes on past the word it could not use: the flag behind it still
  // counts.
  const mixed = parseFlags("fix the bug --max-roles zero --dry-run");
  assert.equal(mixed.flags.dryRun, true, "the flag behind the bad value is still a flag");
  assert.equal(mixed.flags.maxRoles, undefined);
  assert.equal(mixed.task, "fix the bug zero");
});

test("`--` ends the flags, and the rest is the task", () => {
  // The explicit end of the flags: everything after it is task text, however
  // much it looks like a flag.
  const dash = parseFlags("-- --council parsing bug");
  assert.equal(dash.flags.council, undefined, "no council behind the --");
  assert.equal(dash.flags.dryRun, false);
  assert.equal(dash.task, "--council parsing bug");
  assert.deepEqual(dash.problems, []);

  // The task keeps every word after the `--`, flags included.
  const kept = parseFlags("-- --dry-run --allowlist x");
  assert.equal(kept.flags.dryRun, false);
  assert.equal(kept.flags.allowlist, undefined);
  assert.equal(kept.task, "--dry-run --allowlist x");

  // A `--` in the middle ends the flags there; the words before it are still
  // the task, and the words after it are task text too.
  const middle = parseFlags("fix the bug -- --dry-run");
  assert.equal(middle.flags.dryRun, false);
  assert.equal(middle.task, "fix the bug --dry-run");
});

test("the task keeps the spacing and the line breaks the user typed", () => {
  // The task lands in the brief of every emitted agent. Rejoining the words
  // flattened a two-line task into one line and every double space into one.
  const multiline = parseFlags("fix the login bug\nand the sign-in flow");
  assert.equal(multiline.task, "fix the login bug\nand the sign-in flow");
  assert.deepEqual(multiline.problems, []);

  const spaced = parseFlags("fix the  login   bug");
  assert.equal(spaced.task, "fix the  login   bug");

  // A flag at the edge does not take the spacing with it.
  const flagged = parseFlags("fix the  login bug --dry-run");
  assert.equal(flagged.flags.dryRun, true);
  assert.equal(flagged.task, "fix the  login bug");

  const leading = parseFlags("--dry-run fix the  login bug");
  assert.equal(leading.flags.dryRun, true);
  assert.equal(leading.task, "fix the  login bug");

  // A value flag at the trailing edge takes its value and leaves the rest.
  const valued = parseFlags("fix bug --max-roles 3");
  assert.equal(valued.flags.maxRoles, 3);
  assert.equal(valued.task, "fix bug");
});

test("a non-numeric flag is reported instead of silently becoming NaN", () => {
  // NaN council switches the feature off; NaN role cap empties the plan into an
  // opaque "plan has no roles" rejection. Both must be visible to the user.
  const bad = parseFlags("--council=abc --max-roles zero fix the bug");
  assert.equal(bad.flags.council, undefined);
  assert.equal(bad.flags.maxRoles, undefined);
  assert.equal(bad.problems.length, 2);
  // The bad value is refused, not silently deleted from what the user typed: a
  // word that is not a number is task text, and losing it would plan against a
  // task the user never gave. The two problems above are what says "I did not
  // understand --max-roles".
  assert.equal(bad.task, "zero fix the bug");

  const good = parseFlags("--council --max-roles=6 fix the bug");
  assert.equal(good.flags.council, 3);
  assert.equal(good.flags.maxRoles, 6);
  assert.deepEqual(good.problems, []);
});

test("a trailing valueless flag names the missing value, not an empty string", () => {
  // `--max-roles` as the last word has no value at all. Reporting it through the
  // numeric path printed `(got "")` — quoting an argument the user never typed
  // and sending them hunting for one they had already decided not to write —
  // and it said so twice for a single flag.
  const trailing = parseFlags("fix the bug --max-roles");
  assert.equal(trailing.flags.maxRoles, undefined);
  assert.equal(trailing.problems.length, 1, `one flag, one problem: ${trailing.problems.join(" | ")}`);
  assert.match(trailing.problems[0]!, /--max-roles needs a positive whole number/);
  assert.ok(!trailing.problems[0]!.includes('""'), `must not quote an empty string: ${trailing.problems[0]}`);
  assert.equal(trailing.task, "fix the bug");

  // A word after the flag is named verbatim, and stays task text — the other
  // half of the same rule.
  const follower = parseFlags("--max-roles zero fix the bug");
  assert.equal(follower.problems.length, 1, `one flag, one problem: ${follower.problems.join(" | ")}`);
  assert.match(follower.problems[0]!, /got "zero"/);
  assert.equal(follower.task, "zero fix the bug");
});

test("flag values are consumed, not left to contaminate the task text", () => {
  // `--council 5` used to leave `5` in the task, and the task lands in every
  // emitted agent body and in the keyword heuristics.
  const council = parseFlags("--council 5 fix the bug");
  assert.equal(council.flags.council, 3, "council size is capped at the alias pool");
  assert.equal(council.task, "fix the bug");
  assert.equal(council.problems.length, 1, "clamping is visible, not silent");

  // A value must never eat the next flag: swallowing `--dry-run` here means the
  // run writes agent files the user explicitly asked not to write.
  const dryRun = parseFlags("--max-roles --dry-run fix the bug");
  assert.equal(dryRun.flags.dryRun, true);
  assert.equal(dryRun.flags.maxRoles, undefined);
  assert.equal(dryRun.problems.length, 1);
  assert.equal(dryRun.task, "fix the bug");

  // Out-of-range is clamped, not honoured.
  const capped = parseFlags("--max-roles=500 fix the bug");
  assert.equal(capped.flags.maxRoles, 8);
  assert.equal(capped.problems.length, 1);
});

test("--models takes a bracketed list in order, task text stays intact", () => {
  const listed = parseFlags("--models (xai/grok-4,zai/glm-5,@slow) fix the bug");
  assert.deepEqual(listed.flags.models, ["xai/grok-4", "zai/glm-5", "@slow"]);
  assert.equal(listed.task, "fix the bug", "the model list must not leak into the task");
  assert.deepEqual(listed.problems, []);

  // The task can sit anywhere, including last, which is how it reads best:
  // `/role-fleet --council --models (a,b) refactor the auth module`.
  // The host splits on whitespace, so a spaced list arrives as three words and
  // must be read until the brackets balance.
  const spaced = parseFlags("--models (xai/grok-4, zai/glm-5, anthropic/claude-opus-4-6) fix the bug");
  assert.deepEqual(spaced.flags.models, ["xai/grok-4", "zai/glm-5", "anthropic/claude-opus-4-6"]);
  assert.equal(spaced.task, "fix the bug");
  assert.deepEqual(spaced.problems, []);

  const promptLast = parseFlags("--council --models (xai/grok-4, zai/glm-5) refactor the auth module");
  assert.deepEqual(promptLast.flags.models, ["xai/grok-4", "zai/glm-5"], "spaces inside the brackets are trimmed");
  assert.equal(promptLast.task, "refactor the auth module");
  assert.deepEqual(promptLast.problems, []);

  // The same list at the trailing edge, where the flags live after the task.
  const trailing = parseFlags("refactor the auth module --models (xai/grok-4, zai/glm-5)");
  assert.deepEqual(trailing.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.equal(trailing.task, "refactor the auth module");
  assert.deepEqual(trailing.problems, []);

  // Quotes survive the host's whitespace-only split, so they have to be stripped.
  const quoted = parseFlags('--models "(a/1,@task)" fix the bug');
  assert.deepEqual(quoted.flags.models, ["a/1", "@task"]);
  assert.equal(quoted.task, "fix the bug");

  const inline = parseFlags("--models=(xai/grok-4,zai/glm-5) fix the bug");
  assert.deepEqual(inline.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.deepEqual(inline.problems, []);

  // A bare id has no `,`, `/`, or `@` to identify it, and the brackets say
  // where the list ends instead — the reason the form exists.
  const bare = parseFlags("--models (glm-5) fix the bug");
  assert.deepEqual(bare.flags.models, ["glm-5"]);
  assert.deepEqual(bare.problems, []);
});

test("--models never eats a word that is not bracketed", () => {
  // The brackets are the safety mechanism: without them, deciding whether the
  // next word is the list or the first word of the task is a guess, and
  // `--models fix the login bug` would put reviewers on a model called `fix`
  // and drop the task's first word. An unbracketed follower is left alone.
  const eaten = parseFlags("--models fix the login bug");
  assert.equal(eaten.flags.models, undefined);
  // The wording names what was actually wrong. With no bracket anywhere the scan
  // walked the whole rest of the line, so echoing `collected` would throw the
  // user's entire task back at them as if it were a malformed list; the no-bracket
  // case names the one word that was not a list, and the partial-bracket case
  // below reports the list it really did see.
  assert.match(eaten.problems[0] ?? "", /--models needs a bracketed list like \(a,b,c\), got "fix"/);
  assert.ok(!(eaten.problems[0] ?? "").includes("login"), `the whole task was echoed: ${eaten.problems[0]}`);
  assert.equal(eaten.task, "fix the login bug", "nothing the user typed may disappear");

  // A value must never eat the next flag.
  const nextFlag = parseFlags("--models --dry-run fix the bug");
  assert.equal(nextFlag.flags.models, undefined);
  assert.equal(nextFlag.flags.dryRun, true);
  assert.equal(nextFlag.problems.length, 1);
  assert.equal(nextFlag.task, "fix the bug");

  // An unclosed bracket is not a list: nothing is consumed and the words stay
  // task text, with the reason reported.
  const unclosed = parseFlags("--models (a,b fix the bug");
  assert.equal(unclosed.flags.models, undefined);
  assert.equal(unclosed.task, "(a,b fix the bug");
  assert.match(unclosed.problems[0] ?? "", /balanced bracketed list/);

  const empty = parseFlags("--models=() fix the bug");
  assert.equal(empty.flags.models, undefined);
  assert.match(empty.problems[0] ?? "", /nothing usable/);
  assert.equal(empty.task, "fix the bug");

  // Inline, the brackets are optional — so an unbalanced one is the only
  // signal that the list was cut short. Splitting it anyway would pin a
  // selector like `(a` the host cannot resolve, and the seat would silently
  // ride the parent model instead.
  const cut = parseFlags("--models=(a,b fix the bug");
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /unbalanced bracket list/);
  assert.equal(cut.task, "fix the bug");

  // The spaced scanner used to stop only at depth 0, so an over-closed list
  // drove the depth negative and it consumed the rest of the line — then echoed
  // the user's whole task back as if it were a malformed model list.
  const overClosed = parseFlags("--models (a)) fix the login bug");
  assert.equal(overClosed.flags.models, undefined);
  assert.equal(overClosed.task, "(a)) fix the login bug", "nothing the user typed may disappear");
  assert.ok(!(overClosed.problems[0] ?? "").includes("login"), `the task was echoed as a model list: ${overClosed.problems[0]}`);
});

test("--models=(a, b) finishes the list the host split in two", () => {
  // The host splits on whitespace, so a bracketed value in the `=` form arrives
  // as two words — `--models=(a,` and `b)`. Reading only the first refused the
  // list *and* left `b)` in the task text, while the spaced spelling of the same
  // list planned fine: the flag's meaning depended on how it was typed.
  const split = parseFlags("--models=(xai/grok-4, zai/glm-5) fix the bug");
  assert.deepEqual(split.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.equal(split.task, "fix the bug", "the rest of the list must not become task text");
  assert.deepEqual(split.problems, []);

  // A bracket no later word closes is a list cut short, not one the host split:
  // the value is the single word, and the refusal names the bracket.
  const cut = parseFlags("--models=(xai/grok-4, fix the bug");
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /unbalanced bracket list/);
  assert.equal(cut.task, "fix the bug", "nothing the user typed may disappear");
});

test("--models collapses duplicates and caps the list", () => {
  // Two council members on one model is the double-priced single review this
  // feature exists to avoid; spawning it silently would read as two opinions.
  const dupes = parseFlags("--models (xai/grok-4,xai/grok-4,zai/glm-5) fix the bug");
  assert.deepEqual(dupes.flags.models, ["xai/grok-4", "zai/glm-5"]);
  assert.match(dupes.problems[0] ?? "", /duplicates dropped/);

  const many = parseFlags("--models (a/1,b/2,c/3,d/4,e/5,f/6) fix the bug");
  assert.equal(many.flags.models?.length, 5);
  assert.match(many.problems[0] ?? "", /capped at 5/);
});

test("an allowlist without a usable path is refused instead of falling through", () => {
  // Falling through to ROLE_FLEET_ALLOWLIST would pin a file the user never
  // named; falling through to nothing would silently run unpinned.
  const bare = parseFlags("fix the bug --allowlist");
  assert.equal(bare.flags.allowlist, undefined);
  assert.equal(bare.problems.length, 1);
  assert.equal(bare.task, "fix the bug");

  const empty = parseFlags("fix the bug --allowlist=");
  assert.equal(empty.flags.allowlist, undefined);
  assert.equal(empty.problems.length, 1);

  // A prompt is not a shell, so `~` is expanded here — `readFile` cannot.
  const good = parseFlags("fix the bug --allowlist ~/fleet.json");
  assert.equal(good.flags.allowlist, join(homedir(), "fleet.json"));
  assert.deepEqual(good.problems, []);

  const inline = parseFlags("fix the bug --allowlist=~/fleet.json");
  assert.equal(inline.flags.allowlist, join(homedir(), "fleet.json"));

  // The same path at the leading edge is the same flag.
  const leading = parseFlags("--allowlist ~/fleet.json fix the bug");
  assert.equal(leading.flags.allowlist, join(homedir(), "fleet.json"));
  assert.equal(leading.task, "fix the bug");
});

test("a numeric flag with no number leaves the task text intact", () => {
  // `--max-roles fix the bug` used to swallow "fix" as the cap: the cap was
  // then rejected as non-numeric and the task lost its first word, so the user
  // was warned about a correct flag and the plan ran on a mutilated task.
  const missing = parseFlags("--max-roles fix the bug");
  assert.equal(missing.flags.maxRoles, undefined);
  assert.equal(missing.task, "fix the bug");
  assert.equal(missing.problems.length, 1);

  // A real number is still consumed, not left in the task.
  const real = parseFlags("fix the bug --max-roles 3");
  assert.equal(real.flags.maxRoles, 3);
  assert.equal(real.task, "fix the bug");
  assert.deepEqual(real.problems, []);

  // Same rule for the council: a bare `--council` still means 3, but a
  // non-numeric follower is the task, not a council size.
  const bare = parseFlags("review the auth code --council");
  assert.equal(bare.flags.council, 3);
  assert.equal(bare.task, "review the auth code");

  // A typo must not silently become the largest council the plugin can run.
  const worded = parseFlags("review the auth code --council loudly");
  assert.equal(worded.flags.council, 3, "the default council still runs");
  assert.equal(worded.task, "review the auth code loudly");
  assert.ok(
    worded.problems.some((p) => p.includes("--council") && p.includes("loudly")),
    `a mistyped council size must be reported: ${worded.problems.join(" | ")}`,
  );
});

test("an unknown flag is reported, not silently absorbed into the task", () => {
  // A typo'd `--dryrun` used to become task text and reached the brief of every
  // emitted agent. At the edge of the command it must still be reported; the
  // word is kept so nothing the user typed disappears.
  const typo = parseFlags("fix the bug --dryrun");
  assert.equal(typo.flags.dryRun, false);
  assert.equal(typo.task, "fix the bug --dryrun");
  assert.ok(
    typo.problems.some((p) => p.includes("--dryrun")),
    `an unknown flag must be reported: ${typo.problems.join(" | ")}`,
  );

  // A known flag is not reported as unknown.
  assert.ok(!parseFlags("fix the bug --dry-run").problems.some((p) => p.includes("unknown")));
});

test("parseFlags recognizes --yes and -y", () => {
  const long = parseFlags("--yes fix the bug");
  assert.equal(long.flags.yes, true);
  assert.equal(long.task, "fix the bug");
  const short = parseFlags("-y review auth");
  assert.equal(short.flags.yes, true);
  assert.equal(short.task, "review auth");
});

test("--consul refuses a follower that is task text and says how to spell it", () => {
  const eaten = parseFlags("--consul fix the login bug");
  assert.equal(eaten.flags.consul, undefined);
  // The refusal names the two accepted spellings rather than just rejecting: a
  // bare id like `sonnet` is legitimate, it simply cannot be told apart from the
  // task's first word in the spaced form. Pointing at `--consul=sonnet` is what
  // makes the rejection actionable instead of a dead end.
  assert.match(eaten.problems[0] ?? "", /--consul needs @alias or provider\/id/);
  assert.match(eaten.problems[0] ?? "", /--consul=NAME/);
  // The deciding seat stays on the session model, and the word is not lost.
  assert.match(eaten.problems[0] ?? "", /session model/);
  assert.equal(eaten.task, "fix the login bug");

  const inline = parseFlags("--consul=xai/grok-4 fix the bug");
  assert.equal(inline.flags.consul, "xai/grok-4");
  assert.deepEqual(inline.problems, []);

  // A model is `@alias` or `provider/id`, structurally. The earlier test was
  // "contains @, /, or a digit", which accepted `/fix` and `v2` — task words that
  // happen to carry one — and pinned them as selectors the host cannot resolve, so
  // the seat ran on the parent's model while the plan claimed a provider it never
  // had. A bare id is therefore refused in the spaced form, and the word stays in
  // the task.
  const bare = parseFlags("--consul glm-5 fix the bug");
  assert.equal(bare.flags.consul, undefined);
  assert.equal(bare.task, "glm-5 fix the bug", "the refused word must not vanish");

  const digitWord = parseFlags("--consul v2 of the api is stale");
  assert.equal(digitWord.flags.consul, undefined, "a task word carrying a digit is not a model");

  // The same ids are reachable through the `=` form, where the user separated the
  // value themselves — which is what closes the old asymmetry against `--models`,
  // whose bracketed list has always taken `sonnet`.
  for (const spelling of ["sonnet", "glm-5", "anthropic/claude-opus-4-6", "@slow"]) {
    const via = parseFlags(`--consul=${spelling} fix the bug`);
    assert.equal(via.flags.consul, spelling, `--consul=${spelling} was not taken`);
    assert.deepEqual(via.problems, []);
    assert.equal(via.task, "fix the bug");
  }

  // An alias is unambiguous, so the spaced form keeps working for it.
  const aliased = parseFlags("--consul @slow fix the bug");
  assert.equal(aliased.flags.consul, "@slow");
  assert.equal(aliased.task, "fix the bug");
  // A leading slash is a path-shaped word, not a provider/id pair: the old
  // "contains /" test accepted `/fix` and pinned a selector that resolves to
  // nothing, which put the deciding seat on the parent's model while the plan
  // named a provider it never had.
  const slashWord = parseFlags("--consul /fix the login bug");
  assert.equal(slashWord.flags.consul, undefined, "a leading slash is not provider/id");
  assert.equal(slashWord.task, "/fix the login bug");

  // Quotes survive the host's whitespace-only split, so they must be stripped
  // rather than pinned verbatim into the agent frontmatter.
  const quoted = parseFlags('--consul "xai/grok-4" fix the bug');
  assert.equal(quoted.flags.consul, "xai/grok-4", `quotes leaked: ${JSON.stringify(quoted.flags.consul)}`);
  assert.equal(quoted.task, "fix the bug");

  // A blank value is the one thing that must never be pinned. `Boolean(" ")` is
  // true, so a quoted `--consul=" "` would mint the deciding seat on a selector
  // the host cannot resolve, and synthesis sees a truthy string and adds no note
  // — the deciding seat then silently runs on the parent model, which is the
  // exact outcome every other refusal in this parser exists to prevent.
  // The host splits the command on whitespace, so a value with spaces in it
  // never arrives as one word: the blank spellings that can reach the parser
  // are the ones below.
  for (const blank of ["--consul=", "--consul=   ", '--consul=""']) {
    const empty = parseFlags(`${blank} fix the bug`);
    assert.equal(empty.flags.consul, undefined, `a blank value was pinned: ${JSON.stringify(blank)}`);
    assert.equal(empty.problems.length, 1, `no refusal reported for ${JSON.stringify(blank)}`);
    assert.match(empty.problems[0] ?? "", /--consul needs @alias or provider\/id/);
    assert.equal(empty.task, "fix the bug");
  }
});

test("--consul takes a nested provider path in either spelling", () => {
  // A router selector is more than one segment deep, and the spaced form
  // accepted exactly one: `openrouter/anthropic/claude-4` was refused there and
  // accepted through `--consul=`, so the same selector worked or failed
  // depending on how it was typed.
  const spaced = parseFlags("--consul openrouter/anthropic/claude-4 audit the api");
  assert.equal(spaced.flags.consul, "openrouter/anthropic/claude-4");
  assert.deepEqual(spaced.problems, []);
  assert.equal(spaced.task, "audit the api", "the selector must not become task text");

  // The shape test is still a shape test: a task word with a leading slash is
  // not a model, and a bare name is still told to use the `=` form.
  const word = parseFlags("--consul /fix the bug");
  assert.equal(word.flags.consul, undefined);
  assert.match(word.problems[0] ?? "", /needs @alias or provider\/id/);
});

test("--models refuses a list with a bracket left inside an entry", () => {
  // `(a,b))` unwraps to `a, b)`. Splitting it anyway pinned a selector of `b)`,
  // which the host cannot resolve — the seat then ran on the parent's model
  // while the plan and the roster both claimed a provider it never had.
  const cut = parseFlags("--models=(a,b)) fix the bug");
  assert.equal(cut.flags.models, undefined);
  assert.match(cut.problems[0] ?? "", /malformed entries/);
  assert.equal(cut.task, "fix the bug", "the task must survive the refusal");

  // A well-formed list of the same length is still accepted.
  const good = parseFlags("--models=(a/1,b/2) fix the bug");
  assert.deepEqual(good.flags.models, ["a/1", "b/2"]);
  assert.deepEqual(good.problems, []);
});

test("--slices is parsed like the other fan-out flags", () => {
  assert.deepEqual(parseFlags("fix the bug --slices 3").flags.slices, 3);
  assert.deepEqual(parseFlags("fix the bug --slices=2").flags.slices, 2);
  const capped = parseFlags("fix the bug --slices 99");
  assert.equal(capped.flags.slices, MAX_SLICES);
  assert.ok(capped.problems.some((p) => p.includes("capped")), "a clamp is reported, never silent");
  // A typo stays task text and the flag does not pretend to have been honoured:
  // reading `--slices abc` as "no fan-out" would drop what was asked for.
  const typo = parseFlags("fix the bug --slices abc");
  assert.equal(typo.flags.slices, undefined);
  assert.match(typo.task, /abc$/);
  assert.ok(typo.problems.some((p) => p.includes("positive whole number")));
});
