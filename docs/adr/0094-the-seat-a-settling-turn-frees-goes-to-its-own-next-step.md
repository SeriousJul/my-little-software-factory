# ADR 0094: The seat a settling turn frees goes to its own next step

Status: accepted
Date: 2026-10-03

Supersedes part of ADR 0051: the cycle's step order, and the queue gate over a
continuation. Its one-item-per-cycle rule, its continuation-then-restart-then-open
order, its gates, and its empty-queue rule over the fresh-work adds stand.

## Context

A dev run on 2026-10-03 stopped a pull request's chain at the seat its own turn
freed. The record is three lines:

- `20:09:37` - the top-up queued a rework on a second pull request (origin open).
  The one seat was full with the first pull request's running rework, so the item
  stood in the queue.
- `20:26:17` - the first pull request's rework turn ended. The same cycle's pickup
  pass took the standing open-ticket item, and that rework started.
- `20:26:26` - the cycle's top-up queued the review the settled turn's Next step
  derives (origin workflow). No seat was left, and the item never started. The
  settled ticket's handoff environment stood on with no start running in it,
  because ADR 0046's reuse of a route's stored workspace stands until the start
  runs.

ADR 0051 orders the top-up's adds - "Continuation first, then restart, then a new
open ticket" - and orders the cycle's steps - "the pickup first, then the top-up".
Read together, those two rules are what stopped the chain. The order holds inside
one top-up call, and the standing open-ticket item was not added by that call: an
earlier cycle had added it, and it stood in the queue. The pickup ran on that
standing row before the settled turn's continuation existed, and the top-up added
the continuation into the empty queue the pickup had just drained, one step too
late to claim the seat the settled turn had freed.

The seat is the machine's scarcest resource, and ADR 0051 already says which
factory work ranks above which. A continuation that loses a freed seat to a fresh
open ticket inverts that rank in the one place it matters.

## Decision

**The cycle asks the continuation it owes before the pickup pass.** The observation
cycle runs the continuation walks - the settled turn's Next step, and the re-fired
skip's route - then the Work queue's pickup, then the fresh-work adds. The item a
settled turn earns is in the queue when the free seats are handed out, so the seat
that turn freed goes to that turn's own next step.

**A continuation row enters ahead of the factory's standing fresh-work rows.** An
automatic route item takes the place of the first automatic open-ticket or restart
row in the queue. With no such row it enters at the tail, as it did. Rows the
operator staged, and continuations the queue already holds, keep their places, and
no standing row moves relative to another.

**The continuation add is the one add that may enter a queue that holds an item.**
It waits behind an item the operator staged and behind a continuation already
standing, and it does not wait behind a fresh-work row. The fresh-work adds - the
restart and the open ticket - keep ADR 0051's empty-queue gate unchanged, so the
queue still never piles: at most one fresh-work row and one continuation.

**One item per cycle stands.** A cycle that asked a continuation asks no fresh work,
the way the single top-up call used to return after its first taken add.

Manual mode runs neither half, as before: the pickup still runs, and a settled turn
that offers a continuation rests in awaiting for the operator's Decision screen.

## Consequences

- The chain continues unattended through a freed seat. The settled turn's next task
  starts on that seat, and the open ticket's item waits for the next one.
- ADR 0046's leftover environment stops standing on its own. The route's start runs
  on the settled ticket's stored workspace right away, so the workspace the dev run
  left behind is reused instead of held open with nothing in it. The reported
  "the workspace never closed" symptom is this bug's consequence, not a second
  defect.
- The Work queue's order is no longer pure enqueue order: a continuation the machine
  owes can take a place ahead of a fresh-work row that queued earlier. The Work queue
  screen still shows the order the pickup will take the rows in.
- `ObservationCoordinator`'s top-up is two steps now: `askContinuations` before the
  pickup, `topUpFreshWork` after it. `FactoryState.enqueueWork` works the row's place
  out in one private read instead of always taking the tail.
- A standing fresh-work row no longer blocks a continuation, so a cycle can hold two
  automatic rows: the fresh-work row and the continuation it outranks.
