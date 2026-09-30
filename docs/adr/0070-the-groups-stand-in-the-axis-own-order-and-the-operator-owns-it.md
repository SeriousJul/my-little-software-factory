# ADR 0070: The Groups stand in the axis' own order, and the operator owns it

Status: accepted
Date: 2026-09-30

## Context

ADR 0059 stood the Groups by the best attention band among the tickets they
hold, then by the newest external update in the Group, then by the group
value. That order is a presentation of the ticket facts, and it moves as the
facts move: a ticket that enters or leaves a Group, a band a ticket changes,
a turn that settles behind a header - every one of them can trade two Group
headers' places. The operator's map of where a Group stands breaks, and the
Group the cursor rested on is no longer the one under it after a refresh.

The attention order is the right order for rows: a flat list answers
"what needs me now", and a Group's own rows answer it inside the Group. It is
not the right order for the Group headers, because the operator reads the
headers as a stable shelf of their own - the place of a Group is a fact about
the operator's arrangement, not a fact about the tickets. And ADR 0059 gave
no way to arrange the shelf at all: the Group of the Repository an operator is
working in stands wherever the tickets in it happen to put it.

## Decision

**The Groups stand in the axis' own order of its values, and the ticket
facts do not move them.** Each axis names its default order: `position`
reads the Workflow's own order of its positions, with the unmatched position
last; `state` reads the plane's own order of the Ticket states; `repository`,
`source`, and `task` read the values by their name, with the special value
last - `unmatched` on the position axis, `unknown` where the axis has no
value to read. A Group's slot changes only when the operator moves it or the
axis changes. The order inside a Group is exactly what ADR 0059 decided it
to be: the order the flat list holds, band rules and all.

**The operator moves a Group with `+` and `-` on its header.** The cursor
rests on a Group header and `+` or its unshifted form `=` trades the Group
with the visible neighbor above it, and `-` trades it with the visible
neighbor below. The cursor lands on the Group the move ran on, so the next
press needs no hunting. At the first visible Group, `+` runs no move, and at
the last visible Group, `-` runs no move: the Message line says so in the
queue's own words, the refusal the queue's own order keys answer with. On a
ticket row the keys answer the queue's refusals, because the move needs a
Group under the cursor.

**One move writes the whole order, and the order is per axis.** The first
move captures the axis' full computed order - every value the list holds,
stored values and default-ordered ones together - and every later move writes
the full order again. The write is keyed by section and axis, so each axis
keeps its own arrangement. A Group the filter hides keeps its slot in the
order the list stands in, because the write carries the full computed order
rather than the visible slice, and a value no ticket carries today keeps the
place the operator gave it when a ticket carries it again.

**The order is factory state, the way the axis itself is.** A `group_order`
table holds one row per value, per section and axis, on the state file. A
fresh file holds no order, and the plane then stands the axis' default and
writes nothing until a move asks for it. A plane with no state file keeps the
moved order in memory for the run and writes to nothing. A write that fails
is reported the way the axis' own write is, and the view follows the press
either way: the order stands for the run.

This supersedes ADR 0059's order of the Groups - its first decision sentence,
the best attention band, then the newest external update, then the group
value. ADR 0059's other decisions stand: a Group presents the list order and
never a new sort inside it, a fold hides rows and never facts, the plane
never opens a Group by itself, and a group key is a fact of the ticket.

## Considered options

- **Keep the attention order and make it stable.** A stable presentation of
  the same moving facts - sort by first seen, freeze on load - still puts
  the headers where the tickets put them, and still gives the operator no
  shelf of their own. The instability was the complaint, not just its
  timing.
- **A pin, or a per-Group offset.** A pin says "this Group first" and an
  offset says "this Group two places up"; neither says "this Group third,
  under that one". The operator's arrangement is a full order, so the store
  holds a full order, whole on every write: there is no partial state a
  crash can leave.
- **Let the operator type a value to a position.** A named move is more
  precise than a neighbor swap and costs a text entry in a flow where the
  cursor is already on the Group. The neighbor swap is the move the Work
  queue's `+` and `-` already mean, and one vocabulary for "move this row to
  its neighbor" across the two lists is worth more than the precision.

## Consequences

- The attention order is still the order of rows, in the flat list and
  inside every Group. On a grouped list it no longer orders the headers. ADR
  0059's considered option "Groups alphabetical by value" is now the default
  on the name axes - with the operator's own arrangement standing over it,
  and the Workflow's own order standing first on the position axis.
- `+`, `=`, and `-` in the Ticket modes are the Group's move keys. The
  catalogue owns the resolution, as it owns every key's meaning per context:
  on a Group header the move runs, on a ticket row the queue's refusals
  answer, and in the Consultation modes the queue's own promote and demote
  keep the keys.
- The key guide carries the two move rows, and the bar states the move the
  facts under the cursor run: the move hints stand where the cursor is on a
  Group header, and the axis' own hint stands where it is on a ticket row.
- The state file gains the `group_order` table at the schema step to 23,
  with the standing rule the other tables carry: a file stamped at the
  target without the table heals on open, and an older file migrates to it
  with the work it held.
- A Group the operator moved out of its default place stays moved when the
  axis leaves and returns, when the list refreshes, and across a restart:
  the order is the operator's fact, and only a move changes it.
