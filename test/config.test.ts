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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, test } from "vitest";

import {
	ConfigError,
	configToToml,
	DEFAULT_CONFIG,
	type FactoryConfig,
	loadConfigFile,
	persistConfig,
	validateConfig,
} from "../src/config.ts";

const tempDirs: string[] = [];

function inTempDir(): (path: string) => string {
	const dir = mkdtempSync(join(tmpdir(), "factory-config-"));
	tempDirs.push(dir);
	return (name: string) => join(dir, name);
}

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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
	test("a missing file yields the shipped defaults", async () => {
		const path = inTempDir()("config.toml");
		const { config, fromFile } = await loadConfigFile(path);
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

	test("a valid file loads", async () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, validBody);
		const { config, fromFile } = await loadConfigFile(path);
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

	test("an explicit repository mapping loads", async () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, `${validBody}\n[repos]\n"acme/billing" = "~/src/billing"\n`);
		const { config } = await loadConfigFile(path);
		expect(config.repos).toEqual({ "acme/billing": "~/src/billing" });
	});

	test("unreadable TOML is a readable error", async () => {
		const path = inTempDir()("config.toml");
		writeFileSync(path, "default-agent = ");
		let message = "";
		try {
			await loadConfigFile(path);
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

	test("any brace pair is a placeholder, not only letters", () => {
		// A {ticket-id} or a {value2} would stay literal in the prompt the
		// agent receives, so it is an error, not an unknown-letter miss.
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "hello {ticket-id}" } },
			},
			"unknown placeholder {ticket-id}",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", model: "--model {value2}" } },
				"task-types": { t: { template: "x" } },
			},
			"template must contain the {value} placeholder",
		);
	});

	test("an empty brace pair is a placeholder too", () => {
		// A {} is still a brace pair: it would stay literal in the prompt
		// the agent receives, so it is a startup error, not a silent miss.
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "hello {}" } },
			},
			"unknown placeholder {}",
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

	test("a task type name must be one word", () => {
		// A two-word name would show on the ticket detail line and in the
		// override panel, and the config write-back would quote it.
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "implement two",
				agents: { pi: { kind: "pi" } },
				"task-types": { "implement two": { template: "x" } },
			},
			"config: task-types.implement two: must be a one-word name",
		);
	});
});

describe("ticket source configuration", () => {
	test("validates sources, authentication, task rules, and a relative state file", () => {
		const config = validateConfig({
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			"state-file": "state.sqlite",
			agents: { pi: { kind: "pi" } },
			"task-types": {
				implement: { template: "{source-kind} {external-key} {source-url} {labels}" },
			},
			sources: [
				{
					name: "issues",
					kind: "github-issues",
					"refresh-interval-seconds": 60,
					repositories: ["acme/factory"],
					auth: { "token-env": "FACTORY_TOKEN" },
				},
			],
			"task-rules": [
				{
					"task-type": "implement",
					when: { "source-kind": "github-issue", "labels-all": ["ready-for-agent"] },
				},
			],
		});
		expect(config.stateFile).toBe("state.sqlite");
		expect(config.sources[0].auth).toEqual({ tokenEnv: "FACTORY_TOKEN" });
		expect(config.taskRules).toEqual([
			{
				taskType: "implement",
				when: { sourceKind: "github-issue", labelsAll: ["ready-for-agent"] },
			},
		]);
	});

	test("rejects duplicate source names and ambiguous authentication", () => {
		const source = {
			name: "issues",
			kind: "github-issues",
			"refresh-interval-seconds": 60,
			repositories: ["acme/factory"],
		};
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "implement",
				agents: { pi: { kind: "pi" } },
				"task-types": { implement: { template: "x" } },
				sources: [source, source],
			},
			"duplicate source name",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "implement",
				agents: { pi: { kind: "pi" } },
				"task-types": { implement: { template: "x" } },
				sources: [{ ...source, auth: { token: "a", account: "me" } }],
			},
			"specify exactly one",
		);
	});
});

describe("configToToml and persistConfig", () => {
	test("the shipped defaults round-trip through TOML", () => {
		const config = validateConfig(parseToml(configToToml(DEFAULT_CONFIG)));
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("persistConfig writes a file the loader reads back", async () => {
		const temp = inTempDir();
		const path = temp("factory/config.toml");
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			repos: { "acme/billing": "~/src/billing_1" },
		};
		await persistConfig(path, config);
		const { config: loaded, fromFile } = await loadConfigFile(path);
		expect(fromFile).toBe(true);
		expect(loaded).toEqual(config);
		expect(readFileSync(path, "utf8")).toContain('"acme/billing"');
	});

	test("a failed persistConfig write leaves no temp file behind", async () => {
		const temp = inTempDir();
		const dir = temp("factory");
		const path = join(dir, "config.toml");
		// A directory where the file should be: the rename must fail.
		mkdirSync(path, { recursive: true });
		await expect(persistConfig(path, DEFAULT_CONFIG)).rejects.toThrow();
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
	});
});
