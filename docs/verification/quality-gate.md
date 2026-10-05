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
filed as issues #301, #302, #303, and #304.

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

## What was not measured

| Item | State |
| --- | --- |
| A real `git push` to `github.com/SeriousJul/my-little-software-factory` with the hook installed | Passed. The push of `main` ran the hook: `pre-push: bun run lint` (302 files, no fixes), `pre-push: bun run typecheck`, `pre-push: lint and typecheck clean, and no branch behind its remote-tracking ref`, and `370563f5..724dc3ec main -> main` landed |
| The hook installed in the operator's checkout | Passed. `git config core.hooksPath scripts/git-hooks` is set in this checkout, and the push above is the proof it is live. The setup line stays a documented step on [the commands page](../development/commands.md) for every other checkout |
| The doc-claim rule, the rename sweep, the documented-line rule, the probe rule, the determinism rule, the fake-fidelity rule, the file-the-defect rule, the failure-mode sweep, and the reporting rules | First measured by the self-review round above, on `b3b5fc38`: the probe rule, the rename sweep, the determinism rule, the file-the-defect rule, and the doc-claim rule each produced a result there, and the doc-claim rule found the stale cost numbers. What stays incomplete is the round's value: every commit was written by the agent that wrote the rules, so this is self-review, and a round on a pull request from a different author is the first independent measurement |
| The 14 domain types in `UNREAD_TYPE_BASELINE` | Held still, not cleaned, and filed as [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301). The ratchet refuses a new one and refuses a stale baseline entry; nothing was measured about whether these 14 should be exported, and the check's own header states that a caller can hold such a type without naming it |
| The CI load flake on the frame tests | Investigated on 2026-10-05 and filed as [issue #302](https://github.com/SeriousJul/my-little-software-factory/issues/302): four remote frame-deadline misses, the mechanism measured, no local reproduction, and no fix shipped on that evidence. The older records in [the shared control record](./shared-controls.md) and the pull request records stand |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, as [the shared control record](./shared-controls.md) states. The gate is a claim about the automated checks and the tree they ran on, and it extends no further |
