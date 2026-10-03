---
title: Main view
description: The Main view's three sections and its counts, the keys you drive it with, and what the badges mean.
---

# Main view

![The Main view: the Ticket and Consultation sections on the left, the
detail of the selected ticket on the right](images/main-view.png)

The Main view holds three list sections on the left - the Ticket section on
top, the Consultation section below it, and the Work section below that -
plus one detail pane on the right that shows the detail of the item the
cursor holds. `x` or a click on a section header folds the section to its
header row; the same toggle restores it.

- **The Ticket section** lists your tickets with their state and task type.
  Its header shows the pipeline counts - open, running, awaiting - and, only
  when non-zero, the held count with its bell marker and the ignored and
  muted counts. A held count means a turn ended badly and the decision is
  yours.
- **The Consultation section** lists your Consultations. Its header shows how
  many wait for your answer and how many need recovery, so a Consultation
  that needs you is visible whether the section is open or folded.
- **The Work section** holds every start that waits for a seat: the manual
  starts you staged, the starts the auto-handoff adds, and the Consultation
  starts. Its header shows the queue depth and the `paused` word while the
  drain is paused. `+` and `-` move the item under the cursor toward the
  front or the back, `Delete` removes it, `p` pauses or resumes the drain,
  and Enter starts the item now, even over the limit.

The detail pane shows the full detail of the selected item. On a ticket: the
title, the repository, the state, the agent with its environment, model,
thinking level, and context window, the task type, the handoff count against
its limit, the last completion when one stands, and the source facts - the
source name, the state, and the labels. On an open ticket it shows the
settings `Enter` would start with; on a ticket inside a work cycle it shows
the settings that handoff started with.

## The keys

| Key        | What it does                                                             |
| ---------- | ------------------------------------------------------------------------ |
| `Enter`    | Hand an open ticket off; open the decision on an `awaiting` one         |
| `e`        | Open the override panel: change the handoff's settings before it starts  |
| `w`        | Close the selected ticket's work cycle, behind a confirmation            |
| `i`        | Ignore the selected ticket, or take the ignore back                      |
| `u`        | Mute the source the selected ticket came in on, or take the mute back    |
| `f`        | Cycle the list filter: the active rows, the ignored, the muted, both     |
| `a`        | Toggle auto-handoff                                                      |
| `r`        | Refresh the ticket sources and the Consultation list                     |
| `g`        | Go to the selected ticket's agent pane in herdr                          |
| `Tab`      | Split the ticket list into Groups, and step to the next grouping axis    |
| `Space`    | Fold or open the Group under the cursor                                  |
| `?` / `F1` | Open the Key guide, from anywhere                                        |

`h`/`l` or `Left`/`Right` move between the list and the detail pane,
`j`/`k` and the arrows move the selection, `m` or `F2` reads a truncated
Message line, and `q` quits.

## The badges

- `awaiting`: the agent's turn settled, and the ticket waits for your
  decision.
- `parked`: the ticket sits on a state the machine offers no task for; it
  moves only when a label changes.
- `queued`: the ticket's start waits in the Work section for a seat.
- A starting ticket wears an animated spinner in place of its state badge.
- A `blocked` badge means the agent is waiting on your approval; a `missing`
  badge means the agent is gone, and the work stops there until you restart
  or abandon it.

The screen names two task type facts for one ticket, and they stay separate on
purpose (issue #201, story 18). The row's badge and the detail pane name the
task type of the turn the ticket is on: the handoff's while a turn runs, and the
suggested task type for an open ticket, whose handoff record is the closed
cycle's history. The Decision modal's context row, the Live view's context line,
and the Work queue's row name the task type of the turn that settled, else the
handoff's, else the suggestion, else the configured default. While a second turn
runs on one ticket the two can name different task types, and each surface keeps
the one its own rows are about. The domain answers both: `rowTaskType` for the
row and the detail, `turnTaskType` for the context lines.

## Groups

`Tab` splits the ticket list into **Groups**: runs of rows that share one
value of one **Grouping axis** - the repository, the source, the task type,
the state, or the position - and one press steps to the next axis, so the
flat list is always one press away. Each Group header carries its ticket
count and, above zero, its held count. `Space` or a left click folds or opens
the Group under the cursor. A fold hides rows, never facts: the counts and
the order of work are the same with a Group open or shut. Your grouping axis
stands after a restart; the folds do not.

## The mouse

The mouse works: a click selects a row, a drag copies the text to your
clipboard, and the wheel scrolls the lists and the detail pane.
