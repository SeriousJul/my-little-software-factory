#!/usr/bin/env node
/**
 * Standalone bin wrapper for the control plane.
 *
 * Node 26 still gates node:ffi, which the OpenTUI renderer loads, behind
 * --experimental-ffi. A bin launch does not carry that flag, so this wrapper
 * re-runs the entry module with it on.
 *
 * The Node floor is checked here, before the spawn, and with a helper the
 * old runtimes can still load: an operator on a Node below the floor gets
 * the required version and the reason, not a stack trace from the entry.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from "../src/node-support.mjs";

if (!isSupportedNodeVersion(process.versions.node)) {
	process.stderr.write(unsupportedNodeVersionMessage(process.versions.node));
	process.exit(1);
}

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
		// Drop the handlers before re-raising. With a listener still
		// registered, the re-raise below re-enters this handler and loops at
		// full CPU instead of killing the wrapper, leaving the child an orphan.
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
			process.removeAllListeners(name);
		}
		// Raise the same signal on the wrapper so it dies from it, as the
		// child does.
		process.kill(process.pid, signal);
	});
}
