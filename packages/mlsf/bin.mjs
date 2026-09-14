#!/usr/bin/env node
/**
 * The alias launcher.
 *
 * It reads the main package's own bin declaration and re-execs that bin with
 * the operator's arguments, so `npx mlsf` and `npx my-little-software-factory`
 * are the same command. The alias adds no behavior of its own, and it keeps
 * no copy of the version floor: the main bin checks the Node version
 * itself.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const mainPkgPath = require.resolve("my-little-software-factory/package.json");
const mainPkg = require(mainPkgPath);
const realBin = join(dirname(mainPkgPath), mainPkg.bin.factory);
const child = spawn(process.execPath, [realBin, ...process.argv.slice(2)], {
	stdio: "inherit",
});
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});
// The launcher spawns the real bin as its own child. A signal to the
// launcher must reach the child, or the child outlives it as an orphan.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill(signal);
			} catch {
				// The child exited between the check and the kill.
			}
		}
		// Raise the same signal on the launcher so it dies from it, as the
		// child does.
		process.kill(process.pid, signal);
	});
}
