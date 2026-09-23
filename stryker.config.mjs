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
	// The shared control architecture test reads production source as text and
	// counts the shapes it finds. Instrumentation rewrites exactly those
	// shapes, so under mutation the test fails on a text change rather than on
	// a behavior change: it would kill every mutant in every file it reads and
	// inflate the score it reports. It stays in `bun run test`, which reads the
	// uninstrumented tree.
	ignorePatterns: [".codegraph", ".pi", "test/shared-control-architecture.test.ts"],
	reporters: ["clear-text", "progress", "html"],
	tempDirName: ".stryker-tmp",
	cleanTempDir: "always",
	// One `bun test` child holds about 250 MB resident and runs its tests one at
	// a time, so a campaign peaks near this number times 250 MB. Measured on 32
	// cores: 8 workers ran 814 mutants of session-record and domain logic (10
	// tests per mutant on average) in 11 minutes, and 16 workers ran 913 mutants
	// of the shared control library (47 tests per mutant on average) in 22
	// minutes. The campaign is CPU-bound before it is memory-bound, so raise
	// this on a machine that is doing nothing else, not because the children
	// need room.
	concurrency: 8,
	// A mutant run may take no longer than the time its own covering tests
	// took in the initial run plus this slack. The slack bounds how long a
	// mutant that hangs a test - a loop whose end test was removed, a promise
	// that is never awaited - costs the campaign before it is reported as a
	// timeout.
	timeoutMS: 60_000,
	bun: {
		// The plugin's kill bound for one `bun test` child, and the bound that
		// governs the initial run: the plugin adds a fixed 30 seconds for its
		// inspector drain and holds this one number for the initial run and for
		// every mutant run, and it does not use core's own `dryRunTimeoutMinutes`
		// for the initial run. So it has to clear the initial run, which measures
		// 3 minutes 31 seconds here (see the ADR), while Stryker's `timeoutMS`
		// above is what cuts off a mutant run that hangs. The plugin also answers
		// a child that outlives its parent and signals the whole process group on
		// a kill, so a timed-out mutant leaves no `bun test` behind.
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
