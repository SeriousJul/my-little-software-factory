# Mutation testing verification

Status: the campaign harness works on Bun and was measured on the branch that
added it, on 2026-09-23, then re-measured on the same date against the review of
pull request #157: the initial run's two bounds, the harness test's own tree, the
`--cleanTempDir` values, the Stryker entry point lookup, and the JSON report are
rows below. A whole-`src` campaign has not been run end to end, so
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
| Suite at the measured commit | 1,916 tests over 79 files: 38 seconds with `bun run test`, and 3 minutes 24 seconds to 3 minutes 31 seconds for the campaign's initial run, which is one serial process over 1,903 tests with the architecture test's 13 standing outside |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| Stryker instruments this TypeScript tree and drives the real suite on Bun | Four campaigns, 1,765 mutants in total, over `src/domain`, `src/turn-log.ts`, six modules of `src/components/shared`, and `src/lines.ts`, `src/fs.ts`, `src/herdr.ts`, and `src/gallery.ts`; then this branch's rework re-ran campaigns over `src/fs.ts`, `src/lines.ts`, and `src/herdr.ts` after each change, ending with 14 mutants across two runs side by side in one checkout. Every campaign runs one whole-suite initial run first | Passed. Zero runner errors, zero infrastructure errors |
| The whole suite passes once against the instrumented copy | The shipped config's initial run: 1,903 tests, 3 minutes 25 seconds, exit 0, on a campaign over `src/lines.ts` and `src/fs.ts` with the reworked entry point and config. The first whole-scope run on the branch reported 1,897 tests in 3 minutes 31 seconds before this file's harness test grew | Passed, after the two adjustments ADR 0055 records |
| The code under test runs on Bun, not on Node | `ps` during a campaign: the host is `bun .../stryker.js run` and every child is `bun test --config=/tmp/stryker-bun-runner/...` | Passed |
| A test that reads production source survives instrumentation | `test/state.test.ts` failed the first whole-campaign initial run: its line-shaped read found the two `work_cycle` statements where the instrumented file no longer prints them whole. It passed once the read took each statement's own quoted literal, and it passed again on the shipped config's run | Passed |
| The architecture test stays out of the campaign | The first whole-campaign initial run failed 3 tests in `test/shared-control-architecture.test.ts` (its `borderColor: controlInk()...` shape count came back 0 against an expected 2, because instrumentation rewrites the shape); the file is in `ignorePatterns`, and the campaign's initial run reports 13 tests fewer than `bun run test` | Passed. The exclusion is deliberate: the file would kill mutants on a text change |
| The command's Bun floor gate | `test/mutate-script.test.ts`: a fake `bun` reporting 1.2.99 and 1.3.0 and 1.3.6 exits 1 before any campaign process starts; 1.3.7 and newer reach it, and the caller's arguments arrive at Stryker intact. The same file checks the entry point refuses when no Stryker entry point answers `STRYKER_BIN`, and says `bun install` | Passed |
| The command forwards its arguments to Stryker | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts --dryRunOnly`, `bun run mutate -- "--mutate=src/domain/**"` (2 files, 93 mutants), and `bun run mutate -- --mutate=src/domain/ticket.ts` (1 file, 84 mutants). A repeated `--mutate` replaces the earlier one, so a scope is one argument | Passed |
| A campaign run end to end through `bun run mutate` | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts` on the shipped config: 14 mutants, 13 killed, 1 survived, score 92.86 %, zero errors, exit 0. The run's own clock read 3 minutes 40 seconds against the machine and 6 minutes 55 seconds on a later pass whose survivor's whole-suite run shared the box with this session's `bun run test`. It worked in `.stryker-tmp/campaign-<pid>` and left no `.stryker-tmp` behind. It wrote `reports/mutation/mutation.html` and `reports/mutation/mutation.json`, and nothing else under `reports/`. Its log answers the `concurrency: "25%"` knob directly: `Creating 8 test runner process(es)` on this 32-core machine, the same count the first record measured by hand | Passed |
| The initial run's two bounds, and which one governs | Core races `dryRunTimeoutMinutes` against the dry run it hands the runner (`3-dry-run-executor.js`, `test-runner/index.js`, `timeout-decorator.js`), and the plugin bounds the same child at `bun.timeout` plus 30 seconds for its inspector drain. Measured: `bun run mutate -- --mutate=src/fs.ts --dryRunOnly --dryRunTimeoutMinutes=0.5` printed `ERROR DryRunExecutor Initial test run timed out!` at 30 seconds with `bun.timeout` still at 300_000; the tighter of the two bounds governs, so the config now sets `dryRunTimeoutMinutes: 10` and the plugin's 330 seconds is what stands over the measured 3 minute 25 second run | Passed, and it corrects the first record's claim that the plugin ignores core's timeout |
| The harness test leaves a live campaign alone | `test/mutate-script.test.ts` runs a copy of `scripts/` inside its own `mkdtemp` tree. One case starts that copy from the real repository root and reads back where the campaign worked - the test tree, never the caller's - and another lays a sibling campaign's tree beside the run's own and checks it survives, so the removal can name only what the run created. A third case puts a probe standing for a live sandbox under the real `.stryker-tmp`, keyed to this process's id, and checks it is still there after the runs. Before that change, placing `.stryker-tmp/sandbox-LIVECAMPAIGNPROBE/mutant.ts` in this worktree and running only `bun test test/mutate-script.test.ts` deleted the whole tree | Passed. A campaign is 6 to 11 machine hours, so the entry point must not be able to reach another tree's sandbox |
| The entry point stands down only for a request to keep the sandbox | `test/mutate-script.test.ts` runs the entry against a fake campaign for each value: `--cleanTempDir=false`, `=0`, `=never` and the separated `--cleanTempDir false`, `0`, `never` keep the sandbox; no argument, `=true`, `=always` and the separated `true`, `always` remove it. Stryker's own parser (`parseCleanDirOption`) reads only `false` and `0` as "do not clean", so `never` is taken here as that request spelled in plain English, and it is this entry point's stand-down, not Stryker's, that keeps the tree. Through the real command too: `bun run mutate -- --mutate=src/fs.ts --cleanTempDir=false` finished 5 mutants at exit 0 and left `.stryker-tmp/campaign-2736156/sandbox-voYUnS` in place for inspection, and the run said so: `mutate: the campaign's sandbox is kept under .stryker-tmp/campaign-2736156 for inspection.` | Passed, and it corrects the first version, which stood down for any `--cleanTempDir=` value and for none of the separated forms |
| The suite does not depend on Stryker's installed layout | `test/mutate-script.test.ts` points `STRYKER_BIN` at a stub of its own; moving `node_modules/@stryker-mutator/core/bin/stryker.js` aside no longer turns the file red. The entry point still refuses, with `bun install` named, when no Stryker entry point is there | Passed |
| Two campaigns in one checkout do not reach each other's tree | Each run gets `.stryker-tmp/campaign-<pid>`, and the entry point's removal names only that. Two runs side by side in this worktree at `--concurrency=4` each, `--mutate=src/lines.ts` and `--mutate=src/fs.ts --cleanTempDir=false`: the first finished its 9 mutants with zero errors and removed its own dir, the second finished its 5 with zero errors and exit 0, and left `.stryker-tmp/campaign-2736156/sandbox-voYUnS` standing with `mutate: the campaign's sandbox is kept under ... for inspection.` The same pair was run here before that change, on a `.stryker-tmp` both shared: the run that finished first removed the whole tree while the other was still testing, and that other one reported 3 of its 9 mutants as errors | Passed |
| No `bun test` child outlives the campaign, and the OS records no crash for one | `pgrep -af "bun test"` after every recorded run found no match, including after the campaign whose host was killed by SIGKILL. A campaign cancelled with SIGTERM read out as `crash-guard: the command died of signal 15 (TERM), exit code 143. The OS recorded no crash.`, which is the guard's non-dumpable path taken with a Bun host. The plugin signals a child's process group on a kill and watches its own parent | Passed |
| The sandbox is gone after the run, and stays only when the caller asked | A completed campaign leaves no `.stryker-tmp`. With the host process killed by SIGKILL mid-run, the entry point still removed it and reported the killed command. With `--cleanTempDir=false` the sandbox survives for inspection and the entry point stands down. Re-measured on this branch for both halves: the run without the option left nothing behind, the run with it left its own campaign dir and nothing else, with its sibling campaign's dir already removed by that sibling's own cleanup | Passed |
| Memory per child | `ps` RSS sampling during campaigns at 8 and 16 workers: 190 MB to 290 MB per child, no growth across a child's lifetime | Measured, and it is the basis of the `concurrency` comment |
| A hung mutant is bounded, not fatal | The bounds are core's plan for that mutant (`timeoutFactor * netTime + timeoutMS + overhead`) and the plugin's own child kill at `bun.timeout`, and a too-small bound on each was seen to cut an initial run: at `bun.timeout` 30 seconds the run died at 61 seconds, at `dryRunTimeoutMinutes` 0.5 it died at 30 seconds. No mutant run hung in the recorded campaigns | Recorded as unverified for the mutant case |

## What is incomplete

- **No whole-`src` mutation score.** A campaign over the scope's 26,177 mutants
  was not run; it measures 6 to 11 machine hours by extrapolation from two
  slices, and the extrapolation is labelled as such wherever it appears. The
  baseline a score gate would need does not exist yet, so `thresholds.break` is
  unset.
- **The two slice scores are not the plane's score.** 79.48 % over session-record
  and domain logic (of 814 mutants: 645 killed, 2 timed out, 144 survived, 23
  with no coverage, so 647 of 814) and 63.20 % over the shared control library
  (of 913 mutants: 573 killed, 4 timed out, 287 survived, 49 with no coverage,
  so 577 of 913). Stryker's score counts a timeout as killed, which is why the
  killed counts alone do not divide out to the percentages. They say where the
  first gaps stand.
- **The whole-scope campaign has never run, so the two bounds that matter for it
  are untested at that length.** `dryRunTimeoutMinutes: 10` and the plugin's
  330 second child bound were measured against the initial run alone, and
  `timeoutMS: 60_000` has never cut a real mutant: no recorded campaign hung. The
  plan core builds for one mutant is `timeoutFactor * netTime + timeoutMS +
  overhead`, so on a slice whose static mutants run the whole suite, the plugin's
  300 second bound is the one that bites first. It is recorded as unverified
  rather than as a bound that was seen to hold.
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
