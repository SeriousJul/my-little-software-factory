# ADR 0031: A work cycle can close while the agent is still working

Status: accepted
Date: 2026-09-18

## Context

A ticket's work cycle could only end from the Decision modal: the operator
pressed Enter on an `awaiting` ticket, read the turn log, and picked the Close
row. The state layer needs the settled turn's pending trace row to apply a
`closed` decision, so a ticket whose agent is still working - `handed-off` or
`running` - had no close at all. The operator's only routes to stop it were
the emergency exit, or the manual work in herdr that the emergency exit
warns about.

The two sections diverged on the shape of the action. A Consultation close
was a base-mode key with a confirmation dialog while the agent was alive. A
Ticket close was a modal row behind Enter, with no dialog of its own. The
`w` key in the Ticket section belonged to the leftover clear, the least used
control of the plane, which held the key this action wanted.

## Decision

**Key `w` closes the work cycle of the selected ticket, in both Ticket base
modes.** It is available on an in-flight ticket and on an `awaiting` ticket,
and it refuses on an `open` one: there is no work in flight to close.

**The close asks for confirmation whenever it stops a live agent, which is
every ticket state the close runs on.** The dialog is the shared
confirmation panel. Its first line states who is alive - the agent working,
or the turn settled - and the rest states what survives: the worktree
environment removes the checkout, a dirty checkout stays open as a leftover,
the live-worktree environment closes the herdr tab and keeps the checkout and
workspace, and the git branch stays in every case. The ticket returns to
`open` with the cycle incremented.

**An in-flight close is its own state operation.** The cycle ends, the ticket
moves to `open`, and no completion trace is written: the turn never settled,
so there is no cause, no turn log, and no message to record. The Close
cleanup runs exactly as it runs for the decision's close - the same commands,
the same seat, the same leftover recording when herdr refuses. The state line
gains the moves `handed-off -> open` and `running -> open`.

**An `awaiting` close is the decision modal's close.** It records the
`closed` decision on the pending trace, then runs the same cleanup. The
Decision modal keeps its Close row: it is the close with the turn log beside
it. `w` is the direct route to the same action.

**A close that meets an in-flight handoff of the same ticket queues behind
it.** The seat of ADR 0012 already serializes environment changes behind
handoffs. The queued close runs when the handoff settles, so a hung start
still ends in the close the operator asked for, and no cleanup runs under a
handoff that is still building its agent.

The considered alternatives:

- Keep the close in the modal and give it another key. Rejected: the
  operator must open the decision surface to stop the work, and the Ticket
  keeps diverging from the Consultation, whose close is one key deep.
- Reuse `abandoned` for the in-flight close. Rejected: abandon is the
  recovery of a missing agent, and it writes its own trace row. A close over
  a live turn is an operator decision, and the record should read closed,
  not abandoned.
- Write a completion trace row for the unsettled turn, with `aborted` as its
  cause. Rejected: the turn never settled, and a cause word asserts a fact
  about a turn that did not happen. The handoff row keeps the record of the
  work.
- Refuse the close while the ticket's handoff is in flight. Rejected: a hung
  start would leave the operator with no way out but the emergency exit, and
  the seat already makes the ordered wait safe.

## Consequences

- The operator stops an in-flight agent from one key and one confirmation.
  The emergency exit is no longer the only route, and the plane no longer
  needs the operator to reach for herdr mid-cycle.
- The state line reads `handed-off/running -> open` beside the settled
  path. The cycle number increments on the unsettled close, and the Handoff
  limit counts it like any other cycle end.
- The re-verify gate and the Same-type hold (ADR 0026) read the newest
  cycle-end decision and its cause. A cycle that ends without a trace row
  holds nothing and re-verifies nothing, the way an abandon row without a
  cause does. The gates must treat the absent row and the cause-less row
  alike.
- The `w` key leaves the leftover clear, which ADR 0032 removes.
- The Action bar and the Key guide state the new key from the catalogue.
  Close shows while the ticket is in flight or awaiting, and Goto, ADR
  0033, shows beside it while the agent's pane is alive.
