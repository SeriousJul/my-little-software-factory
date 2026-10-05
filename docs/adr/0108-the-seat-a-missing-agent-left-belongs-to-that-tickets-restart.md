# ADR 0108: The seat a Missing Agent left belongs to that Ticket's Restart

Status: accepted
Date: 2026-10-06

Extends ADR 0021 (a seat is held from the claim, not from the listing) and ADR 0051
(the Top-up tops up the Work queue one item at a time). Amends ADR 0021's missing
rule and ADR 0051's empty-queue rule over the Restart add. Extends ADR 0100's queue
rank with the second row that does not enter at the tail.

## Context

ADR 0021 frees a seat for a Ticket whose own Agent the latest poll does not list past
the Startup grace, so the Missing path can restart it. ADR 0021 named the net for the
double start that slips past the grace: "the handoff name collision fails the second
start cleanly". That net is the Ticket's own Agent name, and it catches only the
Ticket's own Restart starting beside its own booting Agent.

The seat the freed Ticket leaves is open to every start standing in the queue, and
nothing about it says who it belongs to. A dev run measured the result, with
`max-parallel-agents = 1`:

```text
18:50:14.939  handoff 5fb1d997 starts its review Agent in pane w15V:p5
18:59:05.899  consultation started: "free" a28133c8 (mode pickup, origin consultation, seats 0/1)
19:03:47.329  completion trace: handoff 5fb1d997 settles, cause completed
```

The review Agent ran for thirteen minutes. At 18:59 the plane counted no seat for it,
so the queued Consultation took the limit of one on top of a running Agent. The plane
said nothing about the seat it had just freed: the Missing path reports no line, and
the Top-up's Restart line names the restart, not the seat.

The seat is freed, and two things want it:

- the Ticket's own Restart, which ADR 0051 adds only into an empty queue, and
- every start already standing in the queue.

The standing row wins, because the queue's order puts it first and the empty-queue
rule never lets the Restart row in to be second. So the seat the Missing Agent left
goes to unrelated work, and the Ticket whose Agent the plane judged dead waits behind
the start that took its seat.

Measured at the unit seam on the real state, the real dispatch module, and the real
observation cycle, with one seat, one Ticket `handed-off` on a pane the poll does not
list aged past the grace, and one queued Consultation: the seat count answers 0, the
pickup starts the Consultation, and the cycle's own Top-up then adds the Restart row
behind it.

ADR 0021's grace is the right bet for the Restart: it self-clears, and it costs at
most one grace of restart delay. The hole is not the grace. It is that the freed seat
is handed to a start the collision net cannot see, and that the row which owns it is
the one row the queue's pace rule keeps out.

## Decision

**The seat a Missing Agent left is reserved for that Ticket's Restart row.** The
Pickup hands it to that row and to no other start, the way ADR 0094 gives the seat a
settling turn freed to that turn's own next step. A start that wants a seat wants a
free seat, and the reserved seats are not free.

**One seat reading answers both facts.** `parallelSeatAccount` returns the held count
and the Tickets whose own Agent the latest poll does not list past the Startup grace
and that hold no seat through an unresolved claim. `parallelSeatCount` is that
reading's count, so the mode cell, every cap gate, and the Pickup's reservation read
one rule and cannot disagree about which Ticket is Missing.

**The reservation is released where no Restart row can ever come.** The Top-up
restarts a Ticket that carries the ignore flag, a Ticket at its Handoff limit, and no
Ticket at all while Auto-handoff mode is off. A seat no Restart row will take is not
reserved: that is the seat that starves every other start in the queue, and it is the
failure ADR 0021 rejected when it refused to count every in-flight Ticket.

**The Restart walks past the standing row, and its row leads the queue.** ADR 0051's
empty-queue rule holds the fresh-work adds, and it holds the Restart out of the only
seat that is its own, so the standing row is not a hold for the Missing Agent's
Restart. The Restart row enters behind every owed continuation and ahead of the
standing rows: ADR 0100's rank over the continuation holds, and the reserved seat is
spent on the row it belongs to and not on the row that got there first. The standing
row stays the open-ticket add's hold, so the Top-up keeps its one item per cycle.

**The Pickup measures the reservation at every seats-bound item, not only at its
head.** The pass is not the only taker of a seat, and the walk awaits, so the live
gate reads the held seats plus the seats still reserved: a second pass cannot spend a
reserved seat across an `await` either.

**The Plane action's row is not held by the reservation.** ADR 0068: it takes no
seat, so the walk runs it whatever the seats read, and the early return that skips a
seats-bound walk under a full cap has to see a reserved Restart row too.

**The operator's Force-dispatch passes the reservation, as it passes the cap.**
ADR 0052's rule is the operator's explicit ask over the scheduler's gate, and the
reserved seat is the scheduler's fact.

**The Restart's start is the seat's answer.** It takes the reserved seat, and the
seat is spent: the row that starts leaves a live Agent in it, and the row that fails
leaves the seat free for the next pass. The reservation never outlives the row it
belongs to, so it cannot hold a seat the plane has no answer for.

## Options considered

- **Count every in-flight Ticket, Missing included.** Rejected for the same reason
  ADR 0021 rejected it: a seat a truly dead Agent holds never frees, and the queue
  starves on it. The reservation is that option with the escape ADR 0021's option
  lacked - the row that owns the seat is guaranteed to reach it.
- **Reserve the seat only against the Consultation, the start the dev run measured.**
  Rejected: the shape is the seat, not the kind. A queued fresh start, a routed
  start, and a Consultation all take a freed seat the same way, and the collision net
  sees none of them.
- **Leave the empty-queue rule and reserve the seat anyway.** Rejected: it deadlocks.
  The standing row keeps the Restart row out of the queue, the reserved seat keeps the
  standing row out of the seat, and nothing starts. This is the reason the queue's
  pace rule is amended in the same decision as the reservation.
- **Lengthen the Startup grace.** Rejected: the measured Agent was unlisted for
  thirteen minutes, and a grace long enough to cover that is a grace long enough to
  park every restart behind a dead Agent. The grace is the right bet; the seat's
  owner is the missing fact.
- **Report the freed seat and change nothing.** Rejected as the whole answer, kept as
  a consequence: the seat the plane hands to unrelated work is worth a line, and the
  Top-up's Restart line now names the seat it is the answer for. It does not stop the
  start, and the issue's over-cap start is what has to stop.
- **Give the reserved seat to the Restart row at the head of the queue, ahead of the
  owed continuation too.** Rejected: ADR 0100 ranks the owed continuation over every
  standing row, and the seat a settling turn freed for its own next step is not
  outranked by a seat the plane is holding for a restart.

## Consequences

`parallelSeatAccount` in `src/parallel.ts` is the seat reading; `parallelSeatCount`
stays the count every existing reader calls. The Pickup takes a new seam,
`missingSeatTickets`, wired from the same facts read the count reads, so the two
readings of one poll cannot drift.

The Work queue's position rule now knows two rows that do not enter at the tail: the
automatic continuation (ADR 0094, ADR 0100) and the automatic Restart. It reads
`is_automatic` beside `origin` to keep the continuation's rank.

The Top-up's fresh-work walk reads its queue-depth hold as the open-ticket add's hold
and the Restart add's non-hold. The hold states itself in the record exactly as it
did, so a cycle that asked a Restart past a standing row states the row's hold once
and asks no open ticket.

The over-cap start the issue measured is gone: a queued Consultation, a queued fresh
start, and a queued route cannot take a Missing Agent's seat. What replaces it is one
cycle of delay for the Restart row, the poll interval at most, and the standing row
starting on the seat that Restart leaves.

The seat a Missing Agent left is now a fact the plane acts on and states through the
Restart row's own lines. It has no line of its own at the moment the seat frees: the
Missing path still reports nothing, and the record names the Restart, not the seat.
The screen-reader path is not verified, and the terminal walks have not been re-run on
the theme-inherited paint.
