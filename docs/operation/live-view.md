---
title: Live view
description: Watch an agent that is running, and the decision the same screen carries when the turn settles.
---

# Live view

![The Live view on an in-flight ticket: the agent's terminal output in the
Agent view pane and its context above](images/live-view.png)

Enter on an in-flight ticket opens the Live view: a near-fullscreen screen
that pops in over the app with the same fade and grow as the decision
modal, one cell of margin on every side. Its border reads
`Live: <ticket title>` while the agent works. The first row under the
border names the context: repository, task type, agent, and `blocked` when
the ticket wears the blocked marker.

The body is the agent's terminal output as plain text, in its own pane
titled `Agent view`. The screen reads the ticket's agent pane on a
one-second cadence and keeps the newest `completion-message-lines` of it.
New output pins the stream to the bottom; a scroll releases the pin, and
reaching the bottom by scrolling pins it again. A failed read keeps the
last good lines under a dim stale note, the note as the body's last line.
A ticket without a recorded pane shows a note in place of the stream and
reads nothing.

The Action bar follows the mode. While the agent works it offers the
stream's scroll, the leave, and the Goto confirm. `Enter` is the Goto:
pure focus, the same navigation as `g` in the Ticket section. It focuses
the agent's pane and closes the screen. It changes no state and records no
decision. The confirmation stands on the Message line and names the
workspace the pane lives in: the Goto moves herdr's view to the agent's
pane, which is the one focus move the control plane makes and the one the
operator asked for at the key (ADR 0061). Ending an environment is not
such a move: a Close cleanup, a route close, or a Consultation close never
changes what the operator is looking at.

When the turn settles and the factory leaves the decision to the operator,
the same screen carries the decision: the pane re-titles from `Agent view`
to `Turn log`, the choice rows come in at the box's floor, the border
re-titles from `Live:` to `Decision:` in the same place, and the bar's
hints switch to the decision's. The switch is in place: the screen keeps
its box, its scroll, and its pop-in, and no second screen opens over it.
The one screen both paths end at is the one the
[decision modal](modals.md) page describes, because it is the same one.

| Key             | What it does                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ |
| `j` / `k`       | Scroll the body, one row down or up                                                         |
| `PgUp` / `PgDn` | Scroll the body by a page                                                                   |
| `Home` / `End`  | Jump to the top or the bottom of the body                                                   |
| `Up` / `Down`   | Move between the choice rows, once the decision is on screen                                |
| `Enter`         | The Goto: focus the agent's pane and close the screen; choose the selected row, in the decision |
| `e`             | Edit the selected Handoff row's settings before it starts, in the decision                  |
| `Esc`           | Close the screen: nothing runs, the ticket stays where it is                                |

When the agent leaves herdr, the screen carries the
[missing modal](modals.md) in its place. When the ticket leaves the
in-flight and awaiting states, the screen closes. A settled turn the
factory decides for itself never hands the screen over: the border keeps
its `Live:` title, the pane keeps streaming, and the choice rows stay out.

## The turn log

![The same Live view after the turn settles: the border re-titled to
`Decision:`, the Turn log pane, and the choice rows](images/turn-log.png)

When the turn settles and the factory leaves the decision to the operator,
the pane's body is the turn log of the settled turn, in the same dressing
the [decision modal](modals.md) renders: the agent's text blocks, the tool
calls as dim notes, and the choice rows below the pane. The choice rows and
their keys are the modal's: Close, Goto, and the Handoff row of the position
the settled turn's written labels derived, with `e` on a Handoff row editing
that one handoff before it starts. When the choice rows hold more rows than
the box has room for, the region shows as many as it can and scrolls, and
its range rides the Action bar behind the selection's hint. The trace rules
are the modal's rules, and the
[completion guide](../work-flow/completion.md) records what a decision does
to the ticket after.
