# ADR 0009: Handoff settings resolve on their own chains

Status: accepted
Date: 2026-09-02

## Context

A task type now carries a task profile (agent type, model, thinking level),
and the config file carries a top-level default model. The agent of one
handoff can therefore be named by four places: the operator's override, a
workflow edge's pin, the arriving task profile, and `default-agent`. Model
and thinking have their own source lists. Model names are not portable
across agent kinds, so a profile's model can be meaningless to an agent
another place chose.

## Decision

Each setting resolves on its own chain, and the closer a decision is to the
handoff in front of the operator, the more weight it gets:

- Agent: operator override, workflow edge pin, task profile, `default-agent`.
- Model: operator override, task profile, `default-model`, the agent's own default.
- Thinking: operator override, task profile, the agent's own default.

Every resolved value is a start value: the override panel prefills it, the
operator changes it or clears it, and a cleared setting is left to the
agent. When the resolved model does not fit the resolved agent, the handoff
fails with a readable reason and the ticket stays open.

The considered alternatives:

- The task profile's agent beats the edge pin. Rejected: the edge pin is
  specific to one transition, the profile applies to every handoff of the
  work kind, and the more specific decision should win.
- The profile falls as a unit: when another place replaces its agent, its
  model and thinking are dropped and the runner's own defaults apply.
  Rejected: it absorbs a config error silently. This factory prefers loud,
  readable failure over silent approximation.

## Consequences

- A model written for the profile's own agent can fail a handoff an edge
  routed to another agent. That failure is how the config error is seen.
- Workflow edges deliberately cannot pin model or thinking. The arriving
  task profile owns both, so no precedence rule is needed for them.
- A profile's thinking is checked against its own agent's `thinking-values`
  at startup. A later edge reroute to another agent is checked only at
  handoff time, by the agent itself.
