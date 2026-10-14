---
title: Mutation testing
description: What a mutation campaign measures, how to run one, and the budget a run costs.
---

# Mutation testing

A test suite that passes says the tests agree with the code. It does not say
the tests would notice a wrong program. Mutation testing answers that: a runner
rewrites one expression at a time in `src`, changes `x > y` to `x >= y`, drops a
`!`, empties a string, returns `undefined` from an arrow function, and runs the
tests against the rewritten copy. A mutant the suite fails is **killed**: some
test reads the difference. A mutant that passes every test is a hole: the code
carried a behavior no test answers on.

The plane runs mutation testing with [StrykerJS](https://stryker-mutator.io)
and its Bun test-runner plugin. See
[ADR 0055](../adr/0055-mutation-testing-runs-on-the-bun-test-runner.md) for why
this shape and what it costs.

## Running a campaign

```sh
bun run mutate                                    # the whole of src: hours
bun run mutate -- --mutate=src/domain/ticket.ts   # one file
bun run mutate -- "--mutate=src/domain/**"        # one directory: quote the glob
bun run mutate -- --dryRunOnly                    # one instrumented full run
```

The command copies the tree into a sandbox under `.stryker-tmp`, rewrites the
copy, runs `bun test` against it, and removes that sandbox afterwards: the working
tree never holds a mutant. Each campaign gets a directory of its own there,
named for its process, so two campaigns in one checkout do not delete each
other's tree; they still share `reports/mutation`, where the last run to finish
owns the report. The copy step ignores that whole temp tree, so a campaign reads
none of what the campaigns before it left in it: Stryker excludes only the one
temp directory it is handed, and the per-campaign name sits one level deeper.
Reports are not committed - `mutation.html` to read and `mutation.json` for a
program to diff. The run takes the machine: it spawns one
`bun test` process per worker, each about 250 MB, and `concurrency` in
`stryker.config.mjs` sets how many run at once - a quarter of the machine's
logical cores there, which is the measured 8 on a 32-core machine and scales down
on a smaller one.

To look inside a campaign's sandbox after it ends, ask Stryker to keep it and the
entry point stands down with it: `bun run mutate -- --cleanTempDir false` (the
`--cleanTempDir=false` form works the same). Those are the only two values that
keep it: `false` and `0` are exactly what Stryker's own option parser reads as
"do not delete", and this entry point stands down for no value core does not, so
`true`, `always`, and `never` all leave the removal armed. `never` is the one
spelling whose English and whose parsed reading disagree - Stryker's parser takes
any text but `false` and `0` as truthy - so the command says so at its gate
instead of promising a sandbox that its own runner then takes down.

The command refuses to start on a Bun older than `1.3.7`, the release that added
the inspector events the runner reads to tie a mutant to its tests. The control
plane itself still runs on the `1.3.0` floor
[ADR 0035](../adr/0035-the-control-plane-runs-on-bun.md) set; the higher floor
belongs to the mutation harness, not to the app.

`--dryRunOnly` is the cheap probe. It instruments every file, runs the suite
once against the instrumented copy, and stops. It answers whether the campaign
can run at all, how many mutants the scope holds, and what one full test run
costs - the floor under the campaign's slowest mutant runs.

Read the report two ways. The terminal prints the score table and each surviving
mutant with the tests that ran for it. The HTML report
(`reports/mutation/mutation.html`) shows the source with every mutant in place,
killed or not, so a survivor can be judged where it stands. The JSON report
(`reports/mutation/mutation.json`) holds the same result for a program to read.

## What the campaign host resolves

The campaign's host process runs Stryker core on the Bun runtime. One part of
the host reads the repository's typescript: core's ts-config preprocessor
imports the bare specifier `typescript` from its own package and reads
`parseConfigFileTextToJson` from it, the parse it runs on the sandbox copy's
`tsconfig.json` before it rewrites the file's path fields for the sandbox. It
runs before the campaign's scope is applied, so the typescript it resolves is
the campaign's gate. The typescript 7.0.2 this repository declares - the
native compiler line `bun run typecheck` runs - exposes no such function, and
a host that resolved the top-level package died at that step, so no campaign,
scoped or full, could start at all (issue #377).

`bun run mutate` therefore gives the host its own copy: it stages the shim the
checkout vendors at `scripts/stryker-host-typescript` under
`node_modules/@stryker-mutator/core/node_modules/typescript` before every run,
where the preprocessor's import finds it first. The shim is a package named
`typescript` that implements that one function on a small JSONC parse and
nothing else of the typescript API; it is not a compiler. Bare-specifier
resolution being per package, nothing else in the host - the instrumenter, the
runner plugin - resolves it, and the declared typescript, the type check, and
the Quality audit stand untouched. The entry point re-stages on every run,
because `bun install` can prune a staged copy, and it refuses a campaign whose
checkout lost the shim. See
[ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)
for the decision.

## What bounds one run

Two clocks run over the campaign's initial run - the whole suite, instrumented,
in one process - and the tighter one governs. `dryRunTimeoutMinutes` is core's:
it races the dry run it hands the test runner. `bun.timeout` is the plugin's kill
bound for one child, plus a fixed 30 seconds it allows itself for the inspector
drain on that first run. The config sets 15 minutes and 600 seconds against a run
that measures 6 minutes 10 seconds on this machine (3,369 tests, net 3 minutes
56 seconds of test time, the rest the inspector's overhead, measured on the head
this branch's campaign ran), so the plugin's 630 seconds is what stands over it
with 70 percent of headroom. The run's tests take the suite's own
sixty-second per-test budget, handed to the child on its `bun test` command line
through the config's `bun.bunArgs`: bun takes that budget from the CLI only, and
without it the campaign's children would die on bun's five-second default while
the frame rig's timeout test waits out its full twenty-second deadline. A mutant
run is bounded the same two ways: core gives it `timeoutFactor * netTime +
timeoutMS + overhead`, where `netTime` is what the tests covering that one mutant
took in the initial run, and `timeoutMS` is the flat slack in that sum.

## What a campaign costs

Measured on a 32-core machine, Bun 1.4.2, the suite of this repository:

| Thing                                                             | Cost                         |
| ----------------------------------------------------------------- | ---------------------------- |
| `bun run test`                                                    | 65.67 s (3,415 tests over 155 files)   |
| The campaign's initial run: the whole suite, instrumented, serial | 6 min 10 s (3,369 tests)               |
| The campaign's initial run on the head behind #394, measured 2026-10-14 | 7 min 48 s (3,363 tests over 149 files, the suite minus the excluded files) |
| Mutants in `src`                                                  | 39,111 over 127 files                |
| Mutants in the campaign's scope (`src` without the gallery)       | 37,207 over 126 files                |
| 814 mutants of session-record and domain logic, 8 workers         | 11 min, about 4,400 per hour         |
| 913 mutants of the shared control library, 16 workers             | 22 min, about 2,500 per hour         |
| The scoped campaign of this branch (4,835 mutants, 4 workers, busy machine) | 5 hours 42 minutes, measured on 2026-10-13 |
| One campaign over the whole scope                                 | about 44 hours, extrapolated from that measured rate |

The table's numbers stand on the head this branch's scoped campaign measured,
rebased onto the Seeded plane (#378). The frame rig's rework (#391) landed on
main after that run and grows the suite from 3,415 to 3,428 tests; the
campaign's score belongs to the measured head, as the verification record
states.

Two numbers explain the rest. A mutant run costs the time of the tests that
covered it - 10 tests on average for the logic slice, 47 for the library slice -
so a module the frame tests all import is expensive per mutant no matter how few
mutants it holds. And the campaign is CPU-bound before it is memory-bound:
doubling the workers did not double the rate.

The single most expensive mutants are the static ones: an expression that runs
when a module loads is covered by every test that imports it, so its run is
practically the whole suite. Stryker reports how many it found and what share of
the time they take: 4 % of one measured slice, estimated at 61 % of its running
time. `--ignoreStatic` drops them and takes that saving, and it is a real loss:
module-level constants are behavior the frames read. `bun run mutate` keeps them.

## The score, and what is not in it

One module and seven test files stay out of the campaign on purpose:

- `src/components/shared/gallery.ts` is the shared control gallery's own example
  list. `bun run gallery` is its only caller, no shipped surface reads it, and it
  holds 1,904 of the 39,111 mutants in `src`: 5 percent of the campaign's work
  from one module that imports the whole control library.
- `test/shared-control-architecture.test.ts` reads production source as text and
  counts the shapes it finds. The runner rewrites exactly those shapes, so under
  mutation the file fails on a text change rather than on a behavior change. It
  would kill mutants for the wrong reason and inflate the score. It stays in
  `bun run test`, which reads the uninstrumented tree.
- `test/state-architecture.test.ts` does the same job for the state aggregates
  (ADR 0095): it reads the nine aggregate modules, the composition, and the
  callers as text, and counts the interface methods, the tables each statement
  names, and the shapes the graph is built with. Instrumentation rewrites the
  method bodies and the query strings it reads, so it would kill every mutant in
  the nine state modules for the wrong reason. It stays in `bun run test` too.
- `test/record-lines-doc.test.ts` (issue #223 review) holds that the
  configuration reference states the same record lines the code writes, and for
  the lines that live only in a module's source it reads them out of that
  source: the dispatch's refusal facts out of `src/handoff-dispatch.ts`, the
  checkout hold's lines out of `src/checkout-hold.ts`, and the rest out of the
  domain modules. Instrumentation rewrites those string literals in the files it
  mutates, so it would fail on a text change rather than a behavior change.
  Measured on this branch: with `src/handoff-dispatch.ts` in the scope, the
  campaign's initial run died on `every refusal shape the dispatch writes is on
  the page`. It stays in `bun run test` too.
- `test/quality-audit.test.ts` (ADR 0120) runs `bun run audit` as a child, and
  the audit measures the duplication of `src` against the baseline the clean
  tree sets in `.quality-baseline.json`. Instrumentation rewrites the source
  text the audit measures, so the child reports counts the baseline does not
  hold and exits non-zero, and the campaign's initial run dies on the case. The
  file's other cases measure the audit's payload and baseline rules, not the
  tree's text, but the exclusion is per file, the way the others' is. It stays
  in `bun run test` too.
- `test/app-shell-architecture.test.ts` (issue #372) reads the App shell module
  as text: it scans the `AppProps` interface's field list and the shell's boot
  code for the shapes the total boot record refuses, and instrumentation
  rewrites exactly those shapes, so under mutation the scan answers no fields.
  It stays in `bun run test` too.
- `test/git-push-architecture.test.ts` (ADR 0127) scans the source for a
  `"git"` argv holding a `"push"` token and refuses a push that does not name
  the bypass. The scan reads the call shapes instrumentation rewrites, so under
  mutation it finds no pushing source at all. It stays in `bun run test` too.
- `test/attempt-hold-architecture.test.ts` (ADR 0077 as extended by ADR 0101)
  is the source tripwire of the attempt hold's rule: it reads the two state
  modules' text and counts the shared module's call shapes, which
  instrumentation rewrites. The rule's behavior half stays in
  `test/attempt-hold.test.ts`, inside the campaign, and the tripwire stays in
  `bun run test`.

One more file reads production source as text and is deliberately **not** on
that list. `test/config-write-architecture.test.ts` (ADR 0103) counts call
names - `writeConfigFile(`, `persistConfig(`, `writeConfigText(` - and
instrumentation leaves those names whole, so the file passes against the
instrumented copy and stands inside the campaign. Measured: a `--dryRunOnly`
initial run over the whole instrumented tree reported 2,771 tests in 4 minutes
38 seconds with no failure, and the file's own cases reported 5 pass, 0 fail
run alone inside that campaign's kept sandbox. The file has since grown to 6
cases, and this branch's scoped campaign ran the file's cases inside the
initial run on both trees it measured, with no failure. The rule for the exclusion is
what a file counts, not that it reads source: a file that counts shapes
instrumentation rewrites is excluded, a file that counts names it does not is
not.

The score is a coverage measure of the tests, not a grade of the code. A
survivor is only a problem when the mutation it stands on is a behavior the
plane should answer on: `i -= 1` to `i += 1` in a loop that never runs more than
once is a survivor worth leaving. A survivor on a state transition, a settings
resolution, or a frame's cell is a missing test.

The three measured slices scored **79.48 %** (session-record parsing and the
domain modules: of 814 mutants, 645 killed and 2 timed out, 144 survived, and 23
with no coverage), **63.20 %** (the shared control library: of 913 mutants,
573 killed and 4 timed out, 287 survived, and 49 with no coverage), and
**76.73 %** (the Handoff dispatch and the observation, measured on the pushed
tree on 2026-10-13: of 4,835 mutants, 3,701 killed, 8 timed out, and 1 runtime
error counted with the killed, 919 survived, and 206 with no coverage). A
timeout counts as a kill, and so does a run that errors, so the scores read as
647 of 814, 577 of 913, and 3,710 of 4,835. Those are the first places to
look; none is the plane's score, and no whole-`src` baseline has been measured
yet.
