---
title: Completion
description: "What happens after a turn settles: the completion trace, auto-handoff, held turns, and the Dispatch pause."
---

# Completion

## Completion and auto-handoff

The control plane polls herdr for its agents every
`agent-poll-interval-seconds`. The poll reads the agent list, and it reads
the last message of an agent that has settled its turn. It never writes to
herdr.

An agent can outlive the work cycle that started it: the Close cleanup cannot
remove a dirty checkout, and the operator can re-prompt a settled agent in its
herdr pane. The cycle is closed, so the ticket rests `open`, and the next
handoff of that ticket meets the herdr agent name the live agent still
holds. The poll reclaims it (ADR 0011): a working or blocked agent in the pane
of a ticket's last closed handoff records a handoff of the current cycle and
runs the ticket again, with a warning line that names the ticket. An idle, done,
or unknown report reclaims nothing. The reclaimed agent settles, awaits, and
closes like any other, and it holds a parallel slot while it works.

What the poll cannot reclaim stays as a fact on the ticket (ADR 0012): a Close
cleanup that fails, or a handoff that meets its own leftover name, records the
herdr environment that is still alive, and the ticket wears the `leftover`
marker until the operator ends the environment in herdr - the control plane
keeps no clear of its own (ADR 0032). That handoff still starts: it takes the
ticket's cycle name, and it works beside the leftover agent in the reused
workspace until someone ends it.

When the agent settles its turn (herdr reports it as done, or it is idle at
the end of the turn), the ticket moves to `awaiting`. The
completion trace records the task type, the agent, the Model, Thinking level,
and context window that handoff started with, the completion time, the last
message, the turn end cause, and the decision that ends the awaiting state. A
workflow handoff that follows an awaiting ticket renders its prompt with the
`{previous-message}` placeholder filled from that last message, so the next
agent reads what the previous one left behind.

A turn that settles `completed` fires the task type's Transition first
(ADR 0027), before any decision and in either mode: the plane writes the
transition's label facts on the ticket and on its linked pull request through
the command runner, and the [workflow machine](../configuration/index.md)
re-derives every position from the labels it wrote. The fire is idempotent,
so a second fire on the same labels writes nothing, and its outcome is stored
on the completion trace: the written facts, the failure when a write failed,
and the new position. No linked pull request is a visible fact on that trace,
and it is not retried.

In manual mode, `awaiting` waits for the operator. Enter opens the decision
modal, which states what the transition wrote and offers the handoff of the
position those labels derived, or the close of the cycle. Key `w` closes it
too, from either Ticket pane and behind a confirmation, without the turn log
beside it (ADR 0031): the two routes run one close, so they cannot drift.

The same key closes a cycle whose turn never settled. An in-flight ticket -
`handed-off` or `running` - has no settled turn to decide, so its close ends
the cycle with no completion trace at all: there is no cause, no turn log,
and no message to record of a turn that did not finish, and the handoff row
stays the record of the work. The ticket returns to open with its cycle
incremented, the Agent stops through the Close cleanup, and the closed cycle
counts toward the Handoff limit like any other. A close that meets a Handoff
still building its agent waits for it on the shared environment seat, so a
hung start still ends in the close the operator asked for.

Auto-handoff mode decides without the operator, within the configured
limits:

- A fired transition that carries `auto-advance` routes the task of the
	position it derived, while the parallel limit has room, in manual mode
	too. The handoff starts on the ticket that position sits on, which is the
	linked pull request when the written labels put the pull request in the
	machine. At the per-ticket handoff limit the route degrades to close, and
	a full parallel limit leaves the ticket awaiting until a slot frees. The
	route's `auto-handed-off` decision lands the same way the operator's does:
	only once the routed handoff has started the agent. A route that cannot
	start - because its Agent takes one of the settings its target Task
	profile names - records nothing on the turn, says why on the status line,
	and leaves the turn undecided, so the next poll can route it once the
	config or the panel fixes the pair.
- Every other settled turn closes: with auto-handoff on, the control plane
	closes a completion whose transition did not auto-advance, whose
	transition found no position, or whose label write failed. With
	auto-handoff off such a turn waits for the operator instead.
- Every eligible open ticket is handed off with the config defaults when the
	parallel limit allows it. The limit counts the live agents: the in-flight
	tickets in `handed-off` or `running` whose agent was alive in the latest
	poll. A blocked agent still counts; a missing agent holds no slot.
- The per-ticket handoff limit stops the close-and-rehandoff loop. When a
ticket reaches it, auto-handoff leaves it open. A manual handoff may pass
	the limit. A cycle closed with no trace counts toward it like a cycle
	closed by a decision, because the limit counts started handoffs.

Both limits gate auto-handoff only. A manual handoff is always allowed.

## Held turns and the Dispatch pause

The completion trace records the turn end cause beside the last message, read
from the agent's session record in the same read that gives the turn log
(ADR 0015): `completed`, `failed`, `aborted`, `truncated`, or `unknown`. The
readers know three kinds: `pi`, `codex`, and `claude`. Every other kind, a
missing or unreadable record, and a malformed record settle `unknown`, which
fails open and auto-decides exactly as it did before: the absence of evidence
is not evidence of failure. A record whose last turn-end event predates the
handoff is not this turn's end: it settles `unknown`, never `completed`.

An upgrade holds nothing. A trace that settled before the upgrade carries no
cause and reads `unknown`, so the factory does not freeze on install. The
accepted consequence: a turn that failed before the upgrade and is still
`awaiting` after it can still be closed automatically, because the control
plane holds no cause for it.

A turn that settled `failed`, `aborted`, or `truncated`, and that no decision
has landed on, is held (ADR 0016). No automatic decision runs on a held turn:
the control plane does not close its cycle and does not route it, in auto mode
or manual mode. The ticket rests in `awaiting`, shown held in the ticket list,
in the detail pane, and in the attention line, until the operator decides it.
Once the operator decides the held turn, it is no longer held.

A held turn that settled `failed`, with no `completed` settle since it, also
pauses the dispatch: while the pause is on, auto mode starts no agent by
itself. The pause is derived from the completion traces on every cycle and
never stored, so it survives a restart. It holds only the automatic origins -
the open handoff, the workflow route, and the restart of a missing agent - and
it ends at the next `completed` settle, or when the operator decides the held
turn that started it. It never blocks a manual handoff. The open handoff and
the restart run only in auto mode; the route block applies in manual mode
too, where an auto-advance transition still routes without the operator,
exactly like the Parallel limit. A Consultation never contributes to the pause.

Both cycle-end gates read the cycle that ended last, and a cycle that ended
with no trace row is one of them (ADR 0031). The re-verify gate waits for the
sources to re-read the ticket since a finished turn's close, because that
agent may have merged the pull request or closed the issue; a cycle closed over
an unsettled turn changed no such fact, so the absent row asks for no re-read
and holds no ticket. The Same-type hold reads the same row, and reads a
missing one the way it reads a cause-less one: neither says the work finished,
so neither holds the next handoff. An older cycle's finished turn is not this
cycle's fact, and never becomes the reason to withhold it.

A missing agent in auto mode restarts the handoff once, with the last
message as the previous message. At the per-ticket handoff limit, the
cycle is abandoned instead. When the agent is missing again, or the
parallel limit is full, the control plane stops: the `missing` badge stays
until the operator restarts or abandons from the missing modal. In manual
mode the control plane never touches a missing agent. Abandon ends the
work cycle, closes the handoff's environment, and returns the ticket to
open with its cycle number incremented.
