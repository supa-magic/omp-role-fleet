# omp-role-fleet

One task in → a team of specialised agents out. The plugin picks roles, assigns models, runs them in dependency waves, and hands results back to the main model.

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
| `--allowlist FILE` | Pin models via JSON instead of `@` aliases |

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

### Confirm the cast

Before anything is written you see the seats, models, and grants (read-only / edit / shell). Presets: run all, look-only, fewer reviewers, or pick seats. Dropping a seat drops its dependents. Headless hosts skip the dialog and dispatch.

When an **agent** drives the fleet (`role_fleet_plan` tool, or `/role-fleet --yes`), the recommended cast is accepted automatically so the turn does not hang on a menu. Pass `autoConfirm: false` on the tool to force the dialog.

---

## Models

By default seats use `@` aliases (`@smol`, `@plan`, `@task`, `@slow`, …) from your `/model` → `modelRoles`.

After a run settles, the plugin reports what **actually** ran (including fallbacks):

```text
role-fleet: rf-reviewer-c1 — planned `@slow`, ran `zai/glm-5` — FALLBACK
```

`/role-fleet report` and `.role-fleet/run-*/plan.json` keep the same record.

---

## Reports

Every seat yields a structured result: full **`report`**, short **`summary`**, **`verdict`**. The council and consul must read `report`, not `summary`. Read-only seats cannot write files — the orchestrator (or the plugin ledger) places their report on the artifact path before the next wave.

---

## Council & slices

- **Council** (`--council` / `--models` / task wording): several independent reviewers. Optional **`--consul MODEL`** reconciles them.
- **`--slices N`**: N writer seats in one parallel wave; tester/reviewer wait on all of them. Give each writer its own files from the scout map.

Waves run as parallel `task` batches. Results auto-deliver — do not poll `wait` between waves (call `wait` only when fully blocked). Next wave starts after every seat of the previous wave has reported.

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

---

## Development

```sh
npm test
npm run typecheck
```

Publish: bump `package.json`, `package-lock.json`, and `PLUGIN_VERSION` in `src/index.ts` together → GitHub Release `vX.Y.Z` → workflow publishes to npm (`NPM_TOKEN`).

---

## License

MIT
