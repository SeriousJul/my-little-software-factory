/**
 * Regression test at the real executable boundary: mouse controls are live.
 *
 * The frame test seam cannot observe production renderer startup, so this
 * test starts the shipped bin on a pseudo-terminal and reads its protocol.
 * Ticket controls need mouse reporting for wheel input, track clicks, and
 * thumb drags. This later control decision supersedes host text selection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
			const configPath = join(dir, "config.toml");
			writeFileSync(configPath, configToml(join(dir, "state.sqlite")), "utf8");

			session = await openControlPlanePty(["--config", configPath], isolatedEnv(dir));
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
				// A config file that exists must not be reported as missing.
				expect(session.output().toString("utf8")).not.toContain("no config file at");
			} finally {
				session.dispose();
				session = null;
			}
		},
		TEST_TIMEOUT_MS,
	);

	// Every bad startup argument must end in a readable line and a nonzero exit,
	// with the UI never entered.
	const startupFailures: Array<{ name: string; argv: (dir: string) => string[]; needle: string }> =
		[
			{
				name: "an unknown argument",
				argv: () => ["--unknown"],
				needle: "usage: factory [--config <path>]",
			},
			{
				name: "a --config flag with no path",
				argv: () => ["--config"],
				needle: "usage: factory [--config <path>]",
			},
			{
				name: "an empty config path",
				argv: () => ["--config", ""],
				needle: "usage: factory [--config <path>]",
			},
			{
				name: "a trailing extra argument",
				argv: (dir) => ["--config", join(dir, "unused.toml"), "extra"],
				needle: "usage: factory [--config <path>]",
			},
			{
				name: "an invalid config file",
				argv: (dir) => {
					writeFileSync(join(dir, "invalid.toml"), "default-agent = 42\n", "utf8");
					return ["--config", join(dir, "invalid.toml")];
				},
				needle: "default-agent",
			},
			{
				name: "a state file that cannot be opened",
				argv: (dir) => {
					// A directory where the state database must be created.
					mkdirSync(join(dir, "state.sqlite"), { recursive: true });
					const blocked = join(dir, "blocked.toml");
					writeFileSync(blocked, configToml(join(dir, "state.sqlite")), "utf8");
					return ["--config", blocked];
				},
				needle: "cannot open factory state",
			},
		];

	for (const failure of startupFailures) {
		it(
			`exits with a readable error before the UI starts for ${failure.name}`,
			async (ctx) => {
				const isolated = mkdtempSync(join(tmpdir(), "factory-exec-failure-"));
				let bad: PtySession | null = null;
				try {
					bad = await openControlPlanePty(failure.argv(isolated), isolatedEnv(isolated));
					if (bad === null) {
						ctx.skip("cannot open a pseudo-terminal on this platform");
						return;
					}
					const output = await bad.waitFor(
						(out) => out.toString("utf8").includes(failure.needle),
						`the ${failure.name} error`,
						EXIT_TIMEOUT_MS,
					);
					const exit = await withTimeout(
						bad.exit(),
						EXIT_TIMEOUT_MS,
						`the ${failure.name} process to exit`,
					);
					expect(exit.code).not.toBe(0);
					expect(output.toString("utf8")).toContain(failure.needle);
					expect(output.toString("utf8"), output.toString("utf8")).not.toContain(ALT_SCREEN);
				} finally {
					bad?.dispose();
					rmSync(isolated, { recursive: true, force: true });
				}
			},
			TEST_TIMEOUT_MS,
		);
	}

	it(
		"starts with shipped defaults and a note when the config file is missing",
		async (ctx) => {
			const isolated = mkdtempSync(join(tmpdir(), "factory-exec-defaults-"));
			let defaults: PtySession | null = null;
			try {
				const missing = join(isolated, "does-not-exist.toml");
				defaults = await openControlPlanePty(["--config", missing], isolatedEnv(isolated));
				if (defaults === null) {
					ctx.skip("cannot open a pseudo-terminal on this platform");
					return;
				}
				await defaults.waitFor(
					(out) => out.includes(ALT_SCREEN),
					"the defaults UI to start",
					STARTUP_TIMEOUT_MS,
				);
				await defaults.waitFor(
					(out) =>
						out
							.toString("utf8")
							.includes(`no config file at ${missing}, using the shipped defaults`),
					"the shipped-defaults note",
					STARTUP_TIMEOUT_MS,
				);
				await defaults.waitForStable(500, STABLE_TIMEOUT_MS);
				defaults.write(QUIT_KEY);
				const exit = await withTimeout(
					defaults.exit(),
					EXIT_TIMEOUT_MS,
					"the defaults process to exit",
				);
				expect(exit.code).toBe(0);
			} finally {
				defaults?.dispose();
				rmSync(isolated, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * The environment one startup case runs in: a home nothing reads, and an
 * empty bin dir on PATH so the control plane's external commands (herdr, git,
 * gh) resolve through it and none of them can run.
 */
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

/** One valid startup config, pointed at the state file the case needs. */
function configToml(stateFile: string): string {
	return [
		'default-agent = "pi"',
		'default-environment = "live-worktree"',
		'default-task-type = "implement"',
		`state-file = "${stateFile}"`,
		"[agents.pi]",
		'kind = "pi"',
		"[task-types.implement]",
		'template = "Implement {title}"',
		"",
	].join("\n");
}

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
