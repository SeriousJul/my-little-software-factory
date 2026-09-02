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

	test("keeps the context window of an agent, a task type, and a Consultation type", () => {
		const parsed = validateConfig({
			...base(),
			agents: {
				...base().agents,
				codex: { kind: "codex", "context-window": "-c model_context_window={value}" },
			},
			"task-types": {
				implement: { template: "Implement {title}", agent: "codex", "context-window": 272000 },
			},
			"consultation-types": {
				grill: {
					agent: "codex",
					environment: "worktree",
					template: "/grill {input}",
					"context-window": "65536",
				},
			},
		});
		// The digits are the value: a bare number and a quoted count read the
		// same, and the control plane never reformats either one.
		expect(parsed.taskTypes.implement.contextWindow).toBe("272000");
		expect(parsed.consultationTypes.grill.contextWindow).toBe("65536");
		expect(parsed.agents.codex.contextWindow).toBe("-c model_context_window={value}");
		expect(validateConfig(parseToml(configToToml(parsed)))).toEqual(parsed);
	});

	test("rejects a context value that is not a positive whole token count", () => {
		const agents = {
			...base().agents,
			codex: { kind: "codex", "context-window": "--context {value}" },
		};
		for (const value of ["", "0", "-1", "200k", "272 000", "1.5", "abc", 0, -5, 1.5]) {
			expect(() =>
				validateConfig({
					...base(),
					agents,
					"task-types": {
						implement: { template: "x", agent: "codex", "context-window": value },
					},
				}),
			).toThrow(
				"task-types.implement.context-window: must be a positive whole number of tokens in digits",
			);
		}
	});

	test("rejects a context window its agent does not map", () => {
		// pi maps no context window, so a profile or Consultation that names
		// one is a config error the operator sees at startup.
		expect(() =>
			validateConfig({
				...base(),
				"task-types": { implement: { template: "x", "context-window": 272000 } },
			}),
		).toThrow('task-types.implement.context-window: agent "pi" does not define a');
		expect(() =>
			validateConfig({
				...base(),
				"consultation-types": {
					grill: {
						agent: "pi",
						environment: "worktree",
						template: "/grill {input}",
						"context-window": 272000,
					},
				},
			}),
		).toThrow('consultation-types.grill.context-window: agent "pi" does not define a');
	});

	test("rejects an agent context template that cannot carry a value", () => {
		expect(() =>
			validateConfig({
				...base(),
				agents: { ...base().agents, codex: { kind: "codex", "context-window": "--context" } },
			}),
		).toThrow("agents.codex.context-window: template must contain the {value} placeholder");
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
			contextWindow: "",
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
			contextWindow: "",
		});

		expect(resolveHandoffChoice(config, "review")).toEqual({
			agentType: "claude",
			environment: "live-worktree",
			taskType: "review",
			model: "factory-default",
			thinking: "",
			contextWindow: "",
		});

		expect(resolveHandoffChoice(config, "fix")).toEqual({
			agentType: "pi",
			environment: "live-worktree",
			taskType: "fix",
			model: "factory-default",
			thinking: "",
			contextWindow: "",
		});
	});

	test("takes the context window from the Task profile and from nowhere else", () => {
		// No top-level default context window exists: one number cannot fit
		// every model, so a profile that names none leaves the room to the
		// agent even though the default model resolves.
		const profiled: FactoryConfig = {
			...config,
			agents: {
				...config.agents,
				codex: { ...config.agents.codex, contextWindow: "-c model_context_window={value}" },
			},
			taskTypes: {
				...config.taskTypes,
				implement: { ...config.taskTypes.implement, contextWindow: "272000" },
			},
		};
		expect(resolveHandoffChoice(profiled, "implement").contextWindow).toBe("272000");
		// An edge reroutes the handoff onto another agent; it pins no context
		// window, so the profile's value still resolves and reaches that
		// agent, or fails the handoff there.
		expect(
			resolveHandoffChoice(profiled, "implement", {
				from: "review",
				to: ["implement"],
				agent: "pi",
			}).contextWindow,
		).toBe("272000");
		expect(resolveHandoffChoice(profiled, "review").contextWindow).toBe("");
		expect(resolveHandoffChoice(config, "implement").contextWindow).toBe("");
	});
});
