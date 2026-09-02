/**
 * Regression test at the real executable boundary: mouse controls are live.
 *
 * The frame test seam cannot observe production renderer startup, so this
 * test starts the shipped bin on a pseudo-terminal and reads its protocol.
 * Ticket controls need mouse reporting for wheel input, track clicks, and
 * thumb drags. This later control decision supersedes host text selection.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { openControlPlanePty, type PtySession } from "./executable-pty.ts";

/** The reporting modes required for the control plane's pointer controls. */
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
const STARTUP_TIMEOUT_MS = 10_000;
const STABLE_TIMEOUT_MS = 8_000;
const EXIT_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 30_000;

describe("control plane executable, terminal protocol", () => {
	let dir: string | undefined;
	let session: PtySession | null = null;

	afterAll(() => {
		session?.dispose();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it(
		"enables terminal mouse reporting and quits cleanly",
		async (ctx) => {
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
				await session.waitFor(
					(out) => out.includes(ALT_SCREEN),
					"the alternate screen",
					STARTUP_TIMEOUT_MS,
				);
				// Let the app boot, render, and settle: that is when its
				// keyboard handler is reliably live and the quit key will land.
				await session.waitForStable(500, STABLE_TIMEOUT_MS);

				// The executable boundary must enable the reporting modes that
				// deliver wheel, click, and drag input to the panes.
				expectMouseReportingEnabled(session.output(), "at startup");

				// Send the normal quit key and wait for a clean exit: the
				// input path and shutdown both worked end to end.
				session.write(QUIT_KEY);
				const exit = await withTimeout(session.exit(), EXIT_TIMEOUT_MS, "the process to exit");
				expect(exit.code, `process exit (signal ${String(exit.signal)})`).toBe(0);

				// The startup request remains observable in the full session.
				expectMouseReportingEnabled(session.output(), "over the whole session");
			} finally {
				session.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("control plane executable, the startup Model list check", () => {
	/**
	 * The config the check reads: one task profile that names a model, against
	 * one `pi` agent that maps the setting (ADR 0010).
	 */
	function modelConfig(statePath: string): string {
		return [
			'default-agent = "pi"',
			'default-environment = "live-worktree"',
			'default-task-type = "implement"',
			`state-file = "${statePath}"`,
			"[agents.pi]",
			'kind = "pi"',
			'model = "--model {value}"',
			"[task-types.implement]",
			'template = "Implement {title}"',
			'model = "anthropic/missing-model"',
			"",
		].join("\n");
	}

	/** Put a stand-in `pi` on the PATH the control plane resolves through. */
	function stubPi(bin: string): void {
		const path = join(bin, "pi");
		writeFileSync(
			path,
			[
				"#!/bin/sh",
				"printf 'provider  model  context  max-out  thinking  images\\n'",
				"printf 'anthropic  claude-sonnet-4-5  200000  16384  true  true\\n'",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(path, 0o755);
	}

	async function boot(
		dir: string,
		withPi: boolean,
	): Promise<{ session: PtySession | null; configPath: string; statePath: string }> {
		const emptyBin = join(dir, "bin");
		mkdirSync(emptyBin, { recursive: true });
		if (withPi) stubPi(emptyBin);
		const statePath = join(dir, "state.sqlite");
		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, modelConfig(statePath), "utf8");
		const session = await openControlPlanePty(["--config", configPath], {
			HOME: dir,
			XDG_CONFIG_HOME: join(dir, ".config"),
			XDG_STATE_HOME: join(dir, ".state"),
			XDG_DATA_HOME: join(dir, ".data"),
			XDG_CACHE_HOME: join(dir, ".cache"),
			PATH: emptyBin,
		});
		return { session, configPath, statePath };
	}

	it(
		"a config that names an unavailable model stops the control plane before it opens anything",
		async (ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "factory-exec-model-"));
			const { session, statePath } = await boot(dir, true);
			if (session === null) {
				rmSync(dir, { recursive: true, force: true });
				ctx.skip("cannot open a pseudo-terminal on this platform");
				return;
			}
			try {
				// The error line the operator reads instead of losing a ticket.
				const out = await session.waitFor(
					(o) => o.includes('has no model "anthropic/missing-model"'),
					"the startup model error",
					STARTUP_TIMEOUT_MS,
				);
				expect(out.toString()).toContain("check the model id and its provider auth");
				// The boot stops there: no window, and no state file opened behind it.
				const exit = await withTimeout(session.exit(), EXIT_TIMEOUT_MS, "the process to exit");
				expect(exit.code, `process exit (signal ${String(exit.signal)})`).toBe(1);
				expect(session.output().includes(ALT_SCREEN)).toBe(false);
				expect(existsSync(statePath)).toBe(false);
			} finally {
				session.dispose();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a Model list that cannot be fetched warns and lets the control plane start",
		async (ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "factory-exec-model-"));
			// No `pi` on PATH: the query fails, so the value stays unchecked and the
			// boot continues. One silent agent kind must not block the control plane.
			const { session, statePath } = await boot(dir, false);
			if (session === null) {
				rmSync(dir, { recursive: true, force: true });
				ctx.skip("cannot open a pseudo-terminal on this platform");
				return;
			}
			try {
				await session.waitFor(
					(o) => o.includes("its model list is unavailable"),
					"the startup warning",
					STARTUP_TIMEOUT_MS,
				);
				// The boot reached the renderer, and the state file exists: a failed
				// query warns, it does not stop.
				await session.waitFor(
					(o) => o.includes(ALT_SCREEN),
					"the alternate screen",
					STARTUP_TIMEOUT_MS,
				);
				expect(existsSync(statePath)).toBe(true);
				expect(session.output().toString()).not.toContain('has no model "anthropic/missing-model"');
			} finally {
				session.dispose();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/** Fail with the names of reporting modes missing from renderer startup. */
function expectMouseReportingEnabled(out: Buffer, when: string): void {
	const missing = MOUSE_ENABLE.filter(([, sequence]) => !out.includes(sequence));
	expect(
		missing.map(([name]) => name),
		`terminal mouse reporting was not fully enabled ${when}; Ticket pointer controls need it`,
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
