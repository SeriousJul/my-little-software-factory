# The Stub herdr world verification

Status: the world module and its suite pass on the unit layer. The suite
measures the world's answers to the plane's own command shapes, its stateful
transitions, its refusals for the commands it does not hold, its recording
shape, and the closed surface. The migration has moved the checkout
verification and eight of the nine files that held a local copy of it onto the
world; the ninth, the auto-mode suite, is held on the pin table (below). The
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

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| A world description stands a checkout | `test/herdr-world.test.ts` ("the checkout side"): the description names the path, clone URL, default branch, and branches, and the checkout answers the git pair the plane's verification reads | Passed |
| A create adds to the world, a close removes from it | "the worktree side", "the live side", "the Agent side": a `worktree create`, `tab create`, `workspace create`, and `agent start` stand their entities, and a later `worktree remove`, `tab close`, `workspace close`, and `pane close` remove them, cascading an empty tab and workspace | Passed |
| A close of what the world does not hold is refused with herdr's own code | the same blocks: a close of a workspace, tab, or pane the world never made answers the herdr error envelope with its code, and the plane's reader takes the refusal unchanged | Passed |
| The plane reads the refusal codes it reads | the blocks assert the codes the handoff and the observation read: `worktree_not_found`, `agent_name_taken`, `agent_pane_busy`, `tab_not_found`, `workspace_not_found`, and `worktree_remove_failed` | Passed |
| The held `agent wait` is the one exception to the refusal rule | "the Agent side": an `agent wait` for a settling Agent holds instead of answering, and a wait for a settled Agent answers | Passed |
| The recording keeps the fake runner's shape | "the recording": `commands()`, `settledCommands()`, `peakConcurrency()`, the raw `calls`, the `hold`/`release`, the `raise`, and the `set`/`setSequence` sequence all answer the way the fake command runner answers, so the gate and delay wrappers compose over the world unchanged | Passed |
| The closed surface stays closed | "the closed surface": every herdr and git command shape the plane builds is driven against a healthy world and meets no refusal; a shape the world never answers and a command the plane starts sending both fail there | Passed |
| The gate and delay wrappers compose over the world | the wrappers take a `CommandRunner`, and the world satisfies it; the suites that gate and delay a handoff run over the world without change | Passed |
| The checkout verification moves off the local builder | the eight files that held a local `stubCheckout` (the Action bar, the Consultation frame, the Consultation operations, the Handoff frame, the Key guide, the Live view, the Message line, and the Starting face) now state the checkout as a world and their local builders are deleted | Passed |

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
| The checkout verification | the Action bar, the Consultation frame, the Consultation operations, the Handoff frame, the Key guide, the Live view, the Message line, the Starting face | their eight local `stubCheckout` copies | Moved |
| The checkout verification | the auto-mode suite | its `stubCheckout` copy | Held on the pin table |

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
| A scoped Stryker campaign over the Handoff dispatch and the observation | not run in this change | Incomplete |
| The auto-mode suite's move onto the world | its pinned flows need a per-test rework that is its own step | Incomplete, recorded in the migration table above |
| The screen-reader path of the surfaces the suites touch | not verified in this branch's scope | Incomplete |
| The machine state beside the full suite | the full `bun run test` ran on the merged tree with the plane's own processes live | The suite passed; one test that failed in one full run and passed alone and in the two full runs beside it is named as a load flake |
