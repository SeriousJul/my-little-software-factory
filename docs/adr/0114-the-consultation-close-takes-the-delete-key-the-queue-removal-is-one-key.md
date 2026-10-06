# ADR 0114: The Consultation close takes the Delete key, so the queue removal is one key

Status: accepted
Date: 2026-10-06

Amends ADR 0037's key decision: the Consultation close no longer takes `w`.
Its confirmation decisions hold unchanged.

## Context

ADR 0037 put the Consultation close on `w`, the key ADR 0031 gave the Ticket
work-cycle close, so the two sections named their close on one key and the Key
guide stated it once. The unification was between the two Closes.

The operator reads the key for a different job. Taking a start out of the Work
queue is one gesture: the Work queue removes the item under the cursor with
the Delete key, and the Consultation section's close is how a queued
Consultation leaves that same queue. ADR 0034's queue holds the Consultation
items beside the Handoff items, and the two sections that look at the same
row reached for two keys - Delete in the queue, `w` in the section - to take
it out. The operator asked for the removal to be one key, and for `w` to leave
the Consultation section.

The Ticket work-cycle close (ADR 0031) is a different action: it ends a
ticket's work cycle, not a queue row, so it keeps `w`. The Consultation
section's `d` Delete is a third action - it removes a closed or unscheduled
record from the history - and keeps its key.

## Decision

**The Consultation close takes the Delete key, in both Consultation modes.**
The catalogue's `consultation-close` control claims `delete`, beside the
Work queue's `queue-remove`, so the key that takes a row out of the queue
answers the close in the section that lists the row. `w` is retired from the
Consultation section: the catalogue resolves it there to nothing, and the
Ticket section's `w` Close is untouched.

**The close's confirmation shape is ADR 0037's, unchanged.** A close that
stops a live Agent confirms first behind the shared panel and names what it
keeps; a `missing`, `failed`, `queued`, or `unscheduled` Consultation closes
without a dialog; a `closing` one opens the panel with its Retry and
Force-close rows. The key move is in the catalogue only; the dispatch stays
in the Consultation routes.

## Consequences

- The Key guide and the Action bar state Close on the Delete key in the
  Consultation section and on `w` in the Ticket section. The shared catalogue
  still states each close once, so the bar and the guide cannot disagree.
- The Consultation section names its two removals on two keys: the Delete key
  closes the Consultation and, for a queued record, takes its item out of the
  Work queue; `d` deletes a closed or unscheduled record from the history.
  The keys follow the actions, and each action keeps its own refusal.
- ADR 0037 is superseded in part: the close no longer takes `w`. Its
  confirmation decisions - confirm exactly when a live Agent is stopped, close
  direct on a record with no agent, refuse a closed one - hold.
- ADR 0038's references to `w` as the key that opens the Consultation close
  panel are superseded where they name the key: the panel opens on the Delete
  key. Its Enter decisions hold.
- `w` now belongs to the Ticket section alone: the work-cycle close on a
  ticket, in both Ticket base modes. A key the catalogue resolves to nothing
  in the Consultation section answers no control there, the way `z` does.
