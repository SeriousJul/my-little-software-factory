/** The strict, startup-only factory configuration. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";

import {
	ConfigMigrationError,
	hasOldWorkflowMachineKeys,
	migrateWorkflowMachineConfig,
} from "./config-migration.ts";
import { isThinkingLevel, type ThinkingLevel, thinkingLevelList } from "./domain/agent.ts";
import { type EnvironmentKind, HANDOFF_ENVIRONMENT_KINDS } from "./domain/ticket.ts";
import { fileExists } from "./fs.ts";
import { firstNonEmptyLine } from "./lines.ts";
import {
	contextSettingFit,
	modelSettingFit,
	type ResolvedAgentType,
	TOKEN_COUNT_RULE,
	thinkingSettingFit,
	tokenCountDigits,
} from "./setting-fit.ts";

export interface AgentTypeConfig {
	kind: string;
	model?: string;
	thinking?: string;
	/** The template that carries a maximum context window to this agent. */
	contextWindow?: string;
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
	/**
	 * The maximum context window, in tokens, its handoffs start on: plain
	 * digits, the same string the Handoff carries. Omitted leaves the room to
	 * the agent, and there is no top-level default for it: one number cannot
	 * fit every model.
	 */
	contextWindow?: string;
	/**
	 * The Transition that hangs off this task type (ADR 0027): the label facts
	 * a completed turn of it writes, and where the ticket goes by judgment.
	 * Omitted: the type completes without a transition.
	 */
	transition?: WorkflowTransition;
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
	/** Optional context window setting passed through the Agent type mapping. */
	contextWindow?: string;
}

/** A semantic key used to leave Agent interaction mode. */
export type InteractionExitKey = string;

/**
 * The match condition of one State (ADR 0027). Every named condition must
 * hold; an omitted condition holds for anything. A State whose match names
 * nothing matches every ticket: a catch-all at the end of the list is a
 * parking state.
 */
export interface StateMatch {
	sourceName?: string;
	sourceKind?: string;
	repository?: string;
	labelsAll?: string[];
	labelsAny?: string[];
	labelsNone?: string[];
}

/**
 * One State of the workflow machine (ADR 0027). A ticket's position is the
 * first State whose match holds on any of its memberships, derived on every
 * refresh and never stored. A State that offers no task is a parking state:
 * the control plane does nothing on it, and an external label write is the
 * only engine that moves the ticket.
 */
export interface WorkflowState {
	name: string;
	match: StateMatch;
	/** The task the State suggests. Omitted: a parking State. */
	taskType?: string;
}

/** The judgments the control plane can branch a Transition on (ADR 0027). */
export const TRANSITION_JUDGMENTS = [
	"score-above-threshold",
	"score-below-threshold",
	"pull-request-open",
	"pull-request-closed",
] as const;
export type TransitionJudgment = (typeof TRANSITION_JUDGMENTS)[number];

/**
 * The Agent and Environment pins a transition or branch carries for the
 * handoff its fire routes: the same override pair the old workflow edges
 * carried (ADR 0027).
 */
export interface TransitionPin {
	agent?: string;
	environment?: EnvironmentKind;
}

/**
 * One branch of a Transition (ADR 0027). A branch carries a judgment and the
 * label facts it writes; the branch's facts replace the transition's for the
 * surface it names, and its pins replace the transition's pins. A branch
 * without a judgment is the fallback: it fires when no judgment branch does.
 */
export interface TransitionBranch {
	when?: TransitionJudgment;
	/** The label facts the ticket wears after this branch fires. */
	ticketFacts?: string[];
	/** The label facts the linked pull request wears after this branch fires. */
	pullRequestFacts?: string[];
	/** Hand off the new position's task without the operator, in any mode. */
	autoAdvance?: boolean;
	agent?: string;
	environment?: EnvironmentKind;
}

/**
 * The Transition that hangs off one task type (ADR 0027). A completed turn of
 * the type fires it once, before the completion decision: it writes the
 * label facts on the ticket and its linked pull request, and the machine
 * re-derives every position from the written labels. It names no destination.
 */
export interface WorkflowTransition {
	/** The label facts the ticket wears after a completed turn. */
	ticketFacts: string[];
	/** The label facts the linked pull request wears after a completed turn. */
	pullRequestFacts: string[];
	/** The review-score threshold the score judgments test against. */
	scoreThreshold?: number;
	branches?: TransitionBranch[];
	/** Hand off the new position's task without the operator, in any mode. */
	autoAdvance?: boolean;
	agent?: string;
	environment?: EnvironmentKind;
}

/**
 * What one Transition fire did, stored on the settled turn's trace (ADR
 * 0027). The decision modal reads the written facts from it, and the
 * automatic decision reads the new position: the task the written labels
 * suggest on the ticket the position sits on.
 */
export interface TransitionOutcome {
	/** Whether a branch fired and the label write ran. */
	fired: boolean;
	/** The judgment that fired; null for a fact-only transition. */
	when: TransitionJudgment | null;
	/** Why the transition did not fire; empty when it did. */
	reason: string;
	/** The effective ticket facts the fire wrote. */
	ticketFacts: string[];
	/** The effective pull request facts the fire wrote. */
	pullRequestFacts: string[];
	autoAdvance: boolean;
	agent?: string;
	environment?: EnvironmentKind;
	/** What the write did on the ticket; null when it wrote nothing. */
	ticketWrite: { added: string[]; removed: string[] } | null;
	/** What the write did on the pull request; null when nothing was written. */
	pullRequestWrite: { added: string[]; removed: string[] } | null;
	/** The linked pull request's identity; null when none was found. */
	pullRequestIdentity: string | null;
	/** The pull request's external key, as the source lists it; null when none. */
	pullRequestKey: string | null;
	/** A label-write failure; empty when every write took. */
	writeFailure: string;
	/** The task the written labels suggest on the new position; null when none. */
	positionTaskType: string | null;
	/** The ticket the new position sits on; null when the position offers no task. */
	positionTicketIdentity: string | null;
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
	/**
	 * The model a handoff starts with when the task profile names none and the
	 * operator overrides none (ADR 0009). Startup checks it through every task
	 * profile that resolves it against the Model list the agent reports
	 * (ADR 0010), and the handoff fit check guards it again there; a resolved
	 * agent that maps no model template fails the handoff with a readable
	 * reason instead of dropping the value.
	 */
	defaultModel?: string;
	defaultEnvironment: EnvironmentKind;
	defaultTaskType: string;
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
	/** The workflow machine's ordered States (ADR 0027). */
	workflowStates: WorkflowState[];
	/** Repository identity to checkout path. */
	repos: Record<string, string>;
	/** No shipped source points at the maintainer repository. */
	sources: TicketSourceConfig[];
	/**
	 * The Priority label list (ADR 0022): the ordered labels that define the
	 * priority ranks, first entry highest. Missing or empty ranks no ticket.
	 */
	priority?: { labels: string[] };
	/** An optional state file. Relative paths use the selected config directory. */
	stateFile?: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * The per-key defaults one optional scroll value takes when the file omits
 * it. They are per-key defaults, not a config: the control plane carries no
 * in-code config object, and the shipped Default configuration is the TOML
 * at config/default.toml.
 */
const DEFAULT_SCROLL: ScrollConfig = { speed: 1, acceleration: 0.8, maximumSpeed: 6 };

export function defaultConfigPath(): string {
	return join(os.homedir(), ".config", "my-little-software-factory", "config.toml");
}

export function defaultStatePath(
	home = os.homedir(),
	xdgStateHome = process.env.XDG_STATE_HOME,
): string {
	return join(
		xdgStateHome || join(home, ".local", "state"),
		"my-little-software-factory",
		"state.sqlite",
	);
}

/** The Default configuration the package ships and a missing file is seeded from. */
export function shippedDefaultConfigPath(): string {
	return fileURLToPath(new URL("../config/default.toml", import.meta.url));
}

/** A loaded config, and whether the load seeded the file. */
export interface LoadedConfig {
	config: FactoryConfig;
	/** The file at the path held config text when the parse ran. */
	fromFile: boolean;
	/** The file was missing: the seam seeded it from the Default configuration. */
	seeded?: boolean;
	/**
	 * The non-blocking config issues the operator must read. The Priority
	 * section reports its problems here, and the factory starts with no
	 * ranking when it names that section.
	 */
	warnings: string[];
	/**
	 * The one-line load note the operator must see: a seeded file, or a
	 * config the load migrated to the workflow machine (ADR 0027).
	 */
	note?: string;
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

/**
 * Load the config at the given path. A missing file is seeded from the
 * Default configuration the package ships, at the path itself, and the
 * seeded file is loaded through the normal parse and validate path, so a
 * seed that would not validate stops the control plane like any bad file.
 * The load reports that it seeded, so the operator sees a note instead of
 * silence.
 *
 * A file that carries the pre-workflow-machine keys is migrated at load
 * (ADR 0027): the rules become states, the expressible edges become
 * transitions, the seed templates are replaced on exact match, and the old
 * file is backed up. The migrated text is validated before the migration
 * writes, and any failure stops the load with the file unchanged.
 */
export async function loadConfigFile(path: string): Promise<LoadedConfig> {
	const seeded = !(await fileExists(path));
	if (seeded) await seedConfigFile(path);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read ${path}: ${String(error)}`);
	}
	let note: string | undefined;
	let data: unknown;
	try {
		data = parse(text);
	} catch (error) {
		throw new ConfigError(`invalid TOML in ${path}: ${readableParseError(error)}`);
	}
	if (hasOldWorkflowMachineKeys(data)) {
		try {
			const shippedText = await readFile(shippedDefaultConfigPath(), "utf8");
			const migration = migrateWorkflowMachineConfig(
				path,
				data as Record<string, unknown>,
				shippedText,
			);
			// The migrated text must validate before the migration writes
			// anything: a broken migration stops the plane with the file
			// unchanged and the reason named.
			validateConfigWithWarnings(parse(migration.configText));
			await writeMigrationFiles(path, text, migration);
			note = `the config at ${path} was migrated to the workflow machine; the pre-migration file is at ${migration.backupFileName} and the report at ${migration.reportFileName}`;
			text = migration.configText;
		} catch (error) {
			if (error instanceof ConfigError || error instanceof ConfigMigrationError) {
				throw new ConfigError(
					`config migration failed for ${path}: ${error instanceof ConfigMigrationError ? error.message : String(error.message)}; the config was not changed`,
				);
			}
			throw error;
		}
	}
	try {
		const { config, warnings } = validateConfigWithWarnings(parse(text));
		return {
			config,
			warnings,
			fromFile: true,
			...(seeded ? { seeded: true } : {}),
			...(note === undefined ? {} : { note }),
		};
	} catch (error) {
		if (error instanceof ConfigError) {
			throw error;
		}
		throw new ConfigError(`invalid TOML in ${path}: ${readableParseError(error)}`);
	}
}

/**
 * The migration's writes: the backup first, the report second, and the new
 * config last, each atomic. The backup lands before the config is touched,
 * so no failure path loses the original.
 */
async function writeMigrationFiles(
	path: string,
	originalText: string,
	migration: { configText: string; reportText: string; backupFileName: string; reportFileName: string },
): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const write = async (name: string, content: string): Promise<void> => {
		const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
		await writeFile(temp, content, { encoding: "utf8", mode: 0o666 });
		try {
			await rename(temp, join(dir, name));
		} catch (error) {
			try {
				await unlink(temp);
			} catch {}
			throw error;
		};
	};
	await write(migration.backupFileName, originalText);
	await write(migration.reportFileName, migration.reportText);
	await write(basename(path), migration.configText);
}

/**
 * Seed a missing Config file from the Default configuration. The text goes
 * over verbatim: the operator's file keeps the template's comments, and the
 * seed write is atomic like every other config write.
 */
async function seedConfigFile(path: string): Promise<void> {
	const source = shippedDefaultConfigPath();
	let text: string;
	try {
		text = await readFile(source, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read the Default configuration at ${source}: ${String(error)}`);
	}
	await mkdir(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	await writeFile(temp, text, { encoding: "utf8", mode: 0o666 });
	try {
		await rename(temp, path);
	} catch (error) {
		try {
			await unlink(temp);
		} catch {}
		throw new ConfigError(`cannot create ${path}: ${String(error)}`);
	}
}

function readableParseError(error: unknown): string {
	const message = String(error);
	return firstNonEmptyLine(message) ?? message.trim();
}

/**
 * The one structural validation for every source of config: the CLI path
 * and the editor both call this, so the two cannot disagree about what is
 * valid.
 *
 * A misconfigured Priority section does not throw: the factory must start
 * with no ranking and report the section, while every other structural
 * failure here blocks startup with the reason.
 */
export function validateConfig(data: unknown): FactoryConfig {
	return validateConfigWithWarnings(data).config;
}

/**
 * The validation with its warnings: the config, plus the non-blocking
 * issues the operator must read, one line each. The CLI startup prints
 * these, and the factory starts with the section they name missing.
 */
export function validateConfigWithWarnings(data: unknown): {
	config: FactoryConfig;
	warnings: string[];
} {
	return parseConfig(data);
}

function parseConfig(data: unknown): { config: FactoryConfig; warnings: string[] } {
	if (!isRecord(data)) {
		throw new ConfigError("config: the top level must be a table of key = value pairs");
	}
	const knownTop = new Set([
		"default-agent",
		"default-model",
		"default-environment",
		"default-task-type",
		"agents",
		"task-types",
		"consultation-types",
		"attention-bell",
		"interaction-exit-key",
		"repos",
		"sources",
		"ticket-sources",
		"states",
		"state-file",
		"auto-handoff",
		"max-parallel-agents",
		"agent-poll-interval-seconds",
		"completion-message-lines",
		"max-handoffs-per-ticket",
		"scroll",
		"priority",
	]);
	for (const key of Object.keys(data)) {
		if (key === "task-rules" || key === "workflows") {
			// The pre-workflow-machine keys (ADR 0027). The load migrates a file
			// that carries them; a file that still does after the migration, or
			// a config validated without going through the load, is a config
			// error that points at the backup the migration left.
			throw new ConfigError(
				`config: "${key}" is a pre-workflow-machine key; the config migrates to "states" and task-type transitions at load (see the .bak backup and the migration report)`,
				);
		}
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
	const workflowStates = validateWorkflowStates(data.states, taskTypes);
	// The Priority section reports its own errors instead of throwing: the
	// factory must start with no ranking, not refuse to boot, when it is
	// misconfigured (ADR 0022).
	const warnings: string[] = [];
	let priority: FactoryConfig["priority"];
	const rawPriority = data.priority;
	if (rawPriority !== undefined) {
		if (!isRecord(rawPriority)) {
			warnings.push(
				`config: [priority] must be a table with a labels list; got ${describeValue(rawPriority)}. The factory starts with no priority ranking`,
			);
		} else {
			const unknownPriorityKeys = Object.keys(rawPriority).filter((key) => key !== "labels");
			if (unknownPriorityKeys.length > 0) {
				warnings.push(
					`config: unknown key${unknownPriorityKeys.length > 1 ? "s" : ""} in [priority]: ${unknownPriorityKeys.join(", ")}. The factory starts with no priority ranking`,
				);
			} else if (!Array.isArray(rawPriority.labels)) {
				warnings.push(
					`config: [priority] labels must be a list of labels; got ${describeValue(rawPriority.labels)}. The factory starts with no priority ranking`,
				);
			} else if (
				rawPriority.labels.some((label) => typeof label !== "string" || label.trim() === "")
			) {
				warnings.push(
					"config: [priority] labels must all be non-empty strings. The factory starts with no priority ranking",
				);
			} else {
				priority = { labels: rawPriority.labels as string[] };
			}
		}
	}
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
	const config: FactoryConfig = {
		defaultAgent,
		...(defaultModel === undefined ? {} : { defaultModel }),
		defaultEnvironment: defaultEnvironment as EnvironmentKind,
		defaultTaskType,
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
		workflowStates,
		repos,
		sources,
		...(priority === undefined ? {} : { priority }),
		...(stateFile === undefined ? {} : { stateFile }),
	};
	return { config, warnings };
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object") return "a table";
	return `a ${typeof value}`;
}

function validateScroll(value: unknown): ScrollConfig {
	if (value === undefined) return { ...DEFAULT_SCROLL };
	if (!isRecord(value)) throw new ConfigError("config: scroll: must be a table");
	const known = new Set(["speed", "acceleration", "maximum-speed"]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new ConfigError(`config: scroll: unknown key "${key}"`);
	}
	const speed = positiveIntField(value, "speed", DEFAULT_SCROLL.speed, "scroll");
	const acceleration = nonNegativeFiniteNumberField(
		value,
		"acceleration",
		DEFAULT_SCROLL.acceleration,
		"scroll",
	);
	const maximumSpeed = positiveIntField(
		value,
		"maximum-speed",
		DEFAULT_SCROLL.maximumSpeed,
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
		const contextWindow = optionalStringField(raw, "context-window", `agents.${name}`);
		if (model !== undefined) agent.model = settingTemplate(model, `agents.${name}.model`);
		if (thinking !== undefined)
			agent.thinking = settingTemplate(thinking, `agents.${name}.thinking`);
		if (contextWindow !== undefined)
			agent.contextWindow = settingTemplate(contextWindow, `agents.${name}.context-window`);
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
			if (!new Set(["kind", "model", "thinking", "thinking-values", "context-window"]).has(key)) {
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
		const profileAgent: ResolvedAgentType = {
			agentType: agent ?? defaultAgent,
			// The named Agent type is checked below when the file names one, and
			// `validateAgents` holds the default to a record the config has.
			agent: agents[agent ?? defaultAgent],
		};
		const model = optionalStringField(raw, "model", where);
		if (model !== undefined) {
			const verdict = modelSettingFit(profileAgent, model);
			if (!verdict.ok) throw new ConfigError(`config: ${where}.model: ${verdict.reason}`);
		}
		const thinking = validateThinkingLevel(
			optionalStringField(raw, "thinking", where),
			profileAgent,
			`${where}.thinking`,
		);
		// The profile's own agent is the one its context window must reach. A
		// transition can reroute the handoff onto another agent later; that
		// pair is caught at handoff time by the same module.
		const contextWindow = tokenCountField(raw, "context-window", where, profileAgent);
		if (raw["auto-close"] !== undefined) {
			// The retired completion flag (ADR 0027): the auto-advance flag on
			// the task type's transition is the replacement.
			throw new ConfigError(
				`config: ${where}: "auto-close" is a pre-workflow-machine key; use auto-advance on ${where}.transition (see the .bak backup and the migration report)`,
			);
		}
		for (const key of Object.keys(raw))
			if (!["template", "agent", "model", "thinking", "context-window", "transition"].includes(key))
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
		const transition = validateTransition(raw.transition, agents, where);
		out[name] = {
			template,
			...(agent === undefined ? {} : { agent }),
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(transition === undefined ? {} : { transition }),
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
	agent: ResolvedAgentType,
	where: string,
): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (!isThinkingLevel(value)) {
		throw new ConfigError(
			`config: ${where}: "${value}" is not a standard thinking level (${thinkingLevelList()})`,
		);
	}
	const verdict = thinkingSettingFit(agent, value);
	if (!verdict.ok) throw new ConfigError(`config: ${where}: ${verdict.reason}`);
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
			if (
				!["agent", "environment", "template", "model", "thinking", "context-window"].includes(key)
			)
				throw new ConfigError(`config: consultation-types.${name}: unknown key "${key}"`);
		const where = `consultation-types.${name}`;
		const agentName = stringField(raw, "agent", where);
		const agentConfig = agents[agentName];
		if (agentConfig === undefined)
			throw new ConfigError(`${where}.agent: unknown agent "${agentName}"`);
		const agent: ResolvedAgentType = { agentType: agentName, agent: agentConfig };
		const environment = stringField(raw, "environment", where);
		if (!(HANDOFF_ENVIRONMENT_KINDS as readonly string[]).includes(environment))
			throw new ConfigError(
				`${where}.environment: must be one of: ${HANDOFF_ENVIRONMENT_KINDS.join(", ")}`,
			);
		const template = stringField(raw, "template", where);
		validateConsultationTemplate(template, `${where}.template`);
		const model = optionalStringField(raw, "model", where);
		if (model !== undefined) {
			const verdict = modelSettingFit(agent, model);
			if (!verdict.ok) throw new ConfigError(`${where}.model: ${verdict.reason}`);
		}
		const thinking = validateThinkingLevel(
			raw.thinking === undefined ? undefined : stringField(raw, "thinking", where),
			agent,
			`${where}.thinking`,
		);
		const contextWindow = tokenCountField(raw, "context-window", where, agent);
		out[name] = {
			agent: agentName,
			environment: environment as EnvironmentKind,
			template,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			...(contextWindow === undefined ? {} : { contextWindow }),
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
	if (normalized === "ctrl+c") {
		// Ctrl+C is the emergency exit the control catalogue owns: an Agent
		// interaction mode that took it would end the app instead of leaving
		// the mode.
		throw new ConfigError(
			"config: interaction-exit-key cannot be ctrl+c; the emergency exit owns that key",
		);
	}
	if (/^ctrl\+[a-z]$/.test(normalized)) return normalized;
	throw new ConfigError(
		"config: interaction-exit-key must be a function key (for example f12) or ctrl plus one letter",
	);
}

/**
 * The ordered States of the workflow machine (ADR 0027). Names are unique,
 * and every task type a State offers must exist.
 */
function validateWorkflowStates(value: unknown, taskTypes: Record<string, TaskTypeConfig>): WorkflowState[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new ConfigError("config: states: must be a list of [[states]] tables");
	const names = new Set<string>();
	return value.map((raw, index) => {
		const where = `states[${index}]`;
		if (!isRecord(raw)) throw new ConfigError(`config: ${where}: must be a table`);
		for (const key of Object.keys(raw))
			if (!new Set(["name", "match", "task-type"]).has(key))
				throw new ConfigError(`config: ${where}: unknown key "${key}"`);
		const name = stringField(raw, "name", where);
		if (names.has(name)) throw new ConfigError(`config: duplicate state name "${name}"`);
		names.add(name);
		if (!isRecord(raw.match))
			throw new ConfigError(`config: ${where}.match: must be a [states.match] table`);
		const match = validateStateMatch(raw.match, where);
		let taskType: string | undefined;
		if (raw["task-type"] !== undefined) {
			taskType = stringField(raw, "task-type", where);
			if (!(taskType in taskTypes))
				throw new ConfigError(`config: ${where}.task-type: unknown task type "${taskType}"`);
		}
		return { name, match, ...(taskType === undefined ? {} : { taskType }) };
	});
}

function validateStateMatch(raw: Record<string, unknown>, where: string): StateMatch {
	for (const key of Object.keys(raw))
		if (
			!["source-name", "source-kind", "repository", "labels-all", "labels-any", "labels-none"].includes(
				key,
			)
		)
			throw new ConfigError(`config: ${where}.match: unknown key "${key}"`);
	const stringCondition = (key: "source-name" | "source-kind" | "repository") =>
		raw[key] === undefined ? undefined : stringField(raw, key, `${where}.match`);
	const labels = (key: "labels-all" | "labels-any" | "labels-none") => {
		const rawLabels = raw[key];
		if (rawLabels === undefined) return undefined;
		if (
			!Array.isArray(rawLabels) ||
			rawLabels.length === 0 ||
			rawLabels.some((label) => typeof label !== "string" || label === "")
		)
			throw new ConfigError(`config: ${where}.match.${key}: must be a non-empty list of strings`);
		return [...rawLabels] as string[];
	};
	return {
		...(stringCondition("source-name") === undefined ? {} : { sourceName: stringCondition("source-name") }),
		...(stringCondition("source-kind") === undefined ? {} : { sourceKind: stringCondition("source-kind") }),
		...(stringCondition("repository") === undefined ? {} : { repository: stringCondition("repository") }),
		...(labels("labels-all") === undefined ? {} : { labelsAll: labels("labels-all") }),
		...(labels("labels-any") === undefined ? {} : { labelsAny: labels("labels-any") }),
		...(labels("labels-none") === undefined ? {} : { labelsNone: labels("labels-none") }),
	};
}

/**
 * The Transition that hangs off one task type (ADR 0027). Facts are lists
 * of workflow label names; a score judgment is only legal with a threshold;
 * an agent pin names an existing agent type; an environment pin names a
 * known environment kind.
 */
function validateTransition(
	value: unknown,
	agents: Record<string, AgentTypeConfig>,
	where: string,
): WorkflowTransition | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new ConfigError(`config: ${where}.transition: must be a table`);
	for (const key of Object.keys(value))
		if (
			![
				"ticket-facts",
				"pull-request-facts",
				"score-threshold",
				"branches",
				"auto-advance",
				"agent",
				"environment",
			].includes(key)
		)
			throw new ConfigError(`config: ${where}.transition: unknown key "${key}"`);
	const facts = (key: "ticket-facts" | "pull-request-facts") => {
		const rawFacts = value[key];
		if (rawFacts === undefined) return [] as string[];
		if (
			!Array.isArray(rawFacts) ||
			rawFacts.some((label) => typeof label !== "string" || label === "")
		)
			throw new ConfigError(`config: ${where}.transition.${key}: must be a list of label names`);
		return [...rawFacts] as string[];
	};
	let scoreThreshold: number | undefined;
	if (value["score-threshold"] !== undefined) {
		const rawThreshold = value["score-threshold"];
		if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold) || rawThreshold < 0 || rawThreshold > 100)
			throw new ConfigError(
				`config: ${where}.transition.score-threshold: must be a number between 0 and 100`,
			);
			scoreThreshold = rawThreshold;
	}
	const autoAdvance =
		value["auto-advance"] === undefined
			? undefined
			: (() => {
				if (typeof value["auto-advance"] !== "boolean")
					throw new ConfigError(`config: ${where}.transition.auto-advance: must be a boolean`);
				return value["auto-advance"] as boolean;
			})();
	let agent: string | undefined;
	if (value.agent !== undefined) {
		agent = stringField(value, "agent", `${where}.transition`);
		if (!(agent in agents))
			throw new ConfigError(`config: ${where}.transition.agent: unknown agent "${agent}"`);
	}
	let environment: EnvironmentKind | undefined;
	if (value.environment !== undefined) {
		const kind = stringField(value, "environment", `${where}.transition`);
		if (!(HANDOFF_ENVIRONMENT_KINDS as readonly string[]).includes(kind)) {
			throw new ConfigError(
				`config: ${where}.transition.environment: must be one of: ${HANDOFF_ENVIRONMENT_KINDS.join(", ")}`,
			);
		}
		environment = kind as EnvironmentKind;
	}
	const branches: TransitionBranch[] | undefined =
		value.branches === undefined
			? undefined
			: (() => {
				if (!Array.isArray(value.branches))
					throw new ConfigError(`config: ${where}.transition.branches: must be a list of tables`);
				return value.branches.map((rawBranch, index) => {
					const branchWhere = `${where}.transition.branches[${index}]`;
					if (!isRecord(rawBranch))
						throw new ConfigError(`config: ${branchWhere}: must be a table`);
					for (const key of Object.keys(rawBranch))
						if (
							![
								"when",
								"ticket-facts",
								"pull-request-facts",
								"auto-advance",
								"agent",
								"environment",
							].includes(key)
						)
							throw new ConfigError(`config: ${branchWhere}: unknown key "${key}"`);
					let when: TransitionJudgment | undefined;
					if (rawBranch.when !== undefined) {
						const judgment = stringField(rawBranch, "when", branchWhere);
						if (!(TRANSITION_JUDGMENTS as readonly string[]).includes(judgment))
							throw new ConfigError(
								`config: ${branchWhere}.when: must be one of: ${TRANSITION_JUDGMENTS.join(", ")}`,
							);
						when = judgment as TransitionJudgment;
					}
					const branchFacts = (key: "ticket-facts" | "pull-request-facts") => {
						const rawFacts = rawBranch[key];
						if (rawFacts === undefined) return undefined;
						if (
							!Array.isArray(rawFacts) ||
							rawFacts.some((label) => typeof label !== "string" || label === "")
						)
							throw new ConfigError(
								`config: ${branchWhere}.${key}: must be a list of label names`,
							);
						return [...rawFacts] as string[];
					};
					const branchAutoAdvance =
						rawBranch["auto-advance"] === undefined
							? undefined
							: (() => {
								if (typeof rawBranch["auto-advance"] !== "boolean")
									throw new ConfigError(`config: ${branchWhere}.auto-advance: must be a boolean`);
								return rawBranch["auto-advance"] as boolean;
							})();
					let branchAgent: string | undefined;
					if (rawBranch.agent !== undefined) {
						branchAgent = stringField(rawBranch, "agent", branchWhere);
						if (!(branchAgent in agents))
							throw new ConfigError(`config: ${branchWhere}.agent: unknown agent "${branchAgent}"`);
					}
					let branchEnvironment: EnvironmentKind | undefined;
					if (rawBranch.environment !== undefined) {
						const kind = stringField(rawBranch, "environment", branchWhere);
						if (!(HANDOFF_ENVIRONMENT_KINDS as readonly string[]).includes(kind)) {
							throw new ConfigError(
								`config: ${branchWhere}.environment: must be one of: ${HANDOFF_ENVIRONMENT_KINDS.join(", ")}`,
							);
						}
						branchEnvironment = kind as EnvironmentKind;
					}
					return {
						...(when === undefined ? {} : { when }),
						...(branchFacts("ticket-facts") === undefined ? {} : { ticketFacts: branchFacts("ticket-facts") }),
						...(branchFacts("pull-request-facts") === undefined
							? {}
							: { pullRequestFacts: branchFacts("pull-request-facts") }),
						...(branchAutoAdvance === undefined ? {} : { autoAdvance: branchAutoAdvance }),
						...(branchAgent === undefined ? {} : { agent: branchAgent }),
						...(branchEnvironment === undefined ? {} : { environment: branchEnvironment }),
					};
				});
			})();
	if (branches !== undefined) {
		const scoreJudgments: TransitionJudgment[] = [
			"score-above-threshold",
			"score-below-threshold",
		];
		if (branches.some((branch) => branch.when !== undefined && scoreJudgments.includes(branch.when))) {
			if (scoreThreshold === undefined) {
				throw new ConfigError(
					`config: ${where}.transition: a score judgment needs score-threshold`,
				);
			}
		}
	}
	return {
		ticketFacts: facts("ticket-facts"),
		pullRequestFacts: facts("pull-request-facts"),
		...(scoreThreshold === undefined ? {} : { scoreThreshold }),
		...(branches === undefined ? {} : { branches }),
		...(autoAdvance === undefined ? {} : { autoAdvance }),
		...(agent === undefined ? {} : { agent }),
		...(environment === undefined ? {} : { environment }),
	};
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

/**
 * A maximum context window: a positive whole token count, written in plain
 * digits. A quoted digit string reads like the bare number, so the config
 * writer's quoting never changes what a file says. There is no suffix
 * parsing and no unit: `200k`, `272 000`, `0`, and a negative all fail.
 */
function tokenCountField(
	record: Record<string, unknown>,
	key: string,
	where: string,
	agent: ResolvedAgentType,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	const digits = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
	// An explicit empty field is not the same as an omitted field in the file.
	// Use the module's count rule for the error while keeping the config field's
	// concise shape error.
	if (digits === "") throw new ConfigError(`config: ${where}.${key}: must be ${TOKEN_COUNT_RULE}`);
	const verdict = contextSettingFit(agent, digits);
	if (!verdict.ok) throw new ConfigError(`config: ${where}.${key}: ${verdict.reason}`);
	// The digits are the value: a file's count keeps one spelling, the same one
	// the panel folds a typed count to.
	return tokenCountDigits(digits);
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
		...(config.defaultModel === undefined ? {} : { "default-model": config.defaultModel }),
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
					...(agent.contextWindow === undefined ? {} : { "context-window": agent.contextWindow }),
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
					...(task.contextWindow === undefined ? {} : { "context-window": task.contextWindow }),
					...(task.transition === undefined
						? {}
						: { transition: transitionToToml(task.transition) }),
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
					...(consultation.contextWindow === undefined
						? {}
						: { "context-window": consultation.contextWindow }),
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
		...(config.priority === undefined ? {} : { priority: { labels: config.priority.labels } }),
		scroll: {
			speed: config.scroll.speed,
			acceleration: config.scroll.acceleration,
			"maximum-speed": config.scroll.maximumSpeed,
		},
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
		states: config.workflowStates.map((state) => ({
			name: state.name,
			...(state.taskType === undefined ? {} : { "task-type": state.taskType }),
			match: stateMatchToToml(state.match),
		})),
	});
}

function stateMatchToToml(match: StateMatch): Record<string, unknown> {
	return {
		...(match.sourceName === undefined ? {} : { "source-name": match.sourceName }),
		...(match.sourceKind === undefined ? {} : { "source-kind": match.sourceKind }),
		...(match.repository === undefined ? {} : { repository: match.repository }),
		...(match.labelsAll === undefined ? {} : { "labels-all": match.labelsAll }),
		...(match.labelsAny === undefined ? {} : { "labels-any": match.labelsAny }),
		...(match.labelsNone === undefined ? {} : { "labels-none": match.labelsNone }),
	};
}

function transitionToToml(transition: WorkflowTransition): Record<string, unknown> {
	return {
		"ticket-facts": transition.ticketFacts,
		"pull-request-facts": transition.pullRequestFacts,
		...(transition.scoreThreshold === undefined
			? {}
			: { "score-threshold": transition.scoreThreshold }),
		...(transition.branches === undefined
			? {}
			: {
					branches: transition.branches.map((branch) => ({
						...(branch.when === undefined ? {} : { when: branch.when }),
						...(branch.ticketFacts === undefined ? {} : { "ticket-facts": branch.ticketFacts }),
						...(branch.pullRequestFacts === undefined
							? {}
							: { "pull-request-facts": branch.pullRequestFacts }),
						...(branch.autoAdvance === undefined ? {} : { "auto-advance": branch.autoAdvance }),
						...(branch.agent === undefined ? {} : { agent: branch.agent }),
						...(branch.environment === undefined ? {} : { environment: branch.environment }),
					})),
				}),
		...(transition.autoAdvance === undefined ? {} : { "auto-advance": transition.autoAdvance }),
		...(transition.agent === undefined ? {} : { agent: transition.agent }),
		...(transition.environment === undefined ? {} : { environment: transition.environment }),
	};
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
