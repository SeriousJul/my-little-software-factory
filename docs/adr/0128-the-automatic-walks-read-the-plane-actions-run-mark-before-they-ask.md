# ADR 0128: The automatic walks read the Plane action's run mark before they ask

Status: accepted
Date: 2026-10-09
Amends ADR 0104's consequence that the run's refusal is what the automatic walks
answer, and ADR 0125's rejected option about reading the mark before the ask. It
changes no refusal, no hold word, and no operator's ask.

## Context

The plane asked for a merge it was running, and said so in the record.

```text
04:56:29.785 merge queued: "The quality backlog: the campaign that shrinks the Quality baseline" (origin workflow, automatic)
04:56:30.074 merge started: ... (mode pickup, origin workflow, automatic, seats 0/1)
04:56:33.824 WARN merge refused: ... (already has a merge running; the first run stands)
04:56:34.167 automatic walks hold: the Ticket's merge is already running (...)
```

The merge landed. The development record carries 37 of these refusals across
2026-10-05 to 2026-10-09, and 10 of them after ADR 0125 took the Message-line
warning away (issue #327): the warning stopped, the ask did not.

The unit layer counts the asks. With one `gh pr merge` command held inside the
command runner, five observation cycles ask for the same merge eleven times
(`test/auto-handoff-chain.test.ts`, the same rig at its parent commit): the owed
continuation walk asks once per cycle, and the fresh-work walk asks once per
cycle beside it. The row of the merge left the Work queue at its claim, so the
queue's one-item-per-ticket rule cannot see the run, and neither walk reads the
fact that can.

ADR 0104's mark answers every one of those asks, and it works: the rig runs one
`gh pr merge` command and lands one attempt row. The guard is not the fault. The
asks are. A merge earns one ask, and the plane writes a refusal line for a merge
it is landing, on every merge it makes.

The report that opened this (issue #352) quotes the Message-line warning ADR 0125
removed. That line does not stand at head: the report was written from a build of
`2a3d2564`, and ADR 0125's commit landed forty-two minutes before the report and
reached that machine one minute after it. What still reproduces is the
multiple ask the warning was the symptom of.

## Decision

**The run's mark is a standing gate the automatic walks read before they ask.**
The dispatch module owns the mark (ADR 0104), so it answers for it: the seam
`planeActionRunInFlight(ticketIdentity)` says whether that Ticket's Plane action
run stands - claimed, not settled. The observation cycle reads it in its plane
action ask step, beside the blocked attempt's hold that step already reads.

**The walk states the hold it took, not a refusal.** The hold word is the one
ADR 0125 introduced - `automatic walks hold: the Ticket's merge is already
running ("<title>")` - stated once while the run stands. The ask step returns the
same hold whether it read the mark itself or the ask refused it, so one standing
fact has one key and one line wherever it is reached.

**The ask's guard stands.** `dispatchPlaneAction` still refuses an ask for a
Ticket whose run is in flight, before the enqueue, with the same reason and the
same `merge-run` standing fact. The gate is a read of the mark at one moment; the
window between that read and the enqueue is exactly where ADR 0104's guard lives,
and the guard is what keeps two `gh pr merge` commands off one pull request when
the operator's confirm, a force-dispatch, or a second walk crosses the mark.

**The refusal line keeps its meaning.** `merge refused:` now answers an ask that
crossed the mark, not the automatic walk's every-cycle re-ask. The line and its
shape are unchanged.

## Considered options

- **Leave the asks and keep only the refusal.** Rejected: the plane asks eleven
  times for one merge, and the record calls a merge it is landing a refusal, on
  every merge. ADR 0125 fixed what the operator read and left what the plane does.
- **Hold the Work queue row through the run.** Rejected for ADR 0104's reasons,
  which stand: the row is the claim, a row that stands through its run reads to
  the operator as a start still waiting, and removal and force-dispatch would
  reach a run already in flight.
- **Read the mark in each walk's own gate rule.** Rejected: the two walks reach
  the plane action from different facts, and the ask step is where both of them
  already read the plane action's other standing facts - the blocked attempt's
  hold sits there. One read, one place, both walks.
- **Move the mark into the state module beside the Handoff channel's in-flight
  fact.** Rejected: ADR 0104 put the mark in the module that owns the run, and a
  durable row before the run is what that ADR decided against. The seam is the
  module's own answer, not a second copy of the fact.
- **Give the mark a clock and let a stale mark expire.** Rejected: the run's own
  settle clears the mark through one `finally`, and the checkout hold's budget
  already states a start that stopped answering. An expiring mark would re-open
  the double ask the mark exists to close.

## Consequences

One merge earns one ask. The development record loses one `merge refused:` line
per merge and keeps the hold line it gained from ADR 0125.

ADR 0125's rejected option - "have the walks check the queue and the run mark
before they ask" - is adopted for the run mark, and only as a gate beside the
guard, never in place of it. Its stated reason against, that the window between
the check and the ask is where the duplicate lives, is answered by the guard
standing: the gate stops the repeat, the guard closes the window.

The verification record names the seam that measures the walk's read, and the
configuration reference states when a `merge refused:` line lands.
