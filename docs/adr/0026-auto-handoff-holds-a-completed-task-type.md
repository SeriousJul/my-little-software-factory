# ADR 0026: Auto-handoff holds a completed task type

Status: accepted
Date: 2026-09-15
Superseded in part by ADR 0051: the hold gates the auto top-up's adds instead of the direct open dispatch. Its rule is unchanged.

## Context

ADR 0005 ends a work cycle at close and returns the ticket to `open` at
once, so the close-and-rehandoff loop is possible; the Handoff limit bounds
it. The re-verify gate behind the open auto-handoff defends the loop against
one case: the cycle's agent changed the source item (a merged pull request,
a closed issue), and the stale fetch still lists it. The gate waits for the
source to re-read the ticket; an item that left the list does not dispatch,
and an item that is still open re-verifies and dispatches.

The gate's premise fails for work that hands off to another ticket. The
`implement` task type opens a pull request and leaves its issue open: the
pull request closes the issue at merge, and the follow-up work (review,
merge) runs on the pull request's own ticket. For the whole review window
the issue is open, listed, and actionable, and the task rules still suggest
`implement`. Auto-handoff closes the cycle, the gate re-verifies the
still-open issue, and the dispatch starts `implement` again on finished
work. Each repeat re-runs an agent on a clean tree; the only bound is the
Handoff limit, a dozen idle agent runs per ticket.

The label the source query filters on is the pipeline's "work is needed"
signal, and the task template tells the implementing agent to remove it when
it opens the pull request. An agent that omits the removal leaves the signal
up, and the control plane cannot tell a left-behind signal from real new
work: both read as the same suggestion.

## Decision

**The Same-type hold.** The open auto-handoff does not dispatch a ticket
whose newest closed cycle settled a `completed` turn of exactly the task
type the ticket now suggests. A completed work needs no repeat; progress
needs a new signal. The hold ends when the ticket's suggested task type
changes - the agent or the operator flips a label the rules read - or the
ticket leaves the source list.

The hold reads the newest cycle-end decision - the same row the re-verify
gate reads - and the task type and cause that row records. A cycle closed
after an `aborted` or `failed` turn holds nothing: that work did not
finish, and a retry is the next move. A cycle whose turn never settled,
whose abandon wrote its own trace row, holds nothing: the row carries no
cause.

The hold gates the open auto-handoff only. A manual handoff always passes
it, exactly as the Parallel limit and the Handoff limit do: the operator
who re-hands-off a just-completed type chooses the repeat, and the control
plane records the choice in a new cycle. Workflow routes are untouched:
they start from a routed decision inside an open cycle, never from a closed
one.

The hold is derived from the completion traces on every cycle and never
stored, so a restart cannot lose it and it cannot drift from the fact it
describes, exactly as the Dispatch pause (ADR 0016).

The considered alternatives:

- Hold on raw label churn, not on the suggestion. Rejected: the suggestion
  is the work the dispatch would start; comparing facts the dispatch never
  uses still starts the same finished work when the churn keeps the
  suggestion constant.
- Store a snapshot of the item's facts at cycle end and compare it to the
  newest fetch. Rejected: it stores state per cycle the control plane must
  keep, and it fails the same way when the agent's own edits keep the
  suggestion constant.
- Let auto mode auto-close only the auto-close task types. Rejected: it
  stalls the label-driven pipeline. The review-to-merge progression on a
  pull request rides the close-and-rehandoff loop, and holding every
  non-auto-close type in `awaiting` parks the pipeline on an operator
  keystroke per ticket.
- Have the control plane clear the work signal itself. Rejected: the
  control plane never writes to the external source; the label is the
  operator's and the agents' fact.
- Do nothing and let the Handoff limit bound the repeat. Rejected: a dozen
  idle agent runs per ticket to learn what the hold states in one cycle.

## Consequences

- An `implement` that finishes while its issue stays open rests as an open
  ticket the auto-handoff will not touch until the suggestion moves. The
  ticket is visible and stays manually handoff-able: the operator can force
  the repeat, and the control plane records it in a new cycle.
- The label-driven pipeline keeps its rhythm: review settles, the label
  flips, the suggestion changes to `merge`, and the dispatch runs. The hold
  never fires on a changed suggestion.
- The Handoff limit keeps its role as the last bound. The hold is the first
  line, and it states in one cycle what the limit only bounds.
- A cycle the operator closes by hand after a completed turn holds the same
  way: the close is a cycle end, and auto-handoff will not repeat the
  completed type without a new signal. The operator who wants the repeat
  presses it themselves.
- The re-verify gate, the Dispatch pause, and the Parallel limit are
  untouched. The hold is one more derived check on the same open
  auto-handoff path, beside them.
