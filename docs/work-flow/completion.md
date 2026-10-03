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
  of work without you. A turn with no Next step - no branch held, a label write
  that failed, or labels that land on a parking state - closes the cycle, and a
  step a gate holds rests `awaiting` with the hold stated for you.
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
keep the last word on one ticket.
