/**
 * The setting resolution chains (ADR 0009): what a handoff starts on before
 * the operator touches the override panel.
 *
 * Each setting resolves on its own chain, and the resolved values are start
 * values the panel prefills. These tests pin the chains and the independence
 * of the rows: an agent that changes never drags the model with it.
 */
import { describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import {
	profileAgentOf,
	resolveEnvironment,
	resolveSettings,
	taskProfileOf,
	taskProfilesOf,
} from "../src/setting-resolution.ts";

/** The shipped config plus one agent and the task types the chains need. */
function configWith(
	over: Partial<FactoryConfig>,
	taskTypes: Record<string, Record<string, unknown>> = {},
): FactoryConfig {
	return {
		...DEFAULT_CONFIG,
		...over,
		taskTypes: Object.fromEntries(
			Object.entries(taskTypes).map(([name, task]) => [
				name,
				{ ...DEFAULT_CONFIG.taskTypes.implement, ...task },
			]),
		),
	};
}

describe("the Task profile of a task type", () => {
	test("a profile that names nothing resolves through the defaults", () => {
		const config = configWith({});
		expect(taskProfileOf(config, "implement")).toEqual({
			agentType: "pi",
			model: "",
			thinking: "",
		});
	});

	test("the profile's own agent, model, and level win", () => {
		const config = configWith(
			{ defaultModel: "anthropic/claude-sonnet-4-5" },
			{ merge: { agent: "codex", model: "openai/gpt-5.1", thinking: "high" } },
		);
		expect(taskProfileOf(config, "merge")).toEqual({
			agentType: "codex",
			model: "openai/gpt-5.1",
			thinking: "high",
		});
		// An omitted profile model resolves through `default-model`, and an
		// omitted profile agent through `default-agent`.
		expect(taskProfileOf(config, "implement")).toEqual({
			agentType: "pi",
			model: "anthropic/claude-sonnet-4-5",
			thinking: "",
		});
	});

	test("an omitted level is left to the agent, never invented", () => {
		const config = configWith({}, { merge: { thinking: "low" } });
		expect(taskProfileOf(config, "merge").thinking).toBe("low");
		expect(taskProfileOf(config, "implement").thinking).toBe("");
	});

	test("every task type gets a profile, keyed by its own name", () => {
		const config = configWith({}, { merge: { model: "openai/gpt-5.1" } });
		expect(Object.keys(taskProfilesOf(config)).sort()).toEqual(
			Object.keys(config.taskTypes).sort(),
		);
		expect(taskProfilesOf(config).merge.model).toBe("openai/gpt-5.1");
	});

	test("the profile agent is the agent a handoff starts on", () => {
		const config = configWith({}, { merge: { agent: "claude" } });
		expect(profileAgentOf(config, "merge")).toBe("claude");
		expect(profileAgentOf(config, "implement")).toBe("pi");
		// An unknown task type has no profile of its own: only the default
		// agent is left to name.
		expect(profileAgentOf(config, "nope")).toBe("pi");
	});
});

describe("resolveSettings", () => {
	test("a workflow edge pin replaces the profile's agent and nothing else", () => {
		const config = configWith(
			{ defaultModel: "anthropic/claude-sonnet-4-5" },
			{ merge: { agent: "codex", thinking: "high" } },
		);
		expect(resolveSettings({ config, taskType: "merge", edgeAgent: "claude" })).toEqual({
			agentType: "claude",
			model: "anthropic/claude-sonnet-4-5",
			thinking: "high",
		});
	});

	test("with no pin the profile resolves whole", () => {
		const config = configWith(
			{},
			{ merge: { agent: "claude", model: "anthropic/x", thinking: "max" } },
		);
		expect(resolveSettings({ config, taskType: "merge" })).toEqual({
			agentType: "claude",
			model: "anthropic/x",
			thinking: "max",
		});
	});

	test("a model the resolved agent maps nothing for stays empty", () => {
		// The default agent has no model setting: `default-model` cannot apply
		// to an agent that maps no model, so the row is hidden and the setting
		// is left to the agent.
		const config = configWith(
			{
				defaultModel: "anthropic/claude-sonnet-4-5",
				agents: { plain: { kind: "plain-cli" } },
			},
			{ merge: { agent: "plain" } },
		);
		expect(taskProfileOf(config, "merge")).toEqual({
			agentType: "plain",
			// The profile names no model, and the default cannot resolve onto an
			// agent that maps none.
			model: "",
			thinking: "",
		});
	});
});

describe("resolveEnvironment", () => {
	test("an edge pin wins, and the config default stands behind it", () => {
		const config = configWith({ defaultEnvironment: "worktree" });
		expect(resolveEnvironment(config, undefined)).toBe("worktree");
		expect(resolveEnvironment(config, "live-worktree")).toBe("live-worktree");
	});
});
