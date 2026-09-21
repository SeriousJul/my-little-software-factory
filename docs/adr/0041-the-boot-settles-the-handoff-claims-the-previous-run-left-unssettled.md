# ADR 0041: The boot settles the handoff claims the previous run left unsettled

Status: accepted
Date: 2026-09-20

## Context

A Handoff claims before it starts: the claim writes the attempt row, and the
dispatch settles it when the agent starts or the start fails. A run that ends
between the claim and the settle - a crash, a `kill`, a `bun --watch` reset -
leaves the attempt unsettled. The dead run cannot settle it, and the next run
never did either: the boot only opened the state.

The unsettled attempt blocks the ticket. The claim gate refuses a new handoff
with "handoff recovery is required before another handoff", and the ticket's
detail wears the recovery fact. The gate's promise of a recovery named no
recovery: no operator action, no startup path settled the remnant, and the
ticket stayed blocked until someone edited the state file by hand. ADR 0030's
"stays blocked across a restart" recorded that dead end as behavior, and the
Emergency exit's note - "may require Handoff recovery on the next start" -
named a recovery the plane did not take.

## Decision

The boot settles the remnants. After it takes the one-process lease and before
the UI opens, the recovery marks every unsettled attempt as a failed start
with the reason "the run that claimed this handoff ended before it settled
it", and the boot prints one note when it recovers any: how many claims the
previous run left. The lease is what makes this safe: only one run holds the
state at a time, so an unsettled attempt at the open belongs to a run that is
gone, and the dispatch that claimed it will never settle it.

The ticket's state never moves: a claim that never settled never moved its
ticket. An agent a dead run may have started is a leftover the operator sees
in herdr; the recovery writes no handoff row for it, and the leftover fact
and the Close cleanup cover it the way they cover any other leftover.

## Considered alternatives

- An in-app recovery action the operator takes on the blocked ticket.
  Rejected: a remnant blocks only across runs, and the run the operator acts
  from already saw the recovery at its own boot. The in-flight claim of the
  live run is a different fact - the Starting window - with its own face, and
  cancelling a live start is not a recovery.
- Leave the remnant and let the operator clear it in the state file.
  Rejected: that is the exact dead end this ADR closes, and a repair the boot
  can make in one settled write is not a reason to teach the operator SQL.
- Settle the in-flight claim in the dispatch's stop path. Rejected as the
  whole fix: the stop path sees a start that may already have begun, and the
  dispatch that settles it is the one that is dying. The boot is the one
  place that knows the previous run is gone, so it settles.

## Consequences

- A crashed or killed start costs the ticket a failed handoff and one
  restart, not a permanent block. The operator reads the recovery in the boot
  note, and the ticket is ready to hand off again on the next claim.
- The gate's recovery reason and the ticket's recovery fact now cover only a
  claim this run made in flight, which the handoff-active fact already names
  first. They stay as the state rule's words: a state that reaches them is
  broken, not normal.
- ADR 0030's "stays blocked across a restart" no longer holds: a remnant
  settles at the next open, and the ticket wears no recovery fact after a
  restart. The rest of ADR 0030 stands.
- The Emergency exit's note is true as written.
- The boot does one more settled write per start, even when it recovers
  nothing.
