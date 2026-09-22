# ADR 0047: The pull request state judgment reads the source at settle time

Status: accepted
Date: 2026-09-22

## Context

A transition branch tests a Judgment (ADR 0027): the review score against
the configured threshold, and whether the linked pull request is still open.
The score judgment reads live: when a review turn settles, the plane reads
the pull request's comments through the command runner, and the judgment
decides on what the source says at that moment.

The pull request state judgment did not. It decided from the ticket's
projection: the membership's last refresh read the pull request's state, and
the fire took it. That projection is the last refresh's fact, and the GitHub
search index behind the pull request source still lists a merged pull
request as open for a while after the merge lands. A turn that merged the
pull request settles inside that window: the refresh at the fire's settle
still reads the pull request open, the `pull-request-open` branch holds, the
fire writes `needs-work` onto a merged pull request, and the machine derives
the rework position from the labels it wrote. The Decision screen builds its
offer from the fire's recorded outcome, so it offers the handoff of a task
no state offers: rework on a pull request that is already merged. This is
the recorded failure of issue #152 on the operator's own install: a merged
pull request still wearing `needs-work`, and a Decision screen offering the
rework handoff beside it.

## Decision

**When a branch tests it, the pull request state is read straight from the
source at the fire's settle.** The fire issues one REST read of the pull
request's own record through the command runner, with the source's host and
the resolved auth, the way the score read issues the comment read. The
record answers the judgment: a merged pull request, or one whose state is
closed, is not open; one whose state is open is open. The read runs only
when a branch of the transition tests the `pull-request-open` or
`pull-request-closed` judgment, the same gate the score read keeps for the
score judgment.

**A read that fails, or answers without a state the judgment reads, falls
back to the projection's fact.** The fire then decides on the last refresh,
the way it did before the read existed: the judgment still decides, and the
plane never blocks a settle on a source read it can answer another way. The
score read keeps its own path: the two judgments read from different places
in the source, the score from the pull request's comments, the open state
from its record, and each read belongs to its own judgment.

## Consequences

- A merge that lands while the turn settles routes nowhere: no judgment
  holds, the fallback branch fires, the write converges the machine's labels
  off the merged pull request, the position derives to the parking state,
  and the cycle closes in auto mode or waits in manual mode with no handoff
  to offer.
- A blocked merge still moves the pull request to rework: the read answers
  open, the `pull-request-open` branch holds, and the machine writes
  `needs-work` as before.
- A state-judgment transition's fire gains one read, gated like the score
  read: no branch that tests the state, no read. The fail-open fallback
  keeps the old behavior for a source that cannot be read at that moment.
- The Glossary's Judgment entry stands and is sharpened: the judgment is a
  fact read from the source at settle time, with the projection's last
  refresh as the read's fallback, never a stored verdict.
