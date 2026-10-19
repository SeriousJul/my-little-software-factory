/**
 * The pure logic of the spin watch (issue #403, ADR 0138).
 *
 * The watch stands beside a `bun test` run and reads the run's own
 * processes from the process table. The parsing it applies to what it
 * reads stands here, apart from the `/proc` reads that run it: a byte
 * string of `/proc` is one shape, and the tests feed it that shape
 * without a live process to read it from.
 *
 * Two shapes the parsing stands on:
 *
 * - `/proc/<pid>/cmdline` joins the process's arguments with NUL bytes
 *   and adds a trailing NUL. A spaced read of that byte string never
 *   matches the arguments it holds: a live test worker's line reads
 *   `bun\0test\0--test-worker\0...`, and `includes("bun test
 *   --test-worker")` is false for it. The match therefore stands on the
 *   argument list the NUL split gives back.
 *
 * - the CPU share the watch reads over a beat stands on the kernel's
 *   clock ticks. `/proc/<pid>/stat` counts utime and stime in ticks, and
 *   the ticks per second the kernel reports (`_SC_CLK_TCK`) is not a
 *   constant every Linux kernel agrees on. The share is the ticks a beat
 *   made, over the ticks the beat's wall time held, and the watch reads
 *   the machine's own value before it computes one.
 */

/** One read of a watched process's counters, straight from its /proc entries. */
export interface Sample {
	/** The voluntary context switches the kernel had counted for it. */
	volCtx: number;
	/** The kernel clock ticks it had held in user time. */
	utime: number;
	/** The kernel clock ticks it had held in system time. */
	stime: number;
}

/**
 * The arguments one /proc cmdline byte string holds. The kernel joins them
 * with NUL bytes and ends the line with a trailing NUL.
 */
export function splitCmdline(cmdline: string): string[] {
	const args = cmdline.split("\0");
	if (args.length > 0 && args[args.length - 1] === "") args.pop();
	return args;
}

/**
 * Whether an argument list names one of a run's test workers. The role is
 * an argument the runner passes the child, and it stands in the list
 * beside the runner's own test command, not in the executable's path.
 */
export function isTestWorkerArgs(args: string[]): boolean {
	return args.includes("--test-worker");
}

/**
 * Whether an argument list names a run's own test parent: the bun binary
 * running the test command. A single-file parallel run stands no worker
 * child: its tests run in the parent's own process, and a spin in such a
 * run stands in the parent, so the parent is what the watch reads there.
 */
export function isBunTestArgs(args: string[]): boolean {
	const name = (args[0] ?? "").split("/").pop() ?? "";
	return name === "bun" && args[1] === "test";
}

/**
 * The value one labeled line of a /proc status file holds, or null. The
 * value stands after the line's first colon and holds the rest of the
 * line whole: the `Name:` line of the dead tmux client the issue
 * measured reads `Name:\ttmux: client`, and the value after its first
 * colon is the process class the report names, with the colon inside it
 * part of the value.
 */
export function statusField(status: string | null, label: string): string | null {
	if (status === null) return null;
	const line = status.split("\n").find((entry) => entry.startsWith(label));
	if (line === undefined) return null;
	const colon = line.indexOf(":");
	if (colon === -1) return null;
	return line.slice(colon + 1).trim();
}

/**
 * The dead children a process table read holds for one process: the
 * entries of the process's child list whose status the kernel has written
 * with the zombie state. The kernel writes the state as its character
 * followed by its word, `State:\tZ (zombie)`, and `Z` is the only
 * character the kernel uses for a dead child, so the gate stands on the
 * character: a child the kernel has not reaped stands in that one state,
 * and a child that stands on running, sleeping, or stopped stands
 * unnamed. The read hands each child its status file, or null when the
 * child is gone between the list read and the status read, and the gone
 * child stands unnamed as well: its absence is not a fact the report can
 * name.
 */
export function deadChildrenOf(
	childrenLine: string | null,
	statusOf: (child: string) => string | null,
): string[] {
	const children = childrenLine?.split(" ").filter((child) => child !== "") ?? [];
	const dead: string[] = [];
	for (const child of children) {
		const status = statusOf(child);
		const state = statusField(status, "State:");
		if (state === null || !state.startsWith("Z")) continue;
		const comm = statusField(status, "Name:") ?? "";
		dead.push(`${child} (${comm})`);
	}
	return dead;
}

/**
 * The kernel clock ticks a /proc stat line holds in utime and stime, or
 * null when the line holds neither. The comm field can hold spaces, so
 * the split stands on the last closing paren, and the fields after it
 * stand on their kernel order: utime and stime are the twelfth and
 * thirteenth of them.
 */
export function ticksOf(stat: string): { utime: number; stime: number } | null {
	const close = stat.lastIndexOf(")");
	if (close === -1) return null;
	const fields = stat
		.slice(close + 2)
		.trim()
		.split(" ");
	const utime = Number(fields[11]);
	const stime = Number(fields[12]);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return { utime, stime };
}

/** The CPU share, in percent of one core, a process held over one beat. */
export function beatPercent(
	previous: Sample,
	next: Sample,
	clockTicks: number,
	beatMs: number,
): number {
	const ticks = next.utime + next.stime - (previous.utime + previous.stime);
	const seconds = ticks / clockTicks;
	return (seconds / (beatMs / 1000)) * 100;
}

/** The beats a window held, one per pair of neighboring samples. */
export function beatsOf(window: Sample[], clockTicks: number, beatMs: number): number[] {
	const beats: number[] = [];
	for (let i = 1; i < window.length; i += 1) {
		beats.push(beatPercent(window[i - 1], window[i], clockTicks, beatMs));
	}
	return beats;
}

/** The thresholds a window must wear to stand as a spin. */
export interface SpinThresholds {
	/** The CPU share, in percent of one core, a beat must hold for it to be full. */
	cpuFloor: number;
	/** The most voluntary context switches a spinning process may make over the window. */
	switchCeiling: number;
}

/**
 * The signature the spin measured in issue #403 wore: a full CPU share
 * held on every beat of the window, and the thread making no voluntary
 * switches in it. A healthy process - one busy through a whole heavy file
 * included - turns its event loop between its bursts of work, and every
 * turn it takes on a timer or a pipe is a voluntary switch. A thread
 * spinning inside one synchronous call makes none.
 */
export function isSpinSignature(
	window: Sample[],
	clockTicks: number,
	beatMs: number,
	thresholds: SpinThresholds,
): boolean {
	const beats = beatsOf(window, clockTicks, beatMs);
	const heldHigh = beats.every((beat) => beat >= thresholds.cpuFloor);
	const switches = window[window.length - 1].volCtx - window[0].volCtx;
	return heldHigh && switches <= thresholds.switchCeiling;
}
