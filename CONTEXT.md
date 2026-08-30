# Control Plane

The terminal application that observes the software factory and issues work.
It monitors tickets and hands them off to agents.

## Language

**Factory**:
The whole software development lifecycle, from ticket to shipped work.
_Avoid_: SDLC, pipeline

**Control plane**:
This TUI.
It observes the factory and issues work to agents.
_Avoid_: dashboard, UI

**Ticket**:
A unit of work sourced from GitHub, carrying the repository it belongs to.
_Avoid_: issue, task

**Ticket state**:
The position of a ticket in the factory: `open`, `handed-off`, `running`, `done`.
GitHub's own open/closed status is a separate source fact, not a ticket state.
_Avoid_: status, phase

**Agent**:
An autonomous program that executes a ticket.
The control plane is agent-agnostic and assumes no specific agent runtime (pi, codex, claude code, or others).
_Avoid_: bot, worker

**Agent type**:
The declarative description of a class of agents: its name, how to start it, and how its settings (model, thinking level) map to the agent's own parameters.
An agent is a running instance of an agent type.
_Avoid_: agent definition, plugin, driver

**Handoff**:
Assigning a ticket to an agent type and an environment with a task type, and starting the agent's execution.
_Avoid_: assign, dispatch, launch

**Task type**:
A one-word category of work (for example "implement", "fix", "review") that selects the prompt template of a handoff.
_Avoid_: prompt, template

**Environment**:
The place where an agent runs a ticket.
Kinds: a live worktree (the existing checkout of the ticket's repository), a worktree (a fresh git worktree created for the ticket), and a container (a future kind, not yet built).
_Avoid_: sandbox, isolation

**Override**:
A one-shot change to the settings of a single handoff, made in the override panel before the handoff starts.
It applies to that handoff only and never becomes a new default.
The settings are: agent type, environment kind, task type, model, and thinking level.
_Avoid_: custom setting, tweak
