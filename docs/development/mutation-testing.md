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

The command copies the tree into `.stryker-tmp`, rewrites the copy, runs
`bun test` against it, and removes the sandbox afterwards; the working tree never
holds a mutant. Reports land in `reports/mutation` and are not committed. The
run takes the machine: it spawns one `bun test` process per worker, each about
250 MB, and `concurrency` in `stryker.config.mjs` sets how many run at once.

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
killed or not, so a survivor can be judged where it stands.

## What a campaign costs

Measured on a 32-core machine, Bun 1.4.2, the suite of this repository:

| Thing                                                             | Cost                         |
| ----------------------------------------------------------------- | ---------------------------- |
| `bun run test`                                                    | 38 s                         |
| The campaign's initial run: the whole suite, instrumented, serial | 3 min 31 s                   |
| Mutants in `src`                                                  | 27,293 over 75 files         |
| Mutants in the campaign's scope (`src` without the gallery)       | 26,177 over 74 files         |
| 814 mutants of session-record and domain logic, 8 workers         | 11 min, about 4,400 per hour |
| 913 mutants of the shared control library, 16 workers             | 22 min, about 2,500 per hour |
| One campaign over the whole scope                                 | 6 to 11 hours, extrapolated  |

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

Two files stay out of the campaign on purpose:

- `src/components/shared/gallery.ts` is the shared control gallery's own example
  list. `bun run gallery` is its only caller, no shipped surface reads it, and it
  holds 1,116 of the 27,293 mutants in `src`: 4 percent of the campaign's work
  from one module that imports the whole control library.
- `test/shared-control-architecture.test.ts` reads production source as text and
  counts the shapes it finds. The runner rewrites exactly those shapes, so under
  mutation the file fails on a text change rather than on a behavior change. It
  would kill mutants for the wrong reason and inflate the score. It stays in
  `bun run test`, which reads the uninstrumented tree.

The score is a coverage measure of the tests, not a grade of the code. A
survivor is only a problem when the mutation it stands on is a behavior the
plane should answer on: `i -= 1` to `i += 1` in a loop that never runs more than
once is a survivor worth leaving. A survivor on a state transition, a settings
resolution, or a frame's cell is a missing test.

The two measured slices scored **79.48 %** (session-record parsing and the
domain modules) and **63.20 %** (the shared control library), and reported 23
and 49 mutants with no coverage at all. Those are the first places to look;
neither is the plane's score, and no whole-`src` baseline has been measured yet.
