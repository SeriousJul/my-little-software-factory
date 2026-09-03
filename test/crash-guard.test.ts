/**
 * Regression test at the crash containment boundary.
 *
 * The suite spawns `node factory.ts` children. When a runner process dies
 * on a native crash (the node 26.5.0 node:sqlite use-after-free under
 * Stryker is the known case), those children are left orphaned under
 * systemd and the OS records a crash report for every death. The crash
 * guard wraps the run: it disables core files for the whole process tree
 * and terminates every survivor when the command exits, by success,
 * failure, or crash. This test drives the guard with a fake command that
 * crashes and leaves a child behind, the exact topology of the incident.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GUARD_SCRIPT = fileURLToPath(new URL("../scripts/crash-guard.sh", import.meta.url));
const WORKLOAD_PATH = join(tmpdir(), "crash-guard-workload.cjs");

/**
 * The fake workload. It spawns a long-lived child that survives the
 * workload's own death, records the child's pid and the workload's core
 * file limit, then dies in the requested mode:
 * - crash: process.abort(), the shape of a native crash (SIGABRT).
 * - clean: a normal exit 0.
 * - fail: a normal exit 7.
 * - stubborn: the child ignores SIGTERM and must be SIGKILLed.
 */
const WORKLOAD = `
const { spawn, spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const mode = process.argv[2];
const child = spawn(
	process.execPath,
	mode === "stubborn"
		? ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]
		: ["-e", "setInterval(() => {}, 1000)"],
	{ stdio: "ignore" },
);
const limit = spawnSync("bash", ["-c", "ulimit -c"]).stdout.toString().trim();
writeFileSync(process.argv[3], String(child.pid) + "\\n" + limit + "\\n");
if (mode === "crash") process.abort();
process.exit(mode === "fail" ? 7 : 0);
`;

/** One temp dir for all workloads of this test file. */
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "crash-guard-"));
	writeFileSync(WORKLOAD_PATH, WORKLOAD, "utf8");
});

interface GuardRun {
	code: number | null;
	stderr: string;
	childPid: number;
	coreLimit: string;
}

function runGuard(mode: string, infoPath: string): Promise<GuardRun> {
	return new Promise((resolve, reject) => {
		const child = spawn("bash", [GUARD_SCRIPT, process.execPath, WORKLOAD_PATH, mode, infoPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			const [pidLine, limitLine] = readFileSync(infoPath, "utf8").trim().split("\n");
			resolve({ code, stderr, childPid: Number(pidLine), coreLimit: limitLine });
		});
	});
}

/** True while the pid names a living process. */
function isAlive(pid: number): boolean {
	return spawnSync("kill", ["-0", String(pid)]).status === 0;
}

afterAll(() => {
	rmSync(WORKLOAD_PATH, { force: true });
	rmSync(dir, { recursive: true, force: true });
});

describe("crash guard, run containment", () => {
	it("reaps a surviving child after the command dies on a native crash", async () => {
		const infoPath = join(dir, "info.txt");
		const run = await runGuard("crash", infoPath);

		// The crash signal passes through: SIGABRT is 128 + 6.
		expect(run.code).toBe(134);
		// The whole tree runs with core files disabled, so the OS records
		// no crash for the death.
		expect(run.coreLimit).toBe("0");
		// The child that outlived the crash is gone.
		expect(isAlive(run.childPid)).toBe(false);
	});

	it("reaps a surviving child after a clean exit", async () => {
		const run = await runGuard("clean", join(dir, "info-clean.txt"));

		expect(run.code).toBe(0);
		expect(isAlive(run.childPid)).toBe(false);
	});

	it("passes a failure exit code through", async () => {
		const run = await runGuard("fail", join(dir, "info-fail.txt"));

		expect(run.code).toBe(7);
		expect(isAlive(run.childPid)).toBe(false);
	});

	it("kills a child that ignores SIGTERM after the grace period", async () => {
		const run = await runGuard("stubborn", join(dir, "info-stubborn.txt"));

		expect(run.code).toBe(0);
		expect(isAlive(run.childPid)).toBe(false);
	}, 30_000);
});
