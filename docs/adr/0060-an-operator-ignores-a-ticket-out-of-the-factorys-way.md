# ADR 0060: An operator ignores a ticket out of the factory's way

Status: accepted
Date: 2026-09-24

## Context

The ticket list carries work the operator has judged out for the foreseeable
future: an issue nobody will take, an alert the team accepted as a risk, a pull
request from a fork that stays open forever. Each one keeps a row, keeps its
place in the section's counts, and, with Auto-handoff mode on, stays a candidate
for the automatic top-up. ADR 0051's gates hold a ticket the machine has nowhere
to send, and ADR 0042's list rule withholds a ticket whose work sits in an open
fixing pull request. Neither answers "I have decided this one out", because that
is the operator's judgment, not a fact of the source or of the machine.

The obvious shape was a label write, since the Workflow machine reads labels and
a state that offers no task already stops the auto-handoff. The class rule that
would carry it does not reach every ticket source: a Dependabot alert, a security
advisory, and a secret scanning alert carry no labels of their own, and the plane
synthesizes severity onto them alone (ADR 0029), so a rule that filters a class
by label works on issues and pull requests and stands blind on the security
kinds.

## Decision

**The ignore is the operator's act on one Ticket, and the flag is factory
state.** `i` on a Ticket row writes the flag on the ticket identity in the state
file, and the same key on an ignored row clears it. The plane writes nothing to
the source: no label, no close, no comment. The flag survives every refresh, a
source that drops the item and brings it back, and a work cycle that ends and
starts again, and nothing clears it but the operator's own key. The cost is that
the fact belongs to one state file: another machine or a fresh file does not
carry it, and a teammate sees no sign of it.

**An ignored Ticket leaves the list and every automatic start.** The list rule in
the ticket projection gains the ignore beside ADR 0042's covered rule: two
causes, one read, and an ignored row leaves the section's counts the way a
covered one does. All four of ADR 0051's top-up walks gate on the flag: the
continuation, the re-fired skip, the restart, and the open-ticket add. The
restart walk needed the gate on its own terms: it reads the in-flight tickets
directly, not the list, so without it an ignored ticket whose Agent went missing
would take an automatic Restart, and the plane would start an Agent on work the
operator had just judged out.

**The ignore is an automatic gate, never a hard start gate.** It stands beside
the Same-type hold (ADR 0026) and the Dispatch pause (ADR 0016), not beside the
source health check the claim runs. The pickup and the force-dispatch both start
an ignored ticket's queue item, because the only item an ignored ticket can hold
is one the operator asked for by hand: the ignore itself removes any item that
already waited. A gate on the pickup would leave that ask with no way to start.

**The ignore ends where an obligation begins.** The key refuses a Ticket that
owes the operator a decision now: an `awaiting` one, one whose newest settled
turn is Held, or one whose Agent is missing. The refusal reads the facts the
row's own face reads: the ticket state, the newest settled turn's cause and
decision, and the latest poll's missing Agent. The plane withdraws the flag by
itself when an ignored Ticket starts owing a decision, its turn settling or its
Agent going missing, and the Message line names the cause that pulled the row
back. This is not a courtesy. The Dispatch pause reads the completion traces and
asks nothing about the list (ADR 0016), while the held count reads the list, so
an ignored Held turn would stall every automatic start behind a mode line that
says `paused` over an empty list with nothing to point at. An ignored Ticket
whose Agent works again returns as a row because there is live work to reach;
the flag stays underneath, and the row leaves again when the cycle ends.

**The ignore does not mute the operator's own ask.** A manual Handoff passes an
ignored Ticket, the way it passes the Handoff limit and the Same-type hold. The
Ticket section's `i` control is available in both of the section's modes, so the
detail pane reaches it the way every other Ticket control does.

**The reveal is the section's own key.** `f` cycles the Ticket section's List
filter through `active`, then `ignored`, then `all`. This is the Consultation
section's history filter's shape on the same key: one key, one meaning per
section, the way `w` closes work in both sections and `g` goes to the Agent in
both. The filter is one of ADR 0036's session view facts beside the history
filter: it says nothing about any Ticket, it starts on `active` at every boot,
and no restart brings the pile back on its own. The cursor keeps its ticket when
the cycle still shows that ticket. The ignored view keeps the attention bands and
the newest-external-update order and carries no order of its own, the way a Group
presents the list's order and never a new one (ADR 0059). An ignored row
keeps its state badge and takes a trailing marker beside the handoff-limit and
leftover markers, and the detail pane states the ignore, the moment it was set,
and the key that clears it. The Ticket header carries a conditional `ignored n`
cell above zero, with no bell and no click: the header's click already toggles
the section, and the held bell carries a fact the ignore cannot hold.

**An ignore is not a fold, and the two differ on purpose.** ADR 0058 keeps the
Group fold session-only, and ADR 0059 states its rule: a fold hides rows and
never facts, and the plane never lifts one by itself. The ignore breaks both
halves, deliberately. It hides a row *and* removes the ticket from every
automatic start, because taking the work out of the machine is half of what the
operator asked for; a mechanism that only moved the row would leave the top-up
walking over a ticket its operator had just judged out. And the plane does lift
an ignore by itself, when the ticket starts owing a decision. Both mechanisms
still serve ADR 0058's one rule, that the plane must not hide work the operator
has not seen. The fold keeps it by holding nothing across a restart and lifting
nothing on its own. The ignore keeps it by refusing to hold an obligation at all.
An ignored ticket sits in no Group and is counted by no Group header, because
every axis reads the list the ignore has already taken the row from: the axis
slices the rows that show, the ignore chooses which rows there are.

## Considered options

- **A label write plus a Workflow parking state.** Rejected: the ignore is one
  operator's judgment on one machine, not a statement to the team; the plane's
  write surface stays the settle-time fire and the recorded-skip re-fire
  (ADR 0042); and no label rule reaches the security kinds, which carry no labels
  but the severity the plane synthesizes (ADR 0029).
- **A Config rule that ignores a class of Tickets on sight.** Rejected for the
  same reach, and the judgment is per item: the class an operator judges out
  today holds the one item in it they want next week.
- **Ignore any state, absolutely.** Rejected: it hides the obligations the
  operator owes, stalls the factory behind an invisible Dispatch pause, and
  leaves a Missing agent with no surface for its restart-or-abandon. ADR 0042
  rejected the same shape for the covered rule on the same ground: the row is how
  the operator reaches the Live view, Close, Goto, and the decision.
- **Keep the row and mark it parked instead.** Rejected: the row is the pain, and
  a listed row stays a top-up candidate every walk has to be told about again.
- **Reveal the pile as a value of the Grouping axis (ADR 0058).** Rejected: the
  axis is single-valued, so reading the pile would cost the grouping the
  operator chose, and the flat axis value means the list as it stands, row for
  row, which a mechanism that removes rows contradicts. The axis slices the rows
  that show; the ignore decides which rows exist.
- **A second key for the un-ignore.** Rejected: one key whose meaning the row's
  own fact picks is how Enter already works, and a second letter is one more the
  Key guide has to hold.
- **Ignoring Consultations in the same act.** Rejected: a closed Consultation
  already leaves its list behind the history filter, and an open one is work the
  operator started and can still reach.

## Consequences

- The state file gains the flag and the moment it was set, and the migration
  follows the file's own rule: ask the file, not the stamp.
- The Ticket header's `open` count stops counting ignored tickets, so the counts
  no longer match the source's own list, on purpose. The `ignored n` cell is the
  only bridge, and it is a count, not a filter control.
- `i`, and the Ticket section's use of `f`, join the Control catalogue, the
  Action bar, and the Key guide in both Ticket modes.
- `f` now belongs to two sections, so the Work queue's refusal for it, which
  names the Consultation section alone (issue #85), needs words that hold for a
  key two lists own. This is the one place the feature makes an existing sentence
  untrue.
- A Work queue row for an ignored ticket must keep naming its ticket by title.
  The queue row reads the visible list today and falls back to the raw identity,
  so it needs the projection that stands before the list rule. That is a display
  fault of its own, and it should land whatever the ignore does.
- An ignored Ticket still holds a Parallel limit seat while its Agent works,
  still refreshes, still fires its Transition at a completed settle, and still
  appears wherever its identity is named. The ignore moves the row; it changes no
  fact.
- Nothing prunes ignored flags, and nothing needs to: the plane never deletes a
  ticket row today, so the flag adds no surface the rows did not already have.
- `docs/operation/main-view.md` states current behavior, so it changes with the
  implementation and not with this decision: the sentence that gives `d` and `f`
  to the Consultation section alone, the header's counts, the two new keys, and
  the list's two causes that take a row away.
- `i` is reserved here. ADR 0058 left the Grouping axis's key unnamed and no
  control catalogue binds `i` today, so whoever implements the axis takes a
  letter that is not `i`, and the same holds for the other free letters this
  plane still has: `b n o t u v y z`.
- `f` is one key with two section owners, Ticket and Consultation, and no third.
  The Work queue keeps its refusal, and the refusal's words must name a key two
  lists own rather than the Consultation section alone.
- `CONTEXT.md` names the **Ignored ticket** and the **List filter**, and the
  List filter entry keeps itself apart from the Grouping axis and the fold.
