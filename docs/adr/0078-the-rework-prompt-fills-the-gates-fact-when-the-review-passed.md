# ADR 0078: The rework prompt fills the gates fact when the review passed

Status: accepted
Date: 2026-10-01

## Context

The `needs-work` state offers the rework task type, and a pull request
reaches it by two paths. The review posts a score below the workflow's
score threshold, and the review's feedback names the work. Or the review
passes, the merge position asks the plane action, the action blocks on a
merge conflict or a failing CI check, and the merge transition's
`pull-request-open` branch writes `needs-work` back (ADR 0068, ADR 0077).

The `{review-verdict}` fill of the rework prompt (ADR 0074) takes the
newest post that carries the fixed score line, on both paths. On the
blocked-merge path that post is the verdict the review already passed. The
fill hands the agent a passing score, the agent finds no required changes
in it, and the agent starts the turn without the fact that stands on the
pull request: the failure is in the gates, not in the review.

## Decision

**The fill decides the pass with the judgment's own rule.** The handoff
reads the workflow's score threshold from the config at the prompt render:
the `score-threshold` of the first task type whose transition tests a
score judgment, `undefined` when no transition tests a score. When the
standing verdict carries a score that stands at or above that threshold -
the `>=` the `score-above-threshold` judgment tests - the placeholder
fills the gates fact instead of the verdict's body: the review passed with
the score, the failure stands in the pull request's gates as a merge
conflict or a failing CI check, and the agent rebases the branch onto its
base and fixes what the gates report.

**Every other read keeps the fill it stood under before the threshold
joined it.** A score below the threshold fills the verdict's body under
its header, the way ADR 0074 states. A verdict with no score line, a read
that finds no verdict, a read that fails, and a config with no threshold
all keep their existing fills, so a template that references the
placeholder behaves as before on every config that names no threshold.

The read itself does not move: the same two timelines, the same newest
score-carrying-record rule, the same per-timeline fail-open. The fill
decides on the record the judgment would have decided on, one settle
earlier.

## Consequences

- The rework turn after a blocked merge starts on the right failure: the
  agent rebases the branch and works the gates, and it does not spend
  the turn correcting what the review already passed.
- The threshold stands on the config, so an operator's threshold edit
  reaches the next rework prompt with no migration: the judgment and the
  fill decide against the same number.
- A pull request a human labels `needs-work` by hand, with a passing
  score, takes the gates fact too: the plane cannot separate the blocked
  merge from the human's label, and the gates text sends the agent to
  check the gates either way.
- The `{review-verdict}` placeholder keeps one rule across both paths,
  and a config without a score-testing transition renders every rework
  prompt as it did before.
