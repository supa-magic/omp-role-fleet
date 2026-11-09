# Changelog

Entries before 1.4.0 are reconstructed from the commit record and the tags that
exist (`v1.3.4`, `v1.3.5`); a release is cut from `package.json#version`.

## Unreleased

### Fixed — UI casts, run isolation, allowlist pinning

- A designer in a cast with an implementer now waits for the implementer, and
  the reviewer, council and docs wait for the designer: two writers no longer
  touch unpartitioned files at once, and review sees every write. The
  image/render/layout/design/theme words seat a designer only next to a UI
  word, so "build the docker image in CI" keeps its tester and gets no designer.
  `render the checkerboard pattern` with no UI word is now a one-scout cast
  that goes to the dynamic tier.
- Seat records are keyed by working directory and agent name, so two projects
  in one process never share a seat's record.
- A seat's report path read back from `plan.json` must lie inside that run's
  directory; otherwise no record is built and no report is written.
- Before emitting, a run checks this tree's manifests and notes an earlier run
  whose seats still have no outcome, however old it is. This replaces the
  5-minute-only warning.
- A blank `allowlist` argument is an absent one: `ROLE_FLEET_ALLOWLIST` still
  pins the run, and the ignored path is reported.
- An allowlist chain spreads across a review council only. Seats that share one
  core (a `--slices` fan-out) all take the chain's first enabled model instead
  of the second writer falling back to its `@` alias.

### Changed — flags live at the edges of the command

- Flags are read from the two edges of the command: a leading run before the
  first word of the task, and a trailing run after the last one. A flag-shaped
  word **inside** the task is task text. `/role-fleet add a --dry-run flag to
  the deploy script` planned a dry run and cut the words out of the task; it
  is now a task about a flag.
- The same rule takes the other accidents with it: `--yes` in the middle of a
  task no longer skips the cast dialog, `--council` no longer buys three paid
  reviewers, `--allowlist` no longer eats the next word, and a mistyped flag
  in the middle of a task is no longer reported as a flag at all.
- `--` ends the flags outright: everything after it is task text, flags
  included.
- The task keeps the line breaks and the spacing it was given. The words were
  rejoined with single spaces before, so a two-line task reached every agent
  brief as one line.

### Fixed — a seat's report can no longer go missing

- The plugin places **every** seat's full report at its artifact path when the
  seat yields, writer seats included. A writer's own write to the run
  directory is refused by the host sandbox, so the seat that could write its
  artifact never did: the run looked healthy and the artifact was not there.
- A seat that yields no report — or a blank one — is recorded as
  `seat yielded no report`, no artifact is claimed, and the main session is
  warned. The same goes for a report that could not be written.
- A report yielded in sections is placed when the terminal yield arrives: the
  host assembles the sections after the last one, and the terminal yield can
  carry no data at all.
- An outcome that could not be appended to `plan.json` is reported, not
  dropped in silence.

### Fixed — the MCP guard and the plan tool fail closed

- A generated seat whose grant cannot be read — no run record, no definition
  file — is guarded too: it may call no MCP tool outside the allowlist,
  because nothing proves it may not write. The grant is read from the seat's
  own definition file when the run record is gone.
- `role_fleet_plan` is refused in **any** `rf-*` session, writer seats
  included: a nested plan rewrites the definitions of seats that have not
  started yet.

### Fixed — the fallback record

- A fallback is counted when the seat's **own** model changes. An advisor's
  model swap fires the same event in the same session and was recorded as the
  seat's own fallback.
- A retry that starts the seat again no longer restarts its clock or erases
  its fallback history: the seat's elapsed time and its fallback survive the
  continuation.

### Fixed — reading a run back

- A manifest without `agents` or `notes` is read instead of thrown at, a file
  named like a run is not a run, and `/role-fleet status` names an unreadable
  newest manifest and shows the next readable run.
- A seat that came back `blocked` counts as failed.
- The first manifest of a run is written through a temp file and a rename.

### Fixed — the prune spares the user's files

- Only `rf-*` files are pruned or replaced. A copy of a generated seat under
  another name carried the generated marker and was deleted by the next run.

### Internal

- `mayWrite` replaces `writesOwnReport` in the run manifest and in the plan
  tool's dispatch data: the plugin places every seat's report, so the flag
  says what the seat's grant allows.
- A proposal whose dependencies form a cycle — or a role that waits on itself
  — is refused whole, instead of shipping a plan that can never be scheduled.

### Fixed — write seats only where the tree may change

- The change vocabulary reads verb forms only. `implement\w*` matched "the
  implementation of the auth module" and `improv\w*` matched "suggest
  improvements", so a task that asked to be *told about* the code minted an
  implementer and a tester with a shell. A subject is not an ask.
- The specialist proposal now carries the proposer's own reading of the task —
  `analysis` or `change`. On a cast the static heuristics could not read (the
  degenerate cast the tier exists for) that verdict decides whether a proposed
  writer may join, so a task read as analysis gets no seat that can change the
  code.
- A selector the host cannot resolve is marked unresolved in the plan, on the
  consent screen and in the seat's brief. A `--models` entry, a `--consul` or an
  allowlist pin that names a model the host does not have used to be printed as
  if it were one; the seat rides the session model instead, and the plan says
  so.
- A cast nobody was asked about is recorded as auto-accepted, not as confirmed.
  The agent-driven path and `--yes` open no dialog, and the note claimed a
  decision that never happened.

### Fixed — a typo no longer starts a paid run

- `/role-fleet report run-12x` — a word that starts like a run id but is not
  one — is a usage warning now, and plans nothing. It used to fall through to
  planning and start a fleet for a typo. The run-id shape comes from
  `run-layout.ts`, which owns it.

### Changed — the minimum host, stated honestly

- The minimum host is oh-my-pi **18.11.0**: the first release that reads
  `structured: true` from an agent definition, which is what gives a seat its
  `yield` tool and its report. On an older host a seat has no `yield` tool, its
  report is never placed, and nothing says so. The README and the dev
  dependency say so, and `/role-fleet doctor` reports the running host's version
  and whether it is new enough.

### Docs — the README matches the code

- `--models=a,b` works without brackets; the flag table said the brackets were
  required. `--consul` states its shape (`@alias` or `provider/id`; a bare name
  goes as `--consul=NAME`) and `--max-roles` its minimum of 2.
- The cast presets are named as they are: the council preset keeps exactly one
  reviewer, it does not keep "fewer".
- `@designer` and `@vision` are documented, with the `modelRoles` entries they
  need to resolve.
- The allowlist file documents `enabled` and `roles[].aliases`. There is an
  environment table (`ROLE_FLEET_ALLOWLIST`, `ROLE_FLEET_MCP_READONLY`, and the
  allowlist paths offered for `--allowlist`) and a table of the
  `role_fleet_plan` parameters with their defaults.


## 1.7.0

### Fixed — the ledger works on default host settings

- Seat reports, outcomes and fallback notices are now recorded from the seat's
  own session when it yields (`tool_execution_end` for `yield`). With the
  host's default `async.enabled`, the parent's `task` result carries no seat
  results, so the old `tool_result` ledger never fired: read-only reports were
  never placed, `plan.json` outcomes stayed empty and fallbacks went unreported.
- Generated definitions set `structured: true`. With the host's default
  `task.structured` off, seats had no `yield` tool and their `output:` schema
  was ignored — results came back as a last paragraph, not a full `report`.
- An aborted seat no longer has its failure text placed as its report.
  Concurrent seats appending to one `plan.json` no longer lose each other's line.
- The MCP guard no longer polices hand-written agents (only `rf-*`).
- A seat's session pins its run when it starts: a newer run (or a nested
  fleet) reusing the same `rf-*` names no longer receives an older seat's
  report and outcome. A seat that yields again records a second outcome.
- Read-only seats can no longer call `role_fleet_plan` (it writes and prunes
  agent definitions; extension tools reach every seat whatever its grant).
- The cast question counts two council members on the same unresolved alias as
  one model.
- The publish workflow no longer checks the removed `PLUGIN_VERSION` constant.

### Changed — faster runs

- Seats start as soon as their own dependencies have reported instead of
  waiting for a whole wave: a seat is no longer held behind a slow seat it does
  not depend on. The dispatch text groups seats by what they wait on, and the
  plan tool's data carries each seat's `after` (roster names).
- The reviewer now waits on read-only specialists (security auditor, …) in its
  plan: it is the seat that checks their findings. The wave barrier used to hide
  the missing edge; a blind A/B on the per-seat dispatch caught the reviewer
  reviewing without the audit. A specialist dropped by the role cap no longer
  leaves a dangling dependency that failed plan validation.

- No `tool_call`/`tool_result` hook in the main session: their presence made the
  host refuse speculative task launch in every session with the plugin loaded.
  The MCP guard is installed only inside read-only seat sessions.
- The main model is told not to copy read-only reports (the plugin places them);
  it writes one only if the file is missing.
- A planner wave only for breadth wording; a bare "refactor X" is scout →
  implementer → tester ∥ reviewer.
- The single reviewer gating a change runs at medium effort; council, consul,
  review-only and security asks stay high.
- `advisor: true` only on the planner (and vision seats), not the implementer.
- The plan tool's text no longer repeats the cast the dispatch block carries.

### Internal

- `src/run-layout.ts` owns the run tree layout; `src/seats.ts` is the one seat
  registry (in memory, rebuilt from `plan.json` after a restart).
- The banner version is read from `package.json`.


## 1.6.0

### Added — read-only seats lose their MCP tools unless allowed

- Read-only seats (scout, planner, reviewer, council, consul) may call only the
  MCP tools the operator allowed by name. Everything else is refused before the
  call runs, with a reason the model can act on.
- Allowlist: `ROLE_FLEET_MCP_READONLY=mcp__codesearch_` (comma-separated tool
  prefixes). Empty means a read-only seat may call no MCP tool at all.
- Seats that may write (implementer, tester, docs) keep their MCP tools, and
  the main session keeps its own — the host's own consent screen governs those.
- The seat's brief states which MCP tools it may use, so it does not learn the
  rule by having a call refused.
- `/role-fleet doctor` prints the effective allowlist.

Why: an agent definition's `tools:` list governs built-ins only — MCP, extension
and custom tools stay additive — and every MCP tool is minted write-tier
(`mcp/tool-bridge.ts`) while subagents run with `tools.approvalMode: "yolo"`
(`task/executor.ts`). A seat the consent screen called read-only therefore held
every connected MCP tool, and a write-capable one would have run unattended.


## 1.5.3

### Added — auto-accept recommended cast for agents

- `--yes` / `-y` skips the cast confirmation dialog and keeps every planned seat
  (same as the recommended "Run all of them" preset).
- `role_fleet_plan` tool defaults `autoConfirm: true` so agent automation does
  not hang on a menu nobody answers; set `autoConfirm: false` to force the
  interactive dialog. Sub-session agents also auto-accept.


## 1.5.2

### Fixed — wave wait polling

- Dispatch instructions no longer tell the orchestrator to "wait for that wave"
  between batches. `wait` returns on the first settled seat, so a three-seat wave
  produced three identical "waiting on N of M jobs" panels in the transcript —
  one snapshot per call of the same running jobs. The host auto-delivers seat
  results; the wave boundary is which seats have reported. Instructions now
  state that results arrive on their own, forbid polling `wait` (call it only
  when completely blocked), and gate the next wave on every seat of the previous
  wave having delivered its result.

### Docs

- README trimmed to user-facing essentials (install, flags, models, runs, safety).



## 1.5.1

### Fixed — seat thinking / effort

- Dispatch batches now carry per-seat `effort` (`lo` | `med` | `hi`) derived from
  the seat's planned thinking level. Host precedence is caller `effort` >
  modelRoles `:suffix` > agent `thinking-level`; without the field, a
  `modelRoles.smol: …:auto` (or `:high`) suffix silently overrode scout `low`
  and other seat budgets. Live runs showed `rf-scout` settling at `:high`
  despite frontmatter `thinking-level: low`.
- Dispatch instructions require copying `effort` from the batch and no longer
  forbid it. `model` and `tools` remain forbidden on the task call.
- GitHub Actions publish the package on a GitHub Release (`Publish to npm`,
  same shape as `supa-magic/spm`): environment `npm` + `NPM_TOKEN`, no local
  npm login. CI also runs test + typecheck on `main` and pull requests.


## 1.5.0

Correctness and post-dispatch ownership.

### Fixed — classification

- `verifyAsk` re-tested the raw change vocabulary instead of `changesTree`, so a
  migration that named a test suite (`migrate the test suite to vitest`) lost
  both the implementer and the migration-runner. The runner now replaces the
  implementer and the tester is what the cap spends.
- Change vocabulary is split into unambiguous verbs (`fix`, `add`, `refactor`)
  and noun-ambiguous ones (`build`, `update`, `write`, `patch`, `change`). The
  ambiguous set mints the code cast only when nothing asks to look, so
  `profile the write path` and `compare the read path with the write path` no
  longer ship a shell-holding implementer for a measurement.
- Common change verbs outside the old closed list (`memoize`, `bump`, `enable`,
  `sort`, `log`, `optimi[sz]e`, …) now reach the code cast instead of one scout.
- A defect report about a product surface is a change ask: `the review page
  shows stale data` no longer becomes a read-only cast.
- A docs ask naming a code subject (`update the api docs`) keeps its docs seat
  instead of minting a code cast and dropping the seat at the cap. Code comments
  are no longer a docs ask.
- A reviewer with no implementer in the cast waits on the verifier, docs seat or
  scout instead of landing in wave 1 with an empty dependency.
- A role cap below two is raised to two: a cast needs a worker and an
  investigator, and `--max-roles 1` used to ship an implementer with no plan.

### Fixed — council models

- After plan-time resolution, council members that resolve to the same concrete
  model are reported in the plan instead of silently paying for the same review
  three times.
- Thinking-level variants (`provider/id` vs `provider/id:high`) collapse before
  the council is seated: they are one model, and the dropped spelling is named.

### Changed — post-dispatch record

- The `tool_result` hook now places a read-only seat's full report at its
  artifact path and appends the settled outcome — actual model, fallback, route,
  exit state, verdict, tokens, requests, duration — to `plan.json`.
- `/role-fleet report [run-id]` and `/role-fleet runs` read that record back.
- The command path dispatches inside the run pipeline: a host that refuses the
  message now reports "emitted but not dispatched" instead of success.
- The tool's `details` carry the dispatch batches as data: run id, verdict,
  notes, wave groups, roster names, artifacts and dependencies.

### Fixed — emission and pruning

- Agent ids are validated at the emit boundary, YAML scalars strip invalid
  control characters, and the emit pass never writes through a symlink.
- A renamed seat can no longer claim another seat's base filename.
- `pruneRunDirs` treats its keep count as at least one, so the current run's
  directory always survives.
- Overwriting or pruning a file owned by another run is reported when that run
  is recent enough to still be in flight (5 minutes), in both owner directions,
  instead of on every sequential run or only when the foreign run is newer.

### Fixed — live smoke pass

- The proposal merge counted the implementer and every council member as zero
  seats, so a full 4/4 build cast merged one specialist and silently shipped five
  roles. It now counts logical seats exactly like the static cap: a slice group
  and a council group each cost one, the consul costs one but is never dropped,
  and any exempt overrun gets the same `role cap N exceeded` note the static pass
  writes.
- An over-closed `--models (a))` list drove the spaced scanner's depth negative,
  made it consume the rest of the line, and echoed the whole task back as a
  malformed model list. The scanner stops at `depth <= 0`, so the error names the
  bad token and every task word stays task text.
- `expandHome` and `baseModel` live in `core.ts` instead of `flags.ts` importing
  the orchestration graph for a path helper; the tool parameter type reuses
  `Flags`, and the write-only `emitted`/`dispatched` result fields are gone.

## 1.4.0

Cast decisions, the run tree's safety, the council's authority, and a shell where
a seat has to run something.

### Fixed — the cast read a vocabulary only half the pipeline knew

- `wantsCode` and the analysis veto were two different keyword lists in one file,
  so `add`, `build`, `create`, `write`, `port`, `update` and `improve` asked for a
  change and got a cast of one investigator: `add a dark mode toggle` shipped
  `[scout]`. Every classification now reads one table (`VOCAB` in `src/core.ts`),
  verbs are kept apart from nouns, and each entry is `\b`-delimited at both ends.
- `explore the api surface`, `investigate the bug in the payment module`,
  `analyse the module structure` and `explain how the api module works` minted an
  implementer and a tester, because a *subject* noun drove the cast. A look-verb
  now thins the builder seats out.
- `\bcheck` matched "checkbox", so `improve the checkbox styling` bought a review
  seat on the strength of that word.
- The word-boundary rule was applied to only part of the vocabulary: `test\w*`
  still matched "testimonials" and `check\w*` "checkerboard", so a content task
  could mint a verifier and a UI task a reviewer. Both are tight to their real
  inflections now.
- `compare`, `library` and `version` had been dropped from the research wording,
  so `compare the two libraries` lost the read-only research seat it used to get.
  The nouns are safe to carry now that the migration veto reads verbs only.
- `design` counted as a build verb, so `design a threat model` and
  `audit the design of the login flow` kept a write-granted seat on a look-only
  task, and a designer joined casts that had just promised no source changes.
- `update the readme`, `write the changelog` and `document the api` shipped one
  investigator: the docs seat was reachable only through a code or a research
  shape. A documentation ask with no code subject is now its own cast
  (`[scout, docs-updater]`), and that seat writes the document.
- `test the payment checkout flow` minted an implementer. An ask to run checks
  with no change verb is now `[scout, tester]`.
- A migration named without a code verb (`upgrade the deps`, `move off webpack`)
  is a change; an investigation *of* one (`evaluate migrating off lodash`,
  `research migration options`) is not, and mints no writer.
- `--review-only` reported "role cap left no implementer" for a cap that never bit.
  The note now fires only when the cap actually dropped the seat, and the
  analysis-only guarantee is stated from the cast that ships.

### Fixed — the dynamic tier fires where it is needed

- `shouldPropose` was keyed on `analysisOnly`, so a degenerate cast — one
  investigator, which also carries `analysisOnly: false` — could never be improved
  by it: those tasks, and every task phrased in another language, had no second
  chance. The trigger is now the cast (`isDegenerateCast`), alongside the
  thin-analysis case that already existed.

### Fixed — a paid call no longer rides under `--dry-run`

- The specialist tier ran on `--dry-run`, which promises a cast without spending
  anything. It is skipped now, and the plan records that it was. On a host with no
  side turns the capability note wins instead, because "skipped, it is a paid
  model call" would claim a saving that host could never have offered.

### Changed — the builder seats hold a shell

- The tester's acceptance is "exact commands run" and the implementer's is
  "focused check executed and its real output reported", and neither was
  satisfiable: a definition's `tools` list *replaces* a subagent's toolset, and
  the grants held no execution tool. Both seats now carry `bash`, as does the
  migration runner (the implementer seat under another id) and any proposed
  writer. The designer and the docs seat keep `edit`/`write` without it.
- `grantsWrite` is the one rule for "can this seat change the tree?" — `edit`,
  `write` or `bash` — so the analysis-only guarantee, the proposal merge, the
  consent screen's authority line, the shell-capable proposal refused on a plan
  that promised no writes, and the grant note on the emitted definition all
  answer the same way. The consent screen gains a third authority phrase (*can
  change the code and run commands*) and the cast question counts shells
  separately from editors, because a shell is the wider grant and that is what a
  reader is approving.

### Changed — the read-only grants match the host's read tier

- A definition's `tools` **replaces** a subagent's toolset rather than extending
  it, and the host calls an agent read-only exactly when every declared tool is in
  its own read tier. The read grant was `read`, `grep`, `glob`, so the seats asked
  to locate where a task touches had no behaviour search and no structural search.
  They now carry `find` and `ast_grep` too, and the write grant is derived from
  the read one instead of being a second literal list.
- The host's read tier is still wider than this grant (`web_search`, `todo`,
  `ask`, the memory tools), and the seats that have to *run* something now hold a
  shell rather than relying on the read tier. What is still open is the
  researcher flavor of the docs seat: its brief says "every claim backed by a
  primary source" and it can only read the local repo, because `web_search` was
  not granted with it.

### Changed — the council holds no write authority

- Council members and the consul were granted `write` — repo-wide and
  path-unrestricted — so that their reports reached the filesystem. The channel
  already existed: `renderDispatch` names every read-only seat's artifact path and
  tells the orchestrator to write each settled `report` there before the next wave.
  The grant is gone; the consent screen names three authority phrases — a shell
  (`can change the code and run commands`), an editor (`can change the code`), or
  `read-only` — and no seat this plugin emits holds a write that was not asked
  for.

### Fixed — a file the plugin does not own is not overwritten

- `emitAgents` wrote `rf-<seat>.md` unconditionally, destroying a hand-written
  agent — which the next prune then *deleted*, since by then it carried the marker
  and matched its filename. Emit and prune now share one predicate
  (`oursToReplace`): a file that is hand-written, hand-renamed, or owned by a newer
  run is left alone, and the seat is emitted as `rf-<seat>-2.md` with a note naming
  both.

### Added

- `plan.json` in each run directory: the cast, its models, its waves and its notes,
  written where the artifacts already are, so a finished run can be audited after
  the session that produced it is gone.
- `test/classification.test.ts`: the decision layer's regression net — ~35
  task→cast rows, each naming the defect it exists for, plus the vocabulary's two
  structural rules.
- `--slices N` (and the tool's `slices`): fan the implementation out across N
  writer seats in one parallel wave. Everything downstream waits on all of them,
  the fan-out costs the implementer's single seat against `--max-roles`, the
  dispatch names each seat so the orchestrator can give it its own files, and a
  proposed writer is refused on a fanned-out plan.

### Documented

- The concurrent-fleet limit now names both consequences: a newer run's prune
  deletes the earlier in-flight run's seats wherever its own narrower cast does not
  replace them.
- The shared model-observation baseline names its real failure: with overlapping
  runs a seat is compared against the *other* run's pin, so the line can report a
  "model changed" that did not happen.

## 1.3.6

- Reconstructed from `a93e186`: closed thirteen defects found in a three-seat audit.

## 1.3.5

- Reconstructed from `c05103a`: fixed analysis-only misclassification in the
  dynamic tier. Tagged `v1.3.5`.

## 1.3.4

- Reconstructed from `f024db2` and `7c5b388`: the review council, `--consul`,
  `--review-only` and model observation, with the run artifact tree bounded to ten
  directories. Tagged `v1.3.4`.

## 1.0.0 – 1.3.3

- Reconstructed from `0fd7281`, `ff758de`, `9c198e8` and `a378037`: the initial
  release, harder frontmatter against untrusted scalar values, and the republish
  under the `@supa-magic/` scope.