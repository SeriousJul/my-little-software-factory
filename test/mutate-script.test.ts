/**
 * Regression test at the mutation harness boundary (issue #94, ADR 0055).
 *
 * `bun run mutate` is the campaign's only entry. It forwards its arguments to
 * Stryker, and it must refuse to start a campaign the runtime cannot support:
 * the Bun test-runner plugin reads the inspector's TestReporter events to tie a
 * mutant to the tests that covered it, and an older Bun has no such events, so
 * the campaign would fail in ways that read like a broken suite.
 *
 * Everything here runs inside one `mkdtemp` tree. The entry point takes its own
 * directory as the repository root, changes into it, and removes that campaign's
 * temp dir there, so a copy of `scripts` in this file's own tree is what keeps
 * the run away from the real worktree: aimed at the repository root it would
 * delete the sandbox of a campaign that is live in that same tree, and a campaign
 * is 6 to 11 machine hours. The two cases that name that hazard start the entry
 * from the real repository root and check where the run actually worked.
 *
 * The child `bun` is a shim that records its call and lays down the sandbox a
 * campaign would leave, so the file proves the gate, the argument forwarding, and
 * the cleanup in seconds and without a real campaign.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

let dir: string;
let mutateScript: string;
let strykerStub: string;
let shimPath: string;
let recordFile: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "mutate-script-"));
	// The entry point's own tree: it resolves the repository root from its own
	// location, so a copy of the scripts it needs makes this directory the root
	// it works, and cleans, in.
	mkdirSync(join(dir, "scripts"), { recursive: true });
	for (const name of ["mutate.sh", "crash-guard.sh", "nondumpable.c"]) {
		copyFileSync(join(REPO_ROOT, "scripts", name), join(dir, "scripts", name));
	}
	mutateScript = join(dir, "scripts", "mutate.sh");
	// The Stryker entry point the script refuses to run without. The script reads
	// its own from `STRYKER_BIN`, so this file names a stub of its own rather than
	// depending on one third party package keeping its internal layout.
	strykerStub = join(dir, "fake-stryker.mjs");
	writeFileSync(strykerStub, "// never executed: the fake bun answers instead\n", "utf8");
	// The fake runtime. It answers `bun --version` with the version under test,
	// records any other invocation rather than starting a campaign, names the
	// working directory it was called from (the tree the entry point resolved from
	// its own location, and therefore the tree its cleanup removes), and lays down
	// the sandbox a campaign leaves behind when it dies before its own cleanup -
	// under the temp dir the campaign line names, the way Stryker would.
	shimPath = join(dir, "bin");
	recordFile = join(dir, "fake-sandbox-record");
	mkdirSync(shimPath, { recursive: true });
	writeFileSync(
		join(shimPath, "bun"),
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_BUN_VERSION}"; exit 0; fi
echo "fake-bun-cwd: $(pwd)" >&2
echo "fake-bun-call: $*" >&2
temp=.stryker-tmp
for a in "$@"; do case "$a" in --tempDirName=*) temp="\${a#--tempDirName=}" ;; esac; done
rm -f "$FAKE_SANDBOX_RECORD"
mkdir -p "$temp/sandbox-fake"
echo mutant > "$temp/sandbox-fake/src.ts"
echo "$temp/sandbox-fake" > "$FAKE_SANDBOX_RECORD"
exit 0
`,
		"utf8",
	);
	chmodSync(join(shimPath, "bun"), 0o755);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Run the campaign entry inside this file's tree with a fake `bun` on the PATH. */
function runMutate(bunVersion: string, args: string[]) {
	return spawnSync("bash", [mutateScript, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: mutateEnv(bunVersion, strykerStub),
	});
}

/** Run the campaign entry from another directory, to see which one it resolves. */
function runMutateFrom(cwd: string) {
	return spawnSync("bash", [mutateScript], {
		cwd,
		encoding: "utf8",
		env: mutateEnv("1.4.2", strykerStub),
	});
}

/**
 * The environment one entry run sees: this file's fake `bun` first on the PATH,
 * the version it reports, this file's stub Stryker entry point, and the record
 * file the fake writes the path of its own sandbox into.
 */
function mutateEnv(bunVersion: string, strykerBin: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${shimPath}:${process.env.PATH ?? ""}`,
		FAKE_BUN_VERSION: bunVersion,
		STRYKER_BIN: strykerBin,
		FAKE_SANDBOX_RECORD: recordFile,
	};
}

/**
 * Where the last fake campaign laid its sandbox, as a path inside this file's
 * tree, or null when that sandbox is gone: removed by the entry point, or never
 * written because the campaign never started.
 */
function recordedSandbox(): string | null {
	if (!existsSync(recordFile)) {
		return null;
	}
	const sandbox = readFileSync(recordFile, "utf8").trim();
	return existsSync(join(dir, sandbox)) ? sandbox : null;
}

/** The `--tempDirName` the entry point handed Stryker, if it handed one. */
function tempDirOf(run: { stderr: string }): string | undefined {
	return run.stderr.match(/--tempDirName=(\S+)/)?.[1];
}

function clearTestTreeSandbox() {
	rmSync(join(dir, ".stryker-tmp"), { recursive: true, force: true });
	rmSync(recordFile, { force: true });
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

	it("refuses a campaign it cannot start, and says what is missing", () => {
		const run = spawnSync("bash", [mutateScript], {
			cwd: dir,
			encoding: "utf8",
			env: mutateEnv("1.4.2", join(dir, "no-such-stryker.js")),
		});
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("no-such-stryker.js is missing");
		expect(run.stderr).not.toContain("fake-bun-call:");
	});

	it("starts the campaign inside its own tree, and forwards every argument", () => {
		clearTestTreeSandbox();
		const run = runMutate("1.3.7", ["--mutate=src/lines.ts", "--dryRunOnly"]);
		expect(run.status).toBe(0);
		expect(run.stderr).not.toContain("needs Bun");
		// The fake runtime records Stryker's own call: the resolved entry point,
		// the `run` command, and the caller's arguments intact and in order. The
		// entry point adds its own campaign temp dir after them.
		expect(run.stderr).toContain(
			`fake-bun-call: ${strykerStub} run --mutate=src/lines.ts --dryRunOnly`,
		);
	});

	it("resolves its repository root from its own location, not the caller's", () => {
		// The one rule that keeps `bun run test` out of a live campaign's way: the
		// entry point works, and cleans, in the tree it lives in. The campaign is
		// started from the real repository root on purpose, so a run that resolved
		// the caller's directory instead would name that root to its cleanup.
		clearTestTreeSandbox();
		const run = runMutateFrom(REPO_ROOT);
		expect(run.status).toBe(0);
		expect(run.stderr).toContain(`fake-bun-cwd: ${dir}`);
		expect(recordedSandbox()).toBeNull();
	});

	it("gives each campaign a temp dir of its own", () => {
		// Stryker's own cleanup deletes the whole temp dir it is handed, so one dir
		// shared by a checkout is two campaigns destroying each other's sandbox.
		clearTestTreeSandbox();
		const first = runMutate("1.4.2", ["--cleanTempDir=false"]);
		expect(first.status).toBe(0);
		const firstSandbox = recordedSandbox();
		expect(firstSandbox).not.toBeNull();
		expect(dirname(firstSandbox as string)).toMatch(/^\.stryker-tmp[/\\]campaign-\d+$/);
		const firstDir = tempDirOf(first);
		clearTestTreeSandbox();
		const second = runMutate("1.4.2", ["--cleanTempDir=false"]);
		const secondDir = tempDirOf(second);
		expect(secondDir).toBeDefined();
		expect(firstDir).toBeDefined();
		expect(secondDir).not.toBe(firstDir);
		clearTestTreeSandbox();
	});

	it("leaves another campaign's tree beside its own alone", () => {
		// The sibling this run must not reach: another campaign's temp dir, laid
		// down inside the same `.stryker-tmp`.
		clearTestTreeSandbox();
		const sibling = join(dir, ".stryker-tmp", "campaign-999999", "sandbox-live");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "src.ts"), "export const mutant = 1;\n", "utf8");
		expect(runMutate("1.4.2", []).status).toBe(0);
		expect(existsSync(join(sibling, "src.ts"))).toBe(true);
		// Its own campaign's tree is gone, and the `.stryker-tmp` parent stays
		// because it still holds that sibling.
		expect(recordedSandbox()).toBeNull();
		expect(existsSync(join(dir, ".stryker-tmp", "campaign-999999"))).toBe(true);
		clearTestTreeSandbox();
	});

	it("removes the sandbox the campaign left behind, in its own tree", () => {
		clearTestTreeSandbox();
		expect(runMutate("1.4.2", []).status).toBe(0);
		expect(recordedSandbox()).toBeNull();
	});

	it("keeps the sandbox for each value that asks Stryker to keep it", () => {
		// The values Stryker's own option parser reads as "never delete the temp
		// dir", in the `=` form and in the separated form commander also accepts.
		for (const args of [
			["--cleanTempDir=false"],
			["--cleanTempDir", "false"],
			["--cleanTempDir=0"],
			["--cleanTempDir", "0"],
			["--cleanTempDir=never"],
			["--cleanTempDir", "never"],
		]) {
			clearTestTreeSandbox();
			const run = runMutate("1.4.2", args);
			expect(run.status).toBe(0);
			expect(recordedSandbox()).not.toBeNull();
			// The forwarding keeps the caller's own argument intact for Stryker.
			expect(run.stderr).toContain(`fake-bun-call: ${strykerStub} run ${args.join(" ")}`);
			expect(run.stderr).toContain("the campaign's sandbox is kept under");
		}
		clearTestTreeSandbox();
	});

	it("removes the sandbox for each value that asks Stryker to delete it", () => {
		for (const args of [
			[],
			["--cleanTempDir=true"],
			["--cleanTempDir", "true"],
			["--cleanTempDir=always"],
			["--cleanTempDir", "always"],
		]) {
			clearTestTreeSandbox();
			expect(runMutate("1.4.2", args).status).toBe(0);
			expect(recordedSandbox()).toBeNull();
		}
	});

	it("keeps a campaign that is live in the real worktree out of reach", () => {
		// The hazard by name. A campaign running in this checkout owns a
		// `.stryker-tmp` at the real repository root, and a probe standing in for
		// its sandbox has to survive every run this file makes. The path carries
		// this process's id, so two suites in one worktree do not share a probe.
		const probe = join(REPO_ROOT, ".stryker-tmp", `probe-${process.pid}-other-campaign`);
		const rootWasThere = existsSync(join(REPO_ROOT, ".stryker-tmp"));
		mkdirSync(probe, { recursive: true });
		writeFileSync(join(probe, "src.ts"), "export const mutant = 1;\n", "utf8");
		try {
			clearTestTreeSandbox();
			expect(runMutateFrom(REPO_ROOT).status).toBe(0);
			clearTestTreeSandbox();
			expect(runMutate("1.4.2", []).status).toBe(0);
			expect(existsSync(join(probe, "src.ts"))).toBe(true);
			expect(recordedSandbox()).toBeNull();
		} finally {
			rmSync(probe, { recursive: true, force: true });
			if (!rootWasThere) {
				// No `recursive`: a campaign that started in the meantime keeps its
				// own tree, and this file has no business reaching into it.
				try {
					rmSync(join(REPO_ROOT, ".stryker-tmp"));
				} catch {
					// Something else lives there now. Leave it to that run.
				}
			}
		}
	});
});
