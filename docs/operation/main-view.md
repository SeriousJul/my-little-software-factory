---
title: Main view
description: The Main view's three sections, its counts, its controls, and the layout the terminal shows.
---

# Main view

![The Main view: the Ticket and Consultation sections on the left, the
detail of the selected ticket on the right](images/main-view.png)

The Main view holds three list sections on the left, the Ticket section on
top, the Consultation section below it, and the Work section below that,
plus one context-dependent detail pane on the right that shows the detail
of the item the cursor holds. One control catalogue, one Action bar, and
one Message line answer for all of them. The Ticket and Consultation
sections start expanded; `x` or a click on a section header collapses the
section under the cursor to its header row, and the same toggle restores
it. The Work section holds every start the factory makes: the manual starts
that wait for a Parallel limit seat (ADR 0034), the automatic adds the
auto-handoff top-up makes (ADR 0051), and the Consultation starts (issue
#90). Its header carries the depth, and the section is always visible
(ADR 0049): it starts expanded and keeps a minimum of three content rows,
so an idle factory keeps its three-Section frame with an empty queue that
says `no waiting starts`. A queued Handoff start carries the ticket's
title, the start's origin, and its place in the queue; the detail pane
shows the choice the start carried and names whose start the row is -
`Asked by: the operator` for a start the operator staged, `Asked by: the
factory's auto top-up` for one the auto-handoff added (ADR 0051). The
origin word alone cannot tell them apart: the operator's route and the
factory's continuation are both `workflow`. A queued Consultation start carries
the kind word and the record's identity prefix, and the detail pane reads
the record the item names - the ask, the type, the state - with the record
gone saying so in its place. `+` and `-` move the item under the cursor
one place toward the front or the back (ADR 0049): the queue's order is
the order of work, and the ticket list orders by attention (ADR 0050).
`p` pauses or resumes the queue's drain (ADR 0052): the pickup takes no
item and the top-up adds none while the pause stands, and the fact is
factory state, so a restart finds it where the operator left it; the
header carries the `paused` word while the pause stands, and the key's
hint flips between `Pause queue` and `Resume queue`. `Delete` removes the
item - the ticket keeps the state it wore while it waited, and a
Consultation item unschedules the record (issue #91): the record keeps
its ask in `unscheduled` state, listed in the Consultation section - and
Enter force-dispatches the item under the cursor (issue #89, ADR 0034):
it starts now, even when the Parallel limit is full and even when the
queue's pause stands, and it re-runs every start check the queue's
pickup runs except the cap, so the seat count can stand over the limit
until the work settles. A force-dispatch that fails leaves the item out
of the queue with the failure on the Message line, and the ticket keeps
its state. A Consultation item runs the same force-dispatch over the cap
(ADR 0034, issue #90): its record takes its seat in the atomic move to
`opening`, the line names the cap when the seat count stood over it, and
the item leaves the queue on the answer. A Handoff in flight refuses the
key on a Handoff item only: a Consultation start never parks on the herdr
seat a Handoff holds, the way a launcher submit does not. Enter on a
Ticket or Consultation row that waits in the queue jumps to the item's
row (ADR 0049): the cursor lands where the queue's keys act, and the
start the operator is about to make is the one the cursor holds. The
removal cancels the start everywhere the factory holds it: a claim its
pickup already made and the herdr seat parked ends with the row, and it
never starts an Agent the operator removed. The one exception is a start
whose work had already reached herdr: that Agent runs, and the removed
row adds no second line about it. The line the cancel writes states only
what the module measured: a removal when a row stood under the cursor,
and the queue holding no such row when its pickup had already taken it.
Up and down move the cursor through the visible rows and cross the
section boundary when the sections are adjacent. `d` belongs to the
Consultation section alone: in the Ticket section and the Work queue it
states that section's refusal, and neither the guide nor the Action bar
names it (issue #85, ADR 0034). `f` belongs to two lists: it cycles the
Ticket section's List filter, and it is the Consultation section's history
(ADR 0060). In the Work queue the key states that the Ticket section and the
Consultation section own it, and the queue's guide and bar name it nowhere.
The mode the bar and the guide state derives from the section that holds the
cursor and its focused pane.

The Ticket header always shows the pipeline counts - open, running, and
awaiting - then the held count with its bell marker and then the ignored count,
each of the last two only when it is non-zero (ADR 0060). The order is the
machine's: a held turn is a decision the plane waits on and an ignore is a
judgment it does not, so a row too short for both conditional cells spends its
last cells on the pile and never on the held count or its bell. The ignored cell
counts the Tickets the flag names, so the header says the list is filtered before
the operator looks for a row that is not there.
All four counts, and the held-count bell, read the machine's active view rather
than the operator's List filter, so a cycle of `f` moves none of them and rings
nothing. The
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
`e`. `a` toggles
auto-handoff, `r` refreshes, `g` goes to the agent's pane, `w` closes the work
cycle of the selected ticket behind a confirmation (ADR 0031), `i` ignores the
selected ticket or takes it back, and `f` cycles the Ticket section's List
filter (ADR 0060), and `q` quits.
The list rule that takes a row away has two causes in one read, in the state
module alone (ADR 0042, ADR 0060): a covered open ticket - one an open fixing
pull request fixes - and an ignored ticket at rest - one the operator judged out
of the factory's way. The ignore is the operator's act on one ticket, and the
flag is factory state on the state file: the plane writes nothing to the source
for it, and nothing clears the flag but that same key. The ticket keeps its
state, its Parallel limit seat, and its source facts; every automatic start - the
Top-up's continuation, its re-fired skip, its restart, and its open-ticket add -
leaves it out. A start the operator asks for by hand still runs, and the waiting
start an ignore finds in the Work queue leaves with the row. The key refuses a
ticket that owes a decision now - one `awaiting`, one whose newest settled turn is
held, and one whose agent is missing - and states that reason on the Message line.
The ignore then hides a resting row and never a live one: an ignored ticket whose
agent works keeps its row because there is live work to reach, one whose turn
settled keeps its row because a decision is owed, and the row goes back into the
pile when the cycle ends and the ticket rests. The flag stays set under both, so
the row wears `ignored` beside its own state badge while its work runs, and the
`i` line states the row's place from the read the act caused: a resting row is
gone, a live row stays, and a clear that leaves the row to the covered rule says
so instead of promising a row. `f` cycles the list through
the active rows, the pile the flag names, and both, and the filter opens on the
active rows at every boot; without a state file the list rule has no pile to
lift, so `f` states that in the same words `i` states the missing fact in. The
section's counts and the held-count bell read the active view, never the drawn
rows, and every read that resolves a ticket by identity - a Work queue row and
the line that cancels its item, an open panel and the Live view's pane read -
reads the whole projection, so a cycle of `f` moves none of them. The pile is the ledger of the operator's own acts: it
holds every row the flag stands on, so a ticket that is ignored *and* covered -
one whose fixing pull request appeared after the ignore - stands in the pile and
in no other view, and the same key reaches it there. The detail pane names the
ignore, the moment it was set, and the key that clears it.
The ticket list no longer carries a rank: the ticket priority is retired in
favor of the queue's order (ADR 0050), and the detail pane holds no priority
row and the list no key that raises, lowers, or clears a rank. `+` and `-`
are the Work queue's keys for the item under the cursor (ADR 0049), and the
Ticket section names them nowhere.

### Groups and the Grouping axis

`Tab` splits the Ticket section's list into **Groups**: runs of ticket rows that
share one value of one **Grouping axis** - `none`, `repository`, `source`,
`task`, `state`, or `position` - each run under a **Group header** the operator
can collapse (issue #159). One press steps to the next axis in that fixed order,
so `none`, the flat list, is always one press away, and the control answers from
the Ticket list and the Ticket detail alike. The Action bar hint names the axis
in effect, the Message line states it on every change, and the Key guide carries
both the axis control and the fold.

A **Group is a presentation of the list order and never a new sort** (ADR 0059).
The Groups stand by the best Attention band among the tickets they hold, then by
the newest external update in the Group, then by the Group value; the order
inside a Group is the order the flat list holds, band rules and all. A group key
is a fact of the ticket, never a face the row wears: a Queue wait's `queued`
badge groups under `open`, a Starting window's spinner under `handed-off`, and a
held turn under `awaiting`, because the badge is a presentation. The Task axis
reads the row's own badge rule, so `parked` and `unknown` are Groups of their
own; the Position axis reads the Workflow state the machine matched on this read
- derived from the source facts on every read and never stored - and files a
ticket no state matches under `unmatched`.

The header carries its ticket count and, above zero, its held count, with no
axis prefix, and the fold rides on the glyph beside it, never on a color. The
line follows the list pane's rule for its ticket rows: a field is dropped, never
wrapped. Where the pane is too narrow for everything, the Group's value gives up
its tail and then its last cell, and the ticket count gives up before the held
count does, because a wrapped header would cost the window a row and split the
count a fold exists to keep. Member
rows keep every cell they had in the flat list. `x` is resolved by the facts
under the cursor: on a Group header it folds that Group and lands the cursor
there, and anywhere else in the Ticket section - and in any other section - it
keeps the Section toggle. A collapsed Ticket section draws no header, so there
its `x` is the Section toggle and the Ticket controls keep working on the ticket
the detail pane shows. A left click on a header folds the same Group. Every
Ticket control refuses where the cursor stands on a header, in the catalogue's
own words for no selection, and the detail pane keeps the last ticket it showed.

**A fold hides rows and never facts** (ADR 0059). The Section header's counts,
the mode line, the Parallel limit, the Pickup, the Top-up, the handoff gates,
and every Decision route read the same facts with a Group open or shut, and the
Work queue's order stays the order of work. The plane never opens a Group by
itself: a ticket that moves into a folded Group, or a held turn that arrives
behind a fold, changes no fold. There is no collapse-all and no expand-all - the
axis cycle to `none` is the one escape hatch - and a Group with no tickets never
appears, so a repository or a feed that has gone leaves no ghost header.

Each header costs one window row, so a short terminal's list window can hold
nothing but headers; it still reads, because each header carries its counts, and
one press returns the flat list.

The Action bar hint names the axis wherever the list is split; the flat list
states no axis, because it hides no split to name, and the control's row in the
Key guide is there whatever the axis in effect. The Message line is a notice, so
the axis a press chose yields its place on the line to a fact an operation wrote
- which is why the split also stands in the headers themselves and in the hint.

The axis is **factory state on the state file**, stored per section the way the
Auto-handoff mode (ADR 0036) and the queue pause (ADR 0052) are (ADR 0058): a
restart and a dev reload find the split where the operator left it, and a fresh
file starts at `none`. A state file that will not take the write is reported on
the Message line, and the view the operator asked for still stands for the run.
**Collapsed Groups are session facts**: they live in memory for the run, keyed by
the axis and the Group value, so an axis visited twice comes back as it was left
and a restart never brings back a fold that hides a decision the operator owes.
A plane with no state file keeps the axis in memory too, and grouping degrades
to session-only instead of refusing the key.

When the Message line is truncated, press `m` in a base pane or `F2` in any
mode to read the captured message in the Message view. The Message line and
the Action bar reserve the two bottom rows at every terminal size, and each
list section reserves its header row plus a minimum of three content rows:
below the smallest useful frame (40 columns by 27 rows) the panes give way
to a size message and a compact Help control, a section that cannot hold its
minimum collapses rather than vanishing so the section headers keep their
counts, and a surface that cannot draw its own rows says so instead of
painting them over its border. The Work section keeps its header and its
minimum of three content rows at every size, so an idle factory keeps its
three-Section frame even at the smallest terminal. One hint holds the row's
end cells: Help on a
bar that can open the Key guide, and the overlay's own Close on a utility
overlay. A frame too narrow for that hint states one of its whole keys, so the
way out of a screen is named at any width and never cut in half.

The keys the override panel answers with live on the
[Consultation page](consultation.md), under Entry controls.

## Layout

The Main view is one surface with three list sections, the Ticket section
on top, the Consultation section below it, and the Work section below
that, and one context-dependent detail pane on the right (ADR 0019, and
ADR 0034 for the Work section). All three sections start
expanded, and the detail pane shows the detail of whichever item the
cursor holds: the ticket detail on a ticket, the Consultation detail on a
Consultation, and the queued start's captured choice on a Work row. The
Work section is always visible (ADR 0049): it keeps its header row and a
minimum of three content rows, so an idle factory draws its three-Section
frame with an empty queue. `x` or a click on a header
toggles the section under the cursor: it shrinks to its header row and its
rows leave the navigation flow, and the same toggle restores it. A collapsed
section keeps its list selection, and the selection and detail of a collapsed
section survive the collapse, so a re-expand shows the same place. The rows
run: the mode line (while the control plane has state to observe), the
Ticket header across the full terminal width, the three sections' list panes
stacked on the left with each section's own header between its pane and the
next, the detail
pane on the right, the Message line, and the Action bar. The focused
section takes the remaining rows after the other two sections claim their
minimum of three content rows, so the list the operator works in gets the
room. The floor this sets is 27 rows (ADR 0049): the shortest terminal the
control plane draws its three sections at. The
Ticket header always shows the pipeline counts - open, running, and awaiting,
in the labelled form on a terminal 60 columns and wider and the bare form
below - appends the held count with its bell marker and then the ignored count
only when each is non-zero, the held cell first so a short row cuts the view
fact and not the machine's (ADR 0060), and truncates at the row's end so a narrow
terminal never hides the section's own name. The Consultation header carries that section's attention facts, its
awaiting-response and recovery counts, the bell marker while the bell rings,
and "new output" while that fact holds, so a Consultation that needs
the operator is visible whether the section is expanded or collapsed and no
free-standing attention line exists. The Work header carries its queue
depth and the `paused` word while the queue's pause stands (ADR 0052). A
section that cannot hold its minimum collapses rather than
vanishing, so the section headers keep their counts; the Work section is
the exception (ADR 0049): it keeps its header and its minimum of three
content rows at every size, and below the smallest useful frame the
compact frame drops the panes with a size message.

Two panes side by side, flex-sized to the terminal.
The list pane on the left shows the tickets of the Ticket section with their
state badge, task type badge, title, and repository. The task type badge is the type the
control plane would hand off: an open ticket shows its suggested task type,
every other ticket shows the task type its recorded handoff started with.
An open ticket on a parking state shows `[parked]`: the machine matched and
offered no task, so the plane hands off nothing on its own, and a Hand off
keypress starts the default task type (ADR 0027).
A non-open ticket without a recorded handoff shows `[unknown]`, and only
that badge wears a warning color; every configured task type uses one
neutral style. The detail pane on the right shows the full detail of the
selected ticket. The title wears the accent color in bold, and the
repository flows on the same lines in the dim color, wrapping where the width
breaks them. Then the ticket state, and the work's facts beside its source:
the Agent column holds the Agent with its Environment, the Model, Thinking
level, and context window, the task type, and the handoff count, while the
Source column holds the source name, source kind, external key, source state,
the labels, and the source health, standing in two columns where the width
holds both and one above the other where it does not. An open
ticket shows the settings its suggested task type's Task profile resolves to,
which is what Enter starts, including the Environment it starts in; a ticket
inside a work cycle shows the settings its own handoff started with. A close
returns a ticket to open and keeps that handoff's record as history, so the
rows follow the ticket's state rather than whichever record survives. A
setting left to the agent reads `left to agent` in the dim color. The task
type line wears its own accent color, `unknown` the warning color, and the
labels and the GitHub link wear the source's color.
The detail carries one explicit task type line for every ticket: `Suggested
task type:` for an open ticket, `Handoff task type:` for every other, with
`Handoff task type: unknown` when the handoff data is absent. The detail
also carries
the ticket's handoff count against its per-ticket limit, counting the
handoffs of every work cycle the ticket ran, and, when one exists, the last
completion: its date, the task type, the agent, and the recorded decision,
the label in its own color and the message indented in the dim color beneath
it. A blank line closes the static facts and opens the ticket's own
description. Factory ticket state and external source state stay separate.
The panes share one focus.
Switching focus never moves the selection.

The vertical keys act on the focused pane.
With the list focused, they move the selection and cross the section boundary
when the sections are adjacent: from the last row of the Ticket list the next
down lands on the Consultation list, and the next up from its first row lands
back on the tickets. While the Work section stands expanded, the same step
crosses from the Consultation list down into it and back up. Page keys move by one visible
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
so claims never race each other. The Close cleanup of any path that runs
one holds that same seat: an environment change and a handoff never work
beside each other.

Above the panes sits a mode line. It shows the auto-handoff state and the
Parallel limit seat count against the parallel limit: `auto: on 2/2`, or
`auto: off 1` when no limit is set. The count is the one shared
seat-count source the automatic start gates read: the in-flight tickets
whose agent was alive in the latest herdr poll, or is still inside its
startup grace, the handoffs still in progress, and every Consultation in
`opening` or `working`. The gates and the mode line read the same source,
so the two never disagree. The `a` key in the Ticket section toggles the
mode and writes it to the state file at once, so a restart or a dev reload
finds the mode where the operator left it; a state file the plane has just
created starts with the mode off (ADR 0036). A write the state file refuses
reports on the Message line, and the flip stands for the session.

A ticket in the Starting window wears the window's face in the state badge
slot: the Handoff is claimed and not yet settled, or the ticket is
`handed-off`. The face is an animated spinner with the written word
`starting`, and it stands in the list row and the detail pane's state line
in place of the state badge. The `[handed-off]` badge is never drawn: the
face wears the badge's slot from the keypress, and the row's timeline is
`[open]`, face, `[running]` - one face on the way in, one flip when the work
is observed. The face ends when the observation moves the ticket to
`running`, when a settle moves it to `awaiting` or held, or when a start
fails and returns the row to its state with the error line. Every origin
wears the same face: a manual hand-off, a workflow route, a restart, and an
auto hand-off. The face is a shared control with a gallery example, and the
animated glyph is not what the frame snapshots verify: the checks run on the
written word beside any glyph of the face.

A blocked agent replaces the state badge in the list row with a `blocked`
badge: the agent shows an approval or question UI and waits for a human.
The ticket stays in flight, in `handed-off` or `running`, and still counts
against the parallel limit. A missing agent replaces the state badge with a
`missing` badge: the stored pane is gone or holds no agent, so the work
stops there until the operator restarts or abandons the cycle. Both badges
clear when the next poll no longer shows the condition. The first poll has
not landed yet, so no badge appears before it. The failure markers beat the
Starting window's face the way they beat the state badge: a dead or blocked
agent is never hidden behind a spinner, and a crash remnant shows its
recovery fact, not the spinner. A `handed-off` ticket under a marker wears
that marker's own word in the detail's state line too: the `[handed-off]`
badge is drawn by no surface, and the row and the detail never disagree.
A ticket that has used up its per-ticket handoff limit wears a trailing
`handoff limit` marker at the end of the row, and the detail pane shows the
count as `Handoffs: 2/2`. Auto-handoff leaves such a ticket open; a manual
handoff may still pass the limit.
A ticket whose previous herdr environment is still alive wears a trailing
`leftover` marker, and its detail pane names the workspace, tab, and pane that
remain, the reason the control plane knows, and since when. The detail states
that the cleanup runs in herdr, not in the control plane (ADR 0032).
