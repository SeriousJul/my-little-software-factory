/**
 * The spin watch's logic and its end-to-end path (issue #403, ADR 0138).
 *
 * The fixture half feeds the watch's parsing the shapes the process table
 * holds, the way the table held them on the machine that measured the
 * spin. The worker's command line is the argument list the kernel joins
 * with NUL bytes, and a spaced read of that byte string never matched the
 * arguments it held - the defect the watch's first head stood with, the
 * one that left its worker set empty on every real run.
 *
 * The end-to-end half stands the real watch beside a stub command
 * (`scripts/spin-stub.ts`): the stub stands one child of its own that
 * spins at full CPU and makes no voluntary context switches, the
 * signature of the spin the issue names. The watch takes the child down,
 * the child's death is reported by the stub, and the run the watch stood
 * beside ends red instead of open. The end-to-end checks stand the watch
 * on a fast pace and a floor a loaded runner still holds, through the
 * watch's SPIN_WATCH_ settings.
 */

import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import {
	beatPercent,
	beatsOf,
	isBunTestArgs,
	isSpinSignature,
	isTestWorkerArgs,
	type Sample,
	splitCmdline,
	statusField,
	ticksOf,
} from "../scripts/spin-watch-core.ts";

/** One sample of a watched process's counters, the way the fixtures hold them. */
const sample = (utime: number, stime: number, volCtx: number): Sample => ({ utime, stime, volCtx });

describe("the spin watch's parsing of the process table", () => {
	// The byte string a live test worker's command line held, measured on
	// the machine that measured the spin: the kernel joins the arguments
	// with NUL bytes and ends the line with a trailing NUL.
	const workerCmdline =
		"/home/op/.local/share/mise/installs/bun/1.4.2/bin/bun\0test\0--test-worker\0--isolate\0--timeout=60000\0--max-concurrency=20\0";

	test("a worker's NUL-joined command line matches on its argument list", () => {
		// The spaced word the watch's first head searched for never stands
		// in the byte string: the kernel joins the arguments with NUL
		// bytes. The match that stands is the argument the list carries.
		expect(workerCmdline.includes("bun test --test-worker")).toBe(false);
		expect(isTestWorkerArgs(splitCmdline(workerCmdline))).toBe(true);
	});

	test("an argument list without the worker argument does not match", () => {
		expect(
			isTestWorkerArgs(splitCmdline("bun\0test\0--parallel\0--isolate\0--timeout=60000\0")),
		).toBe(false);
		expect(
			isTestWorkerArgs(
				splitCmdline(
					"/usr/bin/tmux\0-L\0factory-fields-1\0-f\0/dev/null\0has-session\0-t\0factory-fields-1\0",
				),
			),
		).toBe(false);
		expect(
			isTestWorkerArgs(splitCmdline("/bin/sh\0-c\0exec bun bin/factory-gallery.mjs fields\0")),
		).toBe(false);
		expect(isTestWorkerArgs(splitCmdline(""))).toBe(false);
	});

	test("the run's bun test parent matches on the bun binary and the test command", () => {
		expect(isBunTestArgs(splitCmdline("bun\0test\0--parallel\0--isolate\0--timeout=60000\0"))).toBe(
			true,
		);
		expect(
			isBunTestArgs(
				splitCmdline("/home/op/.local/share/mise/installs/bun/1.4.2/bin/bun\0test\0a.test.ts\0"),
			),
		).toBe(true);
		expect(isBunTestArgs(splitCmdline("bun\0run\0scripts\0spin-stub.ts\0"))).toBe(false);
		expect(isBunTestArgs(splitCmdline("bun\0scripts\0spin-stub.ts\0--test-worker\0"))).toBe(false);
		expect(isBunTestArgs(splitCmdline("node\0test\0a.test.ts\0"))).toBe(false);
		expect(isBunTestArgs(splitCmdline(""))).toBe(false);
	});

	test("the NUL split gives back the argument list, trailing NUL dropped", () => {
		expect(splitCmdline("a\0b\0")).toEqual(["a", "b"]);
		expect(splitCmdline("a\0b")).toEqual(["a", "b"]);
		expect(splitCmdline("")).toEqual([]);
	});

	test("a beat's CPU share stands on the kernel's own clock ticks", () => {
		// A full spin holds the kernel's own tick rate: 500 ticks over a 5 s
		// beat on a 100-tick kernel is a full core.
		expect(beatPercent(sample(0, 0, 0), sample(500, 0, 0), 100, 5000)).toBeCloseTo(100, 5);
		// The same spin on a 250-tick kernel makes 1250 ticks over the beat,
		// and read against the kernel's own rate it is still a full core.
		expect(beatPercent(sample(0, 0, 0), sample(1250, 0, 0), 250, 5000)).toBeCloseTo(100, 5);
		// Read against a rate below the kernel's, the same ticks stand over
		// the floor, so the assumed value of 100 does not hide a spin on a
		// kernel that reports more.
		expect(beatPercent(sample(0, 0, 0), sample(1250, 0, 0), 100, 5000)).toBeCloseTo(250, 5);
	});

	test("the window's beats stand on pairs of neighboring samples", () => {
		const window = [sample(0, 0, 0), sample(500, 0, 0), sample(750, 0, 0)];
		expect(beatsOf(window, 100, 5000)).toEqual([100, 50]);
	});

	const thresholds = { cpuFloor: 90, switchCeiling: 50 };
	// Twelve samples of a full spin on a 100-tick kernel over 5 s beats:
	// 500 ticks per beat, the thread making no voluntary switches.
	const spinWindow: Sample[] = Array.from({ length: 12 }, (_, i) => sample(i * 500, 0, 383));

	test("a full share on every beat and no switches is the signature", () => {
		expect(isSpinSignature(spinWindow, 100, 5000, thresholds)).toBe(true);
	});

	test("a beat that dips under the floor breaks the signature", () => {
		const dip = [...spinWindow];
		dip[6] = sample(dip[5].utime + 250, 0, 383); // a half-core beat
		expect(isSpinSignature(dip, 100, 5000, thresholds)).toBe(false);
	});

	test("switches over the ceiling break the signature", () => {
		const busy = [...spinWindow];
		busy[11] = sample(spinWindow[11].utime, 0, 383 + 60);
		expect(isSpinSignature(busy, 100, 5000, thresholds)).toBe(false);
	});

	test("switches at the ceiling keep the signature", () => {
		const few = [...spinWindow];
		few[11] = sample(spinWindow[11].utime, 0, 383 + 50);
		expect(isSpinSignature(few, 100, 5000, thresholds)).toBe(true);
	});

	test("the tick read stands on the last closing paren, so a comm with spaces parses", () => {
		const stat =
			"475407 (bun test --test-worker) S 475403 1 1 0 -1 4194304 123 0 0 0 500 12 0 0 20 0 1 0 42 7 8000 18446744073709551615 0 0 0 0";
		expect(ticksOf(stat)).toEqual({ utime: 500, stime: 12 });
	});

	test("a stat line without its closing paren stands no ticks", () => {
		expect(ticksOf("123 (no closing paren S 1 2 3 4 5 6 7 8 9 10 11 12")).toBeNull();
	});

	test("one labeled line of a status file stands beside its label", () => {
		const status =
			"Name:\tbun\nState:\tR (running)\nPPid:\t475403\nvoluntary_ctxt_switches:\t383\n";
		expect(statusField(status, "PPid:")).toBe("475403");
		expect(statusField(status, "voluntary_ctxt_switches:")).toBe("383");
		expect(statusField(status, "State:")).toBe("R (running)");
		expect(statusField(status, "no such label:")).toBeNull();
		expect(statusField(null, "PPid:")).toBeNull();
	});
});

describe("the spin watch, end to end", () => {
	const repoRoot = join(import.meta.dir, "..");
	const WATCH = join(repoRoot, "scripts", "test-spin-watch.ts");
	const STUB = join(repoRoot, "scripts", "spin-stub.ts");

	/** One setting of the watch's pace and thresholds for an end-to-end run. */
	const fastWatch = {
		SPIN_WATCH_SAMPLE_MS: "300",
		SPIN_WATCH_WINDOW: "4",
		SPIN_WATCH_CPU_FLOOR: "50",
	};

	/** Stand the watch beside one command and wait for the run it stood beside to end. */
	function standWatch(
		command: string[],
		env: Record<string, string>,
	): Promise<{ code: number; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(command[0], command.slice(1), {
				cwd: repoRoot,
				env: { ...process.env, ...env },
				stdio: ["ignore", "ignore", "pipe"],
			}) as ChildProcess;
			let stderr = "";
			child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
			child.on("error", reject);
			child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
		});
	}

	test("the watch takes a spinning worker down and ends the run red", async () => {
		const run = await standWatch([process.execPath, WATCH, process.execPath, STUB], fastWatch);

		// The stub's spin child was taken down by the watch's signal, not by
		// its own exit: the stub reports how the child died.
		expect(run.stderr).toContain("taken down by SIGKILL");
		// The watch named the process that spun and the signature it wore.
		expect(run.stderr).toContain("spun at full CPU");
		expect(run.stderr).toContain("cpu share per 300ms beat:");
		expect(run.stderr).toContain("voluntary context switches over the window:");
		expect(run.stderr).toContain("no dead children stood beside it");
		expect(run.stderr).toContain("taking the process down so the run can end");
		// The run the watch stood beside ended red: a run pulled out of a
		// spin is not a green run, even when the command it stood beside
		// exits 0.
		expect(run.code).toBe(1);
		// And the watch reported the set it held in its sight: the spin
		// child, and no process but it.
		expect(run.stderr).toContain("the run ended 0 after");
		expect(run.stderr).toContain("it held 1 process(es) of the run in its sight");
		expect(run.stderr).toContain("a spin stood, and the watch pulled the run red");
	}, 30_000);

	test("a run that stands no spin passes through with its own exit code", async () => {
		// The command outlives a couple of beats, so the watch samples a
		// healthy process: one that yields to its event loop on every wait
		// makes the voluntary switches a spin does not, and stands no
		// signature.
		const run = await standWatch(
			[process.execPath, WATCH, process.execPath, "-e", "setTimeout(() => process.exit(0), 900)"],
			fastWatch,
		);

		expect(run.code).toBe(0);
		expect(run.stderr).toContain("the run ended 0 after");
		expect(run.stderr).toContain("it held no process of the run in its sight");
		expect(run.stderr).toContain("no spin stood");
	}, 30_000);
});
