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
| The domain rule is not in the domain docs | `GLOSSARY.md`'s Live view entry states the cycle bound as a fact of the screen, [docs/operation/live-view.md](../operation/live-view.md) tells it to the operator, and [ADR 0110](../adr/0110-the-live-view-is-one-work-cycles-screen.md) states the decision, its considered options, and the general rule: a screen bounded by a transition reads the durable form of it, not a state the write only passes through. ADR 0072 stands unedited, corrected there for the screen |
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
  the key-bus waits flush per poll through the shared `awaitKeyBus` loop. The
  close-side flush the fix added to the retired `closeOverlay` stands in the
  rig's named close operations now: the dead raw input operations, the
  operation among them, left the rig's interface with ADR 0128's addendum.
  The fixpoint the walk takes is named in the hold's file as
  `FLUSH_FIXPOINT_ROUNDS` (8): a commit the walk lands queues one flush, and a
  flush it runs can queue the update it settles, so two rounds settle a commit
  and its flush, and the bound is a margin over that shape, not a measured
  depth.
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
rig's waits stand at 12000 ms, 8000 ms, and the rig's own 15000 ms default, so
which wait missed there is not measured in the run's record - and it is filed on
2026-10-06 as [issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321),
where [the wait it stood on is named from the layout](#the-original-1000709-ms-miss-named-from-the-wait-layout).
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
when the key reached the shell, so no frame ever painted the marker. The 25 red
ran on `seriousarch`, the machine this branch's worktree stands on. The 2026-10-06
review of this branch could not confirm the red there: on the exact pre-fix tree
`32836ff5`, the same double ran 17 iterations - 72 busy loops, then 272 busy
loops at load 97 to 239 - and every iteration stood green. The rework round of
2026-10-06 re-established the red on the same machine: on `32836ff5` under 72
busy loops, load rising from 8.59 to 72.37 over the run, and two concurrent
suites of 10 iterations each: the fifth iteration of one suite went red at
9612.94 ms on the same named wait, the `waitFor` for "the focus to reach the
Initial input row", while the other suite stood green 10 of 10.

### The original 10007.09 ms miss, named from the wait layout

The original miss - the same case, at 10007.09 ms in the #311 branch run - ran
on the pre-naming layout, and its record carried the case name only. That
layout still names the wait it stood on. The waits in the case stood at
12000 ms for the alternate screen, 8000 ms for each of the three
`waitForStable`, 15000 ms for the launcher title - the rig's default where the
call named no deadline - and 8000 ms for the paste's `waitFor`, with the test's
own deadline at 40000 ms. A total of 10007.09 ms is below both 12000 and
15000, so the miss cannot stand on the alternate screen or the launcher title:
each of those goes red at or past its own deadline, and the alternate screen is
the case's first wait. It stands on one of the 8000 ms waits that started about
2000 ms into the test. The three silences end on the first 300 ms of stillness
and take the deadline only while the child paints without stop for 8 s, and the
case's quiet-machine run paints nothing after the paste. The wait the dropped
TAB leaves unpaid in this layout is the `waitFor` for the pasted text: the
paste reaches the Draft field only if the TAB moved focus there, and the
mechanism the pre-fix red above measured is that drop. The miss therefore stood
on the `waitFor` for "the pasted text to reach the Draft field as text", at its
8000 ms deadline, about 2000 ms into the test. The attribution stands at the
reasoning layer: the run's record carried no wait line, and the pre-naming
rig cannot print one, so the wait is named from the layout's arithmetic and
the mechanism, not captured.

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
42 byte waits, 34 in the three test files and 8 in
`scripts/screenshot-fixture.ts`.

| Kind | Count | Where |
| --- | --- | --- |
| `waitFor` on the bytes a step owes | 29 | 24 in the test files, 5 in the fixture |
| `waitForStable` with `requireChange`, the boot settles | 4 | 1 in `test/executable-fields.test.ts`, 2 in `test/executable.test.ts`, 1 in `test/terminal-desync.test.ts` |
| `waitForStable` on pure silence | 9 | 6 in the test files, 3 in the fixture |

The 29 evidence waits owe their bytes: they end only when the expected bytes are
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

### The review rework round (2026-10-06)

The review of this branch scored it 78 / 100 and asked for three changes.
Each is recorded in the place it lands:

| The review asked for | What it became |
| --- | --- |
| The sweep's counts stand at 49 waits, 41 in the test files, and the `waitFor` row at 34 with 29 in the test files, while the table's own rows sum to 47 | Re-counted on the post-fix tree: 42 waits, 34 in the three test files and 8 in the fixture, and the `waitFor` row at 29, 24 in the test files and 5 in the fixture. The table's rows now sum to the total |
| The record never says which wait the original 10007.09 ms miss stood on | [The subsection above](#the-original-1000709-ms-miss-named-from-the-wait-layout) names it from the wait layout the miss ran on: the `waitFor` for the pasted text, at its 8000 ms deadline, with the arithmetic that rules the 12000 ms and 15000 ms waits out |
| The 25 fail of 25 pre-fix red is not named to a machine, and the review's own 17-iteration re-run on the pre-fix tree to load 239 stood all green | The red is named to `seriousarch` in the reproduction and re-established there in this round, on `32836ff5` under 72 busy loops: the fifth iteration of one concurrent suite red at 9612.94 ms on the focus-marker wait, the other suite green 10 of 10. The review's 17 green iterations stand recorded in the reproduction |
| The gate line's 15,623 `expect()` count does not match this tree's 15,903 on the same 3132 pass | The gate run below carries the count this round measured |

The gate on the rework head, the merged tree (level with `origin/main` at
`207e61be`):

| Check | Result |
| --- | --- |
| `bun run lint` | Clean over 310 files in 147 ms, no fixes |
| `bun run typecheck` | Clean |
| `bun run docs:build` | Complete in 1.80 s |
| `bun run test`, the first run after the red re-establishment | 3131 pass / 1 fail across 141 files in 40.98 s (15,575 `expect()`): `test/terminal-desync.test.ts` - repaints the screen after the terminal drops bytes from a frame - red at 15977.50 ms with the machine still at load 10.0 from the 72 busy loops of the red re-establishment above, and green alone in 5.13 s. A load flake by the triage rule, recorded as evidence, not a pass |
| `bun run test`, the gate run, machine at load 2.52 before and 2.26 after, no other `bun test` process on the machine | 3132 pass / 0 fail across 141 files in 38.25 s (15,863 `expect()`) |

### What this fix did not measure

| Item | State |
| --- | --- |
| The shell's boot-side window | Closed by the ordering the source fix states, green in every run measured here, not measured as a window the way the open window was. The shell's own `useKeyboard` was left on its passive hook on purpose: moving it is a second timing change with no measured red behind it |
| The fixture's first capture | A pure silence before painted evidence, and it could end on the empty buffer the way the boot settles could before `requireChange`. The walk that follows throws on an empty screen, so a miss is named rather than silent |
| The double load beyond the 30 iterations measured | Not run. The 30 green iterations stand on the same rig the 25 red ones did, and the record does not extend the claim past that count |
| The live terminal walk, the screen-reader path | Open, as [the shared control record](./shared-controls.md) states. The fix changes when a surface's keys are live, and the walk has not been re-run on that change |

## Issue #360: the test suite's duplication stands as its own metric (2026-10-09, the landing)

The Quality audit runs jscpd once per duplication scope: the run over
`src scripts bin` stands as `duplicates`, and the run over `test` stands as
`test-dup`, with its own baseline count (ADR 0135). This section states what
was measured, on what head, and what was not measured.

### What was measured

| Piece | Value |
| --- | --- |
| Heads | `498db20d`, the head the metric lands on, and `f2f221fe`, the commit that adds the metric. `498db20d` stands level with `origin/main` at `95dfd69a` plus the branch's hold commit, and its `test/` stands byte-identical to the landing tree's `test/` |
| jscpd | 5.4.0, pinned as a devDependency, run with the settings `.jscpd.json` holds (`minTokens: 100`, `minLines: 5`) |
| The `test` scope, at `498db20d` | **282 clones**, 5,657 duplicated lines, 4.92% of the suite's TypeScript lines: 44 cross-file and 238 intra-file |
| The `src scripts bin` scope, at `498db20d` | 0 clones |
| The combined run, at `498db20d` | one jscpd run over `src scripts bin test` finds 282 clones, exactly the sum of the two scoped runs (0 + 282), and no clone spans the two scopes. Recorded as a measurement on this head, not as a permanent property |
| The baseline counts | `test-dup` lands at 282 in `.quality-baseline.json`, beside `measured-on` 498db20d. The other four counts stand at 0 on that head and on the landing tree, and the audit prints `OK` there |

The spec's 267-clone count was measured at head `3f5c7662`. The tree moved
between that head and the landing head, and the count the metric lands on
is the one the landing head stands at: 282.

### The threshold curve, measured over `test` at `498db20d`

`minLines` stands at 5, the pinned binary, one run per threshold:

| `minTokens` | Clones | Duplicated lines | Share of `test` | Cross-file | Intra-file |
| --- | --- | --- | --- | --- | --- |
| 35 | 3,088 | 31,428 | 27.30% | 620 | 2,468 |
| 50 | 1,666 | 20,379 | 17.70% | 294 | 1,372 |
| 70 | 773 | 11,691 | 10.16% | 115 | 658 |
| **100** (adopted) | **282** | **5,657** | **4.92%** | **44** | **238** |
| 120 | 162 | 3,744 | 3.26% | 22 | 140 |
| 150 | 81 | 2,186 | 1.90% | 10 | 71 |
| 200 | 18 | 683 | 0.60% | 2 | 16 |

`minTokens: 100` is the value ADR 0120 adopted for `src`. The flood ADR 0120
refused does not stand at the adopted threshold, and 282 is the same order
of backlog issue #356 already cleared to zero.

### The costs, measured at `f2f221fe`

| Run | Cost, three runs |
| --- | --- |
| `bun run audit`, whole | 1,082 ms, 1,119 ms, 1,113 ms |
| the type check | 357 ms, 362 ms, 360 ms |
| the Biome run | 205 ms, 207 ms, 209 ms |
| jscpd over `src scripts bin` | 23 ms, 28 ms, 25 ms |
| jscpd over `test` | 31 ms, 40 ms, 31 ms |

The second run adds a measured fraction of a second to the audit, and the
cost rows on [the quality gate page](../development/quality-gate.md) carry
these numbers at `f2f221fe`.

### The backlog, as the campaign will inherit it at `498db20d`

The 20 largest clones, at `minTokens: 100`, `minLines: 5`:

| First block | Second block | Tokens | Lines |
| --- | --- | --- | --- |
| `test/ignored-ticket.test.ts:1009-1064` | `test/ignored-ticket.test.ts:1100-1150` | 338 | 56 |
| `test/auto-mode.test.ts:1993-2030` | `test/auto-mode.test.ts:2048-2085` | 310 | 38 |
| `test/app.test.ts:109-165` | `test/app.test.ts:215-269` | 251 | 57 |
| `test/config.test.ts:136-193` | `test/config.test.ts:697-758` | 246 | 58 |
| `test/observation.test.ts:4549-4582` | `test/refresh.test.ts:39-72` | 240 | 34 |
| `test/plane-action-merge.test.ts:1869-1908` | `test/plane-action-merge.test.ts:1960-2000` | 238 | 40 |
| `test/live-view.test.ts:981-1014` | `test/live-view.test.ts:1092-1121` | 219 | 34 |
| `test/auto-mode.test.ts:2008-2030` | `test/auto-mode.test.ts:2391-2413` | 214 | 23 |
| `test/app.test.ts:330-379` | `test/app.test.ts:446-495` | 212 | 50 |
| `test/live-view.test.ts:1015-1046` | `test/live-view.test.ts:1285-1309` | 212 | 32 |
| `test/consultation-frame.test.ts:3554-3585` | `test/consultation-frame.test.ts:3639-3670` | 207 | 32 |
| `test/ignored-ticket.test.ts:913-936` | `test/muted-source.test.ts:432-456` | 205 | 24 |
| `test/repository-select-panel.test.ts:514-541` | `test/repository-select-panel.test.ts:582-609` | 205 | 28 |
| `test/plane-action-merge.test.ts:1061-1097` | `test/plane-action-merge.test.ts:1125-1163` | 204 | 37 |
| `test/live-view.test.ts:425-453` | `test/live-view.test.ts:460-487` | 199 | 29 |
| `test/live-view.test.ts:425-453` | `test/live-view.test.ts:502-529` | 199 | 29 |
| `test/plane-action-merge.test.ts:2150-2171` | `test/plane-action-merge.test.ts:2505-2529` | 199 | 22 |
| `test/state/ticketWorkCycle.test.ts:635-660` | `test/state/ticketWorkCycle.test.ts:683-708` | 195 | 26 |
| `test/handoff-dispatch.test.ts:2752-2794` | `test/handoff-dispatch.test.ts:2808-2851` | 194 | 43 |
| `test/handoff-dispatch.test.ts:4565-4581` | `test/handoff-dispatch.test.ts:4604-4618` | 192 | 17 |

The 44 cross-file clones (784 lines) concentrate in 23 pairs, and the ten
largest pairs hold 31 of the 44 clones and 604 of the 784 lines. Those pairs
are where a shared fixture removes the most at once:

| Pair | Clones | Lines |
| --- | --- | --- |
| `test/ignored-ticket.test.ts` <-> `test/muted-source.test.ts` | 9 | 195 |
| `test/state/handoff.test.ts` <-> `test/state/ticketWorkCycle.test.ts` | 8 | 98 |
| `test/state/handoff.test.ts` <-> `test/state/sourceFact.test.ts` | 5 | 58 |
| `test/state/consultationRecord.test.ts` <-> `test/state/handoff.test.ts` | 2 | 58 |
| `test/auto-mode.test.ts` <-> `test/live-view.test.ts` | 2 | 37 |
| `test/repo-init-stub.test.ts` <-> `test/repo-init.test.ts` | 1 | 38 |
| `test/security-source.test.ts` <-> `test/ticket-source.test.ts` | 1 | 37 |
| `test/observation.test.ts` <-> `test/refresh.test.ts` | 1 | 34 |
| `test/fake-source.ts` <-> `test/source-frame.test.ts` | 1 | 27 |
| `test/action-bar.test.ts` <-> `test/handoff-frame.test.ts` | 1 | 22 |
| 13 further pairs | 13 | 180 |

### The probes, re-run on the tree of `f2f221fe`

Each probe planted its block, ran `bun run audit`, and was reverted; a
`git status` came back clean after every probe. The tree of `f2f221fe`
stands byte-identical to the tree the landing commit pushes, over every
scope the audit reads.

| Probe | Result |
| --- | --- |
| 1, the duplication teeth: the `piScanLine` block of `src/turn-log.ts` pasted into the same file as a new top-level function | `duplicates` 0 to 1, `test-dup` stands at 282, exit 1, the finding `src/turn-log.ts:249 duplicate of src/turn-log.ts:830, 213 tokens` |
| 2, the cognitive teeth: a function in `src/turn-log.ts` whose body nests its way to a cognitive score of 21 | `cognitive` 0 to 1, exit 1, the finding `src/turn-log.ts:830 cognitive 21 over 15` |
| 3, the ratchet: `test-dup` lowered to 281 in `.quality-baseline.json` | exit 1, the count line `test-dup 282 / baseline 281` |
| 4, the secrets rule: a planted 32-character base64 token in `src/turn-log.ts` | `secrets` 0 to 1, exit 1, the finding `src/turn-log.ts:830 secrets Potential secret found.` |
| 5, the suite's duplication teeth: the `withholdFrameEvents` block of `test/app-harness.ts` pasted into the same file as a new top-level function | `test-dup` 282 to 283, `duplicates` stands at 0, exit 1 |
| 6, the independence of the two counts: the paste of probe 5 leaves `duplicates` at 0, and the paste of probe 1 grows `duplicates` while `test-dup` stands | the two counts move on their own baselines, one per probe |
| The narrowing, with probe 5's paste in place, `bun run audit --changed` | exactly one `test-dup` finding, `test/app-harness.ts:463 duplicate of test/app-harness.ts:1465, 161 tokens`, and the count line still states the whole count, `test-dup 283 / baseline 282` |

The plant of probe 5 chose a block with no existing clone partner, so the
paste adds exactly one clone, and the plants of probes 1, 2, and 4 keep the
other counts at 0, so each probe moves the one count it claims.

### The documentation check

The **Quality audit** and **Quality baseline** entries in `GLOSSARY.md`
were re-read against the code path that produces the behavior, as the
gate's "a claim a document makes is a claim the code keeps" rule requires:
neither entry names a scope, and both stand unchanged. The
`bun run audit` row in `docs/development/commands.md` names the checks, not
their scopes, and needs no wording change. No new ADR number collision:
`0135` is checked against `origin/main` at `95dfd69a`, where `0134` is the
highest number that stands.

### The gate on this branch

The branch was level with `origin/main` at `95dfd69a` (0 behind, 3 ahead)
before the runs, and every check below ran on the tree of `c019d37c`.

| Check | Result |
| --- | --- |
| `bun run lint` | clean over 320 files (143 ms), no fixes; the five standing warnings stand in files this change does not touch |
| `bun run typecheck` | clean (`tsc`, no output) |
| `bun run audit` | OK: type 0, lint 0, secrets 0, cognitive 0 / baseline 0, function 0 / baseline 0, params 0 / baseline 0, duplicates 0 / baseline 0, test-dup 282 / baseline 282, and 6 open code-scanning alerts |
| `bun run test`, once | 3241 pass / 0 fail across 147 files in 40.42 s (16,626 `expect()` calls). Load average 2.53 before the run and 1.99 after, 32 CPUs, and no other `bun test` process ran on this machine |
| `bun run docs:build` | complete in 1.57 s |

The cheap checks were re-run on the record commit `cd4d3971`: `bun run
lint` clean over 320 files (148 ms), `bun run typecheck` clean, `bun run
audit` OK with `test-dup` at 282 / baseline 282, and `bun run docs:build`
complete in 1.72 s. The only change after that run is this record's own
wording.

### What this change did not measure

| Item | State |
| --- | --- |
| Whether the two scoped runs ever miss a cross-scope clone | Measured at 0 at `498db20d` and recorded as a measurement on that head, not as a permanent property. A clone that ever appears is filed, not pre-built for |
| The audit's cost on another machine | Measured on this machine only, the way the page's other cost rows stand |
| The lowering of the 282 | Out of scope: the campaign that drives the count down is its own issue, in the shape of #350, and it works one metric at a time |
| The CI load flake on the frame tests, and `bun run mutate` | Open and outside the gate, as the standing records state |

## Issue #363: the test duplication campaign, the state and handoff suites' stage (2026-10-12, the landing)

The campaign drives the `test-dup` count down stage by stage. Each stage is a
shippable unit: it keeps the audit green, it states the count before and after
on the heads it measured, and it lowers the baseline only by replacement -
no jscpd setting moves (ADR 0121).

### What was measured

| Piece | Value |
| --- | --- |
| Heads | `ee89e153`, the branch head the stage starts from, standing level with `origin/main` at `241e63bb`; `66a4c9cc` and `76e08355`, the heads the state stage lands on; `2f02e125`, the head the stage lands on |
| jscpd | 5.4.0, pinned as a devDependency, run with the settings `.jscpd.json` holds (`minTokens: 100`, `minLines: 5`) |
| The `test` scope, at `ee89e153` | **271 clones** (34 cross-file, 237 intra-file), 5,662 duplicated lines, 3,169 `test(…)` sites |
| The `test` scope, at `66a4c9cc` | **226 clones** (15 cross-file, 211 intra-file), 4,938 duplicated lines, 3,167 `test(…)` sites |
| The `test` scope, at `76e08355` | **220 clones** (15 cross-file, 205 intra-file), 4,806 duplicated lines, 3,167 `test(…)` sites |
| The `test` scope, at `2f02e125` | **211 clones** (15 cross-file, 196 intra-file), 4,355 duplicated lines, 3,167 `test(…)` sites |
| The baseline counts | `test-dup` lands at 211 in `.quality-baseline.json`, beside `measured-on` 2f02e125 |

### What the stage changed

- `test/state/harness.ts` now holds the one standing every state suite needs: `seeded()` opens the world with the tickets the test names, in memory or on a file or on a fixed clock; `claim`, `settleAttempt`, and `settle` carry the Handoff; `turn` and `decide` carry the cycle's end; `downgradeToV2/V4/V5/V7` carry the older schema shapes the migration tests re-stamp. A test that asserts a claim or a settlement's result still calls the API; a test that settles the world only to stand behind its fact uses the harness.
- Eight state suites read their facts through the harness instead of re-opening and re-seeding the world test by test: `handoff`, `ticketWorkCycle`, `route`, `sourceFact`, `ignore`, `mute`, `consultationRecord` (its v4 downgrade now stands in the harness beside the one `state/handoff` reads), and `workQueue`.
- The stage's residual cleanup, at `76e08355`, reads the last standing through shared helpers: the downgrade tools share one drop of the post-v10 facts, the migration tests' schema check is the harness' `schemaObjects`, the route suite's handed-off turn and its two queue items are its own `handedOffTurn` and `queueBoth`, and the trace rows a `ticketWorkCycle` test verifies are read by one `traceRows` read.
- The handoff suite's stage, at `2f02e125`, reads its 117 handoff runs through the suite's `handoffRun` builder, which stands the base config, the open claim, and the home beside the overrides a case names. The branch the ticket takes stands once in the suite's `BRANCH` constant beside the worktree path that carries it, and the worktree choice stands once beside the default it overrides. Each case keeps its expected argv and its `expectNoCommand` claims literal: where the argv is the subject, the pin table is the correct adapter (ADR 0132). The suite drops from 64 clones over 1,608 lines to 23 clones over 353 lines, and the file from 6,919 lines to 5,860.
- The fixture literals the tests verify stand as written, and each test's distinct claim stays visible beside the shared standing.

### The gate on this branch

| Check | Result |
| --- | --- |
| `bun run lint` and `bun run typecheck`, on the merged tree | Pass, no findings |
| `bun run audit`, on the merged tree | Pass: `type` 0, `lint` 0, `duplicates` 0 / baseline 0, `test-dup` 211 / baseline 211, the 6 pre-existing CodeQL findings stand as open alerts |
| `bun run test`, on the merged tree | Pass: 3,320 tests, 0 fail, across 151 files. No other `bun test` ran on this machine while the suite ran |
| The state suites, alone | 229 pass, 0 fail, across the 16 files the stage touched and left untouched alike |
| The handoff suite, alone | 172 pass, 0 fail, its 662 `expect()` calls |

### The backlog the next stage inherits, at `2f02e125`

The remaining clones stand in the command-sequence suites whose other halves
the campaign still works, and in the frame suites the campaign's later stages
work (ADR 0132):

| File | Clones | Duplicated lines |
| --- | --- | --- |
| `test/handoff.test.ts` | 23 | 353 |
| `test/handoff-frame.test.ts` | 27 | 1,321 |
| `test/plane-action-merge.test.ts` | 20 | 1,082 |
| `test/auto-mode.test.ts` | 28 | 904 |
| `test/handoff-dispatch.test.ts` | 19 | 744 |
| `test/consultation-frame.test.ts` | 15 | 634 |
| `test/live-view.test.ts` | 12 | 548 |

The frame suites' duplicates stand in their `seededApp`, `withApp`, and
frame-wait preambles, and the `plane-action-merge` suite's stand in the git
sequences its pin tables pin: each is its own case-builder stage, beside the
`handoff.test.ts` builder that landed here. The 15 cross-file pairs stand in
the same suites, beside `repo-init-stub.test.ts` and `repo-init.test.ts` at
38 lines and `security-source.test.ts` and `ticket-source.test.ts` at 37.

### What this stage did not measure

| Item | State |
| --- | --- |
| The case builders for the command-sequence suites the stage did not reach | The handoff suite's builder landed at `2f02e125`. The `plane-action-merge` and `repo-init` suites' git pin tables, and the frame suites' preambles, are the next stages' work |
| The frame suites' clones | Untouched by this stage |
| The count on another machine | Measured on this machine only, the way the page's other cost rows stand |

## Issue #375: the auto-mode suite moves onto the world (2026-10-13, the landing)

The move is the campaign's next stage on `test/auto-mode.test.ts` (issue
#375): the suite's tests read their herdr and git side through the Stub
herdr world instead of the pin table's launch sequences, and the GitHub
side stays pinned, the way the world leaves it unmodelled.

### What was measured

| Piece | Value |
| --- | --- |
| Heads | `55a32d5c`, the head of `origin/main` the landing re-merges, where the `test-dup` baseline stands at 197; `76f86309`, the head the move lands on; `c3a58b1d`, the head of `origin/main` the rework round re-merges, past the landing's base; `67cb8e95`, the rework head beside it |
| jscpd | 5.4.0, pinned as a devDependency, run with the settings `.jscpd.json` holds (`minTokens: 100`, `minLines: 5`) |
| The `test` scope, at `55a32d5c` (before) | **197 clones** (14 cross-file, 183 intra-file), 4,091 duplicated lines, re-measured on this branch's base |
| The `test` scope, at `76f86309` (after) | **190 clones** (14 cross-file, 176 intra-file), 3,974 duplicated lines |
| `test/auto-mode.test.ts`, at `55a32d5c` (before) | 28 clones, 457 duplicated lines, 5,404 file lines |
| `test/auto-mode.test.ts`, at `76f86309` (after) | 21 clones, 340 duplicated lines, 5,294 file lines |
| The baseline counts | `test-dup` lands at 190 in `.quality-baseline.json`, beside `measured-on` 76f86309, and stands at 190 on the rework head `67cb8e95` |

### What the move changed

- The suite's fixture builds the world from the ticket's shape, its
  environment, and the agents and pane contents the test names, and the
  plane's herdr and git egress routes through the world: the launch
  sequences the pin table held stand once in the standing, and the test
  reads the world's calls for the commands it verifies.
- `test/herdr-world.ts` gains the routing egress the app-level suites
  share, the described worktree workspace's binding to the worktree
  herdr opened it from, and the `removeAgent` fact a test stands when an
  agent dies beside its pane.
- The suite's `stubCheckout` copy and its local launch builders are gone.
  A test that verifies a herdr refusal the world does not hold stands it
  on the world's override, and the settled tickets' `gh` reads and writes
  stay pinned on the suite's fallback runner.
- A standing agent now lists in the world the way herdr lists it, so a
  started agent's row keeps its Starting window's face on the settle
  instead of wearing the marker the older static pins left, and the tests
  that waited for that marker wait for the face with the Working line
  cleared.
- The landing re-merges `origin/main` past the branch's base: the suite's
  plane stands on the Seeded plane the `#378` stage landed, its fetched
  ticket reads from the shared fact fixture, and the tests whose seeded
  agent died stand their state clock past the startup grace the `#388`
  stage put on the boot's poll.

### The gate on this branch

| Check | Result |
| --- | --- |
| `bun run lint` and `bun run typecheck`, on the merged tree | Pass, no findings, on the tree beside `origin/main` at `c3a58b1d`; the one info-level note the lint stands beside is pre-existing on `origin/main` |
| `bun run audit`, on the merged tree | Pass at `67cb8e95`: `type` 0, `lint` 0, `duplicates` 0 / baseline 0, `test-dup` 190 / baseline 190, the 7 pre-existing CodeQL findings stand as open alerts |
| `bun run test`, on the merged tree | Pass at `67cb8e95` beside `origin/main` at `c3a58b1d`: 3,434 tests, 0 fail, 17,423 `expect()` calls, across 155 files, in 70.00 seconds. The count stands on `origin/main`'s re-merge past the landing's base, which carries #392's frame-rig tests, and on the rework round's one egress test; the `expect()` count moves with the polling load the run stands in. No other `bun test` ran on this machine while the suite ran (32 cores) |
| `test/auto-mode.test.ts`, the move's own suite | 94 pass, 0 fail, 461 `expect()` calls in the scoped run beside `67cb8e95`; the full run carries the suite green |
| The gate's tree and this record's tree | The full run reads `67cb8e95` beside `origin/main` at `c3a58b1d`; the pushed head adds only this table's markdown, which no test reads |

## Issue #398: the CI test flake, the week of evidence, and what it names (2026-10-15, the answer)

The week ending 2026-10-15 was investigated on pull request
[#401](https://github.com/SeriousJul/my-little-software-factory/pull/401) against
[issue #398](https://github.com/SeriousJul/my-little-software-factory/issues/398).

### What was read on the remote

Fifty-seven runs of `CI`, 2026-10-12 to 2026-10-15, a sample of the
week's runs:

38236560588, 38245491021, 38250398336, 38253444393, 38255652285, 38255964276,
38257653053, 38258997607, 38259861009, 38261319897, 38261339415, 38271874043,
38272186793, 38275540313, 38297174098, 38297189529, 38304692240, 38307466890,
38334111995, 38340692572, 38342612389, 38344294734, 38345261311, 38345276819,
38349792024, 38350464306, 38350479697, 38398321639, 38419688456, 38421625895,
38421651710, 38431838034, 38437786249, 38444823531, 38444970617, 38446259124,
38457027744, 38461511503, 38480269612, 38480669762, 38481377945, 38485714777,
38502067088, 38503981818, 38518396179, 38525408617, 38559532640, 38560591287,
38562479177, 38567181257, 38573286828, 38599346995, 38641754682, 38644930682,
38655106938, 38661144514, 38694947443.

The week's full population, 2026-10-04 to 2026-10-15, held 389 runs of
`CI`: 291 pull-request and 98 push, 170 of them red. The fifty-seven runs
read are a sample of the week's last three days, and the remaining 332 runs
of the population stand in the not-measured table below without a per-run
state.

Fourteen of the sample were push runs and forty-three pull-request runs.
Fifty-six of the fifty-seven went red on the `Run bun run test` step of the
`checks` job, and the one green run, `38562479177`, a push run, came back
with an empty log, so its step results are not stated here. The `site-build`
job passed on every run that ran it. The reds were never the whole suite: a
small cluster of cases failed in a different subset of the runs each time,
and the other 3400-plus tests passed on every run.

| Case | Runs red of 57 |
| --- | --- |
| `test/quality-audit.test.ts` - the audit command's `--changed` form | 43 |
| `test/consultation-launcher-editing.test.ts` - closing keeps the unfinished text | 33 |
| `test/auto-mode.test.ts` - the re-fire of a recorded skip | 24 |
| `test/live-view.test.ts` - the routed handoff from the decision sub-mode (ADR 0072) | 19 |
| `test/auto-mode.test.ts` - the auto dispatch's first cycle | 17 |
| `test/live-view.test.ts` - the route confirmed through the override (ADR 0072) | 4 |
| `test/repository-select-panel.test.ts` - the two-run queue's confirmation order | 1 |
| `test/message-line-source-health`'s case - the source health it records | 1 |
| `test/quality-audit.test.ts` - the dotfiles state the audit's values | 1 |
| `test/dispatch-pause`'s walk - the pause never stands with no row | 1 |
| `test/native-viewport`'s case - the monotonic complete frames | 1 |

The three recurring classes and what this round made of them:

1. **The audit test read a ref its runner did not fetch.** The `--changed`
   form narrows its findings to the files that differ from its changed base,
   which `.quality.json` names as `origin/main`. The runner's shallow
   checkout of a pull request fetches the pull's head and no remote branch,
   so `origin/main` is an unknown revision there, the script's `git diff`
   fails before it prints, and the test reads an empty payload. Measured on
   the 57 runs: the case went red on all 43 pull-request runs and on none of
   the 14 push runs, and a probe clone holding the runner's shallow pull
   checkout reproduced the empty payload and the non-zero exit on the
   unfixed tree. The test now pins its `--changed` run's base on `HEAD`, the
   one ref every checkout holds, and the check it is for stands unchanged:
   the counts stay whole whatever base narrows the findings.
2. **A log read at the painted frame.** The re-fire's case and the auto
   dispatch's case read the runner's command log in the same breath the frame
   their walk painted landed, and the start the frame stands ahead of is
   recorded a few milliseconds later: under the runner's load the read lands
   before the write, and the case failed in 122 ms, a fast failure, not a
   deadline miss. Both cases now wait on the log for the command, the way
   every other command wait in the suite stands.
3. **A Consultation operation settling after its run's state closed.** The
   launcher's case came back red with `RangeError: Cannot use a closed
   database` at `failConsultationOpening` called from `runOpening`, the
   stack read in run `38644930682`: an opening that stood mid-flight at the
   test's teardown kept running, and its first settlement wrote into the
   database the teardown had closed behind it. The app's stop stopped the
   Handoff dispatch and left the Consultation operations running, so the
   owner's ordering of the stop before the state's close held for one of the
   run's two background modules and not the other. `ConsultationOperations`
   now takes the dispatch's own stop rule: a `stop` the app's teardown runs
   beside the dispatch's stop, after which an in-flight operation runs its
   remaining commands and settles nothing, and an operation that starts after
   the stop starts no work. A regression case in
   `test/consultation-operations.test.ts` holds the start's command in a
   double, stops over the flight, closes the state behind it, and reads the
   record back: it is red on the tree without the stop, and the one that
   fails is the settlement, the way the run's stack named it.

The deadline class stands separate: the rig's one twenty-second wall-clock
deadline against an app whose loops run on the machine's clock. On a loaded
runner the app completes late, past the deadline, and the case fails with the
last frame dumped. The local A/B below is what this round measured of it.

### The local A/B, on this worktree

One machine, 32 cores, and every run pinned to two of them with `taskset`,
Bun 1.4.2, the suite's own flags. The hogs are busy loops pinned to the same
two cores, one per extra CPU of load, and they stood for the duration of the
run. No other `bun test` process ran on the machine during any of them.

The change was uncommitted on this worktree while the runs were made, so the
record names no commit for any of them. The no-load pair P1 and P2 report
3443 pass: that is the test count the base tree of this worktree holds, one
more than the 3442 the final tree runs. The pair measured the worktree in an
intermediate state, before it reached the final tree, and not the tree the
branch pushed.

| Run | Shape | Result |
| --- | --- | --- |
| P1 | the full suite, parallel, two cores, no load | 3443 pass / 0 fail in 211 s |
| P2 | the full suite, serial, two cores, no load | 3443 pass / 0 fail in 411 s |
| P3 | the full suite, parallel, two cores, four hogs | 2 fail, both at the twenty-second deadline, in 282 s |
| P4 | the full suite, serial, two cores, four hogs | 2 fail, both at the deadline, in 667 s |
| E1 | the full suite, parallel, two cores, two hogs | 3 fail at the deadline, in 377 s |
| E2 | the full suite, serial, two cores, two hogs | the same 3 fail at the deadline, in 729 s |
| L1 | the four flaky files, parallel, two cores, two hogs, the deadline raised to sixty seconds | the Live view's case and the ignore's case fail on the sixty-second deadline itself, the guide screenshots' case at 22.9 s, and the repository select panel's case passes, in 104 s |

The serial step was measured and rejected on this evidence: on two cores it
is no faster than the parallel pool, it is slower when the pool's workers
share the cores with the load (377 s beside 729 s), and under a steady
co-tenant load it reds the same cases the parallel pool reds. The step CI
runs stays `bun run test`. And the sixty-second deadline of run L1 did not
save the two cases that missed it: under that load they stood past any
deadline the suite can afford, the case for the stall mechanism standing on
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302),
which owns the rig's remaining wall-clock exposure. The two ADR 0072 follow
walks that carried the class in the week's evidence - the routed handoff's
case and the override's case, nineteen and four of the fifty-seven runs -
were removed with their removal note in `test/live-view.test.ts`, and the
facts they asserted, the route's ask ending the source's cycle and the
attention band holding the open band, stand in `test/domain.test.ts`,
`test/handoff-dispatch.test.ts`, and `test/auto-mode.test.ts`.

### The tail this round did not name

Five cases went red once apiece across the fifty-seven runs read: the
repository select panel's confirmation order, the Message line's source
health, the dotfiles' baseline values, the dispatch pause's walk, and the
native viewport's monotonic frames. No mechanism stood behind any of them
in this round: one failure apiece across the fifty-seven runs read gives no
pattern to read, and the dotfiles' case is the one whose red is explainable
as a cross-commit mismatch, its literal count standing beside a baseline
another commit moved. They stay in the suite, and the next red on any of
them is a data point for the issue that owns its class, not a new one.

### What this round did not measure

| Item | State |
| --- | --- |
| The 332 unread runs of the week's 389-run population | The fifty-seven runs read in the section above cover the week's last three days, 2026-10-12 to 2026-10-15. The remaining 332 runs of the population, 2026-10-04 to 2026-10-15, were not read individually, and no per-run state is stated for them |
| The runner's own co-tenant load | The hogs are a stand-in for a steady load on the two cores, and the runner's load is bursty at the hypervisor. No measurement of the runner's load itself was made, and the hogs do not measure it |
| The serial step on the runner | Rejected on the local A/B before any remote run of it. No run of the serial step was made on the remote in this round, and the workflow it would have changed was not pushed |
| The suite's result on the remote after this change | First measured in the rework round below, on the pre-rework head `5caab8d1`: the `CI` run `38721431002` passed the `Run bun run test` step, and no run on the reworked head was read as of that round |
| Whether a pull-request checkout of the branch's head carries `origin/main` | The 43-of-43 and 0-of-14 split is the measurement this round made of it, beside the probe clone. The checkout's own ref list was not read off the runner |

### The review round on the record, and the remote on the fixed head (2026-10-15, the rework)

The review of the pull request found three claims in the record above
wrong, and the rework corrects each in the place it stands, beside the
commit message:

- the fifty-seven runs read were presented as the week of 2026-10-04 to
  2026-10-15; they cover its last three days, 2026-10-12 to 2026-10-15,
  beside the week's full population of 389 runs, and the 332 unread runs
  now stand in the not-measured table;
- a count read "fifty-six of the seventy" where the sample is fifty-seven;
- the no-load A/B pair's 3443 test count was not pinned to a tree; the
  final tree runs 3442, and the pair measured the worktree before it
  reached the final tree.

The round read the remote result the record had deferred. On the pre-rework
head `5caab8d1`, the `CI` run `38721431002` passed the `Run bun run test`
step at 3442 pass / 0 fail, 17454 `expect()` calls: the first remote
measurement of the fixed tree. The `CodeQL` run `38721423857` on the same
head passed without running tests. The review also named one asymmetry in
the stop rule: the response's draft and pending line settle ahead of the
send's first guard, and the flag's comment now states it. The rework
changes only this record and that comment, and no run on the reworked head
was read as of this round.

## Issue #302: the merged panel pass keeps one instance's keys (2026-10-16, the fix)

The push run `38862876556` on `main` at `060eeabb` went red on the
repository select panel's two-run queue case, `a marking of two runs the
queue, one confirmation per row, in list order`, at 20675.98 ms: the rig's
twenty-second deadline on the wait for the keys the `Init acme/factory`
panel gives back after the cancel. This section is the investigation of that
run and the fix it named. The remote was read once, for this run and the
run list that places it; the rest of the evidence is local.

### The reproduction, at the unit layer

One machine, 32 cores, Bun 1.4.2, `bun run test` with its own flags, which
bun spreads over twenty workers here. The pre-fix tree, at `060eeabb`, went
red on the queue case in the first run of the session, at 20583.19 ms, load
1.64 before it, and red again in baseline run 1 at 20582.64 ms, load 1.13,
while baseline run 2, load 2.36, passed. The file alone passes on the same
tree: 14 pass / 0 fail in 4.67 s, load 1.77. By the triage rule of
AGENTS.md the full-suite red is a load flake, and the reproduction recipe of
[issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302)
- `bun run test` on a many-core box - held on this head, not only on the
heads the issue recorded.

### The mechanism, pinned by probe

Three probes stood in the tree for the red runs and came out again before
the fix landed: the key-bus wait's inter-poll gaps, the rig's owed
normal-priority callbacks per poll, and a mount and unmount trace of the key
bus's subscriptions in `useControlDispatch`.

| Fact | Reading |
| --- | --- |
| The wait's inter-poll gaps over its full twenty seconds | every poll about 10 ms apart, the largest gap 22 ms in one red run and 19 ms in another: the process was scheduled throughout, so the miss is not the OS withholding the process |
| The rig's owed callbacks, polled on every wait turn | zero on every poll of the failed wait: the `setPanel(null)` the cancel sends never stood in the normal-priority lane the rig's flush reaches |
| The factory panel's key handler on the bus | on at the open of `Init acme/factory`, off only at the worker's teardown, 20.1 s later: the handler never left the bus while the frame showed `Init acme/billing` and the queue had moved on |

The last frame of the red run shows the billing panel open: the queue did
advance, and the app behaved. What never settled is the rig's close contract.
`appRepoInitPanel` renders `createElement(ActionPanel, { ... })` with no
`key`, and the factory and the billing entries are the same element type at
the same place in the tree. The cancel sends `setPanel(null)` and the queue's
next entry sends `setPanel(billing)`; under load the two updates render in
one merged pass, the reconciler re-renders the factory panel directly into
the billing panel, the instance never unmounts, and the one stable key
handler the instance took when it mounted never leaves the key bus. The wait
that ends on that handler leaving can end on nothing, and it stands to the
deadline.

The merged pass is the ordering the loaded runner opens: on a quiet machine
the first update commits before the second arrives, the panel unmounts and
remounts, and the handler leaves. The app's own comment beside the skip
names the fact the key expresses: a panel the operator can still key into is
a stale act waiting to run twice.

### The fix: one element per entity

Every per-entity panel element now carries a `key` that names the entity it
stands for, so the reconciler cannot fold one entity's panel into another's:

| Surface | Key |
| --- | --- |
| the override panel | `override:<ticket>:<route>` |
| the Decision modal | `decision:<ticket>` |
| the Live view | `live:<ticket>:<work cycle>` - the cycle is part of the panel (ADR 0110) |
| the Missing modal | `missing:<ticket>` |
| the repository init panel | `repository-init:<repository>` |
| the ticket close, and the Consultation's safety, recovery, close, force, and delete panels | `<kind>:<identity>` |

The kind prefix is not decoration: the first shape of the fix keyed the
panels on the bare identity, and two consultation-frame cases went red on it,
at the opens wait, 20316.05 ms and 20489.05 ms. React matches keyed children
across the parent's whole child list, so the close panel of one consultation
and the force panel of the same consultation, both keyed by the bare id, were
matched as one element across the two renders, the instance reused, and the
force panel's handler - already on the bus from the close panel - could never
be seen as new. The prefix makes no two siblings of the list share a key,
and the two cases pass beside the other 81 of the two suites, 97 pass /
0 fail across the three files the fix touches most, in 41.98 s.

The kind prefix changes one behavior the operator sees: when the open panel's
entity changes - the open Decision modal following its ticket to another
ticket, the queue's confirm moving to the next repository - the panel stands
fresh: its cursor starts at the first row, and its keys are the new entity's.
Before the fix the instance, its cursor, and its key handlers carried over
across the entity. The fresh panel is what the close contract and the skip's
comment both already asked for.

### The verification, on this machine

| Run | Tree | Result |
| --- | --- | --- |
| The session's first run, load 1.64 | pre-fix, `060eeabb` | red on the queue case, 20583.19 ms |
| Baseline 1, load 1.13 | pre-fix | red on the queue case, 20582.64 ms |
| Baseline 2, load 2.36 | pre-fix | green, 3456 pass / 0 fail |
| Post-fix runs 1 to 3, loads 2.04, 1.28, 1.55 | fixed | green, 3456 pass / 0 fail apiece |
| Post-fix run 4, load 1.27 | fixed | did not complete: one test worker spun at about 100% CPU past every test's deadline and was killed. Recorded as [issue #403](https://github.com/SeriousJul/my-little-software-factory/issues/403), not as a pass or a flake |
| The base tree, load 1.23, in the same worktree with the fix checked out of the file | pre-fix | green, 3456 pass / 0 fail in 130.55 s |
| Post-fix runs 5 and 6, loads 1.95 and 1.43 | fixed | green, 3456 pass / 0 fail apiece |

The Quality audit on the fixed tree answers `audit OK`: type 0, lint 0, and
every count at its baseline. The Quality audit's `bun run test` gate on the
pushed tree is the measurement this record defers to, the way the #398 round
did.

### What this answers, and what stays

This fixes the merged-panel-pass mechanism: the class of the 2026-10-16 CI
red and of every red run this investigation reproduced on the unit layer, in
`test/repository-select-panel.test.ts`. The case of issue #302 that owns the
rig's remaining wall-clock exposure on a loaded runner - a wait that ends on
a pass the plane does not owe - stands as the issue states it, beside the
worker livelock of issue #403. No loaded-runner run at the fixed head is on
file from this machine, and the runner's own co-tenant load is not measured
here.

## Issue #403: a test worker spins at full CPU during a full suite run on a many-core machine (2026-10-19, the fix)

The worker livelock already stood in the run table of the #302 section above
(the post-fix run 4 row: one worker spun past every test's deadline and was
killed). This section is the reproduction of the issue on this machine, the
state the spin stood in, and the fix that lands in
[pull request #404](https://github.com/SeriousJul/my-little-software-factory/pull/404).

### The reproduction, and the state the spin stands in

One machine: 32 cores, Bun 1.4.2. The pre-fix tree, at `a0db73cd`, is the
head of `origin/main` (`486481d5`) with no file of its own, and `bun run
test` stands on its own flags. Six full runs in a row:

| Run | Wall | Load (one minute) | Result |
| --- | --- | --- | --- |
| 1 | 129.57 s | 1.28 before the run | green, 3456 pass / 0 fail |
| 2 | stood open until the worker was killed | 2.29 at the kill | one worker spun at about 100% CPU; captured below |
| 3 | 129 s | 0.90 | green, 3456 pass / 0 fail |
| 4 | 131 s | 0.88 | green, 3456 pass / 0 fail |
| 5 | 340 s after the worker was killed | 5.93 at the kill | one worker spun at about 100% CPU; captured below. Killing it ended the run red: the runner reports the worker's death, and the suite ends |
| 6 | 130 s | 2.90 | green, 3456 pass / 0 fail |

Both of the spinning runs stood in `test/tmux-fields.test.ts`, the check that
reads the pane of its own tmux server. The state the spin stood in, from two
process-table captures of the live spinning workers:

| Fact | Capture 1: run 2, worker 127399, 4 min 23 s in | Capture 2: run 5, worker 147555, 5 min 16 s in |
| --- | --- | --- |
| Thread state and CPU | `R` (running), 99.4% | `R` (running), 99.3% |
| Voluntary context switches over an eight-second beat | 383 before the beat, 383 after: the thread made no system calls while it ran | 368 over the worker's whole stand, and flat across the beat |
| The worker's children | one dead `tmux: client` it had not reaped | one dead `tmux: client` it had not reaped |
| The check's tmux server and its gallery child | both at 0.0% CPU: the pane stood healthy beside the spin | the server the check started stood with its gallery beside it |
| The run's log | stood at its last line, from another worker: the override panel group of `test/handoff-frame.test.ts` | the same last line, from the same group |

The check's poll makes three synchronous `tmux` client calls per poll, a poll
every 50 ms, a window of up to 25 s per wait, because its pane keeps changing
while the gallery runs. The state of the spin is one of those synchronous
calls that lost its child's exit: the child stands dead beside the worker
unreaped, and the worker's JS thread spins at full CPU with the event loop
starved. A starved event loop is why neither the check's 25-second wait nor
the runner's 60-second test budget can fire, and the run cannot end on its
own.

The last line of the log stands beside the original report: both of the
stall runs the issue records stood at the override panel group of
`test/handoff-frame.test.ts`, because that file's worker finished last and
reported last; the worker that spun was `test/tmux-fields.test.ts`, the file
the two captures above name on this machine, on the same tree the issue
names. A run's log says which worker reported last, not which worker stands
open.

### What the run ruled out

- It is not a synchronous loop in the app's code: the app's loops bound
  themselves on timers, and the captured workers held no child of the app at
  all.
- It is not the frame rig's waits: those yield on every poll and stand on the
  rig's twenty-second deadline, and the check's file boots no renderer.
- The spin did not stand in a minimal pattern: twenty-four parallel files,
  each starting the check's own tmux server and polling a changing pane with
  the same three synchronous calls per 50 ms, ran fifteen times on this
  machine without a spin. The reproduction stands on the two process-table
  captures of the full suite, and this section says so instead of claiming a
  smaller trigger than the evidence holds.

### What stays unmeasured

The mechanism inside the runtime that dropped the child's exit: the machine
has no `strace` or `perf`, and the runtime hands no stack to a thread that
spins, so the captures say what stood - the spin, the starved event loop, the
unreaped child - and not where inside the runtime the exit was lost. The fix
and the watch stand on the captured state, not on that mechanism.

### The fix

1. The check's tmux calls run as asynchronous child processes
   (`test/tmux-fields.test.ts`): the child's exit arrives on the event loop
   the check's waits run on, so a client that stops answering stands the
   check's own deadline up, fails the test, and the run ends. The check makes
   no synchronous child-process call in the suite's polling path.
2. `bun run test` runs under the spin watch (`scripts/test-spin-watch.ts`,
   ADR 0138): the same `bun test` command and the same output, with a reader
   beside it that samples the run's own processes every five seconds. It
   reads the run's `bun test` parent - so a run that stands no worker child,
   a single-file parallel run whose tests run in the parent, stands in its
   sight - and the parent's test workers, matched on the `--test-worker`
   argument of each child's argument list: the kernel joins a command line
   with NUL bytes, and a spaced word of the byte string never matches the
   arguments it holds. A process that holds its full CPU share on every beat
   of a sixty-second window and makes no voluntary context switches in it is
   the spin the captures stand in; the watch reports its pid, the per-beat
   CPU share, the switches the window held, and the dead children the
   process had left unreaped, takes it down so the run can end, and the run
   ends red. The watch reads the share against the kernel's own clock ticks,
   which it reads through a one-line helper it compiles once in the user's
   cache, and falls back to 100, naming which value stood. When the run
   ends, the watch prints the set of processes it held in its sight over the
   run. The watch stands only on Linux.

The measured spin wears the signature the watch reads: a full CPU share on
every beat, zero voluntary switches over an eight-second beat, one unreaped
child.

### The rework round (2026-10-19, the review's required changes)

The first head of the watch this branch stood with did not see a worker of
any real run: it tested its child's command line for the spaced word `bun
test --test-worker`, and the kernel joins a command line with NUL bytes, so
the word never stood in the byte string. Measured against the first head's
own match during a live `bun test --parallel` run that stood eight live
`--test-worker` processes: every beat of the watch reported an empty worker
set, its sample window never filled, and its kill path never ran. The first
head's three full runs in the table below therefore stood under an empty
watch: their protection stood on the check's asynchronous calls, not on the
watch, and the round re-measured the watch's two claims instead of carrying
the first head's "the watch stood silent" forward.

The round also measured the two limits of the first head's sight: a
single-file parallel run stands no `--test-worker` child at all - the parent
runs the tests in its own process, and a spin there stood outside the
watch's children-only sight - and the clock ticks per second the watch stood
on were pinned at 100, the value this machine reports, an assumption the
watch never stated.

The rework, and the measurement that stands on it, on this machine (32
cores, Bun 1.4.2):

| Run | Tree | Result |
| --- | --- | --- |
| The reworked match, against the argv a live `bun test --parallel` run stands | reworked | the match stands on the `--test-worker` argument of the child's argument list; a live worker's line reads `.../bin/bun`, `test`, `--test-worker`, `--isolate`, `--timeout=60000`, `--max-concurrency=20`, NUL-joined, and matches, while a spaced read of the same byte string does not |
| The reworked watch beside a live three-file parallel run, on a one-second beat | reworked | it held the run's parent and its two workers in its sight (pids 479943, 479955, 479958), standing on 100 clock ticks per second read from the kernel, and its end line named the set; the run ended green and the watch saw it |
| The stub's spin child under the reworked watch | reworked | the watch took the child down with SIGKILL with the signature report - a full share on every beat, zero voluntary switches over the window, no dead children beside it - and the run it stood beside ended red instead of the stub's own exit 0. This is the suite's own end-to-end test (`test/spin-watch.test.ts`), and its parsing fixtures stand on the shapes the process table held on the machine that measured the spin |
| The full suite through the watched entry, on the reworked tree | reworked | green, 3471 pass / 0 fail in 130 s, and the run's end line named the set the watch held: the run's `bun test` parent and its 32 workers, 33 processes in all, standing on 100 clock ticks per second read from the kernel; no spin stood. The push gate's run on the merged tree is the second full run through the reworked watch, and its result is what this record defers to, the way the #398 round did |

The round's coverage stands named beside the guard on
[the commands page](../development/commands.md): the watch reads the run's
own parent and the parent's children only, so a run standing beside another
run on the same machine cannot trip it; a `bun test` run outside the entry -
the inner loop's `bun test <file>`, a hand-run suite - stands under no
watch; and a machine that is not Linux gets the run passed through
untouched.

### The rework round two (2026-10-19, the review's required changes)

The review of the reworked head named four defects, and the round fixed
each:

1. The report misnamed the zombie the issue measured. `statusField`
   took the field between the line's first and second colons, so the line
   `Name:\ttmux: client` of the dead tmux client read back as `tmux`,
   and the report named the spin's unreaped child `(tmux)` instead of
   `(tmux: client)`. Detection stood unaffected - the values of `State:`,
   `PPid:`, and `voluntary_ctxt_switches:` hold no colon - but the report
   is the evidence the issue asks for. The value now stands after the
   line's first colon and holds the rest of the line whole, and a fixture
   stands the measured line beside the parsing.
2. The end-to-end half timed out on a machine that is not Linux: the
   watch is inert off Linux, so it took the stub's spin child down
   nowhere, the check timed out at its 30 s, and the stub and its spin
   child stood on as orphans at full CPU. The half now throws the check
   incomplete on a platform the watch stands nowhere, the way the tmux
   check reports a missing binary. The mechanism stands measured on this
   machine: a `beforeAll` that throws fails the check's tests without
   running them and stands no process on.
3. The pass-through test tested a command the watch never reads: `bun
   -e ...` is not a `bun test` run, the watch's target set stood empty on
   every beat, and the run it stood beside stood outside its sight. The
   false-positive path - a busy but healthy `bun test` parent the watch
   must not take down - stood beside no automated test. The check now
   stands the watch beside a real `bun test` run of a small temporary
   test file that yields to its event loop on every wait, and asserts the
   run ends 0 with the watch holding the run's parent in its sight.
4. A tmux client that did not answer stood outside the check's own
   deadline: `tmuxCall` waited on the child's exit with no deadline of
   its own, so a client that never answered stood the wait on the
   runner's 60 s budget, with the check's 25 s bound and its pane report
   bypassed. Each client call now stands its own 5 s deadline: a client
   that stands past it is taken down and read as a no-answer.

The round also made the entry report the child's exit code unchanged
instead of normalizing any non-zero code to 1: the watch writes one code
of its own, the 1 of a run it pulled out of a spin, and the wording that
the entry reports the same exit code stands beside the code now (ADR
0138).

The round's measurement, on this machine (32 cores, Bun 1.4.2, load 2.22
before the scoped runs, no other `bun test` process running):

| Run | Tree | Result |
| --- | --- | --- |
| The `Name:` line of a dead tmux client, beside the fixed parsing | reworked | the value after the line's first colon stands whole: `Name:\ttmux: client` reads back as `tmux: client`, the process class the report names, beside the fixture in `test/spin-watch.test.ts` |
| The pass-through check beside a real `bun test` run of a small temporary test file, on a 300 ms beat | reworked | the run stood about 3 s, the watch held the run's parent in its sight (one process, its pid named in the end line), and the run ended 0 with no spin stood; a single-file run stands no `--test-worker` child, and the parent is what stands in the watch's sight there |
| The end-to-end half's platform guard, beside the mechanism it stands on | reworked | a `beforeAll` that throws on a platform the watch stands nowhere fails the check's tests without running them and stands no process on, measured beside a probe of the throwing hook; the platform check itself is the one-line read the watch itself stands on, and its stand on a machine that is not Linux is named in [the table below](#what-was-not-measured) |
| A client that never answers, beside the deadline the round gives each `tmuxCall` | reworked | the child was taken down at the 5 s deadline and the wait resolved as a no-answer 501 ms into it, and no child stood on after, measured beside a probe of the deadline shape the call stands on |
| `bun test test/spin-watch.test.ts --isolate` | reworked | 16 pass / 0 fail in 3.8 s: the fixture half, the spin child the watch took down with its report, and the real `bun test` run the watch held in its sight and let end green |
| `bun test test/tmux-fields.test.ts --isolate` | reworked | 1 pass / 0 fail in 285 ms: the healthy client answers in well under its 5 s deadline, and the check's own deadline and pane report stand in charge of a client that does not answer |

The push gate's run on the merged tree is the full-suite measurement this
round defers to, the way the rounds before it did.

### The verification, on this machine

| Run | Tree | Result |
| --- | --- | --- |
| The check's file alone, through its own runner flags | fixed | 1 pass / 0 fail in 256 ms |
| Three full runs through the watched entry, under the first head of the watch | first head | green, 3456 pass / 0 fail in 130 s each - and the watch's worker set stood empty on all three, which the rework round found and measured beside the live worker's argv above |

The six pre-fix runs stand in the table above, and the rework round's runs
stand in its table. The push gate's run on the merged tree is the
measurement this record defers to, the way the #398 round did.

### What the watch does not see

- The run's grandchildren: a check's own tmux server and pane, a stub a
  test spawns. The spin measured in the issue stood in the worker's own
  thread, beside the child the worker had lost the exit of; a spin that
  stood in a grandchild instead would stand outside the watch.
- A `bun test` run outside the `bun run test` entry: the inner loop's
  `bun test <file>` and a hand-run suite stand under no watch.
- A machine that is not Linux: the watch passes the run through untouched.
- A spin on a kernel that reports fewer clock ticks per second than the
  assumed 100, on a machine the tick read cannot stand on: the share stands
  under the floor, and the watch misses the spin without saying so. A
  machine the read stands on gets its own value, and the report names it.
  On a kernel that reports more ticks, the assumed value of 100 stands a
  spin over the floor, so its direction does not hide a spin.

## What was not measured

| Item | State |
| --- | --- |
| A real `git push` to `github.com/SeriousJul/my-little-software-factory` with the hook installed | Passed. The push of `main` ran the hook: `pre-push: bun run lint` (302 files, no fixes), `pre-push: bun run typecheck`, `pre-push: lint and typecheck clean, and no branch behind its remote-tracking ref`, and `370563f5..724dc3ec main -> main` landed |
| The hook installed in the operator's checkout | Passed. `git config core.hooksPath scripts/git-hooks` is set in this checkout, and the push above is the proof it is live. The setup line stays a documented step on [the commands page](../development/commands.md) for every other checkout |
| The doc-claim rule, the rename sweep, the documented-line rule, the probe rule, the determinism rule, the fake-fidelity rule, the file-the-defect rule, the failure-mode sweep, and the reporting rules | First measured by the self-review round above, on `b3b5fc38`: the probe rule, the rename sweep, the determinism rule, the file-the-defect rule, and the doc-claim rule each produced a result there, and the doc-claim rule found the stale cost numbers. What stays incomplete is the round's value: every commit was written by the agent that wrote the rules, so this is self-review, and a round on a pull request from a different author is the first independent measurement |
| The 14 domain types in `UNREAD_TYPE_BASELINE` | Answered on 2026-10-05 in [the section above](#issue-301-the-14-unread-domain-types-2026-10-05): each name took one of [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301)'s three answers and the baseline stands empty. What stays unmeasured is whether any of them is dead, which the check still cannot see, and it is recorded in that section |
| The CI load flake on the frame tests | Investigated on 2026-10-05 and filed as [issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302): four remote frame-deadline misses, the mechanism measured, no local reproduction, and no fix shipped on that evidence. The scroll half of it is answered on 2026-10-05 in [the section above](#issue-302-the-details-scroll-restore-waits-for-a-pass-the-plane-does-not-owe-2026-10-05-the-fix). The deadline miss that survived that fix is [issue #311](https://github.com/SeriousJul/my-little-software-factory/issues/311), answered on 2026-10-06 by the fix in pull request [#318](https://github.com/SeriousJul/my-little-software-factory/pull/318): the harness's waits run the reconciler's flush before they read, and the pin stands in `test/repository-select-panel.test.ts` - recorded in [the #311 section above](#issue-311-frame-waits-still-miss-the-deadline-under-load-in-the-surfaces-the-302-fix-does-not-touch-2026-10-06-the-fix). The pseudo-terminal seam that stood beside the class is answered on 2026-10-06 in [the section above](#issue-321-pseudo-terminal-waits-miss-their-deadline-under-load-in-the-executable-fields-rig-2026-10-06-the-fix): the rig's input stands on the painted fact the previous key owed, and the open window between a surface's first frame and its key taking is closed in the source, in [issue #321](https://github.com/SeriousJul/my-little-software-factory/issues/321). The frame-rig rework in [pull request #395](https://github.com/SeriousJul/my-little-software-factory/pull/395) moves the class onto the rig's one deadline and its named outcomes, and moves the suites' remaining deadline loops onto the rig's waits: every one of the twelve issues it lists stands at that pull's head closed, issue by issue, or merged, pull by pull, by its own fix, and the rework closes none of them anew. The item stays open on the loaded-runner evidence this record holds: the deadline miss survives the fixes under a loaded runner, and no loaded run at the rework's head is on file. The push gate's full-suite run at the pushed head is the rework round's measurement, and each file that fails it and passes alone is named as a load flake in the pull. The older records in [the shared control record](./shared-controls.md) and the pull request records stand The week ending 2026-10-15 was investigated in [the #398 section above](#issue-398-the-ci-test-flake-the-week-of-evidence-and-what-it-names-2026-10-15-the-answer), and its three fixable classes landed there. The merged-panel-pass mechanism the 2026-10-16 push run named is answered on 2026-10-16 in [the section above](#issue-302-the-merged-panel-pass-keeps-one-instances-keys-2026-10-16-the-fix): the per-entity panels carry a key that names their entity, and the six completed post-fix runs of this record stand green on the unit layer |
| The mechanism inside the runtime that dropped the child's exit in issue #403 | Open, as [the #403 section above](#issue-403-a-test-worker-spins-at-full-cpu-during-a-full-suite-run-on-a-many-core-machine-2026-10-19-the-fix) records: no `strace` or `perf` on the machine, and no stack from a spinning thread. The fix and the watch stand on the captured state |
| The spin watch taking down a process that spins in a real full-suite run | Not stood on this machine: no spin stood in any of the post-fix runs, first head or rework. What stands measured instead is in the rework rounds above: the live worker's argv that the reworked match matches on, the set of the run's own parent and workers the reworked watch held beside a live parallel run, the stub's spin child the watch took down with SIGKILL in the suite's own end-to-end test, and the real `bun test` run the reworked watch held in its sight and let end green. A real suite spin that returns will be the first measurement of the watch's kill path against the measured state itself |
| Whether a `bun test` worker exits when the watch takes the run's `bun test` parent down | Unmeasured: the watch's signal reaches the parent, and the parent's worker children stand orphaned whether or not they exit on their parent's death. The measured spin stood in a worker the watch takes down itself, so the risk stands low, and the limit stands named in [the #403 section above](#issue-403-a-test-worker-spins-at-full-cpu-during-a-full-suite-run-on-a-many-core-machine-2026-10-19-the-fix) and in ADR 0138 |
| The spin watch's end-to-end half on a machine that is not Linux | Not stood on this machine, which is Linux: the guard's throwing `beforeAll` fails the check as incomplete, measured beside a probe, but the one-line platform read standing on a macOS or Windows machine is named, not measured. CI (ubuntu) stands on the watch the same way this machine does |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, as [the shared control record](./shared-controls.md) states. The gate is a claim about the automated checks and the tree they ran on, and it extends no further |
