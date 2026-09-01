/** The strict, startup-only factory configuration. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

import { type EnvironmentKind, HANDOFF_ENVIRONMENT_KINDS } from "./domain/ticket.ts";
import { fileExists } from "./fs.ts";
import { firstNonEmptyLine } from "./lines.ts";

export interface AgentTypeConfig {
	kind: string;
	model?: string;
	thinking?: string;
	thinkingValues?: string[];
}

export interface TaskTypeConfig {
	template: string;
	/** The thinking level of its handoffs when no explicit choice is made. Omitted leaves the setting to the agent. */
	thinking?: string;
}

export type GitHubSourceKind = "github-issues" | "github-pull-requests";

export interface GitHubAuthentication {
	/** A literal token. It is never passed in argv. */
	token?: string;
	/** The environment variable that contains a token. */
	tokenEnv?: string;
	/** An account already authenticated by gh. */
	account?: string;
}

export interface TicketSourceConfig {
	name: string;
	kind: GitHubSourceKind;
	refreshIntervalSeconds: number;
	repositories: string[];
	host: string;
	filter?: string;
	auth?: GitHubAuthentication;
}

export interface TaskRuleWhen {
	sourceName?: string;
	sourceKind?: string;
	repository?: string;
	labelsAll?: string[];
	labelsAny?: string[];
	labelsNone?: string[];
}

export interface TaskRule {
	taskType: string;
	when: TaskRuleWhen;
}

export interface FactoryConfig {
	defaultAgent: string;
	defaultEnvironment: EnvironmentKind;
	defaultTaskType: string;
	agents: Record<string, AgentTypeConfig>;
	taskTypes: Record<string, TaskTypeConfig>;
	/** Repository identity to checkout path. */
	repos: Record<string, string>;
	/** No shipped source points at the maintainer repository. */
	sources: TicketSourceConfig[];
	taskRules: TaskRule[];
	/** An optional state file. Relative paths use the selected config directory. */
	stateFile?: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export const DEFAULT_CONFIG: FactoryConfig = {
	defaultAgent: "pi",
	defaultEnvironment: "live-worktree",
	defaultTaskType: "implement",
	agents: {
		pi: {
			kind: "pi",
			model: "--model {value}",
			thinking: "--thinking {value}",
			thinkingValues: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
		codex: {
			kind: "codex",
			model: "--model {value}",
			thinking: "-c model_reasoning_effort={value}",
		},
		claude: { kind: "claude", model: "--model {value}", thinking: "--effort {value}" },
	},
	taskTypes: {
		implement: {
			template:
				"Implement the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		fix: {
			template:
				"Fix the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		review: {
			template:
				"Review pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		rework: {
			template:
				"Rework pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
	},
	repos: {},
	sources: [],
	taskRules: [
		{ taskType: "rework", when: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] } },
		{
			taskType: "review",
			when: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
		},
	],
};

export function defaultConfigPath(): string {
	return join(os.homedir(), ".config", "factory", "config.toml");
}

export function defaultStatePath(
	home = os.homedir(),
	xdgStateHome = process.env.XDG_STATE_HOME,
): string {
	return join(xdgStateHome || join(home, ".local", "state"), "factory", "state.sqlite");
}

/** Resolve a configured state path relative to the selected config file. */
export function statePathFor(config: FactoryConfig, configPath: string): string {
	if (config.stateFile === undefined) {
		return defaultStatePath();
	}
	return isAbsolute(config.stateFile)
		? config.stateFile
		: resolve(dirname(configPath), config.stateFile);
}

export async function loadConfigFile(
	path: string,
): Promise<{ config: FactoryConfig; fromFile: boolean }> {
	if (!(await fileExists(path))) {
		return { config: DEFAULT_CONFIG, fromFile: false };
	}
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read ${path}: ${String(error)}`);
	}
	try {
		return { config: validateConfig(parse(text)), fromFile: true };
	} catch (error) {
		if (error instanceof ConfigError) {
			throw error;
		}
		throw new ConfigError(`invalid TOML in ${path}: ${readableParseError(error)}`);
	}
}

function readableParseError(error: unknown): string {
	const message = String(error);
	return firstNonEmptyLine(message) ?? message.trim();
}

export function validateConfig(data: unknown): FactoryConfig {
	if (!isRecord(data)) {
		throw new ConfigError("config: the top level must be a table of key = value pairs");
	}
	const knownTop = new Set([
		"default-agent",
		"default-environment",
		"default-task-type",
		"agents",
		"task-types",
		"repos",
		"sources",
		"ticket-sources",
		"task-rules",
		"state-file",
	]);
	for (const key of Object.keys(data)) {
		if (!knownTop.has(key)) {
			throw new ConfigError(`config: unknown top-level key "${key}"`);
		}
	}
	if ("sources" in data && "ticket-sources" in data) {
		throw new ConfigError("config: use either sources or ticket-sources, not both");
	}
	const defaultAgent = stringField(data, "default-agent");
	const defaultEnvironment = stringField(data, "default-environment");
	const handoffKinds = HANDOFF_ENVIRONMENT_KINDS as readonly string[];
	if (!handoffKinds.includes(defaultEnvironment)) {
		throw new ConfigError(`config: default-environment must be one of: ${handoffKinds.join(", ")}`);
	}
	const defaultTaskType = stringField(data, "default-task-type");
	const agents = validateAgents(data.agents);
	const taskTypes = validateTaskTypes(data["task-types"]);
	const repos = validateRepos(data.repos);
	const sources = validateSources(data.sources ?? data["ticket-sources"]);
	const taskRules = validateTaskRules(data["task-rules"], taskTypes);
	const stateFile = data["state-file"] === undefined ? undefined : stringField(data, "state-file");
	if (!(defaultAgent in agents)) {
		throw new ConfigError(`config: default-agent "${defaultAgent}" does not match any agent`);
	}
	if (!(defaultTaskType in taskTypes)) {
		throw new ConfigError(
			`config: default-task-type "${defaultTaskType}" does not match any task type`,
		);
	}
	return {
		defaultAgent,
		defaultEnvironment: defaultEnvironment as EnvironmentKind,
		defaultTaskType,
		agents,
		taskTypes,
		repos,
		sources,
		taskRules,
		...(stateFile === undefined ? {} : { stateFile }),
	};
}

function validateAgents(value: unknown): Record<string, AgentTypeConfig> {
	const agents = tableField(value === undefined ? {} : value, "agents");
	if (Object.keys(agents).length === 0)
		throw new ConfigError("config: at least one agent is required under [agents]");
	const out: Record<string, AgentTypeConfig> = {};
	for (const [name, raw] of Object.entries(agents)) {
		if (!isRecord(raw)) throw new ConfigError(`config: agents.${name}: must be a table`);
		const agent: AgentTypeConfig = { kind: stringField(raw, "kind", `agents.${name}`) };
		const model = optionalStringField(raw, "model", `agents.${name}`);
		const thinking = optionalStringField(raw, "thinking", `agents.${name}`);
		if (model !== undefined) agent.model = settingTemplate(model, `agents.${name}.model`);
		if (thinking !== undefined)
			agent.thinking = settingTemplate(thinking, `agents.${name}.thinking`);
		if ("thinking-values" in raw) {
			const values = raw["thinking-values"];
			if (
				!Array.isArray(values) ||
				values.some((item) => typeof item !== "string" || item === "")
			) {
				throw new ConfigError(`config: agents.${name}.thinking-values: must be a list of strings`);
			}
			agent.thinkingValues = [...values];
		}
		for (const key of Object.keys(raw)) {
			if (!new Set(["kind", "model", "thinking", "thinking-values"]).has(key)) {
				throw new ConfigError(`config: agents.${name}: unknown key "${key}"`);
			}
		}
		out[name] = agent;
	}
	return out;
}

/**
 * GitHub issue search applies AND, OR, and NOT to search text only, and it
 * has no parenthesized grouping. Unsupported shapes fail or return zero
 * results silently, turning a source into a healthy-but-empty list. This is
 * the single home of that rule; the built-in policies in ticket-source.ts
 * are built from it. Reject the shapes at config time.
 */
function validateSearchFilter(filter: string, where: string): void {
	const parsed = tokenizeSearchFilter(filter);
	if (parsed.quotesOpen)
		throw new ConfigError(`${where}: a quoted search term is not closed; add the matching quote`);
	const tokens = parsed.tokens;
	if (tokens.some((token) => token.includes("(") || token.includes(")")))
		throw new ConfigError(
			`${where}: parentheses do not group GitHub search queries; define one source per query branch`,
		);
	const logicalOperators = new Set(["AND", "OR", "NOT"]);
	const hasOperator = tokens.some((token) => logicalOperators.has(token.toUpperCase()));
	if (!hasOperator) return;
	const hasQualifier = tokens.some(
		(token) => token.includes(":") && !token.startsWith('"') && !token.startsWith("'"),
	);
	if (hasQualifier)
		throw new ConfigError(
			`${where}: AND, OR, and NOT apply to search text, not to qualifiers like label:; define one source per query branch`,
		);
}

/** Split a filter into tokens, keeping quoted phrases as single text terms. */
function tokenizeSearchFilter(filter: string): { tokens: string[]; quotesOpen: boolean } {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of filter) {
		if (quote === undefined) {
			if (char === '"' || char === "'") {
				quote = char;
				current += char;
				continue;
			}
			if (/\s/.test(char)) {
				if (current !== "") tokens.push(current);
				current = "";
				continue;
			}
		} else if (char === quote) {
			quote = undefined;
		}
		current += char;
	}
	if (current !== "") tokens.push(current);
	return { tokens, quotesOpen: quote !== undefined };
}

const PROMPT_PLACEHOLDERS = [
	"repository",
	"title",
	"description",
	"source-kind",
	"external-key",
	"source-url",
	"labels",
];
function validateTaskTypes(value: unknown): Record<string, TaskTypeConfig> {
	const taskTypes = tableField(value === undefined ? {} : value, "task-types");
	if (Object.keys(taskTypes).length === 0)
		throw new ConfigError("config: at least one task type is required under [task-types]");
	const out: Record<string, TaskTypeConfig> = {};
	for (const [name, raw] of Object.entries(taskTypes)) {
		if (/\s/.test(name))
			throw new ConfigError(`config: task-types.${name}: must be a one-word name`);
		if (!isRecord(raw)) throw new ConfigError(`config: task-types.${name}: must be a table`);
		const template = stringField(raw, "template", `task-types.${name}`);
		const thinking = optionalStringField(raw, "thinking", `task-types.${name}`);
		for (const placeholder of placeholderNames(template)) {
			if (!PROMPT_PLACEHOLDERS.includes(placeholder)) {
				throw new ConfigError(
					`config: task-types.${name}.template: unknown placeholder {${placeholder}}; use ${PROMPT_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
				);
			}
		}
		for (const key of Object.keys(raw))
			if (key !== "template" && key !== "thinking")
				throw new ConfigError(`config: task-types.${name}: unknown key "${key}"`);
		out[name] = thinking === undefined ? { template } : { template, thinking };
	}
	return out;
}

function validateRepos(value: unknown): Record<string, string> {
	if (value === undefined) return {};
	if (!isRecord(value))
		throw new ConfigError("config: repos: must be a table of repository identity to checkout path");
	const out: Record<string, string> = {};
	for (const [repository, raw] of Object.entries(value)) {
		if (typeof raw !== "string" || raw === "")
			throw new ConfigError(`config: repos["${repository}"]: must be a non-empty path`);
		out[repository] = raw;
	}
	return out;
}

function validateSources(value: unknown): TicketSourceConfig[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new ConfigError("config: sources: must be a list of source tables");
	const names = new Set<string>();
	return value.map((raw, index) => {
		const where = `sources[${index}]`;
		if (!isRecord(raw)) throw new ConfigError(`config: ${where}: must be a table`);
		for (const key of Object.keys(raw)) {
			if (
				!new Set([
					"name",
					"kind",
					"refresh-interval-seconds",
					"repositories",
					"host",
					"filter",
					"auth",
				]).has(key)
			) {
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
			}
		}
		const name = stringField(raw, "name", where);
		if (names.has(name)) throw new ConfigError(`config: duplicate source name "${name}"`);
		names.add(name);
		const kind = stringField(raw, "kind", where);
		if (kind !== "github-issues" && kind !== "github-pull-requests") {
			throw new ConfigError(`config: ${where}.kind: unknown source kind "${kind}"`);
		}
		const interval = raw["refresh-interval-seconds"];
		if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
			throw new ConfigError(`config: ${where}.refresh-interval-seconds: must be a positive number`);
		}
		if (
			!Array.isArray(raw.repositories) ||
			raw.repositories.length === 0 ||
			raw.repositories.some((repo) => typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo))
		) {
			throw new ConfigError(
				`config: ${where}.repositories: must be a non-empty list of owner/name strings`,
			);
		}
		const host =
			raw.host === undefined ? "github.com" : stringField(raw, "host", where).toLowerCase();
		const filter = raw.filter === undefined ? undefined : stringField(raw, "filter", where);
		if (filter !== undefined) validateSearchFilter(filter, `${where}.filter`);
		const auth = raw.auth === undefined ? undefined : validateAuth(raw.auth, `${where}.auth`);
		return {
			name,
			kind,
			refreshIntervalSeconds: interval,
			repositories: [...raw.repositories] as string[],
			host,
			...(filter === undefined ? {} : { filter }),
			...(auth === undefined ? {} : { auth }),
		};
	});
}

function validateAuth(value: unknown, where: string): GitHubAuthentication {
	if (!isRecord(value)) throw new ConfigError(`config: ${where}: must be a table`);
	for (const key of Object.keys(value))
		if (!new Set(["token", "token-env", "account"]).has(key))
			throw new ConfigError(`config: ${where}: unknown key "${key}"`);
	const token = value.token === undefined ? undefined : stringField(value, "token", where);
	const tokenEnv =
		value["token-env"] === undefined ? undefined : stringField(value, "token-env", where);
	const account = value.account === undefined ? undefined : stringField(value, "account", where);
	if ([token, tokenEnv, account].filter((item) => item !== undefined).length !== 1) {
		throw new ConfigError(`config: ${where}: specify exactly one of token, token-env, or account`);
	}
	return {
		...(token === undefined ? {} : { token }),
		...(tokenEnv === undefined ? {} : { tokenEnv }),
		...(account === undefined ? {} : { account }),
	};
}

function validateTaskRules(value: unknown, taskTypes: Record<string, TaskTypeConfig>): TaskRule[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new ConfigError("config: task-rules: must be a list of rule tables");
	return value.map((raw, index) => {
		const where = `task-rules[${index}]`;
		if (!isRecord(raw)) throw new ConfigError(`config: ${where}: must be a table`);
		for (const key of Object.keys(raw))
			if (key !== "task-type" && key !== "when")
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
		const taskType = stringField(raw, "task-type", where);
		if (!(taskType in taskTypes))
			throw new ConfigError(`config: ${where}.task-type: unknown task type "${taskType}"`);
		if (!isRecord(raw.when)) throw new ConfigError(`config: ${where}.when: must be a table`);
		const whenRaw = raw.when;
		const known = [
			"source-name",
			"source-kind",
			"repository",
			"labels-all",
			"labels-any",
			"labels-none",
		];
		for (const key of Object.keys(whenRaw))
			if (!known.includes(key))
				throw new ConfigError(`config: ${where}.when: unknown key "${key}"`);
		const stringCondition = (key: "source-name" | "source-kind" | "repository") =>
			whenRaw[key] === undefined ? undefined : stringField(whenRaw, key, `${where}.when`);
		const labels = (key: "labels-all" | "labels-any" | "labels-none") => {
			const rawLabels = whenRaw[key];
			if (rawLabels === undefined) return undefined;
			if (
				!Array.isArray(rawLabels) ||
				rawLabels.length === 0 ||
				rawLabels.some((label) => typeof label !== "string" || label === "")
			)
				throw new ConfigError(`config: ${where}.when.${key}: must be a non-empty list of strings`);
			return [...rawLabels] as string[];
		};
		return {
			taskType,
			when: {
				...(stringCondition("source-name") === undefined
					? {}
					: { sourceName: stringCondition("source-name") }),
				...(stringCondition("source-kind") === undefined
					? {}
					: { sourceKind: stringCondition("source-kind") }),
				...(stringCondition("repository") === undefined
					? {}
					: { repository: stringCondition("repository") }),
				...(labels("labels-all") === undefined ? {} : { labelsAll: labels("labels-all") }),
				...(labels("labels-any") === undefined ? {} : { labelsAny: labels("labels-any") }),
				...(labels("labels-none") === undefined ? {} : { labelsNone: labels("labels-none") }),
			},
		};
	});
}

function settingTemplate(template: string, where: string): string {
	const placeholders = placeholderNames(template);
	if (!placeholders.includes("value"))
		throw new ConfigError(`config: ${where}: template must contain the {value} placeholder`);
	for (const placeholder of placeholders)
		if (placeholder !== "value")
			throw new ConfigError(`config: ${where}: unknown placeholder {${placeholder}}`);
	return template;
}
function placeholderNames(template: string): string[] {
	return [...template.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);
}
function stringField(record: Record<string, unknown>, key: string, where?: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "")
		throw new ConfigError(`config: ${where ? `${where}.${key}` : key}: must be a non-empty string`);
	return value;
}
function optionalStringField(
	record: Record<string, unknown>,
	key: string,
	where: string,
): string | undefined {
	return key in record ? stringField(record, key, where) : undefined;
}
function tableField(value: unknown, key: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ConfigError(`config: ${key}: must be a table`);
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configToToml(config: FactoryConfig): string {
	return stringify({
		"default-agent": config.defaultAgent,
		"default-environment": config.defaultEnvironment,
		"default-task-type": config.defaultTaskType,
		...(config.stateFile === undefined ? {} : { "state-file": config.stateFile }),
		agents: Object.fromEntries(
			Object.entries(config.agents).map(([name, agent]) => [
				name,
				{
					kind: agent.kind,
					...(agent.model === undefined ? {} : { model: agent.model }),
					...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
					...(agent.thinkingValues === undefined
						? {}
						: { "thinking-values": agent.thinkingValues }),
				},
			]),
		),
		"task-types": Object.fromEntries(
			Object.entries(config.taskTypes).map(([name, task]) => [
				name,
				{
					template: task.template,
					...(task.thinking === undefined ? {} : { thinking: task.thinking }),
				},
			]),
		),
		repos: config.repos,
		sources: config.sources.map((source) => ({
			name: source.name,
			kind: source.kind,
			"refresh-interval-seconds": source.refreshIntervalSeconds,
			repositories: source.repositories,
			...(source.host === "github.com" ? {} : { host: source.host }),
			...(source.filter === undefined ? {} : { filter: source.filter }),
			...(source.auth === undefined
				? {}
				: {
						auth: {
							...(source.auth.token === undefined ? {} : { token: source.auth.token }),
							...(source.auth.tokenEnv === undefined ? {} : { "token-env": source.auth.tokenEnv }),
							...(source.auth.account === undefined ? {} : { account: source.auth.account }),
						},
					}),
		})),
		"task-rules": config.taskRules.map((rule) => ({
			"task-type": rule.taskType,
			when: {
				...(rule.when.sourceName === undefined ? {} : { "source-name": rule.when.sourceName }),
				...(rule.when.sourceKind === undefined ? {} : { "source-kind": rule.when.sourceKind }),
				...(rule.when.repository === undefined ? {} : { repository: rule.when.repository }),
				...(rule.when.labelsAll === undefined ? {} : { "labels-all": rule.when.labelsAll }),
				...(rule.when.labelsAny === undefined ? {} : { "labels-any": rule.when.labelsAny }),
				...(rule.when.labelsNone === undefined ? {} : { "labels-none": rule.when.labelsNone }),
			},
		})),
	});
}

export async function persistConfig(path: string, config: FactoryConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await writeFile(temp, configToToml(config), {
		encoding: "utf8",
		mode: containsLiteralToken(config) ? 0o600 : 0o666,
	});
	if (containsLiteralToken(config)) await chmod(temp, 0o600);
	try {
		await rename(temp, path);
	} catch (error) {
		try {
			await unlink(temp);
		} catch {}
		throw error;
	}
}
function containsLiteralToken(config: FactoryConfig): boolean {
	return config.sources.some((source) => source.auth?.token !== undefined);
}
