---
title: Main view
description: The Main view's two sections, its counts, its controls, and the layout the terminal shows.
---

# Main view

![The Main view: the Ticket and Consultation sections on the left, the
detail of the selected ticket on the right](images/main-view.png)

The Main view holds two list sections on the left, the Ticket section on
top and the Consultation section below, and one context-dependent detail
pane on the right that shows the detail of the item the cursor holds. One
control catalogue, one Action bar, and one Message line answer for both.
Both sections start expanded; `x` or a click on a section header collapses
the section under the cursor to its header row, and the same toggle restores
it. Up and down move the cursor through the visible rows and cross the
section boundary when the sections are adjacent. The mode the bar and the
guide state derives from the section that holds the cursor and its focused
pane.

The Ticket header always shows the pipeline counts - open, running, and
awaiting - with the held count appended only when it is non-zero. The
Consultation header carries its attention facts (awaiting response,
recovery). Both counts are computed from the in-memory projection on each
render; neither queries the state.

The control plane keeps a contextual Action bar in the last row of the
terminal. It shows the controls the current interaction mode can run, dims
one it will not run in the present state, and names the reason on the Message
line when the operator presses it anyway.

The in-app Key guide lists the controls of the modes the app dispatches from
its catalogue. Press `?` or `F1` to open it from anywhere, including the
panes and the modals. It carries the Ticket list, the Ticket detail, the
Consultation list, the Consultation detail, the Agent terminal, the response
editor, the override panel in both of its row kinds, the decision modal, the
missing modal, the guide and the Message view, the controls that are only
reachable from another mode, Quit, and the `Ctrl+C` emergency exit, each with
what it does and, where the app will not run it, why. Press `Esc`, `F1`, or
`?` to close it.

This guide does not repeat that list. A table of keys here went stale twice:
the guide and the Action bar are generated from one control catalogue
(`src/components/controls.ts`), so what the app shows is what the app runs.

The Ticket list and detail move with the row, page and jump keys, focus the
detail with `l` or `Right` and the list with `h` or `Left`, hand an open
ticket off with `Enter`, open the decision modal on an awaiting one, the
missing modal on a ticket whose agent is gone, and the override panel with
`e`. `=`, `+`, and `-` bump a ticket's priority up and down through the
configured rank, and Backspace clears it to the label rank or unranked. `a` toggles
auto-handoff, `r` refreshes, `g` goes to the agent's pane, and `q` quits.

When the Message line is truncated, press `m` in a base pane or `F2` in any
mode to read the captured message in the Message view. The Message line and
the Action bar reserve the two bottom rows at every terminal size, and each
list section reserves its header row plus a minimum of three content rows:
below the smallest useful frame (40 columns by 19 rows) the panes give way
to a size message and a compact Help control, a section that cannot hold its
minimum collapses rather than vanishing so both headers keep their counts, and
a surface that cannot draw its own rows says so instead of painting them over
its border. One hint holds the row's end cells: Help on a
bar that can open the Key guide, and the overlay's own Close on a utility
overlay. A frame too narrow for that hint states one of its whole keys, so the
way out of a screen is named at any width and never cut in half.

The keys the override panel answers with live on the
[Consultation page](consultation.md), under Entry controls.

## Layout

The Main view is one surface with two list sections, the Ticket section on
top and the Consultation section below, and one context-dependent detail pane
on the right (ADR 0019). Both sections start expanded, and the detail pane
shows the detail of whichever item the cursor holds: the ticket detail on a
ticket, the Consultation detail on a Consultation. `x` or a click on a header
toggles the section under the cursor: it shrinks to its header row and its
rows leave the navigation flow, and the same toggle restores it. A collapsed
section keeps its list selection, and the selection and detail of a collapsed
section survive the collapse, so a re-expand shows the same place. The rows
run: the mode line (while the control plane has state to observe), the
Ticket header across the full terminal width, the two sections' list panes
stacked on the left with the Consultation header between them, the detail
pane on the right, the Message line, and the Action bar. The focused
section takes the remaining rows after the other section claims its minimum
of three content rows, so the list the operator works in gets the room. The
Ticket header always shows the pipeline counts - open, running, and awaiting,
in the labelled form on a terminal of at least 60 columns and the short form
below - and appends the held count with its bell marker only when it is
non-zero. The Consultation header carries that section's attention facts, its
awaiting-response and recovery counts, the bell marker while the bell rings,
and "new output" while that fact holds, so a Consultation that needs
the operator is visible whether the section is expanded or collapsed and no
free-standing attention line exists. A section that cannot hold its minimum collapses rather than
vanishing, so both headers keep their counts; below the smallest useful frame
the compact frame drops the panes with a size message.

Two panes side by side, flex-sized to the terminal.
The list pane on the left shows the tickets of the Ticket section with their
state badge, task type badge, title, and repository. The task type badge is the type the
control plane would hand off: an open ticket shows its suggested task type,
every other ticket shows the task type its recorded handoff started with.
A non-open ticket without a recorded handoff shows `[unknown]`, and only
that badge wears a warning color; every configured task type uses one
neutral style. The detail pane on the right shows the full detail of the
selected ticket: repository, ticket state, the Agent its handoff runs on with
its Environment and that handoff's Model, Thinking level, and context window,
source name, source kind, external key, source state, URL, labels, and source
health. An open ticket shows the settings its suggested task type's Task
profile resolves to, which is what Enter starts, including the Environment it
starts in; a ticket inside a work cycle shows the settings its own handoff
started with. A close returns a ticket to open and keeps that handoff's record
as history, so the rows follow the ticket's state rather than whichever record
survives. A setting left to the agent reads `left to agent` in the dim color.
The detail carries one explicit task type line for every ticket: `Suggested
task type:` for an open ticket, `Handoff task type:` for every other, with
`Handoff task type: unknown` when the handoff data is absent. The detail
also carries
the ticket's handoff count against its per-ticket limit, counting the
handoffs of every work cycle the ticket ran, and, when one exists, the last
completion: its date, the task type, the agent, and the recorded decision.
Factory ticket state and external source state stay separate.
The panes share one focus.
Switching focus never moves the selection.

The vertical keys act on the focused pane.
With the list focused, they move the selection and cross the section boundary
when the sections are adjacent: from the last row of the Ticket list the next
down lands on the Consultation list, and the next up from its first row lands
back on the tickets. Page keys move by one visible
list page, and Home and End select the list edges. With the detail focused,
the row keys move at the configured speed, PageUp and PageDown retain one row
of context, and Home and End move to the detail edges. A new selection starts
the detail at the top.

The detail is a native OpenTUI viewport. Its complete content stays mounted,
so wheel bursts translate one stable surface instead of rebuilding visible
rows. When the content overflows, its right inner column has a proportional
scrollbar. The gutter is always reserved when width permits, so wrapped text
does not reflow as the bar appears. Click or drag the scrollbar, or use the
wheel or trackpad over any part of the detail. Fast vertical wheel events
accelerate to the configured limit. Horizontal and Shift-wheel input is
ignored. A click or wheel action focuses its pane. Clicking a visible row in either
list selects it, a list wheel event selects one adjacent row, and a click on
a section header toggles that section.

Mouse reporting takes the host terminal's native text selection with it, so the
control plane gives it back as Auto copy: drag with the mouse over any surface
and the text highlights, and releasing the drag copies the selection to the
system clipboard. A click that does not drag copies nothing, a copy the terminal
refuses warns on the Message line, and a copy that takes is silent. Auto copy is
always on, over every surface, with no setting. The keyboard Copy control on a
field selection keeps its own path.

When the terminal is too narrow for a field, the field drops out of the row
instead of wrapping it.
The repository drops before the title does, and the task type badge is
complete or absent: the row keeps the whole badge with a readable title,
or the badge drops and the title takes the cells. A partial badge could
read as another task type, so it never truncates; the full value stays in
the detail pane.

Above the Action bar sits the Message line. It carries the progress and the outcome
of the last handoff: `Working: handing off "..."...` while one is in flight,
`Warning:` for a sibling clone or other recoverable issue, and `Error:` for a
failed handoff. A clean handoff clears its Working line, and a warning the
operator drew while it ran - a refused key or clear - then takes the line. While
a handoff is in flight keys keep working, and `e` is refused with a warning. A second handoff claim
records its attempt, which blocks a further claim on the same ticket, and
queues its external work until the in-flight handoff settles; the ticket
moves to `handed-off` only when the handoff settles and its agent starts,
so claims never race each other. A leftover clear holds that same seat,
and so does the Close cleanup of any path that runs one: an environment
change and a handoff never work beside each other.

Above the panes sits a mode line. It shows the auto-handoff state and the
live agents against the parallel limit: `auto: on 1/2`, or `auto: off 1`
when no limit is set. The count is the in-flight tickets whose agent was
alive in the latest herdr poll. The `a` key toggles the mode for the
session from the Ticket section; the config's `auto-handoff` key sets the
startup value only.

A blocked agent replaces the state badge in the list row with a `blocked`
badge: the agent shows an approval or question UI and waits for a human.
The ticket stays in flight, in `handed-off` or `running`, and still counts
against the parallel limit. A missing agent replaces the state badge with a
`missing` badge: the stored pane is gone or holds no agent, so the work
stops there until the operator restarts or abandons the cycle. Both badges
clear when the next poll no longer shows the condition. The first poll has
not landed yet, so no badge appears before it.
A ticket that has used up its per-ticket handoff limit wears a trailing
`handoff limit` marker at the end of the row, and the detail pane shows the
count as `Handoffs: 2/2`. Auto-handoff leaves such a ticket open; a manual
handoff may still pass the limit.
A ticket whose previous herdr environment is still alive wears a trailing
`leftover` marker, and its detail pane names the workspace, tab, and pane that
remain, the reason the control plane knows, and since when. `w` clears it.
