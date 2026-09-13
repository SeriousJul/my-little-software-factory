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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG, defaultConfigPath } from "../src/config.ts";
import {
	configPathFromArgs,
	loadStartupConfig,
	openStartupState,
	runStartup,
} from "../src/startup.ts";

const USAGE = "usage: factory [--config <path>]";

const tempDirs: string[] = [];

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
	vi.unstubAllEnvs();
});

/** A valid config body, pointed at the state file the case names. */
function configBody(stateFile?: string): string {
	return [
		'default-agent = "pi"',
		'default-environment = "live-worktree"',
		'default-task-type = "implement"',
		...(stateFile === undefined ? [] : [`state-file = "${stateFile}"`]),
		"[agents.pi]",
		'kind = "pi"',
		'model = "--model {value}"',
		"[task-types.implement]",
		'template = "Implement {title}"',
		"",
	].join("\n");
}

describe("the startup argument handling", () => {
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
		["a --config flag with no path", ["--config"]],
		["an empty config path", ["--config", ""]],
		["a trailing extra argument", ["--config", "/tmp/one/config.toml", "extra"]],
	])("any other argument list yields the usage line: %s", (_name, args) => {
		expect(configPathFromArgs(args)).toEqual({ ok: false, reason: USAGE });
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

	test("a missing file is the shipped defaults with the note", async () => {
		const missing = inTempDir("config-missing")("does-not-exist.toml");
		const loaded = await loadStartupConfig(missing);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.note).toBe(`no config file at ${missing}, using the shipped defaults`);
		expect(loaded.config).toEqual(DEFAULT_CONFIG);
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
});

describe("the whole startup", () => {
	test("a bad argument list is the usage line and a nonzero exit", async () => {
		const result = await runStartup(["--unknown"]);
		expect(result).toEqual({ ok: false, lines: [USAGE], exitCode: 1 });
	});

	test("an invalid config stops before the state opens", async () => {
		const stateHome = inTempDir("run-config")("state-home");
		vi.stubEnv("XDG_STATE_HOME", stateHome);
		const at = inTempDir("run-config")("invalid.toml");
		writeFileSync(at, "default-agent = 42\n", "utf8");
		const result = await runStartup(["--config", at]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.exitCode).toBe(1);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toContain("default-agent");
		expect(existsSync(join(stateHome, "factory", "state.sqlite"))).toBe(false);
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
		expect(result.lines[0]).toContain(`cannot open factory state at ${blocked}`);
	});

	test("a valid config opens the state and carries the renderer inputs", async () => {
		const statePath = inTempDir("run-ready")("state.sqlite");
		const configPath = inTempDir("run-ready")("config.toml");
		writeFileSync(configPath, configBody(statePath), "utf8");
		const result = await runStartup(["--config", configPath]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.configPath).toBe(configPath);
		expect(result.statePath).toBe(statePath);
		expect(result.notes).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(typeof result.runner.run).toBe("function");
		expect(existsSync(statePath)).toBe(true);
		result.state.close();
	});

	test("a missing config starts on the shipped defaults with the note", async () => {
		const stateHome = inTempDir("run-defaults")("state-home");
		vi.stubEnv("XDG_STATE_HOME", stateHome);
		const missing = inTempDir("run-defaults")("does-not-exist.toml");
		const result = await runStartup(["--config", missing]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.notes).toEqual([`no config file at ${missing}, using the shipped defaults`]);
		expect(result.statePath).toBe(join(stateHome, "factory", "state.sqlite"));
		expect(existsSync(result.statePath)).toBe(true);
		result.state.close();
	});
});
