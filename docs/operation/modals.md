---
title: Modals
description: The decision modal and the missing modal, and the leftover environment fact.
---

# Modals

## Decision modal

![The decision modal on an awaiting ticket: the turn log of the settled
turn above the choice rows](images/decision-modal.png)

Enter on an `awaiting` ticket opens the decision modal: a near-fullscreen
modal that pops in over the app with a short fade and grow, one cell of
margin on every side. In auto mode, and on an auto-close task type, the
factory decides the ticket itself: Enter only reports that, and the modal
stays closed. Its border reads `Decision: <ticket title>`, and the
first row under the border names the context: repository, task type,
agent, completion time.

The body is the turn log of the settled turn, in order. The agent's text
blocks carry light markdown dressing: headings render bright without their
hashes, bold renders bright, code renders dim, lists keep their markers
and indent per level, links keep their label. Each tool call is one dim
note, `▸ name: target`; a failed call wears the warning color. The agent's
thinking text is not shown. The log comes from the agent's session record
(ADR 0008); when no session is known, the terminal capture stands in. The
modal opens at the bottom, where the agent's conclusion is, and a
proportional scrollbar shows the position when the log is longer than the
window.

The modal offers the choices the state allows. `Up` and `Down` move between
the choice rows; `j` and `k` scroll the turn log one row, with the page and
jump keys as aliases. `Enter` chooses the selected row, `e` edits the
selected Handoff row's settings before it starts, and `Esc` closes the
modal: nothing runs, and the ticket stays awaiting. The shared Action bar at
the terminal bottom names these controls.
The first row, "Close", ends the work cycle: the ticket returns to open
with its cycle number incremented, and the handoff's environment is closed
without touching the git branch, so pushed work and pull requests survive:
a worktree handoff loses its worktree checkout and its herdr workspace,
a live worktree handoff loses its tab.
The second row, "Goto", focuses the agent's pane so the operator can steer
it; the ticket stays where it is, `awaiting` until the poll moves it or the
operator decides. The confirmation on the Message line names the workspace
the pane lives in, since herdr 0.9 keeps each client's own view and a CLI
focus no longer moves the operator's view (the Live view page carries the
full note). Goto is navigation, not a completion decision, so the trace
does not record it: the turn's pending trace stays pending, and the next
settle refreshes it with the agent's new last message.
Then one "Handoff: `<task type>`" row per outgoing workflow edge the
completed task type has, in config order: an edge naming several targets
offers one row per target, and two edges to the same target keep both
rows, so every edge stays reachable. The row's detail shows the Agent the
arriving handoff resolves to (the edge's pin, else the target Task profile's
agent, else `default-agent`), and the edge's pinned environment when the edge
defines one. Choosing a row hands the ticket off again with that target task
type. `e` on such a row opens the override panel on the choice the edge
resolved, so the operator can change the agent, environment, Model, or
Thinking for this one handoff before it starts; the override outranks the
edge pin, the Task profile, and the defaults. Moving that panel to another
Task type re-derives the rows the operator never touched from the type's own
profile, so the route's Agent pin goes with the target the edge named.
`Esc` there closes the panel
back to the decision: nothing is claimed and nothing runs. Enter on an
awaiting ticket keeps the direct route, so a route the operator wants
unchanged stays one press. The row's "handed-off" decision lands on the turn's
trace only when the routed handoff settles with the agent started; a
failed route leaves the trace pending, so Close and Goto keep working
on the awaiting ticket. The automatic route decides the same way: its
`auto-handed-off` record waits for the same start.

## Missing modal

Enter on a ticket whose agent is missing opens the missing modal. It shows
the badge fact and the handoff count, and it offers "Restart" and
"Abandon". `Up` and `Down` move between the choice rows, `j` and `k` scroll
its message, `Enter` chooses the selected row, and `Esc` closes the modal:
nothing runs, and the badge stays. The shared Action bar at the terminal
bottom names these controls. "Restart" hands the ticket off again with the
same choices, in the
workspace the handoff recorded, and the last completion's message as the
previous message. "Abandon" ends the work cycle: the ticket returns to open
with its cycle number incremented, the handoff's environment is closed,
and the missing badge clears.

## Leftover environment

The control plane offers no clear for a leftover environment (ADR 0032):
key `w` on a ticket wearing the `leftover` marker changes nothing and opens
no panel. The leftover stays a durable, visible fact - the `leftover`
marker in the row, and the detail block that names the workspace, tab, and
pane that remain, the reason the control plane knows, and since when. The
block states that the cleanup runs in herdr, not in the control plane, the
way the Consultation detail does for its remaining resources, so the operator
knows where the environment still lives and goes there to remove it.

Every close still runs the Close cleanup: a removal that herdr refuses
records the leftover with its reason, and the close stands. A handoff beside
its ticket's leftover still starts under the cycle name (ADR 0012): the
leftover's agent holding the stable name is the case the fact makes visible,
not a failure of the start.
