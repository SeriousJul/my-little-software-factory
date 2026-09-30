# ADR 0072: The route's ask ends the source ticket's cycle

Status: accepted
Date: 2026-09-30

## Context

ADR 0067 stood the routed ticket `queued` from the ask until the route's
start: the decision screen stayed reachable, the route row stood live for
the re-confirm, and ADR 0069 moved the cycle end earlier for the
operator's removal of the item. The design's promise was the screen: the
operator could watch the route, re-confirm it, or close over it while it
stood.

The list, though, wore the wait. The queued ticket rode the in-flight band
while its route's start waited in the Work queue. In the common flow - the
issue's implement turn routes to the linked pull request's review task -
the operator met two rows for one story: the issue, wearing its queued
face, and the pull request, wearing its queue-wait badge. The story was
already told by the pull request's row, and the issue's row said the same
wait a second time. The ticket left the list only when the route's handoff
started, not when the ask enqueued the item, and the operator met exactly
that in the live factory: the routed ticket stood beside its position
through the whole wait window.

The cycle end already stood in the decision writer, the way a close makes
it: the close on a settled turn ends the cycle, and the close on an
already-decided turn ends it with the recorded decision standing. The ask,
though, learned a second move - `awaiting` to `queued` - and the plane
carried two ways to leave a decided turn. The operator's own words for the
rule: the close logic, properly called at the ask, and the ticket leaves
the list with it, covered by its fixing pull request, the way a closed
cycle's ticket does.

## Decision

The route's ask ends the source ticket's cycle in the same write that
lands the decision.

**The ask's move is the cycle end.** A route ask - the operator's confirm
on the Decision screen, the automatic route of the top-up, and the route
of a Plane action's merge, alike - lands its decision on the settled
turn's trace and moves the settled ticket from `awaiting` to `open` with
an incremented cycle number, in the same state write. The trace keeps its
`handed-off` or `auto-handed-off` decision: a fact is not rewritten, and
the cycle ends behind it, the way the close on an already-decided turn
does. The move is guarded on `awaiting`, so a re-ask of a dead route lands
the decision as a no-op and bumps the cycle once, and a refused claim
records nothing and moves no state (ADR 0064 stands).

**The `queued` ticket state retires.** The state list returns to `open`,
`handed-off`, `running`, and `awaiting`. The state's gate entries, its
place in the Attention band, its Decision screen and Live view modes, and
its Close variant all retire with it. A state file written before this
rule may still hold a queued ticket: a heal at open moves every such
ticket to `open` with an incremented cycle number in one write, the way
the legacy `done` heal of the schema migration ran. The heal is a no-op
for a file the new rule wrote, because the state is unreachable after it.

**The routed ticket rests open and covered.** In the common flow the
source - the issue - goes `open` at the ask and wears its open fixing pull
request, so the list rule of ADR 0042 withholds its row from the ask on,
and the pull request's row carries the story. The hiding is the covered
rule's, not the ask's: a source whose route goes to a position that is not
its fixing pull request stands `open` in the list, the way a closed
cycle's ticket does. The wait is the position's own fact: the item the ask
enqueues names its position, and the position's row wears the queue-wait
badge while the start waits, the way the open ticket's manual wait wears
it (ADR 0064). A route onto the ticket's own new position - the rework -
waits the same way: the ticket goes `open` at the ask and its own row
wears the badge until the pickup claims it, and the rework's passage
splits at the ask, so each routed passage is one cycle the Handoff limit
caps by the handoffs it carried.

**The pickup's route gate retires.** The claim no longer asks the source
ticket's state whether the route stands: the source is `open` in the
common case, and the state can no longer carry the fact. The race check
stands on its own: a handoff of the item's ticket that started after the
item enqueued cancels the item, the way it does now, so a route whose
position the operator handed off by hand while it waited loses its seat to
that start. The claim's state gate drops the retired value from its list;
the position the route claims stands `open` or `awaiting`, the way the
continuation's position checks read it.

**The operator's removal keeps its finality.** The cancel of ADR 0069
ended the cycle the turn routed from; under this rule the cycle already
ended at the ask, so the removal takes the item and marks the route on the
turn's trace, the way the re-fired skip marks its trace (ADR 0054). The
mark says the operator took the route away, and the top-up's re-offer
skips a marked trace: the machine does not bring the route back. A drop
leaves no mark: the machine's failure, the route unrun, and the re-offer
stands.

**The top-up re-offers the dead route from the open ticket.** The
continuation walk reads the awaiting ticket whose turn the machine routes,
and the open ticket whose newest settled turn recorded an automatic route:
the decision stands at the ask, the start died with no mark on the trace,
and the position the decision named still offers the task it named, under
the position's standing checks - the standing, the ignore gate, the
Same-type hold, and the Handoff limit. A marked trace is not re-offered.

**The start report's move and the run's settle-back retire.** The
cross-position start report's move - the source from `queued` to `open`
with an incremented cycle - and the Plane action run's settle-back leave
the rules: the heal at open covers the files they stood for, and a guarded
no-op would only carry the retired state a second time.

**The Decision screen is an awaiting screen again.** Its contract returns
to the awaiting ticket: the route confirm ends the ticket's cycle on the
confirm's own surface, and the screen falls back to the list, which shows
the position the route waits on. The Live view's mode and the ticket's
close keep the awaiting ticket's contract, and the close's cycle-end
fallback on an already-decided trace stands as the heal for a state file
written before the rule that recorded the decision at the ask.

## Considered options

- **Keep ADR 0067's queued wait.** The design stood the state for the
  reachable decision screen and the live route row. Rejected: the wait
  window showed two rows for one story, and the ticket left the list only
  at the start. The screen the design kept was met as the second row, and
  the position's row already told the wait with its badge.
- **Withhold the queued ticket from the list by a list rule.** The row
  would stand out of the list while its route stood, the way a covered
  open ticket stands, and the state machine would keep standing. Rejected:
  the hiding would be a view over a state the decision had already left,
  the way the badge was, and the counts, the band, and the walks would
  keep answering the decided question as undecided. One rule - the ask
  ends the cycle - replaces the view, and the covered rule the list already
  runs does the hiding.
- **Re-offer the operator's removal, the way the drop is re-offered.**
  Under this rule both the drop and the removal leave the source `open`
  with the recorded decision, and the state file no longer tells them
  apart. Rejected: the removal is the operator's own act, and the machine
  that brought the route back would undo it. The mark on the trace keeps
  the drop's re-offer and the removal's finality in one walk.

## Consequences

- The routed ticket's face is `open` from the ask. The covered rule of
  ADR 0042 withholds it while its fixing pull request stands open, and its
  row returns when the pull request closes. The Attention band loses its
  queued place, the Ticket header's counts read the active view's rows,
  and no ticket in the list wears a state the state file no longer writes.
- A routed passage ends its cycle at the ask, cross-position and
  same-position alike. The rework's passage splits at the ask, and the
  Handoff limit still caps the loop, because it counts the handoffs the
  ticket carried, not its cycles. The agent's name takes the cycle number
  the ask moved, on the handoff the route starts.
- A dead route rests open. The operator recovers it on the position
  ticket, which stands in the list with its suggested task, and the
  automatic re-offer of the top-up stands on the trace the ask recorded.
  The Decision screen's re-confirm of a dead route and the close over the
  waiting item retire with the state they stood on.
- ADR 0064 stands as corrected here: the decision records at the ask, a
  re-ask of a dead route re-lands the same decision as a no-op keeping the
  first ask's time, and a refused claim records nothing. What changes is
  the move the ask makes with the decision: the cycle ends, not the wait.
- ADR 0067 stands for the face the routed ticket wore while its route
  stood, corrected here: the `queued` state retires, the cycle ends at the
  ask, and the start report's move and the run's settle-back leave the
  rules. ADR 0069 stands for the operator's act, corrected here: the cycle
  the removal ended ended at the ask, and the removal's fact is the mark
  on the trace, not the move on the state.
- The Consultation's `queued` state keeps its own behavior (ADR 0049,
  ADR 0052): the word is shared, and the Consultation's wait is its own
  state, not the ticket's retired one.
- The verification record's open items stand unchanged: the
  screen-reader path is not verified, and a skipped required check is
  not a pass.
