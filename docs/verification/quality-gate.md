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
| Three mechanisms, not one | #302 misses a deadline (10000 ms local, 20000 ms CI). #303 fails at 796 to 1282 ms on a fixed `sleep(150)` in `stepUntilRow`. A third, filed as [issue #304](https://github.com/SeriousJul/my-little-software-factory/issues/304), fails fast at 360 to 425 ms because `settle` reads a stable frame as a finished transition: `test/live-view.test.ts` asserted on a `settle` result and caught the Live view still open. #303 is the most frequent local failure, so fixing it alone would quiet the noise while #302 and #304 stand. #304 is answered on 2026-10-06 in [the section below](#issue-304-settle-reads-a-stable-frame-as-a-finished-transition-2026-10-06-the-fix), and what that fix exposed is the Live view missing its fallback outright |

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
the probe showed the file byte-identical afterwards. The rows stand on `e4289568`,
the head that round landed them on; [the section after the gate
rows](#the-second-rework-round-the-bound-pinned-and-the-gate-on-the-merged-tree)
re-runs every probe on the rebased tree and names the counts that moved.

| Item the review asked to name | Where it stands |
| --- | --- |
| The give-up path: what becomes of `scrollSlot.current` when the one ask's pass still answers no size | Named in the code where it runs, above the second return of `restore()` in `src/components/ticket-detail.ts`. The offset is not applied and the slot is left exactly as the save side wrote it. That is intended: the slot is the save side's fact, and the restore side rewrites it only to say the offset landed. The retained value cannot move the scroll later, because every path to another remount runs the save cleanup first, which writes the offset the pane actually leaves behind - its top, since nothing was applied - and a zero offset never re-arms the restore. No case reaches the path: the pass the pane asks for lays the box out, and a terminal too small for the detail unmounts the pane into the compact frame outright. [The section after the gate rows](#the-second-rework-round-the-bound-pinned-and-the-gate-on-the-merged-tree) reaches it with a case |
| The `passAsked` bound | A guard no test detects, and Probe E above is the step that shows it. It bounds what a box that keeps answering no size after its own ask would otherwise do: ask again on every pass, forever. Nothing reachable puts the box in that state, so nothing reaches the bound either, and this record states that instead of claiming a pin for it. [The section after the gate rows](#the-second-rework-round-the-bound-pinned-and-the-gate-on-the-merged-tree) supplies that state at the rig layer and pins the bound |

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

### The second rework round: the bound pinned, and the gate on the merged tree

The review of `fb373d83` asked for three things. The round on `e4289568` answered
the ask half and named the other two. This round answers the third with a test
instead of a record: the `passAsked` bound now has a case that goes red when the
line goes.

The branch was rebased onto `origin/main` at `3a1257e4` (0 behind, 11 ahead)
before any check below ran, so the tree checked is the tree that merges. The
rebase rewrote the commit names the rows above carry (`d1b55a00`, `673bb8d3`,
`e4289568`, `6dcc5058`): those objects no longer stand on the branch, and those
rows stand for the content they measured, not for a ref a reviewer can check out.

The bound needs a box that keeps answering no size after its own ask, and no
reachable app state puts a box there: the pass the pane asks for lays it out. So
the rig supplies that state. `withholdEveryRenderAsk` in `test/app-harness.ts`
swallows every render ask, the control plane's own included, so no pass ever runs
and a scroll box remounted under it never lays out; it counts the asks the plane
made directly on the renderer and swallows them with the rest. `announceFramePass`
calls the renderer's own `frame` announcement, which is what a surface registered
with `once("frame", ...)` meets: the rig announces the pass, nothing lays the tree
out, and the box answers no size again.

A new case, `test/ticket-scroll-frame.test.ts` - "the Ticket detail asks for one
pass and stops when its box never lays out" - walks the same scroll and the same
drop below the minimum size as the two round-trip cases, through the prefix helper
they now share, takes the terminal back under that hold, announces five passes, and
reads the witness: the remount costs exactly one ask. Its last assertion is the
give-up path on screen - the buffer holds no detail pane and no thumb, so the saved
offset was never applied to anything the operator can see. Five runs of the file at
the machine's own load came back 14 pass / 0 fail, the case at 518.73 ms to
523.39 ms. The load rig this record used for the held round-trip case did not hold
24 busy loops on this machine during this round - each one exited within seconds -
so the new case is measured at the machine's own load and not under load.

| Probe, re-run on the rebased tree | Result |
| --- | --- |
| Probe A, the retired wait put back (`restore();` to `renderer.once("frame", restore);`) | 1 record red at 11025.94 ms, 24 green, in `test/main-view-frame.test.ts`: the withheld round trip, with the dump the remote misses printed |
| Probe B, the frame hold's own `frame` listener deleted | 1 record red at 1018.66 ms on the hold's swallowed-count line, 24 green |
| Probe C, the frame hold handing the event to the real `emit` | 1 record red at 1018.81 ms on the hold's leaked-count line, 24 green |
| Probe D, `renderer.requestRender();` deleted from the restore effect | 2 records red, 12 green: the held round trip at 10228.18 ms, the local 10000 ms `FRAME_DEADLINE_MS`, with its dump blank rows; and the new case at 518.80 ms with the witness at 0 asks where the record expects 1. The unheld round trip stays green - the gap the review of `fb373d83` measured |
| Probe E, the one-ask bound (`let passAsked = false;`, `if (passAsked) return;`, `passAsked = true;`) deleted | 1 record red at 521.26 ms, 13 green: the new case, with the witness at 6 asks where the record expects 1 - the unbounded restore asks again on every pass the rig announces. The bound is pinned |
| Probe F, the caller test in `renderAskComesFromThePlane` widened so OpenTUI's own asks count as the plane's | 2 records red, 12 green: the held round trip at 258.36 ms on the hold's own swallowed-count line, and the new case at 522.47 ms on its ask-count line, because the rig's resize ask reads as the pane's own |

Each probe edited one file, ran the file alone with `--isolate --timeout=30000`,
and was reverted; a `diff` against a copy taken before the probe showed the file
byte-identical afterwards.

| Item the review asked for | Where it stands on this head |
| --- | --- |
| Pin the ask half, or record it as unpinned | Pinned: Probe D above, on the rebased tree, bites the held round trip and the new case |
| Name the give-up path, and say whether the retained offset is intended | Named in the code, and now reached by a case: the new case is that path, and its buffer states that the offset was never applied. The retained `scrollSlot.current` is intended, for the reason the row above gives |
| State the `passAsked` bound as a guard no test detects, or pin it | Pinned by the new case. The row above that called it a guard no test detects stands as the measurement that made it one, and this round is what changed it |
| Call `sampleOutcome()` once in `longDetailOutcome()` | Landed on `e4289568`, unchanged |

| Check | Result |
| --- | --- |
| `bun run lint` | clean over 306 files (130 ms) |
| `bun run typecheck` | clean (`tsc`, no output) |
| `bun run docs:build` | complete in 1.57 s; the branch touches `docs/`, and this section's anchor resolves |
| Scoped: `test/main-view-frame.test.ts`, `test/ticket-scroll-frame.test.ts`, `test/ticket-detail.test.ts` | 48 pass / 0 fail in 13.02 s |
| `bun run test`, once, on the merged tree | 3058 pass / 0 fail in 39.66 s (17,150 `expect()` calls) at load average 7.39 before and 4.33 after. Machine: 32 CPUs, and the `bun test` process check before the run answered 0. No red to name, so the triage table below stands as the previous head left it. An earlier full run on the same tree, before the harness refactor and the probe-header wording landed, read 3058 pass / 0 fail in 39.78 s (17,110 `expect()`) |

The counts the rows above carry moved with the merge, as they must: `origin/main`
at `3a1257e4` adds files to the lint count (304 to 306) and four records to
`test/ticket-detail.test.ts` (5 to 9), the new case adds one to the scroll file
(13 to 14), and the scoped trio goes from 43 to 48. The gate rows above name the
counts this round measured.

Every check in the table ran on the tree of this round's two commits, with the test
commit at `23caff2b`. The only change after the full run is this record's own text,
in the commit that lands on top of it.

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

## Issue #304: `settle` reads a stable frame as a finished transition (2026-10-06, the fix)

[Issue #304](https://github.com/SeriousJul/my-little-software-factory/issues/304)
is the third mechanism of [the section above](#what-the-failures-have-in-common):
`settle` in `test/app-harness.ts` waits out a 30 ms grace and returns once the
frame has stopped changing, so it measures quiet, not finished. The routed-handoff
cases in `test/live-view.test.ts` asserted on that result that the Live view had
fallen back to the list, and a loaded runner handed them the Live view still
streaming the new pane.

The fix is the wait the issue names, and the wait then exposed two facts the fixed
grace had been covering: the Live view can miss its fallback outright, and the
frame falls back before the closing surface releases its keys. Both are recorded
below with the measurement that found them.

### The reproduction, on the real application flow

The load rig is 96 bash busy loops (`while :; do :; done`) started beside
`bun run test`, which is the state the miss needs: the machine's own load average
was 13 to 16 before the rig and 96 to 98 during the runs. A local inference
engine held about 860 % CPU through every run here, and no other `bun test`
process was running.

| State | Result |
| --- | --- |
| The miss, on `origin/main` at `518029e5`, first reproduction (load 29 before the run) | `test/live-view.test.ts` - a routed handoff from the decision sub-mode falls back to the list, and the Live view follows the new pane (ADR 0072) - red at 525.80 ms on `expect(listFrame).not.toContain("Live: Persist source facts")`, inside a full suite. The frame the assertion received is the Live view fully painted: its `Live: Persist source facts` border, its Agent body reading `the reviewer is on it` (the new pane), and `Warning: "Persist source facts" started from the Work queue` on the Message line. That is the shape the issue prints, and it is a stable frame, not a missing one |
| The same tree, three full runs at the load rig | Red in 3 of 3 runs on one of the two routed cases: 584.42 ms, 754.31 ms, 544.61 ms. 18 routed cases ran, 3 missed |
| The same file alone | 20 pass / 0 fail in 10.05 s, every time it was run alone |

### What the wait exposed first: the plane can miss the fallback entirely

With only the test change the issue names - `awaitFrame` on `!f.includes("Live:")`
- the same load did not go green. It went red at the frame deadline instead: 3 of 3
runs at 10434.11, 10472.98, and 10542.26 ms, with the last frame the Live view
still open. A wait cannot pass a fact the plane never produces, so the fallback
itself was the defect.

A probe recorded every render of the App while the confirm ran, as `panel`,
`liveMode`, the projected ticket `state`, and `workCycle`:

| Run | The render sequence after the confirm |
| --- | --- |
| Green run | `panel=live liveMode=decision pstate=awaiting cycle=1` then `panel=live liveMode=closed pstate=open cycle=2` then `panel=-`. One render holds the `open` state, and the screen falls back in it |
| Red run, 3 of 3 at the load rig | `panel=live liveMode=decision pstate=awaiting cycle=1` then `liveMode=stream pstate=handed-off cycle=2` then `liveMode=stream pstate=running cycle=2`, over 404, 419, and 428 renders, and **no render holds `open` at all** |

The write that ends a cycle moves the Ticket to `open` and to the next cycle in
one step, and the queue's pickup claims the next cycle's start before the plane
next renders. The `open` frame is therefore a moment the plane may never be
handed, and `liveMode` derived the fallback from exactly that moment. The Live
view now ends on the durable form of the same fact: the work cycle it opened on,
the rule [ADR 0110](../adr/0110-the-live-view-is-one-work-cycles-screen.md)
records. `Panel`'s live variant carries that cycle, and a route override holds
the panel it returns to as one value, so a return to the Live view returns to the
cycle it left, and `src/components/app.ts` closes the screen when the Ticket's
cycle moves.

The pin is `test/live-view.test.ts` - "the view ends on the work cycle it opened
on, with no frame holding the open state (ADR 0110)": it ends the cycle and
claims the next one in one turn of the event loop, with no projection read
between the two writes, so the plane's first read finds the Ticket in flight in
the next cycle and no frame ever holds `open`.

| State | Result |
| --- | --- |
| The case on this tree | Green at 164.32 ms |
| Probe: `panelTicket.workCycle === panel.workCycle` replaced by `true` in the `liveMode` derivation | `bun test test/live-view.test.ts` alone: that case red at 5003.98 ms, which is `bun test`'s own 5000 ms per-test deadline, and the other 20 in the file green. The same mutation inside `bun run test` - the harness raises the per-test deadline to 10000 ms there - went red at 10105.23 ms with the last frame the Decision sub-mode. The two routed-handoff cases stay green on an idle machine, which is why the deterministic case exists beside them |

### What the wait exposed second: the keys outlive the frame

With the fallback waited for and the plane fixed, the next step of the walk -
Enter to reopen the Live view - timed out at 10472.98 ms with
`Warning: ticket github:github.com:I_5 already decided` on the Message line: the
frame falls back before the closing surface's effect cleanup removes its key
handler, and the Enter reached that stale handler, which ran the route row again.
This is the window `test/app-harness.ts` documents above `awaitGoneKeyHandler`,
and both routed cases now wait for the release.

They wait with a new harness wait, `awaitBaseKeyHandlers`, because
`awaitGoneKeyHandler` cannot name the handler here: the override path's confirm
returns to the Live view, and that reopen can be elided when the cycle's write
lands in the same render, so no handler of that surface ever joins the bus. A
probe that waited for the join with `awaitNewKeyHandler` timed out at 10455.16 ms
on an idle machine, which is what the new wait is written against. It waits that
the bus holds no subscription outside the set taken while the plane rested in the
base mode, which covers the surface remounting and the reopen being elided alike.

The wait makes the test honest about the window; it does not close it for the
operator. The plane still answers a keypress with a surface that already left
the screen, and an Enter twice at normal speed is inside the window. That is a
product race, filed as
[issue #317](https://github.com/SeriousJul/my-little-software-factory/issues/317),
and the answer recorded there is a guard at the dispatch, not only a wait behind
it: `createControlDispatch` is the one loop every surface's keys run through, so
a liveness flag on the subscription - down in a layout effect's cleanup, which
React runs in the commit that unmounts the surface, before the frame is drawn -
leaves a handler of an undrawn surface unable to act. This branch does not
implement it: the guard needs its own measurement of how long a stale
subscription stands, idle and under load, and the issue names that as its first
step. What this branch ships is the reproduction the issue points at - the second
Enter of the routed walk - and the wait that keeps the test off the race while
the plane still carries it.

### The state assertion the earlier fallback moved

The assertion beside the fallback read `["handed-off", "running"]`, which was true
because `settle`'s fixed grace outlasted the queue's pickup. The waited-for
fallback lands at the ask, before the pickup claims, so the first loaded run after
the wait went red at 515.34 ms with `Expected to contain: "open"`. The set is now
the file's `statesAfterTheAsk`: `open`, `handed-off`, `running` - the window a
Ticket is caught in just after its route's ask ended its cycle, not a domain set -
and the durable fact, the recorded `handed-off` decision, is asserted on its own
line as before. The second round below read that set as three of the four
`TicketState` values and dropped the line; what stands beside the fallback is the
decision alone.

### The sweep requirement 2 asks for

The question was asked of every `settle` result that feeds a "must not contain"
assertion. The first version of this section printed counts without printing the
rule that printed them, and a recount on the same tree did not reproduce them.
The rule is written out below and the counts are re-run from it on both trees.

**The counting rule.** One script over a checkout's `test/` tree, six rules, in
the order they read a file:

1. A **file** is every `*.ts` under `test/` except `test/app-harness.ts`.
2. A **call site** is a line holding `settle(` with no `.` or word character
   before it, so the harness function is named and a method of the same word is
   not (`app.src.settle(...)`, `settleHandoff(...)`).
3. An **assigned result** is a call site on a line matching
   `(const|let) <name> = await settle(`. The bound `<name>` is the result.
4. The **window** is the 40 lines from the assignment's own line.
5. An assertion **reads the result** when its line holds `expect(` and the bound
   name as a whole word. A **"must not contain" assertion** is an assertion line
   that also holds `.not.toContain(`.
6. A **loose** assertion is a "must not contain" line in the window that does
   *not* read the result. A site is counted in the loose row when its window
   holds at least one loose assertion **and** the site holds no "must not
   contain" on the result, so the loose row and the row above it are disjoint.
   Assertions are counted per window, not per line: a line inside two
   overlapping windows counts twice, which is why 23 distinct lines print 26.

| Count | `origin/main` at `518029e5` | This branch |
| --- | --- | --- |
| Files scanned | 156 | 156 |
| Call sites | 306 | 300 |
| Assigned results | 125 | 119 |
| Sites with any assertion on the result | 111 | 105 |
| Sites with a "must not contain" on the result | **40 sites, 43 assertions** | 34 sites, 36 assertions |
| Sites whose window has a "must not contain" on another receiver and none on the result | 20 sites, 26 assertions | 20 sites, 26 assertions |
| Of the 40, sites where the absence is a transition the preceding wait does not cover | **6 sites, 7 assertions** | 0 sites |

The loose row is the row the first version of this section under-specified, and
the review round named the two readings it is not: "every window holding an
assertion whose receiver is anything else" prints 30 sites / 40 assertions at
the base and 29 / 39 here, and "a window with no assertion on the result at all"
prints 3 / 4 on both trees. The arithmetic above is rule 6, re-run from these
six rules on both trees on 2026-10-06, and it prints 20 sites and 26 assertions
on each.
| Of the 40, sites where the absence is a transition the preceding wait does not cover | **6 sites, 7 assertions** | 0 sites |

The last row is the judgement, not arithmetic, and it is the row the fix works
on: which of the 40 absences names a screen or a badge a later render takes
away. The site rows below name the base tree's line numbers, since that is where
the sweep read them. The 6 that shared the mechanism, all now waited for:

| Site | The absence it asserted on a quiet frame |
| --- | --- |
| `test/live-view.test.ts:1042` | The Live view gone after the route confirm - the case the issue names |
| `test/live-view.test.ts:1200` | The same, through the override (2 assertions) |
| `test/auto-mode.test.ts:2535` | The Decision screen gone after a failed route |
| `test/work-queue-frame.test.ts:781` | The cursor gone from the queue a Delete emptied |
| `test/work-queue-frame.test.ts:903` | The `[queued]` badge gone from the row whose start was cancelled |
| `test/work-queue-frame.test.ts:1148` | The same on the route item's own row |

The 34 left alone assert a non-effect, which is what `settle` measures: a refused
control that opens no panel (`test/action-bar.test.ts`, `test/handoff-frame.test.ts`,
`test/source-frame.test.ts`), a key a surface does not take
(`test/key-guide.test.ts`, `test/consultation-frame.test.ts`), a row that keeps its
badge, a header that drops a cell, a boot frame with no warning on it
(`test/theme-frame.test.ts`, `test/ticket-grouping-frame.test.ts`,
`test/work-queue-frame.test.ts:398`), and a Message line that stays a notice rather
than a Working line (`test/message-line.test.ts`). Two of them were read twice
before they were left: `test/plane-action-merge.test.ts:2342` asserts that the
run's settle brings *no* decision screen back, and `test/repository-select-panel.test.ts:175`
repeats an absence its `closeOverlay` call has already waited for. Both are
non-effects, so both keep `settle`.

**The same class on a `press` result.** The rule above is scoped to a `settle`
result, and `press`, `pressArrow`, `pressReturn`, and `pressEnter` hand back a
frame too - the first frame carrying their predicate - so the same question was
asked with rule 3 widened to
`(const|let) <name> = await (press|pressArrow|pressReturn|pressEnter)(`: on the
base tree, 181 assigned press results and **35 sites with a "must not contain"
on the press result**. The judgement that narrows 35 is the settle side's and is
a read, not a count: the class is an absence of a screen a later render takes
away, and 34 of the 35 assert a non-effect on the very frame the key's own
predicate names - a panel that did not open (`test/auto-mode.test.ts:2328`), a
cursor that did not move (`test/decision-modal.test.ts:324`), a Message line that
stayed a notice (`test/main-view-frame.test.ts:699`), a badge a row keeps
(`test/starting-face.test.ts:338`). One site shared the mechanism, and the review
round found it outside this sweep's own scope:

| Site | The absence |
| --- | --- |
| `test/plane-action-merge.test.ts:2325` | The Decision screen gone after the merge ask's confirm, asserted on the frame that carries the ask's Message line - one wait earlier than `test/auto-mode.test.ts:2535`, the same story |

Its wait now takes the absence it asserts: the predicate reads
`messageRowOf(f).includes("... is in the Work queue") && !f.includes("Decision:")`,
so the frame the press returns is the fallen-back list, and a fallback that has
not started cannot pass it.

**What the sweep cannot prove, in both directions.** The 34 left alone are right
in the flake direction: `settle` measures a non-effect, and a non-effect has no
transition to miss. The other direction is a false pass, and the sweep does not
close it: an effect that lands after `settle`'s 300 ms cap is asserted away by
the same absence, and nothing here distinguishes it from a non-effect, because a
test that passes leaves no evidence. The two are told apart only by holding the
transition and watching the assertion go red, which is what the reproduction did
for the 6. A site whose transition is merely slow looks, from this sweep, exactly
like a site whose absence is a non-effect.

The harness helpers that hand back a `settle` result (`openPanel`, `openGuide`,
`openMessageView`, `openLauncher`, `openSurface`, `closeOverlay`, `pressQuiet`,
`pressEnterQuiet`, `tabUntilSlot`) were asked the same question: each waits its
own fact first - the open frame, the key subscription, the close - so the frame
they return is after a wait, not after quiet. None of them carries the mechanism.

No automated check was added for this class. A "must not contain" on a `settle`
result is the *correct* shape for 34 of the 40 sites, so a syntactic check would
refuse the majority of its own uses. The rule stands where a writer reads it: on
`settle`'s own doc comment in `test/app-harness.ts`.

### The gate on this branch, as the first rework round measured it (`6b365016`)

| Check | Result |
| --- | --- |
| `bun run lint` | Clean over 306 files in 147 ms |
| `bun run typecheck` | Clean |
| `bun run docs:build` | Complete in 1.63 s |
| `bun run test`, the gate run, load 14.3 before, no other `bun test` on the machine | 3068 pass / 0 fail across 139 files in 43.74 s (17,070 `expect()`) |
| `bun run test`, two earlier runs on the same head | 3068 pass / 0 fail in 43.86 s (17,270 `expect()`); 3067 pass / 1 fail in 44.59 s (17,069 `expect()`), the one red recorded below |
| `bun test test/live-view.test.ts` alone | 21 pass / 0 fail in 10.22 s (102 `expect()`) |

The `expect()` total is a per-run measurement, not a property of the tree: three
runs of one head printed 17,069, 17,070, and 17,270, because a test that asserts
inside a loop - the scroll walks, the frame sweeps - calls `expect()` as many
times as it iterates. A recorded total therefore names its run.

The one red of the earlier run is recorded as a load flake, per `AGENTS.md`:
`test/repository-select-panel.test.ts` - **a failed act stops the queue, and
names the repository on the line** - at 10743.67 ms, which is
[issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311)'s
frame-deadline class at the local deadline, the same case the table below names
on both trees. It passes alone at 158.21 ms (13 pass / 0 fail in 1.99 s), and the
machine's load average was 16.26 while that suite ran. The gate run above is
green on the same head.

The same load rig, three full runs on this tree, against the three recorded above
on `origin/main`:

| Tree | Routed-handoff reds in 3 runs | Other reds in the same runs |
| --- | --- | --- |
| `origin/main` at `518029e5` | 3 of 3 runs (584.42, 754.31, 544.61 ms) | 11 misses: the scroll round trip, the init TUI walk, the repository select queue and its Esc case, the Consultation launch, the pseudo-terminal paste case, the screenshot fixture, the Action bar `q` case |
| This branch | 0 of 3 runs, and 0 of the 18 routed cases in them | 15 misses, the same class: the scroll round trip twice, the detail's withheld-frame case, the init TUI walk, the repository select queue and its Esc case, the Consultation launch, the screenshot fixture twice, the Action bar `q` case twice, and the two pseudo-terminal cases (the launcher walk, the non-digit paste) |

The other misses are [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311)'s
frame-deadline class and [issue #303](https://github.com/SeriousJul/my-little-software-factory/issues/303)'s
screenshot fixture. They stand on both trees at this load and are not answered here.

### What this branch did not measure

| Item | State |
| --- | --- |
| Why no render held the `open` state | Not pinned. The render log shows the plane was never handed a projection with the Ticket `open`; whether the update was coalesced inside React or the projection read fell between the two writes was not measured. The fix does not depend on which: the cycle number is durable under both |
| The same coalescing on other surfaces | Not swept. `liveMode` is the only derivation this branch found that reads a state the write only passes through; the Decision modal closes in the key handler's own turn, and the failed-route case the sweep fixed rests `open` durably, so neither shares the exposure. No other surface was checked |
| The loaded runs as a rate | Three runs per tree is not a rate. The base tree missed 3 of 18 routed cases; this branch missed 0 of 18 in its three runs, and 18 cases cannot separate a 1-in-6 rate from a 1-in-20 one |
| The screen-reader path, the live terminal walk, and the theme inheritance inside a real herdr | Open, unchanged, as [the shared control record](./shared-controls.md) states |

### The review rework round (2026-10-06)

The review of pull request #316 scored the branch 80 / 100 and asked for eight
changes. Each is recorded with what it became, and the two numbers the review
re-measured are corrected in the gate table above.

| The review asked for | What it became |
| --- | --- |
| The domain rule is not in the domain docs | `CONTEXT.md`'s Live view entry states the cycle bound as a fact of the screen, [docs/operation/live-view.md](../operation/live-view.md) tells it to the operator, and [ADR 0110](../adr/0110-the-live-view-is-one-work-cycles-screen.md) states the decision, its considered options, and the general rule: a screen bounded by a transition reads the durable form of it, not a state the write only passes through. ADR 0072 stands unedited, corrected there for the screen |
| The key-release window is a product race | Filed as [issue #317](https://github.com/SeriousJul/my-little-software-factory/issues/317) with the reproduction, the mechanism, and the guard the fix should take. The plane will guard it at the dispatch, not only wait behind it; this branch ships the wait and the reproduction, and the issue owns the guard |
| The sweep's counts do not re-run | The counting rule is written out as six rules, and the counts are re-run from it on `origin/main` at `518029e5` and on this branch. The conclusion stands: the same 6 sites, and no unfixed site of the class |
| One same-class assertion sits on a `press` result | `test/plane-action-merge.test.ts:2325` now waits for the absence it asserts, in the press's own predicate. The press-side sweep is recorded with its own rule and its 35 mechanical hits, 34 of them read as non-effects |
| `PendingOverride` mirrors the Live panel field by field | The workflow variant holds `returnTo`, one value of type `Extract<Panel, { kind: "decision" | "live" }>`, and `cancelOverride` and the confirm hand it to `setPanel` unchanged. A field the Live panel grows later is carried by the compiler, with no second list to keep in step |
| Three copies of the bus loop, one of them able to pass for free | `awaitKeyBus` owns the poll, and the three waits are its predicates. `awaitBaseKeyHandlers`' doc stated the branch it cannot see - it returns at once when the bus holds only `base` - and the two rules a caller had to meet; the second round below moved that rule from prose into the harness, where `baseKeyHandlers` takes the snapshot and watches the bus and the wait refuses a base that never saw a surface take the keys |
| The `test/work-queue-frame.test.ts:1166` wait takes an absence its assertions do not read | Its predicate now takes the row and the badge the assertions read: the row naming `Add a webhook` wearing `[open]`. A frame with no rows fails the wait |
| Two recorded numbers | The `expect()` count and the mutation probe are restated above with the command each came from: 17,070 for the gate run, beside the two other runs of the same head, because the total moves with the loop counts; and 5003.98 ms for the probe under `bun test test/live-view.test.ts`, against 10105.23 ms inside `bun run test` |

Two notes the review did not require were taken: the state set beside the
fallback was named `statesAfterTheAsk`, so the name said it is a window and not a
domain set (the second round below dropped the line), and the sweep states what it
cannot prove in the false-pass direction, not only in the flake direction.

The rework changed waits, names, and a type. It added no behavior to the plane
beyond the cycle check the first round recorded, so the three loaded runs against
the base tree, recorded above, stand as the branch's load evidence.

### The second review rework round (2026-10-06)

The second review scored the branch 88 / 100, re-measured the sweep and the
mutation pin on this machine, and asked for six changes. Each is recorded with
what it became.

| The review asked for | What it became |
| --- | --- |
| ADR 0109 is claimed by two open pull requests | This branch took **ADR 0110**: [0110-the-live-view-is-one-work-cycles-screen.md](../adr/0110-the-live-view-is-one-work-cycles-screen.md). Pull request [#306](https://github.com/SeriousJul/my-little-software-factory/pull/306) keeps 0109, and no open pull request holds 0110, so neither merge lands a duplicate number |
| Three of the new waits take a bare absence | All three take a positive now. Both routed cases wait through the file's `awaitFallbackToTheList`, whose predicate is `f.includes("┌─❯ Tickets") && !f.includes("Live:")` - the Live view paints the terminal alone, so the list's own border returning is the fallback drawn, and a frame with nothing drawn fails it. `test/auto-mode.test.ts` waits `f.includes("Tickets") && ticketRow(f).includes("[open]")`, the row and badge its next line asserts. A probe of each screen confirms the positive is exclusive: the Live view's frame and the Decision screen's frame hold no `Tickets` at all |
| The assertion the wait was written for is unreachable | The specific `not.toContain` lines stay, and each wait now carries a positive the assertion does not restate: the list drawn. The auto-mode wait's positive (`[open]` on the row) does not entail its absence at all, so that assertion can fail on its own. Where the two screens are mutually exclusive the wait is the drawn fact and the assertion names the border that left |
| A set of three of four states is not an assertion | The line is gone from both routed cases, with the file's `statesAfterTheAsk` with it. What stands beside the fallback is the durable fact, the recorded `handed-off` decision, and the comment at each site says why no state line stands there: the fallback lands at the ask, before the queue's pickup, so the state is a window and not a fact. The routed start itself is still asserted, by the new pane the walk streams next |
| Rule 5's loose clause does not print its own row | The clause is rewritten to the arithmetic that printed the row - rule 6 above - and the row is re-run from it on both trees: 20 sites and 26 assertions on each, 23 distinct lines counted per window. The two readings the review got (30 / 40 and 3 / 4 at the base) are recorded as the readings the rule is not |
| `awaitBaseKeyHandlers` can pass for free, and only prose stops it | The harness owns the rule now. `baseKeyHandlers(setup)` snapshots the bus and keeps watching it through the wait, and `awaitBaseKeyHandlers` refuses a walk that never mounted a surface: it throws that the wait proved nothing. The refusal is measured, not assumed - with the snapshot moved after the Live view opens, `test/live-view.test.ts` - the routed handoff from the decision sub-mode - goes red with exactly that error, and is green with the snapshot where it belongs |
| The new block is duplicated across the two routed cases | The file's `awaitFallbackToTheList(setup, base)` owns the fallback wait, the release wait, and the frame they return, and both routed cases call it. The snapshot's load-bearing place is one line at each walk's start, beside the comment that says why it is taken before anything is mounted |

The rework changed no behavior in the plane. The cycle check, the waits, and the
loaded runs recorded above are unchanged by it, and the ADR 0110 pin was re-run
on this tree with `panelTicket.workCycle === panel.workCycle` replaced by `true`:
`bun test test/live-view.test.ts` puts that case red at 5000.23 ms, bun's own
per-test deadline, with the other 20 green, against the 5003.98 ms the first round
recorded; the same mutation with `--timeout=60000` goes red at 10101.91 ms, which
is the frame deadline the first round measured at 10105.23 ms.

**The gate on the second round's head.**

| Check | Result |
| --- | --- |
| `bun run lint` | Clean over 306 files in 132 ms |
| `bun run typecheck` | Clean |
| `bun run docs:build` | Complete in 1.64 s |
| `bun run test`, the gate run, load 12.61 before, no other `bun test` on the machine | 3068 pass / 0 fail across 139 files in 39.80 s (17,108 `expect()`) |
| `bun test` over the four changed test files, load 19.64 before | 185 pass / 0 fail in 35.68 s (859 `expect()`) |
| `bun test test/live-view.test.ts` alone | 21 pass / 0 fail in 10.20 s (100 `expect()`) |
| The sweep's branch column, re-run from the six rules on this head | 156 files, 300 call sites, 119 assigned results, 105 with an assertion, 34 sites / 36 assertions on the result, 20 sites / 26 assertions loose - the recorded row, unchanged by the rework |

## Issue #311: frame waits still miss the deadline under load in the surfaces the #302 fix does not touch (2026-10-06, the fix)

[Issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311)
filed the deadline miss that survives the #302 restore fix: a full-suite red
on `test/repository-select-panel.test.ts` - "Esc closes the list and keeps
the base frame" - at the local `FRAME_DEADLINE_MS`, green alone. The fix lands
on pull request [#318](https://github.com/SeriousJul/my-little-software-factory/pull/318),
fix commit `82b5e640`, and this section records the rework round the review
scored 76 / 100.

### What the code does

A surface takes and releases its key handler in a passive effect. The
reconciler runs the flush a commit queues on the scheduler's clock at the
normal priority, never on a frame, and the plane paints on invalidation, so on
a loaded runner the flush lands 2 to 6 ms after the frame the same commit
drew. The waits that stood in that window are the ones that end on a pass the
reconciler owes, not a frame the plane owes:

- `closeOverlay` took its key-handler snapshot in the window. The snapshot
  held only the shell's handlers, which never leave the bus, so the
  `awaitGoneKeyHandler` that follows could end on nothing and missed
  `FRAME_DEADLINE_MS` at ~10 s.
- every `awaitFrame` predicate that waits on a fact a late commit or a late
  passive flush carries.

`act` was ruled out by measurement: `await act(async () => {})` does not flush
a pending passive flush, it only yields to the event loop.

### The reproduction, and the probe it carries

`test/passive-flush-hold.ts` puts the rig's own array in the reconciler's
`actQueue` seam and wraps the scheduler's schedule function, which the
reconciler takes at its own module init, so the wrap stands through the
`[test] preload` in `bunfig.toml`. The seam is React's private interior and is
version-pinned in the file's doc: it stands on the `react 19.3.0` /
`scheduler 0.27.0` pair this checkout resolves - declared `react ^19.2.0` and
`scheduler ^0.27.0` in `package.json`, one copy of each - and a bump that moves
the seam breaks the hold visibly, because a hold that no longer stands on it
keeps nothing and the pin's kept check goes red. The fix itself - the waits
running the flush before they read - is not version-bound; only the seam is.

The pin is the case "Esc closes the list when the plane's own flush lands
late" in `test/repository-select-panel.test.ts`: the hold stands up for the
loaded case, the open's commit stands in the rig's hand, and the green run
asserts the hold kept at least one flush. The probe that re-opens the red
stands in the pin's own doc: delete the `flushPassiveNow();` line of the poll
loop in `awaitFrame`, and the pin goes red at the deadline on "the list to
open". Re-measured on this head at `82b5e640`: red at 10029.65 ms, and all
thirteen other cases in the file stay green. The earlier round recorded the
same probe at 10.05 s.

### What the fix holds

- `test/app-harness.ts`: every `awaitFrame` poll flushes before it captures;
  `closeOverlay` flushes before it snapshots; the key-bus waits flush per poll
  through the shared `awaitKeyBus` loop. The fixpoint the walk takes is named
  in the hold's file as `FLUSH_FIXPOINT_ROUNDS` (8): a commit the walk lands
  queues one flush, and a flush it runs can queue the update it settles, so
  two rounds settle a commit and its flush, and the bound is a margin over
  that shape, not a measured depth.
- `package.json` / `bun.lock`: `scheduler` as a dev dependency, the same
  0.27.0 the reconciler already resolves.
- No `src/` change: the app was sound; the waits owed themselves a flush they
  did not run.

### The sweep

Counted on the merged tree (the head above `origin/main`):

- 814 direct `awaitFrame` sites in 34 test files: 813 on
  `FRAME_DEADLINE_MS`, one on its own 350 ms in `ticket-grouping-frame`.
- 986 press-family sites that each await one frame through the harness (647
  `press`, 217 `pressArrow`, 89 `pressReturn`, 19 `pressEnterQuiet`, 12
  `pressScrollKey`, 2 `pressQuiet`).
- 188 open- and close-helper sites (32 `closeOverlay`, 13 `confirmPanel`, 143
  open helpers), each one frame plus one key handler.
- 193 key handler waits (5 direct, the rest through the helpers).

The ones that can end only on a pass the plane does not owe are the 193 key
handler waits: they end on the passive-effect flush, the mount subscribe and
the unmount unsubscribe, owed to the reconciler, not to the renderer. Every
wait on the deadline now runs `flushPassiveNow` per poll before it reads. The
counts stand in the `FRAME_DEADLINE_MS` doc in `test/app-harness.ts`, and the
corrected counts supersede the 807 / 985 / 192 the first round recorded before
the rebase onto the `#316` tree.

### The loaded runs, and the reds they turned

A 28-loop load rig (load 31 to 41), three full runs on the branch before the
rebase (head `4a3291e1`):

| Run | Result | Reds, named by file and case |
| --- | --- | --- |
| 1 | 3068 pass / 0 fail | - |
| 2 | 3065 pass / 3 fail | `test/action-bar.test.ts` - "q quits from both base panes" at 721 ms; `test/executable-fields.test.ts` - "opens the launcher" at 10.0 s; `test/consultation-frame.test.ts` - "a rejected prompt keeps the draft" at 262 ms. Re-run alone under the same load: 12 of 12 green for the first two, 11 of 12 for consultation-frame (its one red was a different case, "a launch stays on the launched Consultation", 461 ms), so load flakes by the triage rule |
| 3, the second full-suite red | 3067 pass / 1 fail | `test/ignored-ticket.test.ts` - "a start the operator asked for after an ignore still runs", at 10.2 s in the wait for the Agent start command. The file passes alone under the same load (7 of 8), and the same case missed the same way on the base commit under the same load (1 of 8): pre-existing, and a different class - that wait's end is an app dispatch through the runner, not a passive flush, so the fix here does not cover it. Recorded, not fixed |

The pseudo-terminal miss in run 2 is the one the issue's own table names at
10007.09 ms in the earlier branch run. That seam is not covered by this fix -
nothing in `test/executable-fields.test.ts` runs the harness's flush, and the
rig's waits stand at 12000 ms and 8000 ms, so which wait missed there is not
measured - and it is filed on 2026-10-06 as
[issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321).
That is the scope decision: the fix answers the harness's waits, and the
pseudo-terminal seam is a sibling issue, not a widening of this branch.

### Which wait missed, recorded

The case holds two `awaitFrame` waits and a gone-wait, and the run's record
carries the case name only. The attribution stands at the reproduction layer
and the loaded-iteration layer, and this record does not extend it past that:

- The pin's probe ties the open-side wait ("the list to open") to the deadline
  miss under the held shape: red at 10029.65 ms on this head, measured above.
- The loaded-iteration run ties the loaded miss to the close-side gone-wait:
  9 misses in 2160 iterations of the case, all at the deadline, all in the
  gone-wait, in the window between the commit the open drew and the subscribe
  it owed.
- A deterministic close-side red at the unit layer was not reached on this
  round. A probe that stood the hold before the open missed the close's commit
  entirely - the close never drew, which is a shape the case does not walk -
  and that probe is not a reproduction of the case's gone-wait. The gone-wait's
  exposure is the snapshot window measured at 2 to 6 ms, and the
  2160-iteration record above stands for it.

### The gate on this head

On `82b5e640` plus the rework commit, merged tree (level with `origin/main`
at `0a37b118`), load 1.22 before, no other `bun test` on the machine:

| Check | Result |
| --- | --- |
| `bun run lint` | Clean over 310 files in 147 ms |
| `bun run typecheck` | Clean |
| `bun run docs:build` | Complete in 1.67 s |
| `bun run test` | 3102 pass / 0 fail across 141 files in 38.53 s (17,245 `expect()`) |
| `bun run test test/repository-select-panel.test.ts` | 14 pass / 0 fail in 1.97 s (31 `expect()`) |

### The review rework round (2026-10-06)

The review of the branch scored it 76 / 100 and asked for seven changes. Each
is recorded with what it became, in this section and in the pull request's
body, which the rework rewrote from the issue's text into the fix's record:

| The review asked for | What it became |
| --- | --- |
| The branch sat on `25937453` and `origin/main` had moved to `0a37b118` | Rebased; the rebase takes the #316 tree whole, and the gate above ran on the merged tree |
| The body's sweep counts stand at the pre-rebase reading (807 / 985 / 192), and its Live view sentence describes a rewrite the rebase dropped | The body is rewritten: the sweep stands at 814 / 986 / 193 on the merged tree, and the Live view cases are re-pointed to the #316 version of `test/live-view.test.ts` that `origin/main` landed, so the sentence no longer describes this branch's work |
| The second full-suite red is not named by file and case | Named above: `test/ignored-ticket.test.ts` - "a start the operator asked for after an ignore still runs", at 10.2 s, with the three reds of run 2 named in the same table |
| The fix is not recorded in the gate record, and the #311 rows stand stale | This section, and the CI load flake row in [the table below](#what-was-not-measured) re-pointed to it |
| The pseudo-terminal miss's scope is not stated | Stated above: filed as [issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321), out of scope for this branch |
| The record does not say which wait the original loaded run missed | Recorded above: the pin ties the open-side wait, the 2160-iteration run ties the loaded miss to the gone-wait, and the single full-suite miss is not attributable from the run's own record |
| The 8-round fixpoint bound is unnamed, and the seam's version stand is unstated | `FLUSH_FIXPOINT_ROUNDS` in `test/passive-flush-hold.ts` carries the bound and why it is a margin, and the file's doc pins the seam to the `react 19.3.0` / `scheduler 0.27.0` pair the checkout resolves |
## Issue #312: the Decision modal's pop-in check samples a 300 ms wall-clock window (2026-10-06, the fix)

[Issue #312](https://github.com/SeriousJul/my-little-software-factory/issues/312) is
the fourth mechanism [the named red cases](#the-named-red-cases-on-the-same-tree)
filed. The case `test/decision-modal.test.ts` - no content ever reaches the
terminal's edge while the box grows - sampled the painted buffer for 300 ms of
wall-clock time after one key. On a loaded runner the pop-in's first paint lands
past the window, the sample reads no frame that holds `Decision:`, and the guard
fails at about 0.4 s with "the modal never rendered during the burst; the pop-in
window was missed" - before the pop-in the check exists to inspect happens. That
is the rule on [the quality gate page](../development/quality-gate.md), "A test
does not stand on wall-clock time". The neighboring failure mode, a wait that
ends successfully on the wrong frame, is [issue #304](https://github.com/SeriousJul/my-little-software-factory/issues/304);
this one ends on no frame at all.

### The reproduction, on the real application flow

The loaded runner is a synchronous hold of the event loop, 400 ms, placed in
the working tree and never committed: `const held = Date.now() + 400; while
(Date.now() < held) {}`. The hold consumes the window and delays the pop-in's
first paint past it: the renderer schedules its paints on timers, and a timer
does not fire on a loop that is held. The hold's placement decides whether
the pre-fix check sees it, and the red stands on the placement after the
pre-fix file's `const deadline = Date.now() + 300;` line: the deadline is
set before the hold, the hold runs past it, and the sample loop reads no
frame that holds `Decision:`. Placed right after the key instead, the old
check sets its deadline after the hold, the pop-in lands inside the window,
and the old check goes green.

| State | Result |
| --- | --- |
| The pre-fix case, the hold after the `const deadline = Date.now() + 300;` line | Red at 445.71 ms on "the modal never rendered during the burst; the pop-in window was missed", Expected > 0, Received 0; the other 11 records in the file green; re-run at 445.63 ms on the rework's base, [the probe below](#the-probe-re-runnable-on-the-pushed-head) |
| The pre-fix case, the hold right after the key | 12 pass / 0 fail, the pop-in record at 749.41 ms: the deadline is set after the hold, and the pop-in lands inside the window |
| The same tree, the file alone, no hold | 12 pass / 0 fail in 3.94 s, the load flake the triage rule records |

### The fix

The window is a fact about the frame stream, not about the clock. The case now
waits for the first frame that holds `Decision:` with the harness's deadline,
and a miss names that wait. It then checks every painted frame up to the
settled size through a new harness wait, `awaitFrameChecking` in
`test/app-harness.ts`: it runs its check on every frame it reads on the way,
the frame that ends the wait included, and ends on the harness's deadline like
`awaitFrame`. The settled frame is the one whose box border stands one cell in
from the terminal's last column, the predicate the window check already used,
and it is checked like the frames before it. The count that came to zero is
gone.

The buffer holds only the frame last painted. The case polls the buffer every
5 ms, faster than the pop-in's own 16 ms tick, so a painted frame is not
replaced in the buffer before a read on a quiet machine. The poll is a
parameter of the wait, and its doc states the rule a caller that must read
every painted frame has to meet.

The review round scored the branch 72 / 100 and reworked it on the tree
rebased onto `origin/main` at `1ccbf930`. The #311 fix that landed there
makes every frame wait in `test/app-harness.ts` run `flushPassiveNow()` per
poll before it reads, so a loaded runner cannot land the flush 2 to 6 ms
after the frame the poll reads. The rework took the same shape here: the two
waits are one loop, `awaitFrameChecking` runs the flush per poll before it
captures, and `awaitFrame` is that loop with a no-op check. The wait stands
on `FRAME_DEADLINE_MS`, and the #311 sweep at that constant, in the harness's
doc, names it. The poll argument stands before the deadline, so the case
passes its 5 ms poll without an explicit `undefined`.

### The probe, re-runnable on the pushed head

The case's header writes the step and the placements. Put the same 400 ms
hold in the working tree, `const held = Date.now() + 400; while (Date.now() <
held) {}`. In the pre-fix file, the hold goes red on the old window check
only after the `const deadline = Date.now() + 300;` line; right after the key
it goes green there. In the fixed file, the waits set their own deadlines
after the hold, so the pop-in record stays green with the hold in place after
the key. The hold was removed before the commit.

| State | Result |
| --- | --- |
| The pre-fix file, the hold after the `deadline` line, re-run on the rework's base | Red at 445.63 ms on "the modal never rendered during the burst; the pop-in window was missed", Expected > 0, Received 0; the other 11 records in the file green |
| The pre-fix file, the hold right after the key, re-run on the rework's base | 12 pass / 0 fail; the pop-in record at 749.41 ms |
| The fixed case, the hold right after the key | 12 pass / 0 fail; the pop-in record at 539.10 ms, the hold plus the pop-in it waited for |
| 10 consecutive runs of the fixed file, no hold | 10 of 10 green, 12 pass / 0 fail each |

### The gate on the rework, at `36d47dab`

| Check | Result |
| --- | --- |
| `bun run lint` | Clean over 310 files in 135 ms |
| `bun run typecheck` | Clean |
| `bun run docs:build` | Complete in 1.64 s |
| `bun run test`, the gate run, on the tree rebased on `origin/main` at `1ccbf930`, load 0.81 before and 0.75 after, no other `bun test` process on the machine | 3102 pass / 0 fail across 141 files in 38.16 s (15,684 `expect()`) |

The gate of the first round, at `1a1e090a` on the tree rebased on
`origin/main` at `a0929ccf`, stands recorded in the first version of this
section: 3101 pass / 0 fail across 141 files in 38.37 s (15,601
`expect()`), lint clean over 309 files in 137 ms, typecheck clean.

### What this fix did not measure

| Item | State |
| --- | --- |
| The full suite under the 96-busy-loop load rig the [issue #304 section](#issue-304-settle-reads-a-stable-frame-as-a-finished-transition-2026-10-06-the-fix) used | Not run. The 400 ms hold is the local equivalent of that state at the case's own seam: it holds the event loop the same way and is re-runnable from the case's header. The gate run above ran on a quiet machine |
| A painted frame replaced before a read on a loaded runner | Not closed. The 5 ms poll outruns the 16 ms tick on a quiet machine; under load the tick stretches wider than the poll, and a frame can be replaced before a read. The window check the case replaces had the same exposure at its own 5 ms poll, and the check now reads every frame from the first paint to the settled size, a superset of the 300 ms window |

## Issue #321: pseudo-terminal waits miss their deadline under load in the executable-fields rig (2026-10-06, the fix)

[Issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321) is the
pseudo-terminal seam [the #311 section](#issue-311-frame-waits-still-miss-the-deadline-under-load-in-the-surfaces-the-302-fix-does-not-touch-2026-10-06-the-fix)
left standing: `test/executable-pty.ts` drives the built executable through a real
terminal, and its two waits, `waitFor` on the bytes a step owes and
`waitForStable` on output silence, both stood on a fact a loaded child process does
not owe on time. The frame-harness fix of [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311)
cannot reach this seam: the parent process cannot run the child's reconciler flush
before it reads, because the flush lives in the child. The two windows were measured
separately, and each took its own fix.

### The two windows, measured

**The evidence window, in the rig.** The rig's `waitForStable` ended on output
silence: read the PTY, and when the read comes back unchanged for the stable
interval, call the screen settled. Silence on the parent's read is not a fact about
the child's commits: the child's React reconciler flushes its passive effects on
the child's own scheduler, and a loaded child can sit silent on the parent's read
while a commit that puts a row on the keyboard is still pending in the child. The
keys the rig sent in that gap were typed into the row that no longer held the
keyboard, or dropped where no handler claimed them, and the wait the next key owed
then missed its deadline with no byte ever painted.

**The open window, in the source.** `useControlDispatch` subscribed a surface's
controls in a passive effect, through the `useKeyboard` hook. The subscription
therefore landed in the flush after the commit that drew the surface's first
frame, and on a loaded host that flush stands open past the frame by far more than
a keypress. A key the operator sent as the frame stands reached the shell's own
handler, which sees the open surface and returns without claiming, and no other
handler was subscribed yet: the key was dropped. The frame harness had named the
hazard in `openLauncher`'s doc, "a key sent before the launcher's key handler
subscribes is dropped by the shell below", and closed it for its own tests with a
wait on the bus subscription, `awaitNewKeyHandler`. The pseudo-terminal seam has
no bus to wait on, so the window stood open there.

### The reproduction, on the real application flow

The loaded runner is the double: 72 busy loops on the machine, and two concurrent
PTY suites each iterating `bun test test/executable-fields.test.ts
test/executable.test.ts test/terminal-desync.test.ts` against the same tree. On
the tree with the rig's evidence waits landed and the source pre-fix, all 25
iterations of one of the suites went red, load 73.7 to 75.3, on the same named
wait: `test/executable-fields.test.ts` - refuses a non-digit paste in the Context
window row - timed out at about 9.5 s on the `waitFor` for the focus marker on the
Initial input row, the marker the TAB after the launcher's open owes. The TAB had
been dropped in the open window: the launcher's dispatch was not yet subscribed
when the key reached the shell, so no frame ever painted the marker.

### The fix

**The rig, in [commit `32836ff5`](32836ff5).** The rig's input now stands on the
painted fact the previous key owed, not on a silence. The four post-TAB settles in
`test/executable-fields.test.ts` wait for the focus marker the TAB owes, `rowHoldsFocus`
on the row that takes the keys: the marker can only be painted by the commit that
put the row on the keyboard, so the wait ends on the fact the next key needs.
`test/terminal-desync.test.ts` waits for the decision modal's painted title after
its open key, the same way. And the four boot settles take a `requireChange`
flag: the old settle could end on the silence of an empty buffer, before the child
painted anything at all, and the silence before the first paint is not a live app.
The flag makes the boot wait observe at least one frame before it declares
stability, and its error tells the two cases apart, no frame painted against a
frame that never settled.

**The source, in this commit.** `useControlDispatch` takes the keys in the commit
that draws the surface's first frame, and gives them back in the commit that closes
the surface. The subscription is a layout effect on the renderer's key bus,
`renderer.keyInput`, so it stands when the frame stands, and its cleanup runs in
the close's commit, before the fallback frame is drawn, the way the #317 flag
already required. The bus holds one stable wrapper per surface, and the wrapper
calls the dispatch the latest render built, so a key resolves against the facts
the frame the operator sees states. The close side keeps its guarantee: the
liveness flag drops in the close's layout pass, and a key in the window between
the fallback frame and the cleanup reaches no behavior. Every surface the
catalogue drives takes the fix through this one hook: the Consultation launcher,
the decision modal, the utility overlays, the response editor, and the Repository
select. The shell's own boot-side subscription was left on its passive hook: the
boot flush is queued at the first commit, the parent cannot write a key until it
has read a painted frame, and the frame paints after that commit, so the flush
runs before the key's bytes are parsed on every run measured here.

### The sweep: the byte waits and their exposure

The sweep walked every wait in the pseudo-terminal seam on the post-fix tree:
49 byte waits, 41 in the three test files and 8 in
`scripts/screenshot-fixture.ts`.

| Kind | Count | Where |
| --- | --- | --- |
| `waitFor` on the bytes a step owes | 34 | 29 in the test files, 5 in the fixture |
| `waitForStable` with `requireChange`, the boot settles | 4 | 1 in `test/executable-fields.test.ts`, 2 in `test/executable.test.ts`, 1 in `test/terminal-desync.test.ts` |
| `waitForStable` on pure silence | 9 | 6 in the test files, 3 in the fixture |

The 34 evidence waits owe their bytes: they end only when the expected bytes are
painted, and a loaded child that never paints them names its wait at the deadline
instead of passing. The 4 boot settles owe their change pass and not their silence
pass: they observe at least one frame, then wait for the paint to stop. The 9
pure-silence settles stand on the ordering the source fix states: each is preceded
by painted evidence or by a key that owes nothing, and the key sent after them
depends on no commit still pending in the child, because the child's event loop
drains the flush it queued at the commit before it parses the bytes the parent
writes after reading the painted evidence. The fixture's first capture is a pure
silence with no painted evidence before it, and the walk that follows throws on
an empty screen, a named failure rather than a silent pass.

### The gate

| Check | Result |
| --- | --- |
| `bun run fmt`, `bun run lint`, `bun run typecheck` | Clean; lint over 310 files in 424 ms, no fixes |
| `bun run docs:build` | Complete in 2.98 s |
| The 11 frame files the dispatch change touches, quiet machine | 240 pass / 0 fail across the two batches, 6 field files in 14.29 s and 5 flow files in 52.21 s |
| The double load, post-fix, the same rig the reproduction ran | 30 of 30 iterations green: two concurrent suites, 15 iterations each of the three PTY files, 72 busy loops, load 12.9 rising to 75.2 over the run, 16 pass / 0 fail per iteration, 480 passes total. The pre-fix tree on the same rig stood at 25 fail of 25 on the one suite measured there |
| The push gate, the merged tree, `bun run test` on the tree rebased on `origin/main` at `207e61be`, under the 28-busy-loop standing rig, load 25.07 after the run, no other `bun test` process on the machine | 3132 pass / 0 fail across 141 files in 39.60 s (15,623 `expect()`) |

### What this fix did not measure

| Item | State |
| --- | --- |
| The shell's boot-side window | Closed by the ordering the source fix states, green in every run measured here, not measured as a window the way the open window was. The shell's own `useKeyboard` was left on its passive hook on purpose: moving it is a second timing change with no measured red behind it |
| The fixture's first capture | A pure silence before painted evidence, and it could end on the empty buffer the way the boot settles could before `requireChange`. The walk that follows throws on an empty screen, so a miss is named rather than silent |
| The double load beyond the 30 iterations measured | Not run. The 30 green iterations stand on the same rig the 25 red ones did, and the record does not extend the claim past that count |
| The live terminal walk, the screen-reader path | Open, as [the shared control record](./shared-controls.md) states. The fix changes when a surface's keys are live, and the walk has not been re-run on that change |

## What was not measured

| Item | State |
| --- | --- |
| A real `git push` to `github.com/SeriousJul/my-little-software-factory` with the hook installed | Passed. The push of `main` ran the hook: `pre-push: bun run lint` (302 files, no fixes), `pre-push: bun run typecheck`, `pre-push: lint and typecheck clean, and no branch behind its remote-tracking ref`, and `370563f5..724dc3ec main -> main` landed |
| The hook installed in the operator's checkout | Passed. `git config core.hooksPath scripts/git-hooks` is set in this checkout, and the push above is the proof it is live. The setup line stays a documented step on [the commands page](../development/commands.md) for every other checkout |
| The doc-claim rule, the rename sweep, the documented-line rule, the probe rule, the determinism rule, the fake-fidelity rule, the file-the-defect rule, the failure-mode sweep, and the reporting rules | First measured by the self-review round above, on `b3b5fc38`: the probe rule, the rename sweep, the determinism rule, the file-the-defect rule, and the doc-claim rule each produced a result there, and the doc-claim rule found the stale cost numbers. What stays incomplete is the round's value: every commit was written by the agent that wrote the rules, so this is self-review, and a round on a pull request from a different author is the first independent measurement |
| The 14 domain types in `UNREAD_TYPE_BASELINE` | Answered on 2026-10-05 in [the section above](#issue-301-the-14-unread-domain-types-2026-10-05): each name took one of [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301)'s three answers and the baseline stands empty. What stays unmeasured is whether any of them is dead, which the check still cannot see, and it is recorded in that section |
| The CI load flake on the frame tests | Investigated on 2026-10-05 and filed as [issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302): four remote frame-deadline misses, the mechanism measured, no local reproduction, and no fix shipped on that evidence. The scroll half of it is answered on 2026-10-05 in [the section above](#issue-302-the-details-scroll-restore-waits-for-a-pass-the-plane-does-not-owe-2026-10-05-the-fix). The deadline miss that survived that fix is [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311), answered on 2026-10-06 by the fix in pull request [#318](https://github.com/SeriousJul/my-little-software-factory/pull/318): the harness's waits run the reconciler's flush before they read, and the pin stands in `test/repository-select-panel.test.ts` - recorded in [the #311 section above](#issue-311-frame-waits-still-miss-the-deadline-under-load-in-the-surfaces-the-302-fix-does-not-touch-2026-10-06-the-fix). The pseudo-terminal seam that stood beside the class is answered on 2026-10-06 in [the section above](#issue-321-pseudo-terminal-waits-miss-their-deadline-under-load-in-the-executable-fields-rig-2026-10-06-the-fix): the rig's input stands on the painted fact the previous key owed, and the open window between a surface's first frame and its key taking is closed in the source, in [issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321). The older records in [the shared control record](./shared-controls.md) and the pull request records stand |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, as [the shared control record](./shared-controls.md) states. The gate is a claim about the automated checks and the tree they ran on, and it extends no further |
