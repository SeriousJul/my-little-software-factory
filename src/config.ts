/** The strict, startup-only factory configuration. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

import { isThinkingLevel, type ThinkingLevel, thinkingLevelList } from "./domain/agent.ts";
import { type EnvironmentKind, HANDOFF_ENVIRONMENT_KINDS } from "./domain/ticket.ts";
import { fileExists } from "./fs.ts";
import { firstNonEmptyLine } from "./lines.ts";

export interface AgentTypeConfig {
	kind: string;
	model?: string;
	thinking?: string;
	/**
	 * The Thinking levels this Agent type maps, as a non-empty subset of the
	 * standard set. An agent that maps thinking must declare it: the override
	 * panel offers exactly this list, and the handoff fit check tests against
	 * it (ADR 0010).
	 */
	thinkingValues?: ThinkingLevel[];
}

export interface TaskTypeConfig {
	template: string;
	/** The Task profile's agent type. Omitted leaves the agent to `default-agent`. */
	agent?: string;
	/** The Task profile's model. Omitted leaves the model to `default-model`. */
	model?: string;
	/** The thinking level of its handoffs when no explicit choice is made. Omitted leaves the setting to the agent. */
	thinking?: ThinkingLevel;
	/** Settle turns of this type without an operator decision. */
	autoClose: boolean;
}

/** A repeatable, operator-started interaction pattern. */
export interface ConsultationTypeConfig {
	/** The configured Agent type to start. */
	agent: string;
	/** The Environment in which the Agent runs. */
	environment: EnvironmentKind;
	/** The opening prompt. It contains {input} exactly once. */
	template: string;
	/** Optional model setting passed through the Agent type mapping. */
	model?: string;
	/** Optional thinking setting passed through the Agent type mapping. */
	thinking?: ThinkingLevel;
}

/** A semantic key used to leave Agent interaction mode. */
export type InteractionExitKey = string;

/**
 * One workflow edge: from a task type to the task types a settled turn of
 * it can hand off to. The edge's optional agent and environment override
 * the config defaults for that handoff.
 */
export interface WorkflowEdge {
	from: string;
	to: string[];
	agent?: string;
	environment?: EnvironmentKind;
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

export interface ScrollConfig {
	/** Rows moved by one detail key step or one slow wheel event. */
	speed: number;
	/** Wheel-burst acceleration strength. Zero keeps wheel movement linear. */
	acceleration: number;
	/** The upper bound in rows for one accelerated wheel event. */
	maximumSpeed: number;
}

export interface FactoryConfig {
	defaultAgent: string;
	defaultEnvironment: EnvironmentKind;
	defaultTaskType: string;
	/**
	 * The model a handoff starts with when the task profile names none and the
	 * operator overrides none (ADR 0009). Empty leaves the setting to the
	 * agent. Startup checks it through every task profile that resolves it, so
	 * a value one agent offers and another does not is still reported per
	 * agent; the handoff fit check guards it again there.
	 */
	defaultModel?: string;
	agents: Record<string, AgentTypeConfig>;
	taskTypes: Record<string, TaskTypeConfig>;
	/** Optional interactive Consultation patterns. Empty is valid. */
	consultationTypes: Record<string, ConsultationTypeConfig>;
	/** Whether a newly settled Consultation rings the terminal bell. */
	attentionBell: boolean;
	/** The semantic key which exits Agent interaction mode. */
	interactionExitKey: InteractionExitKey;
	/** Whether the control plane auto-hands-off open tickets. Off at startup. */
	autoHandoff: boolean;
	/** Agents the control plane keeps in flight; 0 means unlimited. */
	maxParallelAgents: number;
	/** How often the control plane polls herdr for agent states. */
	agentPollIntervalSeconds: number;
	/** How many lines of an agent it captures when the agent settles. */
	completionMessageLines: number;
	/** Handoffs per ticket after which the control plane stops dispatching it. */
	maxHandoffsPerTicket: number;
	/** Detail-pane keyboard and wheel scroll behavior. */
	scroll: ScrollConfig;
	/** Workflows a settled turn can hand off to. */
	workflows: WorkflowEdge[];
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
			thinkingValues: ["minimal", "low", "medium", "high"],
		},
		claude: {
			kind: "claude",
			model: "--model {value}",
			thinking: "--effort {value}",
			thinkingValues: ["low", "medium", "high", "xhigh", "max"],
		},
	},
	consultationTypes: {},
	attentionBell: true,
	interactionExitKey: "f12",
	taskTypes: {
		implement: {
			template:
				"Implement the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
			autoClose: false,
		},
		fix: {
			template:
				"Fix the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
			autoClose: false,
		},
		review: {
			template:
				"Review pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
			autoClose: false,
		},
		rework: {
			template:
				"Rework pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
			autoClose: false,
		},
	},
	autoHandoff: false,
	maxParallelAgents: 2,
	agentPollIntervalSeconds: 5,
	completionMessageLines: 200,
	maxHandoffsPerTicket: 10,
	scroll: { speed: 1, acceleration: 0.8, maximumSpeed: 6 },
	workflows: [],
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
		"default-model",
		"agents",
		"task-types",
		"consultation-types",
		"attention-bell",
		"interaction-exit-key",
		"repos",
		"sources",
		"ticket-sources",
		"task-rules",
		"state-file",
		"auto-handoff",
		"max-parallel-agents",
		"agent-poll-interval-seconds",
		"completion-message-lines",
		"max-handoffs-per-ticket",
		"scroll",
		"workflows",
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
	const defaultModel = optionalStringField(data, "default-model");
	const agents = validateAgents(data.agents);
	if (!(defaultAgent in agents)) {
		throw new ConfigError(`config: default-agent "${defaultAgent}" does not match any agent`);
	}
	// The task profile resolves its agent through `default-agent` when the
	// profile names none, so the thinking and model checks need that agent.
	const taskTypes = validateTaskTypes(data["task-types"], agents, defaultAgent);
	const consultationTypes = validateConsultationTypes(data["consultation-types"], agents);
	const attentionBell = booleanField(data, "attention-bell", true);
	const interactionExitKey = validateInteractionExitKey(
		data["interaction-exit-key"] === undefined ? "f12" : stringField(data, "interaction-exit-key"),
	);
	const repos = validateRepos(data.repos);
	const sources = validateSources(data.sources ?? data["ticket-sources"]);
	const taskRules = validateTaskRules(data["task-rules"], taskTypes);
	const workflows = validateWorkflows(data.workflows, taskTypes, agents);
	const stateFile = data["state-file"] === undefined ? undefined : stringField(data, "state-file");
	const autoHandoff = booleanField(data, "auto-handoff", false);
	const maxParallelAgents = nonNegativeIntField(data, "max-parallel-agents", 2);
	const agentPollIntervalSeconds = positiveNumberField(data, "agent-poll-interval-seconds", 5);
	const completionMessageLines = positiveIntField(data, "completion-message-lines", 200);
	const maxHandoffsPerTicket = positiveIntField(data, "max-handoffs-per-ticket", 10);
	const scroll = validateScroll(data.scroll);
	if (!(defaultTaskType in taskTypes)) {
		throw new ConfigError(
			`config: default-task-type "${defaultTaskType}" does not match any task type`,
		);
	}
	return {
		defaultAgent,
		defaultEnvironment: defaultEnvironment as EnvironmentKind,
		defaultTaskType,
		...(defaultModel === undefined ? {} : { defaultModel }),
		agents,
		taskTypes,
		consultationTypes,
		attentionBell,
		interactionExitKey,
		autoHandoff,
		maxParallelAgents,
		agentPollIntervalSeconds,
		completionMessageLines,
		maxHandoffsPerTicket,
		scroll,
		workflows,
		repos,
		sources,
		taskRules,
		...(stateFile === undefined ? {} : { stateFile }),
	};
}

function validateScroll(value: unknown): ScrollConfig {
	if (value === undefined) return { ...DEFAULT_CONFIG.scroll };
	if (!isRecord(value)) throw new ConfigError("config: scroll: must be a table");
	const known = new Set(["speed", "acceleration", "maximum-speed"]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new ConfigError(`config: scroll: unknown key "${key}"`);
	}
	const speed = positiveIntField(value, "speed", DEFAULT_CONFIG.scroll.speed, "scroll");
	const acceleration = nonNegativeFiniteNumberField(
		value,
		"acceleration",
		DEFAULT_CONFIG.scroll.acceleration,
		"scroll",
	);
	const maximumSpeed = positiveIntField(
		value,
		"maximum-speed",
		DEFAULT_CONFIG.scroll.maximumSpeed,
		"scroll",
	);
	if (maximumSpeed < speed) {
		throw new ConfigError("config: scroll.maximum-speed: must be at least scroll.speed");
	}
	return { speed, acceleration, maximumSpeed };
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
			agent.thinkingValues = validateThinkingValues(raw["thinking-values"], name);
		}
		if (agent.thinking !== undefined && agent.thinkingValues === undefined) {
			// Free-text thinking is retired: the panel offers, and the fit check
			// tests against, the levels the agent declares.
			throw new ConfigError(
				`config: agents.${name}.thinking-values: an agent that maps thinking must declare the levels it supports (${thinkingLevelList()})`,
			);
		}
		if (agent.thinking === undefined && agent.thinkingValues !== undefined) {
			throw new ConfigError(
				`config: agents.${name}.thinking-values: the agent maps no thinking setting, so it has no levels to declare`,
			);
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
 * One agent's declared Thinking levels: a non-empty subset of the standard
 * set, in the order the operator wants them offered.
 */
function validateThinkingValues(value: unknown, name: string): ThinkingLevel[] {
	const where = `config: agents.${name}.thinking-values`;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
		throw new ConfigError(`${where}: must be a list of level strings`);
	}
	if (value.length === 0) {
		throw new ConfigError(`${where}: must declare at least one level (${thinkingLevelList()})`);
	}
	const out: ThinkingLevel[] = [];
	for (const item of value) {
		if (!isThinkingLevel(item)) {
			throw new ConfigError(
				`${where}: "${String(item)}" is not a standard thinking level (${thinkingLevelList()})`,
			);
		}
		if (out.includes(item)) throw new ConfigError(`${where}: "${item}" is declared twice`);
		out.push(item);
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
	"previous-message",
];
function validateTaskTypes(
	value: unknown,
	agents: Record<string, AgentTypeConfig>,
	defaultAgent: string,
): Record<string, TaskTypeConfig> {
	const taskTypes = tableField(value === undefined ? {} : value, "task-types");
	if (Object.keys(taskTypes).length === 0)
		throw new ConfigError("config: at least one task type is required under [task-types]");
	const out: Record<string, TaskTypeConfig> = {};
	for (const [name, raw] of Object.entries(taskTypes)) {
		const where = `task-types.${name}`;
		if (/\s/.test(name)) throw new ConfigError(`config: ${where}: must be a one-word name`);
		if (!isRecord(raw)) throw new ConfigError(`config: ${where}: must be a table`);
		const template = stringField(raw, "template", where);
		for (const placeholder of placeholderNames(template)) {
			if (!PROMPT_PLACEHOLDERS.includes(placeholder)) {
				throw new ConfigError(
					`config: ${where}.template: unknown placeholder {${placeholder}}; use ${PROMPT_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
				);
			}
		}
		// The Task profile (ADR 0009): its own agent, model, and thinking level.
		// An omitted agent leaves the agent to `default-agent`, so the profile's
		// settings are checked against the agent its handoffs start on.
		const agent = optionalStringField(raw, "agent", where);
		if (agent !== undefined && !(agent in agents))
			throw new ConfigError(`config: ${where}.agent: unknown agent "${agent}"`);
		const profileAgent = agent ?? defaultAgent;
		const agentConfig = agents[profileAgent];
		const model = optionalStringField(raw, "model", where);
		if (model !== undefined && agentConfig?.model === undefined)
			throw new ConfigError(
				`config: ${where}.model: agent "${profileAgent}" does not define a model setting`,
			);
		const thinking = validateThinkingLevel(
			optionalStringField(raw, "thinking", where),
			profileAgent,
			agentConfig,
			`${where}.thinking`,
		);
		const autoClose = booleanField(raw, "auto-close", false);
		for (const key of Object.keys(raw))
			if (!["template", "agent", "model", "thinking", "auto-close"].includes(key))
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
		out[name] = {
			template,
			...(agent === undefined ? {} : { agent }),
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			autoClose,
		};
	}
	return out;
}

/**
 * A configured Thinking level: one of the standard set, and one the agent the
 * setting resolves to actually maps. An omitted level stays unset: the level
 * is left to the agent.
 */
function validateThinkingLevel(
	value: string | undefined,
	agentName: string,
	agent: AgentTypeConfig | undefined,
	where: string,
): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (!isThinkingLevel(value)) {
		throw new ConfigError(
			`config: ${where}: "${value}" is not a standard thinking level (${thinkingLevelList()})`,
		);
	}
	if (agent === undefined || agent.thinking === undefined)
		throw new ConfigError(
			`config: ${where}: agent "${agentName}" does not define a thinking setting`,
		);
	const supported = agent.thinkingValues ?? [];
	if (!supported.includes(value))
		throw new ConfigError(
			`config: ${where}: agent "${agentName}" does not support "${value}"; it supports: ${supported.join(", ")}`,
		);
	return value;
}

/** Validate the optional Consultation type table at startup. */
function validateConsultationTypes(
	value: unknown,
	agents: Record<string, AgentTypeConfig>,
): Record<string, ConsultationTypeConfig> {
	const types = tableField(value === undefined ? {} : value, "consultation-types");
	const out: Record<string, ConsultationTypeConfig> = {};
	for (const [name, raw] of Object.entries(types)) {
		if (/\s/.test(name) || name === "")
			throw new ConfigError(`config: consultation-types.${name}: must be a one-word name`);
		if (!isRecord(raw))
			throw new ConfigError(`config: consultation-types.${name}: must be a table`);
		for (const key of Object.keys(raw))
			if (!["agent", "environment", "template", "model", "thinking"].includes(key))
				throw new ConfigError(`config: consultation-types.${name}: unknown key "${key}"`);
		const where = `consultation-types.${name}`;
		const agent = stringField(raw, "agent", where);
		const agentConfig = agents[agent];
		if (agentConfig === undefined)
			throw new ConfigError(`${where}.agent: unknown agent "${agent}"`);
		const environment = stringField(raw, "environment", where);
		if (!(HANDOFF_ENVIRONMENT_KINDS as readonly string[]).includes(environment))
			throw new ConfigError(
				`${where}.environment: must be one of: ${HANDOFF_ENVIRONMENT_KINDS.join(", ")}`,
			);
		const template = stringField(raw, "template", where);
		validateConsultationTemplate(template, `${where}.template`);
		const model = optionalStringField(raw, "model", where);
		if (model !== undefined && agentConfig.model === undefined)
			throw new ConfigError(`${where}.model: agent "${agent}" does not define a model setting`);
		const thinking = validateThinkingLevel(
			raw.thinking === undefined ? undefined : stringField(raw, "thinking", where),
			agent,
			agentConfig,
			`${where}.thinking`,
		);
		out[name] = {
			agent,
			environment: environment as EnvironmentKind,
			template,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
		};
	}
	return out;
}

/** Consultation templates have one input slot and no silent placeholders. */
function validateConsultationTemplate(template: string, where: string): void {
	const placeholders = placeholderNames(template);
	if (placeholders.filter((name) => name === "input").length !== 1)
		throw new ConfigError(`${where}: template must contain the {input} placeholder exactly once`);
	for (const placeholder of placeholders) {
		if (placeholder !== "input")
			throw new ConfigError(`${where}: unknown placeholder {${placeholder}}; use {input}`);
	}
	// A brace which is not part of a matched pair would be sent literally and
	// is almost always a configuration mistake. Reject it like other unknown
	// placeholders.
	const withoutPairs = template.replace(/\{[^{}]*\}/g, "");
	if (withoutPairs.includes("{") || withoutPairs.includes("}"))
		throw new ConfigError(`${where}: contains an unmatched brace`);
}

/** Validate and canonicalize the semantic Agent-terminal exit binding. */
export function validateInteractionExitKey(value: string): InteractionExitKey {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^ctrl-/, "ctrl+");
	if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized;
	if (/^ctrl\+[a-z]$/.test(normalized)) return normalized;
	throw new ConfigError(
		"config: interaction-exit-key must be a function key (for example f12) or ctrl plus one letter",
	);
}

function validateWorkflows(
	value: unknown,
	taskTypes: Record<string, TaskTypeConfig>,
	agents: Record<string, AgentTypeConfig>,
): WorkflowEdge[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new ConfigError("config: workflows: must be a list of [[workflows]] tables");
	return value.map((raw, index) => {
		const where = `workflows[${index}]`;
		if (!isRecord(raw)) throw new ConfigError(`config: ${where}: must be a table`);
		for (const key of Object.keys(raw))
			if (!new Set(["from", "to", "agent", "environment"]).has(key))
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
		const from = stringField(raw, "from", where);
		if (!(from in taskTypes))
			throw new ConfigError(`config: ${where}.from: unknown task type "${from}"`);
		const toRaw = raw.to;
		if (
			!Array.isArray(toRaw) ||
			toRaw.length === 0 ||
			toRaw.some((target) => typeof target !== "string" || target === "")
		) {
			throw new ConfigError(`config: ${where}.to: must be a non-empty list of task types`);
		}
		const to = toRaw.map((target) => {
			if (!(target in taskTypes))
				throw new ConfigError(`config: ${where}.to: unknown task type "${target}"`);
			return target;
		});
		let agent: string | undefined;
		if (raw.agent !== undefined) {
			agent = stringField(raw, "agent", where);
			if (!(agent in agents))
				throw new ConfigError(`config: ${where}.agent: unknown agent "${agent}"`);
		}
		let environment: EnvironmentKind | undefined;
		if (raw.environment !== undefined) {
			const kind = stringField(raw, "environment", where);
			if (!(HANDOFF_ENVIRONMENT_KINDS as readonly string[]).includes(kind)) {
				throw new ConfigError(
					`config: ${where}.environment: must be one of: ${HANDOFF_ENVIRONMENT_KINDS.join(", ")}`,
				);
			}
			environment = kind as EnvironmentKind;
		}
		return {
			from,
			to,
			...(agent === undefined ? {} : { agent }),
			...(environment === undefined ? {} : { environment }),
		};
	});
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

/** A boolean top-level key: absent takes the default, present must be a boolean. */
function booleanField(record: Record<string, unknown>, key: string, def: boolean): boolean {
	const value = record[key];
	if (value === undefined) return def;
	if (typeof value !== "boolean")
		throw new ConfigError(`config: ${key}: must be a boolean (true or false)`);
	return value;
}

/** An integer top-level key of 0 or more; absent takes the default. */
function nonNegativeIntField(record: Record<string, unknown>, key: string, def: number): number {
	const value = record[key];
	if (value === undefined) return def;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new ConfigError(`config: ${key}: must be a whole number of 0 or more`);
	return value;
}

/** A positive whole-number top-level key; absent takes the default. */
function positiveIntField(
	record: Record<string, unknown>,
	key: string,
	def: number,
	where?: string,
): number {
	const value = record[key];
	if (value === undefined) return def;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		throw new ConfigError(
			`config: ${where === undefined ? key : `${where}.${key}`}: must be a whole number greater than 0`,
		);
	return value;
}

function nonNegativeFiniteNumberField(
	record: Record<string, unknown>,
	key: string,
	def: number,
	where?: string,
): number {
	const value = record[key];
	if (value === undefined) return def;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ConfigError(
			`config: ${where === undefined ? key : `${where}.${key}`}: must be a finite number of 0 or more`,
		);
	}
	return value;
}

/** A positive-number top-level key; absent takes the default. */
function positiveNumberField(record: Record<string, unknown>, key: string, def: number): number {
	const value = record[key];
	if (value === undefined) return def;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		throw new ConfigError(`config: ${key}: must be a positive number`);
	return value;
}
function optionalStringField(
	record: Record<string, unknown>,
	key: string,
	where?: string,
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
		...(config.defaultModel === undefined ? {} : { "default-model": config.defaultModel }),
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
					...(task.agent === undefined ? {} : { agent: task.agent }),
					...(task.model === undefined ? {} : { model: task.model }),
					...(task.thinking === undefined ? {} : { thinking: task.thinking }),
					...(task.autoClose ? { "auto-close": true } : {}),
				},
			]),
		),
		"consultation-types": Object.fromEntries(
			Object.entries(config.consultationTypes).map(([name, consultation]) => [
				name,
				{
					agent: consultation.agent,
					environment: consultation.environment,
					template: consultation.template,
					...(consultation.model === undefined ? {} : { model: consultation.model }),
					...(consultation.thinking === undefined ? {} : { thinking: consultation.thinking }),
				},
			]),
		),
		"attention-bell": config.attentionBell,
		"interaction-exit-key": config.interactionExitKey,
		"auto-handoff": config.autoHandoff,
		"max-parallel-agents": config.maxParallelAgents,
		"agent-poll-interval-seconds": config.agentPollIntervalSeconds,
		"completion-message-lines": config.completionMessageLines,
		"max-handoffs-per-ticket": config.maxHandoffsPerTicket,
		scroll: {
			speed: config.scroll.speed,
			acceleration: config.scroll.acceleration,
			"maximum-speed": config.scroll.maximumSpeed,
		},
		workflows: config.workflows.map((edge) => ({
			from: edge.from,
			to: edge.to,
			...(edge.agent === undefined ? {} : { agent: edge.agent }),
			...(edge.environment === undefined ? {} : { environment: edge.environment }),
		})),
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
