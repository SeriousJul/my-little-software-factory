# ADR 0005: A work cycle ends at close

Status: accepted
Date: 2026-08-31

## Context

The work cycle model held a finished ticket in `done` until it left all
sources and later returned. Auto-handoff and workflow routing change the
needs: the operator accepts a settled agent turn, and the ticket must be
usable again at once while its source item is still present and active.
Holding the ticket as `done` would hide it from handoff, and re-arming it
would need a special case for every just-closed ticket.

## Decision

Closing a cycle, by the operator or by auto-close, ends the work cycle,
stores the completion trace, and returns the ticket to `open` at once with
an incremented cycle number. A cycle can hold several handoffs, so a
workflow chain (implement, then review, then merge) is one cycle. `done`
stops being a resting ticket state; it lives only in the work cycle
record. The resting states are `open`, `handed-off`, `running`, and
`awaiting`.

The considered alternatives:

- Hold the ticket as `done` until it leaves all sources and returns, the
  old model. Rejected: a closed ticket would stay invisible to handoff
  while its source item is still active, and auto-handoff would need a
  re-arm rule for every just-closed ticket.
- Keep `done` as a resting state and add a separate re-open action.
  Rejected: two ways to end one cycle, and a state that means both
  "finished" and "waiting to be re-opened".

## Consequences

- The forward note in ADR 0002 ("agent state for the `running` and `done`
  ticket states") lands as `running` and `awaiting` instead.
- Immediate re-availability makes the close-and-rehandoff loop possible,
  so the per-ticket handoff limit bounds auto-handoff.
- Source facts still never reset factory state. Close is a factory action
  and never touches the external source item.
