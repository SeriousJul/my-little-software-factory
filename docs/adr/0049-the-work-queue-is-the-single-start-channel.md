# ADR 0049: The Work queue is the single start channel

Status: accepted
Date: 2026-09-22

## Context

The Work queue held only what the Parallel cap blocked: a manual start that
could not take a seat, and a Consultation whose submit met a full cap
(ADR 0034). A manual start with a free seat started at once, and every
automatic start, the open dispatch, the workflow route, and the restart,
never entered the queue at all: a full cap refused it and its own cycle
retried it. The automatic work the factory was about to start was
invisible, unordered, and beyond the operator's reach, and the queue's
pane hid itself while it was empty.

The operator wanted the queue promoted to the one surface that answers
"what starts next": every start passes through it, its pane is always on
the Main view, the operator steers its order, and the queue can never sit
stuck.

## Decision

**Every start enters the Work queue, and the pickup is the only starter.**
The manual handoff of an open ticket, the route from the Decision screen,
the restart from the Missing modal, the Consultation launcher's submit,
and every automatic start, the continuation, the restart, and the new
open ticket of the auto top-up (ADR 0051), all land as queue items first.
A start that cannot take a seat at once waits in the queue, and a start
with a free seat is picked up in the same tick: an immediate pickup pass
follows every enqueue, so the ask never waits for the next observation
cycle. This supersedes the shape of ADR 0034 in which only the
cap-blocked manual starts entered the queue and the automatic starts
never did. The cap itself is unchanged: it counts Consultations as seats,
and it is the pickup scheduler's check, not the pickup's.

**The queue cannot jam, because every item reaches an exit.** The hard
checks, the ticket still holds the state the item's origin requires, the
source is healthy and re-read, the attempt ledger is clear, and the
Consultation's type still exists, run at the enqueue: a start that
already fails refuses to enter, and the warning stands on the Message
line at the ask. The Consultation's settings fit is the one check that
runs at the start, not at the ask: it asks the agent runtime for its
Model list, and a waiting item must answer to the config it starts
under, not the one it entered behind. While an item waits for a seat, no
failure state can hold it: a pickup attempt ends in start or drop, never
in stay. A dropped item leaves the queue with its warning, the ticket
keeps its state and its own failure surface, and a Consultation's failed
start leaves the terminal `failed` record it always left. The pickup
failure rule and the force-dispatch failure rule become one rule. This
supersedes ADR 0034's pickup that left a failing item in the queue to
retry it, and the once-per-reason warning bookkeeping that made the
repeats quiet.

The exits are start, drop, cancel, the operator's remove, the
restart-or-route race, and the covering fixing pull request, and a
Consultation answer. The only way the queue stays non-empty is items
validly waiting on seats: visible on the header, and escapable by remove,
by force-dispatch, or by closing a stuck agent.

**The Work section is always visible.** It keeps its header row while it
is empty, exactly as the Ticket and Consultation sections do, and the
hiding logic of ADR 0034 goes. It starts expanded with its list visible,
it collapses to its header with `x`, and it takes its minimum rows in
the frame split like the other sections. The frame's floor rises with
the third permanent section.

**The queue owns the ordering keys.** `+` and `-` promote and demote the
item under the cursor, the keys the operator already knew for raising
and lowering a rank, and `u` and `d` are removed, so the queue has one
key system. Delete removes an item and Enter force-dispatches it, as
before.

**Enter on a waiting row jumps to its item.** In the list pane, Enter on
a ticket row or a Consultation row that has a waiting queue item moves
the cursor to that item in the Work queue, where the queue's keys act on
it. The detail panes keep their own keys.

## Consequences

- ADR 0034's decisions that an automatic start never enters the queue,
  that a pickup that fails a check leaves the queue with its item
  standing, and that the Section stays hidden while it is empty and
  collapsed, are superseded by this ADR. Its decisions stand: one cap
  over all running work, the Consultation seats, one item per ticket,
  the force-dispatch, the restart-or-route race cancellation, and the
  Consultation pickup seam.
- ADR 0034's rejected alternative, automatic items visible in the same
  queue and reorderable by the operator, is taken: the automatic adds
  are one at a time into an empty queue (ADR 0051), and the priority
  that once ordered them is retired (ADR 0050), so the queue order is
  the only order, and the operator steers it directly.
- Every start has a visible, cancellable window between the ask and the
  agent. A free-seat start still starts in the same tick, so the manual
  handoff keeps its pace.
- A start the operator enqueued over a temporarily stale source is
  dropped with a warning instead of waiting silently for the fetch to
  recover: the ticket keeps its state, and one Enter re-enqueues it.
- The once-per-reason pickup warning bookkeeping is removed: an item
  fails at most once, so it warns at most once.
- The minimum terminal height rises: the third section's minimum joins
  the frame's floor beside the two that built it (ADR 0019).
