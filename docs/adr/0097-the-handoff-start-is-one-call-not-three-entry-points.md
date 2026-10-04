# ADR 0097: The handoff start is one call, not three entry points

**Status:** accepted
**Date:** 2026-10-04

## Context

`src/handoff.ts` held one concept behind three entry points: `handOffTicket`,
`handOffStoredWorkspace`, and `handOffConsultation`. Each ran the same facts
through its own checks, in its own order, with its own wording, and each cleaned
up after its own failure in its own way.

Issue #204 measured the cost on both sides.

For the operator, one bad choice answered two ways. An unknown Agent type chosen
onto the reserved container Environment answered `the container environment is
reserved and not yet built` on the Ticket path and `unknown agent type: nope` on
the Consultation path. The Message line showed one reason and the Desktop
notification carried the same one, so the fact read away from the terminal was
not the fact the plane had read.

The same failure left different residue. A worktree Handoff removed what it had
created when its Agent never started. A live Handoff removed nothing. A
stored-workspace Handoff closed the fresh Tab but not the Workspace it had
created. A Consultation start in a fresh Workspace closed nothing. The operator
retried and met what the first attempt had left behind.

For a contributor, 2,719 lines and 64 functions held the rule at three places
and the same fact at seven: the workspace lookup at a checkout stood twice, the
read of the handles out of a herdr response ran at seven sites, and the outcome
shape was written twice and cast between the two copies nine times. The caller in
`src/handoff-dispatch.ts` picked between two entry points, so the choice of start
path was a rule a reader had to hold in their head.

ADR 0095 and ADR 0096 set the shape this branch follows: one interface per
aggregate, one module per concept. The handoff's start was the plane's biggest
start path and the last one that answered through several entry points.

## Decision

**The handoff has one start call, and every start path is a thin caller of it.**

- **`runHandoffStart` is the module's one start, and it is module-private.**
  `handOffTicket` and `handOffConsultation` are the interface the plane calls;
  each states the facts it owns - the choice, the resolved settings, the
  Workspace as a fact, the prompt, the name plan, the branch policy, and the
  command runner - and hands one request over. No caller outside the module
  builds a request, so the request's parts (`HandoffStartRequest`,
  `StartWorkspace`, `StartBranch`) are the module's own facts and not part of its
  public surface. A new Environment kind is added inside the module, not as a
  seventh start path.
- **The Workspace is a fact the caller states, never a branch the caller picks.**
  `fresh`, `stored`, or `none`. `handoff-dispatch.ts` no longer chooses between
  two entry points; it states the Workspace its previous Handoff recorded, or
  none. `handOffStoredWorkspace` is gone.
- **One pre-flight rule, in one order, owns every bad-choice reason.** Agent
  type, then Environment, then the Task type a Ticket start names, then the
  Environment a Task type that opens a pull request needs (ADR 0076), then the
  Setting fit. `checkStart` is the only writer of those sentences, and it runs
  before any external step, so no start resolves - and can clone - a repository
  it will never use. The Ticket path changed to the Consultation path's order,
  because that order was the readable one.
- **The bad-choice wording stays in `checkStart`, not in the shared presentation
  module.** The spec for this cut said the reason wording would come from the
  shared presentation module. It does not, and that is the decision:
  `src/components/shared/presentation.ts` owns labels, focus markers, state
  words, and the tested color pairs for the control plane's controls, and a
  handoff failure sentence is a domain fact about a choice, not a control's
  presentation. Putting it there would put a domain rule in the control library
  ADR 0014 keeps domain validation out of. `checkStart` owns the sentences the
  way the Setting fit module owns its own.
- **One facts builder feeds the pre-flight.** `choiceFacts` reads a `HandoffChoice`
  and reads an empty Task type as "no Task type". A Consultation record reaches
  the same rule through `consultationStartFacts`, which names each field it
  reads: a Consultation names no Task type, and a future Consultation field must
  not enter the pre-flight because it happens to share a fact's name.
- **One outcome shape.** The Consultation copy is gone and the nine casts are
  gone. The collision fields stay on the shape, because the naming rules produce
  them on both paths.
- **One reader per herdr response shape, and one stored-workspace lookup.**
  `readWorkspaceList` owns the workspace-list shape, `readStartWorkspaces` runs
  the ask both Environment builders share - list the workspaces and answer
  whether the one a previous Handoff recorded still holds - `workspaceHeld` and
  `workspaceAtCheckout` own the two lookups, and `herdrHandles` owns the Workspace
  id, Pane id, and Tab id read at every start site.
- **One cleanup rule reads one record.** The start owns a `Residue` and every
  Environment builder writes into it as it creates a handle, and `removeResidue`
  removes exactly what that record holds when the Agent never starts. The
  coverage is therefore the same on every Environment kind. No start builder
  closes anything itself: an incomplete herdr answer fails like any other
  failure. What pre-dates the attempt never enters the record, so a stored
  Workspace, a branch the repository already carried, and a pull request the read
  found all stand (ADR 0062, ADR 0076).
- **The record carries the kind it was recorded under.** Each handle enters the
  record as a `CreatedHandle` - a `ResourceKind` (`tab`, `workspace`, `worktree`)
  beside the handle - and `recordResource` answers with it. `confirmRemoved`
  reads the kind out of the record instead of spelling the word a second time, so
  the write into the caller's resource table and the confirmation of it cannot
  name two different kinds and leave the recorded row standing in silence (pull
  request #213 review).
- **A command that raises is a failure the start answers.** The steps from the
  Environment build through the prompt run inside one guard. A raise - what a
  `CommandRunner` adapter makes for a command it cannot run at all, and what an
  injected callback can make - answers as a failed start that runs the same
  cleanup a tagged failure runs. A raise after the Agent started answers as the
  failed prompt it is, because a started Agent is never rolled back. The
  production runner maps a spawn-level failure to a failed command, so this is
  the same rule `runPullRequestOpen` already held for its own commands, extended
  to the steps that run after the Environment stands.
- **The start takes the pre-flight as a fact, never recomputes one.**
  `HandoffStartRequest.startCheck` is required. The start used to fall back to a
  `checkStart` of its own; both callers always carried a check, so the fallback
  was dead code, and it let a caller hand in a check computed from facts the
  request did not state.
- **The branch policy stays a fact, not a merge.** A Ticket branch is reused and
  a Consultation branch is refused. The naming rules are untouched.
- **The resource recorder stays injected, and it travels with its wording.** The
  record must land before the next external step, so it is not a return value.
  The Consultation's Close panel owns the resource table, so the Consultation
  caller hands its recorder and its labels as one `StartResources` record: a
  start that records nothing carries none, and no row is ever written in wording
  the caller did not state. The recorder has a second half, `removed`, which the
  start's own cleanup calls for what it really took down, so the record holds no
  row for a handle the plane already closed.
- **The module keeps four injected callbacks, not the two the spec names.** The
  spec named the stage recorder and the resource recorder. The module also keeps
  `onAgentStarted` and `onRepositoryResolved`, because each is a durable write
  the caller must make before the next external step: the Agent's handles, so a
  run that dies mid-start still leaves the plane able to find the Agent it
  started, and the resolved checkout path, so the Consultation record names the
  directory its worktree was built from. Both follow the same ordering rule that
  keeps the resource recorder injected, and both stay optional: a Ticket start
  carries neither.
- **The filesystem work stays inside the implementation.** The repository
  resolution, the leftover worktree directory move, and the real path comparison
  run for real. A filesystem seam would have one adapter, so it would be
  indirection, not a seam (ADR 0073).

## Consequences

- The same facts answer with the same reason on every start path, on the Message
  line and in the Desktop notification, because one function writes the sentence
  and states the order.
- A failed start leaves the same residue on every Environment kind, and the
  contract is pinned by tests at the start interface rather than asserted in a
  comment. The keep-half of that contract - what pre-dates the attempt stands -
  is pinned by assertions that can fail (pull request #213 review, and
  `test/assertion-architecture.test.ts` refuses the assertion shape that could
  not fail). A cleanup that really removed a resource confirms the row the start
  wrote for it, under the kind the start wrote it under, so the Consultation's
  detail pane names no residue that is gone. The contract holds against a command
  that raises as well as one herdr refuses: the fake runner can stand a raise,
  and "the one start: a command that raises" pins it at the interface.
- A contributor reads one start sequence. `src/handoff.ts` is not a smaller file
  after this cut - it is 2,778 lines and 70 functions at the merge, and 2,967
  lines and 76 functions after the review's raised-command guard and the
  kind-carrying residue record landed - but it holds one start, one pre-flight,
  one workspace reader, one handle read, and one cleanup rule instead of two or
  seven of each. Splitting the Environment builders, the pull request open, and
  the prompt render out of the module is the natural next cut, and this branch
  made the module coherent rather than small.
- The tests assert the command sequence the start produces and the outcome it
  returns, through `handOffTicket` and `handOffConsultation`. No test reaches for
  a private helper, and the Consultation start sequence is now covered at the
  handoff interface instead of only by booting the app.
- The Command runner stays the suite's one seam. No new indirection was added for
  a rule with no second adapter.
- Two wordings the old shape carried are now single-owned: "the task type carries
  no prompt template" belongs to the render that needs the template, and a start
  that names no Task type answers with a whole reason instead of `unknown task
  type: ` with a trailing space.

## Considered alternatives

- **Keep three entry points and share the checks.** Rejected: the drift issue
  #204 measured is the order and the residue, and both are properties of the
  start path. Shared checks under three starts still leave three orders and three
  cleanup paths.
- **Export the start call as the module's interface.** Rejected for this cut: no
  caller outside the module needs to build a request, and an exported request
  shape pulls its parts into the module's public surface. The two thin start
  calls are the interface a caller can state facts in.
- **Put the Workspace lookup behind a caller-supplied adapter.** Rejected: the
  lookup is a herdr read through the command runner, which is already the seam
  with two adapters. A second seam over the same read is indirection.
- **Return the recorded resources instead of injecting the recorder.** Rejected:
  the record must land before the next external step, so a failure in the middle
  of the sequence still shows what may remain in the Close panel.
- **Merge the branch policy into one rule.** Rejected: reuse and refuse are two
  facts about two kinds of work, and merging them would decide the naming rules
  inside the start module. The policy travels as a fact the caller states.
- **Move the pull request Environment refusal into the start body, after the
  repository resolution.** Rejected on review of this branch: the refusal needs
  only the Task type record and the Environment, both of which the pre-flight
  already holds, and a reason written outside the pre-flight is the one reason
  that can drift again.
- **Move the bad-choice wording into the shared presentation module.** Rejected:
  see the Decision. `presentation.ts` is the control library's label, focus,
  state-word, and color module (ADR 0014); a handoff's failure sentence is a
  domain fact about a choice, and one start path's reason does not belong in the
  library every screen shares.
- **Let a raised command escape the start.** Rejected on review of this branch:
  the no-residue contract is stated absolutely, and an escaped raise skips both
  cleanups and leaves the created Workspace, worktree, branch, and pull request
  residue in place. Answering `failed` for every raise was rejected too: after
  the Agent started, the raise is a failed prompt, and a started Agent is never
  rolled back.
- **Re-check the pre-flight inside the start when a caller carries none.**
  Rejected: both callers always carry one, so the fallback was unreachable, and
  it let a check computed from facts the request never stated stand in for the
  start's own.
