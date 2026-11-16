# ADR 0163: A kept terminal's status keeps moving in the plane

Status: accepted
Date: 2026-11-16
Amends ADR 0141's loss read for the kept terminal: a kept terminal whose
program is lost reads Missing beside the shell or the wait the host stands in
it. Amends ADR 0142's list bound: an awaiting ticket's terminal stays in the
bound, so a recovered Agent is the revival the cycle sees.

## Context

The plane's herdr-core start runs without keep (ADR 0141): a lost program ends
the terminal as a finished record, and the Missing flow stands for it. Nothing
the plane writes turns keep on, but a terminal is host state after the start:
the operator, or the host's own recovery, can keep it under the plane.

The measurement of 2026-11-16 on this machine found both gaps. A Ticket
handoff the plane had started stood in a kept terminal (`keep: true` in the
host's record), and the Consultation beside it stood in a second kept
terminal. The Ticket's turn had settled held - cause aborted, no decision -
and its settled facts, the turn log, the last message, and the completion
trace, stood frozen at the settle time. The Agent recovered beside them: it
went back to work and ended a second turn, and the control plane still showed
the Ticket `held` on its first turn's facts. No later cycle could move it,
because no later cycle read the terminal. The status of the held session
never updated in the control plane.

The first gap stands in the list's bound. The merged list's per-Agent read
runs over the terminal names of the in-flight Tickets and the active
Consultations (ADR 0142). A Ticket whose turn settles moves to `awaiting` and
leaves the bound, so the cycle reads no record of the terminal its Agent
stands under. The cycle already owns the revival: an `awaiting` Ticket whose
Agent reports working reopens its turn to `running`, and the turn's next
settle refreshes the same completion trace. The bound, not the revival, was
the gap.

The second gap stands in the record read. A kept terminal whose program is
lost carries the host's loss reason - `signaled`, `holder_lost`,
`stopped_by_restart`, `server_stop`, or `host_shutdown` - beside either no
process id, the wait for the replacement shell the host will spawn, or the
shell itself, which reports no status. The reader mapped every live record to
a present Agent, so the loss read as present and `unknown`, the Missing flow
never ran, and the status never moved. On the plane's own `--no-keep` start a
lost program is a finished record, so the gap shows only on a terminal
someone kept.

## Decision

**The list's bound keeps an awaiting Ticket's terminal.** The ticket states
the merged list reads are the seat states and `awaiting`: `TICKET_LIST_STATES`
beside `TICKET_SEAT_STATES` in the parallel module. The Consultation side of
the bound stands unchanged, with `awaiting-response` and `closing` already in
it. The bound costs one record read per terminal it keeps, and it stays
bounded by the plane's own records.

**The reader reads a kept terminal whose program is lost as a dropped row -
the Agent is Missing - when the live record carries a loss reason and either
no process id or a program that has reported no status.** A program the
operator restarts in the terminal reports a status and stands present on it:
the session's recovery, and the plane re-attaches to the record it reads. A
host that writes no process id and no reported fact for a live record settles
no loss, and the terminal reads as present.

The loss reasons are the host's kept-terminal loss vocabulary: `signaled` (a
program that died to a signal without an exit code), `holder_lost`,
`stopped_by_restart`, `server_stop`, and `host_shutdown`. A terminal that
exits with a code is a finished record the read already maps to a settled
turn, and it stays out of the loss set. A `spawn_pending` terminal is the
start's wait, and it stays present.

## Consequences

- A held turn whose Agent recovers moves on the next cycle: the Ticket
  reopens to `running`, the Agent's next settle refreshes the same completion
  trace, and the plane shows the new last message, not the settle's frozen
  capture.
- A kept terminal whose program dies reads Missing like a lost Agent on any
  host: auto mode restarts it once per episode, and manual mode stands the
  Missing marker and the operator's recovery.
- The plane's `--no-keep` start stands unchanged (ADR 0141). This decision is
  what the plane owes a terminal that someone kept: keep is host state, and
  the plane reads the held session instead of hiding it.
- A Consultation in `missing` is not re-observed: its observe list stands
  unchanged, a missing Consultation still takes the operator's explicit
  recovery, and that gap stands beside this decision, not inside it.
- The suite stands both rules beside the Stub herdr world: the reader's
  mapping of the loss record and of the recovery report, the cycle's revival
  of the awaiting turn, and the auto-mode restart of a lost kept terminal
  (`test/observation.test.ts`). The operator's own report of 2026-11-16 is
  the real-host evidence for the bound gap, and the kept-terminal walk on the
  live host stands as the open item in the verification record.
