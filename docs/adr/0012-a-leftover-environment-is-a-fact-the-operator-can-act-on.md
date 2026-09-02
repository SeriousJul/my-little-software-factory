# ADR 0012: A leftover environment is a fact the operator can act on

Status: accepted (supersedes the last consequence of ADR 0011 in part)
Date: 2026-09-02

## Context

ADR 0005 ends a work cycle at close, and the Close cleanup then removes the
herdr environment that cycle started. For a worktree handoff that cleanup runs
`herdr worktree remove --workspace <id>`, and herdr refuses a dirty checkout
without `--force`. The control plane keeps the state transition and warns on
the message line (issue #7), so the cycle closes while the workspace, its
pane, and the agent in it stay alive. A live-worktree handoff can leave the
same shape behind when its `tab close` fails.

ADR 0011 made the case that matters most visible: an agent in that pane that
herdr reports `working` or `blocked` is reclaimed, so the ticket runs again.
It left the rest open, and the rest is a dead end the operator has to work out
in herdr. The agent that only reports `idle` reclaims nothing, so the ticket
rests `open`, and its herdr agent name is still held by that leftover agent:
the name comes from the ticket's own title. Every new handoff of that ticket
then fails, and the reason for it is herdr's:

```
{"error":{"code":"agent_name_taken","message":"agent name close-the-mutation-testing-gaps is already used; candidates: terminal_id=... pane_id=wE8:p1 workspace_id=wE8 tab_id=wE8:t1 cwd=... status=Working"}}
```

Observed on ticket #22: cycle 1 auto-closed at 15:06 over a dirty checkout, the
cleanup failed, and the manual re-handoff at 15:53 failed with that reason.
The failed attempt is durable and readable, but the operator has to find the
leftover pane in herdr and close it by hand. The control plane already knew
both facts: it recorded the pane of the handoff whose cleanup failed, and it
read the name from the same title.

The considered alternatives:

- Reuse the leftover workspace and start the new agent in a fresh tab in it,
  the way a workflow handoff and a restart already do. Kept, but not
  sufficient by itself: the worktree handoff already reuses the workspace herdr
  still holds, and the start still fails, because herdr refuses a second agent
  with the name the first one holds.
- Give every handoff a distinct herdr agent name. Rejected as the whole answer,
  for the reason ADR 0011 gave: it hides the leftover instead of showing it,
  and here it would also break the one handle the operator knows an agent by.
  Taken in part, as the fallback that only a collision reaches.
- Refuse the handoff until the operator clears the leftover. Rejected: it keeps
  the ticket unworkable over a resource the control plane can start beside, and
  it is the state today.
- Force-remove the leftover workspace when a handoff needs the name. Rejected:
  the checkout is dirty, and discarding someone's uncommitted work is never the
  side effect of an unrelated action.
- Report the failed cleanup as a message line only, as today. Rejected: the
  line fades, the fact does not, and the ticket's next handoff fails on it.

## Decision

A leftover environment of a ticket becomes a durable, visible fact with one
action, and it never blocks a handoff of that ticket.

**The fact.** A handoff row carries the environment of its work cycle that is
still alive in herdr: the readable reason the control plane knows it (herdr
refused the removal, or a new handoff found its own name held), when it learned
that, and when the operator cleared it. The Close cleanup records it on every
path that runs it: the operator's Close, an Abandon, and the automatic close in
the observation loop. A handoff that meets a name collision with its own
leftover records it too, so the fact exists even when no cleanup ran, as after
a crash between the decision and the cleanup. The ticket's newest unresolved
fact is `leftover`, and it shows in the list row and in the detail pane: which
workspace, tab, and pane still live, since when, and what the operator can do.

**The action.** One control, `w`, on a ticket that holds the fact. It retries
the Close cleanup of every leftover environment of that ticket, and herdr's
`--force` is a separate row the operator chooses: a forced removal discards a
dirty checkout and stops the agents in the workspace, so no automatic path ever
passes it. The git branch is never touched.

A cleanup reaches the environment its command names: a worktree removal closes
a whole workspace, and a tab close closes the tab with every pane in it. So a
clear refuses any leftover that names a handle the ticket's own live agent
works on - that workspace, that tab, or that pane - and its answer says which
of the three it refused. A reclaimed agent leaves the same handles on two
handoff rows (ADR 0011), which is the shape that makes a tab leftover as
dangerous as a workspace one. The operator closes the live cycle first, and its
own cleanup ends the leftover with it.

**The seat.** One handoff runs at a time, and a herdr environment change is
the same kind of work. A clear holds the seat for all its cleanups, refuses
while a handoff is in flight, and refuses while another clear runs. The Close
cleanup of any path takes the seat too when it is free, and never waits for
it: the cycle it closes has already ended, so a cleanup held behind a handoff
would only delay the fact the operator sees. A handoff the operator starts
beside an environment change queues behind it, so no agent is built in a
workspace herdr is taking away, and no removal of that ticket reaches under a
new agent.

**The reach.** A cleanup that succeeds clears the facts it ended, and only
those: the facts that named the workspace it removed, or the one that named the
tab it closed, or - when herdr gave it no command to run at all - the fact of
its own handoff row. Facts outside that reach stand, because one row's close
says nothing about another row's environment.

**The handoff.** A handoff does not fail on the ticket's own leftover name. The
stable name is still the one it asks for; when herdr says the name is taken and
the pane or workspace that holds it is one the control plane recorded for this
ticket, or the ticket already carries the fact, the handoff starts under the
same slug with its work cycle (`<slug>-c<cycle>`), and under that name with its
ordinal in the ticket (`<slug>-c<cycle>-<ordinal>`) when two handoffs meet the
collision. That ordinal is the ticket's handoff count plus one, across every
cycle: it only grows, so no two handoffs of one ticket share it. The suffix
always survives the cut to herdr's 32-character limit, so a cut name still says
which cycle and which handoff it belongs to. The cut alone does not keep two
names of one ticket apart: a slug whose own tail spells `-c<cycle>` rebuilds the
stable name under it. So the candidates are built together, and a candidate
that would repeat an earlier one is dropped (see `ticketAgentNames`); a handoff
always keeps two names to ask for, because a cycle name and its ordinal name
never meet. The handoff reports the name it got, the started name is stored with
the handoff, and the completion trace of that turn names the agent that actually
ran. When a later candidate fails herdr for another reason, the failure reports
that reason rather than the collision an earlier name met, and the leftover the
handoff did meet stays recorded. A name held by an agent the ticket never
recorded is not this handoff's to take: the attempt fails, and the reason names
the holder's pane and workspace and says it is no agent of this ticket.

## Consequences

- The ticket's next handoff starts in every case the leftover can start in. The
  operator no longer works out in herdr that a pane of the same ticket blocks
  it, and the herdr reason is never the only clue.
- The leftover survives a new handoff, so the fact stays on the ticket until
  someone clears it: the message line is no longer the only place it appears.
  A stale fact is possible the other way too - a workspace closed in herdr by
  hand leaves the record standing until a clear or a Close cleanup resolves it.
- Two agents can live in one worktree checkout: the leftover one, and the one
  the handoff started beside it. Only the second is tracked: the observation
  keys on the pane of the ticket's latest handoff (ADR 0006), so a leftover
  agent the operator re-prompts after the new handoff is not reclaimed. The
  visible fact and its action are what keep that window small.
- herdr's `agent_name_taken` message is read for the holder's pane and
  workspace. It is a herdr 0.8.2 format, and the fake-runner tests pin it. When
  herdr changes it, the collision degrades to a reported failure with herdr's
  own reason, unless the ticket already carries the durable fact, which needs
  no message to act on.
- The herdr name the operator sees in the control plane can say a different
  cycle from the one they expect. The status line and the detail pane both say
  so while a leftover of the ticket stands.
- The seat makes an environment change wait for a handoff, and a handoff wait
  for an environment change. A queued handoff runs when the cleanup settles,
  and the durable state is re-read before it runs, so the wait cannot start a
  ticket that moved on. A clear that meets a taken seat reports it and does
  nothing: the operator presses the key again.
- A stale fact can survive its own environment the other way too: a handoff
  that recorded no handle can end nothing in herdr, so its close clears only
  its own row. Facts of other rows stand until a cleanup reaches them, and a
  clear reports what herdr refused when it will not.
