# ADR 0069: A cancelled route ends its ticket's cycle

Status: accepted
Date: 2026-09-30

## Context

ADR 0067 lets a routed ticket stand `queued` while its route stands: the
decision screen stays reachable, the route row stands live for the
re-confirm, and the top-up continuation walk re-offers a `queued` ticket
whose automatic route died. It decided that a drop or a cancel leaves the
ticket `queued`: the item leaves the queue, not the decision and not the
state.

The two removals are not the same act. A drop is the machine's failure: the
pickup's start fails, the item leaves with its warning, the route stands
unrun, and the ticket's re-offer keeps the design's promise. A cancel is
the operator's own act on the row the queue shows: the operator saw the
item and chose to take it away. For the cancel, the resting state has a
gap. The `queued` state says the route's start "waits in the Work queue for
its pickup, or runs on its position ticket". A cancelled route satisfies
neither, and the state stands until the re-offer lands - which the top-up's
own pacing (ADR 0051) holds while any other item waits in the queue. The
factory met exactly this gap in the live state: a route item removed by
hand left the ticket wearing its `queued` badge in the main view with no
item behind it, for as long as the queue stood non-empty.

## Decision

The operator's cancel of a Handoff queue item ends the cycle of the route
the item named. The removal and the move are one write: the row leaves the
queue, and the ticket the row names as the route's source moves `queued`
to `open` with an incremented cycle number, the same move a close makes on
a settled turn. The decision the ask recorded stands on the trace: a fact
is not rewritten, and the cycle ends behind it.

**The cancel is the operator's act, not the queue's.** The move runs only
on the operator's removal - the Work queue section's Delete, through the
dispatch module's cancel seam. The pickup's claim, the drop's removal, and
every other internal path keep their own removal: the item leaves and the
ticket keeps its state, the way ADR 0049 and ADR 0067 stand. A dropped
route still rests `queued`, and the continuation walk still re-offers it
when the queue empties.

**A start with no route keeps the ticket's state.** The move is the
route's consequence, named by the row's route-source column. An
open-origin item the operator cancels leaves its ticket exactly where it
stood, the way the removal always did.

**The guard is the state.** The move runs only from `queued`. A source that
already left the wait - a close that won the race, or a pickup whose start
already moved it - keeps the state it holds, and the cancel takes the row
and nothing else.

**The cancelled route is not re-offered.** The ticket rests `open`, and the
continuation walk reads only `awaiting` and `queued` tickets: the operator
took the route away, and the machine does not bring it back. A new start of
the ticket opens a new cycle, and its own turn decides again.

The same write hygiene lands on the Consultation's pointer removal: the
pickup's start, the close, and the delete each repack the queue's places
behind the pointer they take, the way every other removal does, so a queue
that mixes the two kinds of item never holds a number it does not use.

## Considered options

- Keep ADR 0067's cancel rule: the ticket rests `queued` until the top-up
  re-offers the route. Rejected: the top-up re-offers only when the queue
  is empty (ADR 0051), so with any standing queue the ticket wears a state
  its own definition does not hold - no item waiting, no route running -
  until the operator acts again. The operator met this resting state as a
  stuck label on the main view.
- Return the ticket to `awaiting` on the cancel. Rejected: the awaiting
  state says no completion decision is made yet, and the trace holds one.
  The ticket would wear a state that lies on the decision, beside a state
  that lies on the wait.
- Record a new decision on the cancelled turn's trace. Rejected: the ask's
  decision stands as the fact, and the cancel is not a decision of the
  turn. The cycle end is a move on the ticket, and it needs no trace.

## Consequences

The glossary's Work queue entry and the `queued` state entry carry the
cancel's move, and ADR 0067 stands for the drop, corrected for the cancel.
The `queued` badge leaves the ticket's row in the same frame the item
leaves the queue. A ticket whose route the operator cancels can start
again: the cancelled start may enqueue for its ticket, and a new cycle
opens with its own turn. The Consultation's pointer removals leave the
queue dense, and a queue that mixes both kinds of item shows no gap in its
places.
