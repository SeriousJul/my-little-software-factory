/**
 * Launch the real control plane executable on a pseudo-terminal (PTY) and
 * observe its terminal protocol output.
 *
 * This is the executable-boundary test seam: it runs the production entry
 * exactly as an operator would, in a real terminal, and captures every byte
 * the process writes. The frame test seam (testRender) cannot observe this,
 * because the OpenTUI test renderer owns its own mock terminal and never
 * performs production renderer startup. Only this seam can prove which
 * terminal modes the production renderer requests from the host.
 *
 * The PTY is opened through the same node:ffi the OpenTUI native renderer
 * already loads, so no extra dependency is added. The helper is defensive:
 * if the platform cannot open a PTY, `openControlPlanePty` reports that and
 * the caller skips the test rather than failing it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { dlopen } from "node:ffi";
import { readSync, writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Resolve the shipped control plane bin, the production executable. */
export const CONTROLLER_BIN = fileURLToPath(new URL("../bin/factory.mjs", import.meta.url));

const READ_INTERVAL_MS = 5;
const READ_BUFFER_SIZE = 65536;

interface PtyLibs {
	openpty: (amaster: Int32Array, aslave: Int32Array) => number;
	fcntl: (fd: number, cmd: number, arg: bigint) => number;
	close: (fd: number) => number;
	ioctl: (fd: number, request: number, winsize: Uint16Array) => number;
}

/** TIOCSWINSZ: set the slave's window size from the master. */
const TIOCSWINSZ: Record<string, number> = { linux: 0x5414, darwin: 0x40087467 };

/**
 * The libc symbol table and fcntl constants differ per platform. Anything
 * outside this table cannot open a PTY here, so the test is skipped.
 */
const PTY_SUPPORT: Partial<
	Record<NodeJS.Platform, { libcPaths: string[]; fSetFl: number; oNonBlock: bigint }>
> = {
	linux: { libcPaths: ["libc.so.6", "libc.so"], fSetFl: 4, oNonBlock: 2048n },
	darwin: { libcPaths: ["/usr/lib/libSystem.dylib"], fSetFl: 4, oNonBlock: 2048n },
};

function loadPtyLibs(): PtyLibs | null {
	const support = PTY_SUPPORT[process.platform];
	if (support === undefined) return null;
	for (const path of support.libcPaths) {
		try {
			const { functions } = dlopen(path, {
				openpty: {
					arguments: ["pointer", "pointer", "pointer", "pointer", "pointer"],
					return: "i32",
				},
				fcntl: { arguments: ["i32", "i32", "i64"], return: "i32" },
				close: { arguments: ["i32"], return: "i32" },
				ioctl: { arguments: ["i32", "i32", "pointer"], return: "i32" },
			});
			return {
				openpty: (amaster, aslave) => functions.openpty(amaster, aslave, null, null, null),
				fcntl: (fd, cmd, arg) => functions.fcntl(fd, cmd, arg),
				close: (fd) => functions.close(fd),
				ioctl: (fd, request, winsize) => functions.ioctl(fd, request, winsize),
			};
		} catch {
			// Try the next candidate path.
		}
	}
	return null;
}

export interface PtySession {
	/** The spawned control plane process. */
	readonly child: ChildProcess;
	/** Every byte written to the PTY so far. */
	output(): Buffer;
	/**
	 * Wait until the accumulated output satisfies `predicate`, and return it.
	 * Throws if the deadline passes first.
	 */
	waitFor(predicate: (out: Buffer) => boolean, what: string, timeoutMs?: number): Promise<Buffer>;
	/**
	 * Wait until the output stops changing for `stableMs`, and return it.
	 *
	 * A stable frame means the app has booted, rendered, and settled, which
	 * is when its keyboard handler is reliably live.
	 */
	waitForStable(stableMs: number, timeoutMs?: number): Promise<Buffer>;
	/** Write input to the PTY, as the host terminal would. */
	write(data: string): void;
	/** Wait for the process to exit. */
	exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** Stop reading, kill the process if it is still alive, and close the PTY. */
	dispose(): void;
}

/**
 * Start the control plane bin on a fresh PTY with an isolated environment.
 *
 * `env` is merged over a clean base, so the process never inherits the
 * operator's home, XDG state, or GitHub credentials.
 */
export interface PtyOptions {
	/** The terminal window size in cells. The renderer draws to it. */
	size?: { cols: number; rows: number };
}

export async function openControlPlanePty(
	args: string[],
	env: Record<string, string>,
	options: PtyOptions = {},
): Promise<PtySession | null> {
	const libs = loadPtyLibs();
	if (libs === null) return null;
	const support = PTY_SUPPORT[process.platform];
	if (support === undefined) return null;

	const amaster = new Int32Array(1);
	const aslave = new Int32Array(1);
	if (libs.openpty(amaster, aslave) !== 0) return null;
	const master = amaster[0];
	const slave = aslave[0];
	// Non-blocking master: readSync must report EAGAIN, not stall the
	// event loop, on a PTY with no pending output.
	if (libs.fcntl(master, support.fSetFl, support.oNonBlock) === -1) {
		libs.close(master);
		libs.close(slave);
		return null;
	}
	// A zero-size window renders nothing. Set the size before the child
	// spawns, so the renderer reads it at startup.
	if (options.size !== undefined) {
		const winsize = new Uint16Array([options.size.rows, options.size.cols, 0, 0]);
		const request = TIOCSWINSZ[process.platform];
		if (request === undefined || libs.ioctl(master, request, winsize) !== 0) {
			libs.close(master);
			libs.close(slave);
			return null;
		}
	}

	const child = spawn(process.execPath, [CONTROLLER_BIN, ...args], {
		stdio: [slave, slave, slave],
		env: { ...baseEnv(), ...env },
	});
	// The parent drops its copy of the slave; the child keeps its dup.
	libs.close(slave);

	const chunks: Buffer[] = [];
	const buffer = Buffer.alloc(READ_BUFFER_SIZE);
	let reading = true;
	let exitResolve:
		| ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
		| null = null;
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve) => {
			exitResolve = resolve;
		},
	);
	child.on("exit", (code, signal) => {
		exitResolve?.({ code, signal });
	});

	const timer = setInterval(() => {
		if (!reading) return;
		let count: number;
		try {
			count = readSync(master, buffer, 0, buffer.length, null);
		} catch (error) {
			if (isNoPendingData(error)) return;
			reading = false;
			clearInterval(timer);
			return;
		}
		if (count > 0) {
			chunks.push(Buffer.from(buffer.subarray(0, count)));
		}
	}, READ_INTERVAL_MS);

	const output = (): Buffer => Buffer.concat(chunks);

	const session: PtySession = {
		child,
		output,
		async waitFor(predicate, what, timeoutMs = 15000): Promise<Buffer> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const current = output();
				if (predicate(current)) return current;
				if (Date.now() >= deadline) {
					throw new Error(`timed out waiting for ${what}\ncaptured output:\n${preview(current)}`);
				}
				await sleep(10);
			}
		},
		async waitForStable(stableMs, timeoutMs = 15000): Promise<Buffer> {
			const deadline = Date.now() + timeoutMs;
			let last = output().toString("binary");
			let stableSince = Date.now();
			for (;;) {
				const current = output().toString("binary");
				if (current !== last) {
					last = current;
					stableSince = Date.now();
				} else if (Date.now() - stableSince >= stableMs) {
					return output();
				}
				if (Date.now() >= deadline) {
					throw new Error(
						`output never settled for ${stableMs}ms\ncaptured output:\n${preview(output())}`,
					);
				}
				await sleep(10);
			}
		},
		write(data: string): void {
			writeSync(master, data);
		},
		exit: () => exitPromise,
		dispose(): void {
			reading = false;
			clearInterval(timer);
			if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				// The bin wrapper re-runs the entry as its own child, so
				// killing the wrapper alone would orphan that child. Kill
				// the whole tree: children first, the wrapper last.
				killProcessTree(child.pid);
			}
			libs.close(master);
		},
	};
	return session;
}

/**
 * Every pid in the process tree rooted at `root`, including `root`.
 * Children are reparented when a member dies, so the tree must be
 * collected in one pass while the links are still live.
 */
function processTree(root: number): number[] {
	const seen = new Set<number>([root]);
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift() as number;
		const out = spawnSync("pgrep", ["-P", String(current)]).stdout.toString();
		for (const line of out.split("\n")) {
			const pid = Number(line);
			if (pid > 0 && !seen.has(pid)) {
				seen.add(pid);
				queue.push(pid);
			}
		}
	}
	return [...seen];
}

/** SIGKILL every pid in the tree rooted at `root`, children before parent. */
function killProcessTree(root: number): void {
	for (const pid of processTree(root).reverse()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process already exited between the scan and the kill.
		}
	}
}

function isNoPendingData(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
	);
}

function preview(out: Buffer): string {
	const text = out.toString("utf8");
	return text.length > 2000 ? `...${text.slice(-2000)}` : text;
}

/** A clean environment: no operator home, XDG state, or GitHub credentials. */
function baseEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		TERM: "xterm-256color",
	};
}
