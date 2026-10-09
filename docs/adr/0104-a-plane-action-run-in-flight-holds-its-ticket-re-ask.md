# ADR 0104: A Plane action run in flight holds its Ticket's re-ask

Status: accepted
Date: 2026-10-04
Amends ADR 0068's Plane action start: the claim of its Work queue row now also
takes a mark that stands until the run settles. It does not change ADR 0068's
rule that no durable attempt row stands before the external change.
Amended by ADR 0133: the automatic walks read that mark as a standing gate before
they ask, so the run's refusal answers only the ask that crosses the mark. The
mark, its guard, and its refusal stand.

## Context

The merge of pull request #224 landed, and the plane wrote a block beside it.

The development install's log carries the two asks a second and a half apart:

```text
15:45:24.292 merge queued: "The Auto-handoff mode reads as a lamp cell in the Ticket header" (origin workflow)
15:45:24.477 merge started: ... (mode pickup, origin workflow, seats 0/1)
15:45:25.743 merge queued: ... (origin workflow)
15:45:25.914 merge started: ... (mode pickup, origin workflow, seats 1/1)
```

The state file carries the two attempts they left, 678 ms apart:

```text
3ab87c79  merged
e22260df  blocked  GraphQL: Merge already in progress (mergePullRequest)
```

The pull request merged. The plane posted a comment on it anyway - "The factory's
merge was blocked: GraphQL: Merge already in progress (mergePullRequest)" - and
recorded a blocked attempt, which sets the Attempt hold (ADR 0077) on a merge
that had in fact succeeded.

This is not a #224 one-off. The same install carries 8 attempts blocked with
`Merge already in progress`, from 2026-10-01T01:20:24Z to 2026-10-04T17:19:32Z,
and every one of the 8 Tickets also carries a `merged` attempt: the merge landed
and the plane reported a block over it. 14 of the 27 Tickets that were merged
carry exactly two attempts.

The second ask is the auto top-up doing its job. The merge ask enters the Work
queue, the pickup's claim removes the row, and the `gh pr merge` command runs for
seconds. The observation cycle runs on its poll and again when a source fetch
lands, and the owed continuation walk (ADR 0100) re-asks a route whose item no
longer stands. The ask's own guard is
`hasWorkItem`, which answers for a row that still waits in the queue; the row of
a merge already running left the queue at its claim, so the guard answers clear.
The second row enqueues, its pickup runs, and the source answers the second
command as a block.

The run's fresh read (ADR 0068) cannot close this. It reads the pull request
record before its own command, and while the first merge is still landing the
source answers `open`. Where the two asks fall far enough apart the read does
absorb the second - #221, #218, and #215 each carry two `merged` attempts and no
block - so the race is intermittent by timing alone, and the read is not a guard
against it.

Nothing in the state names a Plane action run that has claimed and not settled.
ADR 0068 decided deliberately that the attempt row is written after the run, so
that a crash between the external change and the record settles on the restart
through the fresh read. That rule stands; it just leaves the window unmarked.

## Decision

**The Plane action's claim takes a run mark, and the mark holds until the run
settles.** The dispatch module holds the set of Tickets whose Plane action run is
in flight. The pickup adds the Ticket at the moment its claim removes the Work
queue row, and removes it when the run settles - on the outcome, on a refused
claim, and on a stop, through one `finally`.

**The Plane action's ask reads the mark.** An ask for a Ticket whose run is in
flight is refused before the enqueue, with the reason stated: the first run
stands. The refusal is the same shape as the queue's one-item-per-ticket refusal
(ADR 0049), and the automatic walks treat it the way they treat that refusal -
the walk moves on to its next candidate.

**The mark is a session fact, not a durable row.** It lives in the module that
owns the run, beside the module's other in-memory start facts. A restart clears
it, and ADR 0068's fresh read is what settles a merge a crashed run left: the
source answers the merged pull request, and the run settles `merged` without a
command. A durable pre-run row would undo ADR 0068's decision, and the race this
holds is between two asks in one process, which a session fact already covers.

**The mark is keyed by the ask's Ticket, the same key the queue's one-item rule
uses.** The merge aims at that Ticket's pull request, and the position a merge
route names is the pull request's own Ticket, so the two keys coincide on every
path the plane reaches today.

## Considered options

- **Re-read the pull request after a failed merge, and settle `Merge already in
  progress` as merged.** Rejected as a symptom patch: it hides the wrong attempt
  row and the wrong comment, and leaves two `gh pr merge` commands against one
  pull request. The duplicate ask is the fault; the source's answer is only
  where it shows.
- **Hold the Work queue row through the run instead of removing it at the claim.**
  Rejected: the row is the claim, and ADR 0049's pickup takes rows in order and
  drops them as they start. A row that stands through its run reads to the
  operator as a start still waiting, and `force-dispatch` and removal would then
  reach a run already in flight.
- **Have the continuation walk skip a route whose decision word already landed.**
  Rejected: the decision lands at the ask (ADR 0064), so this is indistinguishable
  from a genuinely dropped row, and ADR 0100's owed continuation exists precisely
  to bring a dropped row back.
- **Durable pre-run attempt row at stage `claimed`, the way the Handoff channel
  marks its start.** Rejected for ADR 0068's reason kept: the attempt row is the
  record of the run, not the claim of it, and a pre-run row makes the Handoff
  limit and the Attempt hold read a run that has no outcome yet. The Handoff
  channel can afford its claim row because its claim also moves the Ticket to
  `running`; the Plane action holds no work cycle and moves no Ticket state.
- **Serialize every merge command per repository.** Rejected: it holds unrelated
  Tickets behind one another for a brake the per-Ticket mark already gives.

## Consequences

The glossary carries the run's hold beside the Plane action's start.

The ask's refusal reaches the automatic walks' warning line, the way the queue's
one-item refusal does today: at most one line per run, because the mark stands
only for the seconds the command runs.

The second `gh pr merge` command never leaves the plane, so the pull request
carries no block comment over a merge that landed, no blocked attempt row, and no
Attempt hold set by a merge that succeeded. The 8 blocked attempts the
development install carries are the shape this removes.

The fresh read stays where ADR 0068 put it, and keeps its job: it settles the
crash-restart case, and the case of a merge an outside hand landed. It is not the
guard against a double ask, and the record says so.
