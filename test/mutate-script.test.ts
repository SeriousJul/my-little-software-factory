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
 * The child `bun` is a shim that answers `bun --version` and records the call
 * rather than starting a campaign. It also stands in for Stryker's own cleanup,
 * because the entry point's rules about the sandbox only mean something against
 * a runner that has its own rules: it lays the sandbox down under the temp dir it
 * was handed, takes it back down on a clean exit for every `--cleanTempDir` value
 * Stryker's parser reads as truthy, dies before any cleanup on the crash case,
 * and records the path of the tree it left. So a kept sandbox is a sandbox this
 * entry point had to leave alone, and a removed one is a removal this entry point
 * made.
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
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import STRYKER_CONFIG from "../stryker.config.mjs";

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
	// The fake runtime and the fake campaign. It names the working directory it
	// was called from (the tree the entry point resolved from its own location,
	// and therefore the tree its cleanup removes) and the call Stryker received,
	// then behaves like core's `TemporaryDirectory`: it lays a sandbox in the temp
	// dir it was handed, and on a clean exit takes it down for exactly the
	// `--cleanTempDir` values core's parser reads as truthy.
	shimPath = join(dir, "bin");
	recordFile = join(dir, "fake-sandbox-record");
	mkdirSync(shimPath, { recursive: true });
	writeFileSync(
		join(shimPath, "bun"),
		`#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_BUN_VERSION}"; exit 0; fi
echo "fake-bun-cwd: $(pwd)" >&2
echo "fake-bun-call: $*" >&2
args=("$@")
temp=.stryker-tmp
clean=always
for ((i = 0; i < \${#args[@]}; i++)); do
	a="\${args[i]}"
	case "$a" in
		--tempDirName=*) temp="\${a#--tempDirName=}" ;;
		--tempDirName) temp="\${args[i + 1]:-}"; i=$((i + 1)) ;;
		--cleanTempDir=*) clean="\${a#--cleanTempDir=}" ;;
		--cleanTempDir) clean="\${args[i + 1]:-}"; i=$((i + 1)) ;;
	esac
done
rm -f "$FAKE_SANDBOX_RECORD"
mkdir -p "$temp/sandbox-fake"
echo mutant > "$temp/sandbox-fake/src.ts"
echo "$temp/sandbox-fake" > "$FAKE_SANDBOX_RECORD"
# The campaign this one stands in for dies on a native fault: it never reaches
# any JavaScript of its own, so nothing here is cleaned but by the entry point.
if [ "\${FAKE_STYKER_CRASHES:-0}" = 1 ]; then kill -SEGV $$; fi
# core's own cleanup, on the clean path only. parseCleanDirOption reads only
# 'false' and '0' as false, and stryker.config.mjs ships 'always', so an absent
# --cleanTempDir deletes too. core then drops the temp dir it was handed once
# nothing else lives in it, which is what leaves the tree above it standing.
case "\${clean,,}" in
	false | 0) ;;
	*) rm -rf "$temp/sandbox-fake"; rmdir "$temp" 2>/dev/null ;;
esac
exit 0
`,
		"utf8",
	);
	chmodSync(join(shimPath, "bun"), 0o755);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the campaign entry inside this file's tree with a fake `bun` on the PATH.
 * `crashed` stands for a campaign that dies before it reaches its own cleanup,
 * which is the case the entry point's removal exists for.
 */
function runMutate(bunVersion: string, args: string[], crashed = false) {
	return spawnSync("bash", [mutateScript, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: mutateEnv(bunVersion, strykerStub, crashed),
	});
}

/** Run the campaign entry from another directory, to see which one it resolves. */
function runMutateFrom(cwd: string) {
	return spawnSync("bash", [mutateScript], {
		cwd,
		encoding: "utf8",
		env: mutateEnv("1.4.2", strykerStub, false),
	});
}

/**
 * The environment one entry run sees: this file's fake `bun` first on the PATH,
 * the version it reports, this file's stub Stryker entry point, the record file
 * the fake writes the path of its own sandbox into, and whether that campaign
 * dies before its own cleanup.
 */
function mutateEnv(bunVersion: string, strykerBin: string, crashed: boolean): NodeJS.ProcessEnv {
	return {
		...process.env,
		PATH: `${shimPath}:${process.env.PATH ?? ""}`,
		FAKE_BUN_VERSION: bunVersion,
		STRYKER_BIN: strykerBin,
		FAKE_SANDBOX_RECORD: recordFile,
		FAKE_STYKER_CRASHES: crashed ? "1" : "0",
	};
}

/**
 * Where the last fake campaign laid its sandbox, as a path inside this file's
 * tree, or null when that sandbox is gone: removed by the entry point, removed by
 * the fake's own core-style cleanup, or never written because the campaign never
 * started.
 */
function recordedSandbox(): string | null {
	if (!existsSync(recordFile)) {
		return null;
	}
	const sandbox = readFileSync(recordFile, "utf8").trim();
	return existsSync(join(dir, sandbox)) ? sandbox : null;
}

/** The tree a kept sandbox still stands in, when one does. */
function sandboxSurvives(): boolean {
	return recordedSandbox() !== null;
}

/** The `--tempDirName` the entry point handed Stryker, if it handed one. */
function tempDirOf(run: { stderr: string }): string | undefined {
	return run.stderr.match(/--tempDirName=(\S+)/)?.[1];
}

/**
 * The campaign temp dir the entry point names when the caller does not name one,
 * read out of the script itself rather than repeated here: the two must agree,
 * and this file is the check that they do.
 */
function scriptCampaignTempDir(): string {
	const line = readFileSync(mutateScript, "utf8").match(/^temp_dir="([^"]+)"/m);
	if (!line?.[1]) {
		throw new Error("mutate.sh names no default campaign temp dir");
	}
	// The `$$` is this process's id at run time; the tree it lands in is what
	// matters here.
	return line[1].replace(/\$\$/, "1");
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
			env: mutateEnv("1.4.2", join(dir, "no-such-stryker.js"), false),
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
		expect(runMutate("1.4.2", [], true).status).not.toBe(0);
		expect(existsSync(join(sibling, "src.ts"))).toBe(true);
		// Its own campaign's tree is gone, and the `.stryker-tmp` parent stays
		// because it still holds that sibling.
		expect(recordedSandbox()).toBeNull();
		expect(existsSync(join(dir, ".stryker-tmp", "campaign-999999"))).toBe(true);
		clearTestTreeSandbox();
	});

	it("removes the sandbox a crashed campaign never got to clean", () => {
		// The case the trap exists for: a child that dies natively runs none of
		// Stryker's JavaScript cleanup, so nothing but this entry point takes the
		// tree down.
		clearTestTreeSandbox();
		const run = runMutate("1.4.2", [], true);
		expect(run.status).not.toBe(0);
		expect(recordedSandbox()).toBeNull();
		// The campaign's dir is gone, and with nothing else in it the parent went
		// too.
		expect(existsSync(join(dir, ".stryker-tmp"))).toBe(false);
	});

	it("names a tree it will not remove by its resolved path, not its text", () => {
		// The anchoring guarantee. `--tempDirName=.stryker-tmp/../victim` begins
		// with the words the entry point looks for and resolves next door to the
		// temp parent, not under it; a prefix test on the unnormalized string let
		// `..` carry `rm -rf` out of the campaign. The planted victim is the tree
		// a wrong answer would take down.
		clearTestTreeSandbox();
		const victim = join(dir, "victim");
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "keep-me.ts"), "export const tree = 1;\n", "utf8");
		const run = runMutate("1.4.2", ["--tempDirName=.stryker-tmp/../victim", "--dryRunOnly"]);
		expect(run.stderr).toContain("victim");
		expect(run.stderr).toContain("leaves its cleanup to Stryker");
		expect(existsSync(join(victim, "keep-me.ts"))).toBe(true);
		rmSync(victim, { recursive: true, force: true });
		clearTestTreeSandbox();
	});

	it("keeps the sandbox for each value that asks Stryker to keep it", () => {
		// The values Stryker's own parser reads as "do not delete the temp dir", in
		// the `=` form and in the separated form commander also accepts. The fake
		// campaign stands these down too, so a surviving tree is a tree this entry
		// point left alone and not one its runner had already taken away.
		for (const args of [
			["--cleanTempDir=false"],
			["--cleanTempDir", "false"],
			["--cleanTempDir=0"],
			["--cleanTempDir", "0"],
		]) {
			clearTestTreeSandbox();
			const run = runMutate("1.4.2", args);
			expect(run.status).toBe(0);
			expect(sandboxSurvives()).toBe(true);
			// The forwarding keeps the caller's own argument intact for Stryker.
			expect(run.stderr).toContain(`fake-bun-call: ${strykerStub} run ${args.join(" ")}`);
			expect(run.stderr).toContain("the campaign's sandbox is kept under");
		}
		clearTestTreeSandbox();
	});

	it("removes a crashed campaign's sandbox for every other value", () => {
		// The other side of the same rule: the entry point stands down only where
		// core stands down, and a crash means core never reaches its own cleanup.
		for (const args of [
			[],
			["--cleanTempDir=true"],
			["--cleanTempDir", "true"],
			["--cleanTempDir=always"],
			["--cleanTempDir", "always"],
			["--cleanTempDir=never"],
		]) {
			clearTestTreeSandbox();
			const run = runMutate("1.4.2", args, true);
			expect(run.status).not.toBe(0);
			expect(recordedSandbox()).toBeNull();
			expect(run.stderr).not.toContain("the campaign's sandbox is kept under");
		}
		clearTestTreeSandbox();
	});

	it("says what --cleanTempDir=never really asks for", () => {
		// The value whose English and whose parsed readings disagree. Stryker's
		// `parseCleanDirOption` reads `never` as truthy, so it asks core to delete
		// the temp dir; standing the trap down on it would print a keep this entry
		// point cannot deliver, because core owns the deletion. So the entry point
		// takes the tree down and says why at the gate.
		clearTestTreeSandbox();
		const run = runMutate("1.4.2", ["--cleanTempDir=never"]);
		expect(run.status).toBe(0);
		expect(run.stderr).toContain("reads --cleanTempDir=never as a request to delete");
		expect(run.stderr).toContain("--cleanTempDir=false");
		expect(run.stderr).not.toContain("the campaign's sandbox is kept under");
		// The fake took the tree down the way core does for a truthy value, and a
		// clean run leaves no promise of a sandbox to look inside.
		expect(sandboxSurvives()).toBe(false);
		clearTestTreeSandbox();
	});

	it("keeps the campaign's temp tree out of the project copy", () => {
		// Stryker takes the files it copies into its sandbox from one walk of the
		// project, and it auto-excludes only the single `tempDirName` it was handed
		// (fs/project-reader.js). The entry point hands it a campaign dir one level
		// deeper, so the tree holding every campaign needs its own ignore rule or a
		// campaign copies its siblings' sandboxes into its own: measured at 297 read
		// files rising to 298 for one planted file, and a kept sandbox is copied
		// whole by every campaign after it. This checks the config and the script
		// still agree on the one tree that has to be ignored.
		const campaign = scriptCampaignTempDir();
		const tempParent = dirname(campaign);
		expect(tempParent).toBe(".stryker-tmp");
		expect(STRYKER_CONFIG.ignorePatterns).toContain(tempParent);
		// And the name a direct `stryker run` uses sits inside it, so the same rule
		// covers that path too.
		expect(STRYKER_CONFIG.tempDirName).toBe(tempParent);
	});

	it("keeps a campaign that is live in the real worktree out of reach", () => {
		// The hazard by name. A campaign running in this checkout owns a
		// `.stryker-tmp` at the real repository root, and a probe standing in for
		// its sandbox has to survive every run this file makes. The path carries
		// this process's id, so two suites in one worktree do not share a probe.
		// A run that dies between the plant below and the `finally` leaves that
		// probe in the worktree's `.stryker-tmp`; it is inert - no process owns it
		// and the next campaign's cleanup or `rm -rf .stryker-tmp` takes it down.
		const probe = join(REPO_ROOT, ".stryker-tmp", `probe-${process.pid}-other-campaign`);
		const rootWasThere = existsSync(join(REPO_ROOT, ".stryker-tmp"));
		mkdirSync(probe, { recursive: true });
		writeFileSync(join(probe, "src.ts"), "export const mutant = 1;\n", "utf8");
		try {
			clearTestTreeSandbox();
			expect(runMutateFrom(REPO_ROOT).status).toBe(0);
			clearTestTreeSandbox();
			expect(runMutate("1.4.2", [], true).status).not.toBe(0);
			expect(existsSync(join(probe, "src.ts"))).toBe(true);
			expect(recordedSandbox()).toBeNull();
		} finally {
			rmSync(probe, { recursive: true, force: true });
			if (!rootWasThere) {
				// `rmdirSync`, not `rmSync`: it takes down an empty directory only,
				// so a campaign that started in the meantime keeps its own tree, and
				// this file has no business reaching into it. `rmSync` without
				// `recursive` throws EISDIR on a directory rather than removing it,
				// which is why the shell used to survive every run of this file.
				try {
					rmdirSync(join(REPO_ROOT, ".stryker-tmp"));
				} catch {
					// Something else lives there now. Leave it to that run.
				}
			}
		}
	});
});
