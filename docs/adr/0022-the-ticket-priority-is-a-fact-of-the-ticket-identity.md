# ADR 0022: The ticket priority is a fact of the ticket identity

Status: accepted
Date: 2026-09-14

## Context

Auto-handoff dispatches open tickets in list order: attention group, then
external update time, newest first. The operator declares priority on the
GitHub issue, and the pull request that does the work must carry it through,
regardless of task type. Nothing in the factory knows a ticket is urgent
until this ADR.

The hard case is the window between task types. A pull request's task type
settles and its cycle closes; the ticket returns to `open`; the next task
type on the same pull request has not started yet. In that window the
ticket must not lose its priority, and lower-priority work must not jump
ahead of the pull request's continuation.

## Decision

**The priority is a fact of the ticket identity.** One effective rank per
ticket, computed as: the Priority override, else the rank of the ticket's
own label in the Priority label list, else, for a pull request, the highest
effective priority of the issues it closes (ADR 0023), else unranked. The
value survives every task type change and every work cycle close. A close
consumes the cycle; it never consumes the priority.

**One comparator, every place.** Ranked before unranked, better rank first,
then external update time newest first, then ticket identity. It orders the
ticket list within each attention group, the open auto-handoff dispatch, and
the waiting workflow routes that compete for a freed parallel slot. The list
the operator sees and the order the factory acts in cannot disagree.

**No slot reservation across the close window.** After a close, the ticket
re-enters the open queue at its full priority one source refresh later,
behind the existing re-verify gate. Workflow routes keep their existing
precedence: a route is retried every cycle before any open dispatch, so a
continuation that can start always beats new work. Priority only orders
several waiting continuations against one freed slot. The handoff limit
stays the backstop for a label that never changes.

**A refresh can change a rank at any time.** A running ticket is untouched
while its turn runs; its next dispatch, route, and decision use the new
rank. That is the source-fact rule applied to priority.

## Considered options

- **Reserve a parallel seat across the close window.** A seat held for the
  pull request's continuation while the next task type has not started.
  Rejected: it redefines a seat (ADR 0021 counts only in-flight,
  in-progress, and booting facts), and there is no reliable signal that a
  next task type will ever come. A label may never change, and a reserved
  seat starves the factory for work that may never arrive.
- **Per-handoff or per-cycle priority.** A value set at each handoff or
  recomputed per cycle. Rejected: "regardless of task type" asks for a
  value that survives the close and the re-open. A per-cycle value is
  consumed by the close it is supposed to protect.
- **Per-surface orderings.** The list sorts one way, the dispatch another.
  Rejected: the operator trusts the list. A dispatch that disagrees with
  the list reads as a bug, and two comparators drift.

## Consequences

- A ranked ticket whose label never changes can loop: close, re-open,
  re-dispatch, until the handoff limit. That is intended. The handoff-limit
  marker then asks the operator, and the Priority override gives the
  operator a way to lower the rank without touching GitHub.
- A rank change under a running ticket changes nothing until the ticket
  next competes for a slot.
- The control plane never writes priority to the external source. Labels
  change on GitHub; the override and its bump shortcut live in factory
  state.
