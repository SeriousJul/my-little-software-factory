# ADR 0043: A live agent belongs to a ticket by name, not by pane id

Status: accepted
Date: 2026-09-21

## Context

The operator reported a ticket marked `running` whose Goto (key `g`) focused
a Consultation's pane instead of the ticket's own agent pane. The record held
the fact: the ticket's latest handoff recorded the pane id `wPJ:p1`, and the
agent herdr listed in `wPJ:p1` ran under the name
`consultation-27e1542c` - a Consultation's agent, not the ticket's.

The cause is herdr's pane allocation: it hands the id of a closed pane out
again. A ticket's stored handle names an id, not an agent, so a stale handle
can name a pane a different agent owns. Every attribution that trusted the
pane id alone adopted the foreign agent as the ticket's own: the reclaim that
runs a closed cycle's ticket again would have claimed the Consultation's agent
for the ticket, the in-flight poll would have settled the ticket's turn on the
foreign agent's reports, the Parallel seat count would have held the ticket's
seat for it, and the plane's Goto and missing facts would have read the
foreign pane as the ticket's live agent.

The agent name is the identity herdr already enforces: herdr refuses to start
a second agent under a name a live agent holds, and a handoff asks for the
name by candidate until one is free. The name the handoff started the agent
under is therefore a fact the handoff can record, and the name herdr lists for
a live agent is a fact the poll can read.

## Decision

**A live agent belongs to a ticket only when it runs under the name the
ticket's handoff expects.** The expected name is the name recorded on the
ticket's latest handoff, or, for a handoff without a recorded name - one from
before the column, or a Reclaimed handoff recorded before reclaims wrote the
name - the stable name the handoff asked for first, derived from the ticket's
title. The identity answers in three:

- `own`: the live agent runs under the expected name. It is the ticket's own
  agent, and every attribution that trusted the pane id before stands.
- `foreign`: the live agent runs under any other name. The ticket's own agent
  is missing from its pane, the way an empty pane is missing. The reclaim
  adopts nothing, the in-flight poll runs the missing path, the Parallel count
  holds no seat for the ticket, the awaiting poll does not resume the
  ticket's pending turn, and the list shows the failure badge.
- `unverifiable`: the reader cannot read either name - an older herdr that
  lists no agent name, or an expected name the record holds no title for. The
  pane keeps the trust the plane has always given it, except the reclaim,
  which moves the ticket to `running` and so fails safe: it reclaims nothing
  it cannot verify.

**The handoff records the name it started the agent under, and the reclaim
records the name of the agent it reclaims.** Every handoff this plane settles
stores the name, and a Reclaimed handoff stores the reclaimed agent's name, so
the next poll verifies the same identity instead of inheriting an unnamed
record. The state layer is the last gate: the reclaim refuses any name that is
not the ticket's own, whatever the caller believes.

**Goto gives the identity its own refusal (ADR 0033).** The base key refuses
an in-flight ticket whose pane holds a foreign agent, the way it refuses one
whose pane is empty. An `awaiting` ticket's recorded pane stands as ADR 0033
accepted it, except when the pane now holds a live agent that is not the
ticket's own: there the base key refuses, and the decision's and the Live
view's Goto rows refuse the focus with their own words, so no Goto in the
plane lands on a foreign agent's pane.

The considered alternatives:

- Keep trusting the pane id and let the reclaim settle it. Rejected: the
  reclaim moves a closed cycle's ticket to `running`, so a wrong adoption is
  a state corruption, not a display error. The operator's report was the
  display error the wrong adoption leaves behind.
- Match the live agent by its session id, the way a Consultation can.
  Rejected for the ticket side: the handoff records no session id of its own
  agent, and the id herdr lists is the agent's, not a handle the plane owns.
  The name is a handle the plane chose and herdr honors.
- Treat `unverifiable` as missing everywhere. Rejected: an older herdr that
  lists no names would read every live ticket as missing and restart them all.
  The pane keeps its standing where the identity cannot be read; only the
  state-mutating reclaim fails safe.

## Consequences

- A ticket whose pane herdr reused reads `missing`: the row wears the failure
  badge, the Live view opens the missing screen, and the operator restarts
  the ticket or abandons its work cycle from there. In auto mode the missing
  path restarts the ticket after the startup grace, the way it restarts a
  truly gone agent.
- The reclaim never adopts a Consultation's agent or any other agent's. A
  closed cycle's ticket stays open until its own agent is the one the pane
  holds.
- Handoffs from before the name column keep the pane's standing everywhere
  but the reclaim. Their expected name is the stable name derived from the
  title, which is the name the handoff asked for first.
- The plane's Goto can no longer focus a foreign agent's pane for a ticket, in
  any mode or surface. The refusal names the fact it read: the pane the
  handoff recorded is no longer the agent's pane.
- A Consultation still matches its agent by the recorded pane id, with the
  stable session id as its fallback (issue #24). The same reuse hazard stands
  for a Consultation whose pane id herdr handed out again; the ticket side
  holds this identity because the ticket's handoff records the name. Closing
  the Consultation side is open.
