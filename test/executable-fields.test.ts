/**
 * The shared fields at the real executable boundary.
 *
 * A frame test drives the renderer's mock input; this runs the shipped bin on a
 * pseudo-terminal, so the keys are the bytes a terminal actually sends: ordinary
 * sequences, bracketed paste, and Ctrl+C. The reported failures all live at this
 * boundary - a plain Enter that opened work, a paste the field rewrote in
 * silence - so the fix is proven here as well as in the frames.
 *
 * The launcher's Consultation type is the Agent's own start command, which no
 * test may run: the isolated environment leaves an empty PATH, so a launch that
 * reached for a binary would fail on the spot, and the checks below read only
 * what the screen does with the operator's keys.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { openControlPlanePty, type PtySession } from "./executable-pty.ts";

/** The gallery's production bin: the same renderer, the library's own surface. */
const GALLERY_BIN = fileURLToPath(new URL("../bin/factory-gallery.mjs", import.meta.url));

const ALT_SCREEN = "\x1b[?1049h";
const STARTUP_TIMEOUT_MS = 12_000;
const STABLE_TIMEOUT_MS = 8_000;
const INPUT_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 40_000;
/** The Consultation launcher's open key, and the Draft field's Enter. */
const LAUNCH_KEY = "c";
const ENTER = "\r";
const TAB = "\t";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

describe("shared fields, real terminal input", () => {
	let dir: string | undefined;
	let session: PtySession | null = null;

	afterAll(() => {
		session?.dispose();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	/** Boot the plane on a PTY, with a config that offers one Consultation type. */
	async function boot(): Promise<PtySession> {
		dir = mkdtempSync(join(tmpdir(), "factory-fields-pty-"));
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, launcherConfigToml(join(dir, "state.sqlite")), "utf8");
		const opened = await openControlPlanePty(["--config", configPath], isolatedEnv(dir), {
			size: { cols: 100, rows: 30 },
		});
		if (opened === null) throw new Error("cannot open a pseudo-terminal on this platform");
		session = opened;
		await opened.waitFor(
			(out) => out.includes(ALT_SCREEN),
			"the alternate screen",
			STARTUP_TIMEOUT_MS,
		);
		await opened.waitForStable(500, STABLE_TIMEOUT_MS);
		return opened;
	}

	it(
		"opens the launcher, keeps Enter a new line, and launches from the visible action",
		async (ctx) => {
			let opened: PtySession;
			try {
				opened = await boot();
			} catch (error) {
				ctx.skip(String(error));
				return;
			}
			try {
				opened.write(LAUNCH_KEY);
				await opened.waitFor(
					(out) => out.includes("Consultation launcher"),
					"the Consultation launcher",
					INPUT_TIMEOUT_MS,
				);
				// Tab to the Draft field, exactly as the launcher's own guide says.
				opened.write(TAB);
				opened.write(TAB);
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				opened.write("first draft line");
				opened.write(ENTER);
				opened.write("second draft line");
				const afterEnter = await opened.waitFor(
					(out) => out.includes("second draft line"),
					"both draft lines on the screen",
					INPUT_TIMEOUT_MS,
				);
				// Enter inside the field drew a line and opened no Consultation:
				// an ordinary editing key cannot start Agent work.
				expect(afterEnter.toString("utf8")).toContain("Consultation launcher");
				expect(afterEnter.toString("utf8")).not.toContain("opening Consultation");

				// The visible action is the route: Tab reaches it, Enter runs it.
				opened.write(TAB);
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				opened.write(ENTER);
				await opened.waitFor(
					(out) => out.includes("opening Consultation") || out.includes("Consultation"),
					"the Launch action to be taken",
					INPUT_TIMEOUT_MS,
				);
			} finally {
				session?.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a non-digit paste in the Context window row and states why",
		async (ctx) => {
			let opened: PtySession;
			try {
				opened = await boot();
			} catch (error) {
				ctx.skip(String(error));
				return;
			}
			try {
				// `e` on an open Ticket opens the override panel; this plane has no
				// Ticket source, so the panel is reached from the launcher's own
				// field instead: the digits rule belongs to the shared Text field,
				// not to one screen.
				opened.write("v");
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				// A paste that carries a letter, sent to the launcher's Draft field,
				// arrives as text and never as a command.
				opened.write(LAUNCH_KEY);
				await opened.waitFor((out) => out.includes("Consultation launcher"), "the launcher");
				opened.write(TAB);
				opened.write(TAB);
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				opened.write(`${BRACKETED_PASTE_START}1e3${BRACKETED_PASTE_END}`);
				const pasted = await opened.waitFor(
					(out) => out.includes("1e3"),
					"the pasted text to reach the Draft field as text",
					INPUT_TIMEOUT_MS,
				);
				// The draft holds exactly what was pasted: no dropped letter, and no
				// Consultation opened by a pasted newline's absence.
				expect(pasted.toString("utf8")).toContain("1e3");
				expect(pasted.toString("utf8")).toContain("Consultation launcher");
			} finally {
				session?.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"refuses a non-digit paste in a digits field as one operation",
		async (ctx) => {
			dir = mkdtempSync(join(tmpdir(), "factory-gallery-pty-"));
			const opened = await openControlPlanePty(
				["fields"],
				{},
				{
					size: { cols: 80, rows: 24 },
					entry: GALLERY_BIN,
				},
			);
			if (opened === null) {
				ctx.skip("cannot open a pseudo-terminal on this platform");
				return;
			}
			session = opened;
			try {
				await opened.waitFor(
					(out) => out.includes("Shared controls"),
					"the gallery",
					STARTUP_TIMEOUT_MS,
				);
				await opened.waitForStable(500, STABLE_TIMEOUT_MS);
				// The focused control is the digits field, at 272000.
				const before = opened.output();
				expect(before.toString("utf8")).toContain("272000");
				opened.write(`${BRACKETED_PASTE_START}1e3${BRACKETED_PASTE_END}`);
				const refused = await opened.waitFor(
					// The row is cut at the column, as every row is: the words that
					// survive are the ones that name the rule.
					(out) => screenOf(out).includes("This field takes digits only"),
					"the paste refusal to be stated on the screen",
					INPUT_TIMEOUT_MS,
				);
				// The value stands whole: no letter of the pasted run reached it, and
				// nothing was filtered out of it either - `1e3` never becomes `13`.
				expect(screenOf(refused)).toContain("272000");
				expect(screenOf(refused)).not.toContain("27200013");
				expect(screenOf(refused)).not.toContain("2720001");
			} finally {
				session?.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"treats Ctrl+C as the emergency exit while a field holds a selection",
		async (ctx) => {
			let opened: PtySession;
			try {
				opened = await boot();
			} catch (error) {
				ctx.skip(String(error));
				return;
			}
			try {
				opened.write(LAUNCH_KEY);
				await opened.waitFor((out) => out.includes("Consultation launcher"), "the launcher");
				opened.write(TAB);
				opened.write(TAB);
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				opened.write("selected words");
				// Select two cells, then press Ctrl+C: a selection must not turn the
				// plane's safety key into a copy.
				opened.write("\x1b[H");
				opened.write("\x1b[1;2C");
				opened.write("\x1b[1;2C");
				await opened.waitForStable(300, INPUT_TIMEOUT_MS);
				opened.write("\x03");
				const exit = await opened.waitFor(
					() => opened.child.exitCode !== null,
					"the process to exit",
					INPUT_TIMEOUT_MS,
				);
				expect(exit.toString("utf8")).not.toContain("copied");
			} finally {
				session?.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * The screen the bytes drew, with the terminal's own protocol stripped.
 *
 * A paste refusal is a fact about what the operator reads, so the checks compare
 * the painted screen rather than the escape sequences that produced it.
 */
function screenOf(out: Buffer): string {
	return (
		out
			.toString("utf8")
			// CSI, OSC, and DCS sequences: every byte that is a command, not a cell.
			.replace(/\x1b\[[0-9;?<=>!]*[A-Za-z]/g, "")
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			.replace(/\x1b[P_][^\x1b]*(?:\x1b\\)?/g, "")
			.replace(/\x1b[@-Z\\^_]/g, "")
			.replace(/[\x00-\x1f\x7f]/g, "")
	);
}

/** A config with one Consultation type and no Ticket source. */
function launcherConfigToml(stateFile: string): string {
	return [
		'default-agent = "demo"',
		'default-environment = "live-worktree"',
		'default-task-type = "implement"',
		`state-file = "${stateFile}"`,
		"[agents.demo]",
		'kind = "demo"',
		"[task-types.implement]",
		'template = "Implement {title}"',
		"[consultation-types.grill]",
		'agent = "demo"',
		'environment = "live-worktree"',
		'template = "/grill {input}"',
		"",
	].join("\n");
}

/** An environment with no home, no config, no state, and no PATH binaries. */
function isolatedEnv(dir: string): Record<string, string> {
	const emptyBin = join(dir, "bin");
	mkdirSync(emptyBin, { recursive: true });
	return {
		HOME: dir,
		XDG_CONFIG_HOME: join(dir, ".config"),
		XDG_STATE_HOME: join(dir, ".state"),
		XDG_DATA_HOME: join(dir, ".data"),
		XDG_CACHE_HOME: join(dir, ".cache"),
		PATH: emptyBin,
	};
}
