/**
 * The command-line flag surface, kept out of the extension entry so the parser
 * and its bounds have one home and one test file. The tool schema imports the
 * same ceilings: a flag typed by hand must not be the only way to ask for a
 * fan-out the model cannot.
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

export function parseFlags(words: string[]): { flags: Flags; task: string; problems: string[] } {
  const flags: Flags = { dryRun: false };
  const problems: string[] = [];
  const rest: string[] = [];
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
  // A space-separated value must not eat the next flag: `--max-roles --dry-run`
  // used to consume `--dry-run` as the number and then write files anyway.
  const takeValue = (index: number): string | undefined => {
    const next = words[index + 1];
    return next !== undefined && !next.startsWith("-") ? next : undefined;
  };
  // A numeric flag takes the next word only when that word really is a number.
  // Otherwise `--max-roles fix the bug` consumed "fix" as the cap, the cap was
  // rejected as non-numeric, and "fix" was gone from the task text too — the
  // user got a warning about a flag they typed correctly and a task that had
  // quietly lost its first word. A non-numeric follower stays task text.
  const takeNumber = (index: number): string | undefined => {
    const next = takeValue(index);
    return next !== undefined && /^\d+$/.test(next) ? next : undefined;
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--dry-run" || word === "-n") flags.dryRun = true;
    else if (word === "--yes" || word === "-y") flags.yes = true;
    // A prompt is not a shell: `~` reaches the parser literally and `readFile`
    // cannot resolve it, so `--allowlist ~/fleet.json` failed with an ENOENT
    // naming a path that does not exist. Expanded here so the flag reflects what
    // will be opened, and again in `runRoleFleet` for the tool and env surfaces.
    // `export ROLE_FLEET_ALLOWLIST=...` is expanded by the shell and needs none.
    else if (word === "--allowlist") {
      const value = takeValue(i);
      if (value === undefined) {
        // Falling through to ROLE_FLEET_ALLOWLIST would silently pin a file
        // the user never named.
        problems.push('--allowlist needs a file path, ignoring it');
      } else {
        flags.allowlist = expandHome(value);
        i++;
      }
    } else if (word.startsWith("--allowlist=")) {
      // An empty path is a missing path: it would fall through to
      // ROLE_FLEET_ALLOWLIST or to unpinned alias mode without a word.
      const value = word.slice("--allowlist=".length);
      if (value === "") problems.push("--allowlist needs a file path, ignoring it");
      else flags.allowlist = expandHome(value);
    }
    else if (word === "--max-roles") {
      const value = takeNumber(i);
      const follower = takeValue(i);
      if (value !== undefined) {
        i++;
        flags.maxRoles = numeric(value, "--max-roles", MAX_ROLES, 2);
      } else if (follower !== undefined) {
        // Name the word the user actually typed: "(got \"\")" sent them
        // looking for a missing argument they had in fact supplied. The word
        // stays task text rather than being swallowed as a bogus cap.
        problems.push(`--max-roles needs a positive whole number, got "${follower}" — keeping the default, treating it as task text`);
      } else {
        // Trailing flag, nothing after it. `numeric` would report `(got "")` —
        // naming an empty string the user never typed — and the missing value
        // is the whole story, so it is said once, in the words that fit.
        problems.push("--max-roles needs a positive whole number, ignoring it");
      }
    } else if (word.startsWith("--max-roles=")) flags.maxRoles = numeric(word.slice("--max-roles=".length), "--max-roles", MAX_ROLES, 2);
    else if (word === "--slices") {
      // Every slice seat is a concurrent paid writer, so the count is bounded
      // like the rest of the fan-out. A non-numeric follower is a typo, and it
      // stays task text — the alternative, reading `--slices abc` as "no
      // fan-out", silently drops the one thing the user asked for.
      const value = takeNumber(i);
      const follower = takeValue(i);
      if (value !== undefined) {
        i++;
        flags.slices = numeric(value, "--slices", MAX_SLICES);
      } else if (follower !== undefined) {
        problems.push(`--slices needs a positive whole number, got "${follower}" — treating it as task text, one implementer stands`);
      } else {
        problems.push("--slices needs a positive whole number, ignoring it");
      }
    } else if (word.startsWith("--slices=")) flags.slices = numeric(word.slice("--slices=".length), "--slices", MAX_SLICES);
    else if (word === "--review-only") flags.reviewOnly = true;
    else if (word === "--council") {
      // `--council` is bare (size 3), but `--council 5` must consume the number:
      // left unconsumed it landed in the task text of every emitted agent.
      const value = takeNumber(i);
      const follower = takeValue(i);
      if (value !== undefined) {
        i++;
        flags.council = numeric(value, "--council", MAX_COUNCIL);
      } else {
        if (follower !== undefined) {
          // `--council abc` used to mean a full council of 3, silently. Reading
          // a typo as a larger-than-asked fan-out is the expensive direction,
          // so it is reported rather than guessed.
          problems.push(`--council needs a positive whole number, got "${follower}" — running the default council, treating it as task text`);
        }
        flags.council = MAX_COUNCIL;
      }
    } else if (word.startsWith("--council=")) flags.council = numeric(word.slice("--council=".length), "--council", MAX_COUNCIL);
    else if (word === "--models" || word.startsWith("--models=")) {
      const inline = word.startsWith("--models=") ? word.slice("--models=".length) : undefined;
      if (inline !== undefined) {
        // One word usually carries the value, so there is nothing to consume and
        // nothing to guess — parentheses optional here, purely for muscle memory
        // with the spaced form. But the host splits on whitespace, so
        // `--models=(a, b)` arrives as `--models=(a,` and `b)`: a value that
        // opens a bracket it does not close finishes in the words after it.
        // Read the rest only while the bracket is open — a value with an extra
        // `)` is malformed whatever follows, and `parseModelList` is the one that
        // reports it by name.
        let text = inline;
        let depth = 0;
        for (const ch of inline) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        let next = i;
        while (depth > 0 && next + 1 < words.length) {
          const candidate = words[next + 1]!;
          for (const ch of candidate) {
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
          }
          text += ` ${candidate}`;
          next++;
        }
        // A bracket still open after every remaining word was read is a list cut
        // short, not one the host split: the value is the single word, and
        // refusing it beats pinning `(a` as a selector that cannot exist.
        if (depth === 0 && next > i) i = next;
        flags.models = parseModelList(depth === 0 ? text : inline, problems);
      } else {
        // The list is read across words until the brackets balance, because
        // the host splits the command line on whitespace: `--models (a, b, c)`
        // arrives as three words, and stopping at the first would leave `b,`
        // and `c)` to be parsed as task text.
        const collected: string[] = [];
        let depth = 0;
        let opened = false;
        let next = i;
        while (next + 1 < words.length) {
          const candidate = words[next + 1]!;
          for (const ch of candidate) {
            if (ch === "(") {
              depth++;
              opened = true;
            } else if (ch === ")") depth--;
          }
          collected.push(candidate);
          next++;
          if (depth <= 0) break;
        }
        if (!opened || depth !== 0) {
          // Nothing is consumed on a malformed or non-bracketed follower: those
          // words are the user's task, not a value this flag may take.
          //
          // With no bracket at all the scan walked the entire rest of the line,
          // so quoting `collected` would echo the whole task back at the user as
          // if it were a malformed list. Name the one word that was not a list;
          // the unbalanced case genuinely saw a partial list and shows it.
          problems.push(
            !opened
              ? `--models needs a bracketed list like (a,b,c), got "${collected[0] ?? ""}" — treating it as task text`
              : `--models needs a balanced bracketed list like (a,b,c), got "${collected.join(" ")}" — treating it as task text`,
          );
        } else {
          i = next;
          flags.models = parseModelList(collected.join(" "), problems);
        }
      }
    } else if (word === "--consul" || word.startsWith("--consul=")) {
      const inline = word.startsWith("--consul=") ? word.slice("--consul=".length) : undefined;
      // One model, so no brackets — but a follower still has to look like one.
      // `--consul fix the login bug` must not put "fix" on the deciding seat:
      // an unresolvable model there is the silent-parent-model failure the rest
      // of this parser keeps refusing to produce.
      const follower = inline === undefined ? takeValue(i) : undefined;
      // Trimmed: the host splits on whitespace, so a quoted `--consul=" "` arrives
      // with its padding intact, and a blank selector is the one value that must
      // never be pinned — `Boolean(" ")` is true, so the plan would mint a consul
      // seat on a selector the host cannot resolve and never say so.
      const candidate = (inline ?? follower)?.replace(/^["']|["']$/g, "").trim();
      // A model is `@alias` or `provider/id`, structurally. The earlier test was
      // "contains @, /, or a digit", which accepted `/fix` (a task word with a
      // slash) and `v2` (a task word with a digit) and pinned them as selectors
      // the host cannot resolve — the seat then ran on the parent's model while
      // the plan claimed a provider it never had. A bare name like `sonnet` is
      // indistinguishable from task text here, so it goes in the `=` form, where
      // the user separated the value themselves. Paths nest — a router selector
      // is `openrouter/anthropic/claude-4`, three segments — so the shape is one
      // or more `/segment`s after the provider, not exactly one: the spaced form
      // used to refuse the spelling the `=` form accepted, which made the same
      // selector work or fail depending on how it was typed.
      const isModelShape = candidate !== undefined && /^(@[\w][\w.-]*|[\w][\w.-]*(?:\/[\w][\w.:-]*)+)$/.test(candidate);
      if (candidate && (isModelShape || inline !== undefined)) {
        if (inline === undefined) i++;
        flags.consul = candidate;
      } else {
        problems.push(
          `--consul needs @alias or provider/id (a bare name goes as --consul=NAME), got "${candidate ?? ""}" — the deciding seat stays on your session model`,
        );
      }
    } else if (word.startsWith("-")) {
      // An unrecognized flag is not task text: it would otherwise reach the
      // synthesis heuristics and, verbatim, the brief of every emitted agent.
      // Reported, never silently dropped — the word stays in the task so nothing
      // the user typed disappears.
      problems.push(`unknown flag "${word}" — treated as part of the task text`);
      rest.push(word);
    } else rest.push(word);
  }
  return { flags, task: rest.join(" ").trim(), problems };
}

