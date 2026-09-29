# ADR 0066: The routed ticket stands queued while its route stands

Status: accepted
Date: 2026-09-29

## Context

ADR 0064 records the route's decision on the settled turn's trace at the
ask, and the ask never waits on a run. Its consequence kept the settled
ticket in its `awaiting` state, and the Queue wait window covered the wait
with the `queued` badge. The state is a lie once the decision lands: the
glossary defines Awaiting as the state where no completion decision is
made yet, and the decision is made. Three reads still said awaiting where
the work had moved - the state file, the Ticket header's awaiting count,
and the Attention band that held the ticket at the top of the list beside
the turns the operator had not decided yet.

The route's handoff starts on the position's ticket, and in the default
workflow that is a different ticket: the issue's implement turn routes to
the pull request's review task. The settled ticket is not the ticket the
start moves, so nothing took it out of `awaiting` at the pickup. In manual
mode the operator closed its cycle by hand, and in Auto-handoff mode
nothing closed it at all: decided tickets piled in the top band.

## Decision

**The ticket state machine gains `queued`.** The settled ticket whose
route ask enqueues leaves `awaiting` for `queued` in the same state write
that lands the decision on the turn's trace (ADR 0064): the state moves
with the decision, and the ask still never waits on a run. The state is
the wait itself: a queued ticket holds no environment and no Agent, and
its start is the item its ask put in the Work queue. The Consultation's
`queued` state keeps its name: the one word for waiting in the queue for
a pickup.

**The pickup ends the wait.** The start report moves the settled ticket
with the handoff it starts, in the same write. When the handoff starts on
the ticket itself - the route's position is the ticket's own new position,
the rework - the ticket moves `queued` to `handed-off` in the cycle it
wore at the ask: the passage continues, and the workflow claim gate
accepts `queued` beside `open` and `awaiting`. When the handoff starts on
a different ticket - the position's own ticket - the settled ticket's
cycle ends where the machine put the work: it returns to `open` with an
incremented cycle number, the way a Close does, while the position
ticket proceeds through `handed-off` as it does today. The trace's
decision word keeps `handed-off` or `auto-handed-off`: a fact is not
rewritten (ADR 0064).

**The wait's exits keep the decision.** The operator's Close on a queued
ticket ends the cycle the routed turn started from, and removes the item
that still waits in the Work queue: a removal ends the whole waiting
start (ADR 0049), and a closed cycle must not leave a live start behind.
A drop or a cancel leaves the ticket in `queued` with the route dead: the
decision stands on the trace, the decision modal's route row stands live
again for the re-confirm, and the top-up's continuation walk re-offers
the turn in Auto-handoff mode the way it re-offers a dropped auto route
(ADR 0064). The walk reads the `queued` ticket where it read the
`awaiting` one, and its position check accepts `queued` beside `open` and
`awaiting`, so the same-position rework re-offers on its own ticket.

**The reads follow the state.** The decision modal's contract widens from
an awaiting ticket to an awaiting or queued ticket: the operator reopens
it on a queued ticket, and the open modal keeps rendering across the
state move its own ask makes. The ticket's row and detail wear the
state's own badge, `[queued]`, painted in the open role's color, the way
the Queue wait's badge painted before; the badge stays the badge for a
manual start, where the ticket keeps its open state. The queued ticket
rides the Attention band first in the in-flight band, before `running`: a
live route owes the operator nothing, and a dead route states itself on
the drop's warning line. The Ticket header's pipeline counts gain no
queued count: the waiting fact is the Work section's own, and its depth
carries it. The Live view's missing rule, the Missing modal, and the
Restart never read a queued ticket, because it holds no agent; the
reclaim's held-pane read takes `queued` beside the other non-open states,
so a closed pane a queued ticket still records is not handed to a
stranger.

## Considered options

- **Reuse `handed-off` at the ask.** Rejected: the different-ticket route
  leaves the settled ticket reading `handed-off` while no agent starts on
  it, and the missing-agent rule reads its closed pane as a Missing
  agent, so the Missing modal would stand over a ticket that owes no
  restart.
- **Close the cycle at the ask.** Rejected: after a drop or a cancel the
  ticket would read `open`, the decision modal would be unreachable (it
  stands above an awaiting or queued ticket), and the operator would lose
  the re-confirm route in manual mode. The work would stay reachable only
  from the position ticket's open row, without the previous message and
  the leftover name the route carries.
- **Presentation only: keep the state `awaiting`, and let the counts and
  the band treat a decided route as queued.** Rejected: the state file
  keeps the lie the glossary defines, and the different-ticket cycle still
  owes a manual close, so the auto-mode pile stands.

## Consequences

- ADR 0064's consequence that the settled ticket "keeps its `awaiting`
  state" and the Queue wait window covers it is superseded by this ADR:
  the wait is the ticket's `queued` state, and the window keeps its badge
  for the manual start alone. The decision at the ask, the fact-line
  route row, and the drop-keeps-the-decision rule stand as ADR 0064
  records them.
- In Auto-handoff mode the routed ticket's cycle now ends on its own, at
  the position handoff's start, where the route leaves the ticket: the
  top band stops piling decided tickets, and the common cross-ticket
  route owes no manual close. The same-position route keeps its cycle,
  and its rework handoff lands in the cycle the ticket wore at the ask.
- The new value needs no schema migration: the ticket's state column is
  unconstrained text, and the state list is one typed constant the
  compiler carries to the badge role table. Boot finds the durable pair -
  the `queued` state and the queue item - and the pickup resumes it; a
  crashed claim never wears a starting face over the ticket (ADR 0041).
- The ignore rule stands unchanged (ADR 0060): a queued ticket has work
  in flight or a decision owed, so it keeps its row beside its marker.
- The observation's awaiting walks - the pending-turn resume and the
  machine's automatic close - keep reading `awaiting` alone: a queued
  ticket owes the machine no decision, and its turn does not reopen over
  a decided trace (ADR 0064).
