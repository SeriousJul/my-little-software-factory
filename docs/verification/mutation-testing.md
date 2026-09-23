# Mutation testing verification

Status: the campaign harness works on Bun and was measured on the branch that
added it, on 2026-09-23. A whole-`src` campaign has not been run end to end, so
the plane has no whole-`src` mutation score and no score gate; both are recorded
incomplete below.

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it is
not silently dropped.

See [ADR 0055](../adr/0055-mutation-testing-runs-on-the-bun-test-runner.md) for
the decision, [the command guide](../development/mutation-testing.md) for how to
run a campaign, and [issue #94](https://github.com/SeriousJul/my-little-software-factory/issues/94)
for the question this answers.

## What it was measured on

| Piece | Value |
| --- | --- |
| Runtime, host and test children both | Bun 1.4.2 (Linux x64) |
| StrykerJS | `@stryker-mutator/core` 10.0.0 |
| Test-runner plugin | `@hughescr/stryker-bun-runner` 1.4.0 |
| Machine | 32 logical cores, 60 GB RAM, developer workstation |
| Machine state during the runs | the plane's own dev watch process, this session's `bun run test` and `vitepress` builds, and the code-index writer were live, so the campaign shared the machine rather than owning it. The rates below are a busy-machine rate, not an idle one |
| Suite at the measured commit | 1,910 tests over 79 files: 38 seconds with `bun run test`, and 3 minutes 31 seconds for the campaign's initial run, which is one serial process over 1,897 tests with the architecture test standing outside |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| Stryker instruments this TypeScript tree and drives the real suite on Bun | Four campaigns, 1,765 mutants in total, over `src/domain`, `src/turn-log.ts`, six modules of `src/components/shared`, and `src/lines.ts`, `src/fs.ts`, `src/herdr.ts`, and `src/gallery.ts`. Every campaign runs one whole-suite initial run first, six in total here | Passed. Zero runner errors, zero infrastructure errors |
| The whole suite passes once against the instrumented copy | The shipped config's initial run: 1,897 tests, 3 minutes 31 seconds, exit 0, with all 74 campaign files instrumented | Passed, after the two adjustments ADR 0055 records |
| The code under test runs on Bun, not on Node | `ps` during a campaign: the host is `bun .../stryker.js run` and every child is `bun test --config=/tmp/stryker-bun-runner/...` | Passed |
| A test that reads production source survives instrumentation | `test/state.test.ts` failed the first whole-campaign initial run: its line-shaped read found the two `work_cycle` statements where the instrumented file no longer prints them whole. It passed once the read took each statement's own quoted literal, and it passed again on the shipped config's run | Passed |
| The architecture test stays out of the campaign | The first whole-campaign initial run failed 3 tests in `test/shared-control-architecture.test.ts` (its `borderColor: controlInk()...` shape count came back 0 against an expected 2, because instrumentation rewrites the shape); the file is in `ignorePatterns`, and the campaign's initial run reports 1,897 tests instead of the suite's 1,910 | Passed. The exclusion is deliberate: the file would kill mutants on a text change |
| The command's Bun floor gate | `test/mutate-script.test.ts`: a fake `bun` reporting 1.2.99 and 1.3.0 and 1.3.6 exits 1 before any campaign process starts; 1.3.7 and newer reach it, and the caller's arguments arrive at Stryker intact | Passed |
| The command forwards its arguments to Stryker | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts --dryRunOnly`, `bun run mutate -- "--mutate=src/domain/**"` (2 files, 93 mutants), and `bun run mutate -- --mutate=src/domain/ticket.ts` (1 file, 84 mutants). A repeated `--mutate` replaces the earlier one, so a scope is one argument | Passed |
| A campaign run end to end through `bun run mutate` | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts`: 14 mutants, 13 killed, HTML and JSON reports written, exit 0 | Passed |
| No `bun test` child outlives the campaign, and the OS records no crash for one | `pgrep -af "bun test"` after every recorded run found no match, including after the campaign whose host was killed by SIGKILL. A campaign cancelled with SIGTERM read out as `crash-guard: the command died of signal 15 (TERM), exit code 143. The OS recorded no crash.`, which is the guard's non-dumpable path taken with a Bun host. The plugin signals a child's process group on a kill and watches its own parent | Passed |
| The sandbox is gone after the run, and stays only when the caller asked | A completed campaign leaves no `.stryker-tmp`. With the host process killed by SIGKILL mid-run, the entry point still removed it and reported the killed command. With `--cleanTempDir=false` the sandbox survives for inspection and the entry point stands down | Passed |
| Memory per child | `ps` RSS sampling during campaigns at 8 and 16 workers: 190 MB to 290 MB per child, no growth across a child's lifetime | Measured, and it is the basis of the `concurrency` comment |
| A hung mutant is bounded, not fatal | The bounds are Stryker's per-mutant `timeoutMS` plus the plugin's child kill, and a too-small child bound was seen to cut an initial run at 61 seconds, so the bound fires. No mutant run hung in the recorded campaigns | Recorded as unverified for the mutant case |

## What is incomplete

- **No whole-`src` mutation score.** A campaign over the scope's 26,177 mutants
  was not run; it measures 6 to 11 machine hours by extrapolation from two
  slices, and the extrapolation is labelled as such wherever it appears. The
  baseline a score gate would need does not exist yet, so `thresholds.break` is
  unset.
- **The two slice scores are not the plane's score.** 79.48 % over session-record
  and domain logic, 63.20 % over the shared control library. They say where the
  first gaps stand.
- **A fatal-signal death inside a campaign was not observed.** No child of a
  recorded campaign died on a signal: the runs saw clean exits, timeouts, and one
  SIGTERM cancellation of the whole command, which the guard reported as
  contained. `test/crash-guard.test.ts` proves the guard's crash path (no core
  file, no orphans) with a fake workload that aborts; that is the evidence for
  that case, not a campaign observation.
- **No CI job.** The decision put the campaign outside the push gate; a scheduled
  or `workflow_dispatch` job is open work, not a verified option.
- **`--ignoreStatic` was not measured.** Stryker reported 32 static mutants as 4 %
  of one slice's mutants and 61 % of its estimated running time; that estimate is
  the only number behind the fast path.
- **Incremental mode and the dashboard reporter were not used.** Both are
  supported by the runner and untested here.
- **One cancellation left a descendant behind, and it was not the campaign's.**
  Two `bun` processes survived a cancelled early run: they were the stubborn
  children of `test/crash-guard.test.ts`, which the initial run was executing
  when the cancel landed, and the guard's own grace period was cut short with
  them. No `bun test` child of the harness itself survived any recorded run.
- **The coverage-bleed warnings were read, not resolved.** The initial run reports
  mutant coverage recorded outside any test for module-level code, and names one
  mutant id for the whole set. Stryker's static-mutant handling (all tests for
  that mutant) covers the case, so attribution for those mutants is coarse rather
  than wrong. It was not verified that no other mutant lost a killer this way.
