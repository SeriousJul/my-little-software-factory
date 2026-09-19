# ADR 0037: The Consultation close takes w and confirms on a live Agent

Status: accepted
Date: 2026-09-19

## Context

ADR 0019 moved the Consultation close onto key `z` when `x` became the
section toggle. The key carried no meaning, and it diverged from the Ticket
section, where ADR 0031 put the work-cycle close on `w` with a confirmation
whenever it stops a live agent. `z` is the left-pinky corner of the home row
with nothing on it, and the two sections naming their most destructive
action on different keys made the Key guide state a fact the operator had to
memorize per section.

The Consultation close already had the confirmation decision; ADR 0019 only
gave it a key. A close on a `missing` or a `failed` Consultation runs
directly, because those records hold no agent to stop. A close on an
`opening`, a `working`, or an `awaiting-response` Consultation stops a live
agent, so it confirms first.

## Decision

**The Consultation close takes `w`, the key the Ticket work-cycle close
holds (ADR 0031).** Both sections name the close on the same key, and the
Key guide states it once from the shared control catalogue, so the Action
bar and the guide cannot disagree. The key moves in the catalogue only; the
dispatch stays in the Consultation routes.

**The close confirms exactly when it stops a live agent.** On an
`opening`, a `working`, or an `awaiting-response` Consultation, the shared
confirmation panel opens. Its first line states who is alive, worded per
state, and its body states what the close keeps: the worktree and the branch
on a worktree Consultation, the checkout on a live-worktree Consultation.
Confirming closes, cancelling leaves the state unchanged.

**A `missing` or a `failed` Consultation closes directly.** The record holds
no agent, so the close has nothing to confirm. A `closing` Consultation
opens the existing recovery panel with its Retry and Force-close rows, and a
`closed` one refuses on the Message line. The close panel is one panel kind
and one shared panel element; the record's state selects the shape - the
confirmation rows on a live record, the recovery rows while closing - and a
record the close panel cannot draw lets the panel go, with the reason
stated on the Message line.

The considered alternatives:

- Keep `z`. Rejected: the key carries no meaning, and the sections name
  their close on different keys for no gain.
- Refuse the live close and require a Recovery first. Rejected: stopping a
  live agent is a normal operator decision, not a recovery, and the
  confirmation is the record that it was made.
- Confirm on every close, including `missing` and `failed`. Rejected: a
  record with no agent has nothing the confirmation could state, so the
  dialog would ask for a fact the record denies.

## Consequences

- ADR 0019's consequence that the Consultation close takes `z` is superseded
  in part by this ADR. Its other decisions hold.
- The Ticket close (ADR 0031) and the Consultation close share one key. The
  dispatch resolves it per section: the Ticket section closes the work
  cycle of the selected ticket, the Consultation section closes or confirms
  the close of the selected Consultation.
- The Key guide and the Action bar state Close on `w` in both sections,
  from the shared catalogue.
- The confirmation body's environment split keeps the surviving resources
  honest: a live-worktree close never states that a worktree stays, because
  it keeps the operator's own checkout.
