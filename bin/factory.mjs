#!/usr/bin/env node
/**
 * Standalone bin wrapper for the control plane.
 *
 * Node 26 still gates node:ffi, which the OpenTUI renderer loads, behind
 * --experimental-ffi. A bin launch does not carry that flag, so this wrapper
 * re-runs the entry module with it on.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/factory.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-ffi", entry, ...process.argv.slice(2)], {
	stdio: "inherit",
});
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});
// The wrapper spawns the entry as its own child. A signal to the wrapper
// must reach the child, or the child outlives the wrapper as an orphan.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill(signal);
			} catch {
				// The child exited between the check and the kill.
			}
		}
		// Raise the same signal on the wrapper so it dies from it, as the
		// child does.
		process.kill(process.pid, signal);
	});
}
