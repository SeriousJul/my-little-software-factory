# ADR 0051: Auto-handoff tops up the Work queue one item at a time

Status: accepted
Date: 2026-09-22
Superseded in part by ADR 0092: a continuation is the Next step Auto-handoff mode derives from a settled turn, not the outcome of a transition that carries `auto-advance`; the flag is deleted and the mode decides at runtime. Its single-channel, one-item-per-cycle, and gate rules stand.

Superseded in part by ADR 0094: the cycle asks the continuation it owes before the Work queue's pickup, and a continuation row enters ahead of the factory's standing fresh-work rows. Its one-item-per-cycle rule, its continuation-then-restart-then-open order, its gates, and its empty-queue rule over the fresh-work adds stand.

Amended in part by ADR 0108: the Missing Agent's Restart is asked past a standing queue row, because the seat that Agent left is reserved for that row, and its row enters behind the owed continuation and ahead of the standing rows. The empty-queue rule over the open-ticket add, the one-item-per-cycle pace, and the gates stand.

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

(ADR 0094 moves the continuation ask ahead of the pickup, and lets a
continuation enter a queue that holds only fresh-work rows. The restart
and open-ticket adds keep this rule unchanged.)

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

**The ask's stopped answer is a stop, not a refusal.** The top-up's
ask reports a refusal with a warning line when the dispatch rejects
the item, and the run ending is not a rejection of any item. A
stopped dispatch answers with its own stop fact, and the ask ends the
walk with no line: the observation's own stop follows in the same
teardown, and a warning per cycle would pin the Message line while
the run ends.

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
