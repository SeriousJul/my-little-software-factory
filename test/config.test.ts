/**
 * The config tests: the shipped Default configuration, the seed of a
 * missing file, the standard paths, a valid file, and every way a file can
 * be wrong.
 *
 * The validation rules: a missing file is seeded from the Default
 * configuration the package ships, then loaded; a file must carry every key
 * the control plane reads, reject every key it does not read, and check the
 * cross references (default agent, default task type, default environment).
 * The error is always one readable line an operator can act on.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import {
	ConfigError,
	configToToml,
	defaultConfigPath,
	defaultStatePath,
	type FactoryConfig,
	loadConfigFile,
	logPathFor,
	persistConfig,
	type TicketSourceConfig,
	validateConfig,
} from "../src/config.ts";
import { THINKING_LEVELS } from "../src/domain/agent.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { stubEnv, unstubAllEnvs } from "./env-stub.ts";

/** The checked-in Default configuration the package ships. */
const SHIPPED_DEFAULT_CONFIG = fileURLToPath(new URL("../config/default.toml", import.meta.url));

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

describe("the Default configuration", () => {
	test("a missing file is seeded from it, at the path, and loaded", async () => {
		const path = inTempDir()("config.toml");
		const { config, fromFile, seeded } = await loadConfigFile(path);
		expect(fromFile).toBe(true);
		expect(seeded).toBe(true);
		// The seed is a verbatim copy: the operator's file carries the
		// template's comments, so the seeded file says what it means.
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"));
		expect(config).toEqual(validateConfig(parseToml(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"))));
		// A present file is not seeded again, whatever it holds.
		writeFileSync(path, "# kept as is\n", "utf8");
		await expect(loadConfigFile(path)).rejects.toThrow(ConfigError);
	});

	test("it validates through the seam and carries the workflow template", async () => {
		const { config, fromFile, seeded } = await loadConfigFile(SHIPPED_DEFAULT_CONFIG);
		expect(fromFile).toBe(true);
		expect(seeded).toBeUndefined();
		// The four workflow task types, the three security task types, and
		// the states of the label workflow machine (ADR 0027).
		expect(Object.keys(config.taskTypes).sort()).toEqual([
			"implement",
			"merge",
			"resolve-dependabot-alert",
			"resolve-secret-scanning-alert",
			"resolve-security-advisory",
			"review",
			"rework",
		]);
		// The security task types run on a high thinking level: one kind of
		// finding per template.
		for (const name of [
			"resolve-security-advisory",
			"resolve-dependabot-alert",
			"resolve-secret-scanning-alert",
		]) {
			expect(config.taskTypes[name].thinking).toBe("high");
		}
		expect(config.workflowStates).toEqual([
			{
				name: "ready-for-agent",
				taskType: "implement",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
			},
			{
				name: "needs-work",
				taskType: "rework",
				match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
			{
				name: "ready-to-ship",
				taskType: "merge",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
			},
			{
				name: "security-advisory",
				taskType: "resolve-security-advisory",
				match: { sourceKind: "github-security-advisory" },
			},
			{
				name: "security-dependabot-alert",
				taskType: "resolve-dependabot-alert",
				match: { sourceKind: "github-dependabot-alert" },
			},
			{
				name: "security-secret-alert",
				taskType: "resolve-secret-scanning-alert",
				match: { sourceKind: "github-secret-scanning-alert" },
			},
			{
				name: "pull-request-unlabeled",
				match: {
					sourceKind: "github-pull-request",
					labelsNone: ["needs-work", "ready-for-review", "ready-to-ship"],
				},
			},
		]);
		// Every task type carries its transition: the plane fires it on a
		// completed turn and writes the label facts the machine reads.
		expect(config.taskTypes.implement.transition).toEqual({
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
		});
		expect(config.taskTypes.rework.transition).toEqual({
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
		});
		expect(config.taskTypes.review.transition).toEqual({
			ticketFacts: [],
			pullRequestFacts: [],
			scoreThreshold: 90,
			branches: [
				{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] },
				{ when: "score-below-threshold", pullRequestFacts: ["needs-work"] },
			],
		});
		expect(config.taskTypes.merge.transition).toEqual({
			ticketFacts: [],
			pullRequestFacts: [],
			branches: [
				{ when: "pull-request-open", pullRequestFacts: ["needs-work"] },
				{ pullRequestFacts: [] },
			],
		});
		// The security transitions write ready-for-review on the opened pull
		// request and auto-advance into its review position.
		for (const name of [
			"resolve-security-advisory",
			"resolve-dependabot-alert",
			"resolve-secret-scanning-alert",
		]) {
			expect(config.taskTypes[name].transition).toEqual({
				ticketFacts: [],
				pullRequestFacts: ["ready-for-review"],
				autoAdvance: true,
			});
		}
		// One neutral Consultation type that passes the operator's input
		// straight through, and the pair programming type on the high
		// thinking level.
		expect(config.consultationTypes).toEqual({
			consult: { agent: "pi", environment: "worktree", template: "{input}" },
			pair: {
				agent: "pi",
				environment: "worktree",
				thinking: "xhigh",
				template: expect.stringContaining("pair programming session"),
			},
		});
		// No ticket sources, no repository mappings, and no state file entry:
		// the file works on any machine.
		expect(config.sources).toEqual([]);
		expect(config.repos).toEqual({});
		expect(config.stateFile).toBeUndefined();
		// The agent types and the existing default limits.
		expect(Object.keys(config.agents).sort()).toEqual(["claude", "codex", "pi"]);
		expect(config.defaultAgent).toBe("pi");
		expect(config.defaultTaskType).toBe("implement");
		expect(config.maxParallelAgents).toBe(2);
		expect(config.agentPollIntervalSeconds).toBe(5);
		expect(config.completionMessageLines).toBe(200);
		expect(config.maxHandoffsPerTicket).toBe(20);
	});

	test("it marks the workflow machine as extensible and holds a source example", () => {
		const text = readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8");
		expect(text).toContain("The workflow machine");
		expect(text).toContain("meant to be extended");
		// The commented-out source block the operator uncomments and edits.
		expect(text).toContain("# [[sources]]");
	});
});

describe("the standard paths", () => {
	test("the default Config file lives under the project name", () => {
		expect(defaultConfigPath()).toBe(
			join(homedir(), ".config", "my-little-software-factory", "config.toml"),
		);
	});

	test("the default state file lives under the project name in the XDG state home", () => {
		expect(defaultStatePath("/home/op", "/custom/state")).toBe(
			join("/custom/state", "my-little-software-factory", "state.sqlite"),
		);
		// With the state home unset, the file lives under the home.
		stubEnv("XDG_STATE_HOME", "");
		expect(defaultStatePath("/home/op")).toBe(
			join("/home/op", ".local", "state", "my-little-software-factory", "state.sqlite"),
		);
	});
});

afterEach(() => {
	unstubAllEnvs();
});

describe("loadConfigFile", () => {
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

	test("state match label conditions must be non-empty lists of strings", () => {
		const base = {
			"state-file": "~/factory/state.sqlite",
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "{title}" } },
		};
		const states = (match: Record<string, unknown>) => ({
			...base,
			states: [{ name: "x", "task-type": "implement", match }],
		});
		expectConfigError(states({ "labels-all": [] }), "labels-all");
		expectConfigError(states({ "labels-any": ["ok", ""] }), "labels-any");
		expectConfigError(states({ "labels-none": 5 }), "labels-none");
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
				...BASE_CONFIG,
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
				...BASE_CONFIG,
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
			// The dev feed: both adapters and the three security feeds, all
			// tracking this repository. A local development setup may add more
			// repositories to the same sources, so track membership rather than
			// the exact list.
			expect(config.sources.map(({ name, kind }) => ({ name, kind }))).toEqual([
				{ name: "factory-issues", kind: "github-issues" },
				{ name: "factory-pull-requests", kind: "github-pull-requests" },
				{ name: "my-security-advisories", kind: "github-security-advisories" },
				{ name: "my-dependabot-alerts", kind: "github-dependabot-alerts" },
				{ name: "my-secret-alerts", kind: "github-secret-scanning-alerts" },
			]);
			for (const source of config.sources) {
				expect(source.refreshIntervalSeconds, `${source.name} keeps its refresh interval`).toBe(
					source.kind === "github-issues" || source.kind === "github-pull-requests" ? 60 : 300,
				);
				expect(source.host).toBe("github.com");
				expect(source.repositories).toContain("SeriousJul/my-little-software-factory");
			}
			// The dev path records its run in a log the git tree ignores.
			expect(config.logging).toMatchObject({
				level: "debug",
				file: ".factory-development.log",
				maxSizeMib: 10,
				keep: 5,
			});
			// Normal gh authentication and no explicit filters: the file reads
			// neither an auth table nor a filter, so no token is committed.
			for (const source of config.sources) {
				expect(source.auth).toBeUndefined();
				expect(source.filter).toBeUndefined();
			}
			// The merge task type runs its handoffs on a low thinking level,
			// and its transition returns a pull request that did not merge to
			// the needs-work state.
			expect(config.taskTypes.merge).toEqual({
				template: expect.stringContaining("Squash and merge"),
				thinking: "low",
				transition: {
					ticketFacts: [],
					pullRequestFacts: [],
					branches: [
						{ when: "pull-request-open", pullRequestFacts: ["needs-work"] },
						{ pullRequestFacts: [] },
					],
				},
			});
			// The review task type carries a template only: the live development
			// path pins no Task profile settings in the file. The profile
			// feature itself is covered by the inline config tests in this file,
			// which name the agent, model, thinking level, and context window
			// they set.
			expect(config.taskTypes.review).toEqual({
				template: expect.stringContaining("Review pull request"),
				transition: expect.objectContaining({ scoreThreshold: 90 }),
			});
			expect(config.taskTypes.review.agent).toBeUndefined();
			expect(config.taskTypes.review.model).toBeUndefined();
			expect(config.taskTypes.review.contextWindow).toBeUndefined();
			// Every agent that can take a context window names its own spelling
			// of the count, so one profile value reaches each of them.
			expect(config.agents.codex?.contextWindow).toBe("-c model_context_window={value}");
			expect(config.agents.claude?.contextWindow).toBe("--autocompact {value}");
			// pi takes no per-run context-window argument, so it maps none, and no
			// profile may set one for it.
			expect(config.agents.pi?.contextWindow).toBeUndefined();
			expect(config.workflowStates).toEqual([
				{
					name: "ready-for-agent",
					taskType: "implement",
					match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
				},
				{
					name: "needs-work",
					taskType: "rework",
					match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
				},
				{
					name: "ready-for-review",
					taskType: "review",
					match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
				},
				{
					name: "ready-to-ship",
					taskType: "merge",
					match: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
				},
				{
					// The park: an open pull request the plane has not labeled
					// yet, which the implement transition still reaches through
					// its Issue reference (ADR 0027).
					name: "pull-request-unlabeled",
					match: {
						sourceKind: "github-pull-request",
						labelsNone: ["needs-work", "ready-for-review", "ready-to-ship"],
					},
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
			agents: {
				pi: {
					kind: "pi",
					thinking: "--thinking {value}",
					"thinking-values": ["low", "high"],
				},
			},
			"task-types": {
				merge: { template: "Merge {title}", thinking: "low" },
			},
		});
		expect(config.taskTypes.merge).toEqual({
			template: "Merge {title}",
			thinking: "low",
		});
		// The thinking default survives a write/read cycle.
		const roundTrip = validateConfig(parseToml(configToToml(config)));
		expect(roundTrip.taskTypes.merge).toEqual({
			template: "Merge {title}",
			thinking: "low",
		});
	});

	test("a Task profile names its agent, its model, and its level", () => {
		const config = validateConfig({
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "merge",
			agents: {
				pi: {
					kind: "pi",
					model: "--model {value}",
					thinking: "--thinking {value}",
					"thinking-values": ["low", "high"],
				},
				slow: {
					kind: "codex",
					model: "--model {value}",
					thinking: "-c model_reasoning_effort={value}",
					"thinking-values": ["high", "low"],
				},
			},
			"task-types": {
				merge: {
					template: "Merge {title}",
					agent: "slow",
					model: "openai/gpt-5.1",
					thinking: "high",
				},
			},
		});
		expect(config.taskTypes.merge).toEqual({
			template: "Merge {title}",
			agent: "slow",
			model: "openai/gpt-5.1",
			thinking: "high",
		});
		// The profile keys survive a write/read cycle.
		const roundTrip = validateConfig(parseToml(configToToml(config)));
		expect(roundTrip.taskTypes.merge).toEqual(config.taskTypes.merge);
	});

	test("a task type names an agent the config defines", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x", agent: "cursor" } },
			},
			'task-types.t.agent: unknown agent "cursor"',
		);
	});

	test("a task type names a model for an agent that maps one", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x", model: "gpt-4o" } },
			},
			'task-types.t.model: agent type "pi" defines no model setting, so model "gpt-4o" cannot reach it',
		);
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", model: "--model {value}" } },
				"task-types": { t: { template: "x", model: 7 } },
			},
			"task-types.t.model: must be a non-empty string",
		);
	});

	test("a task type level must be one the profile's agent declares", () => {
		const base = {
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "t",
			agents: {
				pi: {
					kind: "pi",
					thinking: "--thinking {value}",
					"thinking-values": ["low", "high"],
				},
				cx: {
					kind: "codex",
					thinking: "-c model_reasoning_effort={value}",
					"thinking-values": ["minimal", "low"],
				},
			},
		};
		// The default agent's own set admits the level.
		expect(() =>
			validateConfig({ ...base, "task-types": { t: { template: "x", thinking: "low" } } }),
		).not.toThrow();
		expectConfigError(
			{ ...base, "task-types": { t: { template: "x", thinking: "xhigh" } } },
			'agent type "pi" offers no thinking level "xhigh"',
		);
		// The profile's agent owns the set once the profile names one: the
		// level that pi supports is unfit for cx.
		expectConfigError(
			{
				...base,
				"task-types": { t: { template: "x", agent: "cx", thinking: "high" } },
			},
			'agent type "cx" offers no thinking level "high"',
		);
	});

	test("the top-level default model is a non-empty string and round-trips", () => {
		const config = validateConfig({
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "t",
			"default-model": "anthropic/claude-sonnet-4-5",
			agents: { pi: { kind: "pi", model: "--model {value}" } },
			"task-types": { t: { template: "x" } },
		});
		expect(config.defaultModel).toBe("anthropic/claude-sonnet-4-5");
		expect(validateConfig(parseToml(configToToml(config))).defaultModel).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		// Omitted: the key is absent, not an empty string.
		expect(BASE_CONFIG.defaultModel).toBeUndefined();
		expect(configToToml(BASE_CONFIG)).not.toContain("default-model");
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				"default-model": "",
				agents: { pi: { kind: "pi" } },
				"task-types": { t: { template: "x" } },
			},
			"default-model: must be a non-empty string",
		);
	});

	test("an agent that maps thinking must declare its levels", () => {
		expectConfigError(
			{
				"default-agent": "pi",
				"default-environment": "worktree",
				"default-task-type": "t",
				agents: { pi: { kind: "pi", thinking: "--thinking {value}" } },
				"task-types": { t: { template: "x" } },
			},
			"agents.pi.thinking-values: an agent that maps thinking must declare the levels",
		);
	});

	test("declared levels are a non-empty subset of the standard set, without repeats", () => {
		const base = {
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "t",
			"task-types": { t: { template: "x" } },
		};
		const withValues = (values: unknown) => ({
			...base,
			agents: { pi: { kind: "pi", thinking: "--thinking {value}", "thinking-values": values } },
		});
		// The order the operator declares is the order the row offers.
		expect(validateConfig(withValues(["max", "off"])).agents.pi.thinkingValues).toEqual([
			"max",
			"off",
		]);
		expectConfigError(withValues([]), "agents.pi.thinking-values: must declare at least one");
		expectConfigError(
			withValues(["ultra"]),
			'agents.pi.thinking-values: "ultra" is not a standard thinking level',
		);
		expectConfigError(
			withValues(["low", "low"]),
			'agents.pi.thinking-values: "low" is declared twice',
		);
		expectConfigError(withValues("low"), "must be a list of level strings");
		// An agent that maps no thinking has no levels to declare.
		expectConfigError(
			{
				...base,
				agents: { pi: { kind: "pi", "thinking-values": ["low"] } },
			},
			"agents.pi.thinking-values: the agent maps no thinking setting",
		);
	});

	test("every shipped agent declares the levels its runtime supports", () => {
		// The Default configuration's agents are the shipped set: each subset
		// holds standard levels in the runtime's own order, and every one of
		// them fits inside the standard set.
		const agents = validateConfig(parseToml(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8"))).agents;
		expect(agents.pi.thinkingValues).toEqual([...THINKING_LEVELS]);
		expect(agents.codex.thinkingValues).toEqual(["minimal", "low", "medium", "high"]);
		expect(agents.claude.thinkingValues).toEqual(["low", "medium", "high", "xhigh", "max"]);
		for (const agent of Object.values(agents)) {
			for (const level of agent.thinkingValues ?? []) {
				expect(THINKING_LEVELS).toContain(level);
			}
		}
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
	test("validates sources, authentication, states, and a relative state file", () => {
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
			states: [
				{
					name: "ready-for-agent",
					"task-type": "implement",
					match: { "source-kind": "github-issue", "labels-all": ["ready-for-agent"] },
				},
			],
		});
		expect(config.stateFile).toBe("state.sqlite");
		expect(config.sources[0].auth).toEqual({ tokenEnv: "FACTORY_TOKEN" });
		expect(config.workflowStates).toEqual([
			{
				name: "ready-for-agent",
				taskType: "implement",
				match: { sourceKind: "github-issue", labelsAll: ["ready-for-agent"] },
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
			{ ...base, states: [{ name: "x", "task-type": "missing", match: {} }] },
			"unknown task type",
		);
		expectConfigError(
			{ ...base, states: [{ name: "x", "task-type": "implement", match: { bogus: 1 } }] },
			'match: unknown key "bogus"',
		);
		expectConfigError(
			{ ...base, states: [{ name: "x", "task-type": "implement", match: "labels" }] },
			"match: must be a [states.match] table",
		);
		expectConfigError(
			{ ...base, states: [{ name: "x", match: {}, bogus: 1 }] },
			'states[0]: unknown key "bogus"',
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

	describe("the security feed source kinds (issue #73)", () => {
		const base = {
			"default-agent": "pi",
			"default-environment": "worktree",
			"default-task-type": "implement",
			agents: { pi: { kind: "pi" } },
			"task-types": { implement: { template: "x" } },
		};

		test("each kind validates and reuses the shared source shape", () => {
			for (const kind of [
				"github-security-advisories",
				"github-dependabot-alerts",
				"github-secret-scanning-alerts",
			] as const) {
				const config = validateConfig({
					...base,
					sources: [
						{
							name: kind,
							kind,
							"refresh-interval-seconds": 300,
							repositories: ["acme/factory", "acme/portal"],
							auth: { account: "me" },
						},
					],
				});
				expect(config.sources).toEqual([
					{
						name: kind,
						kind,
						refreshIntervalSeconds: 300,
						repositories: ["acme/factory", "acme/portal"],
						host: "github.com",
						auth: { account: "me" },
					},
				]);
			}
		});

		test("a filter on a security feed is a startup error, not a silent no-op", () => {
			for (const kind of [
				"github-security-advisories",
				"github-dependabot-alerts",
				"github-secret-scanning-alerts",
			]) {
				expectConfigError(
					{
						...base,
						sources: [
							{
								name: kind,
								kind,
								"refresh-interval-seconds": 300,
								repositories: ["acme/factory"],
								filter: "severity:critical",
							},
						],
					},
					`takes no filter; a filter would be silently ignored`,
				);
			}
		});
	});
});

describe("limits config keys", () => {
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
		expect(config.maxParallelAgents).toBe(2);
		expect(config.agentPollIntervalSeconds).toBe(5);
		expect(config.completionMessageLines).toBe(200);
		expect(config.maxHandoffsPerTicket).toBe(10);
		expect(config.scroll).toEqual({ speed: 1, acceleration: 0.8, maximumSpeed: 6 });
		expect(config.workflowStates).toEqual([]);
		expect(config.taskTypes.implement.transition).toBeUndefined();
	});

	test("a config that still carries the removed auto-handoff key fails startup", () => {
		expectConfigError({ ...base(), "auto-handoff": false }, 'unknown top-level key "auto-handoff"');
	});

	test("the new keys validate their types and ranges", () => {
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
		const three = validateConfig({ ...base(), "max-parallel-agents": 3 });
		expect(three.maxParallelAgents).toBe(3);
	});

	test("a task type's transition sets the facts, threshold, and branches it writes", () => {
		const config = validateConfig({
			...base(),
			"task-types": {
				implement: {
					template: "x",
					transition: {
						"pull-request-facts": ["ready-for-review"],
						"score-threshold": 90,
						"auto-advance": true,
						agent: "pi",
						branches: [
							{
								when: "score-above-threshold",
								"pull-request-facts": ["ready-to-ship"],
							},
						],
					},
				},
			},
		});
		expect(config.taskTypes.implement.transition).toEqual({
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
			scoreThreshold: 90,
			autoAdvance: true,
			agent: "pi",
			branches: [{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] }],
		});
		// A branch without a judgment is the fallback: it fires when no
		// judgment branch does.
		const fallback = validateConfig({
			...base(),
			"task-types": {
				implement: {
					template: "x",
					transition: {
						"pull-request-facts": ["a"],
						branches: [
							{ when: "pull-request-open", "pull-request-facts": ["b"] },
							{ "pull-request-facts": ["c"] },
						],
					},
				},
			},
		});
		expect(fallback.taskTypes.implement.transition?.branches).toEqual([
			{ when: "pull-request-open", pullRequestFacts: ["b"] },
			{ pullRequestFacts: ["c"] },
		]);
	});

	test("a score judgment is legal only with a score threshold", () => {
		expectConfigError(
			{
				...base(),
				"task-types": {
					implement: {
						template: "x",
						transition: { branches: [{ when: "score-above-threshold" }] },
					},
				},
			},
			"a score judgment needs score-threshold",
		);
	});

	test("transitions reject unknown or malformed parts", () => {
		const withTransition = () => ({
			...base(),
			"task-types": { implement: { template: "x", transition: {} } },
		});
		expectConfigError(
			{ ...withTransition(), "task-types": { implement: { template: "x", transition: "no" } } },
			"transition: must be a table",
		);
		expectConfigError(
			{
				...withTransition(),
				"task-types": { implement: { template: "x", transition: { "ticket-facts": 3 } } },
			},
			"ticket-facts: must be a list of label names",
		);
		expectConfigError(
			{
				...withTransition(),
				"task-types": { implement: { template: "x", transition: { "score-threshold": 150 } } },
			},
			"score-threshold: must be a number between 0 and 100",
		);
		expectConfigError(
			{
				...base(),
				"task-types": {
					implement: { template: "x", transition: { "auto-advance": "yes" } },
				},
			},
			"auto-advance: must be a boolean",
		);
		expectConfigError(
			{
				...withTransition(),
				"task-types": { implement: { template: "x", transition: { agent: "cursor" } } },
			},
			'unknown agent "cursor"',
		);
		expectConfigError(
			{
				...withTransition(),
				"task-types": { implement: { template: "x", transition: { environment: "container" } } },
			},
			"environment: must be one of",
		);
		expectConfigError(
			{
				...base(),
				"task-types": {
					implement: { template: "x", transition: { branches: [{ when: "bogus" }] } },
				},
			},
			"when: must be one of",
		);
		expectConfigError(
			{
				...withTransition(),
				"task-types": { implement: { template: "x", transition: { pin: "x" } } },
			},
			'unknown key "pin"',
		);
	});

	test("the previous-message placeholder is a known prompt placeholder", () => {
		const data = base();
		data["task-types"].implement.template = "then: {previous-message}";
		const config = validateConfig(data);
		expect(config.taskTypes.implement.template).toContain("{previous-message}");
	});
});

describe("logging config keys", () => {
	/** The minimal config every test in this block breaks in one place. */
	const base = () => ({
		"default-agent": "pi",
		"default-environment": "live-worktree",
		"default-task-type": "implement",
		agents: { pi: { kind: "pi" } },
		"task-types": { implement: { template: "x" } },
	});

	test("an absent table means no log", () => {
		expect(validateConfig(base()).logging).toBeUndefined();
	});

	test("a present table takes its defaults", () => {
		const config = validateConfig({ ...base(), logging: {} });
		expect(config.logging).toEqual({ level: "info", maxSizeMib: 10, keep: 5 });
	});

	test("every key validates its type and range", () => {
		expectConfigError({ ...base(), logging: "info" }, "[logging] must be a table");
		expectConfigError({ ...base(), logging: { level: "verbose" } }, "logging.level must be one of");
		expectConfigError(
			{ ...base(), logging: { "max-size-mib": 0 } },
			"logging.max-size-mib: must be a whole number greater than 0",
		);
		expectConfigError(
			{ ...base(), logging: { keep: 1.5 } },
			"logging.keep: must be a whole number greater than 0",
		);
		expectConfigError(
			{ ...base(), logging: { file: 7 } },
			"logging.file: must be a non-empty string",
		);
	});

	test("an unknown key in the table fails startup", () => {
		expectConfigError(
			{ ...base(), logging: { level: "info", extra: 1 } },
			"unknown key in [logging]: extra",
		);
	});

	test("the table round-trips through configToToml", () => {
		const config = validateConfig({
			...base(),
			logging: { level: "debug", file: "run.log", "max-size-mib": 4, keep: 2 },
		});
		const reparsed = validateConfig(parseToml(configToToml(config)));
		expect(reparsed.logging).toEqual({ level: "debug", file: "run.log", maxSizeMib: 4, keep: 2 });
	});

	test("the log path resolves like the state file path", () => {
		// No file: the log lands next to the state file it records.
		const besideState = validateConfig({
			...base(),
			"state-file": "/tmp/run/state.sqlite",
			logging: { level: "info" },
		});
		expect(logPathFor(besideState, "/whatever/config.toml")).toBe("/tmp/run/factory.log");
		// A relative file: the selected config's directory, the state-file rule.
		const named = validateConfig({ ...base(), logging: { level: "info", file: "run.log" } });
		expect(logPathFor(named, "/cfg/config.toml")).toBe("/cfg/run.log");
		// An absolute file stands.
		const absolute = validateConfig({
			...base(),
			logging: { level: "info", file: "/var/log/factory.log" },
		});
		expect(logPathFor(absolute, "/cfg/config.toml")).toBe("/var/log/factory.log");
		// No table: no log, no path.
		expect(logPathFor(validateConfig(base()), "/cfg/config.toml")).toBeUndefined();
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

	test("a type without an environment starts in an isolated worktree", () => {
		const config = validateConfig({
			...base(),
			"consultation-types": {
				consult: { agent: "pi", template: "{input}" },
			},
		});
		expect(config.consultationTypes.consult).toEqual({
			agent: "pi",
			environment: "worktree",
			template: "{input}",
		});
	});

	test("a setting its agent maps no template for is refused with the shared sentence", () => {
		// The file path holds the same rule as the panel and the start, with the
		// config's own key prefix in front of the module's one sentence.
		expectConfigError(
			{
				...base(),
				agents: { pi: { kind: "pi" } },
				"consultation-types": {
					grill: { agent: "pi", environment: "worktree", template: "{input}", model: "gpt-4o" },
				},
			},
			'consultation-types.grill.model: agent type "pi" defines no model setting, so model "gpt-4o" cannot reach it',
		);
		expectConfigError(
			{
				...base(),
				"consultation-types": {
					grill: { agent: "pi", environment: "worktree", template: "{input}", model: 7 },
				},
			},
			"consultation-types.grill.model: must be a non-empty string",
		);
		// A type that names no model leaves the field unasked: the same agent that
		// maps no model setting is a fine start for it.
		expect(() =>
			validateConfig({
				...base(),
				agents: { pi: { kind: "pi" } },
				"consultation-types": {
					grill: { agent: "pi", environment: "worktree", template: "{input}" },
				},
			}),
		).not.toThrow();
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
		const config = validateConfig(parseToml(configToToml(BASE_CONFIG)));
		expect(config).toEqual(BASE_CONFIG);
	});

	test("persistConfig writes a file the loader reads back", async () => {
		const temp = inTempDir();
		const path = temp("factory/config.toml");
		const config: FactoryConfig = {
			...BASE_CONFIG,
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
		await expect(persistConfig(path, BASE_CONFIG)).rejects.toThrow();
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
	});
});
