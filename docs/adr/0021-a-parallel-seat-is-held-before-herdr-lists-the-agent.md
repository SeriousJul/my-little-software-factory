# ADR 0021: A parallel seat is held before herdr lists the agent

Status: accepted
Date: 2026-09-14

## Context

The parallel limit bounds the agents that run, and the observation loop
counts them from the herdr list. The list lags the dispatch: a handoff
claims, prepares the environment, and starts the agent before herdr reports
the pane, and a started agent can take a further moment to appear. While it
waits in that window, the ticket holds no seat.

Measured against the dev state, an auto-handoff run with a limit of two
dispatched two handoffs in one cycle. At the next poll five seconds later
both were still in progress, both seats read free, and the loop handed off a
third ticket on top of the two in-flight agents. The limit was breached
every time the startup window outlived one poll interval.

The same window sat behind the missing rule: a started agent herdr has not
listed yet looks exactly like a dead one, and the loop would restart it and
start a second agent in the same workspace while the first still booted.

## Decision

**A seat is held from the claim, not from the listing.** Three facts hold a
seat: the in-flight tickets whose agent the poll listed; every handoff with
an unresolved claim, the in-progress ones; and the started agents inside the
startup grace (ADR 0017) that the poll has not listed yet. An in-flight
ticket none of those facts covers holds none, so the missing path can
restart it or end its cycle.

**A started agent inside the grace is not missing.** The loop does not
restart it and does not end its cycle: herdr's list is not evidence that a
just-started agent is dead (ADR 0017 keeps the same rule for the settle).
Past the grace, the missing rule applies unchanged.

The seat a cycle dispatches is also held for the rest of the cycle, so one
cycle never measures a later dispatch against a count that misses its own
starts.

## Considered options

- **Count only the listed agents.** The breach: every poll inside the
  startup window could hand out a full limit of extra agents.
- **Count every in-flight ticket.** A seat a truly dead agent holds never
  frees: the ticket's restart starves until the operator intervenes, and the
  handoff limit is spent on a dead pane.
- **A time window for the unlisted started agent.** Chosen. It self-clears,
  it reuses the constant that already names "a started agent is not yet
  trustworthy," and it costs at most one grace of restart delay.

## Consequences

- A cycle that dispatches up to the limit cannot exceed it while its own
  handoffs are still in progress.
- Restarting a dead agent waits out the startup grace, at most 30 seconds,
  instead of the next poll. The trade: the loop never double-starts a
  handoff herdr lost track of for a moment.
- A double start that does slip past the grace is still caught: the handoff
  name collision fails the second start cleanly.
- The observation loop reads the open handoff claims on every poll, one
  small query beside the in-flight list.
