# ADR 0033: Goto is navigation in both sections

Status: accepted
Date: 2026-09-18

## Context

ADR 0025 gave the Consultation its base-mode Goto, key `g`: it runs `herdr
agent focus` on the agent's pane, reports on the Message line, and changes
no Consultation state. "It is navigation, not a decision."

The Ticket side kept Goto one level deeper: a row of the Live view and of the
Decision modal, behind Enter. And the Ticket's Goto was not pure navigation:
it also moved an `awaiting` ticket back to `running`, a state move the
trace does not record. The state line already moves `awaiting -> running`
when the poll sees the agent working again on its still-pending turn, so the
explicit move was not load-bearing. What it did leave was two Goto behaviors
in the plane, and a key the Ticket section did not answer.

## Decision

**Key `g` is a base-mode control of the Ticket section, in both Ticket base
modes.** It is available on an in-flight ticket whose agent is alive in the
last poll, and on an `awaiting` ticket whose handoff recorded a pane. It
refuses elsewhere with the Consultation's own words: no agent is running on
an `open` ticket, and the agent's pane is not alive in the last poll when
the observation says it is gone.

**Every Goto in the plane is navigation.** The base-mode control runs the
same focus the modal rows run and reports the same confirmation, naming the
workspace when herdr has one. The Goto rows of the Decision modal and the
Live view drop the state move: the ticket stays where it is, `awaiting`
until the poll moves it or the operator decides, in flight while it is in
flight. The trace stays pending exactly as before, because a Goto was never
a completion decision.

The considered alternatives:

- Keep the modal Goto's state move and give the base-mode key the same
  behavior. Rejected: an idle, settled agent would read `running` for as
  long as the operator watches it, and one control would mean two things
  depending on where the operator pressed it.
- Make the Ticket Goto available on in-flight tickets only. Rejected:
  `awaiting` is exactly when the operator wants to look at the agent - the
  turn just settled - and the modal row already worked there.
- Leave the Ticket Goto in the modals and accept the asymmetry. Rejected:
  it is the asymmetry the operator asked to close, and the Consultation
  proof of the shape (ADR 0025) already stands.

## Consequences

- Goto is one key and one meaning in both sections: focus the agent's pane,
  change no record. The Action bar and the Key guide state it from the
  catalogue, in every mode it runs on.
- After a Goto from the Decision modal, the ticket reads `awaiting` until
  the agent works again. The badge is still true: the decision is pending,
  and the operator went to look, not to decide.
- The refusal wording is shared with the Consultation, so a key the
  operator learned in one section refuses readably in the other.
- The Live view and the Decision modal keep their Goto rows: the rows are
  the decision surfaces' own way to the pane, and the base-mode key is the
  way that does not open a surface.
