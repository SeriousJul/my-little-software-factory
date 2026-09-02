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
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, test } from "vitest";

import {
	ConfigError,
	configToToml,
	DEFAULT_CONFIG,
	type FactoryConfig,
	loadConfigFile,
	persistConfig,
	type TicketSourceConfig,
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
		expect(DEFAULT_CONFIG.autoHandoff).toBe(false);
		expect(DEFAULT_CONFIG.maxParallelAgents).toBe(2);
		expect(DEFAULT_CONFIG.agentPollIntervalSeconds).toBe(5);
		expect(DEFAULT_CONFIG.completionMessageLines).toBe(200);
		expect(DEFAULT_CONFIG.maxHandoffsPerTicket).toBe(10);
		expect(DEFAULT_CONFIG.scroll).toEqual({ speed: 1, acceleration: 0.8, maximumSpeed: 6 });
		expect(DEFAULT_CONFIG.workflows).toEqual([]);
		for (const task of Object.values(DEFAULT_CONFIG.taskTypes)) {
			expect(task.autoClose).toBe(false);
		}
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
	test("parses a custom host and filter and round-trips both", () => {
		const config = validateConfig({
			"state-file": "~/factory/state.sqlite",
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "{title}" } },
			sources: [
				{
					name: "ghe",
					kind: "github-pull-requests",
					"refresh-interval-seconds": 30,
					repositories: ["acme/private"],
					host: "GITHUB.ACME.COM",
					filter: "label:epic author:me",
				},
			],
		});
		expect(config.sources[0].host).toBe("github.acme.com");
		expect(config.sources[0].filter).toBe("label:epic author:me");

		// A non-default host and the filter must survive a write/read cycle.
		const roundTrip = validateConfig(parseToml(configToToml(config)));
		expect(roundTrip.sources[0].host).toBe("github.acme.com");
		expect(roundTrip.sources[0].filter).toBe("label:epic author:me");
	});

	test("rejects a non-numeric or non-positive refresh interval and an empty repository list", () => {
		const base = {
			"state-file": "~/factory/state.sqlite",
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "{title}" } },
		};
		const source = (over: Record<string, unknown>) => ({
			name: "s",
			kind: "github-issues",
			"refresh-interval-seconds": 60,
			repositories: ["acme/factory"],
			...over,
		});
		expectConfigError(
			{ ...base, sources: [source({ "refresh-interval-seconds": "60" })] },
			"must be a positive number",
		);
		expectConfigError(
			{ ...base, sources: [source({ "refresh-interval-seconds": -5 })] },
			"must be a positive number",
		);
		expectConfigError(
			{ ...base, sources: [source({ repositories: [] })] },
			"non-empty list of owner/name",
		);
	});

	test("rejects GitHub search filter syntax that GitHub fails or empties silently", () => {
		const base = {
			"state-file": "~/factory/state.sqlite",
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "{title}" } },
		};
		const source = (filter: string) => ({
			...base,
			sources: [
				{
					name: "s",
					kind: "github-issues",
					"refresh-interval-seconds": 60,
					repositories: ["acme/factory"],
					filter,
				},
			],
		});
		expectConfigError(source("label:bug OR label:crash"), "apply to search text");
		expectConfigError(source("label:bug OR regression"), "apply to search text");
		expectConfigError(source("label:bug AND label:crash"), "apply to search text");
		expectConfigError(source("(label:bug OR label:crash)"), "parentheses");
		expectConfigError(source('label:bug OR "crash'), "not closed");
		expectConfigError(source("'crash"), "not closed");

		// Pure text operators, quoted phrases, and plain qualifier lists stay valid.
		expect(validateConfig(source("regression OR crash")).sources[0].filter).toBe(
			"regression OR crash",
		);
		expect(validateConfig(source("label:bug author:me")).sources[0].filter).toBe(
			"label:bug author:me",
		);
		expect(validateConfig(source('in:title "fix OR retry"')).sources[0].filter).toBe(
			'in:title "fix OR retry"',
		);
	});

	test("task-rule label conditions must be non-empty lists of strings", () => {
		const base = {
			"state-file": "~/factory/state.sqlite",
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "{title}" } },
		};
		const rules = (when: Record<string, unknown>) => ({
			...base,
			"task-rules": [{ "task-type": "implement", when }],
		});
		expectConfigError(rules({ "labels-all": [] }), "labels-all");
		expectConfigError(rules({ "labels-any": ["ok", ""] }), "labels-any");
		expectConfigError(rules({ "labels-none": 5 }), "labels-none");
	});

	describe("secret round-trip", () => {
		const sourceWithAuth = (auth: Record<string, string>): TicketSourceConfig => ({
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
			auth,
		});

		test("a literal token persists to an owner-only file and comes back intact", async () => {
			const path = inTempDir()("secret/config.toml");
			const config = {
				...DEFAULT_CONFIG,
				sources: [sourceWithAuth({ token: "ghp_secret_token_value" })],
			};
			await persistConfig(path, config);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			const { config: loaded } = await loadConfigFile(path);
			expect(loaded.sources[0]?.auth).toEqual({ token: "ghp_secret_token_value" });
		});

		test("an environment token stays out of the written TOML", async () => {
			const path = inTempDir()("env-token/config.toml");
			const config = {
				...DEFAULT_CONFIG,
				sources: [sourceWithAuth({ tokenEnv: "FACTORY_TEST_TOKEN" })],
			};
			process.env.FACTORY_TEST_TOKEN = "ghp_must_not_be_written";
			try {
				await persistConfig(path, config);
				const written = readFileSync(path, "utf8");
				expect(written).toContain("FACTORY_TEST_TOKEN");
				expect(written).not.toContain("ghp_must_not_be_written");
				const { config: loaded } = await loadConfigFile(path);
				expect(loaded.sources[0]?.auth).toEqual({ tokenEnv: "FACTORY_TEST_TOKEN" });
			} finally {
				delete process.env.FACTORY_TEST_TOKEN;
			}
		});
	});

	describe("checked-in development config", () => {
		test("is complete and valid, and points both adapters at this repository", async () => {
			const path = fileURLToPath(new URL("../config/development.toml", import.meta.url));
			const { config, fromFile } = await loadConfigFile(path);
			expect(fromFile).toBe(true);
			expect(config.defaultAgent).toBe("pi");
			expect(config.defaultEnvironment).toBe("worktree");
			// Separate development state, resolved relative to the config file
			// and ignored by git.
			expect(config.stateFile).toBe(".factory-development.sqlite");
			expect(config.scroll).toEqual({ speed: 1, acceleration: 0.8, maximumSpeed: 6 });
			expect(config.sources).toEqual([
				{
					name: "factory-issues",
					kind: "github-issues",
					refreshIntervalSeconds: 60,
					repositories: ["SeriousJul/my-little-software-factory"],
					host: "github.com",
				},
				{
					name: "factory-pull-requests",
					kind: "github-pull-requests",
					refreshIntervalSeconds: 60,
					repositories: ["SeriousJul/my-little-software-factory"],
					host: "github.com",
				},
			]);
			// Normal gh authentication and no explicit filters: the file reads
			// neither an auth table nor a filter, so no token is committed.
			for (const source of config.sources) {
				expect(source.auth).toBeUndefined();
				expect(source.filter).toBeUndefined();
			}
			// The merge task type runs its handoffs on a low thinking level.
			expect(config.taskTypes.merge).toEqual({
				template: expect.stringContaining("Squash and merge"),
				thinking: "low",
				autoClose: false,
			});
			expect(config.taskRules).toEqual([
				{
					taskType: "rework",
					when: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
				},
				{
					taskType: "review",
					when: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
				},
				{
					taskType: "merge",
					when: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
				},
			]);
		});
	});

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

	test("a task type template only knows the prompt placeholders", () => {
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

	test("a task type carries an optional thinking level and round-trips it", () => {
		const config = validateConfig({
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "merge",
			agents: { pi: { kind: "pi" } },
			"task-types": {
				merge: { template: "Merge {title}", thinking: "low" },
			},
		});
		expect(config.taskTypes.merge).toEqual({
			template: "Merge {title}",
			thinking: "low",
			autoClose: false,
		});
		// The thinking default survives a write/read cycle.
		const roundTrip = validateConfig(parseToml(configToToml(config)));
		expect(roundTrip.taskTypes.merge).toEqual({
			template: "Merge {title}",
			thinking: "low",
			autoClose: false,
		});
	});

	test("a task type thinking level must be a non-empty string", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x", thinking: "" } },
			},
			"task-types.t.thinking: must be a non-empty string",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x", thinking: 5 } },
			},
			"task-types.t.thinking: must be a non-empty string",
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x", extra: "y" } },
			},
			'task-types.t: unknown key "extra"',
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

	test("rejects malformed source and task-rule settings", () => {
		const base = {
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "x" } },
		};
		expectConfigError(
			{
				...base,
				sources: [
					{
						name: "x",
						kind: "gitlab",
						"refresh-interval-seconds": 60,
						repositories: ["acme/factory"],
					},
				],
			},
			"unknown source kind",
		);
		expectConfigError(
			{
				...base,
				sources: [
					{
						name: "x",
						kind: "github-issues",
						"refresh-interval-seconds": 0,
						repositories: ["acme/factory"],
						extra: true,
					},
				],
			},
			"unknown key",
		);
		expectConfigError(
			{
				...base,
				sources: [
					{
						name: "x",
						kind: "github-issues",
						"refresh-interval-seconds": 60,
						repositories: ["factory"],
					},
				],
			},
			"owner/name",
		);
		expectConfigError(
			{ ...base, "task-rules": [{ "task-type": "missing", when: { unknown: "x" } }] },
			"unknown task type",
		);
		expectConfigError(
			{ ...base, "task-rules": [{ "task-type": "implement", when: { bogus: 1 } }] },
			'when: unknown key "bogus"',
		);
		expectConfigError(
			{ ...base, "task-rules": [{ "task-type": "implement", when: "labels" }] },
			"when: must be a table",
		);
		expectConfigError(
			{ ...base, "task-rules": [{ "task-type": "implement", when: {}, bogus: 1 }] },
			'task-rules[0]: unknown key "bogus"',
		);
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

describe("auto-handoff config keys", () => {
	/** The minimal config every test in this block breaks in one place. */
	const base = () => ({
		"default-agent": "pi",
		"default-environment": "live-worktree",
		"default-task-type": "implement",
		agents: { pi: { kind: "pi" } },
		"task-types": { implement: { template: "x" } },
	});

	test("absent keys take the shipped defaults", () => {
		const config = validateConfig(base());
		expect(config.autoHandoff).toBe(false);
		expect(config.maxParallelAgents).toBe(2);
		expect(config.agentPollIntervalSeconds).toBe(5);
		expect(config.completionMessageLines).toBe(200);
		expect(config.maxHandoffsPerTicket).toBe(10);
		expect(config.scroll).toEqual({ speed: 1, acceleration: 0.8, maximumSpeed: 6 });
		expect(config.workflows).toEqual([]);
		expect(config.taskTypes.implement.autoClose).toBe(false);
	});

	test("the new keys validate their types and ranges", () => {
		expectConfigError({ ...base(), "auto-handoff": "yes" }, "auto-handoff: must be a boolean");
		expectConfigError(
			{ ...base(), "max-parallel-agents": -1 },
			"max-parallel-agents: must be a whole number of 0 or more",
		);
		expectConfigError(
			{ ...base(), "max-parallel-agents": 2.5 },
			"max-parallel-agents: must be a whole number of 0 or more",
		);
		expectConfigError(
			{ ...base(), "agent-poll-interval-seconds": 0 },
			"agent-poll-interval-seconds: must be a positive number",
		);
		expectConfigError(
			{ ...base(), "completion-message-lines": 0 },
			"completion-message-lines: must be a whole number greater than 0",
		);
		expectConfigError(
			{ ...base(), "max-handoffs-per-ticket": 0 },
			"max-handoffs-per-ticket: must be a whole number greater than 0",
		);
	});

	test("a zero parallel limit means unlimited and a value parses", () => {
		const zero = validateConfig({ ...base(), "max-parallel-agents": 0 });
		expect(zero.maxParallelAgents).toBe(0);
		const three = validateConfig({ ...base(), "max-parallel-agents": 3, "auto-handoff": true });
		expect(three.maxParallelAgents).toBe(3);
		expect(three.autoHandoff).toBe(true);
	});

	test("a task type can set auto-close to a boolean only", () => {
		const config = validateConfig({
			...base(),
			"task-types": { implement: { template: "x", "auto-close": true } },
		});
		expect(config.taskTypes.implement.autoClose).toBe(true);
		expectConfigError(
			{
				...base(),
				"task-types": { implement: { template: "x", "auto-close": "yes" } },
			},
			"auto-close: must be a boolean",
		);
	});

	test("workflows route a completed task type and pin the handoff", () => {
		const config = validateConfig({
			...base(),
			"task-types": {
				implement: { template: "x" },
				review: { template: "x" },
			},
			workflows: [
				{ from: "implement", to: ["review"], agent: "pi", environment: "worktree" },
				{ from: "implement", to: ["review", "implement"] },
			],
		});
		expect(config.workflows).toEqual([
			{ from: "implement", to: ["review"], agent: "pi", environment: "worktree" },
			{ from: "implement", to: ["review", "implement"] },
		]);
	});

	test("workflow edges reject unknown or malformed parts", () => {
		const withReview = () => ({
			...base(),
			"task-types": { implement: { template: "x" }, review: { template: "x" } },
		});
		expectConfigError(
			{ ...withReview(), workflows: "no" },
			"workflows: must be a list of [[workflows]] tables",
		);
		expectConfigError(
			{ ...withReview(), workflows: [{ from: "build", to: ["review"] }] },
			'workflows[0].from: unknown task type "build"',
		);
		expectConfigError(
			{ ...withReview(), workflows: [{ from: "implement", to: ["build"] }] },
			'workflows[0].to: unknown task type "build"',
		);
		expectConfigError(
			{ ...withReview(), workflows: [{ from: "implement", to: [] }] },
			"workflows[0].to: must be a non-empty list of task types",
		);
		expectConfigError(
			{ ...withReview(), workflows: [{ from: "implement", to: ["review"], agent: "cursor" }] },
			'workflows[0].agent: unknown agent "cursor"',
		);
		expectConfigError(
			{
				...withReview(),
				workflows: [{ from: "implement", to: ["review"], environment: "container" }],
			},
			"workflows[0].environment: must be one of",
		);
		expectConfigError(
			{ ...withReview(), workflows: [{ from: "implement", to: ["review"], pin: "x" }] },
			'workflows[0]: unknown key "pin"',
		);
	});

	test("the previous-message placeholder is a known prompt placeholder", () => {
		const data = base();
		data["task-types"].implement.template = "then: {previous-message}";
		const config = validateConfig(data);
		expect(config.taskTypes.implement.template).toContain("{previous-message}");
	});
});

describe("detail scroll configuration", () => {
	const base = () => ({
		"default-agent": "pi",
		"default-environment": "live-worktree",
		"default-task-type": "implement",
		agents: { pi: { kind: "pi" } },
		"task-types": { implement: { template: "x" } },
	});

	test("uses shipped defaults for an absent or partial scroll table", () => {
		expect(validateConfig(base()).scroll).toEqual({ speed: 1, acceleration: 0.8, maximumSpeed: 6 });
		expect(validateConfig({ ...base(), scroll: { speed: 3 } }).scroll).toEqual({
			speed: 3,
			acceleration: 0.8,
			maximumSpeed: 6,
		});
	});

	test("validates strict scroll settings and keeps them through TOML", () => {
		const config = validateConfig({
			...base(),
			scroll: { speed: 2, acceleration: 1.5, "maximum-speed": 9 },
		});
		expect(config.scroll).toEqual({ speed: 2, acceleration: 1.5, maximumSpeed: 9 });
		expect(validateConfig(parseToml(configToToml(config))).scroll).toEqual(config.scroll);
		expectConfigError({ ...base(), scroll: { speed: 0 } }, "scroll.speed");
		expectConfigError({ ...base(), scroll: { speed: 1.5 } }, "scroll.speed");
		expectConfigError({ ...base(), scroll: { acceleration: -1 } }, "scroll.acceleration");
		expectConfigError(
			{ ...base(), scroll: { acceleration: Number.POSITIVE_INFINITY } },
			"scroll.acceleration",
		);
		expectConfigError({ ...base(), scroll: { speed: 4, "maximum-speed": 3 } }, "at least");
		expectConfigError({ ...base(), scroll: { typo: 1 } }, 'scroll: unknown key "typo"');
	});
});

describe("consultation configuration", () => {
	const base = () => ({
		"default-agent": "pi",
		"default-environment": "live-worktree",
		"default-task-type": "implement",
		agents: {
			pi: {
				kind: "pi",
				model: "--model {value}",
				thinking: "--thinking {value}",
				"thinking-values": ["low", "high"],
			},
		},
		"task-types": { implement: { template: "x" } },
	});

	test("the defaults are zero types, the bell on, and f12 the exit key", () => {
		const config = validateConfig(base());
		expect(config.consultationTypes).toEqual({});
		expect(config.attentionBell).toBe(true);
		expect(config.interactionExitKey).toBe("f12");
	});

	test("a type references an agent, an environment, and optional settings", () => {
		const config = validateConfig({
			...base(),
			"consultation-types": {
				"grill-with-docs": {
					agent: "pi",
					environment: "live-worktree",
					template: "/skill:grill-with-docs {input}",
					model: "--model sonnet",
					thinking: "high",
				},
			},
		});
		expect(config.consultationTypes["grill-with-docs"]).toEqual({
			agent: "pi",
			environment: "live-worktree",
			template: "/skill:grill-with-docs {input}",
			model: "--model sonnet",
			thinking: "high",
		});
	});

	test("an unknown agent reference is rejected", () => {
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "cursor",
						environment: "worktree",
						template: "{input}",
					},
				},
			},
			'consultation-types.grill-with-docs.agent: unknown agent "cursor"',
		);
	});

	test("an unknown environment reference is rejected", () => {
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "pi",
						environment: "container",
						template: "{input}",
					},
				},
			},
			"consultation-types.grill-with-docs.environment: must be one of",
		);
	});

	test("the template must hold {input} exactly once", () => {
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": { agent: "pi", environment: "worktree", template: "hello" },
				},
			},
			"consultation-types.grill-with-docs.template: template must contain the {input} placeholder exactly once",
		);
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "pi",
						environment: "worktree",
						template: "{input} again {input}",
					},
				},
			},
			"consultation-types.grill-with-docs.template: template must contain the {input} placeholder exactly once",
		);
	});

	test("an unknown placeholder and an unmatched brace are rejected", () => {
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "pi",
						environment: "worktree",
						template: "{input} and {title}",
					},
				},
			},
			"consultation-types.grill-with-docs.template: unknown placeholder {title}",
		);
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "pi",
						environment: "worktree",
						template: "{input} left open {",
					},
				},
			},
			"consultation-types.grill-with-docs.template: contains an unmatched brace",
		);
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					"grill-with-docs": {
						agent: "pi",
						environment: "worktree",
						template: "{input} and a stray }",
					},
				},
			},
			"consultation-types.grill-with-docs.template: contains an unmatched brace",
		);
	});

	test("the exit key accepts function keys and ctrl plus one letter", () => {
		for (const raw of ["f12", "F12", "f24", "ctrl-q", "Ctrl-Q"]) {
			const config = validateConfig({ ...base(), "interaction-exit-key": raw });
			expect(config.interactionExitKey).toBe(raw.toLowerCase().replace(/^ctrl-/, "ctrl+"));
		}
	});

	test("the exit key refuses Ctrl+C, which the emergency exit owns", () => {
		for (const raw of ["ctrl+c", "CTRL+C", "ctrl-c", " ctrl+c "]) {
			expectConfigError(
				{ ...base(), "interaction-exit-key": raw },
				"interaction-exit-key cannot be ctrl+c",
			);
		}
	});

	test("the exit key rejects plain letters, punctuation, and out-of-range keys", () => {
		for (const raw of ["q", "ctrl+.", "f0", "f25", "ctrl-x-y", "shift-f12"]) {
			expectConfigError(
				{ ...base(), "interaction-exit-key": raw },
				"interaction-exit-key must be a function key",
			);
		}
	});

	test("attention-bell defaults on and keeps an explicit false", () => {
		expect(validateConfig({ ...base(), "attention-bell": false }).attentionBell).toBe(false);
		expect(validateConfig(base()).attentionBell).toBe(true);
		expectConfigError({ ...base(), "attention-bell": "yes" }, "attention-bell: must be a boolean");
	});

	test("a Consultation config survives a TOML round-trip", () => {
		const config = validateConfig({
			...base(),
			"consultation-types": {
				"grill-with-docs": {
					agent: "pi",
					environment: "worktree",
					template: "/skill:grill-with-docs {input}",
					model: "--model sonnet",
					thinking: "high",
				},
				grill: { agent: "pi", environment: "live-worktree", template: "{input}" },
			},
			"attention-bell": false,
			"interaction-exit-key": "ctrl-q",
		});
		const roundTripped = validateConfig(parseToml(configToToml(config)));
		expect(roundTripped.consultationTypes).toEqual(config.consultationTypes);
		expect(roundTripped.attentionBell).toBe(false);
		expect(roundTripped.interactionExitKey).toBe("ctrl+q");
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
