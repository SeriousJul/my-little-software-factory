---
title: The quality gate
description: The two loops a change runs through, the rules a review measures, and what the gate does not claim.
---

# The quality gate

This page states how a change is checked, and what a claim about a check has to
carry. [ADR 0105](../adr/0105-the-push-gate-runs-the-three-checks-on-the-merged-tree-and-a-hook-owns-the-two-cheap-ones.md)
records the decision. The rules below are the ones the reviews of pull requests
#222, #224, #227, #229, #233, and #300 had to ask for by hand.

## Two loops

The inner loop runs while the work runs. It is small on purpose: the full suite
after every edit is the cost that makes an agent skip a check.

| Command | What it covers | Measured cost |
| --- | --- | --- |
| `bun run audit` | The type check, Biome, jscpd, and the code-scanning read, in the Quality audit's one payload | 1.0 s at head 30d603c4 (three runs: 1.04 s, 1.01 s, 1.09 s) |
| `bun test <file>` | The suite of the file you changed | 0.16 s for a static check over the tree; 13.8 s for the 22 frame tests in `test/action-bar.test.ts`; 21.9 s for the 58 in `test/consultation-frame.test.ts` |
| `bun run test:changed` | The test files the current changes can affect | near zero when nothing changed |

The audit stands in place of the separate `bun run lint` and `bun run
typecheck` runs an agent read after its edits; [the Quality
audit](#the-quality-audit) states its metrics, its baseline, and its cost by
component. The scoped run is the part that moves: a unit file costs a fraction
of a second, and a frame file that boots the real renderer costs 14 to 22
seconds. That is still far below the full suite, and `bun run test` does not
belong in the loop either way.

## The Quality audit

`bun run audit` is the one command this repository runs to check itself
(ADR 0120, ADR 0121). It runs the type check, Biome over `src scripts bin
test` with the audit's config, jscpd over `src scripts bin`, and one `gh api`
read of the open code-scanning alerts, and prints one payload on stdout: a
status line, one count per metric, then the findings as `  path:line rule
message`. It runs no test suite, and it writes nothing inside the worktree:
jscpd's JSON report lands in a temp directory outside the repository and is
removed.

| Metric | Tool | Where the value stands |
| --- | --- | --- |
| Type correctness | `tsc --noEmit` over `src` and `test` | `tsconfig.json` |
| Lint and format | Biome `check` | `biome.json`, through `bun run lint` and the editor |
| Secrets | Biome `security/noSecrets` at `entropyThreshold: 50` | `biome.json` |
| Cognitive complexity | Biome `complexity/noExcessiveCognitiveComplexity`, default 15 | `.quality/biome.json` |
| Function length | Biome `complexity/noExcessiveLinesPerFunction`, `maxLines: 50`, `skipBlankLines: true`, off for `test/**` | `.quality/biome.json` |
| Parameter count | Biome `complexity/useMaxParams`, default 4 | `.quality/biome.json` |
| Duplication | jscpd 5.4.0, `minTokens: 100`, `minLines: 5`, over `src scripts bin` | `.jscpd.json` |
| SAST | CodeQL, read through one `gh api` call over the open alerts | the repository's code scanning |

No threshold stands in the audit script. `.quality.json` states the metric
list, the scopes, the finding cap (20), and the changed base (`origin/main`,
overridable with `QUALITY_CHANGED_BASE`), and `.quality-baseline.json` holds
one count per metric, beside the head it was measured on. Findings cap at 20
per metric, with one `and N more` line.

The baseline only shrinks: a count above it fails the audit, and a count
below it is rewritten down in the same change. Issue #350 is the campaign that
shrinks it, and a finding is never silenced to meet a count: a suppression
needs its reason beside it. A non-zero exit means the tree is worse than its
baseline: a type error, a lint error, a duplication clone above the baseline,
or any count above its baseline. The code-scanning read never fails the audit
on its own; a failed read prints its reason as a fact line. `bun run audit
--changed` lists only findings in files that differ from the changed base, and
never the counts, so the ratchet never reads a partial tree.

The counts stand at 168 cognitive complexity, 87 function length, 49 parameter
count, and 11 duplication clones at head 30d603c4, where the audit landed.
Issue #353 landed between the spec's measurement at head b4c305e6 and this
head, and it added the one function-length finding that moves 86 to 87.

Measured at head 30d603c4: the audit costs 1.0 s (three runs: 1.04 s, 1.01 s,
1.09 s), of which the type check is 0.42 s (three runs: 0.422 s, 0.424 s,
0.429 s), the Biome run is 0.21 s (three runs: 203 ms, 208 ms, 207 ms), and
jscpd is 0.04 s (three runs: 39 ms, 40 ms, 43 ms), plus one `gh api` call.

### The audit's probes

The probes the branch's tests claim, each re-run on the head that is pushed:

1. The duplication teeth: paste a block of at least 100 tokens that already
   stands elsewhere in `src` into a function of `src`. The `duplicates` count
   grows by one and the audit exits non-zero.
2. The cognitive teeth: raise one function's cognitive score past 15 by
   nesting an `if` in a body that already stands over 15. The `cognitive`
   count grows by one and the audit exits non-zero.
3. The ratchet: lower one count in `.quality-baseline.json` below the count
   the tree stands at. The audit exits non-zero and prints that count below
   its baseline.
4. The secrets rule: remove the `overrides` entry in `biome.json` that turns
   `noSecrets` off for the generated screen font table, `scripts/screen-font.ts`.
   The `secrets` count goes to 1 and the audit exits non-zero.

## The push gate

Exactly one full `bun run test` gates the push, and it runs against the merged
tree, in this order:

1. Rebase onto `origin/main`.
2. Check that a new ADR number is still free on the merged tree.
3. `bun run lint`.
4. `bun run typecheck`.
5. `bun run audit`, the Quality audit.
6. `bun run test`, once.
7. `bun run docs:build`, when the change touches `docs/`, `GLOSSARY.md`, or an
   ADR. CI runs the same build and blocks on it.

A branch that falls behind `origin/main` again during a rework round rebases and
runs the gate again. A suite result measured on a tree that is not the tree that
merges says nothing about the tree that merges.

`bun run mutate` stays outside the gate: a campaign costs hours
([ADR 0055](../adr/0055-mutation-testing-runs-on-the-bun-test-runner.md)).

## The hook

`scripts/git-hooks/pre-push` runs `bun run lint` and `bun run typecheck`, and
refuses a push whose branch is behind its remote-tracking branch. It reads the
ref the checkout already holds and fetches nothing.

A committed hook is not active by itself. It runs in a checkout that has set it:

```sh
git config core.hooksPath scripts/git-hooks
```

Do not bypass it with `--no-verify`. CI runs the same checks, and a bypass only
moves the failure to a red check on the pull request.

## A claim a document makes is a claim the code keeps

Every sentence written into `docs/`, `GLOSSARY.md`, an ADR, or a module header
that states behavior is re-read against the code path that produces that
behavior before the push. The reviews found the same finding on four of the six
pull requests: a page that says the header shrinks the mode cell first when the
code gives up the seat reading first, a header comment that stated a record
field backwards, a glossary entry that read as a pass through a standing row, an
operator page that promised a rule the write-back does not follow.

A rename sweeps the old name. `docs/`, `GLOSSARY.md`, the ADRs, and the
verification records are searched for the name that left the tree, and each hit
is updated or keeps the old name beside the probe it was measured under. Two
reviews found a verification record and the module map naming a name the branch
had already renamed.

A documented user-visible string has a test that reads it back: a record line, a
Message line, a config key, and the level or kind the reference states beside it.
`test/record-lines-doc.test.ts` is the pattern: it holds the configuration
reference's literal lines to the source that writes them. A documented line with
no test is how a record drifts, and a documented level no fake can tell apart is
the same drift one level down.

## What a check holds

Three checks read the repository's own prose and sources and refuse the drift a
review would otherwise have to find:

| Check | What it refuses |
| --- | --- |
| `test/record-lines-doc.test.ts` | a record line the configuration reference states that the code does not write, and a level the page states that the code does not send |
| `test/shape-doc-paths.test.ts` | a path `docs/agents/shape.md` prints that the tree does not hold, resolved against the entry that printed it |
| `test/domain-export-architecture.test.ts` | a `src/domain/` value export neither `src` nor a test asks for; a domain export that is a pure alias of another export of its own module; a domain type that neither side names, against a baseline that can only shrink and that stands empty since [issue #301](https://github.com/SeriousJul/my-little-software-factory/issues/301) answered its 14 names; and a baseline entry that states no reason |

The second rule is the one the #223 review found standing in that directory:
`topUpCycleOpen` was a wrapper of `freshWorkHold` with no `src` caller and nine
test callers, and a rule that only asks "does anything read this?" cannot see it.
The alias rule asks the shape instead, and it does not care whether it has
readers.

## A probe is a step a reviewer can re-run

When a change claims its test bites, the claim is written as steps in the test
header: what to change in the source, which records go red, and how many. Every
probe is re-run on the head that is pushed, and the counts are reported there.

#233 shows why the written form is required. Its first review found two probes no
reviewer could re-run; its second review found one of the two did not reproduce as
written, because the text named a line inside a shared helper instead of the
record it meant. The rework re-ran all five probes and reported each count.

A new pure rule module under `src/domain/`, or a rewrite of one, gets a scoped
mutation campaign, and the record names its scope and its score. For other work a
written probe set is enough.

## A test does not stand on wall-clock time

A test that reads real time, or that depends on a millisecond boundary, is
rewritten to drive the rig's pinned clock. A new timing test passes 10
consecutive targeted runs before the push.

The load-flake rule stands as it is: a file that fails in the full suite and
passes alone is a load flake, the report names it as one, and the machine's load
is recorded beside it. The gate does not fix the CI frame-test flake; that item
stays open in [the verification record](../verification/quality-gate.md).

## A fake carries every field of the seam it stands for

A test fake that drops a field makes the documented property untestable. The
shared record fake threw the log level away, so `logger.info` and `logger.warn`
were one array, and a line moved between the two kept the suite green while it
made the documented filter wrong. The fake records the pair, and the suite that
reads a line asserts the level beside its wording.

## A defect found is a defect filed

A defect found while working gets a GitHub issue in the same push, and the
record and the documentation name that issue. #233 recorded a real defect in
prose and filed nothing; the rework filed #234.

When one instance of a failure mode is fixed, the other instances are searched
for and each is fixed or filed. The standing-fact rule applied to one refusal
while a second refusal still wrote about 12 identical lines a minute at the
five-second poll. The rule is: do not leave it unmentioned.

## A number names the head it was taken at

Every count in a commit body or a pull request body names the commit it was
measured on, and the body is updated after each rework round. A body that keeps
the test count of an earlier head, or an acceptance criterion a later ADR
retired, is a rule break.

A branch that carries unrelated churn states in its body which control behavior
did not change, so a reader does not read someone else's rework as this branch's
control decision.

## Small shape rules

- A frame test's chosen terminal width states the arithmetic that fixes it.
- One copy of a describe block per file. The Work queue pickup suite stood twice
  in one file, left by an earlier split.
- A wording that has its own test is not restated literally elsewhere. The
  rewrite Message was spelled out eight times in one shape table, so a wording
  change turned eight shape records red for a reason that had nothing to do with
  shape. `rewriteCosts()` and `rewriteMessage()` answer the line; the records
  read them.

## The reviewer's floor

A review measures the head it reviews, not the description:

- `bun run lint`, `bun run typecheck`, and one full `bun run test` on the merged
  tree, with the machine state recorded.
- Every probe the branch claims is re-run, and each result is reported.
- The score and the specification check name the head they were measured on.
- No remote read. `gh run list`, `gh run watch`, and `gh pr checks` stay unused:
  CI runs the same checks on the tree that merges, and a review that waits on the
  remote is measuring someone else's tree on someone else's schedule. The one
  exception is a CI flakiness investigation, and there the record names every run
  it reads.

## A control change gets a human look

A change under `src/components/shared` gets `bun run gallery` opened on the state
it changed, and the record says whether anyone looked. The gallery's examples run
inside `bun run test`, so the automated gate covers the control's behavior; it
covers no pixel, and it claims none.

## What the gate does not cover

The gate is a claim about the automated checks and the tree they ran on. It says
nothing about the live terminal walk, the screen-reader path, or the theme
inheritance in a real herdr. Those stand open in
[the verification record](../verification/quality-gate.md) and in
[the shared control record](../verification/shared-controls.md).
