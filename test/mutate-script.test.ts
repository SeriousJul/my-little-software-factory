/**
 * Regression test at the mutation harness boundary (issue #94, ADR 0055).
 *
 * `bun run mutate` is the campaign's only entry. It forwards its arguments to
 * Stryker, and it must refuse to start a campaign the runtime cannot support:
 * the Bun test-runner plugin reads the inspector's TestReporter events to tie a
 * mutant to the tests that covered it, and an older Bun has no such events, so
 * the campaign would fail in ways that read like a broken suite.
 *
 * The child `bun` here is a shim that records its call instead of running a
 * campaign, so the file proves the gate and the argument forwarding in seconds.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MUTATE_SCRIPT = join(REPO_ROOT, "scripts", "mutate.sh");

let dir: string;
let shimPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "mutate-script-"));
	// The fake runtime: it answers `bun --version` with the version under test
	// and records any other invocation rather than starting a campaign.
	shimPath = join(dir, "bin");
	mkdirSync(shimPath, { recursive: true });
	writeFileSync(
		join(shimPath, "bun"),
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_BUN_VERSION}"; exit 0; fi
echo "fake-bun-call: $*" >&2
# A campaign leaves its sandbox behind when it dies before its own cleanup,
# which is the case the entry point's removal covers.
mkdir -p .stryker-tmp/sandbox-fake
echo mutant > .stryker-tmp/sandbox-fake/src.ts
exit 0
`,
		"utf8",
	);
	chmodSync(join(shimPath, "bun"), 0o755);
});

afterAll(() => {
	rmSync(join(REPO_ROOT, ".stryker-tmp"), { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

/** Run the campaign entry with a fake `bun` of the given version on the PATH. */
function runMutate(bunVersion: string, args: string[]) {
	return spawnSync("bash", [MUTATE_SCRIPT, ...args], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${shimPath}:${process.env.PATH ?? ""}`,
			FAKE_BUN_VERSION: bunVersion,
		},
	});
}

describe("the mutation campaign entry", () => {
	it("refuses a Bun older than the inspector events the runner reads", () => {
		const run = runMutate("1.3.0", ["--dryRunOnly"]);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("needs Bun 1.3.7 or newer");
		expect(run.stderr).toContain("this machine has 1.3.0");
		// The gate stands before the guard: no campaign process started at all.
		expect(run.stderr).not.toContain("fake-bun-call:");
	});

	it("takes a patch below the floor and a patch above it", () => {
		expect(runMutate("1.2.99", []).status).toBe(1);
		expect(runMutate("1.3.6", []).status).toBe(1);
		expect(runMutate("1.4.2", []).status).toBe(0);
		expect(runMutate("2.0.0", []).status).toBe(0);
	});

	it("starts the campaign on a supported Bun and forwards every argument", () => {
		const run = runMutate("1.3.7", ["--mutate=src/lines.ts", "--dryRunOnly"]);
		expect(run.stderr).not.toContain("needs Bun");
		// The fake runtime records Stryker's own call: the config's resolved
		// entry point, the `run` command, and the caller's arguments intact.
		expect(run.stderr).toContain(
			"fake-bun-call: node_modules/@stryker-mutator/core/bin/stryker.js run --mutate=src/lines.ts --dryRunOnly",
		);
		expect(run.status).toBe(0);
	});

	it("removes the sandbox the campaign left behind", () => {
		runMutate("1.4.2", []);
		expect(existsSync(join(REPO_ROOT, ".stryker-tmp"))).toBe(false);
	});

	it("keeps the sandbox when the caller asked Stryker to keep it", () => {
		runMutate("1.4.2", ["--cleanTempDir=false"]);
		expect(existsSync(join(REPO_ROOT, ".stryker-tmp", "sandbox-fake"))).toBe(true);
		rmSync(join(REPO_ROOT, ".stryker-tmp"), { recursive: true, force: true });
	});
});
