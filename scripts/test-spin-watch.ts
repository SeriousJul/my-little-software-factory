/**
 * The spin watchdog for the test run (issue #403, ADR 0138).
 *
 * A `bun test` process can spin its JS thread at full CPU with the event
 * loop starved: one measured spin stood that way for over twenty minutes,
 * the runner's per-test budget never fired, and the run could not end
 * until the spinning process was killed by hand. The suite entry runs the
 * same `bun test` command it always ran and watches the run's own
 * processes beside it.
 *
 * The watch reads two sets of processes, twice, a short beat apart: the
 * CPU share each one held over the beat, and the voluntary context
 * switches it made over it. It reads the run's own `bun test` parent - so
 * a run that stands no worker child, a single-file parallel run whose
 * tests run in the parent, stands in its sight - and the parent's test
 * workers. A process is a test worker when its argument list carries the
 * argument `--test-worker`: the kernel joins a process's command line
 * with NUL bytes, so the match stands on the argument list, not on a
 * word of the byte string.
 *
 * A healthy process - even one busy through a whole heavy file -
 * alternates bursts of work with event-loop turns, and every turn the
 * process takes on a timer or a pipe is a voluntary switch. A thread
 * that spins inside one synchronous call makes none: the measured spin
 * held its CPU share at about one over every beat for minutes and made
 * zero voluntary switches over an eight-second beat.
 *
 * The share stands on the kernel's clock ticks, which the watch reads
 * from the kernel before it computes one (`sysconf(_SC_CLK_TCK)` through
 * a one-line helper it compiles once, in the user's cache, the way
 * `scripts/crash-guard.sh` builds its library). A machine the read
 * cannot stand on gets the assumed value of 100, and the report names
 * which one stood: with the assumed value, a spin on a kernel that
 * reports more ticks per second still stands over the floor, and one on
 * a kernel that reports fewer stands under it and is missed, so the read
 * is what keeps the share honest on any kernel.
 *
 * When a process shows the spin signature across the whole watch window -
 * a full CPU share held on every beat and the thread making no voluntary
 * switches - the watch records what it saw: the process's pid, the
 * beats, the switches the window held, and the dead children the process
 * had left unreaped. It then takes the process down so the run can end,
 * and it ends the run red: a run pulled out of a spin is not a green run,
 * and a red run with the report names the state the spin stood in
 * instead of the silence a hang leaves.
 *
 * When the run ends, the watch prints the set of processes it held in
 * its sight over the run: a green run names the run it watched instead
 * of standing silent, and a green run whose set is empty says so. A run
 * shorter than the watch's first beat says it ended before that beat,
 * so its end line does not read like an empty watch: the line is true
 * either way, but the empty set of a run that stood under no beat is a
 * different fact from the empty set of a watch that ran and held
 * nothing.
 *
 * The watch is the runner's companion, not a new test layer: it runs the
 * same command, streams the same output, and reports the same exit code
 * when no spin stands. It reads only the run's own parent and the
 * parent's children, so a run standing beside another run on the same
 * machine cannot trip it, and the run's grandchildren - a check's own
 * tmux server and pane, a stub a test spawns - stand outside it. It
 * stands only where it can read the processes' /proc entries (Linux);
 * elsewhere it passes the run through untouched.
 *
 * The end-to-end test of the watch stands it on a fast pace and a floor
 * a loaded runner still holds, through the SPIN_WATCH_SAMPLE_MS,
 * SPIN_WATCH_WINDOW, SPIN_WATCH_CPU_FLOOR, and SPIN_WATCH_SWITCH_CEILING
 * settings; the values it falls back to are the ones a real run stands
 * on.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exit as processExit } from "node:process";
import {
	beatsOf,
	isBunTestArgs,
	isSpinSignature,
	isTestWorkerArgs,
	type Sample,
	type SpinThresholds,
	splitCmdline,
	statusField,
	ticksOf,
} from "./spin-watch-core.ts";

/** How often the watch samples the processes it watches. */
const SAMPLE_MS = numberSetting("SPIN_WATCH_SAMPLE_MS", 5000);
/** How many samples stand in the window a spin must fill. */
const WINDOW_SAMPLES = numberSetting("SPIN_WATCH_WINDOW", 12);
/** The CPU share, in percent of one core, a beat must hold for it to be full. */
const CPU_FLOOR = numberSetting("SPIN_WATCH_CPU_FLOOR", 90);
/** The most voluntary context switches a spinning process may make over the window. */
const SWITCH_CEILING = numberSetting("SPIN_WATCH_SWITCH_CEILING", 50);
/** The clock ticks per second the watch assumes when it cannot read the kernel's. */
const ASSUMED_CLOCK_TICKS = 100;

/** The watch's own start, so it can say how long the run stood under it. */
const runStart = Date.now();

/** The thresholds one window must wear to stand as a spin. */
const thresholds: SpinThresholds = { cpuFloor: CPU_FLOOR, switchCeiling: SWITCH_CEILING };

/** One setting of the watch's pace and thresholds, from the environment. */
function numberSetting(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Read one file's text, or null when it is gone or unreadable. */
function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * The clock ticks per second this kernel reports, or null when the watch
 * cannot read them. The value the kernel hands `sysconf(_SC_CLK_TCK)` is
 * not a constant every Linux kernel agrees on, and a share computed
 * against the wrong value can stand off the floor the spin must clear.
 * The read compiles a one-line helper once, in the user's cache, the way
 * `scripts/crash-guard.sh` builds its library. A machine without a C
 * compiler gets the assumed value, and the run's report names which one
 * stood.
 */
function readClockTicks(): number | null {
	try {
		const cacheDir = join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"my-little-software-factory",
			"spin-watch",
		);
		const binary = join(cacheDir, "clk-ticks");
		const source = join(import.meta.dir, "clk-ticks.c");
		if (!existsSync(binary) || statSync(source).mtimeMs > statSync(binary).mtimeMs) {
			mkdirSync(cacheDir, { recursive: true });
			const built = spawnSync("cc", ["-O2", "-o", binary, source], { timeout: 15000 });
			if (built.status !== 0) return null;
		}
		const out = spawnSync(binary, [], { timeout: 5000 });
		const ticks = Number(out.stdout?.toString().trim());
		return Number.isInteger(ticks) && ticks > 0 ? ticks : null;
	} catch {
		return null;
	}
}

/** The pids of the run's own test workers.
 *
 * They are the parent's children whose argument list carries the
 * `--test-worker` argument the runner passes its workers. A worker
 * another run started stands outside the watch.
 */
function workerPids(parentPid: number): number[] {
	const pids: number[] = [];
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return pids;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const ppid = statusField(readFileOrNull(`/proc/${name}/status`), "PPid:");
		if (ppid !== String(parentPid)) continue;
		const cmdline = readFileOrNull(`/proc/${name}/cmdline`);
		if (cmdline !== null && isTestWorkerArgs(splitCmdline(cmdline))) pids.push(Number(name));
	}
	return pids;
}

/**
 * The processes the watch reads on this beat: the run's own `bun test`
 * parent when it stands, and the parent's test workers. A single-file
 * parallel run stands no worker: its tests run in the parent, and the
 * parent is what the watch reads there.
 */
function watchTargets(parentPid: number): Set<number> {
	const targets = new Set<number>();
	const parentCmdline = readFileOrNull(`/proc/${parentPid}/cmdline`);
	if (parentCmdline !== null && isBunTestArgs(splitCmdline(parentCmdline))) targets.add(parentPid);
	for (const pid of workerPids(parentPid)) targets.add(pid);
	return targets;
}

/** One read of a watched process's counters, or null when it is gone. */
function sampleOf(pid: number): Sample | null {
	const stat = readFileOrNull(`/proc/${pid}/stat`);
	if (stat === null) return null;
	const times = ticksOf(stat);
	if (times === null) return null;
	const volCtx = statusField(readFileOrNull(`/proc/${pid}/status`), "voluntary_ctxt_switches:");
	if (volCtx === null) return null;
	return { utime: times.utime, stime: times.stime, volCtx: Number(volCtx) };
}

/** The dead children a process had not reaped, when the watch looked. */
function deadChildren(pid: number): string[] {
	const children =
		readFileOrNull(`/proc/${pid}/task/${pid}/children`)
			?.split(" ")
			.filter((child) => child !== "") ?? [];
	const dead: string[] = [];
	for (const child of children) {
		const status = readFileOrNull(`/proc/${child}/status`);
		if (statusField(status, "State:") !== "Z") continue;
		const comm = statusField(status, "Name:") ?? "";
		dead.push(`${child} (${comm})`);
	}
	return dead;
}

/** The wall age of the run when the report stands, in whole seconds. */
function runAgeSeconds(): string {
	return `${Math.round((Date.now() - runStart) / 1000)}s`;
}

/** The report the watch prints when it takes a process down. */
function spinReport(
	pid: number,
	role: "parent" | "worker",
	window: Sample[],
	clockTicks: number,
): string {
	const switches = window[window.length - 1].volCtx - window[0].volCtx;
	const beats = beatsOf(window, clockTicks, SAMPLE_MS)
		.map((beat) => `${Math.round(beat)}%`)
		.join(" ");
	const dead = deadChildren(pid);
	const who = role === "parent" ? `the run's bun test parent ${pid}` : `the test worker ${pid}`;
	return [
		`${who} spun at full CPU: ${runAgeSeconds()} of the run stood under the watch`,
		`cpu share per ${SAMPLE_MS}ms beat: ${beats}`,
		`voluntary context switches over the window: ${switches} (a spinning thread makes none)`,
		dead.length > 0
			? `dead children it had left unreaped: ${dead.join(", ")}`
			: `no dead children stood beside it`,
	].join("\n");
}

/**
 * Sample one watched process and run its window through the signature
 * check. When a spin stands, the watch reports it and takes the process
 * down so the run can end. The answer says whether the watch took a
 * process down this beat.
 */
function checkProcess(
	pid: number,
	role: "parent" | "worker",
	windows: Map<number, Sample[]>,
	clockTicks: number,
): boolean {
	const sample = sampleOf(pid);
	if (sample === null) return false;
	const window = windows.get(pid) ?? [];
	window.push(sample);
	if (window.length > WINDOW_SAMPLES) window.shift();
	windows.set(pid, window);
	if (window.length < WINDOW_SAMPLES) return false;
	if (!isSpinSignature(window, clockTicks, SAMPLE_MS, thresholds)) return false;
	process.stderr.write(
		`\n[spin-watch] ${spinReport(pid, role, window, clockTicks)}\n[spin-watch] taking the process down so the run can end\n`,
	);
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// the process died between the sample and the signal
	}
	windows.delete(pid);
	return true;
}

/** The clock ticks per second the run stood on, and whether the value was read. */
interface TickStance {
	/** The ticks per second the watch's shares stood on. */
	ticks: number;
	/** Whether the value stood assumed, the read of the kernel's standing nowhere. */
	assumed: boolean;
}

/** The facts of the run when the watch's end line stands. */
interface RunEnd {
	/** The code the run ended with. */
	exitCode: number;
	/** The set of processes the watch held in its sight over the run. */
	seen: Set<number>;
	/** The clock ticks per second the run stood on, and whether assumed. */
	stance: TickStance;
	/** Whether a spin stood and the watch pulled the run red. */
	spinStood: boolean;
	/** The beats that fired over the run: zero says the run ended before the watch's first beat. */
	beatsFired: number;
}

/**
 * The one line the watch prints when the run it stood beside ends: the
 * code the run ended with, the wall it stood under the watch, the clock
 * ticks per second it stood on, the set of processes it held in its
 * sight over the run, and whether a spin stood. When no beat fired,
 * the line says the run ended before the watch's first beat, so its
 * empty set reads as the fact it is.
 */
function runSummary(end: RunEnd): string {
	const pids = [...end.seen];
	const held =
		pids.length === 0
			? end.beatsFired === 0
				? "the run ended before the watch's first beat, and it held no process of the run in its sight"
				: "it held no process of the run in its sight"
			: `it held ${pids.length} process(es) of the run in its sight (pids: ${pids.join(", ")})`;
	const ticks = end.stance.assumed
		? `${end.stance.ticks} clock ticks per second, assumed: the read of the kernel's value stood nowhere`
		: `${end.stance.ticks} clock ticks per second, read from the kernel`;
	const verdict = end.spinStood
		? "a spin stood, and the watch pulled the run red"
		: "no spin stood";
	return `the run ended ${end.exitCode} after ${runAgeSeconds()} under the watch, standing on ${ticks}; ${held}; ${verdict}`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		process.stderr.write("usage: bun scripts/test-spin-watch.ts <command> [args...]\n");
		processExit(2);
	}
	const child = spawn(args[0], args.slice(1), { stdio: "inherit" }) as ChildProcess;
	const parentPid = child.pid;
	const watched = process.platform === "linux" && parentPid !== undefined;
	const read = watched ? readClockTicks() : null;
	const clockTicks = read ?? ASSUMED_CLOCK_TICKS;
	const assumed = read === null;
	let spinStood = false;
	let beatsFired = 0;
	let beat: ReturnType<typeof setInterval> | undefined;
	const seen = new Set<number>();
	if (watched) {
		const windows = new Map<number, Sample[]>();
		beat = setInterval(() => {
			beatsFired += 1;
			const targets = watchTargets(parentPid as number);
			for (const pid of targets) {
				seen.add(pid);
				spinStood =
					checkProcess(pid, pid === parentPid ? "parent" : "worker", windows, clockTicks) ||
					spinStood;
			}
			for (const pid of [...windows.keys()]) {
				if (!targets.has(pid)) windows.delete(pid);
			}
		}, SAMPLE_MS);
	}
	const exitCode = await new Promise<number>((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
	if (beat !== undefined) clearInterval(beat);
	if (watched) {
		process.stderr.write(
			`\n[spin-watch] ${runSummary({
				exitCode,
				seen,
				stance: { ticks: clockTicks, assumed },
				spinStood,
				beatsFired,
			})}\n`,
		);
	}
	processExit(spinStood ? 1 : exitCode);
}

void main();
