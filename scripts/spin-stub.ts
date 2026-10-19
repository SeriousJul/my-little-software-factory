/**
 * The stub command the spin watch's end-to-end check stands beside
 * (issue #403, ADR 0138).
 *
 * Run without arguments, it stands one child of its own: this same file,
 * run with `--test-worker` in its argument list - the same list shape a
 * run's real test workers carry. That child is the spin: it holds one
 * core at full CPU inside a synchronous loop that yields nowhere, so its
 * thread makes no voluntary context switches, the signature the watch
 * reads. The stub waits on the child and reports how it died: taken down
 * by a signal, or exited on its own. The child's argument list names the
 * worker role the watch matches on, so the check stands the watch's real
 * match beside the spin it exists to take down.
 */
import { spawn } from "node:child_process";

if (process.argv.includes("--test-worker")) {
	// The spin: hold the core with a loop that yields nowhere. The loop
	// writes no state the process ever reads, so the only thing it holds
	// is the CPU share, and the only thing it makes is none of the
	// switches a healthy process makes on every event-loop turn.
	let held = 0;
	for (;;) {
		held = (held + 1) | 0;
	}
}

const self = process.argv[1];
const child = spawn(process.execPath, [self, "--test-worker"], { stdio: "ignore" });
child.on("close", (code, signal) => {
	process.stderr.write(
		`[spin-stub] the spin child ${child.pid} died: ${signal !== undefined ? `taken down by ${signal}` : `exited ${code}`}\n`,
	);
	process.exit(0);
});
