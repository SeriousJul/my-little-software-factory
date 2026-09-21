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
 * A second run finds the cached binary and the version note beside it, and
 * skips the network. The pure decisions live in src/binary-install.mjs,
 * where the unit tests pin them; this file is the run section only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	binaryNameFor,
	installDirFor,
	installVerified,
	needsInstall,
	sidecarPathFor,
	TARGETS,
	targetIdFor,
} from "../src/binary-install.mjs";

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

/** The message of an error, without the `Error:` prefix the value carries. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The version note beside the binary, or undefined where it is missing or empty. */
function sidecarVersion(sidecarPath) {
	try {
		const text = readFileSync(sidecarPath, "utf8").trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * The run section: it runs only when this file is the process's entry, so a
 * test can import the module's decisions without starting an install.
 */
async function run(argv) {
	const facts = processFacts();
	const targetId = targetIdFor(facts);
	if (targetId === null) {
		process.stderr.write(
			`mlsf: the control plane has no binary for ${facts.platform}-${facts.arch}; ` +
				`supported targets: ${TARGETS.join(", ")}\n`,
		);
		process.exit(1);
	}
	const version = require("../package.json").version;
	const dir = installDirFor(facts);
	const binaryPath = join(dir, binaryNameFor(targetId));
	const sidecarPath = sidecarPathFor(binaryPath);

	const install = needsInstall({
		binaryExists: existsSync(binaryPath),
		sidecarVersion: sidecarVersion(sidecarPath),
		wantedVersion: version,
	});
	if (install) {
		try {
			await installVerified({ version, targetId, dir, platform: facts.platform });
		} catch (error) {
			process.stderr.write(`mlsf: ${errorMessage(error)}\n`);
			process.exit(1);
		}
	}

	const child = spawnSync(binaryPath, argv, { stdio: "inherit" });
	if (child.error !== null && child.error !== undefined) {
		process.stderr.write(
			`mlsf: cannot run the control plane binary at ${binaryPath}: ${errorMessage(child.error)}\n`,
		);
		process.exit(1);
	}
	// The child took the operator's signal: end this process the same way,
	// the shape the old alias process forwarded.
	if (child.signal !== null && child.signal !== undefined) {
		try {
			process.kill(process.pid, child.signal);
		} catch {
			process.exit(1);
		}
		return;
	}
	process.exit(child.status ?? 1);
}

// The entry test: Node names its entry in process.argv[1], and an imported
// module does not, so the run section stays off while a test imports here.
const entry = process.argv[1];
if (entry !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(entry)) {
	await run(process.argv.slice(2));
}
