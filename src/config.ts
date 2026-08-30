/**
 * The factory config: one TOML file at ~/.config/factory/config.toml.
 *
 * The file holds the handoff defaults (agent type, environment kind, task
 * type), the agent type blocks, the task type blocks, and the repository
 * mappings. It is read once at startup and validated against this schema:
 *
 * - A missing file is not an error: the shipped default config is used.
 * - An invalid file stops the control plane at startup with a readable
 *   error, so a wrong flag surfaces before any handoff.
 *
 * A new agent is one block (the herdr kind plus argument templates for the
 * settings). Changing the default agent is one line. Tomorrow's agent is a
 * config entry, not a code change.
 */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

import type { EnvironmentKind } from "./domain/ticket.ts";
import { HANDOFF_ENVIRONMENT_KINDS } from "./domain/ticket.ts";

/** The kind of an agent as herdr knows it (the `--kind` of agent start). */
export interface AgentTypeConfig {
	kind: string;
	/** Argument template for the model setting; omitted when unsupported. */
	model?: string;
	/** Argument template for the thinking setting; omitted when unsupported. */
	thinking?: string;
	/** The thinking levels this agent accepts; omitted for free text. */
	thinkingValues?: string[];
}

/** One task type: a one-word name and the prompt template it renders. */
export interface TaskTypeConfig {
	template: string;
}

/** The validated factory config. */
export interface FactoryConfig {
	defaultAgent: string;
	defaultEnvironment: EnvironmentKind;
	defaultTaskType: string;
	agents: Record<string, AgentTypeConfig>;
	taskTypes: Record<string, TaskTypeConfig>;
	/** Explicit repository mappings: "owner/name" to a checkout path. */
	repos: Record<string, string>;
}

/** A config problem with a message an operator can act on. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * The shipped default config, used when no config file exists.
 *
 * It ships the agents pi, codex, and claude with argument templates for the
 * model and the thinking level, and three task types whose templates form
 * the prompt sent to the agent.
 */
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
		claude: {
			kind: "claude",
			model: "--model {value}",
			thinking: "--effort {value}",
		},
	},
	taskTypes: {
		implement: {
			template:
				"Implement the following ticket.\n\n" +
				"Repository: {repository}\n\nTitle: {title}\n\nDescription:\n{description}",
		},
		fix: {
			template:
				"Fix the following ticket.\n\n" +
				"Repository: {repository}\n\nTitle: {title}\n\nDescription:\n{description}",
		},
		review: {
			template:
				"Review the following ticket.\n\n" +
				"Repository: {repository}\n\nTitle: {title}\n\nDescription:\n{description}",
		},
	},
	repos: {},
};

/** The config file path: ~/.config/factory/config.toml. */
export function defaultConfigPath(): string {
	return join(os.homedir(), ".config", "factory", "config.toml");
}

/**
 * Load and validate the factory config from `path`.
 *
 * A missing file yields the shipped default config. A file that cannot be
 * read, parsed, or validated throws a ConfigError with a readable message;
 * the caller stops the control plane with that message.
 */
export function loadConfigFile(path: string): { config: FactoryConfig; fromFile: boolean } {
	if (!existsSync(path)) {
		return { config: DEFAULT_CONFIG, fromFile: false };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read ${path}: ${String(error)}`);
	}
	let data: unknown;
	try {
		data = parse(text);
	} catch (error) {
		throw new ConfigError(`invalid TOML in ${path}: ${readableParseError(error)}`);
	}
	return { config: validateConfig(data), fromFile: true };
}

/** Reduce a TOML parse failure to one readable line. */
function readableParseError(error: unknown): string {
	const message = String(error);
	const line = message.split("\n").find((part) => part.trim() !== "");
	return line ?? message;
}

/**
 * Validate parsed TOML data against the config schema.
 *
 * The file is the complete config: every key the control plane reads must
 * be present, and every key the control plane does not read is an error, so
 * a typo in a flag name surfaces at startup instead of at handoff time.
 */
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
	]);
	for (const key of Object.keys(data)) {
		if (!knownTop.has(key)) {
			throw new ConfigError(`config: unknown top-level key "${key}"`);
		}
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
	};
}

function validateAgents(value: unknown): Record<string, AgentTypeConfig> {
	const agents = tableField(value === undefined ? {} : value, "agents");
	if (Object.keys(agents).length === 0) {
		throw new ConfigError("config: at least one agent is required under [agents]");
	}
	const out: Record<string, AgentTypeConfig> = {};
	for (const [name, raw] of Object.entries(agents)) {
		if (!isRecord(raw)) {
			throw new ConfigError(`config: agents.${name}: must be a table`);
		}
		const agent: AgentTypeConfig = { kind: stringField(raw, "kind", `agents.${name}`) };
		const model = optionalStringField(raw, "model", `agents.${name}`);
		const thinking = optionalStringField(raw, "thinking", `agents.${name}`);
		if (model !== undefined) {
			agent.model = settingTemplate(model, `agents.${name}.model`);
		}
		if (thinking !== undefined) {
			agent.thinking = settingTemplate(thinking, `agents.${name}.thinking`);
		}
		if ("thinking-values" in raw) {
			const values = raw["thinking-values"];
			if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || v === "")) {
				throw new ConfigError(`config: agents.${name}.thinking-values: must be a list of strings`);
			}
			agent.thinkingValues = [...values];
		}
		for (const key of Object.keys(raw)) {
			if (!["kind", "model", "thinking", "thinking-values"].includes(key)) {
				throw new ConfigError(`config: agents.${name}: unknown key "${key}"`);
			}
		}
		out[name] = agent;
	}
	return out;
}

function validateTaskTypes(value: unknown): Record<string, TaskTypeConfig> {
	const taskTypes = tableField(value === undefined ? {} : value, "task-types");
	if (Object.keys(taskTypes).length === 0) {
		throw new ConfigError("config: at least one task type is required under [task-types]");
	}
	const out: Record<string, TaskTypeConfig> = {};
	for (const [name, raw] of Object.entries(taskTypes)) {
		if (/[\s]/.test(name)) {
			throw new ConfigError(`config: task-types.${name}: must be a one-word name`);
		}
		if (!isRecord(raw)) {
			throw new ConfigError(`config: task-types.${name}: must be a table`);
		}
		const template = stringField(raw, "template", `task-types.${name}`);
		const placeholders = placeholderNames(template);
		for (const placeholder of placeholders) {
			if (!["repository", "title", "description"].includes(placeholder)) {
				throw new ConfigError(
					`config: task-types.${name}.template: unknown placeholder {${placeholder}}; ` +
						"use {repository}, {title}, {description}",
				);
			}
		}
		for (const key of Object.keys(raw)) {
			if (key !== "template") {
				throw new ConfigError(`config: task-types.${name}: unknown key "${key}"`);
			}
		}
		out[name] = { template };
	}
	return out;
}

function validateRepos(value: unknown): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new ConfigError('config: repos: must be a table of "owner/name" to checkout path');
	}
	const out: Record<string, string> = {};
	for (const [repository, raw] of Object.entries(value)) {
		if (typeof raw !== "string" || raw === "") {
			throw new ConfigError(`config: repos["${repository}"]: must be a non-empty path`);
		}
		out[repository] = raw;
	}
	return out;
}

/** A setting template must carry the {value} placeholder and nothing else. */
function settingTemplate(template: string, where: string): string {
	const placeholders = placeholderNames(template);
	if (!placeholders.includes("value")) {
		throw new ConfigError(`config: ${where}: template must contain the {value} placeholder`);
	}
	for (const placeholder of placeholders) {
		if (placeholder !== "value") {
			throw new ConfigError(`config: ${where}: unknown placeholder {${placeholder}}`);
		}
	}
	return template;
}

/** The names of the {placeholder} markers in a template. */
function placeholderNames(template: string): string[] {
	const names: string[] = [];
	for (const match of template.matchAll(/\{([a-zA-Z]+)\}/g)) {
		names.push(match[1]);
	}
	return names;
}

function stringField(record: Record<string, unknown>, key: string, where?: string): string {
	const value = record[key];
	if (typeof value !== "string" || value === "") {
		const at = where ? `${where}.${key}` : key;
		throw new ConfigError(`config: ${at}: must be a non-empty string`);
	}
	return value;
}

function optionalStringField(
	record: Record<string, unknown>,
	key: string,
	where: string,
): string | undefined {
	if (!(key in record)) {
		return undefined;
	}
	return stringField(record, key, where);
}

function tableField(value: unknown, key: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ConfigError(`config: ${key}: must be a table`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialize a config back to TOML. Used to write a repository mapping into
 * the config file when a conflicting path yields a sibling clone.
 */
export function configToToml(config: FactoryConfig): string {
	return stringify({
		"default-agent": config.defaultAgent,
		"default-environment": config.defaultEnvironment,
		"default-task-type": config.defaultTaskType,
		agents: Object.fromEntries(
			Object.entries(config.agents).map(([name, agent]) => {
				const block: Record<string, unknown> = { kind: agent.kind };
				if (agent.model !== undefined) {
					block.model = agent.model;
				}
				if (agent.thinking !== undefined) {
					block.thinking = agent.thinking;
				}
				if (agent.thinkingValues !== undefined) {
					block["thinking-values"] = agent.thinkingValues;
				}
				return [name, block];
			}),
		),
		"task-types": Object.fromEntries(
			Object.entries(config.taskTypes).map(([name, task]) => [name, { template: task.template }]),
		),
		repos: config.repos,
	});
}

/**
 * Persist a config to `path`, creating parent directories. The file written
 * is the complete config, so the next start reads exactly what this session
 * used.
 *
 * The write is atomic: the TOML goes to a temp file in the same directory,
 * and the rename over the target is one step. A crash mid-write leaves
 * either the old file or the new one, never a truncated file the next start
 * would reject as invalid TOML.
 */
export function persistConfig(path: string, config: FactoryConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	writeFileSync(temp, configToToml(config), "utf8");
	try {
		renameSync(temp, path);
	} catch (error) {
		// Leave no temp file behind when the rename fails.
		try {
			unlinkSync(temp);
		} catch {
			// The cleanup is best effort; the rename failure is the error.
		}
		throw error;
	}
}
