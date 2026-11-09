/**
 * The command-line flag surface, kept out of the extension entry so the parser
 * and its bounds have one home and one test file. The tool schema imports the
 * same ceilings: a flag typed by hand must not be the only way to ask for a
 * fan-out the model cannot.
 *
 * Flags live at the edges of the command: a leading run before the first word
 * of the task, and a trailing run after the last one. A flag-shaped word in
 * the middle of the task is task text — `add a --dry-run flag to the deploy
 * script` is a task about a flag, not a dry run with a mangled task.
 */
import { expandHome, MAX_SLICES } from "./core.ts";

/** Bounds shared with the `role_fleet_plan` zod schema, so the flag path and
 *  the tool path cannot disagree about what is reachable. */
export const MAX_ROLES = 8;
export const MAX_COUNCIL = 3;
/** Council members the user names themselves. Above the alias fan-out, because a
 *  named list is a deliberate ask — but still bounded, since every member is a
 *  concurrent paid run. */
export const MAX_MODELS = 5;

/** Explicit model list for the review seats, in the order given. */
export interface Flags {
  dryRun?: boolean;
  allowlist?: string;
  maxRoles?: number;
  council?: number;
  models?: string[];
  consul?: string;
  reviewOnly?: boolean;
  slices?: number;
  /** Skip the cast dialog and keep the recommended (as-planned) seats. */
  yes?: boolean;
}

/**
 * `--models (a, b, @slow)` → `["a", "b", "@slow"]`.
 *
 * Parentheses are the whole safety mechanism. Without them, telling a bare list
 * from the first word of the task is a guess, and the guess that costs the most
 * is `--models fix the login bug` → a reviewer on a model called `fix` with the
 * task's first word gone. The brackets say where the list ends, so nothing is
 * guessed — and a bare model id (`glm-5`) works too, because it no longer has to
 * identify itself.
 *
 * Duplicates collapse with a word: two council members on one model is the
 * double-priced single review this feature exists to avoid, and silently
 * spawning it would look like the user asked for two opinions. Quotes and
 * brackets are stripped because the host splits the command line on whitespace
 * only, so both reach here attached.
 */
function parseModelList(raw: string, problems: string[]): string[] | undefined {
  const unbracketed = raw.replace(/^["']|["']$/g, "").trim();
  const bracketed = unbracketed.startsWith("(") && unbracketed.endsWith(")");
  // A stray bracket means the list was cut short. Splitting it anyway pins
  // selectors like `(a` that the host cannot resolve, so the seat silently rides
  // the parent's model — the exact confusion these brackets exist to prevent.
  if (!bracketed && /[()]/.test(unbracketed)) {
    problems.push(`--models got an unbalanced bracket list from "${raw}" — write a balanced (a,b,c), ignoring it`);
    return undefined;
  }
  const tokens = (bracketed ? unbracketed.slice(1, -1) : unbracketed)
    .split(",")
    .map((t) => t.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  // A bracket surviving inside an entry means the list was cut short: `(a,b))`
  // unwraps to `a, b)`, and a selector of `b)` resolves to nothing on the host,
  // which leaves the seat on the parent's model while the plan claims it named
  // one. Refusing the whole list beats pinning a selector that cannot exist.
  const mangled = tokens.filter((t) => /[()]/.test(t));
  if (mangled.length) {
    problems.push(`--models got malformed entries (${mangled.join(", ")}) — write a balanced (a,b,c), ignoring it`);
    return undefined;
  }
  if (!tokens.length) {
    problems.push(`--models got nothing usable from "${raw}", ignoring it`);
    return undefined;
  }
  const unique = [...new Set(tokens)];
  if (unique.length !== tokens.length) {
    problems.push(`--models listed ${tokens.length} entries but only ${unique.length} are distinct — duplicates dropped`);
  }
  if (unique.length > MAX_MODELS) {
    problems.push(`--models capped at ${MAX_MODELS} (asked for ${unique.length})`);
    return unique.slice(0, MAX_MODELS);
  }
  return unique;
}

/* ------------------------------------------------------------------ the line */

/** A word of the command line, with the place it came from. */
interface Token {
  text: string;
  start: number;
  end: number;
}

/**
 * Split the command on whitespace — the host splits it the same way — and keep
 * every token's offset in the original string.
 *
 * The offsets are what lets the task be rebuilt by deleting the flag spans:
 * the user's own spacing and line breaks survive, where a re-join of words
 * would flatten a two-line task into one line of single spaces.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\S+/g;
  let match = pattern.exec(command);
  while (match !== null) {
    const text = match[0];
    tokens.push({ text, start: match.index, end: match.index + text.length });
    match = pattern.exec(command);
  }
  return tokens;
}

/* ---------------------------------------------------------------- the flags */

/** The flag a word names, with the value it carries inline (`--models=(a,b)`)
 *  when the user wrote one. `undefined` for a word that names no flag. */
type FlagKind =
  | { kind: "dry-run" }
  | { kind: "yes" }
  | { kind: "review-only" }
  | { kind: "allowlist"; inline?: string }
  | { kind: "max-roles"; inline?: string }
  | { kind: "slices"; inline?: string }
  | { kind: "council"; inline?: string }
  | { kind: "models"; inline?: string }
  | { kind: "consul"; inline?: string };

function flagKind(text: string): FlagKind | undefined {
  if (text === "--dry-run" || text === "-n") return { kind: "dry-run" };
  if (text === "--yes" || text === "-y") return { kind: "yes" };
  if (text === "--review-only") return { kind: "review-only" };
  if (text === "--allowlist") return { kind: "allowlist" };
  if (text.startsWith("--allowlist=")) return { kind: "allowlist", inline: text.slice("--allowlist=".length) };
  if (text === "--max-roles") return { kind: "max-roles" };
  if (text.startsWith("--max-roles=")) return { kind: "max-roles", inline: text.slice("--max-roles=".length) };
  if (text === "--slices") return { kind: "slices" };
  if (text.startsWith("--slices=")) return { kind: "slices", inline: text.slice("--slices=".length) };
  if (text === "--council") return { kind: "council" };
  if (text.startsWith("--council=")) return { kind: "council", inline: text.slice("--council=".length) };
  if (text === "--models") return { kind: "models" };
  if (text.startsWith("--models=")) return { kind: "models", inline: text.slice("--models=".length) };
  if (text === "--consul") return { kind: "consul" };
  if (text.startsWith("--consul=")) return { kind: "consul", inline: text.slice("--consul=".length) };
  return undefined;
}

/** How many brackets a word opens (positive) or closes (negative). */
function bracketDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

/**
 * The tokens a flag would take as its value, by shape alone.
 *
 * This is the run detector's question — "is this word the value of the flag
 * before it?" — and it answers it without deciding whether the value is any
 * good. `--max-roles zero` is a typo, but `zero` is still the word the user
 * wrote after the flag, and the run has to reach it to report the typo.
 *
 * `limit` is where the flags end: nothing past it is ever a value.
 */
function valueSpan(kind: FlagKind, tokens: Token[], index: number, limit: number): number[] {
  const next = tokens[index + 1];
  if (kind.kind === "models" && kind.inline !== undefined) {
    // The host splits on whitespace, so `--models=(a, b)` arrives as two words;
    // the list continues while the bracket is open.
    let depth = bracketDepth(kind.inline);
    const span: number[] = [];
    let cursor = index + 1;
    while (depth > 0 && cursor < limit) {
      depth += bracketDepth(tokens[cursor]!.text);
      span.push(cursor);
      cursor++;
    }
    // An unclosed bracket takes no value: the words after it are the task.
    return depth === 0 ? span : [];
  }
  if (kind.kind === "models") {
    // The spaced form reads words until the brackets balance. With no bracket
    // at all it takes nothing — but the one word the user wrote after the flag
    // is still where the typo is, so it counts as the value here.
    let depth = 0;
    let opened = false;
    const span: number[] = [];
    let cursor = index + 1;
    while (cursor < limit) {
      const text = tokens[cursor]!.text;
      depth += bracketDepth(text);
      if (text.includes("(")) opened = true;
      span.push(cursor);
      cursor++;
      if (depth <= 0) break;
    }
    if (opened && depth === 0) return span;
    return next !== undefined && !next.text.startsWith("-") ? [index + 1] : [];
  }
  // Every other value-taking flag takes the one word after it — but never a
  // word that is another flag. The flags that take nothing claim nothing: a
  // `--yes` must not swallow the word after it.
  if (kind.kind === "dry-run" || kind.kind === "yes" || kind.kind === "review-only") return [];
  return next !== undefined && !next.text.startsWith("-") ? [index + 1] : [];
}

/** The word after a flag, when it is a word and not another flag. */
function valueWord(tokens: Token[], index: number): Token | undefined {
  const next = tokens[index + 1];
  return next !== undefined && !next.text.startsWith("-") ? next : undefined;
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parse the flags of a `/role-fleet` command.
 *
 * Flags are read from the two edges of the command: the leading run before the
 * first word of the task, and the trailing run after the last one. The task is
 * rebuilt from the original string with the flag spans deleted, so the spacing
 * and the line breaks the user wrote survive.
 *
 * `--` ends flag parsing outright: everything after it is task text.
 */
export function parseFlags(command: string): { flags: Flags; task: string; problems: string[] } {
  const flags: Flags = { dryRun: false };
  const problems: string[] = [];
  const tokens = tokenize(command);
  /** The tokens a flag took, and the flag words themselves: what the task
   *  loses. */
  const consumed = new Set<number>();
  // `--` ends flag parsing: everything after it is the task, verbatim.
  const dashIndex = tokens.findIndex((token) => token.text === "--");
  const flagEnd = dashIndex >= 0 ? dashIndex : tokens.length;

  // A typo'd number must not travel: `Number("abc")` is NaN, `NaN ?? 4` is NaN,
  // and a NaN council silently switches the feature off while a NaN role cap
  // empties the plan into an opaque "plan has no roles" rejection.
  const numeric = (raw: string | undefined, flag: string, max: number, min = 1): number | undefined => {
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < min) {
      problems.push(
        `${flag} needs a whole number${min > 1 ? ` of at least ${min}` : " above zero"} (got "${raw ?? ""}"), ignoring it`,
      );
      return undefined;
    }
    // The tool schema caps these at the same bounds; a flag typed by hand must
    // not be the only way to ask for a fan-out the model cannot.
    if (value > max) {
      problems.push(`${flag} capped at ${max} (asked for ${value})`);
      return max;
    }
    return value;
  };

  /**
   * Apply one flag and say how many tokens it took: the flag word, plus the
   * value it used. A value that is not usable is reported and its word is left
   * in the task — nothing the user typed disappears.
   */
  const applyFlag = (kind: FlagKind, index: number): number => {
    switch (kind.kind) {
      case "dry-run":
        flags.dryRun = true;
        return 1;
      case "yes":
        flags.yes = true;
        return 1;
      case "review-only":
        flags.reviewOnly = true;
        return 1;
      case "allowlist": {
        if (kind.inline !== undefined) {
          // An empty path is a missing path: it would fall through to
          // ROLE_FLEET_ALLOWLIST or to unpinned alias mode without a word.
          if (kind.inline === "") problems.push("--allowlist needs a file path, ignoring it");
          else flags.allowlist = expandHome(kind.inline);
          return 1;
        }
        // A prompt is not a shell: `~` reaches the parser literally and
        // `readFile` cannot resolve it, so `--allowlist ~/fleet.json` failed
        // with an ENOENT naming a path that does not exist. Expanded here so
        // the flag reflects what will be opened, and again in `runRoleFleet`
        // for the tool and env surfaces. `export ROLE_FLEET_ALLOWLIST=...` is
        // expanded by the shell and needs none.
        const follower = valueWord(tokens, index);
        if (follower === undefined) {
          // Falling through to ROLE_FLEET_ALLOWLIST would silently pin a file
          // the user never named.
          problems.push("--allowlist needs a file path, ignoring it");
          return 1;
        }
        flags.allowlist = expandHome(follower.text);
        return 2;
      }
      case "max-roles": {
        if (kind.inline !== undefined) {
          flags.maxRoles = numeric(kind.inline, "--max-roles", MAX_ROLES, 2);
          return 1;
        }
        // A numeric flag takes the next word only when that word really is a
        // number. Otherwise `--max-roles fix the bug` consumed "fix" as the
        // cap, the cap was rejected as non-numeric, and "fix" was gone from
        // the task text too — the user got a warning about a flag they typed
        // correctly and a task that had quietly lost its first word. A
        // non-numeric follower stays task text.
        const follower = valueWord(tokens, index);
        if (follower !== undefined && /^\d+$/.test(follower.text)) {
          flags.maxRoles = numeric(follower.text, "--max-roles", MAX_ROLES, 2);
          return 2;
        }
        if (follower !== undefined) {
          // Name the word the user actually typed: "(got "")" sent them
          // looking for a missing argument they had in fact supplied. The word
          // stays task text rather than being swallowed as a bogus cap.
          problems.push(`--max-roles needs a positive whole number, got "${follower.text}" — keeping the default, treating it as task text`);
        } else {
          // Trailing flag, nothing after it. `numeric` would report `(got "")`
          // — naming an empty string the user never typed — and the missing
          // value is the whole story, so it is said once, in the words that
          // fit.
          problems.push("--max-roles needs a positive whole number, ignoring it");
        }
        return 1;
      }
      case "slices": {
        if (kind.inline !== undefined) {
          flags.slices = numeric(kind.inline, "--slices", MAX_SLICES);
          return 1;
        }
        // Every slice seat is a concurrent paid writer, so the count is bounded
        // like the rest of the fan-out. A non-numeric follower is a typo, and
        // it stays task text — the alternative, reading `--slices abc` as "no
        // fan-out", silently drops the one thing the user asked for.
        const follower = valueWord(tokens, index);
        if (follower !== undefined && /^\d+$/.test(follower.text)) {
          flags.slices = numeric(follower.text, "--slices", MAX_SLICES);
          return 2;
        }
        if (follower !== undefined) {
          problems.push(`--slices needs a positive whole number, got "${follower.text}" — treating it as task text, one implementer stands`);
        } else {
          problems.push("--slices needs a positive whole number, ignoring it");
        }
        return 1;
      }
      case "council": {
        if (kind.inline !== undefined) {
          flags.council = numeric(kind.inline, "--council", MAX_COUNCIL);
          return 1;
        }
        // `--council` is bare (size 3), but `--council 5` must consume the
        // number: left unconsumed it landed in the task text of every emitted
        // agent.
        const follower = valueWord(tokens, index);
        if (follower !== undefined && /^\d+$/.test(follower.text)) {
          flags.council = numeric(follower.text, "--council", MAX_COUNCIL);
          return 2;
        }
        if (follower !== undefined) {
          // `--council abc` used to mean a full council of 3, silently. Reading
          // a typo as a larger-than-asked fan-out is the expensive direction,
          // so it is reported rather than guessed.
          problems.push(`--council needs a positive whole number, got "${follower.text}" — running the default council, treating it as task text`);
        }
        flags.council = MAX_COUNCIL;
        return 1;
      }
      case "consul": {
        // One model, so no brackets — but a follower still has to look like
        // one. `--consul fix the login bug` must not put "fix" on the deciding
        // seat: an unresolvable model there is the silent-parent-model failure
        // the rest of this parser keeps refusing to produce.
        const follower = kind.inline === undefined ? valueWord(tokens, index) : undefined;
        // Trimmed: the host splits on whitespace, so a quoted `--consul=" "`
        // arrives with its padding intact, and a blank selector is the one
        // value that must never be pinned — `Boolean(" ")` is true, so the plan
        // would mint a consul seat on a selector the host cannot resolve and
        // never say so.
        const candidate = (kind.inline ?? follower?.text)?.replace(/^["']|["']$/g, "").trim();
        // A model is `@alias` or `provider/id`, structurally. The earlier test
        // was "contains @, /, or a digit", which accepted `/fix` (a task word
        // with a slash) and `v2` (a task word with a digit) and pinned them as
        // selectors the host cannot resolve — the seat then ran on the parent's
        // model while the plan claimed a provider it never had. A bare name
        // like `sonnet` is indistinguishable from task text here, so it goes in
        // the `=` form, where the user separated the value themselves. Paths
        // nest — a router selector is `openrouter/anthropic/claude-4`, three
        // segments — so the shape is one or more `/segment`s after the
        // provider, not exactly one: the spaced form used to refuse the
        // spelling the `=` form accepted, which made the same selector work or
        // fail depending on how it was typed.
        const modelShape = /^(@[\w][\w.-]*|[\w][\w.-]*(?:\/[\w][\w.:-]*)+)$/.test(candidate ?? "");
        if (candidate && (modelShape || kind.inline !== undefined)) {
          flags.consul = candidate;
          // The spaced form took the word after it; the `=` form carried its
          // value inside the flag word.
          return kind.inline === undefined ? 2 : 1;
        }
        problems.push(
          `--consul needs @alias or provider/id (a bare name goes as --consul=NAME), got "${candidate ?? ""}" — the deciding seat stays on your session model`,
        );
        return 1;
      }
      case "models": {
        if (kind.inline !== undefined) {
          // One word usually carries the value, so there is nothing to consume
          // and nothing to guess — parentheses optional here, purely for muscle
          // memory with the spaced form. But the host splits on whitespace, so
          // `--models=(a, b)` arrives as `--models=(a,` and `b)`: a value that
          // opens a bracket it does not close finishes in the words after it.
          // Read the rest only while the bracket is open — a value with an
          // extra `)` is malformed whatever follows, and `parseModelList` is
          // the one that reports it by name.
          let text = kind.inline;
          let depth = bracketDepth(text);
          let cursor = index;
          while (depth > 0 && cursor + 1 < flagEnd) {
            const candidate = tokens[cursor + 1]!.text;
            depth += bracketDepth(candidate);
            text += ` ${candidate}`;
            cursor++;
          }
          // A bracket still open after every remaining word was read is a list
          // cut short, not one the host split: the value is the single word,
          // and refusing it beats pinning `(a` as a selector that cannot
          // exist.
          if (depth === 0 && cursor > index) {
            flags.models = parseModelList(text, problems);
            return cursor - index + 1;
          }
          flags.models = parseModelList(kind.inline, problems);
          return 1;
        }
        // The list is read across words until the brackets balance, because
        // the host splits the command line on whitespace: `--models (a, b, c)`
        // arrives as three words, and stopping at the first would leave `b,`
        // and `c)` to be parsed as task text.
        const collected: string[] = [];
        let depth = 0;
        let opened = false;
        let cursor = index;
        while (cursor + 1 < flagEnd) {
          const candidate = tokens[cursor + 1]!.text;
          depth += bracketDepth(candidate);
          if (candidate.includes("(")) opened = true;
          collected.push(candidate);
          cursor++;
          if (depth <= 0) break;
        }
        if (!opened || depth !== 0) {
          // Nothing is consumed on a malformed or non-bracketed follower: those
          // words are the user's task, not a value this flag may take.
          //
          // With no bracket at all the scan walked the entire rest of the line,
          // so quoting `collected` would echo the whole task back at the user
          // as if it were a malformed list. Name the one word that was not a
          // list; the unbalanced case genuinely saw a partial list and shows
          // it.
          problems.push(
            !opened
              ? `--models needs a bracketed list like (a,b,c), got "${collected[0] ?? ""}" — treating it as task text`
              : `--models needs a balanced bracketed list like (a,b,c), got "${collected.join(" ")}" — treating it as task text`,
          );
          return 1;
        }
        flags.models = parseModelList(collected.join(" "), problems);
        return cursor - index + 1;
      }
    }
  };

  /** Read a run of flags: the words from `from` while they are flags, and the
   *  values they take.
   *
   *  The leading run stops at the first word that is not a flag — the task
   *  starts there. The trailing run is bounded already: a word in it is the
   *  value slot of the flag before it, and that flag has said why it could not
   *  use it, so the word stays in the task and the run goes on. */
  const readRun = (from: number, to: number, stopAtWord: boolean): number => {
    let index = from;
    while (index < to) {
      const token = tokens[index]!;
      if (!token.text.startsWith("-")) {
        if (stopAtWord) break;
        index++;
        continue;
      }
      const kind = flagKind(token.text);
      if (!kind) {
        // An unrecognized flag is not task text either: it is reported, and
        // the word stays in the task so nothing the user typed disappears.
        problems.push(`unknown flag "${token.text}" — treated as part of the task text`);
        index++;
        continue;
      }
      const taken = applyFlag(kind, index);
      for (let i = index; i < index + taken; i++) consumed.add(i);
      index += taken;
    }
    return index;
  };

  // The leading run: the flags before the first word of the task.
  const leadingEnd = readRun(0, flagEnd, true);

  // The trailing run: the flags after the last word of the task. It is the
  // maximal suffix of flag words and their values, so a flag in the middle of
  // the task is not one.
  const owners = new Map<number, number>();
  for (let i = 0; i < flagEnd; i++) {
    const kind = flagKind(tokens[i]!.text);
    if (!kind) continue;
    for (const j of valueSpan(kind, tokens, i, flagEnd)) {
      // The nearest flag before a word owns it.
      if (!owners.has(j)) owners.set(j, i);
    }
  }
  let cursor = flagEnd - 1;
  while (cursor >= leadingEnd) {
    const token = tokens[cursor]!;
    if (token.text.startsWith("-")) {
      cursor--;
      continue;
    }
    // A word belongs to the trailing run only as the value of the flag before
    // it.
    const owner = owners.get(cursor);
    if (owner === undefined || owner < leadingEnd) break;
    cursor = owner - 1;
  }
  const trailingStart = cursor + 1;
  readRun(trailingStart, flagEnd, false);

  // `--` is not task text: it is the end of the flags, and it goes with them.
  if (dashIndex >= 0) consumed.add(dashIndex);

  return { flags, task: buildTask(command, tokens, consumed), problems };
}

/**
 * Rebuild the task from the original command with the flag spans deleted.
 *
 * The user's own spacing is kept: a task that came in over two lines stays on
 * two lines, and the double spaces they typed are theirs. One whitespace
 * character goes with each flag — the one in front of it when there is text
 * there, the one behind it when the flag opens the command — so the words
 * around it do not run together.
 */
function buildTask(command: string, tokens: Token[], consumed: Set<number>): string {
  const runs: Array<[number, number]> = [];
  for (const index of [...consumed].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && last[1] + 1 === index) last[1] = index;
    else runs.push([index, index]);
  }
  const ranges: Array<[number, number]> = [];
  for (const [first, last] of runs) {
    const start = tokens[first]!.start;
    const end = tokens[last]!.end;
    const before = start > 0 && /\s/.test(command[start - 1]!) ? start - 1 : start;
    const after = end < command.length && /\s/.test(command[end]!) ? end + 1 : end;
    if (before < start) ranges.push([before, end]);
    else if (after > end) ranges.push([start, after]);
    else ranges.push([start, end]);
  }
  let task = "";
  let position = 0;
  for (const [start, end] of ranges) {
    task += command.slice(position, start);
    position = Math.max(position, end);
  }
  task += command.slice(position);
  return task.trim();
}
