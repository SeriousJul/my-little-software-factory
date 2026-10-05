# The quality gate verification

Status: the gate's commands and the pre-push hook were measured on the branch
that added them, on 2026-10-05, and the hook was then installed in this checkout
and exercised by the real push that landed the work. The hook's four ref cases,
its refusal on a lint failure, and its git-level wiring were each run, and the run
found two defects in the hook itself, both fixed before any push. The rules on
[the quality gate page](../development/quality-gate.md) are not machine-checked:
they hold a document's claim, a probe's reproducibility, and a report's numbers,
and only a review measures those. A first round of that review ran on the change
set itself and is recorded below; it is self-review, and the row that says so
stands incomplete. The findings the round and the flake investigation produced are
filed as issues #301, #302, #303, and #304, and the rework round of
[pull request #310](https://github.com/SeriousJul/my-little-software-factory/pull/310)
filed two more from its own gate runs:
[#311](https://github.com/SeriousJul/my-little-software-factory/issues/311) and
[#312](https://github.com/SeriousJul/my-little-software-factory/issues/312).

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it is
not silently dropped.

See [ADR 0105](../adr/0105-the-push-gate-runs-the-three-checks-on-the-merged-tree-and-a-hook-owns-the-two-cheap-ones.md)
for the decision and [the quality gate](../development/quality-gate.md) for the
rules.

## What it was measured on

| Piece | Value |
| --- | --- |
| Hook | `scripts/git-hooks/pre-push`, bash, mode 0755 |
| git | 2.55.0 |
| Runtime | Bun 1.4.2, Linux x86_64 |
| Checks the hook runs | `bun run lint` (Biome 2.5.x, 296 files) and `bun run typecheck` (`tsc`, `strict`) |
| Suite at the measured commit | 2,948 tests over 133 files. Three full runs: 2,948 pass / 0 fail at 40.93 s (load 8.45 before, 6.28 after), 2,947 pass / 1 fail at 40.11 s (load 10.34 before, 6.72 after), and 2,948 pass / 0 fail at 40.02 s (load 4.57 before, 3.73 after). The `expect()` count moves between runs (15,271 to 16,632) on the timing-read assertions the records already name |
| Machine state | No other `bun test` process was running on this machine during any of the three runs |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The inner loop is cheap enough to run after every edit | Each command timed on this tree: `bun run lint` 0.25 s over 296 files, `bun run typecheck` 2.8 s, `bun test test/handoff-dispatch.test.ts` 1.7 s for 124 tests, `bun run test:changed` 0.016 s with nothing changed against `origin/main` | Passed. The loop costs about 5 seconds against a 40.9-second full suite |
| The push gate's commands pass on the tree the change lands on | One gate run on this branch: `bun run lint` clean over 296 files, `bun run typecheck` clean, `bun run docs:build` complete in 1.58 s, `bun run test` 2,948 pass / 0 fail across 133 files | Passed, one run each |
| The hook refuses a push whose branch is behind its remote-tracking ref | A local ref `tmp-hook-behind` at `origin/main~3` with `refs/remotes/origin/tmp-hook-behind` at `origin/main`, pushed through the hook: `tmp-hook-behind is 3 commit(s) behind refs/remotes/origin/tmp-hook-behind`, exit 1 | Passed |
| The hook passes a ref that is level with, or ahead of, its remote-tracking ref | The same rig with the two refs level: exit 0. Then with the remote-tracking ref one commit behind the local ref: exit 0 | Passed |
| The hook says when the behind check has nothing to read | The same rig with no `refs/remotes/origin/<branch>`: `tmp-hook-behind names no refs/remotes/origin/tmp-hook-behind, so the behind check runs on nothing`, exit 0 | Passed |
| A deleted ref takes no behind check | A stdin line whose local oid is all zeros: skipped, exit 0 | Passed |
| The hook refuses on a lint failure, and names the check | Probe: `src/tmp-hook-lint-probe.ts` with an unsorted import group and an unused binding, then a push of `main`: `pre-push: bun run lint failed` and the refusal, exit 1. The probe file was removed after the run | Passed |
| The hook is reached by a real `git push`, not only by hand | `git config core.hooksPath scripts/git-hooks`, then `git push --dry-run . HEAD:refs/heads/tmp-hook-wiring`: the hook's three lines appear in the push output, exit 0. `core.hooksPath` was unset again after the run | Passed |
| The hook runs the checks on a tree it did not change | Every run above ran from this checkout's root through `git rev-parse --show-toplevel` | Passed |

| The module map is held to the tree | `test/shape-doc-paths.test.ts`: green, 80 path claims read from `docs/agents/shape.md`. Probe A, `src/config-write.ts` renamed to `src/config-write-back.ts` in the map: red with `src/config-write-back.ts (entry src/config-write-back.ts) names no file or directory`. Probe B, `batch.ts` renamed to `chunker.ts` inside the `src/state/` entry: red with `chunker.ts (entry src/state/) stands nowhere under src/state/`. Both probes were run on the real file and the file was restored byte-identical |
| A probe that matches nothing is caught | The first probe written for the check above renamed `src/state/store.ts`, a path the map never prints, so its "red" was the check passing on an untouched document. Both probes now assert `expect(moved).not.toBe(doc)`, and the reason stands in the check's header |
| A domain value export nobody reads is refused | `test/domain-export-architecture.test.ts` went red first with four names: `GROUPED_SECTIONS` in `src/domain/grouping.ts`, and `completionTraceOrder`, `ISSUE_REFERENCES_ATTRIBUTE`, `HEAD_BRANCH_ATTRIBUTE` in `src/domain/ticket.ts`. Each is used inside its own module and exported for no reader, so each was fixed by dropping the `export`, and the check is green on that tree |
| The alias shape the #223 review found is refused, and a reader does not save it | Probe on `src/domain/top-up.ts`: `export const freshWorkHoldAlias = freshWorkHold;` turns two cases red, the value-export case and the alias case, the second naming both sides |
| The unread-type ratchet bites in both directions | Probe: `export interface ABrandNewUnreadType { readonly a: 1 }` in `src/domain/top-up.ts` turns the ratchet case red with that one name added to a 14-name baseline. Probe: deleting one baseline name while the type stays unread turns the same case red. The list can only shrink by the type becoming read |
| The wider rule was measured before it was chosen | 40 exports under `src/domain/` have no importer under `src/`: 22 are read by a test import, 18 by nothing at all, and of those 18, 14 are types and 4 are values. The strict form would have spent this change on 40 renames and broken the doc drift check's read of `AUTOMATIC_HOLD_LINES`, so the check took the two narrow rules and the ratchet. The count is recorded here, not as a pass |

## The one red run, recorded as a load flake

The second of the three full runs reported 1 fail out of 2,948 at load average
10.34, and its output was piped through a filter, so the failing case was not
captured. The run before it and the run after it, at load 8.45 and 4.57, each
reported 2,948 pass / 0 fail. The four files with a recorded flake history
(`test/consultation-frame.test.ts`, `test/repository-select-panel.test.ts`,
`test/repo-init-stub.test.ts`, and `test/ticket-scroll-frame.test.ts`) were then
run together alone: 90 pass / 0 fail in 28.18 s. No production line moves in this
change, and no test file changed in it.

This is recorded as a load flake with a missing name, not as a pass: the failing
case is not identified, and the next run that goes red at load names it. The
same shape on the remote was investigated on 2026-10-05 below and filed as
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302).

## The named red cases on the same tree

A later full run on this tree (`48493de3`, load 6.35 before, no other `bun test`
process) went red twice in 39.91 s, and this time the output was kept, so both
cases are named:

| Case | Time | Alone |
| --- | --- | --- |
| `test/repository-select-panel.test.ts` - a failed act stops the queue, and names the repository on the line | 10247.03 ms, which is `FRAME_DEADLINE_MS` at its non-CI 10000 | 14 pass / 0 fail in 12.32 s with the row below |
| `test/screenshot-drift.test.ts` - the guide screenshots, inside `captureScreens` | 796.61 ms | same run, same result |

Each fails in the full suite and passes alone, so each is a load flake under
[the triage rule](../../AGENTS.md), not a regression: the tree moved only markdown
since the green run above. The first case is the frame-deadline class of
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302)
at the local deadline, and the case name is recorded on that issue.

The screenshot case came back on the next push gate, at `b3b5fc38`, load 10.42
before the run, 1282.69 ms, with the same miss text: `the cursor never reached a
row matching "Rank tickets by priori" within 3 "j" steps`, and the dump showed the
cursor on a Group header one step above the row it aims at. That is a fixed 150 ms
sleep in `stepUntilRow` in `scripts/screenshot-fixture.ts`, not a pixel drift, and
it is filed as
[issue #303](https://github.com/SeriousJul/my-little-software-factory/issues/303)
with the three occurrences and what a fix has to hold.

The push gate for the review round ran the full suite a third time on the same
head, at load 11.13, and went red twice again in 41.51 s:

| Case | Time | Alone |
| --- | --- | --- |
| `test/repo-init-stub.test.ts` - the TUI walk of the init (ADR 0075) | 11452.92 ms, the local 10000 ms frame deadline | 8 pass / 0 fail in 11.67 s with the row below, at load 10.39 |
| `test/screenshot-drift.test.ts` - the guide screenshots | 1074.95 ms | same run |

So the full suite did not go green on the head the review round measured, and the
result is recorded as it stands: two named cases, each red in the full suite and
green alone, at load 11.13 after back-to-back suites in one session, with
`test/repo-init-stub.test.ts` already carrying a recorded flake history. The first
is this issue's class in a new file, named on
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302);
the second is #303. No check in this change set is claimed as passing on a run
that did not pass.

A fourth run, at load 11.81, went red once more, on
`test/repository-select-panel.test.ts` at 10180.28 ms. Four consecutive full runs
at load 6.35, 10.42, 11.13, and 11.81 each went red on a frame-deadline case, while
the three runs recorded above as green all ran `bun test --parallel=4` on a 32-core
machine, and `bun run test` passes no count and so spreads 137 files over about one
worker per core. The class is therefore reachable on demand at the unit layer, and
that is recorded on
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302)
as the reproduction its fix needs first.

## Two defects the run found, and fixed

Both came from driving the hook through real refs instead of reading it.

- **The checks ate the ref list.** The first version ran `bun run lint` and
  `bun run typecheck` before the loop that read git's stdin lines. Biome and `tsc`
  read stdin, so the ref list was gone by the time the behind check ran, and a
  branch three commits behind pushed clean with no word about it. The refs are now
  read into a list before the checks run, and each check takes `</dev/null`.
- **The behind count was inverted.** `git rev-list --count <upstream>..<local>`
  counts the commits the local ref has that the remote-tracking ref does not, so
  the check measured ahead, not behind, and never fired. It is now
  `<local>..<upstream>`, and the level, ahead, and behind cases above are each
  run.

## The frame-deadline investigation, on the same date

The remote gate is not read as a rule (AGENTS.md, "Remote gates"); a CI flakiness
investigation is the one case that reads it, and every run read is named here.

Runs read for their failure lines: 37232190458, 37216619811, 37192986722,
37159675095, 37153742528, 37150434813, plus the CI run list for the last 200 runs
of `CI`. Four of the six failed a frame wait between 20155 ms and 21088 ms, which
is `FRAME_DEADLINE_MS` (20000 on CI) in `test/app-harness.ts`, not the runner's
60000 ms budget. The harness's own dump came back with the screen fully painted
and the detail's scroll thumb on the first row of its track.

At the unit layer, in this checkout:

| Run | Result |
| --- | --- |
| The three named files alone | 95 pass / 0 fail in 30.76 s, load 9.61 before |
| Three full suites in CI shape, `CI=1 bun test --parallel=4 --isolate --timeout=60000` | 3 x 2974 pass / 0 fail, load 7.58 to 9.74 before each run |
| Five runs of the three files pinned to two CPUs, `taskset -c 0-1 env CI=1 bun test --parallel=2 --isolate --timeout=60000` | 0 fail in five runs |

Two measurements came out of temporary probes, both deleted after the run, and
both stated here rather than shipped as tests:

- **A resting plane emits no frames.** A listener on the renderer's `frame` event
  counted **0** events over 1000 ms with the app booted and idle. The renderer
  paints on invalidation, not on a free-running loop.
- **The scroll restore's geometry is already real when its effect runs.** The
  round-trip test printed `slot.top=30 box.scrollHeight=52 viewport=22` at the
  restore, and `box.scrollTop=30` at the save. The save side is clean; the
  restore waits for a render pass anyway.

Two probes of the ordering that the failure needs both stayed green, because a
later pass still arrived: deferring the registration by one macrotask, and the
same round trip with the app's loops stopped and `renderer.requestRender`
neutered. The ordering flip is not pinned, so no fix was shipped on this
evidence. The finding, the mechanism, and what a fix has to hold are in
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302).

### What the failures have in common

Across the five local full runs and the six remote runs read, the case names are
not the same. Four things are:

| Constant | Evidence |
| --- | --- |
| The wait | Every deadline miss ends in `awaitFrame` or `awaitNewKeyHandler` in `test/app-harness.ts`, against `FRAME_DEADLINE_MS`: 10000 ms here, 20000 ms on CI. Local misses land at 10180 to 11453 ms, remote ones at 20155 to 21088 ms |
| The file set | Only tests that boot the real renderer and the real state database. No unit file has gone red |
| The exposure | The cases that fail hold the most waits in one test: 8 `awaitFrame` waits in `test/repository-select-panel.test.ts` - a failed act stops the queue, about 9 in `test/repo-init-stub.test.ts` - the TUI walk of the init, about 16 in `test/main-view-frame.test.ts` - the scroll round trip. Which file loses one is which worker got starved that run |
| Three mechanisms, not one | #302 misses a deadline (10000 ms local, 20000 ms CI). #303 fails at 796 to 1282 ms on a fixed `sleep(150)` in `stepUntilRow`. A third, filed as [issue #304](https://github.com/SeriousJul/my-little-software-factory/issues/304), fails fast at 360 to 425 ms because `settle` reads a stable frame as a finished transition: `test/live-view.test.ts` asserted on a `settle` result and caught the Live view still open. #303 is the most frequent local failure, so fixing it alone would quiet the noise while #302 and #304 stand |

A final full run at `50b4a51f`, load 6.66 before, went red three times in 40.39 s:
the screenshot fixture at 1244.35 ms (#303), `test/live-view.test.ts` at 360.95 ms
(#304), and `test/repository-select-panel.test.ts` - Esc closes the list and keeps
the base frame at 10379.11 ms, which is #302's class at the local deadline and the
same case name CI hit at 20155 ms in run 37159675095. Each file passes alone:
`test/live-view.test.ts` gives 20 pass / 0 fail in 10.10 s.

## The review round on the gate itself

The rules on [the quality gate page](../development/quality-gate.md) are not
machine-checked, so a review round is where they are measured. This round measured
the change set that added them, on the head `b3b5fc38`, and followed the
reviewer's floor the page states: the three checks on the merged tree, every probe
re-run, and the score naming the head. No remote run was read.

### The probes, re-run at this head

| Probe | Result at `b3b5fc38` |
| --- | --- |
| shape A, `src/config-write.ts` to `src/config-write-back.ts` in the map | red with `src/config-write-back.ts (entry src/config-write-back.ts) names no file or directory` |
| shape B, `batch.ts` to `chunker.ts` in the `src/state/` entry | red with `chunker.ts (entry src/state/ stands nowhere under src/state/` |
| domain A, `export const anUnreadRule = () => true;` in `src/domain/top-up.ts` | 1 case red, that one name |
| domain B, `export const freshWorkHoldAlias = freshWorkHold;` | 2 cases red, the alias case names both sides |
| domain C, `export interface ABrandNewUnreadType` | 1 case red, that one name |

Each file was restored after its probe, and `git status` came back clean.

### The costs, re-measured at this head

lint 175 ms, 178 ms, 181 ms over 302 files; typecheck 2.74 s and 2.78 s;
`bun run docs:build` 1.75 s; `bun run test` 40.82 s; a scoped static check 0.16 s;
`bun test test/action-bar.test.ts` 13.8 s for 22 tests; `bun test
test/consultation-frame.test.ts` 21.9 s for 58 tests.

### What the round found

- **One stale number, fixed in the round.** The inner-loop table stated `0.25 s
  over 296 files` for lint and `1.7 s for 124 tests` for a scoped run. Neither was
  a measurement of this tree: lint costs 0.18 s over 302 files, and no scoped run
  of that shape costs 1.7 s. The table now carries the numbers above, and the
  sentence that followed them, "the whole loop costs about 5 seconds", is replaced
  by what the two parts actually cost. The hook's own comment carried the same
  `0.25 s` and was corrected with it.
- **The rename sweep is clean.** The four domain values un-exported at `724dc3ec`
  appear nowhere in `docs/` or `test/` as exports; the only mention is this
  record's account of the fix.
- **The determinism rule holds for the new checks.** Both read files and never a
  clock, and neither touches the desktop.
- **Noted, not changed.** ADR 0105's title names "the three checks" while the gate
  runs `bun run docs:build` conditionally. The ADR body states the conditional, so
  the title names the three that always run.

### What this round could not measure

| Item | State |
| --- | --- |
| Whether the rules change behaviour on a pull request that did not come from this session | Incomplete. Every commit in this change set was written by the same agent that wrote the rules, so the round is self-review, and it is recorded as such |
| The screen-reader path, the live terminal walk, and the theme inheritance inside a real herdr | Open, unchanged, as [the shared control record](./shared-controls.md) states |

## Issue #301: the 14 unread domain types (2026-10-05)

The 14 names this record held as "held still, not cleaned" are answered at
`8bd17a4d`, and `UNREAD_TYPE_BASELINE` in
`test/domain-export-architecture.test.ts` stands empty. Each name took one of
the three answers [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301)
states.

| Name | Answer | Where the reader stands |
| --- | --- | --- |
| `agent.ts :: AgentStatus` | reached through a value | `normalizeAgentStatus` answers it to `src/observation.ts` and `src/components/app.ts`; `test/agent-facts.test.ts` pins the set as closed |
| `attempt-hold.ts :: UnreachedOutcome` | module-private | the `export` is gone: it types one field of `AttemptHoldFacts`, and `src/state/handoff.ts` and `src/state/plane-action.ts` each hand their own literal |
| `decision-facts.ts :: DecisionFacts` | reached through a value | `decisionFacts` answers it to `src/components/app.ts`; `test/decision-facts.test.ts` pins its three fields |
| `decision-facts.ts :: DecisionOffer` | reached through a value | the row of the record above; the same test pins the two kinds |
| `section-facts.ts :: SectionFacts` | reached through a value | `sectionFacts` answers it to `src/components/app.ts` and the gallery; `test/section-facts.test.ts` pins the three count groups |
| `ticket.ts :: TicketIgnoreFacts` | reached through a value | `automaticStartBlocked` reads it in `src/observation.ts` and `flagWithholdsRow` in `src/state/ticket-work-cycle.ts` and `src/components/app.ts`; `test/domain.test.ts` now tests the gate on its own four facts |
| `top-up.ts :: AutomaticAddFacts` | reached through a value | `automaticAddsHold` reads it in `src/observation.ts`; `test/top-up.test.ts` states the record |
| `top-up.ts :: AutomaticBareHold` | reached through a value | one member of the `AutomaticHold` the walk holds; the same test states a bare hold names no row |
| `top-up.ts :: AutomaticHoldReason` | reached through a value | the key of `AUTOMATIC_HOLD_LINES` and the `reason` of every hold; the same suite pins that the words and the lines are one set |
| `top-up.ts :: AutomaticRowHold` | reached through a value | one member of the same union, answered by `continuationHold`; the same test pins the row identity it carries |
| `top-up.ts :: AutomaticRowHoldReason` | reached through a value | the `reason` of that member and the words of `AUTOMATIC_ROW_HOLD_REASONS`; `test/top-up.test.ts` - "the pace gate answers each row-hold word, and no word outside the set" - pins the set where the only writer of it answers: the factory's staging and the operator's staging answer the two words, the two answers are the whole set, and each word has its own line |
| `top-up.ts :: ContinuationRowFacts` | reached through a value | the rows `continuationHold` reads in `src/observation.ts`; the same test states the three facts |
| `top-up.ts :: OpenTicketRowGate` | reached through a value | `openTicketRowGate` answers it to `src/observation.ts`; the same test pins that the task type is readable only on the branch that stands |
| `top-up.ts :: OpenTicketWaitsFacts` | reached through a value | `openTicketWaitsHold` reads it in `src/observation.ts`; the same test states the three waits |

The counts the check's ratchet moves, read by the same walk the check runs
(`exportsOf`, `importsOf`, `namesModule`) over every file under `src/domain/`, by
a scratch script under `/tmp` that was deleted after the run:

| Count | At `f3b11e8b`, before | At `8bd17a4d`, after |
| --- | --- | --- |
| exports under `src/domain/` | 126 | 125 |
| of them with no importer under `src/` | 42 | 41 |
| of those, read by a test import | 28 | 41 |
| of those, read by nothing at all | 14, all of them types | 0 |

The rework round below moved no domain export, and the same walk re-run on that
tree answers the same: 125 exports, 41 with no importer under `src/`, 41 read by
a test import, 0 read by nothing at all.

### The probes, re-run at `8bd17a4d`

| Probe | Result |
| --- | --- |
| domain A, `export const anUnreadRule = () => true;` in `src/domain/top-up.ts` | 1 case red, that one name |
| domain B, `export const freshWorkHoldAlias = freshWorkHold;` | 2 cases red, the alias case names both sides |
| domain C, `export interface ABrandNewUnreadType` | 1 case red, that one name against a list that stands empty |
| domain D, `{ name: "src/domain/top-up.ts :: AutomaticHold (interface)", reason: "the walk holds it" }` written into the empty list | 1 case red: the list side holds a name that has readers and the unread side holds nothing |
| domain E, probe C's type plus `{ name: "src/domain/top-up.ts :: ABrandNewUnreadType (interface)", reason: "" }` in the list | the ratchet case green on that name, and "every baseline entry states the reason it stays exported" red with that one name |

Each file was restored after its probe and `git status` came back clean. Probe D
is new to this round: with the list empty the "stale entry" direction has no
entry to delete, so it is probed by writing in a name that has readers. The
three probes recorded above were re-run unchanged. Probe E joined the rework
round below, and all five were re-run there on the tree that merges.

### The review round on pull request #308 (2026-10-05)

The review scored the branch 86 / 100, passed the specification check and the
quality check, and named six required changes. Each was made, and each is
recorded with what measures it:

| Finding | What the rework did |
| --- | --- |
| `AutomaticBareHold` and `AutomaticRowHold` were not greppable in the module map | `docs/agents/shape.md` names all three members of `AutomaticHold` and what each carries, so a reader who greps either name lands on the map entry |
| `AutomaticRowHoldReason` pointed at no assertion | A new case pins the word set at the gate that writes it, and the table row above names that case |
| Six `Object.keys` assertions pinned field declaration order | Each now sorts the read keys, the way `test/config.test.ts` and `test/theme-resolver.test.ts` do: `test/decision-facts.test.ts`, `test/domain.test.ts`, `test/section-facts.test.ts` (four), and `test/top-up.test.ts` (two) |
| Duplicated assertions | `test/agent-facts.test.ts` keeps the closed-set annotation and the no-two-words-answer-alike check and drops the loop over the five words and the second `meditating` fallback, both already pinned by the test above. `test/decision-facts.test.ts` keeps the record-shape pin and the closed pair of offer kinds, and drops the handoff and merge offers the two tests above already pin |
| A row-hold test threw where an `expect` belongs | The row-hold case and the open-ticket row-gate case now compare the whole answer with `toEqual`, so a regression prints a diff instead of an error |
| The header said a name may be written into the list "with its reason", and nothing read a reason | The baseline entry is now `{ name, reason }`, and a new case refuses an entry whose reason is blank. The reason is a field the check reads, not a convention a reviewer enforces. Probe E measures it |

What the round did not change is the ratchet's satisfaction condition the review
named as weak: a name counts as read when a test file imports it, which a bare
annotation satisfies. Biome's `noUnusedImports` refuses the degenerate import,
and the round above replaced the one annotation-only row (`AutomaticRowHoldReason`)
with an assertion. Whether a name named at the seam is dead stays unmeasured, as
the row below states.

The five domain probes were re-run on this tree, each file restored after its
probe and `git status` clean: A, 1 case red with that one value name; B, 2 cases
red, the alias case names both sides; C, 1 case red with that one type name; D, 1
case red on the list side; E, the ratchet green and the reason case red with that
one name.

The gate on this tree, level with `origin/main` at `af085a2e`:

| Check | Result |
| --- | --- |
| `bun run lint` | clean over 304 files (128 ms) |
| `bun run typecheck` | clean (2.92 s) |
| `bun run docs:build` | complete in 1.59 s, because the round touches `docs/` |
| `bun run test` | 3,020 pass / 0 fail across 138 files in 40.18 s (16,895 `expect()` calls), at load average 8.62 before the run and 4.74 after. No other `bun test` process ran on this machine: the only match was the gate's own command line |

### What this round did not measure

| Item | State |
| --- | --- |
| Whether any of the 13 types now named at the seam is dead | Not measured, and the check still cannot see it: a caller holds the shape through the value, so a test writing the name down is not proof of life. What was measured is that each of the 13 has a call site that reads the value carrying it, and the module map names that call site |
| The stated-exemption mechanism the issue sketches for the third answer | Not built as a separate mechanism. No name needed it - 13 are read through a value and one is private - so the baseline stays the only place a name is held. The rework round below settled what an entry holds: `{ name, reason }`, with the reason read by a case that refuses a blank one, so the exemption is written where the check can enforce it |
| The live terminal walk, the screen-reader path, and the theme inheritance in a real herdr | Open, unchanged, as [the shared control record](./shared-controls.md) states. The only production line that moved on the branch is one `export` keyword
in `src/domain/attempt-hold.ts`; the rework round moved none |

## Issue #302: the detail's scroll restore waits for a pass the plane does not owe (2026-10-05, the fix)

The mechanism [the section above](#the-frame-deadline-investigation-on-the-same-date)
measured is answered on this branch. The restore no longer depends on a render
pass, and the contract now has a test that fails when it does.

### The pin, and the reproduction it is

`withholdFrameEvents` in `test/app-harness.ts` takes the renderer's `frame`
event away from every surface and hands back the key that puts it back. The
passes the app's own updates cause still paint, and the harness's waits read the
painted buffer, so the screen keeps working; what is gone is any way for a
surface to be woken by a pass.

The hold also proves its own reach. The renderer announces a pass only behind its
own `listenerCount("frame") > 0` guard, so a fixed restore that registers no
listener leaves the event unannounced, and a hold that swallowed nothing would
look exactly like one that worked. The harness keeps one listener of its own to
hold that guard open, counts the announcements it intercepts, and counts the ones
that reach its listener anyway; the key refuses to hand the event back on an
empty count, and refuses a hold that leaked.

A new case, `test/main-view-frame.test.ts` - "the Ticket detail resumes at its
offset while no surface can be woken by a frame" - walks the same cross-section
round trip the existing scroll test walks, with the event held back for the whole
round trip. One walk helper takes the withhold flag, so the two cases cannot
drift apart, and the three probes below stand in its header as steps a reviewer
can re-run.

| State | Result |
| --- | --- |
| Probe A, the retired wait put back: `restore();` replaced by `renderer.once("frame", restore);` in the restore effect | 1 record red at 11031.14 ms, the local 10000 ms `FRAME_DEADLINE_MS`, with the other 24 in the file green. The harness's dump came back fully painted with the detail at its top and its thumb on the first row of its track: the same shape the four remote misses printed at 20155 to 21088 ms. The older round-trip case stays green, which is why only the withheld case pins the contract |
| The same case with the fix | Green at 1252.89 ms, with the round-trip case beside it at 1284.32 ms |
| Probe B, the harness's own `frame` listener deleted | 1 record red at 1018.41 ms on the hold's swallowed-count line, 24 green: with no listener of the harness's own the renderer announces nothing, so the hold proves nothing and says so |
| Probe C, the wrapper handing the event to the real `emit` | 1 record red at 1021.80 ms on the hold's leaked-count line, 24 green: the witness was woken by a pass, so the hold did not hold |

Each probe ran on the tree that landed as `d1b55a00`, with `bun test
test/main-view-frame.test.ts --isolate --timeout=30000`, and was reverted; a
`diff` against a copy taken before the probe showed both files byte-identical
afterwards.

| Scoped run | Result |
| --- | --- |
| `test/main-view-frame.test.ts`, `test/ticket-scroll-frame.test.ts`, `test/ticket-detail.test.ts` | 42 pass / 0 fail in 12.21 s |
| `test/consultation-frame.test.ts`, `test/repository-select-panel.test.ts` | 71 pass / 0 fail in 23.56 s |

These are scoped runs, not the full suite. What the full suite adds is recorded in
the two tables below.

### What the fix holds

`src/components/ticket-detail.ts` runs the restore in the effect's own turn
whenever the box already answers its content height and viewport, which is what
it does at the moment the effect runs after a cross back. Only when the box
answers no size does the pane ask for the pass that lays it out, and it asks by
calling `renderer.requestRender()` itself rather than waiting for one nobody
owes. The ask is bounded to one per effect run: a box that never lays out cannot
spin the renderer on every pass, which an unbounded "ask while `maxScrollOf`
answers zero" would do on a detail whose body fits the viewport.

| Choice the issue left open | What this branch chose |
| --- | --- |
| "ask for the next pass only when the box does not answer a non-zero `maxScrollOf`" | The ask is keyed on the box answering no size at all (`scrollHeight === 0` or `viewport.height === 0`), not on `maxScrollOf` answering zero. A body that fits its viewport answers `maxScrollOf` 0 for the rest of its life, and asking again on each pass would repaint forever; for that body the clamp to 0 is the right answer, so the pane takes it on the spot |
| How to hold "no later repaint available" in a test | The frame event is withheld rather than the render loop stopped. Stopping the loop (`renderer.pause()`) leaves the painted buffer stale, so the assertion could only read the scroll box's own `scrollTop` and could not say what the operator sees. With the event withheld the screen is still the fact under test, and a restore that waits for a pass still cannot run |

Both branches of the restore are live in the app, read by a temporary
`console.log` probe on the effect in the first round of this branch, reverted
after the run: at the cross-section remount the box answers
`scrollHeight=52 viewport=22`, so the restore runs on the spot; at the remount
back from below the minimum size it answers `scrollHeight=0 viewport=0`, so the
pane asks for the pass and the following pass lands the offset.
`test/ticket-scroll-frame.test.ts` - "restores the detail offset across a
round-trip resize below the minimum size" and "resets a new Ticket, preserves
same-Ticket refresh offsets, clamps, and survives resize" - were named there as
the cases that cover the ask path. That claim holds only while the runner is
quiet, and [the section below](#the-ask-half-pinned-the-review-rework-round)
corrects it and pins the path.

### The ask half, pinned (the review rework round)

The review of `fb373d83` named what the two sections above left unpinned, and
measured it: with `renderer.requestRender();` deleted from the restore effect, all
42 records in `test/main-view-frame.test.ts`, `test/ticket-scroll-frame.test.ts`,
and `test/ticket-detail.test.ts` stayed green. The below-minimum resize case
passes either way, because `setup.resize()` runs `processResize`, which ends in
its own `requestRender()`: the pass the restore waited for came from the rig and
never from the pane.

The claim that the two scroll cases cover the ask path is the first thing that
measurement unsettles. A temporary `console.log` probe on the restore effect,
reverted after the runs, read which branch the unheld resize case takes:

| Machine state | The branch, over 5 runs of that one case |
| --- | --- |
| The machine's own load | ask 5 of 5 |
| 24 busy loops alongside, load average 31.83 | ask 3 of 5, on the spot 2 of 5 |

So on a loaded runner the ask path can go unexercised in the very case this record
named as its coverage. A case that only takes the branch while the machine is
quiet cannot pin it.

`withholdRenderAsksButThePlanesOwn` in `test/app-harness.ts` swallows every render
ask but one the control plane makes directly on the renderer, and counts what it
swallowed. It reads the direct caller of `requestRender` off the call stack, so a
renderable's own ask - which reaches the renderer from inside OpenTUI - is held
like the rig's resize ask is. The first ask that gets through puts the hold down,
because the repaint that carries the restore's result to the screen has to follow
it. The key refuses to hand the asks back on an empty swallowed count: a hold that
swallowed nothing is indistinguishable from no hold at all, and it says so instead.

A new case, `test/ticket-scroll-frame.test.ts` - "restores the detail offset
across a below-minimum resize on its own render ask alone" - walks the same
below-minimum round trip as the case beside it, through one walk helper that takes
the hold flag. With the hold up no pass can land before the pane asks, so the
remounted box still answers no size when the restore effect runs: the branch is
forced, not waited for, and the only pass that can lay the box out is the pane's
own. The witness then states that one remount costs the pane exactly one ask.

| State | Result |
| --- | --- |
| Both cases with the fix | 13 pass / 0 fail in 3.94 s for the file: the held case at 251.11 ms, the unheld one beside it at 257.16 ms |
| The held case under 24 busy loops, load average 50.77 | 5 runs, 5 pass / 0 fail, and the same log probe reads the ask branch 5 of 5. The hold is what makes that branch deterministic |
| Probe D, `renderer.requestRender();` deleted from the restore effect | 1 record red at 10277.00 ms, the local 10000 ms `FRAME_DEADLINE_MS`, and 12 green: the held case. With every outside ask swallowed no pass lands, the box never lays out, and the offset never comes back. The harness's dump is blank rows, because after the resize nothing repainted the buffer at all. The unheld case stays green, which is the gap the review measured |
| Probe E, the one-ask bound (`if (passAsked) return;` and `passAsked = true;`) deleted | 13 pass / 0 fail, and the witness still counts one ask: the pass the pane asks for lays the box out, so the restore takes the on-the-spot branch and never asks again |
| Probe F, the hold's caller test widened so OpenTUI's own asks count as the plane's | 1 record red at 296.73 ms, the held case, on the hold's own swallowed-count line: the rig's resize ask is waved through at once, the hold swallows nothing, and the key refuses to hand the asks back |

Each probe edited one file, ran `bun test test/ticket-scroll-frame.test.ts
--isolate --timeout=30000`, and was reverted; a `diff` against a copy taken before
the probe showed the file byte-identical afterwards.

| Item the review asked to name | Where it stands |
| --- | --- |
| The give-up path: what becomes of `scrollSlot.current` when the one ask's pass still answers no size | Named in the code where it runs, above the second return of `restore()` in `src/components/ticket-detail.ts`. The offset is not applied and the slot is left exactly as the save side wrote it. That is intended: the slot is the save side's fact, and the restore side rewrites it only to say the offset landed. The retained value cannot move the scroll later, because every path to another remount runs the save cleanup first, which writes the offset the pane actually leaves behind - its top, since nothing was applied - and a zero offset never re-arms the restore. No case reaches the path: the pass the pane asks for lays the box out, and a terminal too small for the detail unmounts the pane into the compact frame outright |
| The `passAsked` bound | A guard no test detects, and Probe E above is the step that shows it. It bounds what a box that keeps answering no size after its own ask would otherwise do: ask again on every pass, forever. Nothing reachable puts the box in that state, so nothing reaches the bound either, and this record states that instead of claiming a pin for it |

### The gate on this branch

The branch was level with `origin/main` at `dab44a0d` before the runs.

| Check | Result |
| --- | --- |
| `bun run lint` | clean over 304 files (129 ms) |
| `bun run typecheck` | clean (`tsc`, no output) |
| `bun run docs:build` | complete in 2.33 s on the merged tree, and in 1.67 s one docs commit earlier, because the branch touches `docs/` |
| `bun run test` | Run 1 on `d1b55a00`: 3018 pass / 3 fail in 42.57 s (15,052 `expect()` calls) at load average 6.82 before and 6.79 after. Run 2 on the same head: 3020 pass / 1 fail in 42.74 s (15,055 `expect()`) at load 10.54 before and 10.68 after. Run 3, the gate run on the merged tree at `673bb8d3` level with `origin/main` at `dab44a0d`: 3020 pass / 1 fail in 41.10 s (15,055 `expect()`) at load 13.26 before and 7.47 after. Every red is named as a load flake in the table below and filed; none sits in a file this branch's production diff touches. Machine: 32 CPUs, and the `bun test` process check before the gate run answered 0. The only change after run 3 is this record's own wording of these rows |
| The base run, for pre-existence | `dab44a0d` checked out inside this same worktree, one full `bun run test` at load 11.04 before and 10.59 after: 3019 pass / 1 fail in 41.96 s (16,049 `expect()`), its one red the screenshot fixture, [issue #303](https://github.com/SeriousJul/my-little-software-factory/issues/303). That settles that a loaded runner turns some red per run on both trees; it does not settle which miss pre-exists which fix |

### The gate on the rework head

The head `e4289568` stands level with `origin/main` (0 behind, 9 ahead), and every
check below ran on it. The only change after these runs is this record's own text,
in the commit that lands on top of it. Machine: 32 CPUs, and the `bun test` process
check before the full run answered 0. Load average 7.21 before the full suite and
6.81 after; the load the probe runs above injected was killed before these checks
started.

| Check | Result |
| --- | --- |
| `bun run lint` | clean over 304 files (128 ms) |
| `bun run typecheck` | clean (`tsc`, no output) |
| `bun run docs:build` | complete in 1.62 s; the branch touches `docs/`, and the new section's anchor resolves |
| Scoped: `test/main-view-frame.test.ts`, `test/ticket-scroll-frame.test.ts`, `test/ticket-detail.test.ts` | 43 pass / 0 fail in 12.67 s, and 43 / 0 again in six further runs of the same trio |
| `bun run test`, once, on the merged tree | 3022 pass / 0 fail in 42.39 s (16,781 `expect()` calls). No red to name, so the triage table below stands as the previous head left it |

One scoped run of that trio, taken during the rework before the final tree was
settled, printed 42 pass / 1 fail without this agent capturing which record went
red. It is not reproducible on the head above: six runs of the trio and the full
suite all came back clean. It is recorded here rather than dropped, and it is not
filed, because nothing names it.

The three cheap checks and a second full run were repeated on the record commit
`6dcc5058`: `bun run lint` clean over 304 files, `bun run typecheck` clean, `bun
run docs:build` complete in 1.64 s, and one `bun run test` at 3022 pass / 0 fail in
42.29 s at load average 8.58 before and 5.93 after, with the `bun test` process
check again answering 0. The only change after that run is this paragraph.

### The full-suite reds this branch produced, and where each is filed

The standing triage rule records a file that goes red in the full suite and green
alone as a load flake. Each file below was run alone in this worktree, and each
red is filed.

| Case | The miss | Alone | Filed |
| --- | --- | --- | --- |
| `test/repository-select-panel.test.ts` - Esc closes the list and keeps the base frame | 10479.56 ms in run 1, the local `FRAME_DEADLINE_MS`. The #310 review reproduced the same case at 10412.69 ms on `b08745fa`, and remote run 37159675095 printed it at 20155 ms | 13 pass / 0 fail in 1.90 s | [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311), the frame-deadline class that survives the #302 fix |
| `test/executable-fields.test.ts` - refuses a non-digit paste in the Context window row and states why | 10007.09 ms in run 1, at the pseudo-terminal rig's own waits (12000 ms and 8000 ms), not at `FRAME_DEADLINE_MS`; which wait missed was not captured | 4 pass / 0 fail in 5.80 s | named in [#311](https://github.com/SeriousJul/my-little-software-factory/issues/311) as the other miss of the same run |
| `test/decision-modal.test.ts` - no content ever reaches the terminal's edge while the box grows | red in 3 of 3 full runs on this branch, at 505.66 ms, 401.24 ms, and 534.57 ms, on "the modal never rendered during the burst; the pop-in window was missed": the check samples a 300 ms wall-clock window and caught no pop-in frame | 12 pass / 0 fail in 3.99 s | [issue #312](https://github.com/SeriousJul/my-little-software-factory/issues/312), the wall-clock window |
| `test/screenshot-drift.test.ts` - the guide screenshots | 891.35 ms in the base run at `dab44a0d` | not run alone there | [issue #303](https://github.com/SeriousJul/my-little-software-factory/issues/303) stands |

### What this branch did not measure

| Item | State |
| --- | --- |
| Whether the other three remote misses share this mechanism | Not measured. `src/components/ticket-detail.ts` is the only surface under `src/` that reads the renderer's `frame` event, so the mechanism measured here cannot be what `test/consultation-frame.test.ts` - a live checkout conflict blocks the launch until one explicit confirm - and `test/repository-select-panel.test.ts` - Esc closes the list and keeps the base frame - miss on. The pair is green run together here (71 pass / 0 fail in 23.56 s), and that is a scoped run, not the full suite: the panel case did go red inside a full suite on this head, at 10479.56 ms. The class that survives this fix now stands filed as [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311) instead of staying open under #302 |
| The ordering flip that let a remote run miss at all | Still not pinned. The two probes the section above record stayed green, and this branch does not reproduce the miss; it removes the wait that made the miss a 20-second failure instead of a repaint the next key would have hidden. What is pinned is the contract: no surface can bring the offset back by waiting |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, unchanged, as [the shared control record](./shared-controls.md) states |

## What was not measured

| Item | State |
| --- | --- |
| A real `git push` to `github.com/SeriousJul/my-little-software-factory` with the hook installed | Passed. The push of `main` ran the hook: `pre-push: bun run lint` (302 files, no fixes), `pre-push: bun run typecheck`, `pre-push: lint and typecheck clean, and no branch behind its remote-tracking ref`, and `370563f5..724dc3ec main -> main` landed |
| The hook installed in the operator's checkout | Passed. `git config core.hooksPath scripts/git-hooks` is set in this checkout, and the push above is the proof it is live. The setup line stays a documented step on [the commands page](../development/commands.md) for every other checkout |
| The doc-claim rule, the rename sweep, the documented-line rule, the probe rule, the determinism rule, the fake-fidelity rule, the file-the-defect rule, the failure-mode sweep, and the reporting rules | First measured by the self-review round above, on `b3b5fc38`: the probe rule, the rename sweep, the determinism rule, the file-the-defect rule, and the doc-claim rule each produced a result there, and the doc-claim rule found the stale cost numbers. What stays incomplete is the round's value: every commit was written by the agent that wrote the rules, so this is self-review, and a round on a pull request from a different author is the first independent measurement |
| The 14 domain types in `UNREAD_TYPE_BASELINE` | Answered on 2026-10-05 in [the section above](#issue-301-the-14-unread-domain-types-2026-10-05): each name took one of [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301)'s three answers and the baseline stands empty. What stays unmeasured is whether any of them is dead, which the check still cannot see, and it is recorded in that section |
| The CI load flake on the frame tests | Investigated on 2026-10-05 and filed as [issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302): four remote frame-deadline misses, the mechanism measured, no local reproduction, and no fix shipped on that evidence. The scroll half of it is answered on 2026-10-05 in [the section above](#issue-302-the-details-scroll-restore-waits-for-a-pass-the-plane-does-not-owe-2026-10-05-the-fix). What stays open is the rest of the class: the other three named misses do not share the mechanism, and the deadline miss itself still reproduces in a full suite on this branch, which is filed on 2026-10-05 as [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311) with its reproductions in that section. The older records in [the shared control record](./shared-controls.md) and the pull request records stand |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, as [the shared control record](./shared-controls.md) states. The gate is a claim about the automated checks and the tree they ran on, and it extends no further |
