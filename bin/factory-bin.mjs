#!/usr/bin/env node
/**
 * The published bin: it installs and runs the prebuilt binary.
 *
 * The control plane runs as the standalone executable the release build
 * compiles with `bun build --compile` (ADR 0056). The binary needs neither
 * Node nor Bun on the operator's machine, so the npm package no longer
 * carries the app: it carries this launcher and the install decisions in
 * src/binary-install.mjs. The launcher resolves the machine's target, takes
 * this package version's binary from the release's GitHub Release, verifies
 * it against the release's checksum file, caches it under the data home,
 * and hands it the operator's arguments.
 *
 * A second run finds the cached binary and the install note beside it, and
 * skips the network. Every decision - the target, the cache reuse, the
 * download, the verification, the exec, and what the run ends with - lives in
 * src/binary-install.mjs, where the unit tests pin it with a fake network and
 * a fake child process. This file is the machine's facts, the entry guard, and
 * the process exits only.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInstaller } from "../src/binary-install.mjs";

const require = createRequire(import.meta.url);

/** The machine's facts, as the install decisions read them. */
function processFacts() {
	const header = process.report.getReport().header;
	return {
		platform: process.platform,
		arch: process.arch,
		glibc: typeof header.glibcVersionRuntime === "string",
		homedir: homedir(),
		xdgDataHome: process.env.XDG_DATA_HOME,
		localAppData: process.env.LOCALAPPDATA,
	};
}

/**
 * Whether this file is the process's entry.
 *
 * Node names its entry in `process.argv[1]` by the path it was asked to run,
 * which for a package bin is the symlink npm wrote in `node_modules/.bin`,
 * while the module URL of this file is realpath'ed. Both sides are resolved
 * to their real paths here: an unmatched guard skips the run section, and the
 * `factory` command ends silently having installed nothing and printed
 * nothing - the shape the npm bin shim takes, not the shape `npx` hands over
 * an absolute real path.
 */
function isProcessEntry() {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return resolve(realpathSync(fileURLToPath(import.meta.url))) === resolve(realpathSync(entry));
	} catch {
		// An entry path this process cannot stat is not this file.
		return false;
	}
}

async function main() {
	const outcome = await runInstaller({
		facts: processFacts(),
		version: require("../package.json").version,
		argv: process.argv.slice(2),
	});
	if (outcome.kind === "fail") {
		process.stderr.write(`mlsf: ${outcome.line}\n`);
		process.exit(1);
	}
	if (outcome.kind === "signal") {
		try {
			process.kill(process.pid, outcome.signal);
		} catch {
			process.exit(1);
		}
		return;
	}
	process.exit(outcome.code);
}

if (isProcessEntry()) {
	await main();
}
