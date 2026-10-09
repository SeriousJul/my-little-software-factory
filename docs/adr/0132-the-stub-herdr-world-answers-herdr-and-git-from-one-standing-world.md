# ADR 0132: The Stub herdr world answers herdr and git from one standing world

Status: accepted
Date: 2026-10-09

Records that the herdr and git side of the automated suite's Command runner double becomes one
**Stub herdr world** module at the existing Command runner seam, that the world is stateful and
refuses what it does not hold, that the fake command runner stays where the command itself is the
subject, that the world is handed to a run through the Seeded plane's runner and no new injection
point, that one closed-surface rule pins the world's answered surface against the commands the plane
really builds, and that every answer shape is traced to a recorded real herdr answer or recorded as
unverified. It moves no control, changes no key, rewords no hint, decides no gate, touches no
surface, and changes no command the plane sends.

## Context

ADR 0073 settled the seam: every herdr, git, GitHub CLI, and agent model list command leaves the
plane through the Command runner, and the boundary for a stand-in is that seam and not a new one.
ADR 0073 then stubbed one side of it, the GitHub side, for the operator's Stub run, and left `git`,
herdr, and the agent runtimes real there. That decision stands untouched here.

The automated suite stands on the other side of the same seam, and its double is shallow. The fake
command runner's interface is a table: a test pins one exact argument vector and hands back one exact
result. It holds no state and no behaviour, so the protocol it stands for lives nowhere it owns.
Every suite re-encodes that protocol around it.

Measured at head `62ef9770`:

- **815 pinned argument vectors** across the suite: **545 herdr**, **201 git**, **69 GitHub CLI**.
- The plane builds **20 herdr command shapes** and **18 git command shapes**, and reads **5 herdr
  refusal codes**: `worktree_not_found`, `agent_name_taken`, `agent_pane_busy`, `tab_not_found`,
  `workspace_not_found`.
- **50 local builders** named `stub*`, `seed*`, `make*`, or `write*` stand across the suite. Eight
  of them stand in two or more files: `stubCheckout` in **9**, `stubLiveHandoff` in **3**,
  `seededApp` in **3**, and `stubWorktreeLaunch`, `stubTopology`, `stubLiveCheckout`,
  `seedResources`, `seededState` in **2** each.
- The suite holds **267 clones across 5,098 duplicated lines** at the Quality audit's own settings,
  against **0 clones** in the plane's own sources. Issue
  [#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) puts the suite in the
  audit's scope, so the count this change drives down is a number the audit prints.

The cost is not length. It is that the plane's external protocol has no home. One herdr argument
change lands in nine files. A test that wants "one verified checkout, one worktree, one live Agent"
must first write the plane's command table, because nothing else will answer for that standing. The
nine copies of the checkout verification are the same two commands written nine times, and a tenth
suite writes an eleventh.

The statefulness is the part the current double cannot express at all. A `workspace create` that
returns `ws-1` and a later `workspace close ws-1` are two independent pins today, so a suite can pin
a close of a workspace no create made, and a suite can pin an `agent list` that contradicts the
`agent start` the same test drove. The bugs that live in that gap - the residue contract, the seat
the Missing Agent left (ADR 0108), the Shared checkout gate (ADR 0109) - are exactly the bugs a
stateful world answers and a pin table cannot.

## Decision

**One Stub herdr world module, at the existing Command runner seam, and no new seam.** It is a second
deep adapter on the seam ADR 0073 fixed, beside the Stub runner that serves the GitHub side. The
plane's sources gain no port, no indirection, and no knowledge that a world is in play.

**The interface is a standing, not a table.** A test names the world it wants - the checkouts and
what each holds, the default branch, the branches and worktrees, the workspaces, tabs, panes, and
Agents already standing, and which names are held - and receives a Command runner. Everything else
is implementation. The interface is small on purpose: this is the whole difference from the fake
command runner, whose interface is the protocol.

**The world is stateful, and its state is the world's own.** A create adds to it, a close removes
from it, a start stands an Agent in a pane, and every later read answers from what the earlier
command left. A close of something the world does not hold is refused with herdr's own code, and the
plane's existing readers take that refusal unchanged. This is what makes the residue, seat, and
shared-checkout rules testable as facts instead of as pinned sequences.

**The world answers only the shapes the plane builds, and refuses everything else.** No fallback
result stands for an unmodelled command. The one behaviour kept from the fake command runner is the
held `agent wait`, because a real `agent wait` blocks and a code-zero fallback would wake the
observation cycle on every armed Agent.

**One closed-surface rule pins the surface.** Following the Stub world suite's existing closed-surface
block and the view-ownership check, one check reads the commands the plane really builds and drives
each against the world, and any refusal there fails. A command the plane starts sending and a shape
the world never answered both show up in that check rather than in a fallback. The check states its
own allowance list beside its reason, the way the eight existing architecture checks do.

**The fake command runner stays, and it is not a legacy shape.** Where the argument vector is the
subject under test, the pin table is the right adapter: the herdr CLI contract the Handoff suite
pins, the Repository init's git writes, the Plane action merge's command sequence, and every
"this run did not issue that command" claim of the residue contract. The world replaces the standing
a suite needs in order to reach a test; it does not replace a test whose subject is the command.
**Replace, do not layer:** as each flow moves onto the world, its local builders are deleted in the
same change, and no builder is kept beside the world in case.

**The world records, and the recording keeps its shape.** The recorded command list, the settled
list, the peak concurrency, the held command, the raised command, and the per-command sequence are
answered by the world exactly as the fake command runner answers them today, so the gate and delay
wrappers compose over it unchanged and the Parallel limit and serialization suites do not move.

**The world reaches a run through the Seeded plane's runner, and no new injection point.** ADR 0131
owns the module that holds the Command runner double and puts it in the Plane boot ADR 0129 settled.
This decision adds an adapter behind that runner; it adds no field to the Plane boot, no field to the
Frame rig, and no second way to hand a runner to a surface.

**The world is in memory, and the Stub world's file stays the Stub run's own.** The Stub world is
file-backed because the operator hand-edits it between turns and a restart reads it back (ADR 0073).
No operator edits a test's herdr world, so a file there would be a cost with no owner. The two worlds
share the shape, not the storage.

**Every answer shape is traced, and the untraced ones are recorded as unverified.** Each answer shape
the world produces comes from a recorded real herdr answer, and the record names the herdr version
the shapes were taken from. A shape inferred from the plane's own reader rather than from a recorded
answer is recorded as unverified in the verification record, and the claim stops there. This is the
honesty rule, not a caveat: the world is a claim about herdr, and a claim that was not measured is
not a pass.

**The migration order is fixed, and the ratchet is measured.** Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) lands first, so the
suite's clone count is visible before any of it moves. Then one flow per change, each naming the
clone count before and after at the head it measured them on: the checkout verification, which
retires the nine copies; the live-worktree Handoff; the worktree Handoff and its Worktree base read;
the Consultation launch and Agent interaction; the Plane action merge and the Repository init. The
closed-surface check lands with the first flow, because a world with no surface check is a world that
can drift silently.

## Considered options

- **A herdr client port between the plane and herdr.** Rejected: the seam already carries three
  adapters - the child-process runner, the Stub runner over the Stub world, and the fake command
  runner - so a port of its own is indirection, and ADR 0073 already fixed the boundary at the
  Command runner. One seam, one more adapter.
- **Replace the fake command runner with the world.** Rejected: several suites exist to pin the exact
  command sequence, and a world that answers from a standing cannot show a reader which command the
  plane sent. The pin table is the right adapter when the command is the subject.
- **Keep the pin table and share the builders instead.** Rejected: that is what the 50 local builders
  already are, and eight of them are already shared by copy. A shared builder module over a pin table
  still leaves every suite writing the plane's protocol, and it cannot hold state, so the residue,
  seat, and shared-checkout gaps stay untestable.
- **Land the world before the Seeded plane.** Rejected, and ADR 0131 records the same rejection from
  the other side: the world has nowhere to be handed to until one module owns the runner every suite
  gets. The fixture is that owner, and the world is one adapter behind it.
- **Make the world file-backed like the Stub world, for one shape across both.** Rejected: the file is
  what makes the Stub run walkable by a human, and no human edits a test's herdr world. Sharing the
  storage would put a temporary file between a test and a fact it names in one line.
- **Let the world answer any plausible herdr command, not only the plane's.** Rejected: an answer for
  a command the plane never sends is untested code, and it hides the one failure this decision exists
  to make loud - a plane command the world does not model.

## Consequences

The plane's external protocol has one home. A herdr argument change lands in the world, or in the one
suite whose subject is that argument, and not in nine. A test states a standing in the domain's words
and never names a command, so it survives a command change it was never about.

The suite gains assertions it cannot write today: a close of a workspace the world never created, an
`agent list` that must agree with the `agent start` the same test drove, a name the world already
holds. Those are the residue, seat, and shared-checkout facts the pin table could only imitate.

The clone count falls and the audit sees it fall, because issue #360 put the suite in scope first.
The pinned argument vectors fall to the suites whose subject is the argument.

The cost is real and named. Five flows move, one per change. The world is a new module with its own
suite, and its surface check must be maintained against the plane's commands, which is a standing
cost the closed-surface check turns into a test failure rather than a drift. The migration is
behavior-preserving: a step that changes an assertion is a step that found a defect, and that defect
is filed in the same push rather than folded into the migration.

The main risk is stated plainly: **the world can drift from the real herdr binary**, and a suite that
passes against a world that answers wrongly proves nothing about the operator's run. Three things
hold it, and none of them is this suite: the closed-surface check, the traced answer shapes with the
untraced ones recorded as unverified, and the Stub run and the terminal walks, where herdr runs for
real. This decision moves no ground truth; it makes the automated suite's claim about herdr explicit
enough to be checked.

Each change records the clone count, the pinned-vector count, and the flows moved at the head it
measured them on, with the machine state beside one full `bun run test` on the merged tree. A file
that fails in the full suite and passes alone is named as a load flake, and the CI frame-test flake
stays open in
[the quality gate verification record](../verification/quality-gate.md); this decision does not touch
it. This decision claims no screen-reader support.

Issue [#361](https://github.com/SeriousJul/my-little-software-factory/issues/361) is the spec for
this change. Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) blocks it: the
duplication scope lands first so every later step is measured. Issue
[#362](https://github.com/SeriousJul/my-little-software-factory/issues/362) (ADR 0131) owns the
Seeded plane whose runner this adapter stands behind, and the two do not both hand a runner to a
surface.

The glossary's **Stub herdr world** entry names the module and its `_Avoid_` list, and the **Command
runner** entry now names the two doubles the automated tests inject at that seam. As with ADR 0122,
ADR 0128, ADR 0129, ADR 0130, and ADR 0131, the decision and the terms land before the change they
govern does.
