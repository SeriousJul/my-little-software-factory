# ADR 0060: An operator ignores a ticket out of the factory's way

Status: accepted
Date: 2026-09-24
Revised 2026-09-25: the first version of this decision lifted an ignore by itself, in a pass of the observation cycle beside the settle and the missing facts, and cleared the flag when it did. That lift is withdrawn here. The flag now stands until the operator's own key clears it, and the list rule reveals a row instead of unwriting a flag; see **The ignore ends where an obligation begins** and **The reveal is the section's own key** below, and the lift's entry in **Considered options**. The same revision names the gate once, `ticketIgnored`, states the identity reads' one projection read apart from the List filter's `all` view, and takes the `i` line from the read the act caused rather than from the flag's own fact. Every other decision in this record stands as accepted.

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
causes, one read, in the state module alone, and an ignored row leaves the
section's counts the way a covered one does. The gate is one predicate,
`ticketIgnored`, and it takes the flag and never the row's face. Three of ADR
0051's top-up walks call it on the row they hold - the continuation, the re-fired
skip on its position, and the open-ticket add - and the fourth, the restart walk,
reads the in-flight tickets rather than the list, so it asks the cycle's one read
of the pile, `ignoredTickets`, which is the same column by identity. The restart
walk needed the gate on its own terms: without it an ignored ticket whose Agent
went missing would take an automatic Restart, and the plane would start an Agent
on work the operator had just judged out. The open-ticket add reads the list with
the ignore's own withhold lifted, so its call is what holds the row out: no walk
leaves the gate to the view it happens to read.

The counts and the held-count bell read that active view, never the operator's
List filter. The machine's obligations and the section's numbers are facts about
the factory, so a cycle of `f` moves none of them and rings nothing, and the
rows the filter shows are the only thing the view decides. The same rule keeps
every read that resolves a Ticket by identity off the filter: a Work queue row
and the cancel line that removes its item, an open panel and the Live view's pane
read, a route's position, and a confirmed override share one projection read and
ask it for the whole projection that stands before the list rule, while the live
checkout's conflict name and the launcher's repository choices take the active
view. Neither follows the drawn rows, so a withheld row still names its ticket,
keeps its pane, and never tears down the screen that shows it.

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
decision, and the latest poll's missing Agent.

The ignore then hides a resting Ticket, and never a live one. An ignored Ticket
whose Agent works keeps its row because there is live work to reach - the row is
how the operator reaches the Live view, the Goto, and the Close - and one whose
turn settled keeps its row because the operator owes it a decision. The flag
stays set underneath both, so the row wears its `ignored` marker beside its own
state badge while the work runs, and goes back into the pile when the cycle ends
and the Ticket rests `open` again. This is ADR 0042's shape for the same reason:
the in-flight states are never covered, so live work stays listed whatever pull
requests exist, and the ignore withholds a row on the operator's judgment, not
on the machine's facts.

That is not a courtesy. The Dispatch pause reads the completion traces and asks
nothing about the list (ADR 0016), while the held count reads the list, so an
ignored Held turn would stall every automatic start behind a mode line that says
`paused` over an empty list with nothing to point at. Hiding a resting row and
revealing a live one is the one rule that keeps a stalled factory visible, and
it needs no write to do it: every obligation the refusal predicate names lives
on a Ticket that has already left `open`, so no obligation is ever out of the
list the counts, the bell, and the Decision region read. And because the flag
stands, the gate the walks read stands with it: an ignored Ticket whose Agent has
gone missing keeps waiting for the operator's own hand, cycle after cycle, and
the key that put it away is the key that puts it back in the machine's way.

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
presents the list's order and never a new one (ADR 0059). It is the ledger of
the flag: every row the operator put away stands in it, including one the active
view shows again while its work is live, and including one ADR 0042's covered
rule takes out of the list - a Ticket ignored first and covered by a fixing pull
request that appears later stands in the pile and in no other view, because the
only key that clears a flag rides on the row, and a pile that hid the row would
hide the key with it. An ignored row keeps its state badge and
takes a trailing marker beside the handoff-limit and leftover markers, and the
detail pane states the ignore, the moment it was set, and the key that clears it.
The Ticket header carries a conditional `ignored n` cell above zero, with no
bell and no click: the header's click already toggles the section, and the held
bell carries a fact the ignore cannot hold. It is the row's last cell for that
same reason: the row truncates at its end, so the held count and the bell that
rings on it stand ahead of it, and a view fact never cuts a decision the operator
owes. The `i` line says which of the two
the act did, and it says it from the re-read the act caused: a resting Ticket
loses its row, counts, and every automatic start, a live one keeps its row under
the flag, and a clear that leaves the row to ADR 0042's covered rule names that
rule instead of promising a row the list does not draw.

**An ignore is not a fold, and the two differ on purpose.** ADR 0058 keeps the
Group fold session-only, and ADR 0059 states its rule: a fold hides rows and
never facts, and the plane never lifts one by itself. The ignore breaks the first
half, deliberately. It hides a row *and* removes the ticket from every automatic
start, because taking the work out of the machine is half of what the operator
asked for; a mechanism that only moved the row would leave the top-up walking
over a ticket its operator had just judged out. It keeps the second half: the
plane never lifts an ignore by itself, because the flag is the operator's
judgment and only their key ends it. What the plane does instead is decline to
hide what the operator still has to reach: it withholds a resting row and reveals
a live one, and it says so on the row's own face. Both mechanisms still serve
ADR 0058's one rule, that the plane must not hide work the operator has not
seen. The fold keeps it by holding nothing across a restart and lifting nothing
on its own. The ignore keeps it by refusing to hold an obligation in the pile at
all. An ignored ticket that rests sits in no Group and is counted by no Group
header, because every axis reads the list the ignore has already taken the row
from: the axis slices the rows that show, the ignore chooses which rows there
are.

## Considered options

- **The lift: the plane clears the flag itself when an obligation appears.** The
  first version of this decision held it, in a pass that ran after the settle and
  the missing facts wrote theirs, so the row that came back was a flag the plane
  had unwritten and the cause could be named. It was measured away. A cleared
  flag no longer gates the restart walk, so in auto mode an ignored Ticket whose
  Agent went missing still took an automatic Restart one poll later, and the
  operator could not put the work away again, because `i` refuses a missing Agent:
  the one surface the obligation exists to keep was gone by the time it stood.
  The reveal in this decision costs no write, gates as long as the operator let it
  stand, and needs no ordering against the Top-up, because there is no pass to
  place.
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
  follows the file's own rule: ask the file, not the stamp. The step is version
  22, the two columns on the ticket row: ADR 0058's Grouping axis took version 21
  while this work was open, so the ignore lands behind it.
- The Ticket header's `open` count stops counting ignored tickets, so the counts
  no longer match the source's own list, on purpose. The `ignored n` cell is the
  only bridge, and it is a count, not a filter control. The count, the four
  pipeline counts, and the held-count bell all read the active view, so a cycle
  of the List filter moves none of them and rings nothing; only the rows the
  section draws follow the operator's view.
- The list rule lives in the state module alone: one read returns the drawn rows,
  the active view, and the pile, and no screen re-applies the covered rule or the
  ignore rule beside it. The pile reads the flag over the projection before the
  list rule, so it is the ledger of the operator's acts, and the drawn rows and
  the active view read it after the covered rule, so the list stays ADR 0042's.
  The gate is one predicate, `ticketIgnored`, read from the row a walk already
  holds or, for the in-flight rows that carry no flag, from one read of the pile
  per cycle, so neither rule costs a second projection read on a refresh.
- The missing-Agent fact is one rule too: one helper answers what the latest poll
  reports for a Ticket's pane, and the in-flight pass, the Restart walk, the
  Parallel limit seat count, and the list's failure badge all read it, so the
  obligation predicate, the badge, and the seat cannot drift apart.
- `i`, and the Ticket section's use of `f`, join the Control catalogue, the
  Action bar, and the Key guide in both Ticket modes.
- `f` now belongs to two sections, so the Work queue's refusal for it, which
  names the Consultation section alone (issue #85), needs words that hold for a
  key two lists own. This is the one place the feature makes an existing sentence
  untrue.
- An ignored Ticket still holds a Parallel limit seat while its Agent works,
  still refreshes, still fires its Transition at a completed settle, and still
  appears wherever its identity is named. The ignore moves the row; it changes no
  fact. The reads that resolve a Ticket by identity - a Work queue row and the
  cancel line that removes it, an open panel and the Live view's pane read, a
  route's position, and a confirmed override - share one projection read over the
  rows that stand before the list rule, and the Consultation launcher's repository
  choices and live-checkout conflict names take the active view, so none of them
  follows the operator's filter and a withheld row still names itself. A row a
  panel can stand on is never a withheld row, because each panel reads a state the
  list rule keeps listed: the frames that pin that read are the queue's row title
  and its cancel line, and no state separates the two sources for the panel and
  the pane read.
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
- The pile is the ledger of the operator's own acts, so the `ignored` view reads
  the flag over the projection that stands before the list rule, while the drawn
  rows and the active view both keep ADR 0042's covered rule. A Ticket that is
  ignored *and* covered therefore stands in the pile and in no other view: the
  covered rule takes it from the list, and the flag keeps it in the ledger. It is
  the one state where the two causes do not agree on one row, and it is settled
  for the operator's sake - a row the `ignored` view hides is a row the `i` key
  cannot reach, and only that key clears a flag.
