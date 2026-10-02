---
title: Live view
description: Watch an agent that is running, and the decision the same screen carries when the turn settles.
---

# Live view

![The Live view on an in-flight ticket: the agent's terminal output in the
Agent view pane and its context above](images/live-view.png)

Enter on an in-flight ticket opens the Live view: the agent's terminal output
in full, with the repository, task type, and agent named above it. New output
pins the stream to the bottom; a scroll releases the pin, and reaching the
bottom by scrolling pins it again.

While the agent works, the keys are:

| Key            | What it does                                                |
| -------------- | ----------------------------------------------------------- |
| `j` / `k`      | Scroll the stream one row down or up                        |
| `PgUp` / `PgDn`| Scroll the stream by a page                                 |
| `Home` / `End` | Jump to the top or the bottom of the stream                 |
| `Enter`        | Go to the agent's pane in herdr and close the screen        |
| `Esc`          | Close the screen; nothing runs, the ticket stays where it is|

When the turn settles and the factory leaves the decision to you, the same
screen carries it: the stream becomes the turn log, and the choice rows come
in below - the same rows and keys as the [decision modal](modals.md): Close,
Goto, and the Handoff row the settled turn's labels derived, with `e` editing
that one handoff before it starts.

| Key         | What it does, once the decision is on screen                |
| ----------- | ----------------------------------------------------------- |
| `Up` / `Down`| Move between the choice rows                              |
| `Enter`     | Choose the selected row                                     |
| `e`         | Edit the selected Handoff row's settings before it starts   |
| `Esc`       | Close the screen; nothing runs, the ticket stays awaiting   |

When the agent leaves herdr, the screen carries the
[missing modal](modals.md) in its place. A settled turn the factory decides
for itself never hands the screen over: the pane keeps streaming.

## The turn log

![The same Live view after the turn settles: the border re-titled to
`Decision:`, the Turn log pane, and the choice rows](images/turn-log.png)

The turn log holds the agent's messages in order: its text, its tool calls as
dim notes, and its failures. [The completion guide](../work-flow/completion.md)
records what a decision does to the ticket after.
