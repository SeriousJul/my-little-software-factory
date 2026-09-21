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

## Amendment: a close of a decided turn ends the cycle with the decision standing

Date: 2026-09-21

A transition route records its decision on the settled turn when the routed
handoff starts. The operator's instance routed an issue to its fixing pull
request, and the issue then rested in `awaiting` wearing its `handed-off`
decision. The close refused the turn: the decision write runs only on a
pending trace, and a decided trace is not pending. The routed ticket's work
cycle could never end, and its environment - the worktree, the workspace,
the idle agent that still held the ticket's herdr name - could never be
cleaned up.

The decision above is amended for that case: **a close on a turn that already
decided ends the cycle without rewriting the decision.** The recorded
decision stands - a fact is not rewritten - and the ticket returns to `open`
with the cycle incremented, exactly as the closed decision leaves it. The
move runs only from `awaiting`, so a repeated close changes nothing, and the
cycle number still moves exactly once per end. The automatic close degrades
the same way: a route that meets the handoff limit after its decision stands
still ends the cycle. The automatic rule likewise decides a decided turn
nothing more: the routed turn rests for the operator's close, and the poll
routes no second time on the turn the route already decided.
