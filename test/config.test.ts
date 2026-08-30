/**
 * The config tests: the shipped defaults, a valid file, and every way a
 * file can be wrong.
 *
 * The validation rules: a missing file is the shipped defaults; a file must
 * carry every key the control plane reads, reject every key it does not
 * read, and check the cross references (default agent, default task type,
 * default environment). The error is always one readable line an operator
 * can act on.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";

import {
	ConfigError,
	configToToml,
	DEFAULT_CONFIG,
	type FactoryConfig,
	loadConfigFile,
	persistConfig,
	validateConfig,
} from "../src/config.ts";

function inTempDir(): (path: string) => string {
	const dir = mkdtempSync(join(tmpdir(), "factory-config-"));
	return (name: string) => join(dir, name);
}

/** A minimal valid config file body, for the negative tests to break. */
const validBody = `
default-agent = "pi"
default-environment = "live-worktree"
default-task-type = "implement"

[agents.pi]
kind = "pi"
model = "--model {value}"
thinking = "--thinking {value}"
thinking-values = ["low", "high"]

[agents.codex]
kind = "codex"

[task-types.implement]
template = "Implement it: {repository} {title} {description}"
`;

function expectConfigError(data: unknown, fragment: string): void {
	let message = "";
	try {
		validateConfig(data);
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		message = String(error);
	}
	expect(message).toContain(fragment);
}

describe("loadConfigFile", () => {
	test("a missing file yields the shipped defaults", () => {
		const path = inTempDir()("config.toml");
		const { config, fromFile } = loadConfigFile(path);
		expect(fromFile).toBe(false);
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("the shipped defaults are a valid config", () => {
		expect(() => validateConfig(parseToml(configToToml(DEFAULT_CONFIG)))).not.toThrow();
		expect(DEFAULT_CONFIG.agents).toHaveProperty("pi");
		expect(DEFAULT_CONFIG.agents).toHaveProperty("codex");
		expect(DEFAULT_CONFIG.agents).toHaveProperty("claude");
		expect(DEFAULT_CONFIG.taskTypes).toHaveProperty("implement");
		expect(DEFAULT_CONFIG.defaultEnvironment).toBe("live-worktree");
	});

	test("a valid file loads", () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, validBody);
		const { config, fromFile } = loadConfigFile(path);
		expect(fromFile).toBe(true);
		expect(config.defaultAgent).toBe("pi");
		expect(config.defaultEnvironment).toBe("live-worktree");
		expect(config.defaultTaskType).toBe("implement");
		expect(config.agents.pi.kind).toBe("pi");
		expect(config.agents.pi.thinkingValues).toEqual(["low", "high"]);
		expect(config.agents.codex.kind).toBe("codex");
		expect(config.agents.codex.model).toBeUndefined();
		expect(config.taskTypes.implement.template).toContain("{description}");
		expect(config.repos).toEqual({});
	});

	test("an explicit repository mapping loads", () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, `${validBody}\n[repos]\n"acme/billing" = "~/src/billing"\n`);
		const { config } = loadConfigFile(path);
		expect(config.repos).toEqual({ "acme/billing": "~/src/billing" });
	});

	test("unreadable TOML is a readable error", () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, "default-agent = ");
		let message = "";
		try {
			loadConfigFile(path);
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			message = String(error);
		}
		expect(message).toContain("invalid TOML");
		expect(message).toContain(path);
	});
});

describe("validateConfig", () => {
	test("every required top-level key is read", () => {
		expectConfigError(
			{ defaultAgent: "pi", agents: {}, "task-types": {} },
			'unknown top-level key "defaultAgent"',
		);
		expectConfigError(
			{ "default-environment": "x", "default-task-type": "y", agents: {}, "task-types": {} },
			"config: default-agent",
		);
		expectConfigError(
			{ "default-agent": "x", "default-task-type": "y", agents: {}, "task-types": {} },
			"config: default-environment",
		);
		expectConfigError(
			{ "default-agent": "x", "default-environment": "worktree", agents: {}, "task-types": {} },
			"config: default-task-type",
		);
	});

	test("the default environment must be a handoff kind", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "container",
				"default-task-type": "implement",
				agents: { pi: { kind: "pi" } },
				"task-types": { implement: { template: "{title}" } },
			},
			"default-environment must be one of",
		);
	});

	test("at least one agent and one task type are required", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: {},
				"task-types": { t: { template: "x" } },
			},
			"at least one agent",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": {},
			},
			"at least one task type",
		);
	});

	test("an agent block requires its kind", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: {} },
				"task-types": { t: { template: "x" } },
			},
			"agents.pi.kind",
		);
	});

	test("a setting template must carry the value placeholder and nothing else", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", model: "--model" } },
				"task-types": { t: { template: "x" } },
			},
			"agents.pi.model: template must contain the {value} placeholder",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", thinking: "-c effort={value} and {title}" } },
				"task-types": { t: { template: "x" } },
			},
			"unknown placeholder {title}",
		);
	});

	test("an agent block rejects keys the control plane does not read", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", model: "--model {value}", extra: "x" } },
				"task-types": { t: { template: "x" } },
			},
			'agents.pi: unknown key "extra"',
		);
	});

	test("a task type template only knows the three placeholders", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "hello {body}" } },
			},
			"unknown placeholder {body}",
		);
	});

	test("the default agent must match an agent", () => {
		expectConfigError(
			{
				"default-agent": "cursor",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x" } },
			},
			'default-agent "cursor" does not match any agent',
		);
	});

	test("the default task type must match a task type", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "refactor",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x" } },
			},
			'default-task-type "refactor" does not match any task type',
		);
	});

	test("a repository mapping must be a non-empty path", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x" } },
				repos: { "acme/billing": "" },
			},
			'repos["acme/billing"]: must be a non-empty path',
		);
	});
});

describe("configToToml and persistConfig", () => {
	test("the shipped defaults round-trip through TOML", () => {
		const config = validateConfig(parseToml(configToToml(DEFAULT_CONFIG)));
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("persistConfig writes a file the loader reads back", () => {
		const temp = inTempDir();
		const path = temp("factory/config.toml");
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			repos: { "acme/billing": "~/src/billing_1" },
		};
		persistConfig(path, config);
		const { config: loaded, fromFile } = loadConfigFile(path);
		expect(fromFile).toBe(true);
		expect(loaded).toEqual(config);
		expect(readFileSync(path, "utf8")).toContain('"acme/billing"');
	});
});
