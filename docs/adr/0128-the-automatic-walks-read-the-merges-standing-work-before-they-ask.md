# ADR 0128: The automatic walks read the merge's standing work before they ask

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

The same count has a second window, before the claim. While the merge's row
stands in the Work queue - held by the Shared checkout hold (issue #297), or
standing behind a seat-bound row the pickup's walk breaks at - the two
continuation walks still ask for that Ticket once per cycle. The fresh-work walk
reads the queue's own row above its add (`openTicketWaitsHold`); the continuation
walks run no such read, because ADR 0094 lets a continuation enter a queue that
already holds a row. Each of those asks lands on the queue's one-item-per-ticket
refusal, which states one `merge refused: ... (already has a waiting queue item;
...)` line per standing row. A row at the head of the queue stands for one
pickup; a row held by the checkout hold stands for many cycles, and the walks
ask through all of them.

The report that opened this (issue #352) quotes the Message-line warning ADR 0125
removed. That line does not stand at head: the report was written from a build of
`2a3d2564`, and ADR 0125's commit landed forty-two minutes before the report and
reached that machine one minute after it. What still reproduces is the
multiple ask the warning was the symptom of.

## Decision

**The merge's standing work is a gate the automatic walks read before they ask.**
Two facts say the merge is already entered: the Work queue's row for the Ticket
(ADR 0049), and the run's mark the claim took over from that row (ADR 0104). The
dispatch module owns the mark, so it answers for it: the seam
`planeActionRunInFlight(ticketIdentity)` says whether that Ticket's Plane action
run stands - claimed, not settled. The seam is required beside `dispatchPlaneAction`
on the cycle's options, not optional with a default: a wiring that leaves it out
goes back to the shape this ADR exists to close, and says nothing when it does.
The mark is keyed by the Ticket alone, not by the task type, because the Plane
action set holds only the merge; the seam's own record names that as the fact to
re-open if the set grows.

**One step reads both, in one order.** The observation cycle reads them in its
plane action ask step, the one step all three automatic walks cross, beside the
blocked attempt's hold that step already reads. The order is the work's own life:
the Work queue's row, then the run's mark that the claim took over from that row,
then the blocked attempt's hold, and only then the ask. The first fact that
stands wins the line, the way the cycle's other gate reads answer; the three are
exclusive in time in a normal run, and the order is what the record states when
they are not. The dispatch's own guards keep their order - the claim check, then
the queue's row, then the run's mark - and they answer whatever crosses the walk's
read.

**The walk states the hold it took, not a refusal.** The hold words are the ones
ADR 0125 introduced - `automatic walks hold: the Work queue already holds an item
for the Ticket (...)`, and `automatic walks hold: the Ticket's merge is already
running (...)` - stated once while the fact stands. The ask step returns the same
hold whether it read the fact itself or the ask refused it, so one standing fact
has one key and one line wherever it is reached.

**The ask's guards stand.** `dispatchPlaneAction` still refuses an ask for a
Ticket whose queue row stands, and one whose run is in flight, before the
enqueue, with the same reasons and the same `queue-row` and `merge-run` standing
facts. The gate is a read of the fact at one moment; the window between that read
and the enqueue is exactly where ADR 0104's guard lives, and the guard is what
keeps two `gh pr merge` commands off one pull request when the operator's
confirm, a force-dispatch, or a second walk crosses the mark.

**The refusal line keeps its meaning.** `merge refused:` now answers an ask that
crossed a standing fact, not the automatic walks' every-cycle re-ask. The line
and its shape are unchanged.

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
- **Close only the run's window, and record the queued window as open.**
  Rejected: the queued window is the same mistake one step earlier, and it is the
  longer one whenever the Shared checkout hold stands (issue #297). The fresh-work
  walk already reads that row above its own add; the continuation walks reach the
  same ask step, so the read belongs there and not in a second rule per walk.
  Recording it open would leave "one merge earns one ask" true only for part of
  the merge's life.

## Consequences

One merge earns one ask across its whole life in the queue and in the run. The
development record loses one `merge refused:` line per merge and keeps the hold
line it gained from ADR 0125.

ADR 0125's rejected option - "have the walks check the queue and the run mark
before they ask" - is adopted for both facts, and only as a gate beside the
guards, never in place of them. Its stated reason against, that the window between
the check and the ask is where the duplicate lives, is answered by the guards
standing: the gate stops the repeat, the guard closes the window.

The Handoff channel keeps its shape: its continuation asks still reach the
queue's one-item-per-ticket refusal, and that refusal still states one line per
standing row. This ADR changes the Plane action's ask step only, because the
issue is the merge the plane asked for itself.

The verification record names the seams that measure the walk's reads - the gate,
and the ask that crosses the mark and takes the guard's refusal - and the
configuration reference states when a `merge refused:` line lands.
