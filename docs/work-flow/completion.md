---
title: Completion
description: "What happens after a turn settles: the decision in manual mode, the limits in auto mode, held turns, and the handoff limit."
---

# Completion

## After a turn settles

When the agent settles its turn, the ticket moves to `awaiting`, and the
handoff's facts are recorded with the turn: the task type, the agent, its
settings, the completion time, the agent's last message, and the decision
that ends the awaiting state. What happens next depends on your mode:

- **Manual mode** gives you the decision. Enter opens the
  [decision modal](../operation/modals.md) on every settled turn: the turn
  log, and the rows - close the cycle, or hand the ticket off to the next kind
  of work when the settled turn's labels offer one.
- **Auto mode** decides within the configured limits. A fired Transition
  leaves a Next step: the task type the written labels put the ticket on, the
  ticket that position stands on, and whether the step is a Handoff or a Plane
  action. The mode's one rule is "Auto-handoff mode is on, and the settled turn
  has a Next step" (ADR 0092), so that step routes the ticket to the next kind
  of work without you. A turn with no Next step - no branch held, or labels
  that land on a parking state - closes the cycle. A turn whose label write
  failed parks for you: the plane does not route from labels it did not write.
  A step a gate holds - the position offers no such task, the position is not
  actionable, the Same-type hold - rests `awaiting`, and the Message line names it for
  you beside the settle that produced it: the held step, the ticket that position
  stands on when that is not your settled ticket, and the gate that holds it. The
  decision modal never opens on that turn, so the line is where the hold is stated
  while the mode runs.
- A turn that ended in a failure is never decided for you, in either mode:
  see held turns below.

## Held turns and the dispatch pause

A turn that ended in a failure - an error, an interruption, or a cutoff -
rests `awaiting` and shown held until you decide it. While it is held, the
factory will not close its cycle and will not route it, in auto mode or
manual mode.

A failed turn also pauses the automatic starts: while the pause stands, auto
mode starts no agent by itself, so the factory does not pile more work on top
of a failure. The pause ends when you decide the held turn, or when a later
turn completes. Your own manual handoffs are never blocked by it, and a start
that already stands in the Work queue still takes its seat.

A missing agent behaves the same way in auto mode: the factory restarts the
handoff once, with the last message as the previous message, and at the
per-ticket handoff limit it abandons the cycle instead. In manual mode the
factory never touches a missing agent: the `missing` badge stays until you
restart or abandon it from the [missing modal](../operation/modals.md).

## The per-ticket handoff limit

Every ticket carries a handoff limit, `max-handoffs-per-ticket` in the config
(10 by default). The limit stops the close-and-rehandoff loop: when a
ticket's started handoffs reach it, auto mode stops dispatching the ticket
and leaves it open for you. A manual handoff may still pass the limit, so you
keep the last word on one ticket. The limit a held step reads is the limit of
the ticket its position stands on, so a settled ticket whose routes land on a
position at its limit spends its own budget on those turns, and it stops where
its own limit stops it.

## When one ticket's starts keep failing

A start that never reaches its Agent - herdr refuses it, the worktree path
already stands, a name a stranger holds - leaves the ticket exactly where it
stood, so the automatic walk asks it again. The attempt hold waits out one such
failure until your ticket's sources read it again, which on a healthy source is
one refresh. If the starts keep failing after that read, the failed-start park
stands: at half the handoff limit the top-up stops asking that ticket, and the
fact says so where you can read it.

The row wears `failed starts` beside the `handoff limit` marker, the detail
states the run and that the top-up holds it, the record names the hold once, and
the Message line states it as a standing warning, which sends a desktop
notification. The park arrives before the handoff limit, so the limit still
reaches what happens after you act.

Nothing holds your own hand of it. A handoff you start that reaches its Agent ends
the run and the automatic starts resume; ignoring the ticket, or muting its
source, answers the failure and takes the marker off the row. A start of yours
that fails keeps the park standing, because it met the same refusal. See
[ADR 0106](../adr/0106-a-run-of-failed-handoff-starts-parks-its-ticket-and-the-park-states-itself.md).

## When herdr holds the ticket's Agent name

Every ticket asks herdr for one stable Agent name, and herdr holds one name space
across every Agent it knows (ADR 0098). When a pane the plane cannot tie to that
ticket holds the name - another Agent, or one from a run the state file no longer
carries - herdr refuses the start, and the start has nothing left to try: the same
ask meets the same line until a person closes that Agent in herdr.

The refusal leaves a fact on the ticket: the Agent name collision. The row wears
`name held` beside the `leftover` marker, the detail names the pane, the
workspace, the name, and since when, the record names the hold once with the
refusal beside it, and the Message line states it as a standing warning, which
sends a desktop notification. While it stands the top-up adds no automatic start
for that ticket, so the re-ask waits for you instead of spending the handoff limit
on a refusal herdr has already given.

It is not a leftover environment. A leftover environment is your own ticket's
workspace, tab, or Agent that herdr did not remove, and the plane asks herdr to
clean it up. The collision is a name in a pane the plane never made, and the plane
owns no cleanup for it. The two markers ride the same lane and never stand for one
another.

One act clears it, and nothing holds that act out: the handoff you start yourself.
A start that reaches its Agent took the name, so the fact leaves and the automatic
starts resume with no second act. A start of yours that fails for another reason
never asked for the name, so the fact stands. Ignoring the ticket, or muting its
source, answers the refusal the way they answer a run of failed starts. See
[ADR 0107](../adr/0107-a-herdr-agent-name-held-by-a-stranger-is-a-fact-on-the-ticket-and-the-top-up-waits-for-the-operator.md).
