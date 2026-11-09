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
Requires oh-my-pi **18.10+**.

---

## Usage

```text
/role-fleet fix the login bug
/role-fleet refactor auth across several files and review it --dry-run
```

`--dry-run` / `-n` plans only (nothing written, no paid specialist tier).

Watch agents live with **Alt+A** (Agent Hub).

### Flags

| Flag | Effect |
|---|---|
| `--dry-run`, `-n` | Plan only |
| `--yes`, `-y` | Skip cast dialog — accept recommended seats (for agents/automation) |
| `--council [N]` | N reviewers on different models (max 3) |
| `--models (a,b,c)` | Review seats on these models, in order (max 5; brackets required) |
| `--consul MODEL` | Model that reconciles council reports (default: session model) |
| `--review-only` | Scout + review only — no code changes |
| `--max-roles N` | Cap generated roles (default 4, max 8) |
| `--slices N` | N parallel writer seats (max 4) |
| `--allowlist FILE` | Pin models via JSON instead of `@` aliases (a blank path is ignored — `ROLE_FLEET_ALLOWLIST` applies) |

Examples:

```text
/role-fleet --council 3 --consul zai/glm-5 review the auth fix
/role-fleet --models (xai/grok-4, zai/glm-5) refactor the adapter
/role-fleet --review-only review the auth fix
/role-fleet --slices 2 fix the login bug
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
    { "selector": "anthropic/claude-sonnet-4-6", "aliases": ["sonnet"] }
  ],
  "roles": [
    { "role": "scout", "chain": ["haiku"] },
    { "role": "implementer", "chain": ["sonnet"] }
  ]
}
```

A role's `chain` spreads across a review council — member N takes the Nth enabled model. Seats that share one core (a `--slices` fan-out) all take the chain's first enabled model.

### Confirm the cast

Before anything is written you see the seats, models, and grants (read-only / edit / shell). Presets: run all, look-only, fewer reviewers, or pick seats. Dropping a seat drops its dependents. Headless hosts skip the dialog and dispatch.

When an **agent** drives the fleet (`role_fleet_plan` tool, or `/role-fleet --yes`), the recommended cast is accepted automatically so the turn does not hang on a menu. Pass `autoConfirm: false` on the tool to force the dialog.

---

## Models

By default seats use `@` aliases (`@smol`, `@plan`, `@task`, `@slow`, …) from your `/model` → `modelRoles`.

Each seat records what **actually** ran (including retry fallbacks) from its own session when it yields; the main session shows a divergence as it happens:

```text
role-fleet: rf-reviewer-c1 — planned `anthropic/claude-opus-4-6`, ran `zai/glm-5`, FALLBACK
```

`/role-fleet report` and `.role-fleet/run-*/plan.json` keep the same record (model, fallback, verdict, seat time).

---

## Reports

Every seat yields a structured result (`structured: true` is set in each generated definition, so this holds even with the host's `task.structured` off): full **`report`**, short **`summary`**, **`verdict`**. The council and consul must read `report`, not `summary`. Read-only seats cannot write files — the plugin writes each one's full report to its artifact path when the seat yields, so the main model does not copy reports between waves.

## Speed

- The plugin registers no `tool_call`/`tool_result` hook in your main session: the host turns off speculative task launch wherever an extension holds one. The read-only MCP guard is installed only inside read-only `rf-*` seat sessions.
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
- Generated agents are `rf-*` only; hand-written agents are never touched.
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

  Seats that may write (implementer, tester) keep their MCP tools. Check the
  effective list with `/role-fleet doctor`.

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
