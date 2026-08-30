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
