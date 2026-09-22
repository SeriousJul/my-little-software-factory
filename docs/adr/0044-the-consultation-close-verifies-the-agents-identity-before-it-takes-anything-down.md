# ADR 0044: The Consultation close verifies the Agent's identity before it takes anything down

Status: accepted
Date: 2026-09-22

## Context

The operator closed a `missing` Consultation in the morning after a herdr
restart. The record's stored handles named the tab `wAR:t29` and the pane
`wAR:p29`. Herdr's restore had handed the same public ids to a restored
environment: the tab stood again, its pane was a bare shell, and the operator
ran the control plane in it. The Consultation's own Agent was not there; the
observation loop had already marked the record `missing`.

The close planned its cleanup from the stored ids alone. The topology probe
asked, "does the owned tab hold only the owned pane id?", and herdr answered
yes, so the close issued `tab close wAR:t29`. The id was exclusive and stale
at once: the pane the id named no longer held the Consultation's Agent, it
held the control plane's own environment. The tab close took the control
plane down with it, and the record died in `closing` with its resources
unconfirmed.

The defect was the guard. ADR 0043 established the identity rule for tickets:
a live agent belongs to a ticket by name, not by pane id, because herdr hands
a closed pane's id out again. The Consultation close had not received the
same rule: it verified the topology by id and trusted the result. ADR 0037
promised that a `missing` or a `failed` Consultation "holds nothing live that
should be stopped" and closes directly; the close kept issuing destructive
commands anyway, and the ids alone decided what they took down.

## Decision

**The close verifies the Consultation's own Agent before it may take anything
down.** Before the first destructive command, the close probes herdr's agent
list and matches the record's Agent in this order:

1. **The name the Agent runs under.** The name is the identity herdr
   enforces: it refuses to start a second Agent under a name a live Agent
   holds, so one named match is the record's Agent. A named match whose
   session contradicts the stored session, and a name held by more than one
   Agent, are ambiguous: the close takes nothing down and leaves the record
   in `closing` for a retry or a Force-close.
2. **The stored stable session id**, when this herdr omits names from the
   list. One session match is the Agent; more than one is ambiguous.
3. **The stored pane**, only when no Agent in the list reports a name: the
   weak match the observation loop uses, its `unverifiable` tier (ADR 0043).
   An Agent in the stored pane whose session contradicts the stored one is a
   foreign Agent, and the record's own is then absent.

**The close follows a verified Agent.** When the matched Agent's handles
differ from the stored ones, the close retargets the record's handles and its
owned resource rows to the Agent, then plans the cleanup from the environment
the Agent holds. It closes what the Agent is in, never what the Agent left.

**A missing Agent closes nothing.** When no Agent matches, the close issues
no destructive command:

- A record that began the close in `opening` is unverified, because the Agent
  may still be starting. The close takes nothing down and leaves the record
  in `closing` with a recovery warning; a retry or a Force-close decides it.
- Any other state retires the record: it closes with no command, records its
  owned resources as remaining, and leaves herdr untouched. The operator sees
  what stands, and the ADR 0037 promise holds: there was nothing to stop.

**An unverifiable probe is a recovery, never a blind close.** A failed or
unreadable agent list leaves the record in `closing` with a warning, the way
an unverifiable topology already does. A close that recorded no pane, a record
that never started an Agent, still closes with no command at all, as before.

## Consequences

- The close's first herdr call is an `agent list` probe whenever the record
  owns a pane. The probe is read-only; a close that retires the record issues
  exactly one command, the probe itself.
- A stale handle can no longer steer the close at a foreign environment,
  because the stored ids decide the plan only after the Agent is verified at
  them. A restored tab that reuses an old id holds a bare shell or a foreign
  Agent, and both answers close nothing.
- A Consultation whose Agent moved is closed where the Agent stands. The
  record's handles and resource rows move with it, so the close, the
  remaining resources, and the detail all name the same environment.
- An interrupted opening cannot be closed blind. Its close waits on a retry
  or a Force-close, and a Force-close on it records the environment it left
  standing instead of taking it down on an unverified id.
- The close and the observation loop now hold the same identity rule for
  Consultations: name first, session second, pane only as the unnamed tier.
  A herdr that reports names keeps the strong match; an older herdr that does
  not falls back in the tested order instead of trusting ids.
