# ADR 0038: Enter answers a Consultation with the surface its state needs

Status: accepted
Date: 2026-09-20

## Context

Enter carried two meanings in the Consultation section: the response on an
`awaiting-response` record, and Agent interaction on a `working` or a blocked
one. Every other state answered the key with the response control's reason, so
an operator holding a broken Consultation read "only an awaiting Consultation
can receive a response" over a record that could never answer that.

The recovery itself already existed, but it reached the operator through three
unrelated keys: `r` retried an interrupted opening, `c` opened the Replacement
launcher over a `missing` or a `failed` record, and `w` opened the close panel
whose `closing` shape carries the Retry and the Force-close (ADR 0037). Each
one worked, and none of them was discoverable from the key the operator
already presses to make a Consultation do something.

The Ticket section had already settled this shape: Enter means the thing the
selected record's state asks for - Hand off on an open Ticket, Decide on a
settled one, the Live view on an in-flight one - and the shared catalogue owns
the resolution, so the Action bar, the Key guide, and the dispatch cannot
disagree.

## Decision

**Enter answers every Consultation state with the surface that state needs**,
and the catalogue owns the resolution:

| State | Enter |
| --- | --- |
| `working` | Interact, unchanged |
| `awaiting-response` | Respond, unchanged |
| `awaiting-response` with a blocked Agent | Interact, unchanged |
| `opening` | the recovery panel: Recover, Close |
| `missing`, `failed` | the recovery panel: Replace, Close |
| `closing` | the existing close panel: Retry, Force-close, Cancel |
| `closed` | a refusal: the selected Consultation is already closed |

**The recovery is one new control with one panel module.** `Recovery` joins the
two live `return` controls in the shared catalogue, so the bar, the guide, and
the dispatch read one source. The panel's copy lives in
[consultation-recovery-panel.ts](../../src/components/consultation-recovery-panel.ts)
beside the close panel's, and the record's state names its rows, so the panel
cannot offer a choice the record denies. It renders through the same shared
`ActionPanel` the close and delete confirmations use.

**The panel runs the existing operations; it stores nothing.** Recover calls
the same recovery `r` calls, Replace takes the same path `c` takes onto the
Replacement launcher with the durable recovery context and the link to the
replaced record, and Close calls the same close path `w` calls, so a live Agent
still confirms and a record with no Agent still closes directly. A `closing`
record does not get a second recovery screen: Enter opens the close panel that
already holds its rows.

**The `closed` refusal comes from the catalogue's order, not from a screen.**
`Recovery` is the first `return` candidate in the Consultation section: a live
record still resolves to an available Respond or Interact, and a record with no
available Enter meaning reads this control's reason. A refusal an operator can
act on beats a reason that belongs to a different state.

The considered alternatives:

- Keep Enter silent on a broken record and leave recovery to `r`, `c`, and `w`.
  Rejected: the operator presses Enter on a stuck Consultation because they
  want it to move, and the answer they got named a state they were not in.
- Run the state's recovery directly on Enter, with no panel. Rejected: the same
  key would then destroy a record on a `failed` row and resume an Agent on an
  `opening` one, and neither choice deserves a single unconfirmed press.
- Draw one panel for `closing` as well. Rejected: the close panel already
  carries the retry and the force-close, and a second screen for the same
  decision is a second thing to keep honest.

## Consequences

- The Consultation section has three meanings of Enter, and the Key guide names
  all three: the guide row for the new control states the recovery meaning, and
  the gallery's examples hold the recovery panel's states, drawn from the
  production module.
- The Action bar and the Key guide name the row `Enter Recovery`, and the guide
  states what it opens, so it cannot be taken for the `r` recovery of an
  interrupted opening.
- A recovery panel that loses its states releases itself and says so on the
  Message line, the way the close panel does: a panel that paints nothing must
  not keep holding the keys the panels swallow.
- `r` stays the direct recovery of an interrupted opening and `c` stays the
  direct Replacement: the panel is the discoverable route, not the only one.
