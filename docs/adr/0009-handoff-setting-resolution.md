# ADR 0009: Handoff settings resolve on their own chains

Status: accepted, with one part superseded by ADR 0010
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
that is not a digit never reaches the value, typed or pasted, and a draft
that is digits but no count, `0` among them, is refused by the handoff rule
below: one rule covers the typed path and the file path. One count also keeps
one spelling: both paths fold a leading zero, so `007` and `7` are the same
room and reach the agent as `7`.

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

- A route's decision belongs to the Handoff that starts it, not to the claim
  that reserved it. The app runs a claimed Handoff and reports its start to
  whoever asked for the route: the operator's decision records `handed-off`,
  the loop's records `auto-handed-off`, and a Handoff that never started
  records neither. The settled turn therefore keeps its pending trace when a
  route fails, and the operator's Close and Goto, the loop's reopen, and the
  next attempt all still work on it.
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
- A model can name an agent that the handoff never lands on, and an agent can
  be reached only through a reroute or an override, so the handoff-time rule
  above is what catches a model those two cannot see: an edge reroute, an
  operator override, and `default-model` all name no agent of their own. A
  profile's own `model` and a Consultation type's `model` do name their agent,
  so ADR 0010 supersedes this record there and checks those two at startup
  against the agent's own Model list, while the handoff keeps checking them
  too. What this record decides and ADR 0010 keeps is the loud rule itself: a
  setting its agent cannot take fails the handoff with a readable reason
  instead of being absorbed.
- Because a resolved value the resolved agent cannot take fails the handoff,
  the override panel keeps such a value on screen in the warning color, and its
  guide names the way out: the key that clears the row, or the arrows that
  cycle a list row onto a value its agent offers. A row hidden behind an agent
  that maps no model would strand the value where no key can clear it, and a
  row that hid a value it still sends would tell the operator something false
  about the handoff they are confirming.
- Known limitation: a Consultation dispatch does not carry the handoff-time
  rule. A setting its resolved agent cannot map is still dropped there, so a
  Consultation can start without the model, level, or count its type names.
  Its own ticket retires that drop.
- Known limitation: in auto-handoff mode a profile setting its Agent cannot
  take fails every pass, and each pass records a failed handoff attempt: the
  loop retries the route on every poll, with no backoff and no limit, because
  the per-ticket handoff limit counts started handoffs only. What the retry
  does not do is decide the turn: the route's decision waits for its Handoff
  to start, so the settled turn keeps its pending trace, Close, Goto, and a
  reopened turn all keep working on the awaiting ticket, and the record never
  claims a route the factory did not start. Holding a ticket whose failure
  reason repeats is a rule this record does not set: the loud failure is the
  report, and the fix is the config or the panel.
- Known limitation: a Model is free text, and the panel cannot yet list what
  an agent offers (ADR 0010), so a value that carries a space reaches the agent
  as two arguments. The Context row was made digits-only to keep one count in
  one argument; the shape rule for a model belongs beside it once the Model
  list lands.
- Known limitation: a Restart repeats the handoff it interrupted, and the
  missing modal offers no way to edit that choice. A stored Model, thinking
  level, or count its Agent no longer takes therefore leaves that cycle by
  Abandon alone, which ends the work cycle. The loud failure is the report;
  editing a restart the way a route is edited is a later ticket's rule.
- Known limitation: the panel still takes a Thinking level as free text when
  its agent maps a template but lists no values, because the shared level set
  is ADR 0010's to ship. A row can therefore hold a level its agent will
  refuse; the handoff-time rule above is what makes that value loud, and the
  row shows it in the warning color until the operator clears it.
