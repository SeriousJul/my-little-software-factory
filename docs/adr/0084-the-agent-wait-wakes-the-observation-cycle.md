# ADR 0084: The agent wait wakes the observation cycle

Status: accepted
Date: 2026-10-02

## Context

ADR 0006's poll is the control plane's single observation of the agents,
and it lags every state change by up to one interval, five seconds by
default. The visible cost sits at the finish: an agent that ends its turn
waits out the rest of the interval before the plane settles the turn,
reads the trace, and offers the decision. Herdr offers a blocking
`herdr agent wait <target>` per agent that exits when the agent reaches a
requested state (idle, done, or blocked by default), so the finish can
reach the plane at the moment it happens instead of at the next poll.

## Decision

The poll keeps its standing as the single source of truth. On top of it,
every successful cycle arms, per in-flight ticket whose own agent the
probe shows working, one `herdr agent wait` on the agent's name, through
the command runner like every other herdr exchange. The until set is
pinned to idle, done, and blocked, not left to herdr's default. When a
wait exits with a state match, the loop runs a cycle now, and the settle
the poll would have made runs at once on the fresh list.

The arm rules:

- The arm is on the working report, not on the in-flight state. A booted
  agent reports idle before it picks up the prompt, and the wait matches
  the current state at once: an arm on the state would run a cycle at
  once, in a loop the poll interval never had. A working agent stays
  working until the turn ends, so the wait held from the working report
  blocks exactly until the settle.
- The wait targets the agent's name, the identity a live agent belongs to
  by (ADR 0043): a pane id is not an identity, and herdr hands closed ids
  out again.
- Only a state match wakes. A missing agent, a herdr failure, and a
  budget timeout are all unmatched: a wake on none of them would run a
  cycle that re-arms the same failed wait, in a loop. A failed wait is
  down, and the next successful cycle re-arms the still-working agent.
- The wait carries a command budget of fifteen minutes
  (`AGENT_WAIT_BUDGET_MS`). The budget bounds only the orphan: a wait that
  runs on after its ticket leaves in-flight or the plane stops, and a
  budget that runs out mid-turn is an unmatched wait the next cycle
  re-arms, so a long turn loses no wake.

The settle guards are unchanged: a wake runs the same cycle on the same
facts (ADR 0006), a settle still needs the turn to have demonstrably
started (ADR 0017), and the missing path keeps the poll's own pace. The
wait is optional on the reader interface: a reader without it leaves the
loop poll-only, and a herdr version without the command degrades to the
ADR 0006 standing without a failure.

## Consequences

- A finished turn settles at the finish, not at the next interval. The
  interval still bounds everything the wait does not cover: the missing
  path, the state corrections, and a wake that runs into a cycle already
  in flight.
- The plane holds one blocking `herdr agent wait` per working in-flight
  agent, bounded orphans of at most the wait budget. ADR 0006 rejected
  replacing the list with the waits; this decision does not: one list
  call still carries every agent, and the parallel limit counts it as
  before. The waits are a wake on the poll, not a second observation.
- A settle between the wait's exit and the woken cycle's list is a no-op
  the poll already owns: the wake is level-triggered on herdr's facts, and
  a missed or failed wake costs nothing the poll does not already stand.
