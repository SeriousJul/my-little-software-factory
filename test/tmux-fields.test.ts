/**
 * The shared fields through a real multiplexer path.
 *
 * This is the acceptance check the shared control standard names for a tmux
 * path: the production gallery runs on a real terminal multiplexer under a real
 * `tmux` binary, keys go in as the bytes a terminal sends them, and the screen
 * is read back out of the pane - the same two directions an operator uses, with
 * no test renderer between them.
 *
 * The check reports itself incomplete rather than passing quietly: when tmux is
 * not installed, it says so in the failure message. A required check that cannot
 * run is not a pass, and a skipped one proves nothing about paste, focus, or
 * rendering.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/** The gallery's production bin: the same renderer startup an operator gets. */
const GALLERY_BIN = join(process.cwd(), "bin", "factory-gallery.mjs");
/** How long one wait on the pane is allowed to run. */
const SETTLE_MS = 25_000;

const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
const available = tmux.status === 0;

/** Start a detached tmux session running one command, at one size. */
function tmuxSpawn(session: string, command: string[], cols: number, rows: number): void {
	const started = spawnSync(
		"tmux",
		["new-session", "-d", "-s", session, "-x", String(cols), "-y", String(rows), ...command],
		{ encoding: "utf8" },
	);
	if (started.status !== 0) {
		throw new Error(`tmux new-session failed: ${started.stderr.trim()}`);
	}
}

/** Collapse a captured screen's runs of spaces, so column padding is not asserted. */
const collapse = (screen: string): string => screen.replace(/[ \t]{2,}/g, " ");

/** Read the pane after it has stopped changing, so a key has landed. */
async function settle(session: string, ms: number): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, ms));
	return tmuxCapture(session);
}

/**
 * Send keys to the session as the terminal sends them.
 *
 * `tmux send-keys -l` writes the literal bytes a key produces, which is what an
 * operator's keystroke is on the wire; the paste run is written the same way, so
 * the field sees the terminal's own bracketed-paste sequence rather than a test's
 * approximation of one.
 */
function tmuxSendKeys(session: string, text: string): void {
	const sent = spawnSync("tmux", ["send-keys", "-t", session, "-l", text], {
		encoding: "utf8",
	});
	if (sent.status !== 0) throw new Error(`tmux send-keys failed: ${sent.stderr.trim()}`);
}

/** The pane's drawn screen: what an operator in front of the terminal reads. */
function tmuxCapture(session: string): string {
	const captured = spawnSync("tmux", ["capture-pane", "-p", "-t", session], {
		encoding: "utf8",
	});
	if (captured.status !== 0) throw new Error(`tmux capture-pane failed: ${captured.stderr.trim()}`);
	return captured.stdout;
}

/** Wait until the pane's screen satisfies a predicate, and return it. */
async function tmuxWaitFor(
	session: string,
	predicate: (screen: string) => boolean,
	what: string,
): Promise<string> {
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const screen = tmuxCapture(session);
		if (predicate(screen)) return screen;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}\nlast screen:\n${screen}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function tmuxKill(session: string): void {
	spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8" });
}

describe("shared fields through tmux", () => {
	const session = `factory-fields-${process.pid}`;
	let dir: string;

	beforeAll(() => {
		if (!available) {
			throw new Error(
				"tmux is not installed, so the multiplexer acceptance check cannot run; " +
					"it is recorded as incomplete, not as passed",
			);
		}
		dir = mkdtempSync(join(tmpdir(), "factory-tmux-"));
	});

	afterAll(() => {
		tmuxKill(session);
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	test("a real terminal path draws the fields, takes ordinary keys, and refuses a bad paste whole", async () => {
		tmuxSpawn(session, [process.execPath, "--experimental-ffi", GALLERY_BIN, "fields"], 90, 26);
		try {
			// The gallery is up and the shared chrome drew its controls.
			const opened = await tmuxWaitFor(
				session,
				(screen) => screen.includes("Shared controls") && screen.includes("Context"),
				"the gallery to draw its fields",
			);
			expect(opened).toContain("272000");
			expect(opened).toContain("Initial input");
			expect(collapse(opened)).toContain("Tab Field");

			// An ordinary sequence moves the caret. A digits field that only had its
			// caret touched keeps its text: the key belongs to the field, and the
			// application below it sees nothing.
			tmuxSendKeys(session, "\x1b[D");
			const held = await settle(session, 400);
			expect(collapse(held)).toContain("Context 272000");

			// A bracketed paste that carries a letter is refused as one operation:
			// `1e3` never becomes `13`, and the field states why in its own row.
			tmuxSendKeys(session, "\x1b[200~1e3\x1b[201~");
			const refused = await tmuxWaitFor(
				session,
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
			tmuxSendKeys(session, "7");
			const taken = await tmuxWaitFor(
				session,
				(screen) =>
					collapse(screen).includes("Context 2720070") && !screen.includes("Error: Context"),
				"the typed digit to join the value and the reason to end",
			);
			// The refusal row goes with the edit that was taken: a reason that
			// lingered under a field that had moved on would mislead.
			expect(collapse(taken)).toContain("Context 2720070");
			expect(collapse(taken)).not.toContain("Error: Context");
		} finally {
			tmuxKill(session);
		}
	});
});
