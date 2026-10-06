# ADR 0116: The shipped machine gates a position on the source's own type label

Status: accepted
Date: 2026-10-06

## Context

Every issue-side gate of the shipped machine is a label the operator applies
for the machine: `ready-for-agent` opens the implement position, and
`ready-for-spec` opens the analyze position. ADR 0115 made those gates
reachable in an initialized repository: the act creates every label a state
match names, and it registers one issues feed per issue-side gate, because
GitHub search cannot union two `label:` qualifiers in one query.

Issue #330 adds the `diagnose` task type: the bug-diagnosis loop run against
an issue, on the ticket's factory branch, with the plane opening the draft
pull request at the Handoff start and the type's Transition writing
`ready-for-review` on it, exactly the way `implement` and the three security
types reach the review machine. That type needs a position, and a position
needs a gate. Two shapes stand open:

- a factory gate in the machine's own naming, `ready-for-diagnosis`, the way
  `ready-for-spec` works, so the machine starts a diagnosis only on an issue
  the operator handed it;
- the source's own type label, `bug`, which the repository's triage already
  writes and which the operator reads as a fact about the item rather than an
  order to the factory.

The second shape reaches work the operator already recorded, at the cost of
making a vocabulary the repository owns into a machine gate: the machine
starts on anything its initialized repositories call a bug.

## Decision

**The shipped machine gates its diagnosis position on `bug`.** The state is
`bug`, its match is `source-kind = "github-issue"` with
`labels-any = ["bug"]`, and it offers the `diagnose` task type. `bug` is a
Scoping label: no Transition writes it, so no fire adds it and no fire
removes it.

**State order carries the precedence, and the operator's act outranks the
source's label.** The state stands after `ready-for-agent` and
`ready-for-spec`, so a ticket carrying either stronger label rests on that
position and is never offered a diagnosis. The machine diagnoses only what no
stronger label claims.

**The init follows ADR 0115 unchanged, and the gate joins the fixed palette.**
`bug` takes GitHub's own spelling, `d73a4a` and "Something isn't working", so
the act leaves an existing `bug` label looking as the repository's owner made
it and gives a fresh repository the same face. Each initialized repository
gains a third issues feed, `<repository>-issues-bug`. The generator's version
does not bump: the rule that derives the label set and the feeds did not
change, the settings did.

**The brakes are the existing ones.** The Same-type hold rests a ticket whose
newest turn completed as `diagnose`, so the machine never re-diagnoses the
same bug on the same signal, and the Handoff limit caps the loop.

## Consequences

- A repository's own triage vocabulary becomes factory work. In a repository
  the operator initialized, with Auto-handoff mode on, every open issue its
  owner labels `bug` and no stronger label claims is diagnosis work, one
  Top-up item at a time. The operator's levers are the ones the machine
  already holds: which repositories it reads, the ignore, the source mute,
  the mode, and the Handoff limit.
- A gate the source writes is never cleared by the machine. A fire leaves
  `bug` on the surface, so the ticket stays on the diagnosis position until a
  stronger label lands or the operator moves it, and the Same-type hold is
  what stops the repeat rather than a label write.
- Every Initialized repository reads Init drift once, because the state set
  is an input to the init settings hash. The re-run act creates `bug` and
  registers the feed; until the operator runs it, GitHub refuses the label
  write and the position stays empty. The Group header's marker and the
  one-time Message note are the signal, as ADR 0115 states.
- The gate naming rule widens in one direction only. A gate may be a source
  fact rather than a machine naming convention; a `labels-none` label is
  still never created, and a label no state and no Transition names is still
  the operator's own.
- A `bug` label the operator deletes by hand comes back on the next re-init,
  because the settings name it (ADR 0115).
