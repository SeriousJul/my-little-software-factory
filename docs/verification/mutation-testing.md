# Mutation testing verification

Status: the campaign harness works on Bun and was measured on the branch that
added it, on 2026-09-23, then re-measured against the two reviews of pull request
#157 on the same date. The first review's rows are the initial run's two bounds,
the harness test's own tree, the `--cleanTempDir` values, the Stryker entry point
lookup, and the JSON report. The second review's rows are the temp tree a campaign
copies, the `never` value core reads as a delete, and the path the removal
anchors to. A whole-`src` campaign has not been run end to end, so
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
| Suite at the measured commit | 1,919 tests over 79 files, 38.34 seconds with `bun run test`. The campaign's initial run measured 1,905 tests at 3 minutes 24 seconds to 3 minutes 26 seconds on this branch's final rework: one serial process over the 1,918-test suite as it stood at those runs, with `test/shared-control-architecture.test.ts` and its 13 cases standing outside the campaign |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| Stryker instruments this TypeScript tree and drives the real suite on Bun | Four campaigns, 1,765 mutants in total, over `src/domain`, `src/turn-log.ts`, six modules of `src/components/shared`, and `src/lines.ts`, `src/fs.ts`, `src/herdr.ts`, and `src/gallery.ts`; then this branch's rework re-ran campaigns over `src/fs.ts`, `src/lines.ts`, and `src/herdr.ts` after each change, ending with the two side-by-side runs and a `--cleanTempDir=never` run recorded below. Every campaign runs one whole-suite initial run first | Passed. Zero runner errors, zero infrastructure errors |
| The whole suite passes once against the instrumented copy | The shipped config's initial run on this branch's final rework: 1,905 tests in 3 minutes 26 seconds, exit 0, on a campaign over `src/lines.ts` and on one over `src/fs.ts`. The first whole-scope run on the branch reported 1,897 tests in 3 minutes 31 seconds before this file's harness test grew | Passed, after the two adjustments ADR 0055 records |
| The code under test runs on Bun, not on Node | `ps` during a campaign: the host is `bun .../stryker.js run` and every child is `bun test --config=/tmp/stryker-bun-runner/...` | Passed |
| A test that reads production source survives instrumentation | `test/state.test.ts` failed the first whole-campaign initial run: its line-shaped read found the two `work_cycle` statements where the instrumented file no longer prints them whole. It passed once the read took each statement's own quoted literal, and it passed again on the shipped config's run | Passed |
| The architecture test stays out of the campaign | The first whole-campaign initial run failed 3 tests in `test/shared-control-architecture.test.ts` (its `borderColor: controlInk()...` shape count came back 0 against an expected 2, because instrumentation rewrites the shape); the file is in `ignorePatterns`, and the campaign's initial run reports 13 tests fewer than `bun run test` | Passed. The exclusion is deliberate: the file would kill mutants on a text change |
| The command's Bun floor gate | `test/mutate-script.test.ts`: a fake `bun` reporting 1.2.99 and 1.3.0 and 1.3.6 exits 1 before any campaign process starts; 1.3.7 and newer reach it, and the caller's arguments arrive at Stryker intact. The same file checks the entry point refuses when no Stryker entry point answers `STRYKER_BIN`, and says `bun install` | Passed |
| The command forwards its arguments to Stryker | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts --dryRunOnly`, `bun run mutate -- "--mutate=src/domain/**"` (2 files, 93 mutants), and `bun run mutate -- --mutate=src/domain/ticket.ts` (1 file, 84 mutants). A repeated `--mutate` replaces the earlier one, so a scope is one argument | Passed |
| A campaign run end to end through `bun run mutate` | `bun run mutate -- --mutate=src/lines.ts,src/fs.ts` on the shipped config: 14 mutants, 13 killed, 1 survived, score 92.86 %, zero errors, exit 0. The run's own clock read 3 minutes 40 seconds against the machine and 6 minutes 55 seconds on a later pass whose survivor's whole-suite run shared the box with this session's `bun run test`. It worked in `.stryker-tmp/campaign-<pid>` and left no `.stryker-tmp` behind. It wrote `reports/mutation/mutation.html` and `reports/mutation/mutation.json`, and nothing else under `reports/`. Its log answers the `concurrency: "25%"` knob directly: `Creating 8 test runner process(es)` on this 32-core machine, the same count the first record measured by hand | Passed |
| The initial run's two bounds, and which one governs | Core races `dryRunTimeoutMinutes` against the dry run it hands the runner (`3-dry-run-executor.js`, `test-runner/index.js`, `timeout-decorator.js`), and the plugin bounds the same child at `bun.timeout` plus 30 seconds for its inspector drain. Measured: `bun run mutate -- --mutate=src/fs.ts --dryRunOnly --dryRunTimeoutMinutes=0.5` printed `ERROR DryRunExecutor Initial test run timed out!` at 30 seconds with `bun.timeout` still at 300_000; the tighter of the two bounds governs, so the config now sets `dryRunTimeoutMinutes: 10` and the plugin's 330 seconds is what stands over the measured 3 minute 25 second run | Passed, and it corrects the first record's claim that the plugin ignores core's timeout |
| The harness test leaves a live campaign alone | `test/mutate-script.test.ts` runs a copy of `scripts/` inside its own `mkdtemp` tree. One case starts that copy from the real repository root and reads back where the campaign worked - the test tree, never the caller's - and another lays a sibling campaign's tree beside the run's own and checks it survives. A third puts a probe standing for a live sandbox under the real `.stryker-tmp`, keyed to this process's id, and checks it is still there after the runs. Before that change, placing `.stryker-tmp/sandbox-LIVECAMPAIGNPROBE/mutant.ts` in this worktree and running only `bun test test/mutate-script.test.ts` deleted the whole tree. The fake campaign in that file now answers `--cleanTempDir` the way core's parser does and can die before any cleanup of its own, so a kept sandbox is one this entry point had to leave alone and a removed one is a removal this entry point made. Its own cleanup of the worktree probe runs through `rmdirSync`, which takes down an empty shell and fails on a directory another run owns: measured here, a run of the file leaves no `.stryker-tmp` behind when the root held none, and leaves a planted `.stryker-tmp/campaign-live/s.ts` whole when one did | Passed. A campaign is 6 to 11 machine hours, so the entry point must not be able to reach another tree's sandbox |
| The removal is anchored by the resolved path, not by the text `--tempDirName` carried | A prefix test on the unnormalized string lets a `--tempDirName` holding `..` through it, and the trap's `rm -rf` then walks out of the campaign. Measured both ways in a throwaway tree off this worktree, against the previous entry point and the current one, with `--tempDirName=.stryker-tmp/../victim` and a planted `victim/keep-me.ts` standing for the tree the run must not reach: the previous script's cleanup took `victim` down whole, and the current one left it in place and printed `--tempDirName=.stryker-tmp/../victim is no campaign dir under <root>/.stryker-tmp, so this entry point leaves its cleanup to Stryker.` The entry point now resolves both its own temp parent and the campaign dir with `realpath -m` and arms the removal only for a tree strictly under that parent, which also covers an absolute `--tempDirName` and a symlinked root. `test/mutate-script.test.ts` holds the same case, inside its own tree | Passed. The check is a resolved-path comparison, not a string match, and the comment on it says so |
| The entry point stands down only for a request Stryker honors too | `test/mutate-script.test.ts` runs the entry against a fake campaign that cleans the way core does. `--cleanTempDir=false`, `=0` and the separated `false`, `0` keep the sandbox; no argument, `=true`, `=always`, and `=never` all take it down, and the entry point prints no keep line for any of those. Core's `parseCleanDirOption` reads only `false` and `0` as "do not clean" and everything else, `never` included, as truthy, so `TemporaryDirectory.dispose` deletes the tree on a clean run: the previous entry point stood down for `never` and printed `the campaign's sandbox is kept under .stryker-tmp/campaign-2825909 for inspection.` for a directory that did not exist when the command returned. It now takes `never` as what core reads it to be and says so at the gate. Both halves measured through the real command: `bun run mutate -- --mutate=src/lines.ts --cleanTempDir=false` ran its 9 mutants to exit 0 and left `.stryker-tmp/campaign-198708/sandbox-vOSO9Y` standing with `the campaign's sandbox is kept under .stryker-tmp/campaign-198708 for inspection.`, and `bun run mutate -- --mutate=src/fs.ts --cleanTempDir=never` ran its 5 to exit 0 at an 80.00 % score, printed `Stryker reads --cleanTempDir=never as a request to delete the temp dir, so the sandbox goes with the run. Use --cleanTempDir=false to keep it for inspection.`, and left no `.stryker-tmp` at all | Passed, and it corrects both earlier versions: the first stood down for any `--cleanTempDir=` value, the second for `never`, which core cannot honor |
| A campaign copies none of the temp tree | Core builds its project-copy ignore set as `ALWAYS_IGNORE` plus the one `tempDirName` it was handed plus `ignorePatterns` (`fs/project-reader.js`), and the entry point names a campaign dir one level deeper, so `.stryker-tmp` itself was no longer excluded and a campaign walked and copied its siblings' sandboxes into its own. Measured on the previous config: a planted `.stryker-tmp/probe-sibling/sandbox-ABC/deep/probe.txt` took the project read from 297 to 298 files and reappeared at `.stryker-tmp/campaign-<pid>/sandbox-XXXX/.stryker-tmp/probe-sibling/...`. `.stryker-tmp` is now in `ignorePatterns`, and with the same probe planted the read stays at 297 files and reaches no sandbox | Passed. The leak compounded: a sandbox kept by `--cleanTempDir=false` was copied whole by every campaign after it |
| The suite does not depend on Stryker's installed layout | `test/mutate-script.test.ts` points `STRYKER_BIN` at a stub of its own; moving `node_modules/@stryker-mutator/core/bin/stryker.js` aside no longer turns the file red. The entry point still refuses, with `bun install` named, when no Stryker entry point is there | Passed |
| Two campaigns in one checkout do not reach each other's tree, at either end of a run | Each run gets `.stryker-tmp/campaign-<pid>`, the entry point's removal names only that by its resolved path, and the project copy ignores the whole temp tree. Re-run on this branch as the review asked, with the keep on the first run, which is the case that showed the copy leak: `bun run mutate -- --mutate=src/lines.ts --cleanTempDir=false` beside `bun run mutate -- --mutate=src/fs.ts`, both on the shipped config. The first read 297 project files, ran its 9 mutants to exit 0 in 3 minutes 51 seconds with zero errors and kept `.stryker-tmp/campaign-198708/sandbox-vOSO9Y`; the second, started 42 seconds into the first with that live sandbox already on disk, read the same 297 files, held no nested `.stryker-tmp` in its own 297-file sandbox, and left the first's tree standing when it finished. Before the `ignorePatterns` line the same probe took the read to 298 files and copied the sibling tree into the new sandbox, and a kept sandbox was copied whole by every campaign after it. The pair was also run here on a `.stryker-tmp` both shared, before the per-campaign dir: the run that finished first removed the whole tree while the other was still testing, and that other one reported 3 of its 9 mutants as errors | Passed |
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
- **The state split (issue #202, ADR 0095) has had no campaign at all.** The
  nine aggregate modules, `store.ts`, `graph.ts`, `tables.ts`, and `batch.ts` are
  in the `src/**/*.ts` scope, so a future whole-`src` run will instrument them,
  but no mutant has been run against them: this branch was gated by `bun run
  test`, `bun run typecheck`, and `bun run lint` only. The suite it gated is
  2,593 tests over 114 files, against the 1,919 tests over 79 files this record's
  rates were measured on, so every time and mutant-count number above is out of
  date for the current tree. Nine of the branch's guards were each confirmed by
  hand - the guard was mutated, the named test went red, and the guard was put
  back: the import door, the table matcher, the matcher's reading of a
  schema-qualified name (`FROM main.tickets` read as `tickets`), the
  one-transaction rule in each of its shapes (a published internal method, an
  interface method another aggregate calls, and the private method behind them),
  the two alias rules (an aggregate bound to another name, and a distinctive
  method called on another receiver), the batched seat-name read, the Handoff
  limit rule's no-restatement check, and the failed rollback's kept cause. That
  is not a campaign, and it covers no other module.
  The #202 review's rework added four guards, and how each was measured differs:
  the transitive reading of the one-transaction rule was confirmed by hand the
  same way - a published internal method made to call `this.settleHandoff`, both
  transaction tests red, the call removed again - and it keeps two probe tests
  that run the rule over synthetic module sources. The derived-table alias case,
  the per-file reading of the bare-method-name rule, and the interface reach rule
  are measured by tests in the suite (`test/state/seam.test.ts` and
  `test/state-architecture.test.ts`), not by hand. No campaign has been run over
  any of them.
- **The #202 review's second rework added three guards and took five methods off
  the interfaces.** How each was measured, and what was not:
  - The method-value rule - a destructured entry, a `.bind`, a method handed to a
    function as a value - is held by three probe sources in
    `test/state-architecture.test.ts`. The destructured probe was seen red before
    the rule that names it was written, and green once the rule read it. A probe is
    a synthetic source, not a mutant.
  - The top-up walk's read-shape rule was confirmed by hand: `queueItemStands` put
    back to a per-candidate `this.state.workQueue.hasWorkItem(...)` in
    `src/observation.ts`, `the auto top-up's walk takes its per-Ticket facts from
    one read of the list` red, the batched read put back and the file green.
  - The batched restart facts are held by two new cases in
    `test/state/reads.test.ts`, and each was confirmed by hand. `handoffCountsFor`
    made to loop `this.handoffCount` per identity turned the statement-count case
    red (7 statements for 5 in-flight Tickets and for 300, where the loop costs
    three per Ticket); `handoffCountsFor` made to answer a count one higher than
    `handoffCount` turned the answer-equality case red, which is the case that
    refuses a batch answering something other than what the per-Ticket read answered.
  - The five removed methods left no call behind: `bun run typecheck` is the gate
    that refuses a leftover call, and it passed with each removal in place. The
    interface reach rule's recorded no-caller list was seen to report exactly one
    method after the removals, `ticketWorkCycle.ignoredTickets`, down from seven.
  - No campaign has been run over any of them.
- **The suite's load flake, recorded.** At `e12fa8ee` the #202 review ran the full
  suite twice and `test/repo-init-stub.test.ts > the TUI walk of the init (ADR 0075)`
  failed in one of those two runs and passed when the file ran alone. By this repo's
  triage rule that is a load flake, not a regression, and it is recorded as evidence
  rather than as a pass. On the rework head the full suite ran twice more on this
  32-core machine - 2,593 tests over 114 files, 39.83 seconds and 39.68 seconds, 0
  failures both times - with no other `bun test` process on the machine and a load
  average of 10 to 12 from other work. The flake was not seen again in those runs.
  Nothing was quarantined, no retry was added, and no bound was changed; the record
  is the measurement, and the file is not claimed as flake-free.
- **One wiring probe survived, and it names an equivalent fact, not a missing
  test.** Dropping the restart walk's read of the queue's own item -
  `queueItemStands: false` in `src/observation.ts` - leaves the whole suite green.
  The reason is structural rather than a hole in the tests: the cycle gate reads
  the queue's depth first and closes the top-up whenever the queue holds any item,
  so the walk never runs with a standing item, so the value the walk hands the rule
  is false on every cycle the plane can reach. `test/top-up.test.ts` covers the
  fact on the rule, where it is reachable. The #202 review's rework adds
  `test/observation.test.ts > the open dispatch > the restart walk holds no item
  the queue already holds`: it plants a Work queue item for the in-flight candidate
  the walk would otherwise restart, holds the cycle to no dispatch and no second
  item, then drains the item and reads the restart add on the next cycle. That test
  holds the wiring and the fact's effect on the walk; it stays green against the
  same probe, which is what a fact the plane cannot make true looks like. The
  `queueItemStands` value now comes from the Work queue read the cycle gate already
  pays for, so the walk carries no stale fact of its own across cycles, and
  `test/state-architecture.test.ts` refuses a per-candidate read of either of the
  walk's two facts. The new wiring test does reach the fact through the walk: with
  the cycle gate's `queueDepth === 0` term also removed - `topUpCycleOpen` made to
  answer `true` - the same `queueItemStands: false` turned
  `the restart walk holds no item the queue already holds` red. Measured, then both
  put back. The single-mutant survival is the gate covering for the fact, not a hole
  where the wiring is untested. The three sibling probes - the episode mark, the
  ignore flag, and the source re-verify - each turned at least one named test red. `src/domain/top-up.ts`, the top-up's new gate rules, is in the same scope
  and has had no mutant run against it either. `test/state-architecture.test.ts` was added to
  `ignorePatterns` for the reason the shared control test is there - it reads the
  state modules as text - and that exclusion is a reading of the existing rule,
  not a measured run: no campaign has been executed on this branch to confirm the
  initial run's test count drops by the file's cases.
- **The coverage-bleed warnings were read, not resolved.** The initial run reports
  mutant coverage recorded outside any test for module-level code, and names one
  mutant id for the whole set. Stryker's static-mutant handling (all tests for
  that mutant) covers the case, so attribution for those mutants is coarse rather
  than wrong. It was not verified that no other mutant lost a killer this way.
