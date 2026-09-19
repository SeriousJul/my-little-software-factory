#!/usr/bin/env node
/**
 * The alias launcher.
 *
 * It reads the main package's own bin declaration and re-execs that bin under
 * Bun with the operator's arguments, so `npx mlsf` and
 * `npx my-little-software-factory` are the same command. The alias adds no
 * behavior of its own. The control plane runs on Bun, so the launcher looks
 * Bun up on PATH and hands the main bin to it; without Bun it says so instead
 * of dying inside the native core.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const mainPkgPath = require.resolve("my-little-software-factory/package.json");
const mainPkg = require(mainPkgPath);
const realBin = join(dirname(mainPkgPath), mainPkg.bin.factory);

/** The first bun on PATH, or null: the main bin runs only on Bun. */
function findBun() {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, "bun");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const bun = findBun();
if (bun === null) {
	process.stderr.write(
		"mlsf: the control plane runs on Bun, but bun was not found on PATH.\n" +
			"Install Bun from https://bun.sh and try again.\n",
	);
	process.exit(1);
}

const child = spawn(bun, [realBin, ...process.argv.slice(2)], {
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
		// Drop the handlers before re-raising. With a listener still
		// registered, the re-raise below re-enters this handler and loops at
		// full CPU instead of killing the launcher, leaving the child an orphan.
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
			process.removeAllListeners(name);
		}
		// Raise the same signal on the launcher so it dies from it, as the
		// child does.
		process.kill(process.pid, signal);
	});
}
