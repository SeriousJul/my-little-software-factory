# ADR 0135: The Quality audit counts the test suite's duplication as its own metric

Status: accepted
Date: 2026-10-09

Records that the Quality audit runs jscpd once per duplication scope, that the `test` scope
stands as its own metric `test-dup` beside the `duplicates` metric ADR 0120 settled, that one
`.jscpd.json` serves both runs, that the baseline holds one count per scope, and that the
suite's 282-clone backlog is made visible by this change and not lowered by it. It adds one
metric, one baseline count, one jscpd run, and one row in the payload. It adds no tool, no CI
step, and no seam.

## Context

ADR 0120 adopted the jscpd scope `src scripts bin` and kept `test` out of it: "Tests stay out
of the scope for the measured reason above." The measured reason was the flood at a loose
threshold - 3,022 clones at 35 tokens across the whole tree - and the threshold at 100 tokens
keeps the detector's teeth while leaving a backlog one agent can clear.

The scope the audit reads is the smaller of the two bodies. Measured at head `3f5c7662` with
the pinned jscpd 5.4.0 and the settings `.jscpd.json` holds (`minTokens: 100`, `minLines: 5`):
`src scripts bin` holds 0 clones, and `test` holds 267 clones across 5,098 duplicated lines,
4.44% of the suite. At the head this metric lands on, `498db20d`, the same run over `test`
holds **282 clones** across 5,657 duplicated lines, 4.92% of the suite's lines, and the
`src scripts bin` count stands at 0. At head `3f5c7662` the suite holds 62% of the
repository's TypeScript and JavaScript lines (114,719 of 184,848), so the ratchet
ADR 0121 settled does not reach the larger body.

The duplication is not incidental. It is the same fixture written again per file:
`stubCheckout` stands in 9 test files, `stubLiveHandoff` in 3, `seededApp` in 3, and 573 local
helper functions stand across 102 test files. A reviewer cannot see the count, an agent
working the inner loop is never told about it, and the Quality baseline cannot ratchet what
it never reads. Issue #360 asks for the count.

## Decision

**The audit runs jscpd once per duplication scope, and each scope stands as its own count.**
The run over `src scripts bin` stands exactly as ADR 0120 settled it. A second run over
`test` joins it. Each run writes its JSON report into its own subdirectory of the one temp
directory the run makes outside the repository, and the temp root is removed in the same
`finally`. Nothing is written inside the worktree.

**The new metric is `test-dup`, standing directly after `duplicates` in the metric list.**
The payload pads the metric name to 14 columns, so a name has 13 usable characters;
`test-dup` is 8. The alternative, `test duplication`, is 16 and would widen the column and
move every existing count line and the line patterns that read them. The kebab spelling
matches the existing `.quality.json` keys (`finding-cap`, `changed-base`). The metric list
order drives the payload order, so the new count line prints beside the one it mirrors.

**The baseline holds one count per scope, and each ratchets on its own.**
`.quality-baseline.json` gains `test-dup`, holding the count measured on the head the metric
lands on: 282 at head `498db20d`, with the pinned jscpd 5.4.0. The count is not written as
zero, and it is not written as a target. The ratchet holds both ways for each count: above
its baseline fails, and below it fails until the file is rewritten down in the same change.
A fix in `src` can never mask a new copy in `test`, and the `src` zero that issue #356 earned
keeps meaning what it says.

**One `.jscpd.json` serves both runs.** ADR 0121 refuses thresholds as flags the script
passes, and a per-scope threshold would need a second config file the tool cannot find on
its own. One settings file at `minTokens: 100` and `minLines: 5` keeps the two counts
comparable.

**The finding form does not move.** Each run's findings print as `path:line rule message`,
and the second run's paths resolve against its own scope as `test/<file>:<line>`, the same
form the existing run prints for `src/<file>:<line>`. The `--changed` narrowing reads a
duplicate finding's second block through its `also` field, so it narrows the new metric with
no change, and the counts stay whole.

**The coverage of the split is measured, not assumed.** Two scoped runs cannot see a clone
whose two blocks stand in different scopes. Measured at head `498db20d`: one jscpd run over
`src scripts bin test` finds 282 clones, exactly the sum of the two scoped runs (0 + 282),
and no clone spans the two scopes. The verification record states this as a measurement on a
head, not as a permanent property.

## Considered options

- **One widened scope over `src scripts bin test`.** Rejected: one run is cheaper and finds
  the same 282 clones today, but the baseline would hold one number. A fix in `src` would
  pay for a new copy in `test`, and the `src` zero that issue #356 earned would stop meaning
  what it says. This repository treats a count that blends two bodies of code as a claim
  that runs past the measurement, and the two scopes differ in clone density by more than
  the whole of `src`.
- **A second settings file for the test scope.** Rejected: a per-scope threshold would need a
  file the tool cannot find on its own, and a settings file the script passes is a threshold
  in disguise. One `.jscpd.json` keeps the two counts comparable.
- **Lower the 282 in this change.** Rejected: the metric lands green the way ADR 0121 landed
  the first baseline. The campaign that drives the count down is its own issue, in the shape
  of #350, which cleared 303 complexity findings and 11 clones to zero. It works one metric
  at a time, and its first moves are the shared fixtures the largest cross-file pairs name.
- **A cross-scope clone detector.** Not built: zero such clones stand at this head. The
  measurement is recorded beside its head, and a clone that ever appears is filed, not
  pre-built for.

## Consequences

The suite is in scope. A copy-paste in a test file is refused by a machine instead of by a
reviewer's patience, and the Quality baseline ratchets the suite's count the way it ratchets
`src`'s. The campaign that lowers the 282 starts from a number the audit prints, beside the
head it was measured on, with the largest clones and the cross-file pairs named in the
verification record.

The audit's cost rises by the second run, a measured fraction of a second inside the check
the push gate already runs, and the quality gate page's cost row is re-measured at the
landing head, because every number in this repository names the head it was taken at.

ADR 0121's path for a new metric is followed exactly: a row in `.quality.json`, a count in
`.quality-baseline.json`, and a test in `test/quality-audit.test.ts` that reads both back.
The baseline key set, the metric list, and both jscpd scopes stand pinned in that test, so
the new row cannot go missing. The quality gate page's metric-to-tool table gains a row for
the second scope, and its probe list gains two probes: one that plants a clone in `test`,
and one that proves the two counts move independently.

ADR 0120's scope sentence is amended in the shape that ADR already carries for ADR 0123: the
sentence is marked as superseded for the jscpd scope, and every other decision there stands.
The run ADR 0120 adopted is untouched, so this is an extension of the audit, not a reopening
of the decision.

CI gains nothing: `bun run audit` already stands as a step after `bun run typecheck`, and
the push gate keeps the four checks ADR 0105 and ADR 0121 settled. A jscpd version bump
shows up as a count that fails the audit, so the dependency PR carries the cleanup or the
baseline note.

Issue #360 is the spec for this change. ADR 0131 and ADR 0132 name it as the change their
campaigns measure against: the count lands first, so every later move is measured.
