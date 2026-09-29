# ADR 0067: The routed ticket stands queued while its route stands

Status: accepted
Date: 2026-09-30

## Context

ADR 0064 recorded the route's decision at the ask: the operator's
`handed-off` and the factory's `auto-handed-off` land on the settled
turn's trace when the ask enqueues the item, and the ask never waits on
a run. The settled ticket's state, though, kept the `awaiting` face
until something else moved it: in the common flow the issue's implement
turn routes to the linked pull request's review task, the pull
request's handoff starts on the pull request, and nothing moves the
issue. It rests in `awaiting` until the operator closes the cycle by
hand - and in Auto-handoff mode nothing closes it at all, so decided
tickets pile in the list's top band, beside the turns the operator had
not decided yet. The Ticket header's awaiting count, the top of the
list, and the state file all said the ticket still owed a decision, and
the decision was made.

ADR 0064 covered the face with the Queue wait window: while the route
item waited in the Work queue, the row and the detail wore the `queued`
badge in place of the state badge. The badge told the truth, but the
state beneath it did not, and every read of the state - the counts, the
band, the walks - answered the question the decision had already
answered.

## Decision

The routed ticket leaves `awaiting` at the ask, and stands `queued`
while its route stands.

**The ticket state list gains `queued`.** Beside `open`, `handed-off`,
`running`, and `awaiting`: the state where the ticket's turn is decided
and its route's start waits in the Work queue for its pickup, or runs on
its position ticket. One typed constant, no schema migration: the
ticket's state column is unconstrained text. The badge role table takes
the new value in the open role's color, the way the Queue wait badge
paints today, and the row and the detail read `[queued]` from the state
itself.

**The route ask moves the ticket at the enqueue.** The dispatch
module's route ask moves the settled ticket from `awaiting` to `queued`
in the same state write that lands the decision on the turn's trace
(ADR 0064). The move is guarded on `awaiting`, so a re-confirm of a dead
route finds the ticket already `queued` and stands as a no-op, and a
refused claim records nothing and moves no state (ADR 0064 stands).

**The start report moves both tickets in one write.** The started
ticket's gate accepts `queued` beside `open` and `awaiting`, so a route
to the ticket's own new position moves `queued` to `handed-off` in its
own cycle, and the rework keeps the passage it began. The named settled
ticket, carried on the start report's details and normalized to null
when the route's position is the started ticket itself, moves `queued`
to `open` with an incremented cycle number when the handoff starts on a
different ticket: the common route owes no manual close, and in
Auto-handoff mode the decided ticket never rests in the top band.

**The workflow claim gate accepts `queued`.** The same-position pickup
claims its own ticket, and the cross-position claim finds the settled
ticket's route still standing in the state it moved to at the ask.

**A drop or a cancel leaves the ticket `queued`.** The item leaves the
queue, not the decision and not the state: the decision screen stays
reachable, the route row stands live again for the re-confirm, and the
top-up's continuation walk re-offers a `queued` ticket whose automatic
route is dead, same-position and cross-position alike. The
pending-turn resume walk and the machine's automatic close walk keep
reading `awaiting` alone: a queued ticket owes the machine no
decision, and its turn does not reopen over a decided trace.

**The close over a waiting item cancels the item.** The close on a
queued ticket ends the cycle the way the close on a settled turn does -
the `closed` decision on the settled trace, the cycle back to `open`
with an incremented number - and removes the waiting item when one
stands, in the same answer. A closed cycle never leaves a live start in
the queue, and the close cleanup takes the shared dispatch seat the
other close paths use.

**The decision screen widens to the queued ticket.** The Decision
modal's contract moves from an awaiting ticket to an awaiting or queued
ticket, and the open decision screen keeps rendering when the route
confirm moves the ticket to `queued` on its own surface. The Live
view's mode gives a queued ticket the decision body in both modes; the
missing, closed, and stream modes never read it, because the queued
ticket holds no agent and wears no missing marker. Goto stands on a
queued ticket as before.

**The list reads the state.** The Attention band rides the queued
ticket first in the in-flight band, before `running`, so the wait reads
as the earliest stage of in-flight work, and the awaiting band holds
only the turns that still owe a decision. The Ticket header's pipeline
counts gain no queued count: the waiting fact is the Work section's own,
and its depth carries it. The queued ticket rides the live band's rank
by newest external update, the way the in-flight states do.

**A restart finds the pair together.** The ticket's state and its
queue item both stand on the state file, so a restart while the item
waits finds the queued ticket beside its item, and the pickup resumes
the wait without a manual nudge. The boot recovery settles the claims
the dead run left unsettled (ADR 0041) and moves no ticket: a claim
that never settled never moved its ticket, and the queued ticket's
claim, like any other, stands with its item.

## Considered options

- **Keep `awaiting` and widen the badge window.** The Queue wait badge
  already painted the truth, but the state beneath it kept answering the
  decided question as undecided: the counts, the band, and the walks all
  read it, and a state the decision had already left could never close
  itself in Auto-handoff mode.
- **End the cycle at the ask for the cross-position route.** The cycle
  could not end until the route's handoff started: a start that the
  pickup refused or the operator cancelled would have closed a cycle
  whose work never began, and the ticket would have rested `open` with
  no way back to the passage it routed.
- **Give the queued ticket its own band above `awaiting`.** The wait is
  in-flight work: the decision is made, and the work is on its way.
  Riding it before `running` in the in-flight band keeps the awaiting
  band honest and the in-flight band complete.

## Consequences

- The Ticket state list grows to five values, and the state-backed
  reads - the gate, the settle, the decision write, the walks, the
  bands, the badges - take the new value where the decision says it
  stands.
- A routed ticket in Auto-handoff mode closes its own cycle: the
  cross-position close lands at the position handoff's start, and the
  same-position passage continues into the rework.
- A dead route in manual mode rests in `queued`, not `awaiting`: the
  operator's re-confirm and close both stand on the decision screen,
  and the close takes the item with the cycle.
- The `queued` badge the Queue wait painted for a routed awaiting
  ticket becomes the state badge itself, and the open ticket's manual
  queue wait keeps its badge over the `open` state: the two waits keep
  their distinct facts.
- ADR 0064 stands as corrected here: the decision records at the ask,
  a re-enqueued route re-lands the same decision as a no-op keeping the
  first ask's time, and a refused claim records nothing. What changes
  is the face the ticket wears while it waits: the state, not the
  badge, says `queued`.
- The Consultation's `queued` state and the manual start's queue wait
  badge are out of scope: the word is shared, and each keeps its own
  behavior (ADR 0049, ADR 0052).
- The verification record's open items stand unchanged: the
  screen-reader path is not verified, and a skipped required check is
  not a pass.
