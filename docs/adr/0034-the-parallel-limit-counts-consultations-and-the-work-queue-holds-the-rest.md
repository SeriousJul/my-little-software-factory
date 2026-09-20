# ADR 0034: The Parallel limit counts Consultations and the Work queue holds the rest

Status: accepted
Date: 2026-09-18

## Context

The Parallel limit counted ticket seats only and gated the automatic
origins only: a manual handoff was always allowed, and a Consultation never
entered the count. The number of agents the factory ran was bounded on one
side only. A full factory still accepted every manual start, and a
Consultation could be opened unbounded, so the operator had no single answer
to "how much work may run at once" and no surface to stage work that could
not start yet.

The operator's need: one configurable cap over all running work, a manual
start that cannot take a seat waiting in a visible, ordered queue instead of
being refused or starting anyway, an automatic pickup when a seat frees, and
a way to push one queued item to the front over the cap.

## Decision

**The Parallel limit is the one cap over all running work.** It keeps the
ticket seats of ADR 0021 - an in-flight ticket whose agent the latest poll
listed, every in-progress handoff, a started agent inside its Startup grace -
and gains the Consultation seats: a Consultation in `opening` or `working`
holds one, the other states hold none. It gates every start:

- A manual start that cannot take a seat enters the Work queue instead of
  starting: the handoff from the ticket detail, the route from the decision
  row, the restart from the Missing modal, and the Consultation launcher
  submit.
- An automatic start - the open dispatch, the workflow route, the restart -
  waits for a seat as before, reading the combined count: a seat a Consultation
  takes in a mid-cycle race refuses the start, and its own cycle retries it.
  An automatic start never enters the queue.

**The Work queue.** A durable, ordered list of starts waiting for a seat:
the manual Handoff intents (ticket, origin, the operator's choice) and the
Consultations in `queued` state, one shared order across both kinds. When a
seat frees, the observation cycle - the single owner of "what may start
now" - starts the queue before auto-dispatch, up to the free seats, and only
then lets auto-dispatch fill what remains. The pickup runs on every cycle,
including the cycle whose cap reads 0: an unlimited cap holds a free seat for
every waiting start, so an operator who lifts the cap while items wait frees
them, and the queue never strands at a cap that no longer exists.

The operator reorders the items, removes an item, and force-dispatches an
item over the cap. Force-dispatch re-runs every start check the normal
pickup runs and skips only the cap.

A pickup is a manual start: every hard check still runs (the ticket still
holds the state the item's origin requires, the source is healthy, the
Setting fit passes), but no automatic gate holds it - the Dispatch pause and
the Same-type hold gate the automatic origins, and the item is the
operator's own ask, exactly as a direct manual handoff is today. A pickup
that fails a check leaves the queue with a Message line warning: the ticket
keeps its state, and a Consultation whose start fails becomes a `failed`
record, as it does today.

A pickup of a `restart` or a `route` item whose ticket already wears a
handoff newer than the item's enqueue cancels the item: the ticket's turn is
back, and the pickup would only start a second handoff on it. The
observation's automatic restart and automatic route skip a ticket the queue
already waits for, so the operator's captured choice takes the freed seat,
and the cancellation meets the race that slips past that skip.

**A queued Consultation is a record, not a bare intent.** A launcher submit
into a full cap creates the durable Consultation record in `queued` state;
it holds no environment and no agent until pickup, which re-reads the
Consultation type's settings from the config. Removing it from the queue
unschedules it: the record keeps an `unscheduled` state, the Consultation
section lists it, and the operator schedules it back, starts it, or deletes
the record there. Removing a Handoff item cancels it: the intent is deleted
and the ticket keeps its state. The cancel reaches the whole waiting start, so
it ends a claim the pickup already made and the herdr seat parked: that claim
settles as failed and the parked run leaves the drain, or a start the operator
removed would run the moment the seat freed. One window stays open by physics,
not by choice: a pickup whose run already reached herdr cannot be recalled, so
that Agent starts, its ticket moves on, and the removed row says nothing on the
Message line - the module reports a queue start only for a row that still
waited when the start answered. The Main view states the same measured fact: its
cancel line reports a removal only for a row that stood when the keypress ran,
and reports that the queue held no such row when its pickup had already taken
it. One item per ticket: a
second add of the same ticket is refused while the first waits.

The considered alternatives:

- Two caps, the ticket cap and a combined cap. Rejected: two knobs with
  overlapping meaning, and the operator reads the true ceiling from neither
  alone.
- A Consultation queue item as a bare intent, the record created at pickup.
  Rejected: removing the item from the queue would delete the drafted
  intent, and the item would live outside the Consultation list. The record
  in `queued` state lets unschedule keep the work and lists the item like
  every other Consultation.
- Auto-dispatch items visible in the same queue, reorderable by the
  operator. Rejected: the queue stages work the operator asked for.
  Auto-dispatch already orders by Ticket priority and re-checks every poll,
  and mixing the two ordering rules into one list made neither readable.
- Refuse a manual start at a full cap. Rejected: the operator would watch
  for a seat and re-issue the same work; the queue waits for them.
- A hard cap with no bypass. Rejected: urgent work that arrives while the
  factory is full had no path to the front other than reorder; the
  force-dispatch gives the direct override with every other check still
  running.

## Consequences

- A manual handoff is no longer always allowed: at a full cap it queues. The
  "manual handoff is always allowed" clause of the Parallel limit is
  superseded by this ADR. The Handoff limit, the Dispatch pause, and the
  Same-type hold keep their roles; the pause and the hold simply never see a
  queued item's pickup, because the pickup is a manual start.
- A pickup claims like any other start: the claim puts the ticket in the
  Starting window and the settle takes it out, so a picked-up start wears the
  same face the operator sees on a start that took its seat at once.
- The decision a routed start leaves on the turn it routes from has one owner,
  the dispatch module's `recordRoutedDecision`, and both paths call it: the
  Main view's own route and the queue pickup of a route that waited for a seat.
  The state's clock stamps both, so the two records of the fact cannot drift
  apart in words or in time.
- The seat count gains a state-based Consultation side. A stuck `opening`
  holds its seat, so its recover is never capped and can never push the
  count past the cap.
- The mode line counts both kinds against the one cap, and the left pane
  gains the queue as a third Section: its header carries the depth, its
  rows are selectable into the detail pane, and the Section stays hidden
  while it is empty and collapsed, so the two-Section frame survives the
  smallest terminal. The queue's two modes join the shared base modes, so
  the Consultation section's `d` and `f` refuse there in that section's
  words and appear in neither the queue's guide nor its bar: the section
  that does not own a control names it nowhere (issue #85 generalized).
- The schema grows the durable queue - the Handoff intents and the shared
  order - and the Consultation states gain `queued` and `unscheduled`.
- With the cap at 0 (unlimited) the queue never engages: a manual start
  always takes a seat, and every start behaves as before this ADR. When
  items already wait and the cap turns to 0, the next cycle starts the
  whole queue: an unlimited cap holds a free seat for every waiting start,
  so the queue never strands an item the operator staged on it.
