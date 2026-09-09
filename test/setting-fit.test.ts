/** The public Setting fit seam: one rule and one sentence for each cause. */
import { describe, expect, test } from "vitest";

import type { AgentTypeConfig } from "../src/config.ts";
import {
	contextSettingFit,
	type FitVerdict,
	firstFailure,
	fitSettings,
	isTokenCount,
	modelSettingFit,
	settingFit,
	thinkingSettingFit,
	tokenCountDigits,
} from "../src/setting-fit.ts";
import { FakeRunner } from "./fake-runner.ts";

const AGENT: AgentTypeConfig = {
	kind: "pi",
	model: "--model {value}",
	thinking: "--thinking {value}",
	thinkingValues: ["low", "high"],
	contextWindow: "--context {value}",
};

const FIT = { model: "openai/gpt-5.1", thinking: "low", contextWindow: "131072" };

function reason(verdict: { ok: true } | { ok: false; reason: string }): string {
	return verdict.ok ? "" : verdict.reason;
}

/** The cause a verdict wears, or "" when it takes the value. */
function cause(verdict: FitVerdict): string {
	return verdict.ok ? "" : verdict.cause;
}

describe("Setting fit", () => {
	test("staticFit passes every value the Agent maps and declares", () => {
		expect(settingFit.staticFit(AGENT, FIT, "pilot")).toEqual({
			model: { ok: true },
			thinking: { ok: true },
			contextWindow: { ok: true },
		});
	});

	test("staticFit returns the Model no-setting sentence", () => {
		const verdict = settingFit.staticFit(
			{ kind: "cursor" },
			{ model: "factory-model", thinking: "", contextWindow: "" },
			"cursor",
		).model;
		expect(verdict).toEqual({
			ok: false,
			cause: "no-setting",
			reason:
				'agent type "cursor" defines no model setting, so model "factory-model" cannot reach it: clear the ' +
				"model in the override panel, or start an agent type that maps one",
		});
	});

	test("staticFit returns the Thinking no-setting and no-level sentences", () => {
		expect(
			reason(
				settingFit.staticFit(
					{ kind: "cursor" },
					{ model: "", thinking: "high", contextWindow: "" },
					"cursor",
				).thinking,
			),
		).toBe(
			'agent type "cursor" defines no thinking setting, so thinking level "high" cannot reach it: clear the thinking level in the override panel, or start an agent type that maps one',
		);
		expect(
			reason(
				settingFit.staticFit(
					{ ...AGENT, thinkingValues: ["low"] },
					{ model: "", thinking: "high", contextWindow: "" },
					"pilot",
				).thinking,
			),
		).toBe(
			'agent type "pilot" offers no thinking level "high" (it offers: low): clear the thinking level in the override panel, or start an agent type that offers it',
		);
	});

	test("staticFit returns the Context no-count and no-setting sentences", () => {
		expect(
			settingFit.staticFit({ ...AGENT }, { model: "", thinking: "", contextWindow: "0" }, "pilot")
				.contextWindow,
		).toEqual({
			ok: false,
			cause: "no-count",
			reason:
				'context window "0" is not a positive whole number of tokens in digits: clear the context row ' +
				"in the override panel, or type a count such as 272000",
		});
		expect(
			reason(
				settingFit.staticFit(
					{ kind: "cursor" },
					{ model: "", thinking: "", contextWindow: "131072" },
					"cursor",
				).contextWindow,
			),
		).toBe(
			'agent type "cursor" defines no context window setting, so the count of 131072 tokens cannot reach it: clear it in the override panel, or start an agent type that maps one',
		);
	});

	test("staticFit refuses a level when an Agent maps thinking but declares no level", () => {
		// A stored choice can name a level for an Agent whose config declares no
		// `thinking-values`, so the empty set is what the sentence lists.
		expect(
			reason(
				settingFit.staticFit(
					{ kind: "pi", thinking: "--thinking {value}" },
					{ model: "", thinking: "low", contextWindow: "" },
					"pilot",
				).thinking,
			),
		).toBe(
			'agent type "pilot" offers no thinking level "low" (it offers: ): clear the thinking level in the ' +
				"override panel, or start an agent type that offers it",
		);
	});

	test("the per-field halves answer the one field a config check asks", () => {
		// The config validates one field at a time, so each half stands alone and
		// gives the same verdict and sentence `staticFit` gives for that field.
		const full = settingFit.staticFit(AGENT, FIT, "pilot");
		expect(modelSettingFit(AGENT, FIT.model, "pilot")).toEqual(full.model);
		expect(thinkingSettingFit(AGENT, FIT.thinking, "pilot")).toEqual(full.thinking);
		expect(contextSettingFit(AGENT, FIT.contextWindow, "pilot")).toEqual(full.contextWindow);
		// An empty value is left to the Agent on every half.
		expect(modelSettingFit({ kind: "cursor" }, "", "cursor")).toEqual({ ok: true });
		expect(thinkingSettingFit({ kind: "cursor" }, "", "cursor")).toEqual({ ok: true });
		expect(contextSettingFit({ kind: "cursor" }, "", "cursor")).toEqual({ ok: true });
		expect(cause(thinkingSettingFit({ kind: "cursor" }, "high", "cursor"))).toBe("no-setting");
		expect(cause(contextSettingFit({ kind: "cursor" }, "0", "cursor"))).toBe("no-count");
		expect(cause(modelSettingFit({ kind: "cursor" }, "factory-model", "cursor"))).toBe(
			"no-setting",
		);
	});

	test("firstFailure uses Model, Thinking, then Context order", () => {
		const verdicts = settingFit.staticFit(
			{ kind: "cursor" },
			{ model: "model", thinking: "high", contextWindow: "0" },
			"cursor",
		);
		expect(firstFailure(verdicts)).toEqual(verdicts.model);
		expect(firstFailure({ ...verdicts, model: { ok: true } })).toEqual(verdicts.thinking);
		expect(firstFailure({ ...verdicts, model: { ok: true }, thinking: { ok: true } })).toEqual(
			verdicts.contextWindow,
		);
	});

	test("the Model list verdict accepts, refuses, and skips the expected values", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["openai/gpt-5.1"]);
		expect(settingFit.modelInList(AGENT, "openai/gpt-5.1", ["openai/gpt-5.1"], "pilot")).toEqual({
			ok: true,
		});
		// An empty model is the unset state: no list can hold it, and none is needed.
		expect(settingFit.modelInList(AGENT, "", ["openai/gpt-5.1"], "pilot")).toEqual({ ok: true });
		// An Agent that maps no model setting takes no model, list or not: the
		// verdict is the same sentence the static rule gives.
		expect(
			settingFit.modelInList({ kind: "cursor" }, "factory-model", ["factory-model"], "cursor"),
		).toEqual({
			ok: false,
			cause: "no-setting",
			reason:
				'agent type "cursor" defines no model setting, so model "factory-model" cannot reach it: ' +
				"clear the model in the override panel, or start an agent type that maps one",
		});
		expect(settingFit.modelInList(AGENT, "missing/model", ["openai/gpt-5.1"], "pilot")).toEqual({
			ok: false,
			cause: "not-in-list",
			reason:
				'agent "pilot" (pi) has no model "missing/model": check the model id and its provider auth',
		});
		expect(await settingFit.modelFit("pilot", AGENT, "missing/model", runner)).toEqual({
			ok: false,
			cause: "not-in-list",
			reason:
				'agent "pilot" (pi) has no model "missing/model": check the model id and its provider auth',
		});
		// The static half stops the query: a model its Agent cannot map never
		// reaches the runtime.
		expect(
			await settingFit.modelFit("cursor", { kind: "cursor" }, "factory-model", runner),
		).toEqual({
			ok: false,
			cause: "no-setting",
			reason:
				'agent type "cursor" defines no model setting, so model "factory-model" cannot reach it: ' +
				"clear the model in the override panel, or start an agent type that maps one",
		});
		expect(await settingFit.modelFit("pilot", AGENT, "anything", new FakeRunner())).toEqual({
			ok: true,
		});
		expect(
			await settingFit.modelFit(
				"pilot",
				{ kind: "codex", model: "--model {value}" },
				"anything",
				runner,
			),
		).toEqual({
			ok: true,
		});
	});

	test("the complete fit checks static failures before the Model list", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["openai/gpt-5.1"]);
		const failure = await fitSettings(
			"pilot",
			AGENT,
			{ model: "missing/model", thinking: "ultra", contextWindow: "0" },
			runner,
		);
		expect(failure !== undefined && !failure.ok ? failure.cause : undefined).toBe("no-level");
		expect(runner.modelListCalls).toEqual([]);
	});

	test("the complete fit checks the Model list last and an unavailable list passes", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["openai/gpt-5.1"]);
		expect(await fitSettings("pilot", AGENT, FIT, runner)).toEqual(undefined);
		expect(runner.modelListCalls).toEqual(["pi"]);
		runner.setModelListFailure("pi", "not installed");
		expect(await fitSettings("pilot", AGENT, { ...FIT, model: "missing/model" }, runner)).toEqual(
			undefined,
		);
	});

	test("Context counts accept positive digits and fold leading zeroes", () => {
		for (const value of ["1", "007", "9007199254740991"]) expect(isTokenCount(value)).toBe(true);
		for (const value of ["", "0", "000", "-1", "200k", "9007199254740992"]) {
			expect(isTokenCount(value)).toBe(false);
		}
		// Plain digits only: `Number` reads a sign and surrounding spaces as a
		// count, and a value with either could never reach an Agent as one argument.
		for (const value of [" 131072", "131072 ", "+131072", "12\n"]) {
			expect(isTokenCount(value)).toBe(false);
		}
		expect(tokenCountDigits("007")).toBe("7");
		expect(tokenCountDigits("0")).toBe("0");
	});
});
