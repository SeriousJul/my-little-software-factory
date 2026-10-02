---
title: Modals
description: The decision modal's rows, the missing modal, the Ticket close, and the leftover environment fact.
---

# Modals

## Decision modal

![The decision modal on an awaiting ticket: the turn log of the settled
turn above the choice rows](images/decision-modal.png)

Enter on an `awaiting` ticket opens the decision modal: the turn log of the
settled turn above the choice rows, with the repository, task type, agent,
and completion time named under the border. `Up` and `Down` move between the
rows, `j` and `k` scroll the log, `Enter` chooses the selected row, `e` edits
the selected Handoff row's settings before it starts, and `Esc` closes the
modal: nothing runs, and the ticket stays awaiting.

The rows the modal offers:

- **Close** ends the work cycle: the ticket returns to open, and the
  handoff's environment is closed without touching your git branch - the
  branch, the pushed work, and the pull requests are left behind.
- **Goto** focuses the agent's pane in herdr so you can steer it by hand. The
  ticket stays awaiting until the next poll moves it or you decide it.
- **Handoff: `<task type>`** hands the ticket off to the next kind of work,
  when the settled turn's labels put it in a state that offers one. `e` on
  the row edits that one handoff first.
- **Re-fire** appears when the turn's transition did not complete its work -
  no branch held, or the label write failed. It runs the same transition
  again, reading the source as it stands now.

In auto mode, and on a transition that auto-advances, the factory decides
the settled turn itself: Enter only reports what it decided, and the modal
stays closed.

## Missing modal

Enter on a ticket whose agent is missing opens the missing modal. It shows
the badge fact and the handoff count, and it offers two rows:

- **Restart** hands the ticket off again with the same choices, in the
  workspace the handoff recorded, and the last message as the previous
  message.
- **Abandon** ends the work cycle: the ticket returns to open, the
  environment is closed, and the missing badge clears.

## Ticket close

Key `w` in either Ticket pane ends the work cycle of the selected ticket,
behind a confirmation that names what is alive and what survives. A close
leaves the git branch, the pushed commits, and the pull requests behind: it
takes only the environment the handoff built, and it never moves your view in
herdr. The ticket returns to open, and the ended cycle counts toward the
ticket's handoff limit.

## Leftover environment

When herdr cannot remove an environment, the ticket wears a `leftover` marker
and its detail names the workspace, tab, and pane that remain, with the
reason and since when. The control plane keeps no clear of its own: the
cleanup runs in herdr, not in the control plane, so go there to remove it.
