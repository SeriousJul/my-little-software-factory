# ADR 0134: The settle that takes a Ticket's turn decides the trace it supersedes

Status: accepted
Date: 2026-10-09
Amends ADR 0016's consequence that the supersede stand-down leaves a trace no
surface can decide. The guard ADR 0016 added for issue #351 stands unchanged,
as does the pause it protects.

## Context

ADR 0016's newest-turn guard stands the Dispatch pause down when a later turn
of the same Ticket takes its newest settled turn - the restart of a Missing
agent, for one, whose own settle reads no session record and fails open to
`unknown` (issue #351). The guard is correct for the deadlock: the pause must
not hold every automatic start on a trace no surface can answer.

The trace the guard stands down is left undecided forever. The row's `held`
badge, the detail pane, the Decision screen, and the ignore refusal all read
`lastCompletion`, the Ticket's newest settled turn, and the pause releases on
a settle that is not `completed`. So a turn that settled `failed` can end with
no decision landed anywhere: the record plainly recorded the failure, no
surface offers it, and the factory keeps dispatching. Issue #359 owns this
harm, and ADR 0016's Consequences state it.

## Decision

**The superseded decision.** When a later turn of a Ticket settles, the settle
decides every undecided trace the Ticket still holds that is no longer the
Ticket's newest settled turn. The decision is `superseded`, landed with the
settling turn's completion time - the moment the later turn takes the Ticket's
turn - and the trace keeps its cause and its failure detail beside it. The
newest settled trace stays undecided, and a decided trace keeps the decision
it wears.

The decision is the machine's, and it is not one of the decisions the held
gate withholds: the held gate's decisions act on the Ticket's live turn - close
the cycle, go to the agent, reroute it - and a superseded turn is no longer
live. Its agent is gone, its cycle is shared with the turn that took it, and
none of the gate's decisions runs on it. `superseded` ends no cycle and routes
nothing; it records the fact that the turn was replaced, and it states that
fact once, on the trace, where the record keeps it.

The write stands in the settle's own transaction, beside the insert and the
refresh, and it takes the newest settled trace by the order the badge's reads
and the pause's guard share (`newestTraceOrder`), so the trace the settle
decides is the one the row stops showing. It runs on every settle, whatever the
trace it supersedes: a pending trace of the same cycle, a pending trace a
closed cycle left behind, and a pending trace whose stamp the settling clock
puts ahead of the settle's, alike.

The pause, the badge, the detail pane, the Decision screen, and the ignore
refusal read nothing new: they keep reading the Ticket's newest settled turn,
and a superseded trace is no longer one. The Same-type hold's read changes
with the write: the supersede puts the first decided trace in the current
cycle beside the newest one, and a decided trace wears a `decided_at` stamp
the newest undecided one does not, so the hold's current-cycle branch now
names the cycle's newest settled turn by the order the badge's reads share
(`newestTraceOrder`) - the stamp-sorted read would have answered the
superseded trace and cleared the hold on the very completed turn that just
settled (ADR 0093). The pause's newest-turn guard stands as the read's second
defense: a state file that predates this decision still carries the pending
trace the guard was added for, and the guard is what keeps the pause out of
it.

## Considered options

- **Keep the owed decision on the row until the operator answers it.**
  Rejected: the held gate's decisions act on the Ticket's live turn, and a
  superseded turn is no longer live - close, goto, and reroute all run on the
  turn that took it, so the Decision screen would offer decisions that act on
  nothing. And the Dispatch pause would have to keep reading the superseded
  trace for the operator's answer to release it, while the row - which shows
  the newest turn - wears no `held` badge for it: a pause that holds every
  automatic start on a fact no row shows is the deadlock issue #351 closed,
  and the guard that closed it exists for exactly that reason.
- **Derive the supersede instead of storing it.** Rejected: a derivation would
  stand in every read of every trace - the record's own reads, the walk's
  oracle, and any reader of the state file - and each of them could drift from
  the others. A decision on the trace is the record's own shape: the writer
  lands it once, and every read already takes it.
- **Supersede only the `failed` traces.** Rejected: the harm is a trace no
  surface can decide, not a failure the operator misses. A superseded
  `aborted` or `truncated` trace stands just as undecided, and a rule that
  closes only the failures leaves the same open record for the other held
  causes.
- **Supersede at the reopen, or at the cycle close, as well.** Rejected: a
  reopened turn settles again on its own trace, and the refresh overwrites
  it, so the reopen leaves a trace the Ticket still answers; and the cycle
  close is the operator's own end of the work, which ADR 0031 keeps apart from
  the completion decisions, so the next turn's settle is the moment the trace
  stops being the Ticket's turn.

## Consequences

- A superseded trace is decided at the supersede: it keeps its cause and its
  failure detail, wears `superseded` beside them, and the record states the
  failure once, at the moment the later turn takes the Ticket's turn. The
  failure was already stated at its settle, while it stood - the `held` badge,
  the detail pane's warning, and the Message line's warning - and it is stated
  no second time: the row, the detail pane, the Decision screen, and the
  ignore refusal keep reading the Ticket's newest settled turn, which is never
  superseded, and the factory keeps dispatching.
- After every settle, a Ticket holds at most one undecided trace, and it is
  the newest: the one the row shows and the Decision screen offers. The
  settle's write decides every other undecided trace the Ticket holds, the
  closed cycle's pending trace among them. Between a close and the next
  settle, that pending trace stands undecided in the record: the operator
  ended the cycle it stands in, the ticket rests open, and the next turn's
  settle decides it the way this decision states.
- The Dispatch pause is unchanged. Its read still takes the undecided `failed`
  trace only while it stands as the decision the operator owes, and a
  superseded trace is no longer one; the newest-turn guard stands as the
  read's second defense over the state files that predate the decision. The
  pause and the badge agree exactly as they did, and the factory's dispatch is
  untouched.
- `reopenTurn` reads no pending trace on a superseded handoff, so the turn
  that can settle again is the one the Ticket is on, and `applyCompletionDecision`
  lands no second decision on a superseded turn: the writer takes the first
  decision on a turn, and the supersede is it.
- The invariant walk's ledger records the superseded decision beside the
  walk's own, and its measured counts move with the write: 4398 steps leave
  the pause standing, 1094 release it across Tickets, and 41 let the
  current-cycle guard decide it. Removing the newest-turn guard no longer
  turns the walk red: the decision the guard was added for now stands on the
  trace it guards, so the guard's defense is the state file that predates it.
- ADR 0016's consequence that "the superseded `failed` trace keeps no decision
  forever" is retired by this decision. The guard ADR 0016 added for issue
  #351 stands as a second defense, and its one-way `completed` release, its
  per-Ticket scope, and its hold of the top-up's adds are untouched.
