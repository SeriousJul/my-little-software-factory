# ADR 0136: A claimed queue row stands until its start answers

Status: accepted
Date: 2026-10-12
Amends ADR 0051's empty-queue rule over the fresh-work adds: a row the
pickup claimed whose start has not answered is a standing row, so the
top-up's add lands on the cycle after the queue drains, not on the cycle
that drained it. The pace, the order, and the gates stand.

## Context

Issue #364 converges the observation cycle's test rig onto the real
`createHandoffDispatch` module. While converging the Story 24 test "a queue
that drains in the pickup's pass leaves the top-up free to add", the seam
the old rig ran diverged from the module it replaces.

The old rig's pickup removed the queue row at the claim. The row was gone
before the cycle's walks ran, so the top-up's empty-queue gate read an
empty queue, and the factory's add landed in the same cycle as the
operator's staging drained - the test pinned the order `["pickup",
"dispatch:open"]` for one tick.

The real module runs the claim differently. The pickup's claim takes the
seat and the handoff claim, but the queue row stands until the start
answers, success or drop alike:

1. The cycle's pickup pass claims the operator's item. Its start runs on
   behind the walk.
2. The fresh-work walk reads the queue while the row still stands, so its
   empty-queue gate (`queue-row-standing`) holds the factory's add for
   this cycle.
3. The start answers, and the row leaves with it.
4. The next cycle reads the queue empty, and the top-up adds then.

The converged test asserts the module's standing: one tick pins `["pickup"]`
with no dispatch, and the add lands on the second tick, after the settle,
as `["pickup", "pickup", "dispatch:open"]`.

## Decision

**The row standing until its start answers is the intended pacing.** The
top-up's empty-queue gate reads the queue as it stands: a row the pickup
claimed whose start has not answered is a row the queue holds, and it holds
the automatic adds out the way every standing row does. The factory's add
lands on the cycle after the queue drains, not on the cycle that drained
it, and the gate counts the depth of the queue's rows, not the starts the
rows started.

The same-cycle add the old rig pinned is not lost to the real module: it
happens whenever the start answers before the top-up's walk reads the
queue. ADR 0094's dev run is that case - the pickup's start answered nine
seconds into the cycle, the row left with it, and the same cycle's top-up
added the settled turn's review into the queue the start had emptied. The
module's pace is one rule on one read: the gate reads the queue where it
stands at the walk, and a fast start simply empties it before the walk.

The row is the fact the plane already owns, and both same-cycle
alternatives give it away. The queue's one-item-per-ticket rule answers
only for a row that stands, so the row is what keeps a second start of the
same ticket out of the queue while its first start runs. The row is also
the operator's handle on the start it waits for: the Work queue section
shows the claimed row, the operator reorders it, and a removal ends the
whole waiting start, including the claim the pickup already made. A start
that left the queue at the claim would stand invisible and unremovable
until its Agent's pane showed beside it.

The delay is bounded, and it strengthens the pace ADR 0051 names. The
start settles a few turns behind the walk that claimed its row, so the add
is at most one cycle late relative to the drained queue. And the operator's
staging does not merely start no later than the factory's: the factory's
add does not even enter the queue in the cycle the operator's staging
drained it.

## Considered options

- **Read the claimed row as drained for pacing.** The top-up's gate
  answers the empty-queue rule on a depth that skips the rows whose starts
  claimed and have not answered, so the add lands in the same cycle the
  operator's staging claimed its seat. Rejected: the gate would read a
  queue no other reader reads. The Work queue's list, its depth, and the
  reorder and the removal the operator makes on it all count the claimed
  row, and only the gate would not. One meaning of "the queue is empty"
  serves every reader, and the add the fiction frees in the drained cycle
  lands the next one whenever the start is slow - the timing ADR 0094's
  dev run shows, the rule would stop naming.
- **Remove the row at the claim, the old rig's seam.** Rejected: it
  retires the row's two jobs. The one-item-per-ticket rule would answer a
  second add of a ticket whose first start is still running, and the
  operator loses the reorder and the removal the row offers for the start
  between its claim and its answer. The settle and the drop paths that
  remove the row today would then refuse a removal nothing holds, or the
  removal would need a second, claim-only, path beside them.

## Consequences

- ADR 0051's empty-queue rule over the fresh-work adds stands, and its
  "the queue is empty" is the depth of the queue's rows: a claimed row
  counts until its start's answer removes it.
- The guaranteed add lands on the cycle after the queue drains. The cycle
  that drained it states the `queue-row-standing` hold on the row the
  pickup holds, and the next cycle's walk reads the queue empty and adds.
  A start that answers inside the drained cycle lands the add in that
  cycle, the way ADR 0094's dev run shows.
- The converged test (issue #364) pins the standing: one tick, `["pickup"]`
  and no dispatch; the start's answer removes the row; the second tick,
  `["pickup", "pickup", "dispatch:open"]`. The old rig's same-cycle order
  `["pickup", "dispatch:open"]` stands with the retired rig, and no seam
  reproduces it.
- The operator sees the claimed row in the Work queue while the start
  runs, and the reorder and the removal it offers act on the in-flight
  start, the way they already do.
