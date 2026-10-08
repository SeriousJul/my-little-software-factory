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

In auto mode the factory decides the settled turn itself: Enter only reports
what it decided, and the modal stays closed. In manual mode the modal opens on
every settled turn (ADR 0092), and when the turn's Next step stands under a
gate - the position offers no task, the position is not actionable, the
Same-type hold, or the Handoff limit - the screen states the hold beside the
row you can still confirm.

## Missing modal

Enter on a ticket whose agent is missing opens the missing modal. It shows
the badge fact and the handoff attempt count, and it offers two rows:

- **Restart** hands the ticket off again with the same choices, in the
  workspace the handoff recorded, and the last message as the previous
  message.
- **Abandon** ends the work cycle: the ticket returns to open, the
  environment is closed, and the missing badge clears.

## Ticket close

The `Delete` key in either Ticket pane is the plane's one destructive key
(ADR 0122). On a ticket that holds a work cycle in flight it ends that cycle,
behind a confirmation that names what is alive and what survives. On an
`open` ticket that waits with a queue row it takes the row out of the Work
section without a confirmation: the ticket stays open, and nothing of the
cycle's history is touched. A close leaves the git branch, the pushed commits,
and the pull requests behind: it takes only the environment the handoff built,
and it never moves your view in herdr. The ticket returns to open, and the
ended cycle counts toward the ticket's handoff limit.

## Leftover environment

When herdr cannot remove an environment, the ticket wears a `leftover` marker
and its detail names the workspace, tab, and pane that remain, with the
reason and since when. The control plane keeps no clear of its own: the
cleanup runs in herdr, not in the control plane, so go there to remove it.

## Agent name held

When herdr refuses a handoff because a pane the plane cannot tie to that ticket
holds the ticket's stable Agent name, the ticket wears a `name held` marker and
its detail names the pane, the workspace, the name, and since when, with herdr's
refusal behind it. The plane owns no cleanup for that pane, so close the Agent
that holds the name in herdr and hand the ticket off yourself: that start clears
the marker, and the automatic starts resume. While the marker stands the factory
adds no automatic start for the ticket. See
[ADR 0107](../adr/0107-a-herdr-agent-name-held-by-a-stranger-is-a-fact-on-the-ticket-and-the-top-up-waits-for-the-operator.md).
