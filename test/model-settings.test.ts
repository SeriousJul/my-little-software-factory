/**
 * The Model list checks (ADR 0010): what the startup validation reports, and
 * what the handoff fit check accepts or refuses.
 *
 * A fake runner holds the lists, so the checks run against a runtime that
 * answers, a runtime that refuses, and a kind that reports no list at all.
 */
import { describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import { checkSettingFit, validateConfiguredModels } from "../src/model-settings.ts";
import type { CommandRunner } from "../src/runner.ts";
import { FakeRunner } from "./fake-runner.ts";

/** A config with one task type and one agent, both named for the reason text. */
function configWith(
	agent: Partial<FactoryConfig["agents"][string]>,
	task: Partial<FactoryConfig["taskTypes"][string]> = {},
	over: Partial<Pick<FactoryConfig, "defaultModel" | "consultationTypes">> = {},
): FactoryConfig {
	return {
		...DEFAULT_CONFIG,
		defaultAgent: "pilot",
		taskTypes: {
			implement: {
				...DEFAULT_CONFIG.taskTypes.implement,
				...task,
			},
		},
		agents: { pilot: { kind: "pi", ...agent } },
		consultationTypes: over.consultationTypes ?? {},
		defaultModel: over.defaultModel,
	};
}

describe("validateConfiguredModels", () => {
	test("a model its agent reports is accepted, and the list is fetched once", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
		const config = configWith({ model: "--model {value}" }, { model: "openai/gpt-5.1" });

		expect(await validateConfiguredModels(config, runner)).toEqual({ errors: [], warnings: [] });
		expect(runner.modelListCalls).toEqual(["pi"]);
	});

	test("a model its agent does not report is an error that names the value", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const config = configWith({ model: "--model {value}" }, { model: "gpt-4o" });

		const check = await validateConfiguredModels(config, runner);
		expect(check.errors).toEqual([
			'config: task-types.implement.model: agent "pilot" (pi) has no model "gpt-4o": check the model id and its provider auth',
		]);
		expect(check.warnings).toEqual([]);
	});

	test("the agent a task profile names is the agent its model has to fit", async () => {
		const runner = new FakeRunner();
		// Both kinds are queried: each agent's own model has to fit its own list.
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const config: FactoryConfig = {
			...configWith({ model: "--model {value}" }, { model: "anthropic/claude-sonnet-4-5" }),
			agents: {
				pilot: { kind: "pi", model: "--model {value}" },
				slow: { kind: "codex", model: "--model {value}" },
			},
			taskTypes: {
				implement: {
					...DEFAULT_CONFIG.taskTypes.implement,
					agent: "slow",
					model: "anthropic/claude-sonnet-4-5",
				},
			},
		};

		const check = await validateConfiguredModels(config, runner);
		// codex reports no list at all: nothing is fetched, so nothing is checked.
		expect(check).toEqual({ errors: [], warnings: [] });
		expect(runner.modelListCalls).toEqual([]);
	});

	test("a consultation model is checked against its own agent", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const config = configWith(
			{ model: "--model {value}" },
			{},
			{
				consultationTypes: {
					grill: {
						agent: "pilot",
						environment: "live-worktree",
						template: "{input}",
						model: "moonshot/kimi-k2",
					},
				},
			},
		);

		const check = await validateConfiguredModels(config, runner);
		expect(check.errors).toEqual([
			'config: consultation-types.grill.model: agent "pilot" (pi) has no model "moonshot/kimi-k2": check the model id and its provider auth',
		]);
	});

	test("an unavailable list warns instead of failing the boot", async () => {
		const runner = new FakeRunner();
		runner.setModelListFailure("pi", "network unreachable");
		const config = configWith({ model: "--model {value}" }, { model: "gpt-4o" });

		const check = await validateConfiguredModels(config, runner);
		expect(check.errors).toEqual([]);
		expect(check.warnings).toEqual([
			'agent kind "pi": its model list is unavailable (network unreachable), so the configured model values were not checked',
		]);
	});

	test("the default model is checked through every profile it lands on", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const config = configWith(
			{ model: "--model {value}" },
			// No task type names a model: each profile resolves the default.
			{},
			{ defaultModel: "gpt-4o" },
		);

		const check = await validateConfiguredModels(config, runner);
		expect(check.errors).toEqual([
			'config: default-model, resolved by task type "implement": agent "pilot" (pi) has no model "gpt-4o": check the model id and its provider auth',
		]);
		// One value on one kind is one query and one report, whatever the
		// number of profiles that resolve it.
		expect(runner.modelListCalls).toEqual(["pi"]);
	});

	test("a profile's own model beats the default it would otherwise resolve", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const config = configWith(
			{ model: "--model {value}" },
			{ model: "anthropic/claude-sonnet-4-5" },
			{ defaultModel: "gpt-4o" },
		);

		expect(await validateConfiguredModels(config, runner)).toEqual({ errors: [], warnings: [] });
	});

	test("a default model that resolves onto an agent that maps no model setting is an error", async () => {
		// The loud rule stands at startup too: a value that cannot reach its
		// resolved agent is a config error, not a value to drop quietly. No
		// list exists to check against, so no query runs either.
		const runner = new FakeRunner();
		runner.setModelList("pi", []);
		const config = configWith({}, {}, { defaultModel: "gpt-4o" });

		expect(await validateConfiguredModels(config, runner)).toEqual({
			errors: [
				'config: default-model, resolved by task type "implement": agent "pilot" defines ' +
					'no model setting, so "gpt-4o" cannot reach it',
			],
			warnings: [],
		});
		expect(runner.modelListCalls).toEqual([]);
	});

	test("a config that names no model runs no query", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

		expect(await validateConfiguredModels(DEFAULT_CONFIG, runner)).toEqual({
			errors: [],
			warnings: [],
		});
		expect(runner.modelListCalls).toEqual([]);
	});
});

describe("checkSettingFit", () => {
	/** One pi agent that maps both settings, as the checks see it. */
	const piAgent = {
		kind: "pi",
		model: "--model {value}",
		thinking: "--thinking {value}",
		thinkingValues: ["minimal", "low"],
	};

	/** The reason one model and thinking pair is unfit on `agent`, or empty when it fits. */
	async function unfitOf(
		agent: Record<string, unknown>,
		{ model = "", thinking = "" }: { model?: string; thinking?: string },
		runner: CommandRunner = new FakeRunner(),
	): Promise<string> {
		const check = await checkSettingFit({
			agentType: "pilot",
			agent: agent as never,
			model,
			thinking,
			runner,
		});
		return check.ok ? "" : check.reason;
	}

	test("an empty setting is left to the agent and always fits", async () => {
		const runner = new FakeRunner();
		expect(await unfitOf(piAgent, {}, runner)).toBe("");
		// A cleared model runs no query.
		expect(runner.modelListCalls).toEqual([]);
	});

	test("a model the agent reports fits, and the list is fresh on every check", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["openai/gpt-4o"]);
		expect(await unfitOf(piAgent, { model: "openai/gpt-4o", thinking: "low" }, runner)).toBe("");
		expect(await unfitOf(piAgent, { model: "openai/gpt-4o" }, runner)).toBe("");
		// No cache: each check queries the runtime again.
		expect(runner.modelListCalls).toEqual(["pi", "pi"]);
	});

	test("a model the agent does not report is refused with its reason", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		expect(await unfitOf(piAgent, { model: "gpt-4o" }, runner)).toBe(
			'agent "pilot" (pi) has no model "gpt-4o": check the model id and its provider auth',
		);
	});

	test("an unfetchable list skips the model check, not the handoff", async () => {
		const runner = new FakeRunner();
		runner.setModelListFailure("pi", "pi is not installed");
		expect(await unfitOf(piAgent, { model: "gpt-4o" }, runner)).toBe("");
	});

	test("a kind that reports no list takes any model, and runs no query", async () => {
		const runner = new FakeRunner();
		const agent = { kind: "codex", model: "--model {value}" };
		expect(await unfitOf(agent, { model: "anything-at-all" }, runner)).toBe("");
		expect(runner.modelListCalls).toEqual([]);
	});

	test("a thinking level the agent does not declare is refused with the levels it supports", async () => {
		expect(await unfitOf(piAgent, { thinking: "xhigh" })).toBe(
			'agent "pilot" does not support the thinking level "xhigh"; it supports: minimal, low',
		);
	});

	test("a thinking level is not checked for an agent that maps no thinking setting", async () => {
		// The start command drops a setting the agent does not map, so the
		// agent never sees the value: it cannot be unfit.
		expect(await unfitOf({ kind: "pi" }, { thinking: "xhigh" })).toBe("");
	});
});
