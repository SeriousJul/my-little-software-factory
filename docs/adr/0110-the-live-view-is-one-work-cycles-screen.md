# ADR 0110: The Live view is one Work cycle's screen

Status: accepted
Date: 2026-10-06

Amends ADR 0072 (the route's ask ends the source ticket's cycle) over the screen
that shows the cycle. The ask's write stands as that ADR states it; what this
decides is what the Live view reads to know its own screen has ended, and the
rule generalises to every screen bounded by a cycle.

## Context

ADR 0072 moved the cycle end into the ask's own write: the settled Ticket goes
`open` with an incremented cycle number in the same step that lands the
decision. The Live view derived its fallback from that move the way the other
modes derive their faces - from the Ticket's state. The screen closed when the
Ticket left the in-flight states, and under the ask that means the frame
holding `open`.

The state a write only passes through is not a fact the plane owes a render of.
[Issue #304](https://github.com/SeriousJul/my-little-software-factory/issues/304)
started as a test that asserted the fallback on a quiet frame; when the test
learned to wait for the fact, it did not go green - it missed the frame deadline
instead, with the Live view still open in the last frame. A probe that recorded
every render of the App through the confirm, as `panel`, the Live view's mode,
the projected Ticket state, and the cycle number, showed why:

| Run | The render sequence after the confirm |
| --- | --- |
| Green run | `panel=live mode=decision state=awaiting cycle=1`, then `panel=live mode=closed state=open cycle=2`, then `panel=-` |
| Red run, 3 of 3 at the load rig | `panel=live mode=decision state=awaiting cycle=1`, then `mode=stream state=handed-off cycle=2`, then `mode=stream state=running cycle=2`, over 404, 419, and 428 renders, and **no render holds `open` at all** |

The write that ends a cycle moves the Ticket to `open` and to the next cycle in
one step, and the Work queue's pickup claims the next cycle's start before the
plane next reads the projection. The `open` frame is a moment the plane may
never be handed. A screen that waits on that moment alone can be given the next
cycle's frame first and then wait for a screen change that no longer comes: the
operator keeps watching a stream that belongs to a passage the plane has already
left, and a test that waits for the screen keeps watching until its deadline.

## Decision

**The Live view is one Work cycle's screen.** The screen ends when the Ticket
moves to the next cycle, whatever Ticket state the render that follows answers
with.

**The Live panel names its cycle.** The panel carries the Work cycle number it
opened on beside the Ticket identity, and the Live view's mode closes the screen
when the projected Ticket's cycle differs from the panel's, beside the rule it
already had that the screen closes when the Ticket leaves the in-flight states.

**A route override returns to the panel it left, as one value.** The override
that edits a route from the Live view holds the panel it returns to - the
Decision modal or the Live view on its cycle - rather than the fields that panel
happens to have, so the return names the cycle the operator left and the ask the
confirm runs ends the returned screen too.

**A screen bounded by a transition reads the durable form of it.** Where a
screen exists for one passage, it ends on the fact that survives the writes
inside the passage - the cycle number, the recorded decision - and not on a
state the write only passes through on its way. A state the plane may never
project is not a fact a surface may wait on, in the plane or in its tests.

## Considered options

- **Wait for the `open` frame.** The plane could be made to owe the render, by
  reading the projection between the ask's write and the pickup's claim.
  Rejected: the plane does not own the pickup's pace, and a render forced to
  catch a state the state file has already left is a render made for the view's
  sake, not for a fact.
- **Keep the state derivation and widen the test's wait.** Rejected: no wait
  passes a fact the plane never produces, and the widened wait is how the
  mechanism surfaced - the miss moved from an assertion at 0.4 s to a deadline
  at 10 s on the same tree.
- **Derive the fallback from the recorded decision.** The `handed-off` trace is
  durable and is the ask's own fact, but it says nothing about the cycles after
  the ask, and the view outlives none of them: the cycle number is the fact the
  screen is bounded by, and the decision is already asserted where it belongs.

## Consequences

- The routed handoff's fallback no longer depends on which projection the plane
  happens to be handed. The screen ends at the ask on the first frame that shows
  the next cycle, and the list is drawn again behind it.
- The Live view's contract in `GLOSSARY.md` states the cycle bound as a state
  fact of the screen, and the plane's `Panel` carries the cycle beside the
  identity, so a surface that reopens the view has to name a cycle.
- The pin is `test/live-view.test.ts` - **the view ends on the work cycle it
  opened on, with no frame holding the open state (ADR 0110)**: it ends the
  cycle and claims the next one in one turn of the event loop, with no
  projection read between the two writes, so the plane's first read finds the
  Ticket in flight in the next cycle and no frame ever holds `open`.
- ADR 0072 stands for the ask's write, corrected here for the screen it ends:
  the ask ends the cycle under the Live view, and the view ends on the cycle
  number, not on the `open` state the write passes through.
- What the same investigation exposed beside this - a keypress landing on a
  surface that already left the screen, in the window between the fallback frame
  and the effect cleanup that releases its keys - is a product race of its own,
  recorded with [issue #317](https://github.com/SeriousJul/my-little-software-factory/issues/317)
  and not answered here.
