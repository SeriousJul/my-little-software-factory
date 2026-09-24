#!/usr/bin/env node
/**
 * The alias launcher.
 *
 * It reads the main package's own bin declaration and re-execs that bin under
 * Node with the operator's arguments, so `npx mlsf` and
 * `npx my-little-software-factory` are the same command. The alias adds no
 * behavior of its own. The main bin is the installer for the prebuilt
 * binary (ADR 0056): it runs on Node, and the binary it installs runs on
 * neither Node nor Bun, so the launcher hands the installer to the runtime
 * it already runs on and looks for nothing else.
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
		// Drop this signal's listener before the re-raise, or the re-raise runs
		// the handler instead of taking the default action and the exit below
		// wins the race: the shipped bin dies from the signal, and the alias has
		// to answer the same way for the same interrupt.
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
		// A signal the launcher's runtime does not act on must not end the run
		// as a success: the child died by that signal, so the launcher leaves
		// nonzero.
		process.exit(1);
	} else {
		process.exit(code ?? 1);
	}
});
// The launcher spawns the installer as its own child. A signal to the
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
		// And if the runtime swallows it, end nonzero rather than return from
		// the handler and let the launcher exit 0 with its child gone.
		process.exit(1);
	});
}
