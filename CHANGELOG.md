# Changelog

Entries before 1.4.0 are reconstructed from the commit record and the tags that
exist (`v1.3.4`, `v1.3.5`); a release is cut from `package.json#version`.


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