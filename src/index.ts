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
import { runRoleFleet, type RunResult } from "./pipeline.ts";
import { renderDispatch, renderPlan, renderVerdict } from "./render.ts";
import { isAdvisorAgent, readAdvise, recordNote, renderNotes, resetNotes, worstSeverity } from "./advisor-watch.ts";
import type { RoleProposer } from "./generate.ts";

/** Kept in step with package.json; shown in the session banner. */
const PLUGIN_VERSION = "1.0.0";

/** Parameters of `role_fleet_plan`, declared for the same reason as everywhere:
 *  the host's schema type resolves tool params to `unknown`. */
interface PlanToolParams {
  task: string;
  maxRoles?: number;
  allowlist?: string;
  dryRun?: boolean;
  specialist?: boolean;
  council?: number;
}

/** Bounds shared with the `role_fleet_plan` zod schema, so the flag path and
 *  the tool path cannot disagree about what is reachable. */
const MAX_ROLES = 8;
const MAX_COUNCIL = 3;

interface Flags {
  dryRun: boolean;
  allowlist?: string;
  maxRoles?: number;
  specialist?: boolean;
  council?: number;
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
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--dry-run" || word === "-n") flags.dryRun = true;
    else if (word === "--allowlist") {
      const value = takeValue(i);
      if (value === undefined) {
        // Falling through to ROLE_FLEET_ALLOWLIST would silently pin a file
        // the user never named.
        problems.push('--allowlist needs a file path, ignoring it');
      } else {
        flags.allowlist = value;
        i++;
      }
    } else if (word.startsWith("--allowlist=")) {
      // An empty path is a missing path: it would fall through to
      // ROLE_FLEET_ALLOWLIST or to unpinned alias mode without a word.
      const value = word.slice("--allowlist=".length);
      if (value === "") problems.push("--allowlist needs a file path, ignoring it");
      else flags.allowlist = value;
    }
    else if (word === "--max-roles") {
      const value = takeValue(i);
      if (value !== undefined) i++;
      flags.maxRoles = numeric(value, "--max-roles", MAX_ROLES);
    } else if (word.startsWith("--max-roles=")) flags.maxRoles = numeric(word.slice("--max-roles=".length), "--max-roles", MAX_ROLES);
    else if (word === "--specialist") flags.specialist = true;
    else if (word === "--council") {
      // `--council` is bare (size 3), but `--council 5` must consume the number:
      // left unconsumed it landed in the task text of every emitted agent.
      const value = takeValue(i);
      if (value !== undefined) {
        i++;
        flags.council = numeric(value, "--council", MAX_COUNCIL);
      } else {
        flags.council = MAX_COUNCIL;
      }
    } else if (word.startsWith("--council=")) flags.council = numeric(word.slice("--council=".length), "--council", MAX_COUNCIL);
    else rest.push(word);
  }
  return { flags, task: rest.join(" ").trim(), problems };
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
  { value: "--max-roles 4", label: "--max-roles N · cap generated roles (default 4)" },
  { value: "--allowlist ", label: "--allowlist FILE · pin models to a file instead of @aliases" },
  { value: "--specialist", label: "--specialist · force LLM-proposed specialist roles" },
  { value: "--council", label: "--council [N] · N reviewers on different providers" },
];

function completeArguments(prefix: string): ArgumentCompletion[] | null {
  if (/^--allowlist[ =]/.test(prefix)) {
    const typed = prefix.replace(/^--allowlist[ =]\s*/, "");
    return ALLOWLIST_SUGGESTIONS.filter(
      (c) => c.path.includes(typed) && existsSync(c.path),
    ).map((c) => ({ value: `--allowlist ${c.path}`, label: `--allowlist ${c.path}` }));
  }
  const needle = prefix.toLowerCase();
  const hits = FLAG_COMPLETIONS.filter(
    (e) => e.value.toLowerCase().startsWith(needle) || e.label.toLowerCase().includes(needle),
  );
  return hits.length ? hits : null;
}

/** Well-known allowlist locations, suggested only when they exist. */
const ALLOWLIST_SUGGESTIONS: Array<{ path: string }> = [
  { path: join(process.cwd(), ".omp", "role-fleet.json") },
  { path: join(homedir(), ".omp", "agent", "role-fleet.json") },
  { path: join(homedir(), ".orch", "fleet.json") },
];

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

/** Strip the redundant `Error:` prefix so notifications read as one message. */
function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}

export default function roleFleet(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.on("session_start", (_event, ctx) => {
    // The version is in the banner on purpose: a stale extension module is the
    // single most confusing failure mode, since `/reload-plugins` does not
    // rebuild it and only a restart picks up new code.
    // Notes are process-level state: without this reset, a session started in
    // the same process would inherit the previous one's advisor notes.
    resetNotes();
    ctx.ui.notify(`role-fleet ${PLUGIN_VERSION} ready · /role-fleet <task>`, "info");
  });

  // The only advisor surface extensions can see: the advisor's own `advise`
  // tool calls, which arrive here with an advisor agent identity.
  pi.on("tool_call", (event, ctx) => {
    if (!isAdvisorAgent(ctx.agent) || event.toolName !== "advise") return;
    const advise = readAdvise(event.input);
    if (!advise) return;
    recordNote({
      severity: advise.severity,
      note: advise.note,
      advisor: ctx.agent?.name ?? "advisor",
      at: Date.now(),
    });
    if (advise.severity === "blocker") {
      ctx.ui.notify(`advisor blocker: ${advise.note}`, "error");
    }
  });

  pi.registerCommand("role-fleet-advisor", {
    description: "Show the advisor notes recorded in this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderNotes(), worstSeverity() === "blocker" ? "error" : "info");
    },
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
            "usage: /role-fleet <task> [--dry-run] [--max-roles N] [--allowlist FILE] [--specialist] [--council [N]]",
            "warning",
          );
          return;
        }

        const result = await runRoleFleet({
          task,
          cwd: ctx.cwd,
          dryRun: flags.dryRun,
          maxRoles: flags.maxRoles,
          allowlist: flags.allowlist,
          specialist: flags.specialist,
          council: flags.council,
          // One cheap side turn, no history, no executed tools: the dynamic
          // specialist tier. Absent on hosts without side turns — static only.
          propose: makeProposer(ctx),
        });

        if (!result.ok || !result.plan) {
          ctx.ui.notify(renderVerdict(result.verdict), "error");
          return;
        }

        ctx.ui.notify(
          `${renderPlan(result.plan, result.waves)}\n\n${renderVerdict(result.verdict)}`,
          "info",
        );
        if (flags.dryRun) return;

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
      task: z.string().describe("The user task to decompose into roles"),
      maxRoles: z.number().int().min(1).max(MAX_ROLES).optional().describe("Cap on generated roles (default 4)"),
      allowlist: z.string().optional().describe("Pin models to an allowlist JSON file"),
      dryRun: z.boolean().optional().describe("Plan without writing agent definitions"),
      specialist: z.boolean().optional().describe("Force the LLM-proposed specialist tier"),
      council: z
        .number()
        .int()
        .min(1)
        .max(MAX_COUNCIL)
        .optional()
        .describe("Reviewers on distinct model-role aliases (default 3 when the task asks for it)"),
    }),
    async execute(_toolCallId, params: PlanToolParams, _signal, _onUpdate, ctx) {
      try {
        const result = await runRoleFleet({
          task: params.task,
          cwd: ctx.cwd,
          dryRun: params.dryRun ?? false,
          maxRoles: params.maxRoles,
          allowlist: params.allowlist,
          specialist: params.specialist,
          council: params.council,
          // Same cheap side turn the command path uses, so `specialist: true`
          // is not a silent no-op for model callers. Absent on hosts without
          // side turns — static cast only.
          propose: makeProposer(ctx),
        });
        if (!result.ok || !result.plan) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Role plan rejected.\n${renderVerdict(result.verdict)}\nDo not dispatch; report these issues instead.`,
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
        return {
          content: [{ type: "text" as const, text }],
          details: {
            roles: result.plan.roles.map((r) => ({ id: r.id, model: r.model })),
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