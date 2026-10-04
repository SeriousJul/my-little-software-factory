# ADR 0100: The owed continuation outranks every standing queue row

Status: accepted
Date: 2026-10-04

Supersedes part of ADR 0094: the sentence "It waits behind an item the operator
staged". Its step order, its placement ahead of a fresh-work row, its one
continuation at a time, its one-item-per-cycle rule, and ADR 0051's empty-queue
gate over the fresh-work adds all stand.

## Context

A dev run on 2026-10-04 stopped a pull request's chain at the seat its own turn
freed, in the shape ADR 0094 already describes. The record is three facts:

- The operator staged a fresh issue in the Work queue by hand while the pull
  request's rework turn ran on the run's one seat.
- `08:30:21` - the rework turn settled. Its fired Transition wrote
  `ready-for-review` and derived its Next step: the review standing on that pull
  request itself, with no gate holding it. The Decision screen showed that review
  as the candidate handoff.
- `08:30:22` - the same cycle's pickup pass took the row the operator had staged,
  and the fresh issue's implement started. The review was never asked, and the
  settled turn's herdr workspace stood open with no start running in it.

ADR 0094 holds the continuation behind "an item the operator staged". That clause
was written to keep the machine from jumping an ask the operator made on purpose.
In this run it did the opposite of what the operator meant: the row was staged
because the seat was full, not because it was wanted ahead of the chain the
operator was watching, and the machine read the staging as a claim on the seat the
chain had just freed. From the operator's side the run said: the Decision screen
offers the review, and the plane started a different ticket instead.

The two facts the clause balances are not the same kind of fact. A staged row is a
request to queue work: it names no seat and no moment, and it waits for whichever
seat frees. A continuation is the next step of the turn that freed this seat, and
ADR 0094 already says whose seat that is. Ranking the first above the second
reopens the miss ADR 0094 was written to close, one row type at a time.

## Decision

**The owed continuation outranks every standing queue row.** Its row enters at the
head of the queue, ahead of a fresh-work row and ahead of a row the operator
staged alike. A continuation already standing keeps its place at the head, so the
queue's pace of one continuation stands, and no row the queue already holds moves
relative to another.

**The queue's depth is no gate over the continuation.** `continuationQueueHolds`
reads one fact: whether a continuation already stands. The gates every automatic
add keeps - Auto-handoff mode, the queue pause, and the Dispatch pause - are
unchanged, and the fresh-work adds keep ADR 0051's empty-queue gate unchanged.

**The operator's controls over a row they staged are the explicit ones.** The
queue pause holds the pickup, so a staged row keeps a freed seat to itself. Enter
on a queued row, and the force-dispatch, start it now, over the cap and over the
pause (ADR 0034). A row the operator wants started ahead of everything is started
that way, not by its place in the queue.

## Consequences

- The chain continues unattended through a freed seat whatever the queue held. The
  "the workspace never closed" symptom follows the path ADR 0094 names: the route's
  start runs on the settled ticket's stored workspace, so the leftover environment
  is reused instead of standing open with nothing in it.
- A staged row can wait one seat longer than it did. It cannot wait indefinitely:
  the continuation that jumped it takes a seat, runs, and ends, and the next free
  seat is the staged row's. The queue pause is the operator's brake on exactly this.
- A queued Consultation is a standing row of the same kind, so its start waits
  behind an owed row too. A chain of continuations can hold it for several cycles;
  Enter on its row starts it now, and the queue pause keeps the seat to it.
- The one-item-per-ticket rule is now what refuses a continuation for a ticket that
  already waits in the queue. The walk asks it, the dispatch refuses it, and the
  refusal is a line on the Message line. Before, the queue's depth stopped the ask
  before the walk reached that rule.
- `ContinuationRowFacts` loses its `operatorStaged` fact: a rule takes only the
  facts it reads (issue #202).
- `WorkQueueModule.workQueuePosition` places an automatic continuation at the first
  row that is no continuation, instead of at the first automatic fresh-work row.
- The Work queue screen still shows the order the pickup will take the rows in, and
  that order can now put a machine-owed row above a row the operator staged. The
  row's detail names who asked for it.
## Amendment: what "a continuation already stands" counts

Date: 2026-10-05

Issue #230 asked what this decision left open. `continuationQueueHolds` "reads one
fact: whether a continuation already stands", and the code classifies a standing row
by its origin alone, so a row the operator confirmed from the Decision screen -
origin `workflow`, `automatic: 0` - holds the next owed continuation out for as long
as it stands. The operator decided the question: yes, an operator-confirmed
`workflow` row counts as a continuation already standing.

**The pace rule counts a standing Workflow route row of either staging.** The
factory's own continuation and the row the operator's route decision left in the
queue hold the next continuation out alike. The rank this ADR decides is the owed
continuation's place in the queue's order - it enters ahead of a fresh-work row and
ahead of a row the operator staged alike - and that rank is not the pace rule: a row
that already stands is never overtaken by a row that has not entered. A row the
operator wants started ahead of a standing one keeps the queue pause, Enter on its
row, and the force-dispatch.

**The hold line keeps naming whose row stands.** `continuationHoldReason` answers
`continuation-standing` for the factory's own row and `operator-row-standing` for the
operator's, because the origin names both `workflow` and a record that calls the
operator's row a continuation names a fact the row is not (issue #223). The staging
is a fact that answer reads, so `ContinuationRowFacts` carries it beside the
`continuation` fact the hold itself rests on.
