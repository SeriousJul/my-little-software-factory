# ADR 0088: The top-up moves open pull request tickets before fresh open tickets

Status: accepted
Date: 2026-10-02

## Context

The open-ticket walk of the auto top-up (ADR 0051) took the first eligible
open ticket in the list's order, and the open band of the list sorts by
ticket number ascending. The journey the pull request carries - the review,
the rework, the merge - stands on the pull request's own ticket, and that
ticket entered the walk like any fresh one. A pull request numbered above
the fresh issues of the day waited behind them on every cycle: the review
never ran, the merge never came, and the operator merged the pull request
by hand while the machine worked the new issues.

The read the walk stands on is not the gap. The settle-time fire already
pulls the pull request sources fresh before it fires (ADR 0076), and its
successful write converges the projection at once, so the pull request
stands in the list the moment its journey step exists, short of the
source's own index lag. The walk's order was the gap, not its read.

## Decision

**The open-ticket walk reads two groups, in the list's order inside each.**
The open pull request tickets stand in the first group, and the rest stand
in the second: the work the machine has started on a pull request moves to
the end before the machine starts work on a ticket it has not started. The
list's order holds inside each group, so the walk's answer reads in the
list's own words.

**The groups order the candidates; the gates still hold the tickets.** A
gate that holds one ticket holds that ticket only, the way every gate of
ADR 0051 does: the Same-type hold, the re-verify after a cycle end, the
handoff limit, and the ignore all rest the held ticket in place, and the
walk falls to the next candidate across the group line as well. A fresh
ticket never waits behind a held pull request.

**The walk's asks are unchanged.** A group's ticket resolves its ask the
way the walk resolved it: the merge ask of the ready position (ADR 0068),
or the handoff ask of the task profile. One item per cycle, and only into
an empty queue.

## Consequences

- ADR 0051's open-ticket walk is refined, not superseded: the
  continuation, restart, and open-ticket order stands, and the open-ticket
  walk now reads the pull request group before the fresh one.
- The list the operator reads and the walk the machine run agree on the
  group line: the pull request the machine is moving stands in the list,
  and the walk takes it ahead of the fresh ticket the list numbers lower.
- The source's index lag stays the one open slice: a pull request the
  search has not listed yet stands in no group, and the walk can take a
  fresh ticket in its name. The fire's forced refresh (ADR 0076) and the
  convergence close the slice in practice, because the pull request is
  older than the lag by the time its journey step fires.
