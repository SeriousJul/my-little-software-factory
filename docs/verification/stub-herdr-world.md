# The Stub herdr world verification

Status: the world module and its suite pass on the unit layer. The suite
measures the world's answers to the plane's own command shapes, its stateful
transitions, its refusals for the commands it does not hold, its recording
shape, and the closed surface. The migration has moved the checkout
verification and eight of the nine files that held a local copy of it onto the
world; the ninth, the auto-mode suite, is held on the pin table (below). The
Consultation launch then stood on the world, and the Agent interaction's text
and key sends reached the world's own pane, so the tests read what the pane
received from its send records instead of the commands that carried the
sends. Since then, the plane-boot migration (issue #366) re-landed seven of
those eight suites - the Action bar, the Consultation frame, the Handoff
frame, the Key guide, the Live view, the Message line, and the Starting face
- on the pin table: they now boot from the one total record on the Seeded
  plane, and their herdr and git answers come from the fake command runner's
  pins again. The Consultation operations and the Agent input queue stand on
  the world: their launch, send, conflict, and failure flows all run over it,
  and their move onto the world is complete (issue #374). The seven
  suites' move onto the world is recorded as incomplete below. The scoped
  Stryker campaign over the Handoff dispatch and the observation has run on
  this branch (issue #377): the campaign's host resolves the vendored
typescript shim
  ([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)),
  and the two modules' mutation score stands measured. The
tracing of every answer shape to a recorded real herdr answer is recorded as
incomplete below: the shapes are derived from the plane's own readers and
herdr's documented CLI behavior, and none has yet been checked against a
recorded answer from a live herdr 0.8.2 binary. A check that could not run is
recorded as incomplete. It is not a pass, and it is not silently dropped.

See [ADR 0132](../adr/0132-the-stub-herdr-world-answers-herdr-and-git-from-one-standing-world.md)
for the decision, [issue #361](https://github.com/SeriousJul/my-little-software-factory/issues/361)
for the requirement, and [test/herdr-world.ts](../../test/herdr-world.ts) for the
module.

## What it was measured on

| Piece | Value |
| --- | --- |
| Runtime, host and test children both | Bun 1.4.2 (Linux x64) |
| Test layer | `bun test` on the unit layer: an in-memory world, the real production readers (the handoff, the observation, the consultation operations) driven over the world, and no desktop control |
| World module | [test/herdr-world.ts](../../test/herdr-world.ts), one `stubHerdrWorld` factory and its `StubHerdrWorld` surface |
| Herdr version the shapes name | 0.8.2, the version the plane's readers were written against |
| The Stryker host of the scoped campaign | Stryker core 10.0.0 on Bun 1.4.2, resolving the vendored typescript shim staged under its own `node_modules` before the run ([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)); the typescript 7.0.2 this repository declares stands untouched |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| A world description stands a checkout | `test/herdr-world.test.ts` ("the checkout side"): the description names the path, clone URL, default branch, and branches, and the checkout answers the git pair the plane's verification reads | Passed |
| A create adds to the world, a close removes from it | "the worktree side", "the live side", "the Agent side": a `worktree create`, `tab create`, `workspace create`, and `agent start` stand their entities, and a later `worktree remove`, `tab close`, `workspace close`, and `pane close` remove them, each close removing the Agents its panes held and cascading an empty tab and workspace | Passed |
| A close of what the world does not hold is refused with herdr's own code | the same blocks: a close of a workspace, tab, or pane the world never made answers the herdr error envelope with its code, and the plane's reader takes the refusal unchanged | Passed |
| The plane reads the refusal codes it reads | the blocks assert the codes the handoff and the observation read: `worktree_not_found`, `agent_name_taken`, `agent_pane_busy`, `tab_not_found`, `workspace_not_found`, and `worktree_remove_failed` | Passed |
| The held `agent wait` is the one exception to the refusal rule | "the Agent side": a wait for an Agent the world holds not at a settle state holds instead of answering, a `setAgentStatus` move to a settle state releases it with code zero, a wait for an Agent already at a settle state answers at once, and a wait for a target the world does not hold is refused | Passed |
| The recording keeps the fake runner's shape | "the recording": `commands()`, `settledCommands()`, `peakConcurrency()`, the raw `calls`, the `hold`/`release`, the `raise`, and the `set`/`setSequence` sequence all answer the way the fake command runner answers, so the gate and delay wrappers compose over the world unchanged | Passed |
| The closed surface stays closed | "the closed surface": every herdr and git command shape the plane builds is driven against a healthy world and meets no refusal; a shape the world never answers and a command the plane starts sending both fail there | Passed |
| The gate and delay wrappers compose over the world | the wrappers take a `CommandRunner`, and the world satisfies it; the suites that gate and delay a handoff run over the world without change | Passed |
| The checkout verification moves off the local builder | the eight files that held a local `stubCheckout` (the Action bar, the Consultation frame, the Consultation operations, the Handoff frame, the Key guide, the Live view, the Message line, and the Starting face) now state the checkout as a world and their local builders are deleted | Passed |
| The Agent interaction's text and key sends are answered by the world | the Agent input queue's send tests and the Consultation frame's interaction test stand the world's own pane: the sends reach it, and the tests read them from `sentTextFor` and `sentKeysFor` instead of the recorded commands | Passed |
| The mutation score of the Handoff dispatch and the observation stands measured | The scoped Stryker campaign over `src/handoff.ts`, `src/handoff-dispatch.ts`, and `src/observation.ts` ran on 2026-10-13 on this branch's head, and re-ran on the head rebased onto the Seeded plane (#378), on the campaign's host resolving the vendored typescript shim ([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)) that issue #377's fix stages under the Stryker core's own `node_modules`. The crash that blocked the campaign stands recorded here: Stryker core 10.0.0's TypeScript preprocessor reads `parseConfigFileTextToJson` from the `typescript` package, and the typescript 7.0.2 this repository declares does not expose it, so the host died at the campaign's first step with `ts.parseConfigFileTextToJson is not a function`, before a mutant was measured; scoping the campaign to `src/handoff.ts` did not avoid it, because the preprocessor runs before the scope is applied, and no campaign, scoped or full, could start | 76.73 percent on the head the campaign measured (the pushed head adds #391's frame-rig rework, which changes the suite the campaign runs): of 4,835 mutants, 3,701 killed, 8 timed out, 1 runtime error counted with the killed, 919 survived, and 206 with no coverage, so 3,710 of 4,835; per file, `handoff.ts` 80.97 percent, `handoff-dispatch.ts` 76.96 percent, and `observation.ts` 72.19 percent. On the tree before the rebase the same scope read 76.69 percent; the [mutation-testing record](mutation-testing.md) holds the full breakdown |

## The answer-shape tracing (incomplete)

The ADR requires every answer shape the world produces to be traced to a
recorded real herdr answer, with the herdr version named, and every shape
inferred from the plane's own reader recorded as unverified.

| Shape family | Source | Status |
| --- | --- | --- |
| The herdr JSON answers (`agent list`, `agent read`, `workspace get/list`, `tab create/list`, `pane list`, `worktree list/open/create/remove`) | derived from the plane's own readers and herdr's documented CLI behavior | Unverified against a recorded herdr 0.8.2 answer |
| The herdr refusal envelope and its codes | derived from the plane's readers (`herdrErrorCode`) and herdr's documented error behavior | Unverified against a recorded herdr 0.8.2 answer |
| The git answers (`rev-parse`, `remote get-url`, `symbolic-ref`, `fetch`, `branch`, `commit-tree`, `update-ref`, `push`, `ls-remote`, `worktree add/remove`, `diff`) | derived from the plane's own readers and standard git behavior | Unverified against a recorded herdr 0.8.2 answer |

Nothing in this change has been checked against a live herdr 0.8.2 binary, so
no answer shape is traced to a recorded answer yet. The tracing is the
acceptance target, and it stands incomplete until the Stub run or a terminal
walk records the real answers and the world is checked against them.

## The migration state

| Flow | Files moved | Local builders deleted | Status |
| --- | --- | --- | --- |
| The checkout verification | the Consultation operations | its local `stubCheckout` copy | Moved |
| The checkout verification | the Action bar, the Consultation frame, the Handoff frame, the Key guide, the Live view, the Message line, the Starting face | their seven local `stubCheckout` copies stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366: those seven suites boot from the Seeded plane's total record, and the checkout stands on the fake command runner's git pins again |
| The checkout verification | the auto-mode suite | its `stubCheckout` copy | Held on the pin table |
| The live-worktree Handoff | the Starting face and the Handoff frame's live-worktree Handoff tests | their `stubLiveHandoff` builders stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366 |
| The live-worktree Handoff | the Handoff frame's worktree Handoff tests and its pin-table tests | - | Out of this flow: the worktree Handoff is the next flow, and the pin-table tests stay |
| The worktree Handoff and its Worktree base read | the Handoff frame's worktree Handoff tests | its `stubWorktreeHandoff` builder stood on the world, and the plane-boot migration re-landed it on the pin table | Re-landed on the pin table by #366 |
| The worktree Handoff and its Worktree base read | the suites whose standing builders also pin the base read (the checkout hold, the auto-handoff chain, the herdr view frame, the repository select panel) | - | Their builders stand a live-worktree environment plus the base read for their own subject (the hold, the chain, the view, the panel); they are not the worktree Handoff's builder, and they stay |
| The Consultation launch, worktree side | the Consultation operations' worktree-launch tests: the full launch, the Replacement, the in-progress opening, the re-run without an Agent handle, and the free-gate pickup and recovery | the `stubWorktreeLaunch` builder the remaining worktree tests still used, deleted with them | Moved: those six stand the world's own worktree launch and name the world's handles; the launch's standing is `worktreeLaunchStanding` (the checkout and its worktrees root, no workspace) |
| The Consultation launch, live side, first batch | the Consultation operations' clean live-launch tests: the free live checkout, and the live-worktree pickup and recovery that cross no gate | the `stubLiveLaunch` builder the conflict tests still used, deleted with them | Moved: those three stand the world's own live launch, which makes the Agent's tab and pane, so the Agent sits in the world's first pane; the launch's standing is `liveLaunchStanding` (the operator's workspace, no tab) |
| The Consultation launch, the frame side | the Consultation frame's worktree-launch tests and its live-launch tests (the launcher's recovery, Replacement, free-seat, pickup, and the full operator flow) | `stubWorktreeLaunch`, `stubLiveLaunchExisting`, `stubLiveLaunchNew`, and the post-launch standings stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366; the Consultation operations' launch flows (the rows above) stand on the world |
| The Agent interaction's text and key sends | the Agent input queue's send tests (the queue seam) | their hand-pinned `pane send-text` and `pane send-keys` chunks: no builder stood there, so nothing is deleted - the seam stands the world's own pane and reads the sends from its `sentTextFor` and `sentKeysFor` records | Moved: the queue's in-flight windows stand on the world's own hold and on the delay wrapper over the world, the way they stood on the pin table's delay. The Consultation frame's interaction test (the UI seam) was re-landed on the pin table by #366 |
| The Consultation launch, live conflict side and the remaining worktree tests | the Consultation operations' live-conflict tests and its worktree failure, leftover, serialize, and start-line tests | `stubLiveLaunch`, `stubWorktreeLaunch`, `stubOpening`, and the pre-seeded `worktreeLaunchWorld` and `liveLaunchWorld` standings | Moved: the conflict tests stand `liveConflictWorld` (the operator's workspace holds the checkout, and the operator's own Agent works in its pane), and the conflicts' identities come from the world's own `agent list`. The one pin each failure test keeps is the one herdr answer the world cannot give: a raw-SHA worktree base (the world checks a base against ref names), a create refusal the plane reads and acts on, or the Agent start failure whose cleanup the test measures. The serialize stands both sides on the world: the close's standing is the worktree workspace, its tab and pane, and its Agent. The start-line and the Work queue dispatch stand `worktreeLaunchStanding`, and the world's own launch builds each record's environment |
| The Plane action merge and the Repository init | none: the Plane action merge's command-sequence tests and the Repository init's git writes stay on the pin table | - | The command is the subject: the merge's `commit-tree`, `update-ref`, and `push` sequence, and the init's commit stream, are pinned in full, so the pin table is the right adapter and the world is not. The world's own git write side (the same shapes) stands and is tested in the world's suite, so the plane's git writes are answered there whenever a flow's subject is the behaviour, not the command |

The auto-mode suite is held because its tests' subjects are the auto dispatch,
the Decision modal, the route, and the leftover environment, not the checkout
verification. Their pinned launch sequences name the same handles the world
would close and re-create, and their settled tickets write their labels through
the GitHub side, which the world does not hold. Moving them onto the world
needs a per-test rework of their standings and their GitHub pins, and that
rework is its own step, recorded here rather than folded into the checkout
verification's change.

## Not measured

| Check | Why it could not run | Recorded as |
| --- | --- | --- |
| The answer-shape tracing to a recorded herdr 0.8.2 answer | it needs a live herdr binary to record the real answers; the contributor instructions keep the automated suite at the unit layer | Incomplete, with the shape table above as the acceptance target |
| The auto-mode suite's move onto the world | its pinned flows need a per-test rework that is its own step | Incomplete, recorded in the migration table above |
| The seven frame suites' move onto the world | the plane-boot migration (#366) re-landed them on the pin table; their herdr and git answers stand on the fake command runner's pins again, and their move onto the world needs a per-test rework of their standings, its own step | Incomplete, recorded in the migration table above |
| The screen-reader path of the surfaces the suites touch | not verified in this branch's scope | Incomplete |
| The machine state beside the full suite | the full `bun run test` ran on this branch's heads with the plane's own processes live | The gate run for this change passed with no red case on the head rebased onto the Seeded plane (#378): 3415 pass, 0 fail, 155 files, in 65.67 seconds with `bun run test`; the pushed head, which adds #391's frame-rig rework, passed its gate beside it: 3428 pass, 0 fail, 155 files, in 65.62 seconds, on a machine with 32 cores and no other test process running. The run before both, on the tree before the rebase, stood red on one case this change itself made: the dotfiles test recorded the old test-dup baseline, and the baseline rewrite moved it. The test now records the rewritten value, and the rerun beside it stood green |
