# ADR 0006: The control plane polls herdr for agent state

Status: accepted
Date: 2026-08-31

## Context

The control plane must observe each handed-off agent's lifecycle (working,
settled, blocked, missing) without blocking its TUI. herdr offers a
blocking `agent wait` command per agent and a one-shot `agent list` of all
agents. The same observation also feeds the parallel limit count.

## Decision

A single timer polls `herdr agent list` on a configurable interval, 5
seconds by default. The handoff record stores the pane id (plus tab and
workspace id) when the handoff starts, and every later read, focus, and
cleanup targets that pane id.

The considered alternative:

- One `herdr agent wait` child process per in-flight ticket. Rejected:
  one process per ticket, a second egress pattern beside the command
  runner, and no single view from which the parallel limit can count.
  One list call carries every agent, so state transitions and the limit
  share one observation.

## Consequences

- A state change lags the real event by up to one interval.
- The pane id must be captured at handoff time: herdr's list result does
  not expose the agent name, so the name alone is not a reliable handle.
- The fake runner tests pin the poll command sequence like every other
  herdr exchange.
