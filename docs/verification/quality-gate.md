# The quality gate verification

Status: the gate's commands and the pre-push hook were measured on the branch
that added them, on 2026-10-05. The hook's four ref cases, its refusal on a lint
failure, and its git-level wiring were each run, and the run found two defects in
the hook itself, both fixed on this branch before any push. The rules on
[the quality gate page](../development/quality-gate.md) are not machine-checked:
they hold a document's claim, a probe's reproducibility, and a report's numbers,
and only a review measures those. Those rows stand incomplete below.

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
case is not identified, and the next run that goes red at load names it.

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

## What was not measured

| Item | State |
| --- | --- |
| A real `git push` to `github.com/SeriousJul/my-little-software-factory` with the hook installed | Incomplete. The wiring was measured with `git push --dry-run` against this checkout, not against the remote. No push was made from this verification |
| The hook installed in the operator's checkout | Incomplete, and deliberate. `core.hooksPath` was set for the wiring run and unset again; the setup line stays a documented step on [the commands page](../development/commands.md) |
| The doc-claim rule, the rename sweep, the documented-line rule, the probe rule, the determinism rule, the fake-fidelity rule, the file-the-defect rule, the failure-mode sweep, and the reporting rules | Incomplete by nature. No check measures them; the reviewer's floor on the quality gate page is what enforces them, and the next review round is where they are first measured |
| The 14 domain types in `UNREAD_TYPE_BASELINE` | Held still, not cleaned. The ratchet refuses a new one and refuses a stale baseline entry; nothing was measured about whether these 14 should be exported, and the check's own header states that a caller can hold such a type without naming it |
| The CI load flake on the frame tests | Open, and unchanged by this decision. `test/consultation-frame.test.ts` and the other load-sensitive frame files are recorded in [the shared control record](./shared-controls.md) and in the pull request records; the gate does not fix them |
| The live terminal walk, the screen-reader path, and the theme inheritance inside a real herdr | Open, as [the shared control record](./shared-controls.md) states. The gate is a claim about the automated checks and the tree they ran on, and it extends no further |
