// StrykerJS mutation testing on the Bun test runner (ADR 0055, issue #94).
//
// Run it with `bun run mutate`; extra arguments forward to Stryker, so
// `bun run mutate -- --dryRunOnly` measures the budget of one full test run
// and `bun run mutate -- "--mutate=src/domain/**"` narrows the campaign to one
// directory. The command takes hours over the whole of `src`: the measured
// budget, the scope rules, and the reason each knob below is what it is are in
// ADR 0055, in docs/development/mutation-testing.md, and in the verification
// record beside it.
//
// Stryker's host process and every test child run on Bun, so the campaign
// needs no Node install: the code under test executes on the same runtime the
// control plane runs on.
export default {
	// The community Bun test-runner plugin. Stryker's own scope publishes no
	// Bun runner (stryker-mutator/stryker-js#5424), and the generic `command`
	// runner cannot report per-test coverage, which would put a full test run
	// behind every one of the 26,177 mutants this scope holds. This plugin
	// spawns `bun test` per mutant and correlates tests to mutants over Bun's
	// inspector protocol, so a mutant run executes only the tests that covered
	// that mutant.
	plugins: ["@hughescr/stryker-bun-runner"],
	testRunner: "bun",
	coverageAnalysis: "perTest",
	mutate: [
		"src/**/*.ts",
		// The shared control gallery is a development preview surface: the module
		// holds the example list the gallery walks, `bun run gallery` is its only
		// caller, and no shipped behavior reads it. It holds 1,116 of the 27,293
		// mutants in `src` - 4 percent of the campaign from one module - and it
		// imports the whole control library, so they reach the frame tests.
		"!src/components/shared/gallery.ts",
	],
	ignorePatterns: [
		// The temp tree, which is where every campaign's sandbox lives. Core
		// excludes the temp dir from the project copy by matching the one
		// `tempDirName` it was handed (`fs/project-reader.js` builds its ignore
		// rules as ALWAYS_IGNORE plus `tempDirName`), and `scripts/mutate.sh`
		// moves each campaign one level deeper so two campaigns in one checkout
		// cannot delete each other's tree. The rule then names
		// `.stryker-tmp/campaign-<pid>` and matches nothing above it, so without
		// this line a campaign walks and copies a sibling campaign's sandbox into
		// its own - measured on this branch, one planted
		// `.stryker-tmp/probe-sibling/sandbox-ABC/deep/probe.txt` took the project
		// read from 297 files to 298 and reappeared inside the new sandbox, and a
		// sandbox kept by `--cleanTempDir=false` is copied whole by every campaign
		// after it. Measured with this line here: the same probe leaves the read at
		// 297 files and reaches no sandbox.
		".stryker-tmp",
		// This checkout's code-index directory - 38 MB in the main worktree, and
		// rewritten while a campaign runs. The suite never reads it.
		".codegraph",
		// The Agent session data a worktree carries. Also not a test input.
		".pi",
		// The shared control architecture test reads production source as text and
		// counts the shapes it finds. Instrumentation rewrites exactly those
		// shapes, so under mutation the test fails on a text change rather than on
		// a behavior change: it would kill every mutant in every file it reads and
		// inflate the score it reports. It stays in `bun run test`, which reads the
		// uninstrumented tree.
		"test/shared-control-architecture.test.ts",
	],
	// "json" is the machine-readable report: a future `break` gate and any
	// campaign-to-campaign diff read `reports/mutation/mutation.json`, so it is
	// written beside the HTML one rather than reconstructed from the terminal.
	reporters: ["clear-text", "progress", "html", "json"],
	// The base of the campaign's working tree. `scripts/mutate.sh` hands Stryker a
	// `--tempDirName` under it for each run, so a campaign cleans its own dir and
	// not a sibling campaign's; this value is what a direct `stryker run` uses.
	// The tree it names is copied away from, not into: `.stryker-tmp` is in
	// `ignorePatterns` above, because core only auto-excludes the one name it is
	// handed.
	tempDirName: ".stryker-tmp",
	// "always": the sandbox goes even when a mutant run ends the campaign badly.
	// The entry point's own removal covers the case this cannot: a child that dies
	// on a native crash never reaches Stryker's JavaScript cleanup.
	cleanTempDir: "always",
	// A quarter of the machine's logical cores, floored at one: Stryker turns the
	// percentage into `max(1, round(cores * 25 %))` (concurrency-token-provider.js),
	// which is the measured 8 on the 32-core machine these numbers come from and
	// holds a smaller machine at its own scale. One `bun test` child holds about
	// 250 MB resident and runs its tests one at a time, so a campaign peaks near
	// this number times 250 MB. Measured on 32 cores: 8 workers ran 814 mutants of
	// session-record and domain logic (10 tests per mutant on average) in 11
	// minutes, and 16 workers ran 913 mutants of the shared control library (47
	// tests per mutant on average) in 22 minutes. The campaign is CPU-bound before
	// it is memory-bound, so raise the share on a machine that is doing nothing
	// else, not because the children need room.
	concurrency: "25%",
	// The initial run is the whole suite in one instrumented serial process, and
	// core bounds it: Stryker wraps every test runner in its TimeoutDecorator and
	// races this number against the dry run (3-dry-run-executor.js, then
	// timeout-decorator.js). 10 minutes, not the 5-minute default, because the
	// measured run is 3 minutes 31 seconds: the default would leave about 85
	// seconds of headroom on a machine this record calls busy. Measured here:
	// `--dryRunTimeoutMinutes=0.5` cut the initial run at 30 seconds with
	// `bun.timeout` still at 300_000. The initial run's real bound is the tighter
	// of this number and the plugin's child bound below, so with 10 minutes here
	// it is the plugin's 330 seconds that governs.
	dryRunTimeoutMinutes: 10,
	// The fixed part of a mutant run's bound: core plans it as
	// `timeoutFactor * netTime + timeoutMS + overhead` (mutant-test-planner.js),
	// where `netTime` is what that mutant's own covering tests took in the initial
	// run and `timeoutFactor` is core's own 1.5. So this is a flat slack on top of
	// that, and it bounds how long a mutant that hangs a test - a loop whose end
	// test was removed, a promise that is never awaited - costs the campaign
	// before the run is reported as a timeout. The plugin's child kill below
	// bounds the same run from the other side.
	timeoutMS: 60_000,
	bun: {
		// The plugin's kill bound for one `bun test` child. It holds this one number
		// for a mutant run, and the initial run gets it plus a fixed 30 seconds the
		// plugin allows itself for the inspector drain (dist/index.js: `timeout:
		// this.timeout + DRAIN_ACK_ABSOLUTE_CEILING_MS`), so 300_000 here is a 330
		// second bound on the initial run and a 300 second one on each mutant run.
		// `dryRunTimeoutMinutes` above is core's own second bound on the initial
		// run, and the tighter of the two governs. Measured directly: an initial run
		// with `bun.timeout` at 30 seconds died at 61 seconds, and one with
		// `--dryRunTimeoutMinutes=0.5` died at 30 seconds with this value at
		// 300_000. Underneath both, Stryker's plan above is what cuts a mutant run
		// that hangs. The plugin also answers a child that outlives its parent and
		// signals the whole process group on a kill, so a timed-out mutant leaves no
		// `bun test` behind.
		timeout: 300_000,
	},
	thresholds: {
		// Report colors only. There is no `break` threshold yet: the plane has
		// no whole-`src` baseline to gate on, and a gate invented from one
		// directory's score would fail the first time it was checked.
		high: 80,
		low: 60,
	},
};
