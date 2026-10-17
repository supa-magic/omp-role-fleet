/**
 * omp extension entry — variant A, zero configuration.
 *
 * Surfaces:
 *   /role-fleet <task>   plan roles → gate → write agent definitions → hand the
 *                        parallel dispatch groups to the main model
 *   role_fleet_plan      model tool: the same plan, as data the model can act on
 *
 * Role models are omp model-role aliases (`@smol`, `@plan`, `@task`, `@slow`),
 * resolved by the host through the user's `modelRoles`. There is nothing to
 * configure; an optional allowlist file pins concrete selectors when asked for.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { expandHome, runRoleFleet, type RunOptions, type RunResult } from "./pipeline.ts";
import { renderDispatch, renderPlan, renderVerdict } from "./render.ts";
import { castPresets, seatRows } from "./confirm.ts";
import { DEFAULT_MAX_ROLES, planWaves, type RolePlan } from "./core.ts";
import { observeSettledRuns, recordExpectedModels, renderObservation, resetExpectedModels } from "./model-observed.ts";
import type { RoleProposer } from "./generate.ts";

/** Kept in step with package.json; shown in the session banner. */
const PLUGIN_VERSION = "1.3.5";

/** Parameters of `role_fleet_plan`, declared for the same reason as everywhere:
 *  the host's schema type resolves tool params to `unknown`. */
interface PlanToolParams {
  task: string;
  maxRoles?: number;
  allowlist?: string;
  dryRun?: boolean;
  council?: number;
  models?: string[];
  consul?: string;
  reviewOnly?: boolean;
}

/** Bounds shared with the `role_fleet_plan` zod schema, so the flag path and
 *  the tool path cannot disagree about what is reachable. */
const MAX_ROLES = 8;
const MAX_COUNCIL = 3;
/** Council members the user names themselves. Above the alias fan-out, because a
 *  named list is a deliberate ask — but still bounded, since every member is a
 *  concurrent paid run. */
const MAX_MODELS = 5;

/** Explicit model list for the review seats, in the order given. */
interface Flags {
  dryRun?: boolean;
  allowlist?: string;
  maxRoles?: number;
  council?: number;
  models?: string[];
  consul?: string;
  reviewOnly?: boolean;
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
  const numeric = (raw: string | undefined, flag: string, max: number): number | undefined => {
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value < 1) {
      problems.push(`${flag} needs a positive whole number (got "${raw ?? ""}"), ignoring it`);
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
        flags.maxRoles = numeric(value, "--max-roles", MAX_ROLES);
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
    } else if (word.startsWith("--max-roles=")) flags.maxRoles = numeric(word.slice("--max-roles=".length), "--max-roles", MAX_ROLES);
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
        // One word carries the value, so there is nothing to consume and
        // nothing to guess — parentheses optional here, purely for muscle
        // memory with the spaced form.
        flags.models = parseModelList(inline, problems);
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
          if (depth === 0) break;
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
      // the user separated the value themselves.
      const isModelShape = candidate !== undefined && /^(@[\w][\w.-]*|[\w][\w.-]*\/[\w][\w.:-]*)$/.test(candidate);
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

/**
 * The one `runRoleFleet` call shape both surfaces use.
 *
 * The command and the tool differ in where their options come from — parsed
 * flags vs a zod object — and in nothing else. Building the object twice let the
 * key order and the host adapters drift between them (a surface silently losing
 * the confirmer, say), and neither copy was readable while mis-indented inside
 * the surrounding try block.
 */
function runOptions(input: Flags & { task: string; cwd: string }, ctx: ExtensionContext, progress: Progress): RunOptions {
  return {
    task: input.task,
    cwd: input.cwd,
    dryRun: input.dryRun ?? false,
    maxRoles: input.maxRoles,
    allowlist: input.allowlist,
    council: input.council,
    ...(input.reviewOnly ? { reviewOnly: true } : {}),
    // A named list and an allowlist both retarget the same seats; the file
    // wins where it describes one, and the user is told rather than left
    // to wonder which of the two took effect.
    ...(input.models?.length ? { models: input.models } : {}),
    ...(input.consul ? { consul: input.consul } : {}),
    // One cheap side turn, no history, no executed tools: the dynamic
    // specialist tier. Absent on hosts without side turns — static only.
    propose: makeProposer(ctx),
    resolveModel: makeModelResolver(ctx),
    // One confirmation per run, before any agent file is written. Hosts
    // without an interactive dialog dispatch straight through.
    confirm: makeConfirmer(ctx.ui, progress),
  };
}

/** Session-shaped prompt handed to the main model once the gate approves. */
function dispatchPrompt(task: string, result: RunResult): string {
  return [
    `Role-fleet plan approved.`,
    ``,
    `User task: ${task}`,
    ``,
    renderDispatch(result.groups, result.agentDir ?? ""),
    ``,
    `Every agent above already exists as an omp agent definition whose model, tool`,
    `grant, and thinking level are pinned in its file. Dispatch each wave with the`,
    `task tool as a single batch, then wait for that wave before starting the next.`,
    `Pass each item's name and agent exactly as given, plus the task text. Do NOT`,
    `set model, tools, or effort on the task call — the task tool has no model`,
    `field (the definition pins it), treats a tools field as eval-defined tools,`,
    `and overriding the agent's own grant is what the definitions exist to prevent.`,
  ].join("\n");
}

/**
 * Flag completions.
 *
 * Labels carry the flag itself: the host decides how a completion is rendered,
 * so a description-only label can end up hiding the very thing being offered.
 * Matching runs against the flag and the label words, so "dry", "cap", or
 * "allow" all find their entry. After `--allowlist`, only files that actually
 * exist are offered — a completion must never suggest a path that is not there.
 *
 * The host calls this synchronously with the prefix only, so existence checks
 * use the synchronous fs API against the process working directory.
 */
interface ArgumentCompletion {
  value: string;
  label: string;
}

const FLAG_COMPLETIONS: ArgumentCompletion[] = [
  { value: "--dry-run", label: "--dry-run · plan only, write nothing" },
  { value: `--max-roles ${DEFAULT_MAX_ROLES}`, label: `--max-roles N · cap generated roles (default ${DEFAULT_MAX_ROLES})` },
  { value: "--allowlist ", label: "--allowlist FILE · pin models to a file instead of @aliases" },
  { value: "--review-only", label: "--review-only · scout and reviewers only, no seat can edit code" },
  { value: "--council", label: "--council [N] · N reviewers on different providers" },
  { value: "--models (", label: "--models (a,b,c) · review seats on these models, in order" },
  { value: "--consul ", label: "--consul MODEL · model that reconciles the council reports (default: session model)" },
];

function completeArguments(prefix: string): ArgumentCompletion[] | null {
  if (/^--allowlist[ =]/.test(prefix)) {
    const typed = prefix.replace(/^--allowlist[ =]\s*/, "");
    return allowlistSuggestions().filter(
      (c) => c.path.includes(typed) && existsSync(c.path),
    ).map((c) => ({ value: `--allowlist ${c.path}`, label: `--allowlist ${c.path}` }));
  }
  const needle = prefix.toLowerCase();
  const hits = FLAG_COMPLETIONS.filter(
    (e) => e.value.toLowerCase().startsWith(needle) || e.label.toLowerCase().includes(needle),
  );
  return hits.length ? hits : null;
}

/** Well-known allowlist locations, suggested only when they exist.
 *
 *  Built per call so a change of working directory is picked up, but still
 *  resolved against `process.cwd()`: the host calls argument completions with
 *  the prefix only, so no session cwd reaches here. A session started outside
 *  its project therefore gets no project-local suggestion — an omission, not a
 *  wrong path, since every entry is existence-filtered. */
function allowlistSuggestions(): Array<{ path: string }> {
  return [
    { path: join(process.cwd(), ".omp", "role-fleet.json") },
    { path: join(homedir(), ".omp", "agent", "role-fleet.json") },
    { path: join(homedir(), ".orch", "fleet.json") },
  ];
}

/**
 * Build a role proposer from the host's ephemeral side turn, when available.
 * Minimized effort and a small token cap: this is a classification call, not
 * a reasoning one.
 */
function makeProposer(ctx: { runEphemeralTurn?: ExtensionContext["runEphemeralTurn"] }): RoleProposer | undefined {
  if (!ctx.runEphemeralTurn) return undefined;
  return async (task) => {
    const result = await ctx.runEphemeralTurn!({
      promptText: task,
      tools: false,
      maxTokens: 800,
      minimizeEffort: true,
    });
    return result.replyText;
  };
}

/**
 * Build the confirmation hook for a run, when the host can ask at all.
 *
 * `askDialog` is absent in print and RPC modes — those hosts dispatch without
 * asking, which is exactly what the flags are for. The callback returns the
 * seats to keep, or `null` when the user declines.
 */
function makeConfirmer(
  ui: ExtensionCommandContext["ui"] | undefined,
  progress?: Progress,
): ((plan: RolePlan) => Promise<ReadonlySet<string> | null>) | undefined {
  // Bound once: `askDialog` is optional on the host type, and narrowing it
  // outside the closure would not survive into the two awaits below. A context
  // with no UI at all (headless callers) takes the same path as no dialog.
  const askDialog = ui?.askDialog;
  if (typeof askDialog !== "function") return undefined;
  return async (plan) => {
    // The dialog owns the screen from here: a spinner ticking underneath it
    // reads as a stuck process rather than as progress.
    progress?.pause();
    const presets = castPresets(plan);
    // Named in the question, not only in the options' previews: the fine-grained
    // picker's row detail is where the per-seat authority lives, and the first
    // screen is where a consul run's repo-wide `write` has to be visible without
    // the reader opening anything. Silently bigger authority than the prose claims
    // is precisely what this dialog exists to prevent.
    const editors = plan.roles.filter((r) => r.tools.includes("edit")).length;
    const repoWriters = plan.roles.filter(
      (r) => r.tools.includes("write") && !r.tools.includes("edit"),
    ).length;
    const authority =
      `${editors} seat(s) can edit code` +
      (repoWriters ? `, ${repoWriters} hold repo-wide write and could overwrite any path` : "");
    const answer = await askDialog(
      [
        {
          id: "cast",
          // The question names the vendors, because "run 4 seats" on its own is
          // not a spend decision — four runs is. What the reader cannot see is
          // which provider answers, and the options below do not fit on one line.
          question: `Run ${plan.roles.length} seat(s) on ${plan.roles
            .map((r) => r.modelResolved ?? r.model)
            .filter((m, i, all) => all.indexOf(m) === i)
            .join(", ")}? ${authority}.`,
          options: presets.map((p) => ({ label: p.label, description: p.description, preview: p.preview })),
          // Index 0 is the proposal, so the cursor and the (Recommended) label
          // both land on it: accepting costs one Enter.
          recommended: 0,
        },
      ],
      {},
    );
    if (!answer || answer.kind !== "submit") return null;

    const item = answer.results.find((r) => r.id === "cast");
    const picked = item?.selectedOptions[0];
    const preset = presets.find((p) => p.label === picked);
    if (!preset) return null;
    if (preset.id !== "pick-seats") return new Set(preset.seats);

    // Fine-grained: a second dialog, reached deliberately. Its initial state is
    // empty by host contract (no API to pre-check a set), so it is offered as a
    // choice rather than as the first screen a user is dropped into.
    const rows = seatRows(plan, planWaves(plan.roles));
    const detail = await askDialog(
      [
        {
          id: "seats",
          multi: true,
          question: "Which seats should run? Toggle with space, confirm with enter.",
          options: rows.map((r) => ({ label: r.label, description: r.description, preview: r.preview })),
        },
      ],
      {},
    );
    if (!detail || detail.kind !== "submit") return null;

    // Rows are labelled by the seat's human name, so the labels the user ticked
    // have to be mapped back to ids before they can filter the plan.
    const idByLabel = new Map(rows.map((r) => [r.label, r.id]));
    const chosen = detail.results.find((r) => r.id === "seats")?.selectedOptions ?? [];
    const seats = new Set(chosen.map((label) => idByLabel.get(label)).filter((id): id is string => id !== undefined));
    return seats.size ? seats : null;
  };
}

/**
 * An animated progress line, stopped and started on demand.
 *
 * Choosing the cast is not instant — it can include a model call for extra
 * roles — and a command that goes quiet for several seconds looks exactly like a
 * dropped keypress. The status bar carries the message because it stays visible
 * whether or not the session is streaming; the braille frames are the same
 * spinner omp itself draws, so it reads as part of the host rather than as a
 * stranger's progress bar.
 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface Progress {
  /** Hide it — for when something else takes the screen, like a dialog. */
  pause(): void;
  /** Stop it for good and take it off the status bar. */
  clear(): void;
}

function startProgress(
  ctx: Pick<ExtensionCommandContext, "setInterval" | "clearTimer">,
  ui: ExtensionCommandContext["ui"] | undefined,
  message: string,
): Progress {
  let frame = 0;
  let running = true;
  const draw = (): void => {
    try {
      ui?.setStatus?.("role-fleet", running ? `${SPINNER[frame++ % SPINNER.length]} ${message}` : undefined);
    } catch {
      // A host with no status line is headless: stay silent rather than fail a
      // run over an indicator.
    }
  };
  // The ticker's handle never leaves this closure, so nothing here publishes the
  // host's timer type — `clear` is the only thing that ever needs it.
  const stopTicking = (() => {
    try {
      const ticker = ctx.setInterval(draw, 90);
      let stopped = false;
      return (): void => {
        if (stopped) return;
        stopped = true;
        try {
          ctx.clearTimer(ticker);
        } catch {
          // The host clears timers on shutdown anyway.
        }
      };
    } catch {
      // No timers here: the first frame still showed, and the message is honest
      // even if it does not move.
      return (): void => {};
    }
  })();

  draw();
  try {
    ui?.setWorkingMessage?.(message);
  } catch {
    // Same.
  }
  return {
    pause: () => {
      running = false;
      draw();
    },
    clear: () => {
      stopTicking();
      running = false;
      draw();
      try {
        ui?.setWorkingMessage?.();
      } catch {
        // Same.
      }
    },
  };
}

/** Strip the redundant `Error:` prefix so notifications read as one message. */
function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}

/**
 * Concrete model behind a selector, from the host's own resolver.
 *
 * `ctx.models.resolve` is the only authority on which provider an alias
 * actually reaches — the same `@slow` resolves differently per account, and a
 * host-side fallback changes it again. Absent on older hosts, where roles keep
 * the alias and the plan says nothing false about a model it could not see.
 */
function makeModelResolver(ctx: ExtensionContext) {
  const query = ctx.models;
  if (typeof query?.resolve !== "function") return undefined;
  return (spec: string) => {
    const model = query.resolve(spec);
    return model ? `${model.provider}/${model.id}` : undefined;
  };
}

export default function roleFleet(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.on("session_start", (_event, ctx) => {
    // The version is in the banner on purpose: a stale extension module is the
    // single most confusing failure mode, since `/reload-plugins` does not
    // rebuild it and only a restart picks up new code.
    // Expectations are process-level state: without the reset, a session started
    // in the same process would compare a settled seat against the previous
    // run's plan. Subagent sessions rebind this factory and start too, so the
    // guard keeps a child from wiping the parent's baseline mid-run.
    if (ctx.agent?.kind === "sub") return;
    resetExpectedModels();
    ctx.ui.notify(`role-fleet ${PLUGIN_VERSION} ready · /role-fleet <task>`, "info");
  });

  // The one place the host states which model a seat actually ran on: every
  // settled `task` result carries it. Plan-time resolution records intent, and
  // a retry fallback replaces exactly that — without this the alias and the
  // plan keep claiming the intended model after the provider switched.
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "task" || ctx.agent?.kind === "sub") return;
    for (const observation of observeSettledRuns(event.details)) {
      ctx.ui.notify(renderObservation(observation), observation.fallback ? "warning" : "info");
    }
  });

  pi.registerCommand("role-fleet", {
    description: "Split a task into agent roles and dispatch them in parallel waves",
    getArgumentCompletions: completeArguments,
    handler: async (args, ctx: ExtensionCommandContext) => {
      // Safety net: a command that throws is rendered by the host as an opaque
      // "Extension command error". The user only ever sees an actionable message.
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (words[0] === "--version" || words[0] === "version") {
          ctx.ui.notify(`omp-role-fleet ${PLUGIN_VERSION}`, "info");
          return;
        }

        const { flags, task, problems } = parseFlags(words);
        for (const p of problems) ctx.ui.notify(p, "warning");
        if (!task) {
          ctx.ui.notify(
            "usage: /role-fleet <task> [--dry-run] [--max-roles N] [--allowlist FILE] [--review-only] [--council [N]] [--models (a,b,c)] [--consul MODEL]",
            "warning",
          );
          return;
        }

        const progress = startProgress(ctx, ctx.ui, "role-fleet: choosing the cast…");
        let result: RunResult;
        try {
          result = await runRoleFleet(runOptions({ ...flags, task, cwd: ctx.cwd }, ctx, progress));
        } finally {
          // Cleared on every path, including a throw: an indicator that
          // outlives its run is a lie sitting in the status bar.
          progress.clear();
        }

        if (!result.ok || !result.plan) {
          // A declined cast is a decision, not a fault. The verdict text is the
          // same, but reporting it as an error tells the user something broke
          // when they answered "no".
          ctx.ui.notify(renderVerdict(result.verdict), result.abandoned ? "info" : "error");
          return;
        }

        ctx.ui.notify(
          `${renderPlan(result.plan, result.waves)}\n\n${renderVerdict(result.verdict)}`,
          "info",
        );
        if (flags.dryRun) return;

        // The settled-result observer compares what ran against this. Recorded
        // before the batch is dispatched, so a fast wave cannot settle before
        // the plan it is measured against exists. A subagent session runs its own
        // fleet and must not overwrite the parent's baseline.
        recordExpectedModels(result.agents, { subSession: ctx.agent?.kind === "sub" });

        // An idle session does not start a turn for a plain sendMessage: the
        // batch would sit in history and never be executed. While a turn is
        // running, the batch steers the current one instead of queueing behind it.
        pi.sendMessage(dispatchPrompt(task, result), {
          ...(ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" as const }),
        });
      } catch (err) {
        pi.logger.error(`role-fleet: unhandled command failure: ${String(err)}`);
        ctx.ui.notify(`role-fleet ${PLUGIN_VERSION}: ${cleanError(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "role_fleet_plan",
    label: "Role Fleet Plan",
    description:
      "Split a task into agent roles and return approved waves with per-role models and generated " +
      "agent definitions. Use when a task needs several specialists that can run in parallel.",
    // Write, not read: a normal call emits and prunes `.omp/agents/rf-*.md`.
    // Declaring "read" let a mutation ride in under a read-tier policy.
    approval: "write",
    parameters: z.object({
      // A blank task cannot produce a meaningful plan, and the command path
      // already refuses one with usage. Without the bound the tool planned an
      // empty plan and returned an approved verdict for a task nobody asked.
      task: z.string().min(1).describe("The user task to decompose into roles"),
      maxRoles: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROLES)
        .optional()
        .describe(`Cap on generated roles (default ${DEFAULT_MAX_ROLES})`),
      allowlist: z.string().optional().describe("Pin models to an allowlist JSON file"),
      dryRun: z.boolean().optional().describe("Plan without writing agent definitions"),
      council: z
        .number()
        .int()
        .min(1)
        .max(MAX_COUNCIL)
        .optional()
        .describe("Reviewers on distinct model-role aliases (default 3 when the task asks for it)"),
      models: z
        .array(z.string())
        .max(MAX_MODELS)
        .optional()
        .describe("Explicit review models in order — two or more run a council of that size"),
      consul: z
        .string()
        .optional()
        .describe("Model that reconciles the council's reports; omit to let the session model do it"),
      reviewOnly: z.boolean().optional().describe("Scout and review seats only: no implementer, tester, or writer"),
    }),
    async execute(_toolCallId, params: PlanToolParams, _signal, _onUpdate, ctx) {
      try {
        const progress = startProgress(ctx, ctx.ui, "role-fleet: choosing the cast…");
        let result: RunResult;
        try {
          // Same builder the command path uses, so a task whose wording asks
          // for extra roles gets them on this path too.
          result = await runRoleFleet(
            runOptions(
              {
                task: params.task,
                cwd: ctx.cwd,
                dryRun: params.dryRun,
                maxRoles: params.maxRoles,
                allowlist: params.allowlist,
                council: params.council,
                models: params.models,
                consul: params.consul,
                reviewOnly: params.reviewOnly,
              },
              ctx,
              progress,
            ),
          );
        } finally {
          progress.clear();
        }
        if (!result.ok || !result.plan) {
          // "Rejected" would tell the model a defect was found. A declined cast
          // is a human decision, and the model must not report it as a fault.
          return {
            content: [
              {
                type: "text" as const,
                text:
                  (result.abandoned ? "Role run not dispatched." : "Role plan rejected.") +
                  `\n${renderVerdict(result.verdict)}\nDo not dispatch; report this outcome instead.`,
              },
            ],
            details: { verdict: result.verdict },
          };
        }
        const text = [
          renderVerdict(result.verdict),
          "",
          renderPlan(result.plan, result.waves),
          "",
          params.dryRun ? "" : "Dispatch instructions:",
          params.dryRun ? "" : renderDispatch(result.groups, result.agentDir ?? ""),
        ].join("\n");
        // Same expectation baseline the command path records: the settled
        // `task` results are compared against the plan the caller will dispatch.
        // Guarded like the command path — a write-granted council member holds
        // this tool, and its call would otherwise clear the parent's baseline
        // while the parent's council is still settling.
        if (!params.dryRun) recordExpectedModels(result.agents, { subSession: ctx.agent?.kind === "sub" });
        return {
          content: [{ type: "text" as const, text }],
          details: {
            roles: result.plan.roles.map((r) => ({
            id: r.id,
            model: r.model,
            ...(r.modelResolved ? { modelResolved: r.modelResolved } : {}),
          })),
            agentDir: result.agentDir,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `role_fleet_plan failed: ${cleanError(err)}` }],
          isError: true,
        };
      }
    },
  });
}