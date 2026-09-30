# ADR 0070: An operator mutes a source out of the factory's way

Status: accepted
Date: 2026-09-30

## Context

ADR 0060 gave the operator an act on one Ticket: `i` puts a ticket out of the
factory's way, and the flag blocks the machine's hand on that ticket alone. The
act does what it says, and the operator's ledger shows the shape of the work it
took: forty dependabot CVE alerts ignored in bursts, seconds apart, over several
days. The source that brought them, `my-dependabot-alerts`, spans the operator's
four repositories, and the per-ticket flag covers only the tickets that stood at
the moment of each act.

On 2026-09-30 a new alert from the same source, in a different repository,
landed unmarked. The top-up queued it at 03:14, the pickup started its agent at
03:30, and the operator read the event as "auto mode launched an item from the
hidden list": in their head the source was out of the way, and in the plane's
head forty tickets of it were. The plane did what ADR 0060 decided. The decision
lacked the source-level act the operator reaches for.

The one source-level lever that stood was the Removed source, and it is a Config
act: the plane stops reading the source, its open tickets leave the list, and
the removal is durable and shared. It is not reachable from the terminal, and it
is the stronger act - it stops the read. A Config rule that mutes a class of
tickets was already measured away in ADR 0060, and its reason stands: a class
rule is a statement to the config, and this is the operator's judgment on their
machine.

## Decision

**The mute is the operator's act on one source, and the flag is factory state.**
The act rides on a Ticket row, in both of the Ticket section's modes: it mutes
or unmutes the source the row's ticket came in on, and the Action bar names the
source it will act on. The flag and the moment it was set stand on the source's
row in the state file, beside the per-ticket flag on the ticket rows. The plane
writes nothing to the source: no config change, no label, no close. Nothing
clears the flag but the operator's own key or the source's removal from the
Config.

**The mute withholds the tickets, not the read.** A muted source keeps
refreshing, so its tickets keep their source facts fresh. The mute is a list and
gate act on the source's tickets, the way the ignore is one on a ticket's row:
it moves rows and blocks automatic starts, and it changes no fact of the source
or of a ticket. This is what keeps the mute apart from the Removed source: the
removal stops the read and is the operator's statement to the Config, and the
mute keeps the read and is the operator's judgment on their machine. When the
operator unmutes, the rows come back current.

**The mute is retroactive, and it reaches the tickets the source brings in
after the act.** Every ticket of a muted source - the ones it already brought
in and the ones to come - leaves the list while it rests and takes no automatic
start. The per-ticket flags are untouched: the pile stays the ledger of the
ticket acts, and an unmute takes no flag that the operator set on a row. A
ticket that stands in more than one source membership is withheld when any of
its sources is muted.

The gate is still the one predicate of ADR 0060 on the row a walk holds. The
facts the predicate reads widen from the ticket's flag to the ticket's flag and
the mute of the ticket's sources, and the state module folds the mute into the
row's facts in the one read the pile already takes per cycle. No walk gains a
second test, and none pays a second projection read: the four top-up walks of
ADR 0051, the route position read, and the restart walk all inherit the mute
the way they inherited the flag.

**The mute ends where an obligation begins, in the ignore's own shape.** The act
on the source takes no refusal, because it acts on none of the source's tickets
in particular: a source whose tickets all owe decisions is mute-able all the
same, and the mute simply does not touch the obligations. A ticket of a muted
source whose Agent works keeps its row beside its own marker, and one whose turn
settled keeps its row, because the operator owes it a decision and the row is how
they reach it. A resting ticket of a muted source leaves the list, and the row
wears a trailing `muted` marker beside the `ignored` one while the flag stands
on it and the row still shows.

At the moment the mute lands, the plane also settles what waits. Every Work
queue item of a ticket of the muted source is removed, and a removal settles its
routed ticket to `open` with an incremented cycle, the way the operator's own
removal already does (ADR 0069). A `queued` ticket of the source whose route
already died stands with no item to remove, and the mute settles it the same
way, so the mute leaves no ticket standing `queued`. A live ticket of a muted
source runs its handoff to completion, the way an ignored one does.

**The mute does not stop the operator's own hand.** A manual Handoff passes a
ticket of a muted source, a manual route from the Decision screen reaches a
position of one, and the pickup starts a queue item the operator asked for by
hand, the way ADR 0060 lets the operator's ask pass the flag. The block is on
the machine's hand alone.

**The `muted` view is the section's own key.** `f` cycles the Ticket section's
List filter through `active`, then `ignored`, then `muted`, then `all`. The
`muted` view is the ledger of the source acts, read over the projection that
stands before the list rule: every ticket of a muted source stands in it,
including the live ones whose rows the active view still shows - only the key on
the row ends a mute, and a ledger that hid the row would hide the key with it -
and including the covered ones ADR 0042 takes out of the list. The `muted` view
keeps the attention bands and the order the flat list holds, the way the pile
does. The Ticket header carries a conditional `muted n` cell above zero, with no
bell and no click, beside the `ignored n` cell. The counts, the held-count bell,
and the reads that resolve a Ticket by identity all keep ADR 0060's rule: the
counts and the bell read the active view, and a withheld row still names its
ticket wherever its identity is read.

**Removal wins over the mute.** When the operator removes a source from the
Config, the plane clears the mute on the source's row as it marks the source
removed and leaves its memberships. The stronger act wins, and a re-added source
comes back clean.

## Considered options

- **Per-ticket only, as ADR 0060 stands.** Rejected: this consultation is the
  incident it leaves. The operator's ledger shows the act happening in bursts -
  a source-level judgment performed ticket by ticket - and every new ticket of a
  muted-in-spirit source still reaches the top-up.
- **The Removed source alone.** Rejected: it is not reachable from the terminal,
  it stops the read the operator wants to keep fresh, and it is the statement to
  the Config where the mute is the judgment on the machine.
- **A mute that stops the source's refresh.** Rejected: it collapses the mute
  into the Removed source and loses the fresh rows the unmute brings back. The
  two acts stay apart on the read.
- **A per-repository mute.** Rejected: the source is the plane's own unit of
  read, refresh, and config, and the operator's batches track the source - every
  alert, in every repository it covers - not a repository of it. The evidence
  that opened this decision crossed the repository boundary: the operator
  expected an alert from a second repository to stand withheld by acts done in
  a first.
- **A dedicated source surface of its own.** Rejected: the plane holds few
  sources, and each names itself on the tickets it brought in. The row key and
  the ledger view give the act and its undo the reach the ignore already has,
  without a new surface the Key guide and the catalogue must carry.

## Consequences

- The state file gains the flag and the moment it was set on the source's row,
  and the migration follows the file's own rule: ask the file, not the stamp.
- The list rule in the ticket projection gains the mute beside the ignore
  (ADR 0060) and the covered rule (ADR 0042): three causes, one read, in the
  state module alone. The active view and the drawn rows withhold a resting row
  on any of them, the `muted` view reads the source flag over the projection
  before the list rule, and the `all` view keeps the rows the way it keeps the
  pile.
- The gate predicate's facts widen to the ticket's flag and the mute of the
  ticket's sources, folded in the state module's one read per cycle. Every walk
  of ADR 0051, the route position read, and the restart walk inherit the mute
  with no new test, and a muted ticket's resting row leaves the section's counts
  the way an ignored one's does.
- The act takes one of the letters ADR 0060 left free, and `u` is reserved
  here: the catalogue binds none of `b n o t u v y z` today. `u`, and the
  Ticket section's use of `f` over the new cycle, join the Control catalogue,
  the Action bar, and the Key guide in both Ticket modes, and the shared
  control's gallery gains the states a reviewer must see, exercised by the suite.
- The Work queue's refusal of `f`, a key two sections own, stands as ADR 0060
  left it.
- `CONTEXT.md` names the **Muted source**, and the **List filter** entry's
  Ticket cycle takes the `muted` view.
- `docs/operation/main-view.md` states current behavior, so it changes with the
  implementation and not with this decision.
