# ADR 0077: The blocked plane action holds its automatic re-ask

Status: accepted
Date: 2026-10-01

## Context

The merge of pull request #184 of this repository blocked on a conflict
against main, and the block worked: the comment posted, and the outcome
fire wrote `needs-work` on the pull request and removed `ready-to-ship`
(ADR 0068). The auto top-up then re-asked the merge in a tight loop: twelve
blocked-merge comments on the pull request inside twenty seconds, each one a
full merge attempt, comment, and outcome fire.

The top-up reads the ticket's position from the local projection, and the
projection carries the labels the source last fetched. After a blocked
merge, that read still wears `ready-to-ship`: the position offers the merge
until the next source refresh lands the labels the fire just wrote. None of
the top-up's gates covered the window. The cycle-end re-verify gate reads
the last ended cycle, and a plane action settles no turn and ends no cycle,
so it read the older cycle and answered clear. The Same-type hold (ADR
0026) reads the newest closed cycle's `completed` turn, and the attempt
stands outside every work cycle, so it answered clear. The one-item-per-
ticket queue rule (ADR 0049) passed, because the row leaves the queue at the
claim, before the run. Every empty-queue cycle re-enqueued the merge on the
stale position, and the loop ran as fast as the observation cycle until the
source refresh moved the labels.

## Decision

The ticket's newest plane action attempt that blocked holds the auto
top-up's re-ask of a plane action for that ticket until one of the ticket's
active sources re-reads the ticket after the attempt ran. The hold is the
cycle-end re-verify gate read on the attempt's row: the attempt is the
newest fact that moved the source's labels, and the refresh that carries
the move is the new signal the Same-type hold and the re-verify gate both
wait for. The state reads it in one query: the newest attempt's outcome is
`blocked`, and an active source's last successful read predates the
attempt.

The hold stands in the top-up's plane action ask, the one step all three
walks share: the continuation, the re-fired skip's route, and the open
ticket. It is silent: the re-ask on the refresh is the expected path, not a
refusal to report, and the walk moves on to its next candidate. When the
refresh lands, the position stands on the written labels: a pull request
that took `needs-work` offers the rework task, and the top-up's
continuation hands it off, the way ADR 0068 states the block's path ends.
A blocked attempt whose label write failed keeps its old labels on the
source, and the refresh that still reads `ready-to-ship` releases the hold
and the top-up asks the merge again: a block the source never saw is not a
move to wait out.

The hold gates the automatic adds only. The Decision screen's confirm and
the force-dispatch pass it, the way they pass the Handoff limit and the
Same-type hold: the brake holds the machine, not the operator's explicit
ask.

## Considered options

- Converge the projection's labels locally when the fire writes them, so
  the position moves the moment the command lands. Rejected: the source's
  fetch is the one writer of the ticket's labels, and a second writer that
  copies the command's intent opens a divergence the plane must then
  repair. The plane already reconciles state at once only where the source
  stops returning the fact (the merged pull request's retirement, ADR
  0068), and everywhere else it accepts the refresh lag and gates the
  automatic adds on the re-read.
- A fixed cooldown after a block. Rejected: a timer is not a fact. The
  refresh is the event that moves the position, and waiting for it bounds
  the hold to one refresh interval without a new knob.
- Gate the pickup's claim as well as the top-up's ask. Rejected: the item
  stands for the ask, and the ask that enqueued it is the one the hold
  covers. A refresh that lands between the ask and the pickup leaves the
  position moved, and the run's own fresh read settles a merged pull
  request without a command.

## Consequences

The glossary's Plane action entry carries the hold (ADR 0077). A blocked
merge delays its rework route by at most one refresh interval of the
ticket's sources, the way a low review score does today. The attempt's row
is the gate's read, and it stands for a crash the way the decision's row
does: a restart finds the blocked attempt and keeps the hold until the
source re-reads the ticket.
