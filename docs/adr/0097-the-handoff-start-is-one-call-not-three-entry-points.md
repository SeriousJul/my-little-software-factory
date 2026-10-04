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
- **One facts builder feeds the pre-flight.** `choiceFacts` reads a `HandoffChoice`
  and reads an empty Task type as "no Task type". A Consultation record reaches
  the same rule through `consultationStartFacts`, which names each field it
  reads: a Consultation names no Task type, and a future Consultation field must
  not enter the pre-flight because it happens to share a fact's name.
- **One outcome shape.** The Consultation copy is gone and the nine casts are
  gone. The collision fields stay on the shape, because the naming rules produce
  them on both paths.
- **One reader per herdr response shape.** `readWorkspaceList` owns the
  workspace-list shape, `workspaceHeld` and `workspaceAtCheckout` own the two
  lookups, and `herdrHandles` owns the Workspace id, Pane id, and Tab id read at
  every start site.
- **One cleanup rule reads one record.** The start writes a `Residue` as it
  creates each handle, and `removeResidue` removes exactly what that record
  holds when the Agent never starts. The coverage is therefore the same on every
  Environment kind. No start builder closes anything itself: an incomplete herdr
  answer returns its residue like any other failure. What pre-dates the attempt
  never enters the record, so a stored Workspace, a branch the repository already
  carried, and a pull request the read found all stand (ADR 0062, ADR 0076).
- **The branch policy stays a fact, not a merge.** A Ticket branch is reused and
  a Consultation branch is refused. The naming rules are untouched.
- **The resource recorder stays injected, and its wording travels with the
  request.** The record must land before the next external step, so it is not a
  return value. The Consultation's Close panel owns the resource table, so the
  Consultation caller passes its own labels; the shared Environment builders hold
  no surface's vocabulary.
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
  comment.
- A contributor reads one start sequence. `src/handoff.ts` is not a smaller file
  after this cut - it is 2,609 lines - but it holds one start, one pre-flight,
  one workspace reader, one handle read, and one cleanup rule instead of two or
  seven of each. Splitting the Environment builders, the pull request open, and
  the prompt render out of the module is the natural next cut.
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
