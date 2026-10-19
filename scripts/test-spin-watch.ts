/**
 * The spin watchdog for the test run (issue #403).
 *
 * A `bun test --test-worker` process can spin its JS thread at full CPU with
 * the event loop starved: one measured spin stood that way for over twenty
 * minutes, the runner's per-test budget never fired, and the run could not
 * end until the worker was killed by hand. The suite entry runs the same
 * `bun test` command it always ran and watches the run's worker processes
 * beside it.
 *
 * The watch samples each of the run's own workers twice, a short beat apart:
 * the CPU share the thread held over the beat, and the voluntary context
 * switches the thread made over it. A healthy worker - even one busy through
 * a whole heavy file - alternates bursts of work with event-loop turns, and
 * every turn the worker makes on a timer or a pipe is a voluntary switch. A
 * thread that spins inside one synchronous call makes none: the measured spin
 * held its CPU share at about one over every beat for minutes and made zero
 * voluntary switches over an eight-second beat.
 *
 * When a worker shows the spin signature across the whole watch window - the
 * CPU share held high on every beat and the thread making no voluntary
 * switches - the watch records what it saw: the worker's pid, the beats, the
 * switches the window held, and the dead children the worker had left
 * unreaped. It then takes the worker down so the run can end, and it ends
 * the run red: a run pulled out of a spin is not a green run, and a red run
 * with the report names the state the spin stood in instead of the silence a
 * hang leaves.
 *
 * The watch is the runner's companion, not a new test layer: it runs the
 * same command, streams the same output, and reports the same exit code when
 * no spin stands. It watches only the workers the run's own parent started,
 * so a run standing beside another run on the same machine cannot trip it.
 * It stands only where it can read the workers' /proc entries (Linux);
 * elsewhere it passes the run through untouched.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { exit as processExit } from "node:process";

/** How often the watch samples the workers. */
const SAMPLE_MS = 5000;
/** How many samples stand in the window a spin must fill. */
const WINDOW_SAMPLES = 12;
/** The CPU share, in percent of one core, a beat must hold for the window to be a spin. */
const CPU_FLOOR = 90;
/** The most voluntary context switches a spinning thread may make over the window. */
const SWITCH_CEILING = 50;
/** The kernel's clock ticks per second, as /proc reports them. */
const CLOCK_TICKS = 100;
/** The watch's own start, so it can say how long the run stood under it. */
const runStart = Date.now();

interface Sample {
	volCtx: number;
	utime: number;
	stime: number;
}

/** Read one file's text, or null when it is gone or unreadable. */
function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** The value one labeled line of a /proc status file holds, or null. */
function statusField(status: string | null, label: string): string | null {
	if (status === null) return null;
	const line = status.split("\n").find((entry) => entry.startsWith(label));
	if (line === undefined) return null;
	return line.split(":")[1]?.trim() ?? null;
}

/**
 * The pids of the run's own test workers: the parent's children whose
 * command line names the worker role. A worker another run started stays
 * outside the watch.
 */
function workerPids(parentPid: number): Map<number, string> {
	const workers = new Map<number, string>();
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return workers;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const ppid = statusField(readFileOrNull(`/proc/${name}/status`), "PPid:");
		if (ppid !== String(parentPid)) continue;
		const cmdline = readFileOrNull(`/proc/${name}/cmdline`);
		if (cmdline?.includes("bun test --test-worker")) {
			workers.set(Number(name), name);
		}
	}
	return workers;
}

/**
 * One read of the worker's thread counters, or null when it is gone.
 * The utime and stime fields the watch reads stand on the kernel's clock
 * ticks, so a beat's CPU share is the ticks it made over the beat's seconds.
 */
function sampleOf(pid: number): Sample | null {
	const stat = readFileOrNull(`/proc/${pid}/stat`);
	if (stat === null) return null;
	// The comm field can hold spaces, so the split stands on the last closing
	// paren, and the fields after it stand on their kernel order: utime and
	// stime are the eleventh and twelfth of them.
	const close = stat.lastIndexOf(")");
	const fields = stat
		.slice(close + 2)
		.trim()
		.split(" ");
	const volCtx = statusField(readFileOrNull(`/proc/${pid}/status`), "voluntary_ctxt_switches:");
	if (volCtx === null) return null;
	return {
		utime: Number(fields[11]),
		stime: Number(fields[12]),
		volCtx: Number(volCtx),
	};
}

/** The CPU share, in percent of one core, the thread held over one beat. */
function beatPercent(previous: Sample, next: Sample): number {
	const ticks = next.utime + next.stime - (previous.utime + previous.stime);
	const seconds = ticks / CLOCK_TICKS;
	return (seconds / (SAMPLE_MS / 1000)) * 100;
}

/** The beats the window held, one per pair of neighboring samples. */
function beatsOf(window: Sample[]): number[] {
	const beats: number[] = [];
	for (let i = 1; i < window.length; i += 1) {
		beats.push(beatPercent(window[i - 1], window[i]));
	}
	return beats;
}

/** The signature the measured spin wore: held high on every beat, no switches. */
function isSpinSignature(window: Sample[]): boolean {
	const beats = beatsOf(window);
	const heldHigh = beats.every((beat) => beat >= CPU_FLOOR);
	const switches = window[window.length - 1].volCtx - window[0].volCtx;
	return heldHigh && switches <= SWITCH_CEILING;
}

/** The dead children the worker had not reaped, when the watch looked. */
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

/** The report the watch prints when it takes a worker down. */
function spinReport(pid: number, window: Sample[]): string {
	const switches = window[window.length - 1].volCtx - window[0].volCtx;
	const beats = beatsOf(window)
		.map((beat) => `${Math.round(beat)}%`)
		.join(" ");
	const dead = deadChildren(pid);
	return [
		`the test worker ${pid} spun at full CPU: ${runAgeSeconds()} of the run stood under the watch`,
		`cpu share per ${SAMPLE_MS}ms beat: ${beats}`,
		`voluntary context switches over the window: ${switches} (a spinning thread makes none)`,
		dead.length > 0
			? `dead children it had left unreaped: ${dead.join(", ")}`
			: `no dead children stood beside it`,
	].join("\n");
}

/**
 * Sample one worker and run its window through the signature check. When a
 * spin stands, the watch reports it and takes the worker down so the run can
 * end. The answer says whether the watch took a worker down this beat.
 */
function checkWorker(pid: number, windows: Map<number, Sample[]>): boolean {
	const sample = sampleOf(pid);
	if (sample === null) return false;
	const window = windows.get(pid) ?? [];
	window.push(sample);
	if (window.length > WINDOW_SAMPLES) window.shift();
	windows.set(pid, window);
	if (window.length < WINDOW_SAMPLES) return false;
	if (!isSpinSignature(window)) return false;
	process.stderr.write(
		`\n[spin-watch] ${spinReport(pid, window)}\n[spin-watch] taking the worker down so the run can end\n`,
	);
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// the worker died between the sample and the signal
	}
	windows.delete(pid);
	return true;
}

/** One pass of the watch over the run's workers. */
function watchBeat(windows: Map<number, Sample[]>, parentPid: number): boolean {
	const workers = workerPids(parentPid);
	let spinStood = false;
	for (const [pid] of workers) {
		spinStood = checkWorker(pid, windows) || spinStood;
	}
	for (const pid of [...windows.keys()]) {
		if (!workers.has(pid)) windows.delete(pid);
	}
	return spinStood;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		process.stderr.write("usage: bun scripts/test-spin-watch.ts <command> [args...]\n");
		processExit(2);
	}
	const child = spawn(args[0], args.slice(1), { stdio: "inherit" }) as ChildProcess;
	const parentPid = child.pid;
	let spinStood = false;
	if (parentPid !== undefined && process.platform === "linux") {
		const windows = new Map<number, Sample[]>();
		setInterval(() => {
			spinStood = watchBeat(windows, parentPid) || spinStood;
		}, SAMPLE_MS);
	}
	const exitCode = await new Promise<number>((resolve) => {
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
	processExit(spinStood || exitCode !== 0 ? 1 : 0);
}

void main();
