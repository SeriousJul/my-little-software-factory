# ADR 0016: The held turn gate and the Dispatch pause

Status: accepted
Date: 2026-09-02

## Context

ADR 0015 gives every settled turn a cause the agent's own record states. Today
the control plane treats a settled turn as finished work and moves on: in
auto-handoff mode it closes the cycle or routes the ticket, and it starts
whatever the next work is. A turn that settled `failed` - the build broke, the
API rejected the request, the context filled - is not finished work. The
control plane still treats it as such, and the operator is left to notice a
failure the record plainly recorded.

Two different failures the operator needs to see, each at its own scope:

- The **ticket's own turn** ended without completing. No automatic decision
  should run on it: the operator must decide the held turn, not have the
  control plane close the cycle on a failed build.
- A failure has happened and nothing has settled `completed` since. The
  control plane should not keep starting more agents into a condition it is
  already failing on.

## Decision

**The held turn gate.** A turn is held when its cause is `failed`, `aborted`,
or `truncated` and no decision has landed on it. `unknown` is never held; it
fails open (ADR 0015). While a ticket's latest turn is held, no automatic
completion decision runs on that ticket: the control plane does not close its
cycle and does not route it. The ticket rests in `awaiting`, shown held, until
the operator decides it. Once the operator decides the held turn, it is no
longer held, and the automatic flow resumes on the ticket's next turn.

The gate runs in auto-handoff mode and manual mode alike, because it is a
per-turn fact about the settled work, not about the mode. A manual operator
already decides every turn; the gate only adds the fact - the cause - to what
they see, and it holds the auto-close task types a manual operator might not
notice, like a `review` that fails.

The gate reads the stored cause of the ticket's latest completion. A turn
settled `completed` or `unknown` passes it and auto-decides exactly as before.

A held turn settles at once, without waiting out the Startup grace: the grace
defends against a silent idle that may still be booting, and a record that
names a refusal is not silent. A `completed` or `unknown` settle still waits
the grace out, so a booting agent's first idle report is not read as a turn
end.

The held badge, the `held` count on the attention line, and the detail-pane
warning show only while the ticket rests in `awaiting`. A held turn whose agent
reports working again reopens as it always does: the ticket leaves `awaiting`
for `running`, and the row shows its state badge, never `held` over an agent
that is visibly working. Its next settle overwrites the same trace, cause and
detail included.

**The Dispatch pause.** The pause is on when the newest held turn settled
`failed` and no turn has settled `completed` since it. It is derived from the
completion traces on every cycle and never stored, so it survives a restart
and cannot drift from the fact it describes. While it is on, auto-handoff mode
starts no agent by itself. It ends at the next `completed` settle, or the
moment the operator decides the held turn that started it.

The pause holds only the three automatic origins: the open handoff, the
workflow route, and the restart of a missing agent. It never blocks a manual
handoff, and it never blocks the operator's explicit close, goto, or route.

The pause is a state fact, not an auto-mode state. The open handoff and the
restart exist only in auto-handoff mode, where the pause holds all three
origins. In manual mode the one automatic start that still runs is the
auto-close types' route, and the pause holds it there too, exactly as the
Parallel limit already does: a full limit waits in awaiting in both modes,
because the auto-close type routes without the operator. A completed turn
that cannot route during a pause rests in awaiting with its trace undecided,
the way a full Parallel limit already leaves it, and the next cycle routes
it once the pause ends.

**Why hold rather than retry.** The control plane does not re-run a failed
turn. A failed build or a rejected request will fail again on a blind retry,
and the operator's decision - close it, go to the agent, reroute it - is the
fact only the operator can make. The held gate and the pause hold the work and
surface the cause; they do not guess the next move.

The pause reads only the ticket completion traces. A Consultation never
contributes to it and never enters the Parallel limit count, per ADR 0007: a
Consultation is a deliberately separate surface, and its failure must not gate
ticket work.

The considered alternatives:

- Retry a failed turn automatically. Rejected: it repeats the failure the
  record already recorded, hides the cause from the operator, and burns an
  agent slot on work that needs a decision, not a rerun.
- Store the pause as a flag the control plane clears. Rejected: a stored flag
  can drift from the trace that set it, and it would not survive a crash
  between the write and the clear. Deriving it from the traces makes it exact.
- Pause on every held cause, not just `failed`. Rejected: `truncated` and
  `aborted` are one agent's own pressure - a full context, an interrupt - and
  a local event. Holding every unrelated agent because one context filled
  would gate the whole factory on a local fact. Only a `failed` turn says the
  work itself is failing.

## Consequences

- A settled turn that failed, aborted, or truncated rests held in `awaiting`,
  shown as held in the ticket list, the detail pane, and the attention line,
  and its cause and detail named in the decision modal. The operator decides
  it instead of the control plane deciding for them.
- A `failed` turn with no `completed` settle since pauses the automatic open
  handoff, the workflow route, and the restart. The open handoff and the
  restart run only in auto-handoff mode; the route block applies in manual
  mode too, because the auto-close types route there. A manual handoff
  always starts.
- A turn the control plane could not read is never held: `unknown` fails open
  (ADR 0015), so a runtime that changes its record format holds nothing.
- The pause is never stored. It is recomputed from the completion traces each
  cycle, so a restart cannot lose it, and a decided held turn ends it in the
  same cycle the decision lands.
- ADR 0006 holds: the poll reads herdr and writes nothing to it. The cause is
  read, and the gate and the pause are derived, never provoked. ADR 0007
  holds: a Consultation never gates ticket work. ADR 0011 and ADR 0012 are
  untouched: the Reclaim rule and the Leftover environment fact are unchanged.
