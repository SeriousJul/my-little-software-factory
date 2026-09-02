# ADR 0009: Handoff settings resolve on their own chains

Status: accepted
Date: 2026-09-02

## Context

A task type now carries a task profile (agent type, model, thinking level,
and context window), and the config file carries a top-level default model.
The agent of one handoff can therefore be named by four places: the
operator's override, a workflow edge's pin, the arriving task profile, and
`default-agent`. Model, thinking, and context window have their own source
lists. Model names are not portable across agent kinds, and neither is a
count of context tokens, so a profile's value can be meaningless to an agent
another place chose.

## Decision

Each setting resolves on its own chain, and the closer a decision is to the
handoff in front of the operator, the more weight it gets:

- Agent: operator override, workflow edge pin, task profile, `default-agent`.
- Model: operator override, task profile, `default-model`, the agent's own default.
- Thinking: operator override, task profile, the agent's own default.
- Context window: operator override, task profile, the agent's own default.

There is no top-level default context window. One count cannot fit every
model, so a profile that names none leaves the room to the agent rather than
guessing a number that may be larger than the model's window or smaller
than the work needs.

Every resolved value is a start value: the override panel prefills it, the
operator changes it or clears it, and a cleared setting is left to the
agent. A context window is a whole count of tokens written in plain digits,
because the value becomes one argv element: a model cannot parse `272 000`,
`272k`, or `0x42000`. The panel takes a count the same way, so a character
that is not a digit never enters the field, typed or pasted, and a draft that
is digits but no count, `0` among them, is refused by the handoff rule below:
one rule covers the typed path and the file path.

The panel edits an operator override on any handoff, including one a
workflow edge resolved: the operator edits the route's settings before it
starts, and their choice is the last writer on it. A handoff fails with a
readable reason before anything starts, and its ticket stays where it was,
when the resolved agent maps no template for a resolved Model, Thinking
level, or context window; when the agent lists the thinking levels it offers
and the resolved level is not one of them; or when a resolved context window
is not a whole count of tokens. The panel shows each of those values on its
row, in the warning color, because the panel never shows something other than
what the handoff sends.

The considered alternatives:

- The task profile's agent beats the edge pin. Rejected: the edge pin is
  specific to one transition, the profile applies to every handoff of the
  work kind, and the more specific decision should win.
- The profile falls as a unit: when another place replaces its agent, its
  model, thinking, and context window are dropped and the runner's own
  defaults apply. Rejected: it absorbs a config error silently. This factory
  prefers loud, readable failure over silent approximation.
- A default context window beside `default-model`, at the config top level.
  Rejected: the count belongs to a model, and the config cannot know which
  model an agent starts on. The agent's own default is the only safe one.

## Consequences

- A model, a thinking level, or a count written for the profile's own agent
  can fail a handoff an edge routed to another agent, and a restart repeats
  the settings of the handoff it restarts, so it can fail the same way. That
  failure is how the config error is seen.
- Workflow edges deliberately cannot pin model, thinking, or context window.
  The arriving task profile owns all three, so no precedence rule is needed
  for them.
- A profile's thinking is checked against its own agent's `thinking-values`
  at startup, and a profile's or Consultation type's context window is
  checked against its own agent's `context-window` template. A later edge
  reroute to another agent is checked only at handoff time, by the same rule
  that fails the handoff, and that rule reads the agent's `thinking-values`
  too: a level the new agent does not offer fails there.
- A profile's `model`, and `default-model`, are free text with no startup
  check, so a model an agent cannot map is caught at handoff time only. A
  startup check would be wrong: an edge can reroute the handoff onto an agent
  that does map a model, and the config cannot know which agent a given
  handoff lands on.
- Because a resolved value the resolved agent cannot take fails the handoff,
  the override panel keeps such a value on screen in the warning color. A row
  hidden behind an agent that maps no model would strand the value where no
  key can clear it, and a row that hid a value it still sends would tell the
  operator something false about the handoff they are confirming.
