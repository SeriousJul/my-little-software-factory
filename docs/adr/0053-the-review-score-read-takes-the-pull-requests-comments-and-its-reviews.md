# ADR 0053: The review score read takes the pull request's comments and its reviews

Status: accepted
Date: 2026-09-22

## Context

A transition branch tests a judgment (ADR 0027): the review score against
the configured threshold. The score judgment reads the verdict live at the
settle (ADR 0047): the plane issues one REST read of the pull request's
issue comments through the command runner, and the judgment decides on the
newest comment that carries the template's fixed score line.

The read took one posting path, and a review agent chose the other. A real
review turn on `SeriousJul/pi-extensions` PR #97 scored the pull request
97/100 and posted the verdict as a pull request **review** (`gh pr review`),
not as an issue comment. The settle's comment read found zero comments, the
score read answered null, neither score branch held, and the transition
recorded its no-fire: the pull request never wore `ready-to-ship`, the
machine offered no merge, and the ticket sat in `awaiting` on a turn whose
verdict the plane could see but could not read. A no-fire records nothing
the re-fire sweep re-fires (the sweep is bounded to the missing-pull-request
skip, ADR 0042), so the record stood until a human re-drove the cycle.

Both paths are on the record: a comment posts to the pull request's issue
timeline, and a review body posts to its review timeline. The template's
fixed line is the contract, and it stands in either body.

## Decision

**The score read collects the verdict records of both posting timelines
- the pull request's issue comments and its review bodies - and takes the
newest record that carries the template's fixed score line.** The fire
issues the two reads together, each with the source's host and the resolved
auth, gated like the score read: a transition that tests no score judgment
issues no read of either timeline.

**Each read fails open on its own timeline.** A read that fails, or answers
a list it cannot read, contributes no records, and the records that stand
decide. The score is null only when no standing record carries the fixed
line.

**The shipped review template's Outcome line names both paths.** The agent
posts its output on the pull request, as a comment or a review, and the
plane reads both. The fixed line and the newest-record rule are unchanged:
the newest record across both timelines is the verdict.

## Consequences

- A verdict posted through a review decides the judgment: the no-fire on a
  review-posted score is gone, and the turn that posted it routes the pull
  request to its state the way a comment-posted verdict does.
- A failed read on one timeline no longer voids the verdict on the other:
  the comment read that fails with the reviews standing still decides on the
  reviews, and the reverse.
- The fire's settle gains one read, gated like the read it joins: no branch
  that tests a score, no read of either timeline.
- The newest-record rule is across timelines: a comment and a review order
  by their timestamps, and the later one is the verdict, whatever the
  timeline it posted to.
- The template's Outcome line changes on shipped installs: an existing
  config keeps its own review template untouched, and the migration
  replaces only a seed-matched template, so no install's review prompt
  changes without its operator's hand.
