/**
 * Tests for the startup decisions.
 *
 * The startup module is what the entry calls before it starts the renderer,
 * and it is scored: every decision returns a value (the operator-facing
 * reason text and the exit status) instead of printing and exiting, so a
 * test reads it directly, with no process and no pseudo-terminal in the way.
 * The pseudo-terminal suite (test/executable.test.ts) still pins the shipped
 * bin end to end; these tests pin the words and the order.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { defaultConfigPath, validateConfig } from "../src/config.ts";
import {
	configPathFromArgs,
	installStateShutdown,
	loadStartupConfig,
	openStartupState,
	runStartup,
	startupArgs,
	USAGE,
} from "../src/startup.ts";
import { stubEnv, unstubAllEnvs } from "./env-stub.ts";

const USAGE_EXPECTED = "usage: factory [--config <path>] | factory --version";

/** The checked-in Default configuration the package ships. */
const SHIPPED_DEFAULT_CONFIG = fileURLToPath(new URL("../config/default.toml", import.meta.url));

const tempDirs: string[] = [];

/**
 * The lines minus the model check warnings.
 *
 * The whole-startup cases run the real agent CLI. On a machine without the
 * agent runtime the model list fails and a `warning:` line appears, so the
 * assertions hold on both kinds of machines: they pin every line that is
 * not a model warning, and the warnings when present.
 */
function withoutModelWarnings(lines: readonly string[]): string[] {
	return lines.filter((line) => !line.startsWith("warning: "));
}

function inTempDir(prefix: string): (name: string) => string {
	const dir = mkdtempSync(join(tmpdir(), `factory-${prefix}-`));
	tempDirs.push(dir);
	return (name: string) => join(dir, name);
}

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

afterEach(() => {
	unstubAllEnvs();
});

/** A valid config body, pointed at the state file the case names. */
function configBody(stateFile?: string, sources?: boolean, defaultModel?: string): string {
	return [
		...(defaultModel === undefined ? [] : [`default-model = "${defaultModel}"`]),
		'default-agent = "pi"',
		'default-environment = "live-worktree"',
		'default-task-type = "implement"',
		...(stateFile === undefined ? [] : [`state-file = "${stateFile}"`]),
		"[agents.pi]",
		'kind = "pi"',
		'model = "--model {value}"',
		"[task-types.implement]",
		'template = "Implement {title}"',
		...(sources
			? [
					"[[sources]]",
					'name = "issues"',
					'kind = "github-issues"',
					"refresh-interval-seconds = 60",
					'repositories = ["owner/name"]',
				]
			: []),
		"",
	].join("\n");
}

describe("the startup argument handling", () => {
	test("the usage line names both the config flag and the version flag", () => {
		expect(USAGE).toBe(USAGE_EXPECTED);
	});

	test("no argument is the shipped default config path", () => {
		expect(configPathFromArgs([])).toEqual({ ok: true, configPath: defaultConfigPath() });
	});

	test("--config with a path selects that path", () => {
		expect(configPathFromArgs(["--config", "/tmp/one/config.toml"])).toEqual({
			ok: true,
			configPath: "/tmp/one/config.toml",
		});
	});

	test.each([
		["an unknown argument", ["--unknown"]],
		["the --version flag, which the boot does not take", ["--version"]],
		["a --config flag with no path", ["--config"]],
		["an empty config path", ["--config", ""]],
		["a different flag with a value", ["--other", "/tmp/one/config.toml"]],
		["a trailing extra argument", ["--config", "/tmp/one/config.toml", "extra"]],
	])("any other argument list yields the usage line: %s", (_name, args) => {
		expect(configPathFromArgs(args)).toEqual({ ok: false, reason: USAGE_EXPECTED });
	});

	test("--version alone is the version decision, which the entry answers before the boot", () => {
		expect(startupArgs(["--version"])).toEqual({ kind: "version" });
	});

	test("every non-version argument list is the run or the usage decision", () => {
		expect(startupArgs([])).toEqual({ kind: "run", configPath: defaultConfigPath() });
		expect(startupArgs(["--config", "/tmp/one/config.toml"])).toEqual({
			kind: "run",
			configPath: "/tmp/one/config.toml",
		});
		expect(startupArgs(["--unknown"])).toEqual({ kind: "usage", reason: USAGE_EXPECTED });
	});
});

describe("the startup config load", () => {
	test("a valid file loads without a note", async () => {
		const path = inTempDir("config-valid")("config.toml");
		writeFileSync(path, configBody(), "utf8");
		const loaded = await loadStartupConfig(path);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.note).toBeUndefined();
		expect(loaded.config.defaultAgent).toBe("pi");
	});

	test("a missing file is seeded from the Default configuration with the note", async () => {
		const missing = inTempDir("config-missing")("does-not-exist.toml");
		const loaded = await loadStartupConfig(missing);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.note).toBe(
			`no config file at ${missing}; created it from the shipped Default configuration`,
		);
		expect(loaded.config).toEqual(
			validateConfig(parseToml(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"))),
		);
		expect(readFileSync(missing, "utf8")).toBe(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"));
	});

	test("an invalid file is one failure line", async () => {
		const path = inTempDir("config-invalid")("invalid.toml");
		writeFileSync(path, "default-agent = 42\n", "utf8");
		const loaded = await loadStartupConfig(path);
		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.reason).toContain("default-agent");
	});

	test("an unreadable file is one failure line", async () => {
		const path = inTempDir("config-broken")("broken.toml");
		writeFileSync(path, 'default-agent = "pi" [\n', "utf8");
		const loaded = await loadStartupConfig(path);
		expect(loaded.ok).toBe(false);
		if (loaded.ok) return;
		expect(loaded.reason).toContain("invalid TOML");
	});
});

describe("the startup state open", () => {
	test("a usable path opens the state and takes the lease", () => {
		const path = inTempDir("state-open")("state.sqlite");
		const opened = openStartupState(path);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(existsSync(path)).toBe(true);
		// The lease is taken: a second control plane on the same state
		// database is refused while the first one holds it.
		const second = openStartupState(path);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.reason).toContain("already in use by process");
		opened.state.close();
	});

	test("a path that cannot be opened is one failure line", () => {
		const at = inTempDir("state-blocked")("state.sqlite");
		mkdirSync(at, { recursive: true });
		const opened = openStartupState(at);
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.reason).toContain(`cannot open factory state at ${at}`);
	});

	/**
	 * The remnant a dead run leaves in the state file: the ticket and its
	 * handoff claim, the claim unsettled the way a crash or a watch reset
	 * leaves it.
	 */
	function plantRemnant(path: string): void {
		const db = new Database(path);
		db.prepare(
			"INSERT INTO tickets(identity, state, work_cycle) VALUES ('github:github.com:I_5', 'open', 1)",
		).run();
		db.prepare(
			"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at) VALUES ('remnant', 'github:github.com:I_5', 1, '{}', 'starting-agent', '2026-09-20T18:55:34.000Z')",
		).run();
		db.close();
	}

	test("opening settles a remnant claim and reports the recovery as a note", () => {
		const path = inTempDir("state-recovery")("state.sqlite");
		const opened = openStartupState(path);
		if (!opened.ok) throw new Error(opened.reason);
		expect(opened.notes).toEqual([]);
		opened.state.close();
		plantRemnant(path);

		const next = openStartupState(path);
		expect(next.ok).toBe(true);
		if (!next.ok) return;
		expect(next.notes).toEqual(["recovered 1 handoff claim left unsettled by the previous run"]);
		// The remnant settled as a failed start, so the ticket's recovery
		// block is gone with it.
		const db = new Database(path);
		const remnant = db
			.prepare(
				"SELECT stage, resolved_at, failure_reason FROM handoff_attempts WHERE attempt_id = 'remnant'",
			)
			.get() as { stage: string; resolved_at: string | null; failure_reason: string | null };
		expect(remnant.stage).toBe("failed");
		expect(remnant.resolved_at).not.toBeNull();
		expect(remnant.failure_reason).toBe(
			"the run that claimed this handoff ended before it settled it",
		);
		db.close();
		next.state.close();
	});
});

describe("the state shutdown", () => {
	/**
	 * A process that records what the shutdown attaches to.
	 *
	 * The recorder stands in for the real process, so the test pulls the hook it
	 * wrote instead of sending a signal to the test runner, and the exit it asks
	 * for is a mark on a list instead of the end of the suite.
	 */
	function recordingProcess() {
		const hooks = new Map<string, () => void>();
		const exits: number[] = [];
		return {
			hooks,
			exits,
			on(signal: string, listener: () => void) {
				hooks.set(signal, listener);
			},
			exit(code?: number) {
				exits.push(code ?? 0);
			},
			/** Run one recorded hook the way the process would. */
			fire(signal: string): void {
				const hook = hooks.get(signal);
				expect(hook, `no hook recorded for ${signal}`).toBeDefined();
				hook?.();
			},
		};
	}

	/** An open state and its lease, at a path of its own. */
	function leasedState(prefix: string) {
		const path = inTempDir(prefix)("state.sqlite");
		const opened = openStartupState(path);
		if (!opened.ok) throw new Error(opened.reason);
		return { path, state: opened.state };
	}

	test("the shutdown writes an exit hook and both end signals", () => {
		const { state } = leasedState("shutdown-hooks");
		const target = recordingProcess();
		installStateShutdown(state, target);
		expect([...target.hooks.keys()].sort()).toEqual(["SIGHUP", "SIGTERM", "exit"]);
		state.close();
	});

	test("the exit hook closes the state", () => {
		const { path, state } = leasedState("shutdown-exit");
		const target = recordingProcess();
		installStateShutdown(state, target);
		target.fire("exit");
		// The lease is back on the shelf: the next control plane opens.
		const next = openStartupState(path);
		expect(next.ok).toBe(true);
		if (next.ok) next.state.close();
	});

	test.each(["SIGTERM", "SIGHUP"])(
		"a run that ends on %s gives the lease back before it ends",
		(signal: string) => {
			const { path, state } = leasedState(`shutdown-${signal}`);
			const target = recordingProcess();
			installStateShutdown(state, target);
			target.fire(signal);
			// The run asks for the exit, so an app that installs this is still
			// stoppable by kill instead of shrugging the signal off.
			expect(target.exits).toEqual([0]);
			// This is the `bun run dev` shape: the watch reset delivers the signal,
			// then re-runs the boot in the same process, so the next boot is the one
			// that would otherwise read this process's own pid in the lease row and
			// stop with "state database is already in use".
			const next = openStartupState(path);
			expect(next.ok).toBe(true);
			if (next.ok) next.state.close();
		},
	);

	test("the signal path and the exit hook together still close once", () => {
		const { state } = leasedState("shutdown-twice");
		const target = recordingProcess();
		installStateShutdown(state, target);
		// The signal closes the state and ends the run; ending the run fires the
		// exit hook, which finds the state already closed.
		target.fire("SIGTERM");
		expect(() => target.fire("exit")).not.toThrow();
		expect(target.exits).toEqual([0]);
	});
});

describe("the whole startup", () => {
	test("a bad argument list is the usage line and a nonzero exit", async () => {
		const result = await runStartup(["--unknown"]);
		expect(result).toEqual({ ok: false, lines: [USAGE], exitCode: 1 });
	});

	test("an invalid config stops before the state opens", async () => {
		const stateHome = inTempDir("run-config")("state-home");
		stubEnv("XDG_STATE_HOME", stateHome);
		const at = inTempDir("run-config")("invalid.toml");
		writeFileSync(at, "default-agent = 42\n", "utf8");
		const result = await runStartup(["--config", at]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.exitCode).toBe(1);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toContain("default-agent");
		expect(existsSync(join(stateHome, "my-little-software-factory", "state.sqlite"))).toBe(false);
	});

	test("a blocked state path stops with its failure line", async () => {
		const blocked = inTempDir("run-state")("state.sqlite");
		mkdirSync(blocked, { recursive: true });
		const configPath = inTempDir("run-state")("config.toml");
		writeFileSync(configPath, configBody(blocked), "utf8");
		const result = await runStartup(["--config", configPath]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.exitCode).toBe(1);
		// The failure line is the one non-warning line, and the warnings,
		// when any, come before it.
		const rest = withoutModelWarnings(result.lines);
		expect(rest).toHaveLength(1);
		expect(rest[0]).toContain(`cannot open factory state at ${blocked}`);
		expect(result.lines[result.lines.length - 1]).toBe(rest[0]);
	});

	test("a blocked state path carries the model warnings before the failure line", async () => {
		const blocked = inTempDir("run-state-warn")("state.sqlite");
		mkdirSync(blocked, { recursive: true });
		const configPath = inTempDir("run-state-warn")("config.toml");
		// A model value makes the boot fetch the agent's Model list.
		writeFileSync(configPath, configBody(blocked, false, "pi/openai/gpt-test"), "utf8");
		// An empty PATH makes the agent CLI unavailable on any machine: the
		// model list fails, the boot warns, and it must still reach the state
		// open, which fails last.
		const emptyBin = inTempDir("run-state-warn")("empty-bin");
		mkdirSync(emptyBin, { recursive: true });
		stubEnv("PATH", emptyBin);
		const result = await runStartup(["--config", configPath]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.exitCode).toBe(1);
		expect(result.lines.length).toBeGreaterThan(1);
		for (const line of result.lines.slice(0, -1)) {
			expect(line).toMatch(/^warning: /);
		}
		expect(result.lines[result.lines.length - 1]).toContain(
			`cannot open factory state at ${blocked}`,
		);
	});

	test("a valid config opens the state and carries the renderer inputs", async () => {
		const statePath = inTempDir("run-ready")("state.sqlite");
		const configPath = inTempDir("run-ready")("config.toml");
		writeFileSync(configPath, configBody(statePath, true), "utf8");
		const result = await runStartup(["--config", configPath]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.configPath).toBe(configPath);
		expect(result.statePath).toBe(statePath);
		expect(withoutModelWarnings(result.notes)).toEqual([]);
		expect(result.sources.map((source) => source.name)).toEqual(["issues"]);
		expect(typeof result.runner.run).toBe("function");
		expect(existsSync(statePath)).toBe(true);
		result.state.close();
	});

	test("a missing config is seeded from the Default configuration with the note", async () => {
		const stateHome = inTempDir("run-defaults")("state-home");
		stubEnv("XDG_STATE_HOME", stateHome);
		const missing = inTempDir("run-defaults")("does-not-exist.toml");
		const result = await runStartup(["--config", missing]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config).toEqual(
			validateConfig(parseToml(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"))),
		);
		expect(withoutModelWarnings(result.notes)).toEqual([
			`no config file at ${missing}; created it from the shipped Default configuration`,
		]);
		// The seed lands at the path the operator asked for, verbatim.
		expect(readFileSync(missing, "utf8")).toBe(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"));
		expect(result.statePath).toBe(join(stateHome, "my-little-software-factory", "state.sqlite"));
		expect(existsSync(result.statePath)).toBe(true);
		result.state.close();
	});
});
