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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runRoleFleet, type RunOptions, type RunResult } from "./pipeline.ts";
import { MAX_COUNCIL, MAX_MODELS, MAX_ROLES, parseFlags, type Flags } from "./flags.ts";
import { dispatchPlan, renderDispatch, renderVerdict, renderPlan } from "./render.ts";
import { sectionFields, settleSeat, type SeatSections } from "./ledger.ts";
import { renderRunList, renderRunReport, renderRunStatus } from "./report.ts";
import { castPresets, castQuestion, seatRows } from "./confirm.ts";
import { AGENT_PREFIX, DEFAULT_MAX_ROLES, MAX_SLICES, planWaves, type RolePlan } from "./core.ts";
import { renderObservation } from "./model-observed.ts";
import { isMcpToolName, mcpAllowlistFromEnv, mcpGuardVerdict, seatMayWrite } from "./mcp-policy.ts";
import { clearNotifier, notify, seatRecord, seatToolsFromDefinition, setNotifier, type SeatRecord } from "./seats.ts";
import type { RoleProposer } from "./generate.ts";

/** The published version, read from the manifest that ships beside `src/`. */
const PLUGIN_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * The one `runRoleFleet` call shape both surfaces use.
 *
 * The command and the tool differ in where their options come from — parsed
 * flags vs a zod object — and in nothing else. Building the object twice let the
 * key order and the host adapters drift between them (a surface silently losing
 * the confirmer, say), and neither copy was readable while mis-indented inside
 * the surrounding try block.
 */
function runOptions(
  input: Flags & { task: string; cwd: string },
  ctx: ExtensionContext,
  progress: Progress,
  onDispatch?: RunOptions["onDispatch"],
  confirmMode?: "ask" | "auto",
): RunOptions {
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
    ...(input.slices && input.slices > 1 ? { slices: input.slices } : {}),
    // One cheap side turn, no history, no executed tools: the dynamic
    // specialist tier. Absent on hosts without side turns — static only.
    propose: makeProposer(ctx),
    resolveModel: makeModelResolver(ctx),
    // One confirmation per run, before any agent file is written. Hosts
    // without an interactive dialog dispatch straight through. Agents and
    // `--yes` take the recommended cast without opening a dialog that no one
    // can answer.
    pluginVersion: PLUGIN_VERSION,
    confirm: makeConfirmer(ctx.ui, progress, {
      autoAcceptRecommended:
        confirmMode === "auto" ||
        input.yes === true ||
        ctx.agent?.kind === "sub",
    }),
    ...(onDispatch ? { onDispatch } : {}),
  };
}

/**
 * Session-shaped prompt handed to the main model once the gate approves.
 *
 * The dispatch instructions themselves live in `renderDispatch`, which both
 * surfaces render: keeping a second copy here is how the tool path came to
 * depend on the model noticing a rule the command path stated.
 */
function dispatchPrompt(task: string, result: RunResult): string {
  return [`Role-fleet plan approved.`, ``, `User task: ${task}`, ``, renderDispatch(result.groups, result.agentDir ?? "")].join(
    "\n",
  );
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
  { value: "--dry-run", label: "--dry-run · plan only, write nothing, no paid tier" },
  { value: "-n", label: "-n · short form of --dry-run" },
  { value: "--yes", label: "--yes · skip cast dialog, accept recommended seats" },
  { value: "-y", label: "-y · short form of --yes" },
  { value: `--max-roles ${DEFAULT_MAX_ROLES}`, label: `--max-roles N · cap generated roles (default ${DEFAULT_MAX_ROLES})` },
  { value: "--allowlist ", label: "--allowlist FILE · pin models to a file instead of @aliases" },
  { value: "--review-only", label: "--review-only · scout and reviewers only, no seat can change the code" },
  { value: "--slices 2", label: "--slices N · fan the implementation out across N writer seats" },
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
 *
 * `autoAcceptRecommended` skips the dialog and keeps every planned seat — the
 * same choice as the recommended "Run all of them" preset. Used when an agent
 * drives the fleet (`role_fleet_plan`, a sub-session, or `--yes`): a menu no
 * human is watching would hang the turn forever.
 */
function makeConfirmer(
  ui: ExtensionCommandContext["ui"] | undefined,
  progress?: Progress,
  opts?: { autoAcceptRecommended?: boolean },
): ((plan: RolePlan) => Promise<ReadonlySet<string> | null>) | undefined {
  if (opts?.autoAcceptRecommended) {
    return async (plan) => {
      // Mirror the recommended preset (`as-planned`): every seat the plan named.
      try {
        ui?.notify?.(
          `role-fleet: auto-accepted recommended cast (${plan.roles.length} seat(s))`,
          "info",
        );
      } catch {
        // Headless: the note in plan.notes still records the confirmation.
      }
      return new Set(plan.roles.map((r) => r.id));
    };
  }
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
    const answer = await askDialog(
      [
        {
          id: "cast",
          question: castQuestion(plan),
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

  // The factory is rebound for every session, subagents included, so these
  // closure fields are per-session state. The seat record is pinned the first
  // time it is found: a newer run (or a nested fleet) reuses `rf-*` names and
  // re-points the registry, but this session still belongs to the run that
  // started it.
  let seat: SeatRecord | undefined;
  // The seat's clock: started with its first prompt, cleared by the yield that
  // ends it. A retry starts the seat again, and that continuation must not
  // restart the clock or the fallback history.
  let seatStartedAt: number | undefined;
  // The seat's own model, remembered at its first prompt. A retry fallback —
  // the seat's or an advisor's — fires the same event in this session, so
  // only the seat's model changing tells the two apart.
  let seatModel: string | undefined;
  // The report a seat yielded in pieces, folded as its sections arrive.
  const sections: SeatSections = {};
  // The MCP guard goes in once per session: the host may start the seat again,
  // and a second guard would stack on the first.
  let guardInstalled = false;
  const isSeatSession = (ctx: ExtensionContext): ctx is ExtensionContext & { agent: { kind: "sub"; name: string } } =>
    ctx.agent?.kind === "sub" && ctx.agent.name.startsWith(AGENT_PREFIX);

  let sink: ((text: string, level: "info" | "warning") => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    // The version is in the banner on purpose: a stale extension module is the
    // single most confusing failure mode, since `/reload-plugins` does not
    // rebuild it and only a restart picks up new code.
    if (ctx.agent?.kind === "sub") return;
    sink = (text, level) => ctx.ui.notify(text, level);
    setNotifier(sink);
    ctx.ui.notify(`role-fleet ${PLUGIN_VERSION} ready · /role-fleet <task>`, "info");
  });
  // Seat news must not go to a UI that is gone; another session's sink stays.
  pi.on("session_shutdown", () => {
    if (sink) clearNotifier(sink);
  });

  // Everything below observes or guards a *seat's own* session. None of it is
  // registered as a tool lifecycle hook in the main session: the host refuses
  // speculative task launch (and speculative reads) for every session in which
  // any extension holds a `tool_call` / `tool_result` handler, so a global hook
  // here would slow every task batch the user runs, fleet or not.
  pi.on("agent_start", async (_event, ctx) => {
    if (!isSeatSession(ctx)) return;
    // The clock starts with the seat's first prompt and is cleared by the yield
    // that ends it: a retry continues the same seat, and must not restart the
    // elapsed time or forget the model it started on.
    seatStartedAt ??= Date.now();
    seatModel ??= ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    if (guardInstalled) return;
    seat ??= await seatRecord(ctx.agent.name, ctx.cwd).catch(() => undefined);
    // The seat's grant: the run's record first, the seat's own definition file
    // second. A seat whose run directory is gone still says what it may do.
    const tools = seat?.tools ?? (await seatToolsFromDefinition(ctx.agent.name, ctx.cwd).catch(() => undefined));
    // A seat that may write keeps its MCP tools; the guard would buy nothing.
    if (seatMayWrite(tools)) return;
    // Fail closed: a seat whose grant cannot be read is not a seat that may
    // call every MCP tool the host hands it. The guard goes in, and it refuses
    // every MCP call outside the allowlist.
    guardInstalled = true;
    const seatName = ctx.agent.name;
    // A definition's `tools:` list governs built-ins only, and MCP tools stay
    // additive — so a seat the consent screen called read-only still holds every
    // connected MCP tool. The host mints MCP tools write-tier and runs subagents
    // unattended, so a read-only seat may call only the MCP tools the operator
    // allowed by name. Installed here, in this seat's session alone.
    pi.on("tool_call", (event) => {
      if (!isMcpToolName(event.toolName)) return;
      const verdict = mcpGuardVerdict({
        toolName: event.toolName,
        // The session is the seat's own: its identity is not read from the
        // tool call, which may carry none.
        agentKind: "sub",
        agentName: seatName,
        seatTools: tools,
        allowlist: mcpAllowlistFromEnv(process.env),
      });
      return verdict.block ? { block: true, reason: verdict.reason } : undefined;
    });
  });

  // A seat's yield is the one place its full report and the model that produced
  // it are both in hand, whether the parent runs seats as background jobs (the
  // host default, whose `task` result carries no seat results) or inline.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "yield" || event.isError || !isSeatSession(ctx)) return;
    const details =
      typeof event.result === "object" && event.result !== null && "details" in event.result
        ? event.result.details
        : undefined;
    // An incremental section is not the seat's result: the host assembles the
    // sections after the last one. Keep it — the terminal yield can arrive
    // with no data at all, and the report would be lost with it.
    const section = sectionFields(details);
    if (section) {
      Object.assign(sections, section);
      return;
    }
    seat ??= await seatRecord(ctx.agent.name, ctx.cwd).catch(() => undefined);
    if (!seat) return;
    const ran = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    // A fallback is the seat's own model changing. An advisor's fallback fires
    // the same event in the same session and leaves the seat's model alone, so
    // counting the event would blame the seat for the advisor's swap.
    const fellBack = ran !== undefined && seatModel !== undefined && ran !== seatModel;
    const { observation } = await settleSeat({
      record: seat,
      details,
      sections,
      ...(ran ? { ran } : {}),
      ...(fellBack && seatModel ? { fallbackFrom: seatModel } : {}),
      ...(seatStartedAt !== undefined ? { durationMs: Date.now() - seatStartedAt } : {}),
    });
    // The seat's next prompt starts a fresh clock, a fresh baseline model and
    // a fresh set of sections.
    seatStartedAt = undefined;
    seatModel = undefined;
    delete sections.report;
    delete sections.verdict;
    if (observation) notify(renderObservation(observation), observation.fallback ? "warning" : "info");
  });

  pi.registerCommand("role-fleet", {
    description: "Split a task into agent roles and dispatch each as soon as its dependencies report",
    getArgumentCompletions: completeArguments,
    handler: async (args, ctx: ExtensionCommandContext) => {
      // Safety net: a command that throws is rendered by the host as an opaque
      // "Extension command error". The user only ever sees an actionable message.
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        // The word alone, never as the first word of a task: "version the api
        // endpoints" is work to plan, and reading it as the version subcommand
        // made that task unplannable with no way to say so.
        if (words.length === 1 && (words[0] === "--version" || words[0] === "version")) {
          ctx.ui.notify(`omp-role-fleet ${PLUGIN_VERSION}`, "info");
          return;
        }

        if (words[0] === "runs" && words.length === 1) {
          ctx.ui.notify(await renderRunList(ctx.cwd), "info");
          return;
        }
        if (words[0] === "status" && words.length === 1) {
          ctx.ui.notify(await renderRunStatus(ctx.cwd), "info");
          return;
        }
        if (words[0] === "doctor" && words.length === 1) {
          ctx.ui.notify(
            [
              `role-fleet ${PLUGIN_VERSION}`,
              `specialist tier: ${typeof ctx.runEphemeralTurn === "function" ? "available" : "unavailable (static cast only)"}`,
              `model resolution: ${typeof ctx.models?.resolve === "function" ? "available" : "unavailable (aliases shown unresolved)"}`,
              `confirmation dialog: ${typeof ctx.ui?.askDialog === "function" ? "available" : "unavailable (dispatches without asking)"}`,
              `live status line: ${typeof ctx.ui?.setStatus === "function" ? "available" : "unavailable"}`,
              `read-only seat MCP allowlist: ${
                mcpAllowlistFromEnv(process.env).join(", ") || "(none — read-only seats may call no MCP tool)"
              }`,
            ].join("\n"),
            "info",
          );
          return;
        }
        if (words[0] === "report" && (words.length === 1 || (words.length === 2 && /^run-\d+$/.test(words[1]!)))) {
          ctx.ui.notify(await renderRunReport(ctx.cwd, words[1]), "info");
          return;
        }

        const { flags, task, problems } = parseFlags(words);
        for (const p of problems) ctx.ui.notify(p, "warning");
        if (!task) {
          ctx.ui.notify(
            "usage: /role-fleet <task> [--yes|-y] [--dry-run|-n] [--max-roles N] [--allowlist FILE] [--review-only] [--council [N]] [--models (a,b,c)] [--consul MODEL] [--slices N] · /role-fleet report [run-id] · /role-fleet status · /role-fleet runs · /role-fleet doctor",
            "warning",
          );
          return;
        }

        const progress = startProgress(ctx, ctx.ui, "role-fleet: choosing the cast…");
        let result: RunResult;
        try {
          result = await runRoleFleet(
            runOptions({ ...flags, task, cwd: ctx.cwd }, ctx, progress, async (approved) => {
              // An idle session does not start a turn for a plain sendMessage:
              // the batch would sit in history and never be executed. While a
              // turn is running, the batch steers the current one instead of
              // queueing behind it.
              pi.sendMessage(dispatchPrompt(task, approved), {
                ...(ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" as const }),
              });
            }),
          );
        } finally {
          // Cleared on every path, including a throw: an indicator that
          // outlives its run is a lie sitting in the status bar.
          progress.clear();
        }

        if (!result.ok || !result.plan) {
          // A dispatch failure is not a rejected plan: the files exist and the
          // user needs to know the fleet was emitted but never started.
          if (result.dispatchError) {
            ctx.ui.notify(
              `role-fleet: emitted ${result.agents.length} agent definition(s) but dispatch failed — ${cleanError(result.dispatchError)}`,
              "error",
            );
            return;
          }
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
      "Split a task into agent roles and return the approved dispatch plan (who starts now, who waits on whom) with per-role models and generated " +
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
        .min(2)
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
      slices: z
        .number()
        .int()
        .min(1)
        .max(MAX_SLICES)
        .optional()
        .describe("Fan the implementation out across this many writer seats (implementer-1 … -N)"),
      // Agents drive this tool; a cast dialog no human answers would hang the
      // turn. Default auto-accepts the recommended cast; set false to force the
      // interactive menu when a human is watching.
      autoConfirm: z
        .boolean()
        .optional()
        .describe("Accept the recommended cast without a dialog (default true for agent automation)"),
    }),
    async execute(_toolCallId, params: Flags & { task: string; autoConfirm?: boolean }, _signal, _onUpdate, ctx) {
      try {
        // The tool writes and prunes `.omp/agents/rf-*` and run trees, and
        // extension tools reach every seat regardless of its `tools:` grant. No
        // seat may plan a fleet: a nested plan would rewrite the definitions of
        // the seats in its own run that have not started yet.
        if (isSeatSession(ctx)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `role_fleet_plan is not available to the seat \`${ctx.agent.name}\`: it writes agent definitions and run files.`,
              },
            ],
            isError: true,
          };
        }
        const progress = startProgress(ctx, ctx.ui, "role-fleet: choosing the cast…");
        let result: RunResult;
        try {
          // Same builder the command path uses, so a task whose wording asks
          // for extra roles gets them on this path too. Tool default is auto
          // confirm: the model tool is the agent automation surface. `yes`
          // follows `autoConfirm` only, whatever else the arguments carry.
          const auto = params.autoConfirm !== false;
          result = await runRoleFleet(
            runOptions({ ...params, cwd: ctx.cwd, yes: auto }, ctx, progress, undefined, auto ? "auto" : "ask"),
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
        // A dispatchable run carries its cast in the dispatch batches and model
        // table already; repeating it as a plan listing only grows every later
        // turn's transcript. A dry run has no dispatch, so it shows the plan.
        const notes = result.plan.notes.length ? ["Notes:", ...result.plan.notes.map((n) => `  - ${n}`), ""] : [];
        const text = [
          renderVerdict(result.verdict),
          "",
          ...(params.dryRun
            ? [renderPlan(result.plan, result.waves)]
            : [...notes, "Dispatch instructions:", renderDispatch(result.groups, result.agentDir ?? "")]),
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          // The model gets the same batches the markdown renders, as data:
          // wave boundaries, roster names (including `-2` renames), artifacts,
          // dependencies and each seat's write authority. Parsing prose for
          // these is how a dispatch loses a seat or runs a wave twice.
          details: {
            runId: result.plan.runId,
            verdict: result.verdict,
            notes: result.plan.notes,
            roles: result.plan.roles.map((r) => ({
              id: r.id,
              model: r.model,
              ...(r.modelResolved ? { modelResolved: r.modelResolved } : {}),
            })),
            groups: dispatchPlan(result.groups),
            agentDir: result.agentDir,
            dryRun: params.dryRun ?? false,
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