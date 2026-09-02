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
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		/**
		 * The heaviest test in the suite measured 4804 ms in a full parallel
		 * run. Six times that is the budget, so a busy machine has room and a
		 * broken one still fails inside half a minute.
		 */
		testTimeout: 30000,
	},
});
