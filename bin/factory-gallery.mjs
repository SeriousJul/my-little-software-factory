#!/usr/bin/env node
/**
 * Standalone bin wrapper for the shared control gallery.
 *
 * Node 26 still gates node:ffi, which the OpenTUI renderer loads, behind
 * --experimental-ffi, and a bin launch does not carry that flag, so this
 * wrapper re-runs the gallery entry with it on. The control plane's own bin
 * does the same for the same reason.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/gallery.ts", import.meta.url));
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
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill(signal);
			} catch {
				// The child exited between the check and the kill.
			}
		}
		process.kill(process.pid, signal);
	});
}
