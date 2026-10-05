# ADR 0107: A herdr Agent name held by a stranger is a fact on the Ticket, and the Top-up waits for the operator

Status: accepted
Date: 2026-10-06
Extends ADR 0098 (the stable Agent name every Ticket asks herdr for) and ADR 0012
(the fact the operator can act on). Amends ADR 0032 in one sentence: the Leftover
environment is the fact whose cleanup runs in herdr, and this is a second
herdr-held fact whose cleanup the plane owns none of.

## Context

ADR 0098 gives every Ticket one stable Agent name, derived from its identity and
its title, and the Handoff asks herdr for that name first. herdr holds one name
space across every Agent it knows, so the ask can be refused with
`agent_name_taken`. The dispatch already knows how to answer the refusal when the
holder is the Ticket's own: when the pane herdr names is a pane the Ticket's own
handoff recorded, the holder is a Leftover environment (ADR 0012, ADR 0032), the
Handoff takes its work cycle's name instead, starts, and the Leftover fact lands
on the handoff that owns the name.

When the holder is not the Ticket's own, the answer was a line and nothing else.
The start fails, the Message line carries herdr's refusal with the holder's pane
and workspace, and no fact stands anywhere: not on the row, not in the detail,
not in the record. The Ticket stays exactly where it stood, so the Top-up asks it
again.

Two brakes already bound that loop, and neither one fits this refusal.

The Attempt hold (ADR 0077 as extended by ADR 0101) releases when the Ticket's
active sources re-read it. A source read says nothing about a name herdr holds, so
the hold is one refresh of delay, and the next empty-queue cycle asks the same
failing start again.

The Failed-start park (ADR 0106) stops the loop at half the Handoff limit and
names the run. It is the right shape for a cause the operator has to go and fix,
and it is the wrong number for this one: the park has to count its way to half the
cap before it says anything, and a name collision is decided by the first ask. The
operator waits through five failed starts - or fifty, on a high cap - to learn that
a pane in workspace `w13K` holds the name, and the fact that arrives names a run of
starts rather than the pane.

The refusal also does not clear itself. The same ask meets the same line until a
human closes the Agent that holds the name in herdr. That is the difference from
every other failed start: the wait is for the operator, not for a source read or a
count.

The issue measured it on a real run: one Ticket, `#299`'s own reporter, asked for
its stable name, met `agent_name_taken` against a pane the plane had never made,
and re-asked until the Handoff limit ended its work cycle. The plane had named the
pane once, in a Message line that was gone before anyone read it.

## Decision

**The refusal leaves a standing fact on the Ticket: the Agent name collision.**
When a Handoff start asks for the Ticket's stable Agent name and herdr refuses it
with a holder the plane cannot tie to that Ticket, the Ticket carries the
collision: the name, the holder's pane and workspace when herdr named them, the
refusal's own reason, and since when. One row per Ticket, refreshed by the newest
refusal, held by the Handoff aggregate in `name_collisions`. The rule that decides
whether a holder is the Ticket's own stays the dispatch's existing one - a holder
its own handoff recorded is a Leftover environment, and everything else is a
stranger - so the two facts are decided by one branch and never for each other.

**The collision is not a Leftover environment, and a Leftover environment is never
it.** A Leftover environment is the Ticket's own workspace, tab, or Agent herdr
still holds, and its cleanup runs in herdr on the plane's request (ADR 0032): the
plane knows which handles to hand over, because its own handoff recorded them. The
collision is a name in a pane the plane never made, and the plane owns no cleanup
for it. The two facts wear different words on the row (`leftover` and `name held`)
and different lines in the detail, and neither read answers for the other.

**While the collision stands the Top-up adds no automatic start for that Ticket.**
The gate stands in the top-up's Handoff ask, `topUpAsk`, behind the Attempt hold
and ahead of the Failed-start park: the first brake waits out one failure for the
refresh, the collision holds while the operator's act is what is missing, and the
park stays behind it as the brake for a cause the collision does not name. Like
both, it gates the automatic adds only: the operator's confirm, the pickup's
claim, and a force-dispatch pass it.

**The fact says so on both channels, once for as long as it stands.** The record
names the hold in the voice the other walk holds wear (issue #223, issue #231) and
carries the refusal the attempt's own row stores:

```text
automatic walks hold: another pane holds the Ticket's Agent name ("Watch agent turns": the herdr name watch-agent-turns-1a2b3c4d is held by pane w13K:p1 in workspace w13K, which is no agent of this ticket: agent_name_taken)
```

The Message line states the same fact as a standing warning, once, and the Desktop
notification carries it (ADR 0080):

```text
agent name held: "Watch agent turns" (the herdr name watch-agent-turns-1a2b3c4d is held by pane w13K:p1 in workspace w13K)
```

The Message line names where the name is held, because that is the place the
operator has to go; the record carries the whole refusal, because the row, the
detail, and the record state one refusal and not three. The report is a memory of
the last statement, the way the park's line is: the collision is read on every ask
and a standing fact states itself once, not once per poll, and a cycle that reads
the Ticket and finds the fact gone retires the memory.

**The row and the detail name it.** The Ticket list wears a `name held` marker in
the lane the `leftover` marker already rides, and the detail states the pane, the
workspace, the name, since when, and what the fact holds. The fact comes from the
projection's one read per cycle, so a surface states it without a rule of its own.

**One operator act clears it, and it is the act the gate never holds out: the
Handoff the operator starts themselves.** A start that reaches its Agent asked for
the name and got it, so the collision leaves with it and the automatic adds resume
on the same rule, with no second act. A start that fails for another reason never
asked for the name, so it answers nothing about it and the fact stands. The
Ticket's own ignore, or the mute of one of its sources, is the operator's answer to
the refusal the way it answers a run of failed starts (ADR 0060, ADR 0070): the row
stops naming a fact the operator has already acted on, and taking the act back
brings the fact back as a new fact, stated once more.

**The fact is durable, and the stable name's state lives here.** ADR 0098 decided
what name the Handoff asks for and left the state of that name in herdr alone. This
decision owns the plane's half of that state: what the plane knows about its own
name being held, and for how long. The collision is on the state file, so the
operator may act in a later run and the fact is still there to be acted on.

## Options considered

- **Leave it to the Failed-start park.** Rejected: the park counts to half the
  Handoff limit before it speaks, and this refusal is decided by the first ask. The
  fact that arrives names a run of starts, not the pane that holds the name, so the
  operator still cannot tell what to close.
- **Retry under a different name, the way the Ticket's own Leftover environment is
  answered.** Rejected: ADR 0098's whole point is that the stable name is the
  Ticket's own, and the cycle name is the fallback for the Ticket's own leftover.
  Starting a stranger's name away leaves the Ticket's name held forever and gives
  the plane no way back to it.
- **Ask herdr to release the name, or close the holding pane.** Rejected: the pane
  is no workspace, tab, or Agent the plane made, and it may be another operator's
  live Agent. ADR 0032 already refuses the plane a cleanup of its own for an
  environment herdr holds; this one refuses it the act entirely.
- **Store the collision on the Handoff attempt row.** Rejected: the attempt is a
  ledger of starts, and the collision outlives the attempt that found it - the
  operator acts days later, and the fact belongs to the Ticket, not to one start.
- **Treat it as a Dispatch pause.** Rejected: ADR 0016's pause answers a Held turn
  the operator must decide on and stops the whole factory. One Ticket's held name
  must not stop the Tickets the factory can work.
- **Re-ask on a slower timer instead of holding.** Rejected: the wait is for a human
  act with no clock on it, and a timer is a second clock the plane has to keep
  while still saying nothing about the pane.

## Consequences

The glossary carries the Agent name collision beside the Leftover environment, and
the Handoff and Handoff attempt entries name it. The `name_collisions` table joins
the Handoff aggregate's owned tables at schema version 30; a v29 file gains the
table on the next open and holds no collision until a refusal writes one.

The `detail` field on a walk's candidate hold is new: a hold that stands on one
Ticket can carry the fact that decision names, and the one `automaticHoldLine`
builder owns the shape. The hold key stays the reason plus the candidate, so a
refresh that names a different pane is the same standing fact and states itself
once.

The collision gate runs before the park's gate, so a Ticket that carries both facts
names the collision. The park still stands behind it: an operator who ignores the
collision, or who clears it and meets a different failing cause, meets the park's
line on the next ask.

The screen-reader path for the new row marker and detail line is not verified: the
suite reads frames and the fact module, and no assistive technology ran against
either. The inherited-theme walks have not been re-run on this marker either (see
the shared-controls verification record).
