# Control Plane

The terminal application that observes the software factory and issues work.
It monitors tickets and hands them off to agents.

## Language

**Factory**:
The whole software development lifecycle: the pipeline from ticket to shipped work.
_Avoid_: SDLC, pipeline

**Control plane**:
This TUI. It observes the factory and issues work to agents.
_Avoid_: dashboard, UI

**Ticket**:
A unit of work sourced from GitHub, carrying the repository it belongs to.
_Avoid_: issue, task

**Ticket state**:
The position of a ticket in the factory pipeline: `open`, `handed-off`, `running`, `done`.
GitHub's own open/closed status is a separate source fact, not a ticket state.
_Avoid_: status, phase

**Agent**:
An autonomous worker that executes a ticket.
The control plane is agent-agnostic and assumes no specific agent runtime (pi, codex, claude code, or others).
_Avoid_: bot, worker

**Handoff**:
Assigning a ticket to an agent and starting its execution.
_Avoid_: assign, dispatch
