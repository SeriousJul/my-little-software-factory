---
title: Modals
description: The decision modal, the Ticket close confirmation, the missing modal, and the leftover environment fact.
---

# Modals

## Decision modal

![The decision modal on an awaiting ticket: the turn log of the settled
turn above the choice rows](images/decision-modal.png)

Enter on an `awaiting` ticket opens the decision modal: a near-fullscreen
modal that pops in over the app with a short fade and grow, one cell of
margin on every side. In auto mode, and on a transition that auto-advances,
the factory decides the ticket itself: Enter only reports that, and the modal
stays closed. Its border reads `Decision: <ticket title>`, and the
first row under the border names the context: repository, task type,
agent, completion time.

The body is the turn log of the settled turn, in its own pane titled
`Turn log`. The log holds the agent's messages in order. The agent's text
blocks carry light markdown dressing: headings render bright without their
hashes, bold renders bright, code renders dim, lists keep their markers
and indent per level, links keep their label. Each tool call is one dim
note, `▸ name: target`; a failed call wears the warning color. The agent's
thinking text is not shown. The log comes from the agent's session record
(ADR 0008); when no session is known, the terminal capture stands in. The
pane opens at the bottom, where the agent's conclusion is, and a
proportional scrollbar shows the position when the log is longer than the
window. A log the trace does not record shows its reason as one dim row in
the pane, and the pane keeps its border and title.

Below the pane, the choice rows stand in their region, pinned to the box's
floor. The region is bounded: it shows as many rows as the box has room
for, and when it holds more rows than that it scrolls, with the range of
the rows it shows riding the Action bar behind the selection's hint. A held
turn stands one warning row between the pane and its rows: the cause the
turn ended on, and the agent's text for it.

The modal offers the choices the state allows. `Up` and `Down` move between
the choice rows; `j` and `k` scroll the body one row, with the page and
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
The settled turn's transition facts stand above those rows (ADR 0027): one
line per surface the fire wrote on, the ticket's reading `ticket · added
ready-for-review · removed ready-for-agent` and the pull request's the same
shape behind its external key; one line for a label write that failed; and
one for a fire whose judgment never held or that found no linked pull
request. The rows decide on those facts, so the turn log yields its rows to
them.
Then one "Handoff: `<task type>`" row when the fire's written labels put a
ticket in a state that offers a task. The row's detail shows the Agent the
arriving handoff resolves to (the fired branch's pin, else the target Task
profile's agent, else `default-agent`), and the branch's pinned environment
when it defines one. Choosing a row hands that ticket off - the linked pull
request when the written labels sit there, else the ticket whose turn
settled. `e` on such a row opens the override panel on the choice the
position resolved, so the operator can change the agent, environment, Model,
or Thinking for this one handoff before it starts; the override outranks the
Transition pin, the Task profile, and the defaults. Moving that panel to
another Task type re-derives the rows the operator never touched from that
type's own profile, so the route's Agent pin goes with the position the fire
named.
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

## Ticket close

Key `w` in either Ticket pane ends the work cycle of the selected ticket
(ADR 0031). The same key closes the selected Consultation in the Consultation
section (ADR 0037): a section owns its per-mode keys, so `w` always means the
Close of the section the cursor is in. On an `open` ticket it refuses with its
reason: no work is in flight to close. On an in-flight ticket, and on an
`awaiting` one, it opens the shared confirmation panel first, because every one
of those states has work behind it to stop.

The panel's first line names who is alive: the Agent working, the Agent that
has started but is not seen yet, the pane herdr no longer lists, the Agent
waiting for input, or the turn that settled with nothing working. The rest
states what survives, read off the environment that ticket's own handoff runs
in: a worktree close removes the checkout and the herdr workspace behind it,
and a checkout herdr refuses to remove stays open as a leftover; a
live-worktree close closes the Agent's tab and keeps the checkout, the
workspace, and the tabs beside them. The git branch stays in every case, so
pushed work and pull requests survive, and the ticket returns to open with its
next cycle number. `Esc`, or the "Cancel" row, leaves the ticket and its work
exactly as they were, and that row states the same fact about the pane the
body's first line states.

The confirmed answer runs one of two closes:

- On an `awaiting` ticket, the "Close" row records the `closed` decision on
  the settled turn's trace and runs the Close cleanup: the same action the
  Decision modal's Close row offers, one key deep. The modal keeps its row,
  because it is the close with the turn log beside it.
- On an in-flight ticket, the cycle ends with no completion trace at all.
  The turn never settled, so there is no cause, no turn log, and no message
  to record, and the handoff row stays the record of the work. The ticket
  returns to open with its cycle incremented, the Agent stops through the
  same Close cleanup, and the ended cycle counts toward the Handoff limit
  like any other. Because no row ends that cycle, the re-verify gate and the
  Same-type hold read it as holding nothing, the way they read an abandon
  without a cause: no finished turn is asserted, so nothing waits and
  nothing repeats.

A close that meets a Handoff still building its agent does not refuse and
does not race it: the whole close takes the shared environment seat, and runs
when that Handoff settles, so a hung start still ends in the close the
operator asked for and no cleanup tears down an environment herdr is mid-way
through building.

## Leftover environment

The control plane offers no clear for a leftover environment (ADR 0032). The
leftover stays a durable, visible fact - the `leftover`
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
