# ADR 0113: A worktree Consultation crosses the Shared checkout gate, and its wait is its row

Status: accepted
Date: 2026-10-07

Extends ADR 0109 (the Shared checkout hold) and ADR 0034 (the Work queue
holds a Consultation's wait). Closes ADR 0109's second open limit, which that
record tracked as issue #315.

## Context

ADR 0109 holds one Repository's shared checkout to one start at a time. A
Handoff whose Environment is a worktree and the merge Plane action cross the
gate their starts claim, and the record's measurement named the second pair it
missed: a Consultation whose Environment is a worktree runs the same branch
rule and the same worktree create as a Handoff, over the same checkout, with a
disjoint lock, and it takes no hold. The Consultation path answers the
collision with a failure, because a failure is the only answer it has: its
start dies, its record settles `failed` with a reason, and its row leaves the
queue.

The failure is wrong in the way a dropped queue item is wrong (ADR 0049): the
checkout being at work says nothing about the Consultation's own work, and the
work is not lost - it is the operator's own interactive work, started on the
operator's own ask. And the gap is not the queue's: the Consultation start
path that reaches the checkout without a queue row at all - the direct start
of a record the operator's start now key ran on - has no row to stand a wait
in, so the queue cannot own its wait either.

## Decision

**The Consultation crosses the gate its start claims.** A Consultation whose
Environment is a worktree takes the Shared checkout hold of the checkout its
start creates the worktree from, from its claim until its start settles - the
same span the worktree Handoff holds, because the checkout is free the moment
the worktree stands and the Agent works inside it. The hold gains a
Consultation side beside its Ticket side and its Plane action side: the same
gate, the same budget, the same two clocks, the same wait entry - keyed by the
Consultation id, and one classification that names the start's side and its
registry word, so the record line a Consultation waits in reads as a
Consultation. A Consultation whose Environment is a live-worktree takes no
hold: the operator chose and owns the checkout that start works, and the live
checkout's safety rule is its own rule (ADR 0109's first open limit is
unchanged).

**The gate lives at the start's claim, on every start path.** The crossing
runs where the Consultation start claims its record - the pickup the Work
queue's rows, the force-dispatch, and the immediate pass of a direct ask all
pass through - so the gate covers the start paths the queue does not hold: a
direct start that fails the gate is refused with a reason like any start the
operator asked for, and nothing about it is a queue matter.

**The three acts of a Consultation that finds the checkout at work are: name
the wait, keep the row, refuse with a reason.**

- *Name the wait.* The wait entry is the record's own: the record names it
  once while it stands, the way the handoff's wait stands, and the entry is
  dropped when the row leaves, so a new wait starts fresh on its own reading.
- *Keep the row.* A Consultation whose row waits stays in the Work queue with
  its place and its record's `queued` state: the pickup that finds the
  checkout busy is not a pickup that drops, and the row is not a failing item
  the queue must clear (ADR 0049).
- *Refuse with a reason.* The waiting row's own wait is bounded by the
  checkout work's budget on the row's own clock (ADR 0109): a Consultation
  row that has waited past the budget is refused the way a dropped item is
  named - its record settles `failed` with the fact, its row leaves the queue,
  and the record's line wears the Consultation's own name, so the refusal is
  read as the Consultation's refusal.

**A direct start that holds no row answers the key.** A start of a record
that keeps no queue row - the record the operator's Delete unscheduled, the
record the operator's start now key ran on - finds the checkout at work and
has no row to stand the wait in: the key answers with the fact, the start runs
nothing, and the record keeps the state it wears.

**The refusal's two halves keep their owners.** The refusal's record state is
the Consultation operations' - they own the record - and the dispatch asks it
for the refusal the way it asks it for the pickup. The refusal's record line
and the row's removal are the dispatch's, the way the pickup's record lines
and its drops are: the operations refuse nothing on their own, and the
dispatch writes no record state of its own.

## Consequences

- The checkout gate covers all three start types of the pair ADR 0109
  measured and the Consultation it missed: a merge, a worktree Handoff, and a
  worktree Consultation of one Repository never reach that checkout at the
  same time.
- A Consultation row that waits for a checkout is a row like any other: it
  keeps its place, its `queued` badge, and its force-dispatch and its removal,
  and it is refused by its own wait's bound, not by the checkout's busy
  state.
- The two clocks keep their two facts (ADR 0109): the hold's age ends the
  hold and names its holder, the row's wait ends the row and names the busy
  Repository, and a Consultation refusal reads as a Consultation's, not a
  Ticket's.
- The Consultation operations gain one seam: the hold they cross, the refusal
  they are asked for, and the release their start settles with. The dispatch
  gains the hold it drives and the refusal it asks for. Neither module gains a
  second lock over the checkout: the operations' per-Repository lock stays
  the start's own lock, and the hold stays the checkout's one fact.
- ADR 0109's second open limit is closed: the carve-out it recorded as open
  is the rule this record holds.

## Unverified

- The terminal walks have not been re-run: the `waits:` line a Consultation
  waits in, and the refusal line a Consultation is refused with, are held on
  the `log` seam and in the suite, and the screen-reader path is not verified.
- The wall-clock cost of a Consultation's wait on a running plane is not
  measured: the bound is the checkout work's budget, the same bound the
  handoff's wait wears, and the number that would move it is the merge's hold
  duration ADR 0109 names as the trigger.
- No new frame test: the gate crosses no surface, and the lines it writes are
  the record's lines.
