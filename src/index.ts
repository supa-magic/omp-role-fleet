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
import { runRoleFleet, type RunOptions, type RunResult } from "./pipeline.ts";
import { MAX_COUNCIL, MAX_MODELS, MAX_ROLES, parseFlags, type Flags } from "./flags.ts";
import { dispatchPlan, renderDispatch, renderPlan, renderVerdict } from "./render.ts";
import { persistSettledRuns } from "./ledger.ts";
import { renderRunList, renderRunReport, renderRunStatus } from "./report.ts";
import { castPresets, seatRows } from "./confirm.ts";
import { DEFAULT_MAX_ROLES, grantsWrite, isCouncilMember, MAX_SLICES, planWaves, type RolePlan } from "./core.ts";
import { observeSettledRuns, recordExpectedModels, renderObservation, resetExpectedModels } from "./model-observed.ts";
import {
  isMcpToolName,
  mcpAllowlistFromEnv,
  mcpGuardVerdict,
  resetSeatToolsets,
  seatToolset,
} from "./mcp-policy.ts";
import type { RoleProposer } from "./generate.ts";

/** Kept in step with package.json; shown in the session banner. */
const PLUGIN_VERSION = "1.6.0";

/** Parameters of `role_fleet_plan`, declared for the same reason as everywhere:
 *  the host's schema type resolves tool params to `unknown`. */

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
    const writers = plan.roles.filter((r) => grantsWrite(r.tools)).length;
    const shells = plan.roles.filter((r) => r.tools.includes("bash")).length;
    // The shell count is not folded into the writer count: a shell is wider than
    // an editor's grant — any command, any path — and the question a user is
    // answering here is what the run may do, so the reach is named.
    const authority =
      writers === 0
        ? "no seat can change the code"
        : `${writers} of ${plan.roles.length} seat(s) can change the code` +
          (shells ? `, ${shells} of them with a shell: any command, any path` : "");
    // The consent screen is where the spend is approved, so the council's
    // independence has to be legible here — plan notes are printed after the
    // dialog and cannot inform the answer. Aliases that resolve to one model
    // buy one review several times.
    const reviewers = plan.roles.filter((r) => isCouncilMember(r.id));
    const reviewerModels = new Set(reviewers.map((r) => r.modelResolved ?? r.model));
    const collapse =
      reviewers.length > 1 && reviewerModels.size < reviewers.length
        ? ` (${reviewerModels.size} distinct model${reviewerModels.size === 1 ? "" : "s"} across ${reviewers.length} reviewers)`
        : "";
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
            .join(", ")}?${collapse} ${authority}.`,
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
    resetSeatToolsets();
    ctx.ui.notify(`role-fleet ${PLUGIN_VERSION} ready · /role-fleet <task>`, "info");
  });

  // The one place the host states which model a seat actually ran on: every
  // settled `task` result carries it. Plan-time resolution records intent, and
  // a retry fallback replaces exactly that — without this the alias and the
  // plan keep claiming the intended model after the provider switched.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "task" || ctx.agent?.kind === "sub") return;
    // Best-effort ledger: place read-only reports and record outcomes before
    // the transient notification, so a missed line is still auditable later.
    await persistSettledRuns(event.details).catch(() => ({ outcomes: [], written: [] }));
    for (const observation of observeSettledRuns(event.details)) {
      ctx.ui.notify(renderObservation(observation), observation.fallback ? "warning" : "info");
    }
  });

  // The gap this closes: a definition's `tools:` list governs built-ins only,
  // and MCP tools stay additive — so a seat the consent screen called
  // read-only still holds every connected MCP tool. The host mints MCP tools
  // with `approval = "write"` and runs subagents with `tools.approvalMode:
  // "yolo"`, so a write-capable MCP tool would run unattended behind a screen
  // that promised the seat could not write. Read-only seats therefore get
  // only the MCP tools the operator allowed by name.
  pi.on("tool_call", async (event, ctx) => {
    if (!isMcpToolName(event.toolName)) return;
    if (ctx.agent?.kind !== "sub") return;
    const seatTools = await seatToolset(ctx.agent.name, ctx.cwd).catch(() => undefined);
    const verdict = mcpGuardVerdict({
      toolName: event.toolName,
      agentKind: ctx.agent.kind,
      agentName: ctx.agent.name,
      ...(seatTools ? { seatTools } : {}),
      allowlist: mcpAllowlistFromEnv(process.env),
    });
    if (!verdict.block) return;
    return { block: true, reason: verdict.reason };
  });

  pi.registerCommand("role-fleet", {
    description: "Split a task into agent roles and dispatch them in parallel waves",
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
              `async task snapshot: ${typeof ctx.getAsyncJobSnapshot === "function" ? "available" : "unavailable"}`,
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
              // The settled-result observer compares what ran against this.
              // Recorded before the batch is dispatched, so a fast wave cannot
              // settle before the plan it is measured against exists. A
              // subagent session runs its own fleet and must not overwrite the
              // parent's baseline.
              recordExpectedModels(approved.agents, { subSession: ctx.agent?.kind === "sub" });

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
        const progress = startProgress(ctx, ctx.ui, "role-fleet: choosing the cast…");
        let result: RunResult;
        try {
          // Same builder the command path uses, so a task whose wording asks
          // for extra roles gets them on this path too. Tool default is auto
          // confirm: the model tool is the agent automation surface.
          const auto = params.autoConfirm !== false;
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
                slices: params.slices,
                ...(auto ? { yes: true } : {}),
              },
              ctx,
              progress,
              undefined,
              auto ? "auto" : "ask",
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
          // The model gets the same batches the markdown renders, as data:
          // wave boundaries, roster names (including `-2` renames), artifacts,
          // dependencies and the read-only placement contract. Parsing prose
          // for these is how a dispatch loses a seat or runs a wave twice.
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