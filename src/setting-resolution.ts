/**
 * The handoff setting resolution chains (ADR 0009).
 *
 * Every setting resolves on its own chain, and the closer a decision is to
 * the handoff in front of the operator, the more weight it gets:
 *
 * - Agent: operator override, workflow edge pin, task profile, `default-agent`.
 * - Model: operator override, task profile, `default-model`, the agent's own default.
 * - Thinking: operator override, task profile, the agent's own default.
 *
 * Every resolved value is a start value: the override panel prefills it, the
 * operator changes it or clears it, and a cleared setting (an empty value) is
 * left to the agent. A model that does not fit the resolved agent is not
 * dropped here: the handoff fit check fails the handoff with a readable
 * reason, so the config error stays visible.
 */
import type { FactoryConfig } from "./config.ts";
import type { EnvironmentKind } from "./domain/ticket.ts";

/** The agent, model, and thinking one task type starts its handoffs on. */
export interface TaskProfileStart {
	agentType: string;
	/** The model, or empty when the setting is left to the agent. */
	model: string;
	/** The thinking level, or empty when the level is left to the agent. */
	thinking: string;
}

/** The agent a task profile names, or the default agent when it names none. */
export function profileAgentOf(config: FactoryConfig, taskType: string): string {
	return config.taskTypes[taskType]?.agent ?? config.defaultAgent;
}

/**
 * The Task profile of one task type: the start values the panel prefills and
 * a handoff without an operator override runs on. An omitted profile agent
 * resolves through `default-agent`, an omitted profile model through
 * `default-model`, and an omitted level is left to the agent.
 */
export function taskProfileOf(config: FactoryConfig, taskType: string): TaskProfileStart {
	const task = config.taskTypes[taskType];
	const agentType = profileAgentOf(config, taskType);
	// `default-model` reaches an agent that maps the setting, and nothing else:
	// a value the resolved agent cannot receive is not a start value, and the
	// panel would hide a row it had filled in.
	const mapsModel = config.agents[agentType]?.model !== undefined;
	return {
		agentType,
		model: mapsModel ? (task?.model ?? config.defaultModel ?? "") : "",
		thinking: task?.thinking ?? "",
	};
}

/** The Task profile of every configured task type, keyed by its name. */
export function taskProfilesOf(config: FactoryConfig): Record<string, TaskProfileStart> {
	return Object.fromEntries(
		Object.keys(config.taskTypes).map((taskType) => [taskType, taskProfileOf(config, taskType)]),
	);
}

/** The settings the operator chose in the override panel replace these. */
export interface SettingRequest {
	config: FactoryConfig;
	taskType: string;
	/** The agent a workflow edge pins for this one handoff. */
	edgeAgent?: string;
}

/**
 * Resolve one handoff's agent, model, and thinking through their chains.
 *
 * A workflow handoff carries the edge's pin; an open-ticket handoff and an
 * auto-handoff carry none. The head of every chain, the operator override,
 * needs no argument here: a confirmed panel hands back a complete choice, and
 * that choice replaces this result as it stands, cleared rows included.
 */
export function resolveSettings({ config, taskType, edgeAgent }: SettingRequest): TaskProfileStart {
	const profile = taskProfileOf(config, taskType);
	return {
		agentType: edgeAgent ?? profile.agentType,
		// A cleared model is a decision, not an absent one: an operator who
		// cleared the row left the setting to the agent, and the handoff runs
		// on the empty value the panel returns.
		model: profile.model,
		thinking: profile.thinking,
	};
}

/** The environment one handoff starts on: an edge pin, then the default. */
export function resolveEnvironment(
	config: FactoryConfig,
	pinned: EnvironmentKind | undefined,
): EnvironmentKind {
	return pinned ?? config.defaultEnvironment;
}
