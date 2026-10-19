/**
 * The shared fields through a real multiplexer path.
 *
 * This is the acceptance check the shared control standard names for a tmux
 * path: the production gallery runs on a real terminal multiplexer under a real
 * `tmux` binary, keys go in as the bytes a terminal sends them, and the screen
 * is read back out of the pane - the same two directions an operator uses, with
 * no test renderer between them.
 *
 * The check runs on its own tmux server, on a socket of its own, and starts
 * that server with an empty config file. The machine's own tmux server is a
 * fixture the check cannot control: it stands up wherever and whenever an
 * operator started it, it keeps the environment of that moment, it wears the
 * global state that stood on it when it started - an operator's own config, or
 * the setting a tool that manages the machine's sessions set on it - and it
 * holds other people's sessions. Measured on a machine holding a long-lived
 * server: a detached session the check spawned stood for under a second before
 * the server's own state dropped it, and the check read `can't find pane`
 * from a screen the gallery never got to draw (issue #400). The check's own
 * server starts from the test's own environment, with stock options, and with
 * no session on it but the check's: the check stands the same on a clean
 * machine and on a machine full of long-lived tmux sessions and dev processes,
 * and it leaves the machine's tmux as it found it. The empty config file
 * matters on an operator's machine: any new tmux server there reads the
 * operator's own tmux.conf at startup, and the check measures the
 * multiplexer's stock behavior, not the operator's personal one.
 *
 * The check's tmux calls run as asynchronous child processes (issue #403): a
 * synchronous client call the check once made for every poll of the pane can
 * lose the child's exit under a parallel run's load, and the worker that made
 * it then spins its JS thread at full CPU with the event loop starved - the
 * runner's test budget never fires, the child stands dead beside it unreaped,
 * and the run cannot end until the worker is killed by hand. A child the check
 * waits on asynchronously leaves the event loop running, so a pane that stops
 * answering stands the check's own deadline up and fails the test, and the run
 * ends. The measured spin stood in exactly this file's poll loop, on the
 * synchronous side.
 *
 * The pane's command runs the gallery through a small shell wrapper that keeps
 * a copy of the pane's stderr in the check's own temporary directory. The pane
 * may die with the session before the first capture; the kept stderr is what
 * the failure then reads out, so the check says what the gallery said instead
 * of `can't find pane`.
 *
 * The check reports itself incomplete rather than passing quietly: when tmux
 * is not installed, it says so in the failure message. A required check that
 * cannot run is not a pass, and a skipped one proves nothing about paste,
 * focus, or rendering.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The gallery's production bin: the same renderer startup an operator gets. */
const GALLERY_BIN = join(process.cwd(), "bin", "factory-gallery.mjs");
/** How long one wait on the pane is allowed to run. */
const SETTLE_MS = 25_000;

/** One answer from the check's own tmux: the exit code and both of its streams. */
interface TmuxResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Collapse a captured screen's runs of spaces, so column padding is not asserted. */
const collapse = (screen: string): string => screen.replace(/[ \t]{2,}/g, " ");

/**
 * The check's own tmux: one socket and one session per run, named for the
 * test's pid, so two runs of the check never share a server. The server the
 * check starts dies with the check: nothing of it stands on the machine after
 * the run.
 */
const NAME = `factory-fields-${process.pid}`;

/** Where the pane's stderr is kept. Stands once `beforeAll` has made the directory. */
let paneLog: string;
/** Where the check's temporary directory stands. Stands once `beforeAll` has made it. */
let dir: string;
/** Whether a `tmux` binary answers on the machine's path. */
let available = false;

/**
 * Run one tmux command as the check's own client and wait for it to answer.
 * The wait is asynchronous on purpose (issue #403): the child's exit arrives
 * on the event loop the check's own waits run on, so a client that stops
 * answering stands the test's deadline up instead of spinning the worker that
 * sent it. The client's environment drops the `TMUX` mark: if the suite runs
 * inside a tmux session, the mark would tell tmux the check is nested, and the
 * check's own server must answer the way the machine's tmux answers.
 */
function tmuxCall(args: string[]): Promise<TmuxResult> {
	const env = { ...process.env };
	delete env.TMUX;
	return new Promise<TmuxResult>((resolve, reject) => {
		const child = spawn("tmux", ["-L", NAME, "-f", "/dev/null", ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		}) as ChildProcess;
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => {
			out.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			err.push(chunk);
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (status) => {
			resolve({
				status,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		});
	});
}

/**
 * Start the check's own tmux server and its one session, running the gallery's
 * fields example at one size.
 *
 * The server is the check's, not the machine's: it stands on the check's own
 * socket, in the check's own environment, wearing no config file. A machine
 * server that stood long before the run - holding an operator's sessions and
 * a dev loop, and the global state such a server picks up along the way - has
 * no say in the pane the check reads. Any server a crashed run of this check
 * left on the socket goes first, so a pid that stands again starts clean.
 *
 * The pane's command runs the gallery through the check's wrapper: the gallery
 * itself, its stderr kept in the check's temporary directory. The pane and the
 * session may die with the gallery before the first capture; the kept stderr
 * wins that race.
 */
async function startPane(): Promise<void> {
	await tmuxCall(["kill-server"]);
	const started = await tmuxCall([
		"new-session",
		"-d",
		"-s",
		NAME,
		"-c",
		process.cwd(),
		"-x",
		"90",
		"-y",
		"26",
		"/bin/sh",
		"-c",
		'exec "$0" "$1" "$2" 2>"$3"',
		process.execPath,
		GALLERY_BIN,
		"fields",
		paneLog,
	]);
	if (started.status !== 0) {
		throw new Error(`tmux new-session failed: ${started.stderr.trim()}`);
	}
	// While the pane stands, keep it standing after the gallery exits, so a
	// gallery that dies mid-check leaves its last screen to be read. The set
	// can lose the race to the gallery's death; the kept stderr wins that race.
	await tmuxCall(["set-option", "-q", "-p", "-t", NAME, "remain-on-exit", "on"]);
}

/** The report a failure carries when the pane is gone, and what the pane left. */
async function paneGoneReport(what: string): Promise<Error> {
	const parts = [
		`${what}: the check ran its own tmux server, so the machine's tmux state stands outside the failure`,
	];
	let screen = "";
	const captured = await tmuxCall(["capture-pane", "-p", "-t", NAME]).catch(() => null);
	if (captured !== null) screen = captured.stdout;
	let log = "";
	try {
		log = readFileSync(paneLog, "utf8");
	} catch {
		// the pane wrote no stderr: nothing was kept
	}
	if (screen.trim() !== "") parts.push(`the pane's last screen:\n${screen.trimEnd()}`);
	if (log.trim() !== "") parts.push(`the pane's stderr:\n${log.trim()}`);
	if (screen.trim() === "" && log.trim() === "") {
		parts.push(
			"the pane left neither a screen nor a word of stderr: the gallery never stood, or it died without writing",
		);
	}
	return new Error(parts.join("\n\n"));
}

/** Whether the session the check spawned still holds its pane. */
async function paneStands(): Promise<boolean> {
	const has = await tmuxCall(["has-session", "-t", NAME]).catch(() => null);
	if (has === null || has.status !== 0) return false;
	const listed = await tmuxCall(["list-panes", "-t", NAME, "-F", "#{pane_dead}"]).catch(() => null);
	if (listed === null) return false;
	return listed.stdout.trim() !== "1";
}

/**
 * The pane's drawn screen: what an operator in front of the terminal reads.
 *
 * A capture that finds no pane would say `can't find pane` and nothing else,
 * the way the check once read a pane its own machine had dropped. A screen is
 * read only from a pane that stands, and a pane that does not stand is
 * reported with what it left behind.
 */
async function readScreen(): Promise<string> {
	if (!(await paneStands())) {
		throw await paneGoneReport("the pane died before the check could read its screen");
	}
	const captured = await tmuxCall(["capture-pane", "-p", "-t", NAME]).catch(() => null);
	if (captured === null || captured.status !== 0) {
		throw await paneGoneReport(
			`tmux capture-pane failed: ${captured?.stderr.trim() ?? "no answer from the client"}`,
		);
	}
	return captured.stdout;
}

/**
 * Read the pane after it has stopped changing, so a key has landed.
 *
 * The wait is bounded by the pane's own state: two captures in a row must
 * agree before the key is proven landed. A fixed sleep would instead bet the
 * check on a machine speed, and pass on a pane that had not finished redrawing.
 */
async function settle(): Promise<string> {
	const deadline = Date.now() + SETTLE_MS;
	let last = await readScreen();
	for (;;) {
		const screen = await readScreen();
		if (screen === last) return screen;
		last = screen;
		if (Date.now() >= deadline) {
			throw new Error(`the pane never stopped changing\nlast screen:\n${screen}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * Send keys to the session as the terminal sends them.
 *
 * `tmux send-keys -l` writes the literal bytes a key produces, which is what an
 * operator's keystroke is on the wire; the paste run is written the same way, so
 * the field sees the terminal's own bracketed-paste sequence rather than a test's
 * approximation of one.
 */
async function sendKeys(text: string): Promise<void> {
	const sent = await tmuxCall(["send-keys", "-t", NAME, "-l", text]);
	if (sent.status !== 0) throw new Error(`tmux send-keys failed: ${sent.stderr.trim()}`);
}

/** Wait until the pane's screen satisfies a predicate, and return it. */
async function waitFor(predicate: (screen: string) => boolean, what: string): Promise<string> {
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const screen = await readScreen();
		if (predicate(screen)) return screen;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}\nlast screen:\n${screen}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** End the check's own server: the check leaves no tmux on the machine. */
async function endPane(): Promise<void> {
	await tmuxCall(["kill-server"]).catch(() => null);
}

describe("shared fields through tmux", () => {
	beforeAll(async () => {
		const probe = await new Promise<{ status: number | null }>((resolve) => {
			const child = spawn("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] }) as ChildProcess;
			child.on("error", () => resolve({ status: null }));
			child.on("close", (status) => resolve({ status }));
		});
		available = probe.status === 0;
		if (!available) {
			throw new Error(
				"tmux is not installed, so the multiplexer acceptance check cannot run; " +
					"it is recorded as incomplete, not as passed",
			);
		}
		dir = mkdtempSync(join(tmpdir(), "factory-tmux-"));
		paneLog = join(dir, "pane-stderr.log");
	});

	afterAll(async () => {
		await endPane();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	test("a real terminal path draws the fields, takes ordinary keys, and refuses a bad paste whole", async () => {
		await startPane();
		try {
			// The gallery is up and the shared chrome drew its controls. The wait
			// demands every row the check reads, so a slow runner never hands back a
			// half-drawn frame: a capture taken mid-redraw would hold the header
			// before the action bar landed, and the check would fail on the missing
			// bar instead of on the field it exists to test.
			const opened = await waitFor(
				(screen) =>
					screen.includes("Shared controls") &&
					screen.includes("Initial input") &&
					collapse(screen).includes("Context 272000") &&
					collapse(screen).includes("Tab Field"),
				"the gallery to draw its fields and its action bar",
			);
			expect(opened).toContain("272000");
			expect(opened).toContain("Initial input");
			expect(collapse(opened)).toContain("Tab Field");

			// An ordinary sequence moves the caret. A digits field that only had its
			// caret touched keeps its text: the key belongs to the field, and the
			// application below it sees nothing.
			await sendKeys("\x1b[D");
			const held = await settle();
			expect(collapse(held)).toContain("Context 272000");

			// A bracketed paste that carries a letter is refused as one operation:
			// `1e3` never becomes `13`, and the field states why in its own row.
			await sendKeys("\x1b[200~1e3\x1b[201~");
			const refused = await waitFor(
				(screen) => screen.includes("takes digits only"),
				"the refusal to be stated on the screen",
			);
			expect(collapse(refused)).toContain("Context 272000");
			expect(refused).not.toMatch(/Context\s+2720013/);
			expect(refused).not.toMatch(/Context\s+27200e/);

			// Typing a digit at the caret the arrow left is taken, so the refusal
			// above was about the letters and not about the terminal path: the value
			// grows by exactly one digit, at the caret, and the row's length proves
			// where it went without pinning the renderer's own padding.
			await sendKeys("7");
			const taken = await waitFor(
				(screen) =>
					collapse(screen).includes("Context 2720070") && !screen.includes("Error: Context"),
				"the typed digit to join the value and the reason to end",
			);
			// The refusal row goes with the edit that was taken: a reason that
			// lingered under a field that had moved on would mislead.
			expect(collapse(taken)).toContain("Context 2720070");
			expect(collapse(taken)).not.toContain("Error: Context");
		} finally {
			await endPane();
		}
	});
});
