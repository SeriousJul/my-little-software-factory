# ADR 0120: Biome owns every quality metric of this repository

Status: accepted
Date: 2026-10-07

## Context

Issue #340 arrived as a guide for a SonarQube-like local stack: `tsc --noEmit`, ESLint with
`@typescript-eslint`, Semgrep for SAST, jscpd for duplication, and Lizard for NCSS, with one
JSON payload an agent reads after its edits. The scope settled during the specification: the
guide is a recipe for this repository only, and the control plane stays out of it. Each
repository the factory works decides its own gates, and no ruler knows better for everyone.

This repository already has a gate (ADR 0105): Biome for lint and format, `tsc` for types, and
the Bun test runner, run as the inner loop and the push gate. The guide's stack would put a
second linter over the same tree, and Biome 2.5 already owns the rules the guide asks for:
the `complexity` group holds `noExcessiveCognitiveComplexity`, `noExcessiveLinesPerFunction`,
`useMaxParams`, and `noExcessiveNestedTestSuites`, and the `security` group holds
`noBlankTarget`, `noDangerouslySetInnerHtml`, `noDangerouslySetInnerHtmlWithChildren`,
`noGlobalEval`, `noScriptUrl`, and `noSecrets`.

Every claim below was measured on head `b4c305e6` with Biome 2.5.14, TypeScript 7.0.2, Bun
1.4.2, and jscpd 5.4.0.

- `bun run lint` checks 312 files in 0.23 s and is clean; `bun run typecheck` runs in 0.44 s
  and is clean.
- The `complexity` rules are off today. Turned on at their defaults they report 133 cognitive
  complexity, 118 function length, and 30 parameter findings over `src scripts bin`, and 35,
  573, and 19 over `test`. The worst function in `src` scores 244.
- jscpd over `src scripts bin` finds 183 clones at 35 tokens, 77 at 50, 28 at 70, 11 at 100,
  4 at 120, and 0 at 150. Over `src test scripts bin` it finds 3022 clones at 35 tokens,
  17.80% of the lines.
- `noSecrets` at its default `entropyThreshold` of 41 reports 84 findings, and every one
  sampled is a false positive: a truncation marker, a `PRAGMA wal_checkpoint(TRUNCATE)`
  string, and SQL `INSERT` statements.
- CodeQL already scans this public repository. It reports 6 open alerts on `main`: three
  `js/incomplete-sanitization` in `scripts/screenshot-fixture.ts`, two
  `actions/missing-workflow-permissions` in `.github/workflows/ci.yml`, and one
  `js/identity-replacement` in `test/handoff-frame.test.ts`.
- `semgrep` is not installable as a pinned dependency: the official channels are pip, pipx,
  uv, and brew, and the npm wrappers download a native binary from GitHub releases at install
  time.

## Decision

**Biome is this repository's only linter, and it owns every metric the guide names except
duplication.** ESLint and `@typescript-eslint` never enter the tree. The guide's ESLint rules
map onto rules that are already in the dependency set and run in 0.23 s: `complexity` for
cyclomatic complexity, function length, and parameter count, and `security` for the
JavaScript and TypeScript danger patterns.

**The complexity rules turn on.** `noExcessiveCognitiveComplexity` keeps its default
`maxAllowedComplexity` of 15, `useMaxParams` keeps its default `max` of 4, and
`noExcessiveLinesPerFunction` runs at `maxLines: 50` with `skipBlankLines: true`. Cognitive
complexity and parameter count run over `src scripts bin test`. Function length runs over
`src scripts bin` only, and the reason is measured rather than assumed: `test` holds 573
findings at the default limit and still holds 52 at `maxLines: 300` with blank lines skipped,
because a frame test builds its fixture state and asserts a whole screen in one body.

**`noSecrets` stays on and is refined, not dropped.** Its one knob is `entropyThreshold`, and
the measured curve is 84 findings at the default 41, 15 at 45, 2 at 50, and 0 at 55. The
setting is 50, where the rule keeps its teeth: a planted GitHub PAT, a planted AWS key id, and
a planted random 32-character token all still fire, and the SQL strings that made the default
useless stay silent. The two findings left are answered where they stand: an `overrides` entry
with `includes: ["**/screen-font.ts"]` turns the rule off for the generated screen font table,
which the `font` script regenerates and which stays formatted and linted for every other rule,
and one `biome-ignore lint/security/noSecrets` suppression with its reason stands at
`test/handoff-frame.test.ts:2744`.

**jscpd 5.4.0 is the one new tool**, pinned as a devDependency so the audit never reaches the
network for it. Its settings live in `.jscpd.json` at the repository root, the file jscpd
reads itself: the scope is `src scripts bin`, `minTokens` is 100, and `minLines` is 5. That
threshold finds 11 real clones today, against 0 at 150, so the detector has teeth and the
backlog is one an agent can clear. Tests stay out of the scope for the measured reason above.

**Semgrep and Lizard stay out.** Semgrep cannot be a pinned dependency and cannot run offline
in a fresh worktree, which is the property every other check keeps. Lizard covers a metric
Biome's two rules already cover, and NCSS is a count no decision reads.

**CodeQL is this repository's SAST.** The Quality audit reads the code-scanning alerts through
one `gh api` call and reports their open count and paths, because that is where this
repository's real SAST findings stand. The read fails open to a fact line when `gh` has no
authentication, and it is the only network read in the audit.

**`bun pm scan` stays out** until a scanner package is real for this repository. Dependency
CVEs belong to Dependabot, which already opens the weekly PRs and auto-merges the safe ones on
a green CI.

## Considered options

- **ESLint beside Biome.** Rejected: two rule sets over one tree drift, the two disagree about
  the same syntax, and Biome already owns every rule the guide asks for.
- **Semgrep for SAST.** Rejected on the install shape, not the idea: no pinned dependency, no
  offline run, and rule packs fetched at run time.
- **`@ast-grep/cli` with rules of our own.** Rejected: the rule set becomes ours to write and
  keep, and CodeQL already reports the findings its rules find in this tree.
- **`bun pm scan` with an OSV or Socket scanner package.** Rejected for now: it duplicates
  Dependabot, and a config section is born only when a second real value exists.
- **Turn `noSecrets` off.** Rejected: a rule that cries wolf is refined first. The measured
  curve gives a setting where it fires on planted secrets and not on SQL.
- **Lizard for NCSS.** Rejected: the metric is covered, and the number drives no decision.

## Consequences

- The metric-to-tool map is one table on the quality gate page. A new metric either names a
  tool already pinned or adds one on purpose, with its cost measured at a head.
- A Biome version bump can add findings. ADR 0121 turns that into a baseline count a reviewer
  sees, not a wall of new errors.
- The audit's security row needs `gh` authentication and degrades to a fact line without it.
- The `overrides` entry is the pattern for generated data: the file stays formatted and
  linted, and one rule steps aside for it.
- The guide's ESLint and `.eslintrc.json` shape is refused in writing, so a later agent does
  not reintroduce it.
