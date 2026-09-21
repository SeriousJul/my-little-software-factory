# ADR 0030: A starting ticket wears a spinner in place of its state badge

Status: accepted
Date: 2026-09-18

## Context

A Handoff moves the ticket's state in two steps after the operator presses
the key. The claim records the Handoff attempt and leaves the ticket where it
stands; only when the agent starts does the settle move the ticket to
`handed-off`, and the first observation that sees the agent working moves it
to `running`.

The list gave the operator no part of that story. The row stayed `[open]` from
the keypress until the agent started, and the only feedback was the Message
line's progress. Then the badge flipped to `[handed-off]`, and flipped again
to `[running]` at the next observation. The start window read as a silent row
and two status flips: the operator could not tell from the row that the key
had registered, and the flips said nothing the operator could act on.

The facts the face needs already exist. The unresolved-attempt fact says a
handoff is in progress from the claim until the agent starts or the start
fails, and the `handed-off` state says the agent has started and the work is
not yet observed. Nothing drew either.

## Decision

**The Starting window.** The window during which a ticket's Handoff is
claimed and not yet settled, or the ticket is `handed-off`. One face wears
the whole window: an animated spinner with the written word `starting`, in
the state badge slot of the ticket row and of the ticket detail, in place of
the state badge. The `[handed-off]` badge is never drawn. The row timeline
becomes `[open]`, spinner, `[running]`: one face on the way in, one flip when
the work is observed.

The face is a presentation of two existing facts. The domain keeps the
`handed-off` state for durability, the Startup grace, and the observation,
and the section header counts keep counting a `handed-off` ticket as
running. No new state, no migration.

The window is bounded by the claim the run made, not by the raw
unresolved-attempt fact. A crashed hand-off leaves an unresolved attempt that
stays blocked across a restart, and the ticket shows its recovery fact. A
spinner driven by the raw fact would spin forever on such a ticket. So the
window is: a claim made in this run, reported by the hand-off dispatch on
claim and on settle, or the `handed-off` state. After a restart, a
`handed-off` ticket wears the spinner until the first observation sees its
work, which is the truth: the control plane has not yet observed it.

A failure marker (blocked, missing) beats the spinner the way it beats the
state badge today. A dead or blocked agent is never hidden behind a spinner,
and the recovery screens stay reachable.

Every Handoff origin wears the same face: manual hand-off, workflow route,
restart, and Auto-handoff. The face states the ticket's fact, not who asked.

The spinner carries its written word the way the shared state words do, so
the NO_COLOR presentation removes nothing. It is a control of the shared
control library with a gallery example, and it drives itself the way the
Decision modal pop-in does, so the deterministic test renderer paints the
first frame and the snapshots hold.

The considered alternatives:

- A spinner only during the claim window, then the `[handed-off]` badge.
  Rejected: the row still flips twice inside the start window, spinner to
  badge to running. The ask was a coherent start, and this keeps two of the
  flips.
- No face at all; the Message line carries the feedback. Rejected: the row
  the operator acted on stays `[open]`, and the feedback lives on a line the
  operator may not be watching.
- Drive the spinner from the raw unresolved-attempt fact. Rejected: it spins
  forever on a crashed run's remnant.
- A new ticket state `starting` in the durable state. Rejected: the window
  is a presentation of two existing facts. A stored state adds a fourth
  badge to manage, a migration, and transitions the domain does not need.

## Consequences

- The operator sees the key register at once: the row leaves `[open]` for
  the spinner on the keypress, and stays one face until the work is observed.
- The `[handed-off]` badge is no longer drawn by any surface. The state
  remains in the domain, the counts, and the observation, and the state badge
  mapping keeps its entry for the state.
- A start that fails ends the face at once: the row returns to `[open]` with
  the error line, as today.
- A turn that settles while the ticket is `handed-off` ends the face at the
  `awaiting` or held face, as the state rules already decide.
- The Message line keeps its own progress line beside the face; the two say
  the same fact in two places.
- The animated frame itself is not something the frame snapshots verify. The
  verification record states what the terminal walk covered.
