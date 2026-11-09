# omp-role-fleet

One task in → a team of specialised agents out. The plugin picks roles, assigns models, starts each one as soon as the roles it depends on have reported, and hands results back to the main model.

```
you:    refactor the auth module and review it
plugin: scout → planner → implementer → tester → reviewer(s)
```

No config file. Agent definitions are written per run under `.omp/agents/rf-*` and pruned on the next run.

<https://github.com/supa-magic/omp-role-fleet>

---

## Install

```sh
omp plugin install @supa-magic/omp-role-fleet
```

**Start a new session** after install — `/reload-plugins` does not reload extension code.

```sh
omp plugin list
/role-fleet --version
```

From a checkout: `omp plugin link ./omp-role-fleet`  
Requires oh-my-pi **18.11+** — the first release that reads `structured: true` from an
agent definition, which is what gives a seat its `yield` tool and its report. On an older
host a seat has no `yield` tool, its report is never placed, and nothing says so.
`/role-fleet doctor` reports the host version and whether it is new enough.

---

## Usage

```text
/role-fleet fix the login bug
/role-fleet refactor auth across several files and review it --dry-run
```

`--dry-run` / `-n` plans only (nothing written, no paid specialist tier).

Watch agents live with **Alt+A** (Agent Hub).

### Flags

Flags go **before** the task or **after** it — never in the middle of it. A
flag-shaped word inside the task is task text: `/role-fleet add a --dry-run
flag to the deploy script` is a task about a flag, not a dry run with the words
cut out of it. `--` ends the flags outright, and everything after it is task
text.

| Flag | Effect |
|---|---|
| `--dry-run`, `-n` | Plan only |
| `--yes`, `-y` | Skip cast dialog — accept recommended seats (for agents/automation) |
| `--council [N]` | N reviewers on different models (max 3) |
| `--models (a,b,c)` | Review seats on these models, in order (max 5). `--models=a,b` works too — brackets are optional in the `=` form and required in the spaced one |
| `--consul MODEL` | Model that reconciles council reports: `@alias` or `provider/id`. A bare name goes as `--consul=NAME` (default: session model) |
| `--review-only` | Scout + review only — no code changes |
| `--max-roles N` | Cap generated roles (default 4, min 2, max 8) |
| `--slices N` | N parallel writer seats (max 4) |
| `--allowlist FILE` | Pin models via JSON instead of `@` aliases |

Examples:

```text
/role-fleet --council 3 --consul zai/glm-5 review the auth fix
/role-fleet --models (xai/grok-4, zai/glm-5) refactor the adapter
/role-fleet --review-only review the auth fix
/role-fleet --slices 2 fix the login bug
/role-fleet fix the login bug --dry-run
```

`--models` list length sets council size (one reviewer per model). An allowlist, when present, wins for seats it describes.

Optional: pin models via a JSON file — point `ROLE_FLEET_ALLOWLIST` or `--allowlist` at it (not auto-loaded from a default path):

```sh
export ROLE_FLEET_ALLOWLIST=~/.omp/agent/role-fleet.json
```

```json
{
  "models": [
    { "selector": "anthropic/claude-haiku-4-5", "aliases": ["haiku"] },
    { "selector": "anthropic/claude-sonnet-4-6", "aliases": ["sonnet"] },
    { "selector": "openai/gpt-5.5", "aliases": ["gpt"], "enabled": false }
  ],
  "roles": [
    { "role": "scout", "chain": ["haiku"] },
    { "role": "implementer", "chain": ["sonnet"], "aliases": ["builder"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `models[].selector` | The concrete `provider/id` this entry stands for (required) |
| `models[].aliases` | Extra names the model answers to — a chain may name an alias instead of the selector |
| `models[].enabled` | `false` takes the model out of every chain (default `true`) |
| `roles[].role` | The seat the entry pins: `scout`, `planner`, `implementer`, `tester`, `reviewer`, `docs-updater`, `designer`, `security`, `consul` |
| `roles[].chain` | The models for that seat, in preference order — selectors or aliases |
| `roles[].aliases` | Extra names for that same seat (e.g. `builder` for `implementer`) |

A seat the file does not describe keeps its `@` alias, and the plan says so. Council members
take the first, second, … model of their seat's chain, so a chain of three distinct models
gives a council three different models.

### Confirm the cast

Before anything is written you see the seats, models, and grants (read-only / edit / shell). Presets: **Run all of them**, **Look, don't touch** (drops every seat that can change the code), **One reviewer instead of N** (a council only — it keeps exactly one reviewer), and **Choose each seat yourself**. Dropping a seat drops its dependents. Headless hosts skip the dialog and dispatch.

When an **agent** drives the fleet (`role_fleet_plan` tool, or `/role-fleet --yes`), the recommended cast is accepted automatically so the turn does not hang on a menu. The plan records that cast as *auto-accepted*, not as confirmed. Pass `autoConfirm: false` on the tool to force the dialog.

### The `role_fleet_plan` tool

The same planner the command uses, as a tool. It writes `.omp/agents/rf-*` and the run tree,
so it is a write-tier tool, and a read-only seat may not call it.

| Parameter | Type | Default | Effect |
|---|---|---|---|
| `task` | string | — | The task to decompose (required, not blank) |
| `maxRoles` | number | 4 | Cap on generated roles (2–8) |
| `allowlist` | string | — | Pin models to an allowlist JSON file |
| `dryRun` | boolean | `false` | Plan without writing agent definitions |
| `council` | number | 3 when the task asks for it | Reviewers on distinct model-role aliases (1–3) |
| `models` | string[] | — | Explicit review models, in order (max 5) |
| `consul` | string | session model | Model that reconciles the council's reports |
| `reviewOnly` | boolean | `false` | Scout + review seats only — no seat can change the code |
| `slices` | number | 1 | Fan the implementation out across N writer seats (1–4) |
| `autoConfirm` | boolean | `true` | Accept the recommended cast without a dialog |

---

## Models

By default seats use `@` aliases from your `/model` → `modelRoles`:

| Seat | Alias |
|---|---|
| Investigator, Tester, Docs updater | `@smol` |
| Planner | `@plan` |
| Implementer, Migration runner | `@task` |
| Reviewer, Security auditor | `@slow` |
| Designer | `@designer` |
| Proposed specialists | `@smol`, `@plan`, `@task`, `@slow`, `@designer`, `@vision` |

`@designer` and `@vision` are **not** stock omp model roles: they resolve only if your
`/model` → `modelRoles` has a `designer` / `vision` entry. Without one the seat runs on the
parent session's model, and the plan says the alias was not resolved.

Each seat records what **actually** ran (including retry fallbacks) from its own session when it yields; the main session shows a divergence as it happens:

```text
role-fleet: rf-reviewer-c1 — planned `anthropic/claude-opus-4-6`, ran `zai/glm-5`, FALLBACK
```

A fallback is the seat's **own** model changing: an advisor's model swap fires the same event in the same session and is not counted as the seat's.

`/role-fleet report` and `.role-fleet/run-*/plan.json` keep the same record (model, fallback, verdict, seat time).

A selector the host cannot resolve — a `--models` entry, a `--consul`, an allowlist pin —
is marked unresolved in the plan, on the consent screen and in the seat's brief: the seat
runs on the session model, not on the one that was named.

---

## Environment

| Variable | Effect |
|---|---|
| `ROLE_FLEET_ALLOWLIST` | Path to the allowlist JSON. Used when `--allowlist` is not given; `~` is expanded |
| `ROLE_FLEET_MCP_READONLY` | Comma-separated MCP tool-name prefixes a read-only seat may call (default: none) |

Allowlist paths offered as completions for `--allowlist`, when the file exists — nothing is
auto-loaded from them:

```text
.omp/role-fleet.json
~/.omp/agent/role-fleet.json
~/.orch/fleet.json
```

---

## Reports

Every seat yields a structured result (`structured: true` is set in each generated definition, so this holds even with the host's `task.structured` off): full **`report`**, short **`summary`**, **`verdict`**. The council and consul must read `report`, not `summary`.

The plugin writes every seat's full report to its artifact path when the seat yields — read-only and writer seats alike (a seat's own write to the run directory is refused by the host sandbox, so a writer seat could not do it itself). The main model never copies reports between waves. A seat that yields **no** report is recorded as a failure (`seat yielded no report`), its artifact is not written, and the main session is warned.

## Speed

- The plugin registers no `tool_call`/`tool_result` hook in your main session: the host turns off speculative task launch wherever an extension holds one. The MCP guard is installed only inside `rf-*` seat sessions.
- Planning (cast, gate, emit) takes a few milliseconds; a run's wall clock is its critical path of seats. Each seat starts as soon as the seats it depends on have reported — never held behind an unrelated slow seat. A planner is added only for breadth wording (`across`, `several files`, `migrate`, `codemod`, …), and the single reviewer that gates a change runs at medium effort (council, consul, review-only and security asks stay high).
- Per-seat `effort` reaches the host only with `task.enableEffort` on.

---

## Council & slices

- **Council** (`--council` / `--models` / task wording): several independent reviewers. Optional **`--consul MODEL`** reconciles them.
- **`--slices N`**: N writer seats that start together; tester/reviewer wait on all of them. Give each writer its own files from the scout map.

Seats are dispatched as `task` batches: those with no dependencies at once, then each one as soon as every seat it depends on has reported (seats ready at the same moment go together). Results auto-deliver — do not poll `wait` (call it only when fully blocked).

---

## Inspect runs

```text
/role-fleet report              # newest run
/role-fleet report run-…        # by id
/role-fleet status              # settled / failed / missing
/role-fleet runs                # recent runs
/role-fleet doctor              # host capabilities
```

Artifacts and `plan.json` live under `.role-fleet/` (gitignored; newest 10 kept).

---

## Safety

- Confirmation before write/dispatch (interactive hosts).
- Tool grants are pinned per seat; shell only on implementer/tester-class seats.
- Generated agents are `rf-*` only; hand-written agents are never touched, and
  only `rf-*` files are ever pruned or replaced.
- No seat may plan a nested fleet: `role_fleet_plan` is refused in every `rf-*`
  session, because a nested plan rewrites the definitions of seats that have
  not started yet.
- Task text never enters frontmatter.
- **Read-only seats get no MCP tools by default.** omp gives every seat every
  connected MCP tool (a `tools:` list covers built-ins only), mints MCP tools
  write-tier, and runs subagents unattended — so a write-capable MCP tool in a
  "read-only" seat would run behind a screen that promised it could not write.
  Read-only seats may call only the MCP tools you allow:

  ```sh
  export ROLE_FLEET_MCP_READONLY=mcp__codesearch_   # comma-separated prefixes
  ```

  A prefix is the tool name as it appears in the seat's tool list: server names
  are lowercased and every character outside `a-z0-9_` becomes `_`, so a server
  named `my-server` is `mcp__my_server_`. The exact tool name also works
  (`mcp__codesearch_search`).

  Seats that may write (implementer, tester) keep their MCP tools. A generated
  seat whose grant cannot be read at all — no run record, no definition file —
  is guarded too: it may call no MCP tool outside the allowlist, because
  nothing proves it may not write. Check the effective list with
  `/role-fleet doctor`.

---

## Development

```sh
npm test
npm run typecheck
```

Publish: bump `package.json` and `package-lock.json` together (`npm version X.Y.Z --no-git-tag-version`; the banner reads the version from `package.json`) → GitHub Release `vX.Y.Z` → workflow publishes to npm (`NPM_TOKEN`).

---

## License

MIT
