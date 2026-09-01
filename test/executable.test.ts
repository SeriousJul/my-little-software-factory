/**
 * Regression test at the real executable boundary: the host owns the mouse.
 *
 * The frame test seam (testRender) cannot observe production renderer
 * startup, so this test starts the shipped control plane bin on a real
 * pseudo-terminal, watches the terminal protocol it emits, and proves the
 * operator-facing contract: the control plane never asks the host for mouse
 * reporting. A host that receives no mouse request keeps its own text
 * selection, so a plain drag or double-click in Herdr (or any terminal or
 * multiplexer) selects control plane text the normal way.
 *
 * The test is isolated: a temporary config with no sources, a temporary
 * state file, a temporary home and XDG state, and an empty PATH, so no real
 * ticket source, user state, or external command (herdr, git, gh) is ever
 * touched. The only outside effect is the process itself, which the test
 * starts and cleanly quits.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { openControlPlanePty, type PtySession } from "./executable-pty.ts";

/**
 * The mouse tracking modes that make a host forward mouse gestures to the
 * application instead of selecting text. Any one of them enabled means the
 * control plane claims the mouse and host text selection stops. The test
 * asserts that none of them is ever requested.
 */
const MOUSE_ENABLE: readonly (readonly [name: string, sequence: string])[] = [
	["normal mouse tracking", "\x1b[?1000h"],
	["button-event (drag) tracking", "\x1b[?1002h"],
	["any-event (motion) tracking", "\x1b[?1003h"],
	["SGR extended mouse encoding", "\x1b[?1006h"],
];

/** The alternate-screen entry: the production renderer is live. */
const ALT_SCREEN = "\x1b[?1049h";

/** The normal quit key: a clean exit proves the input path works end to end. */
const QUIT_KEY = "q";

describe("control plane executable, terminal protocol", () => {
	let dir: string | undefined;
	let session: PtySession | null = null;

	afterAll(() => {
		session?.dispose();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it("never enables terminal mouse reporting and quits cleanly", async (ctx) => {
		dir = mkdtempSync(join(tmpdir(), "factory-exec-"));
		const statePath = join(dir, "state.sqlite");
		// An empty bin dir on PATH: the control plane's external commands
		// (herdr, git, gh) resolve through it, so none of them can run.
		const emptyBin = join(dir, "bin");
		mkdirSync(emptyBin, { recursive: true });
		const configPath = join(dir, "config.toml");
		writeFileSync(
			configPath,
			[
				'default-agent = "pi"',
				'default-environment = "live-worktree"',
				'default-task-type = "implement"',
				`state-file = "${statePath}"`,
				"[agents.pi]",
				'kind = "pi"',
				"[task-types.implement]",
				'template = "Implement {title}"',
				"",
			].join("\n"),
			"utf8",
		);

		session = await openControlPlanePty(["--config", configPath], {
			HOME: dir,
			XDG_CONFIG_HOME: join(dir, ".config"),
			XDG_STATE_HOME: join(dir, ".state"),
			XDG_DATA_HOME: join(dir, ".data"),
			XDG_CACHE_HOME: join(dir, ".cache"),
			PATH: emptyBin,
		});
		if (session === null) {
			ctx.skip("cannot open a pseudo-terminal on this platform");
			return;
		}

		try {
			// Reach normal application startup: the production renderer
			// enters the alternate screen.
			await session.waitFor((out) => out.includes(ALT_SCREEN), "the alternate screen", 20000);
			// Let the app boot, render, and settle: that is when its
			// keyboard handler is reliably live and the quit key will land.
			await session.waitForStable(500, 15000);

			// The operator-facing contract at startup: the control plane
			// must not have asked the host for any mouse tracking mode.
			expectMouseReportingDisabled(session.output(), "at startup");

			// Send the normal quit key and wait for a clean exit: the
			// input path and shutdown both worked end to end.
			session.write(QUIT_KEY);
			const exit = await withTimeout(session.exit(), 10000, "the process to exit");
			expect(exit.code, `process exit (signal ${String(exit.signal)})`).toBe(0);

			// Across the whole session, not just startup, no mouse
			// tracking mode was enabled.
			expectMouseReportingDisabled(session.output(), "over the whole session");
		} finally {
			session.dispose();
			session = null;
		}
	}, 30000);
});

/** Fail with the names of every mouse tracking mode that was enabled. */
function expectMouseReportingDisabled(out: Buffer, when: string): void {
	const enabled = MOUSE_ENABLE.filter(([, sequence]) => out.includes(sequence));
	expect(
		enabled.map(([name]) => name),
		`terminal mouse reporting was enabled ${when}; the host must keep text selection`,
	).toEqual([]);
}

/** Bound a waiter, so a hung process fails the test instead of hanging CI. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
