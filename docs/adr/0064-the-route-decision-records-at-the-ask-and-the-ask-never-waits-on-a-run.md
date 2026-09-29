# ADR 0064: The route's decision records at the ask, and the ask never waits on a run

Status: accepted
Date: 2026-09-29

## Context

ADR 0049 made the Work queue the single start channel: every start enqueues,
and the Pickup takes a free seat now or holds the item until a seat frees.
ADR 0051 added the top-up, one automatic item per cycle, a continuation
first. The decision on a routed turn recorded at the start, though: the
operator's `handed-off` and the factory's `auto-handed-off` both landed on
the settled turn's trace only when the routed Agent went live, through the
dispatch module's start report.

Between the confirm and the start stood the whole start chain: the seat wait
in the Work queue, the route's previous-environment close (ADR 0046), the
dispatch module's one run seat, the placement write, the environment build,
and the Agent start. While it stood, the settled ticket wore the `awaiting`
face with the decision still pending, and the Attention band held it at the
top of the list beside the turns the operator had not decided yet. The
operator had decided; the plane showed the turn as if it had not.

The run seat held the operator's asks as well. While one handoff run stood
in flight, the catalogue refused the Hand off, the Decide, the Override
confirm, the force-dispatch, and the route edit with "a Handoff is
active." The operator could not stage the next start until the current run's
whole chain ended, so several starts landed one chain apart, not in quick
succession.

## Decision

The decision records at the ask, and the ask never waits on a run.

**The decision lands when the ask enqueues.** The route's decision - the
operator's `handed-off` from the Decision modal's route row or the Live
view's decision sub-mode, and the top-up's `auto-handed-off` for each of its
routes - lands on the settled turn's trace when its ask enqueues the item,
not when the start goes live. The dispatch module is the one seam every
handoff ask passes through, and it records the decision there, for the
operator's route and the factory's alike, when the enqueue stands. A refused
claim records nothing. The start-report answers stop recording the
decision: they keep their refresh, their drop answers, and their cancel
answers. A re-enqueued route re-lands the same decision as a no-op, and the
record keeps the first ask's time.

**A dropped or cancelled start keeps the decision.** A drop or a cancel
removes the item, not the decision: a fact is not rewritten. The ticket
rests in `queued` with the decision recorded (ADR 0066). The operator
re-confirms the route from the decision modal or closes the cycle, and both
paths stand as before. The top-up's continuation walk re-offers a turn
whose decision is `auto-handed-off` and whose route is dead - no handoff on
its position, no waiting item - the way it re-offers a pending turn, so a
dropped auto route re-enqueues on the next empty-queue cycle as it does
today.

**The decision modal presents the route's fact.** The route row stands live
only when the route is dead: no queue item waits for it, and its position
holds no handoff. While the route lives, the row is a fact line naming where
it stands: waiting in the Work queue, starting, or running on its position
ticket. Close and Goto stand always, and the Close on a decided turn ends
the cycle the turn routed from, the way it does today.

**The ask controls never wait on a run.** The "a Handoff is active" gate
narrows to normal Quit alone. The Hand off, the Decide, the Override
confirm, the force-dispatch, and the route edit all answer while a handoff
run stands in flight: the ask is an enqueue, and the queue, the claim gates,
and the one-item-per-ticket rule absorb the rest. The run seat keeps
serializing the starts: the asks land in quick succession, the start chains
run one at a time, and the Agents work in parallel afterward.

## Consequences

- The settled ticket leaves its decision-owed face at the confirm. ADR 0066
  supersedes the consequence stated here: the ticket leaves `awaiting` for
  the `queued` state at the same ask, and its row and detail wear the
  state's own badge, while the Queue wait window keeps its badge for the
  manual start alone. The CONTEXT.md entry for the Queue wait names both
  waits.
- The trace's decision line carries the ask's time, not the start's time. A
  turn whose route is confirmed but not yet started reads as decided to the
  observation's walks: the awaiting walk skips it, the continuation walk
  re-offers it only when its route is dead, and the turn does not reopen
  over a decided trace.
- The decision's record leaves the pickup and the force-dispatch answers and
  gains one home in the module's dispatch, where every ask already passes.
  The app's route confirm drops its own decision recording, and the
  module's public decision seam leaves with it.
- Quit keeps its gate: a Quit mid-run orphans the environment build, and the
  boot recovery settles the run (ADR 0041). The gate stays on the one
  control that tears down the process rather than asking for work.
- Concurrent starts stay out of scope. The run seat serializes the start
  chains, and the Agents parallelize afterward. A pace the serialized starts
  do not keep is a separate design.
- The queue pause and the Dispatch pause stand where they are: the brakes
  hold the pickup and the automatic adds, and the manual ask still enqueues
  behind them (ADR 0016, ADR 0052).
