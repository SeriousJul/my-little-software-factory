# ADR 0051: Auto-handoff tops up the Work queue one item at a time

Status: accepted
Date: 2026-09-22

## Context

Auto-handoff held three direct-dispatch jobs: the open dispatch that
filled freed seats with open tickets in priority order, the workflow
route that started a settled turn's next task while a seat was free and
waited in awaiting behind a full one, and the automatic restart of a
missing agent. Each retried itself every observation cycle, and none of
it was visible to the operator. The priority that ordered it is retired
(ADR 0050), and the queue is the single start channel now (ADR 0049).

The operator wants the automatic side very simple: send what the queue
holds, continue a finished workflow when an agent completes, park for a
human whatever the plane is unsure of, ignore a ticket at its handoff
limit, and never pile the queue.

## Decision

**The observation cycle runs the pickup first, then the top-up.** The
pickup, the queue's pass for the free seats, runs in both modes,
unchanged. Then, and only then, the top-up: while Auto-handoff mode is
on and the queue is empty, the cycle adds exactly one item.
Continuation first, then restart, then a new open ticket, else nothing.
A queue that holds even one item holds the automatic adds until it
drains, so the queue never piles, and the operator's staging always
starts before the factory's.

**A continuation is the next step of finished work.** An awaiting
ticket whose newest settled turn's Transition fired, wrote its label
facts, and whose new position offers a task. The top-up adds it as a
route item with the Transition's pins, the way the Decision screen's
route enters the queue. Several continuations compete in the ticket
list order. The re-fired skip's route (ADR 0042) is a continuation: it
enqueues like the rest, and its guards, the position still offers the
task, no handoff, no queue item, under the limit, stand. In manual mode
the top-up does not run: a settled turn that offers a continuation rests
in awaiting, and the operator's Decision screen routes it, the route
entering the queue like every start.

**The wait lives at the gate, not in the queue.** A ticket the gates
hold rests in its state, and the top-up skips it. A ticket at its
handoff limit is ignored: its route degrades to close, as it did. A held
turn, a Transition whose label write failed, a same-type hold
(ADR 0026), and a Dispatch pause (ADR 0016) park the ticket for the
operator instead of adding it. The gates hold the automatic adds only:
a manual handoff and a route the operator confirms pass them, as before.

**The machine acts only where it is sure.** A completion the machine
resolves closes as before: a turn whose task type offers no
continuation closes its cycle, and a Transition that advanced into a
parking state closes it, leaving the ticket in the state where a human
or an external tool drives. The machine knows the destination, so it is
not unsure. A Transition whose label write failed no longer closes: the
plane does not route from labels it did not write, and the ticket rests
in awaiting for the operator's Decision screen, where a route the
operator confirms is the operator's own choice on a position the plane
could not write.

**An item the queue drops re-enters on its own.** A continuation,
restart, or open ticket the pickup drops (ADR 0049) rests in its state
with its warning. The top-up reconsiders it every cycle the queue is
empty, and a gate that still holds it parks it again. Nothing is
retried by re-enqueueing the same item; the top-up simply asks again.
The restart carries one exception: the top-up marks the ticket
restarted for the episode when it asks, and an ask the dispatch refuses
clears the mark again, so the next cycle asks. A restart item that
reached the queue and the pickup then dropped keeps its mark until the
ticket leaves in-flight: the plane does not re-ask a start the seat
already refused, and the operator's Missing-modal restart is the free
path for a ticket that needs one.

## Consequences

- ADR 0027's decision that a fired transition that auto-advances routes
  the new position's task while the parallel limit has room, a full
  limit waiting in awaiting, is superseded by this ADR: the route
  enters the queue through the top-up, and the wait lives at the gate.
  Its machine, fire, and label rules stand.
- The Dispatch pause's hold of the automatic route in manual mode is
  retired with the route: manual mode no longer routes by itself
  (ADR 0016).
- The re-fired skip's route (ADR 0042) no longer starts in its own seat
  in any mode: it enqueues while the mode is on, and in manual mode the
  position rests open and the operator hands it off.
- The held-turn gate of ADR 0016, the same-type hold of ADR 0026, and
  the re-verify gate keep their rules; they now gate the top-up's adds
  instead of the direct dispatches.
- Steady state: the queue holds at most one automatic item beside the
  operator's own staging, and the depth the Work header carries is the
  operator's queue, not the factory's noise.
- The Message line's automatic lines now name the top-up's adds, and
  the operator sees what the factory is about to start in the queue
  before it starts.
