# ADR 0111: The Queue pause's key and display are plane-wide, and the Dispatch pause's word is held

Status: accepted
Date: 2026-10-06

Extends ADR 0052 (the Queue pause is factory state) and ADR 0036 (the
Auto-handoff mode is factory state). Amends ADR 0052's key reach and display
placement and ADR 0016's display of the `paused` word.

## Context

The Queue pause is the operator's own brake on the factory's starts
(ADR 0052). Today its key and its display sit in the Work section: the `p` key
resolves only in the Work queue's base panes, the other sections refuse it, and
the pause's display is the `paused` word on the Work section's header. To see
the brake or lift it, the operator has to be in the Work section.

The operator judges the pause not a queue detail but core to the control
plane: pausing the queue is how they stop the factory's starts, and the
Decision modal and the Live view are exactly the surfaces where that decision
is made. From those surfaces the brake's state is not visible: the
near-fullscreen surfaces replace the Main view, and the Ticket section's header
row does not draw there.

Two collisions stand in the corner the operator picked, the Ticket header's
right corner:

- The corner already paints the word `paused` for the Dispatch pause
  (ADR 0016, ADR 0052). A second `paused` for the Queue pause would state two
  different facts under one word on one row.
- The corner's colors already carry two other facts: the auto lamp wears the
  running state's color for `manual`, and the seat reading wears the error
  color at the cap. A new lamp wanting green for running and red for paused
  would share both colors with them.

## Decision

**The key reaches the whole plane.** `p` toggles the Queue pause in every
Interaction mode except the field modes and the Agent terminal: the modals,
the Live view, the Key guide, and the Message view included. In the field
modes, where the letter types into the row, the F4 alias carries the toggle,
the way F1 and F2 already carry Help and Message. The Agent terminal is the
one surface where neither reaches the plane: the mode owns its keys, and its
guide names the control by absence. The Auto-handoff mode's `a` key widens the
same way with the F5 alias, so the two plane-level mode keys carry one reach
rule.

The catalogue keeps the one record: both controls drop the section ownership
that made the other sections refuse them, they take the `control-plane`
scope, and the Key guide lists them under its Control plane controls group in
every mode. The Action bar names the pause's hint only while the pause stands:
the standing brake earns its width, and the Key guide carries the key the rest
of the time. The mode gets no bar hint: the lamp's word already states the
mode.

**The lamp is the brake's own face.** The Queue pause is the one fact the new
lamp names: the lamp is the key's own face, and the press that flips the brake
flips the lamp. The Ticket header's corner draws it as a lit lamp with the
word `running` in the running state's color, and an unlit lamp with the word
`paused` in the error color. It stands left of the auto lamp, one space of
room between the two cells. The shared modal chrome draws the same lamp in the
box's top border right corner, so every surface the chrome owns carries it:
the Decision modal, the Live view, the Missing modal, the Key guide, the
Message view, and the panels. The word carries the meaning, the color is
secondary, and the no-color presentation keeps the word and drops the color.

At narrow widths the new lamp never gives way, the way the auto lamp already
does not: the ladder gives up the count cells, then the seat reading, then the
Dispatch pause's word, and at the 40-column floor the row keeps the section
name and both lamps.

**The Dispatch pause's word is `held`.** The auto cell's word for the Dispatch
pause changes from `paused` to `held`, the state that names it: a Held turn
set it (ADR 0016). The word `paused` now belongs to the operator's brake
alone. The Work section's header drops its `paused` cell and keeps its depth:
the corner and the chrome border are the Queue pause's only displays, and the
Action bar's hint still names the key at the point of action.

**The semantics do not change.** The pause holds the pickup, the top-up's
adds, and the continuation ask, exactly as ADR 0052 decided, and the
force-dispatch passes it. The running Agents keep running: their turns
settle, their Transitions write, and the auto Completion decisions keep
deciding those turns. The lamp states the brake, not the Agents.

## Consequences

- `p` and `a` leave their sections. The section refusal sentences the
  catalogue carried for them retire, and the catalogue's guard test follows
  them.
- The queue pause's fact joins the plane's standing facts, because a control
  every mode dispatches must read a fact every mode states.
- One row can no longer show two `paused` facts: the Dispatch pause's word
  moves to `held`, and the Work header's cell goes.
- Every surface that draws the shared chrome paints one more standing fact on
  its border. The chrome is the one place to do it, so the border rule stays
  one.
- The plane's own themes must hold the lamp's two colors to the essential
  indicator contrast, and the shared gallery gains the two lamp states beside
  the auto cell.
