# ADR 0106: A run of failed Handoff starts parks its Ticket, and the park states itself

Status: accepted
Date: 2026-10-05
Extends ADR 0101 (and through it ADR 0077): the Attempt hold waits out one failed
start, and this decision owns the brake that stands when the re-ask on the
refresh keeps failing. Amends nothing about the Handoff limit: the cap still
counts every attempt and still ends the work cycle.

## Context

ADR 0101's hold releases when the Ticket's active sources re-read it. A source
read lands on every refresh and says nothing about the failure, so for a cause
outside the Ticket the hold is one refresh of delay, and the Top-up asks the same
failing start again on the next empty-queue cycle.

The development run over the night of 4-5 October measured that shape directly:
three Tickets, one failed start per Ticket per refresh, 20 attempts each inside
98 minutes, then the Handoff limit stopped the Top-up and the Tickets were left
open with no fact saying why. The same shape is older and larger than that
night: single Tickets have carried 9,356 failed attempts in about a day, 4,864 in
another, and 1,772 in a third.

Two things were wrong, and only one of them is the loop.

The loop is the cost: a start that never reaches its Agent is a claim, a herdr
call, and a settled row, once per refresh, forever.

The silence is the real fault: when the Handoff limit finally stops the Top-up,
the Ticket rests open and nothing on the row, the detail, the Message line, or
the record says that the factory stopped asking. The limit is a cap on a work
cycle, not a fact about a Ticket, and it arrives last. The operator meets a
Ticket that has been failing for a day and has no place to read that it was.

The nearest existing shape is ADR 0016's Dispatch pause: a failed Held turn stops
automatic dispatch, and the pause states itself on the Message line when it trips
and when it clears. That is the pattern this decision copies - a standing fact
with a voice - and it is deliberately not the same fact: the Dispatch pause stops
the whole factory, and a failing Handoff is one Ticket's trouble.

## Decision

**A run of failed starts is a standing fact on the Ticket: the Failed-start
park.** The Ticket's newest Handoff attempts, read back until one settled
otherwise or is still in flight, form one run when every attempt in it settled
`failed`. The park stands when that run reaches half the Handoff limit and the
operator has not judged the Ticket out. The rule is pure and lives in
`src/domain/failed-start-park.ts`; every reader asks that one predicate over the
facts it already holds, the way every reader of the Handoff limit asks
`handoffLimitReached`.

**The run is the attempt ledger's own order.** The boundary is the newest attempt
that is not a failed settle, and the run is every failed settle claimed after it.
The boundary is the row order, not the claim's time: two claims stamped in one
millisecond are told apart by which was claimed first, and a time-only boundary
would count a failure claimed before a start that reached its Agent as a failure
after it. ADR 0101's newest-attempt read orders `created_at DESC, rowid DESC` and
reaches the same answer for one attempt; the run needs the boundary of a set, and
the row order is the one that is exact.

**The park arrives before the Handoff limit, and the limit stays the one number
the operator sets.** Half the cap, so the park always stands while the cap that
ends a work cycle still stands behind it. No new setting: a second number the
operator would have to keep in step with the first is a second brake to explain,
and the cap already says how many starts the factory may burn on one Ticket. A
limit below two parks at one failed start, the earliest the fact can say
anything.

**While the park stands the Top-up adds no automatic start for that Ticket, and
the fact says so on both channels, once for as long as it stands.** The gate
stands in the top-up's Handoff ask, `topUpAsk`, behind the Attempt hold: the
first brake waits out one failure for the refresh, the second holds when the
re-ask on that refresh fails too. It gates the automatic adds only - the
operator's confirm, the pickup's claim, and a force-dispatch pass it, exactly as
the Attempt hold and the Handoff limit are passed.

The record names the hold in the voice the other walk holds wear (issue #223,
issue #231), and names the Ticket the walk reached, because a run with more than
one Ticket in play has to say which Ticket it left resting:

```text
automatic walks hold: the Ticket's Handoff starts keep failing ("Watch agent turns")
```

The Message line states the same fact as a standing warning, once, and the
Desktop notification carries it (ADR 0080):

```text
handoff failure park: "Watch agent turns" (6 Handoff starts in a row never reached an Agent)
```

The count is in the sentence because how many starts the factory has already
burned is what the operator weighs. The report is a memory of the last statement,
the way the held Next step's line is (issue #223): the park is derived on every
ask and never stored, a standing fact states itself once and not once per poll,
and a cycle that reads the Ticket and finds the park gone retires the memory, so
the next run of failures states itself again.

**The row and the detail name it.** The Ticket list wears a `failed starts`
marker in the lane the `handoff limit` marker already rides, and the detail
states the run and what it holds beside the `Handoff attempts: n/limit` line. The
fact comes from the projection's one read per cycle, so a surface states it
without a rule of its own.

**An operator act ends it.** A Handoff attempt that settled otherwise, or one
still in flight, ends the run: a manual start that reaches its Agent clears the
park and the automatic adds resume on the same rule, with no second act. A manual
start that fails extends the run, because the refusal it met is the refusal the
park names. The Ticket's own ignore, or the mute of one of its sources, is the
operator's answer to the failure, so the park leaves with it and the row stops
naming a fact the operator has already acted on.

## Options considered

- **Let the Attempt hold release later - a cooldown measured from the failure.**
  Rejected: a timer is a second clock the plane has to keep, the source read is
  the signal ADR 0077 chose on purpose, and a cooldown still says nothing about
  why the next ask did not come.
- **Raise the Handoff limit, or count failed starts separately against it.**
  Rejected: the cap ends a work cycle, and a Ticket that has had one good start
  per cycle should keep its cycles. Counting the failures separately would make
  the number that stops a loop and the number that ends a cycle two numbers again.
- **Stop the whole factory: treat a run of failed starts as a Dispatch pause.**
  Rejected: ADR 0016's pause answers a Held turn the operator must decide on, and
  one Ticket's broken start must not stop the other Tickets the factory can work.
- **Store the run length on the Ticket row.** Rejected: the attempt ledger already
  answers it, a stored counter is a second writer of a fact the settle owns, and
  the read is bounded by an index instead.
- **Cap the run read at the park's count and report a saturated number.** Rejected:
  the count is the operator's evidence, and a number that stops at the threshold
  would understate the 9,356-start Tickets this decision exists for.

## Consequences

The glossary carries the Failed-start park beside the Attempt hold, and ADR 0077
and ADR 0101 state where the park lives. The `max-handoffs-per-ticket` setting
keeps its name and its default; the park reads it and adds no setting of its own.

The run read joins the projection's one read per cycle, beside the count the
Handoff limit already reads from the same ledger. It is one statement per chunk
of Tickets, not one per Ticket, and the automatic ask reads it for the one
candidate it reached, the way the Attempt hold reads that candidate's newest
attempt. Measured on the real schema with 201 Tickets, one of them carrying 9,363
attempts, the batched read costs 2.4 ms with only `attempts_ticket_latest` behind
it; the v28 to v29 migration adds two partial indexes -
`attempts_ticket_reached` on the attempts that settled otherwise and
`attempts_ticket_failed` on the attempts that did not - and the same read costs
1.5 ms. The count the Handoff limit reads costs 0.4 ms on the same file, so the
run read is the larger of the two ledger reads the projection makes, and both run
once per cycle rather than once per candidate.

The park holds the automatic adds, not the ledger: the Handoff limit keeps
counting every attempt, and a Ticket whose park stands stays below the cap that
ends its work cycle, so the cap still reaches what comes after the operator acts.

The park is derived, never stored, so it survives a restart by re-reading the
ledger, and a Ticket parked before a restart is parked after it. What does not
survive is the report memory: a run that already stated itself states itself again
on the first ask after a restart. That is the same shape the held Next step's line
has (issue #223), and it is the honest one - the new run has not been reported to
this process.

The screen-reader path for the new row marker and detail line is not verified: the
suite reads frames and the fact module, and no assistive technology ran against
either.
