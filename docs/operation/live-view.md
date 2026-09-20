---
title: Live view
description: Watch an agent that is running, and the decision the same screen carries when the turn settles.
---

# Live view

![The Live view on an in-flight ticket: the agent's terminal output in the
left box and its context above](images/live-view.png)

Enter on an in-flight ticket opens the Live view: a near-fullscreen screen
that pops in over the app with the same fade and grow as the decision
modal, one cell of margin on every side. Its border reads
`Live: <ticket title>` in every state the screen carries, and the first row
under the border names the context: repository, task type, agent, and
`blocked` when the ticket wears the blocked marker.

The body is the agent's terminal output as plain text. The screen reads the
ticket's agent pane on a one-second cadence and keeps the newest
`completion-message-lines` of it. New output pins the stream to the bottom;
a scroll releases the pin, and reaching the bottom by scrolling pins it
again. A failed read keeps the last good lines under a dim stale note. A
ticket without a recorded pane shows a note in place of the stream and
reads nothing.

The action row under the stream is the Goto, and it is pure focus: it
focuses the agent's pane and closes the screen. It changes no state and
records no decision. The screen follows the ticket: when the turn settles
and the factory leaves the decision to the operator, the same box turns
into the decision, with the turn log and the choice rows; when the agent
leaves herdr, it carries the missing modal; when the ticket leaves the
in-flight and awaiting states, the screen closes. A settled turn the
factory decides for itself never hands the screen over: the stream stands
where the operator left it.

| Key             | What it does                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `j` / `k`       | Scroll the stream, one row down or up                                                          |
| `PgUp` / `PgDn` | Scroll the stream by a page                                                                    |
| `Home` / `End`  | Jump to the top or the bottom of the stream                                                    |
| `Up` / `Down`   | Move between the choice rows, in the decision sub-mode                                         |
| `Enter`         | Focus the agent's pane and close the screen; choose the selected row, in the decision sub-mode |
| `e`             | Edit the selected Handoff row's settings before it starts, in the decision sub-mode            |
| `Esc`           | Close the screen: nothing runs, the ticket stays where it is                                   |

## The turn log

![The same Live view after the turn settles: the turn log above the
decision rows](images/turn-log.png)

When the turn settles and the factory leaves the decision to the operator,
the stream in the left box is replaced by the turn log of the settled turn,
in the same dressing the
[decision modal](modals.md) renders: the agent's text blocks, the tool calls
as dim notes, and the choice rows under them. The choice rows and their keys
are the modal's: Close, Goto, and the Handoff row of the position the settled
with `e` on a Handoff row editing that one handoff before it starts. The
trace rules are the modal's rules, and the
[completion guide](../work-flow/completion.md) records what a decision does
to the ticket after.
