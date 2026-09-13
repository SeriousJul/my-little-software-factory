/**
 * The test runner's own settings.
 *
 * The frame tests drive a rendered terminal: the heaviest presses a dozen
 * keys, waits for each effect, and resizes the terminal on the way. Each of
 * those waits ends the moment the frame says so, so a quiet machine finishes
 * that test in well under a second, while a machine running every test file in
 * parallel takes several times longer. Vitest's 5000 ms default is a per-test
 * budget the suite cannot hold under its own load, and the failure it writes
 * ("Test timed out in 5000ms", on a test that passes alone) reads like a bug
 * in the app rather than a starved runner. One budget for the whole suite,
 * above the worst case the suite has measured, keeps a slow run slow instead
 * of red. A test whose real effect never arrives still fails: its own frame
 * wait throws at the harness's deadline first.
 */
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

/** GitHub Actions and other CI hosts set `CI` for every run. */
const ON_CI = process.env.CI !== undefined;

export default defineConfig({
	test: {
		/**
		 * The heaviest test in the suite measured 4804 ms in a parallel run
		 * at the fork cap below. Six times that is the budget, so a busy
		 * machine has room and a broken one still fails inside half a minute.
		 * CI hosts run under the same doubled load the harness deadline
		 * doubles for (see test/app-harness.ts), so the budget doubles with it.
		 */
		testTimeout: ON_CI ? 60000 : 30000,
		/**
		 * The frame tests each drive their own rendered terminal, and a
		 * machine that forks one renderer per core starves its own frames: at
		 * thirty-two workers the suite's own load pushed a wait past the
		 * harness's 10000 ms deadline on a machine that passes the same test
		 * alone. Eight workers hold the suite's load below the worst case the
		 * budgets above were measured at, on this machine and on the smaller
		 * ones the cap does not reach. A CI host can fork fewer than its
		 * nominal cores can sustain, so the cap never exceeds the machine's
		 * own parallelism.
		 *
		 * A CI host runs the same suite on a shared runner that also hosts other
		 * jobs, so its cores are not all its own: forking one renderer per core
		 * oversubscribes the runner, and a key the test sends into a surface
		 * transition is dropped while the render is starved. Two workers leave
		 * the runner headroom the frame waits and the key-handler waits hold;
		 * the suite runs about twice as long, still well under the job budget.
		 */
		maxWorkers: ON_CI ? 2 : Math.max(1, Math.min(8, availableParallelism())),
	},
});
