# ADR 0055: Mutation testing runs on the Bun test runner

Status: accepted
Date: 2026-09-23

## Context

ADR 0035 removed the Stryker setup with the Bun swap and left the re-evaluation
to issue #94. The removal was not a verdict on mutation testing. The old
containment rode on a Node-only fault, the `node:sqlite` 26.5.0 use-after-free
that Bun does not carry, and the old runner plugin drove Vitest, which the swap
retired. Two questions stood before a campaign could run again: whether any
mutation runner instruments a Bun process reliably, and what a campaign costs
now that the suite is `bun:test`.

The first question has no answer inside Stryker's own scope. The
`@stryker-mutator` scope publishes runners for Vitest, Jest, Mocha, Jasmine,
Karma, Tap, and Cucumber; the open request for a Bun runner
(stryker-mutator/stryker-js#5424) has no package behind it. The docs point an
unlisted test runner at the generic `command` runner, and that runner cannot
report per-test coverage, so Stryker runs the whole suite for every mutant.
Measured here, one whole-suite run inside the instrumented copy takes 3 minutes
31 seconds and the campaign's scope holds 26,177 mutants, so the `command`
runner's arithmetic is 26,177 mutants at 211 seconds each across 8 workers: eight
days per campaign. That is not a mutation-testing setup, it is a background job
that never finishes.

Two community packages cover Bun. `stryker-mutator-bun-runner` last released in
July 2025, peers Stryker 9, and its issue list carries a mutant that crashes at
module load being reported as a survivor. `@hughescr/stryker-bun-runner`
released through 2026 and reached 1.4.0 in September 2026; it peers Stryker 9 or
10, needs Bun 1.3.7 or newer for the inspector's `TestReporter` events, and
carries its own containment: a per-child kill, a whole-process-group signal, a
parent-liveness watchdog so a killed worker strands no child, an optional soft
RSS ceiling, and a spawn-depth ceiling that refuses a nested `bun test`. That
last one matters here: the plane's suite spawns processes of its own, and a
nested discovery run would pick up the suite that started it. The plugin drove
every measurement in this ADR.

The containment question did not disappear with the Node fault. A mutant run is
a real `bun test` of this suite: it opens a pseudo-terminal through OpenTUI's
native core and opens SQLite files, and a mutant that breaks a dispose path can
hang or die natively. Hanging is the plugin's to answer, and it does. Dying
natively is what `scripts/crash-guard.sh` was written for, and it still applies
to any descendant of the command.

## Decision

**Mutation testing returns on StrykerJS 10 with the Bun test-runner plugin, and
`bun run mutate` is its only entry.** `stryker.config.mjs` holds the campaign's
shape and `scripts/mutate.sh` runs it under the crash guard and always removes
the sandbox afterwards. The command refuses to start a campaign on a Bun older
than `1.3.7`, the release the plugin's inspector correlation needs; the control
plane's own `1.3.0` floor from ADR 0035 stands unchanged, because the higher
floor belongs to the harness, not to the app.

**Both the runner's host process and every test child run on Bun.** Stryker's
own process pool starts under `bun` and the plugin spawns `bun test` children,
so a campaign needs no Node install and ADR 0035's two Node exceptions stay
two: the `npm publish` of a release and the `npx` bootstrap. The runtime under
test is the runtime the control plane ships on, which is the whole point of
running a campaign at all.

**The campaign keeps per-test coverage, and the plugin's inspector correlation
is what pays for it.** Each mutant run executes only the tests that covered that
mutant, and bails at the first failure. Measured, a mutant run averaged 10 tests
for session-record and domain logic and 47 tests for the shared control library,
against the 1,897 a coverage-blind runner would run for each one.

**The campaign is an on-demand tool, not a push gate, and no scheduled job
replaces the workstation.** CI stays `lint`, `typecheck`, and `test`. A full
campaign measures 6 to 11 machine hours on the 32-core machine it was measured
on, so it cannot stand in a pull-request path, and a hosted runner is the wrong
place for it: the rate below is a per-core rate, a hosted Linux runner has a
quarter of the cores, and a scheduled job would hold a multi-day run open for a
score nobody reads daily. No score threshold gates it either: the plane has no
whole-campaign baseline yet, and a gate invented from one directory's score
would fail the first time it was checked. `bun run mutate` stays a command an
operator or an agent runs on purpose, and a scheduled job over one directory
stays open work.

**A campaign mutates `src`, not the preview gallery, and the architecture test
stands outside it.** `src/components/shared/gallery.ts` is excluded: it is the
gallery's own example list, `bun run gallery` is its only caller, and no shipped
surface reads it. It holds 1,116 of the 27,293 mutants in `src` - one module,
4 percent of the campaign - and it imports the whole control library, so its
mutants reach the suite's frame tests.
`test/shared-control-architecture.test.ts` is left out of the sandbox: it reads
production source as text and counts the shapes it finds,
and instrumentation rewrites exactly those shapes, so under mutation it kills on
a text change rather than a behavior change and inflates the score it reports.
It stays in `bun run test`, which reads the uninstrumented tree.

**A test that reads production source matches the literal, never the line that
holds it.** `test/state.test.ts` counts the statements that move a ticket's work
cycle by reading `src/state.ts`. It matched whole trimmed lines, which
instrumentation breaks: the runner lifts an expression out of its line into the
mutant table, so the line is no longer the statement. The test now takes each
statement's own quoted text with a `matchAll`, which states the same rule and
survives the rewrite.

## Consequences

- The setup is verified against this suite, not against a sample project. Four
  campaigns and three dry runs measured on Bun 1.4.2: 1,765 mutants ran with
  zero runner errors, and the whole-`src` dry run passed once the two adjustments
  above landed. A campaign runs the real terminal tests and the real `bun:sqlite`
  state tests, and the recorded scores and the incomplete checks stand in
  [the verification record](../verification/mutation-testing.md).
- The budget, measured: 8 workers ran 814 mutants in 11 minutes of mutant time
  (about 4,400 mutants per hour) and 16 workers ran 913 mutants in 22 minutes
  (about 2,500 per hour) for a library whose mutants reach more tests. `src`
  holds 27,293 mutants over 75 files, and the campaign's scope holds 26,177 of
  them over 74 files, so a campaign lands between 6 and 11 machine hours on a
  32-core machine. Doubling the workers did not double the rate: the campaign is
  CPU-bound before it is memory-bound. One `bun test` child holds about 250 MB
  resident.
- Those hours are an extrapolation from two slices. The whole campaign has not
  been run end to end, so this ADR records no whole-`src` mutation score and no
  baseline to gate on. The two measured slices scored 79.48 % (session-record
  parsing and the domain modules, 645 of 814 killed, 23 with no coverage) and
  63.20 % (the shared control library, 573 of 913 killed, 49 with no coverage),
  which says where the first gaps stand, not what the plane's score is.
- The initial run is the whole suite in one process with no `--parallel`, so it
  costs 3 minutes 31 seconds against the 38 seconds `bun run test` takes. The
  plugin holds one child-kill bound for the initial run and for every mutant run
  (`bun.timeout`, plus a fixed 30 seconds it allows itself for the inspector
  drain), and it ignores core's own `dryRunTimeoutMinutes` for the initial run:
  the value reaches the plugin's `dryRun` and goes unused. So `bun.timeout` is
  what has to clear the initial run, and Stryker's `timeoutMS` is what cuts a
  mutant run that hangs underneath it. Measured directly: an initial run with
  `bun.timeout` at 30 seconds died at 61 seconds, not at core's 5-minute
  `dryRunTimeoutMinutes`.
- A third-party package with one maintainer and a short history now owns the
  plane's mutation testing, at roughly 98,000 monthly downloads and Apache-2.0. A
  Stryker major bump is a plugin compatibility check before it is a dependency
  bump. The plugin's own diagnostics are part of the reading of a report: the
  initial run of this suite emits coverage-bleed warnings for module-level code,
  whose covering tests cannot be attributed exactly, and Stryker's handling of a
  mutant it cannot attribute is to run every test for it.
- The `--ignoreStatic` flag is the documented fast path. Stryker detected 32
  static mutants in the first slice - 4 % of its mutants, estimated at 61 % of
  its running time - because a module-load mutant is covered by every test that
  imports the file. It is not the default: a static mutant is a real mutant on a
  constant the plane's frames read, and dropping 4 % of the mutants to save time
  is the trade this ADR already declined once, in the same direction, for the
  gallery.
- `bun run mutate` writes reports under `reports/` and its sandbox under
  `.stryker-tmp`; both patterns were already ignored from the removed setup, and
  the script removes the sandbox even when the runner dies before its own
  cleanup.
