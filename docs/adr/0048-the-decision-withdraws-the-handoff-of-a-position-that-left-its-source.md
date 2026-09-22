# ADR 0048: The Decision screen withdraws the handoff of a position that left its source

Status: accepted
Date: 2026-09-22

## Context

A settled turn's recorded outcome names the position the machine offers:
the task, on the ticket the fire's labels derived it for (ADR 0027). The
Decision screen builds its offer from that record: a handoff row for the
position's task, beside the Close and the Goto. The record is a fact of the
moment the fire ran. The screen's offer is not.

Between the fire and the decision, the ticket the position sits on can
leave its source. A merge turn settles with the pull request open, and the
refresh that follows finds the pull request merged: the membership goes
inactive, and the position's ticket is in no list. The recorded outcome
still names the position - rework on the pull request - and the screen
offers the handoff of a task no state offers, the same stale offer ADR
0047 closes off at the fire for the state it derives from. A route the
operator confirms there would start a turn on an item every source has
dropped: the dispatch fails at its own seam, and the cycle's end reads the
ticket back from a source that no longer holds it.

The screen's own facts already answer the question. The projection keeps
the ticket the position sits on, and its state knows whether a current
source snapshot still lists the ticket. The offer can stand or withdraw
on that fact, at the render the fact changes.

## Decision

**The Decision screen offers the handoff row only while the position's
ticket is still listed in a source.** When the render finds the position's
ticket in no current snapshot - a merged or closed pull request, a closed
issue, a source that dropped the item - the row stands withdrawn, and a
fact line states the reason in its place: the position's ticket left its
source, and no handoff stands. The Close and the Goto keep: they act on
the settled ticket the screen stands on, not on the position.

**The guard reads the projection the screen already holds: one read of
whether the position's ticket still lists, at the render the offer
stands.** It issues no new read of the source at decision time, and it
writes nothing. The refresh cycle is the guard's clock: a decision that
stands open over a refresh that finds the position gone withdraws the row
in place, and the screen follows the projection without the operator
asking. A decision that opens on a projection that already holds the
answer opens withdrawn.

## Consequences

- A merged pull request behind an open Decision stops offering rework: the
  row stands withdrawn with its reason, and the Close stays the way out.
  The operator reads the same fact the fire now reads (ADR 0047), from the
  side that shows it.
- The offer follows the projection, not the record: a refresh that finds
  the position gone withdraws an already-open decision in place, and a
  refresh that finds it listed keeps the row. The record itself stands
  unamended: the fire's facts stay what the fire wrote.
- The guard is display-level: it withdraws the offer, it does not clean up.
  The labels the fire wrote on a merged pull request stay until the
  operator takes them down, and the awaiting ticket keeps its settled
  turns until the operator closes the cycle.
- The screen's handoff offer and the dispatch seam's refusal can still
  meet in the gap the projection's refresh leaves between two reads: the
  guard's lag is the refresh interval, the same lag the projection's other
  facts keep.
