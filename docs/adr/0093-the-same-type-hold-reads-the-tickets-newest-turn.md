# ADR 0093: The Same-type hold reads the ticket's newest turn

Status: accepted
Date: 2026-10-03

Supersedes part of ADR 0026: what the hold reads. Its rule, its purpose, and
its brake on the open auto-handoff stand.

## Context

A dev run on 2026-10-03 stopped a pull request's pipeline in `awaiting`. The
pull request had run a rework turn that finished, and the operator closed that
cycle by hand. The next cycle ran a review, its score fell below the threshold,
its Transition wrote `needs-work` and removed `ready-for-review`, and the Next
step ADR 0092 derives was the rework standing on the same pull request. Auto-handoff
mode routed nothing. The Message line stated the reason: "the Next step is held:
the Same-type hold stands on the position". The Decision screen offered the
rework as a key the machine would not take on its own.

ADR 0026 built the hold against one case: a finished `implement` whose issue
still wears the label that suggests `implement`, so the top-up's open-ticket add
would start the same finished work again. Its read is the newest *closed* cycle -
the row the re-verify gate reads (ADR 0031) - and the rule is that a completed
turn of the suggested task type needs a new signal before the machine repeats it.

ADR 0092 put that same read on the Next step, and the two reads do not describe
the same ticket. A settled turn's Next step stands on a ticket whose current
cycle has already settled a turn. The closed-cycle read skips past it: the rework
that closed two cycles earlier is what the read answers, and the review that just
settled - the newest fact about the ticket, and the act that wrote the label the
rework is asked for - is never read. The hold reported "no new signal landed" on
the ticket whose newest turn was the new signal, and the review and rework loop
ADR 0092 accepts as the mode's unattended work stopped at the first cycle the
operator closed by hand.

## Decision

**The hold reads the ticket's newest turn.** The Same-type hold takes the current
cycle's settled turn when that cycle has settled one, and the newest closed
cycle's row otherwise. The two-cycle window ADR 0031 sets stands: a cycle that
settled no turn - the in-flight Close, an abandon over a turn that never settled -
asserts nothing and clears the hold, and the read never reaches back past the
cycle before the current one.

For the open ticket the top-up's open-ticket add dispatches, nothing changes. Its
current cycle has settled no turn, so the read answers the closed cycle exactly as
it did, and ADR 0026's left-behind-signal case holds the same way.

For a settled turn's Next step the read is now the turn that just settled. A
finished rework two cycles back no longer stands on the rework a review asks for.
The brake the hold carries on a route stays: a turn whose Transition moved no
label, so the position still offers the very task that turn ran, is held by the
turn itself rather than by an older cycle.

The re-verify gate keeps its own read of the newest closed cycle. The two gates
share a row no longer, and they answer different questions: the re-verify gate asks
whether the sources have re-read the ticket since its last cycle ended, and the
hold asks what the ticket's newest turn finished.

## Consequences

- ADR 0026's consequences about the open auto-handoff stand unchanged.
- The review and rework loop runs unattended through a cycle the operator closed
  by hand, up to the Handoff limit, which is the brake ADR 0092 names.
- The hold's sentence on the Message line and the Decision screen is unchanged;
  the fact it states is now the ticket's newest turn.
- `FactoryState.sameTypeHoldActive` and `FactoryState.sourceReverifiedSinceCycleEnd`
  read separate rows. A change to one no longer moves the other.
- The dev run's held pull request routes its rework on the cycle after the review
  settles, with no keypress.
