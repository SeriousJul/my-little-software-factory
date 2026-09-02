import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";

import { configToToml, DEFAULT_CONFIG, type FactoryConfig, validateConfig } from "../src/config.ts";
import { resolveHandoffChoice } from "../src/handoff.ts";

const config: FactoryConfig = {
	...DEFAULT_CONFIG,
	defaultAgent: "pi",
	defaultEnvironment: "live-worktree",
	defaultModel: "factory-default",
	taskTypes: {
		...DEFAULT_CONFIG.taskTypes,
		implement: {
			...DEFAULT_CONFIG.taskTypes.implement,
			agent: "codex",
			model: "task-model",
			thinking: "high",
		},
		review: { ...DEFAULT_CONFIG.taskTypes.review, agent: "claude" },
	},
};

describe("task profile configuration", () => {
	const base = () => ({
		"default-agent": "pi",
		"default-environment": "live-worktree",
		"default-task-type": "implement",
		agents: {
			pi: { kind: "pi", "thinking-values": ["low", "high"] },
			codex: { kind: "codex", "thinking-values": ["minimal", "high"] },
		},
		"task-types": { implement: { template: "Implement {title}" } },
	});

	test("keeps the optional profile and default model through TOML", () => {
		const parsed = validateConfig({
			...base(),
			"default-model": "global-model",
			"task-types": {
				implement: {
					template: "Implement {title}",
					agent: "codex",
					model: "task-model",
					thinking: "high",
				},
			},
		});
		expect(parsed.defaultModel).toBe("global-model");
		expect(parsed.taskTypes.implement).toEqual({
			template: "Implement {title}",
			agent: "codex",
			model: "task-model",
			thinking: "high",
			autoClose: false,
		});
		expect(validateConfig(parseToml(configToToml(parsed)))).toEqual(parsed);
	});

	test("rejects an unknown profile agent and a thinking value outside its agent", () => {
		expect(() =>
			validateConfig({
				...base(),
				"task-types": { implement: { template: "x", agent: "missing" } },
			}),
		).toThrow('task-types.implement.agent: unknown agent "missing"');
		expect(() =>
			validateConfig({
				...base(),
				"task-types": {
					implement: { template: "x", agent: "codex", thinking: "low" },
				},
			}),
		).toThrow("task-types.implement.thinking: must be one of: minimal, high");
	});
});

describe("resolveHandoffChoice", () => {
	test("resolves each setting from its own chain", () => {
		expect(resolveHandoffChoice(config, "implement")).toEqual({
			agentType: "codex",
			environment: "live-worktree",
			taskType: "implement",
			model: "task-model",
			thinking: "high",
		});

		expect(
			resolveHandoffChoice(config, "implement", {
				from: "review",
				to: ["implement"],
				agent: "claude",
				environment: "worktree",
			}),
		).toEqual({
			agentType: "claude",
			environment: "worktree",
			taskType: "implement",
			model: "task-model",
			thinking: "high",
		});

		expect(resolveHandoffChoice(config, "review")).toEqual({
			agentType: "claude",
			environment: "live-worktree",
			taskType: "review",
			model: "factory-default",
			thinking: "",
		});

		expect(resolveHandoffChoice(config, "fix")).toEqual({
			agentType: "pi",
			environment: "live-worktree",
			taskType: "fix",
			model: "factory-default",
			thinking: "",
		});
	});
});
