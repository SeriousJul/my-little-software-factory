/**
 * The Setting fit module.
 *
 * This module owns the rule and wording for whether an Agent type can take the
 * Model, Thinking level, and Context window a caller resolved. It has no TUI,
 * durable state, or herdr knowledge. The CommandRunner is the only seam for a
 * Model list query.
 */
import type { AgentTypeConfig } from "./config.ts";
import type { CommandRunner } from "./runner.ts";
import { supportsModelList } from "./runner.ts";

/** The causes shared by every Setting fit verdict. */
export type FitCause = "no-setting" | "no-level" | "no-count" | "not-in-list";

/** One answer for one setting: a pass, or the cause and the one sentence. */
export type FitVerdict = { ok: true } | { ok: false; cause: FitCause; reason: string };

/** The static verdict for every setting covered by the fit rule. */
export interface FitVerdicts {
	model: FitVerdict;
	thinking: FitVerdict;
	contextWindow: FitVerdict;
}

/** The values the control plane wants one Agent type to take. */
export interface SettingValues {
	model: string;
	thinking: string;
	contextWindow: string;
}

/**
 * The Setting fit interface.
 *
 * `staticFit` answers every setting at once, which is what a start and the
 * override panel read. The three halves stand on their own as `modelSettingFit`,
 * `thinkingSettingFit`, and `contextSettingFit`, which is what a per-field config
 * check asks.
 *
 * Every method names the Agent type the caller resolved, because the sentence
 * reads with that config key: two Agent types of one kind can take one value
 * differently, and the operator fixes the key the message names.
 */
export interface SettingFit {
	/** Check templates, declared Thinking levels, and the token count rule. */
	staticFit(agent: AgentTypeConfig, settings: SettingValues, agentType: string): FitVerdicts;
	/** Check a Model against a list the caller already holds. */
	modelInList(
		agent: AgentTypeConfig,
		model: string,
		list: readonly string[],
		agentType: string,
	): FitVerdict;
	/** Check a Model through the CommandRunner. An unavailable list passes. */
	modelFit(
		agentType: string,
		agent: AgentTypeConfig,
		model: string,
		runner: CommandRunner,
	): Promise<FitVerdict>;
}

/** The wording shared by config, Handoff, panel, and Consultation checks. */
export const TOKEN_COUNT_RULE = "a positive whole number of tokens in digits";

/**
 * Whether a string is a safe Context window value.
 *
 * Plain digits are required because the value becomes one argv cell. Zero and
 * values past the safe integer range are not useful counts and cannot be
 * represented without rounding.
 */
export function isTokenCount(value: string): boolean {
	if (!/^[0-9]+$/.test(value)) return false;
	const count = Number(value);
	return Number.isSafeInteger(count) && count > 0;
}

/** Fold a valid count to one spelling. Invalid values stay visible to callers. */
export function tokenCountDigits(value: string): string {
	return isTokenCount(value) ? String(Number(value)) : value;
}

/** The one sentence for a Model the Agent runtime does not report. */
export function unavailableModelMessage(agentType: string, kind: string, model: string): string {
	return `agent "${agentType}" (${kind}) has no model "${model}": check the model id and its provider auth`;
}

/** The one sentence for an Agent type that does not map a setting. */
function noSettingMessage(
	agentType: string,
	setting: "model" | "thinking" | "context",
	value: string,
): string {
	switch (setting) {
		case "model":
			return (
				`agent type "${agentType}" defines no model setting, so model "${value}" cannot reach it: clear ` +
				`the model in the override panel, or start an agent type that maps one`
			);
		case "thinking":
			return (
				`agent type "${agentType}" defines no thinking setting, so thinking level "${value}" cannot ` +
				`reach it: clear the thinking level in the override panel, or start an agent type that maps one`
			);
		case "context":
			return (
				`agent type "${agentType}" defines no context window setting, so the count of ${value} tokens ` +
				`cannot reach it: clear it in the override panel, or start an agent type that maps one`
			);
	}
}

/** The one sentence for a Thinking level outside the Agent type's declared set. */
function noLevelMessage(agentType: string, value: string, supported: readonly string[]): string {
	return (
		`agent type "${agentType}" offers no thinking level "${value}" (it offers: ${supported.join(", ")}): ` +
		`clear the thinking level in the override panel, or start an agent type that offers it`
	);
}

/** The one sentence for a Context value that is not a count. */
function noCountMessage(value: string): string {
	return (
		`context window "${value}" is not ${TOKEN_COUNT_RULE}: clear the context row in the override panel, ` +
		`or type a count such as 272000`
	);
}

const pass = (): FitVerdict => ({ ok: true });

function noSetting(
	agentType: string,
	setting: "model" | "thinking" | "context",
	value: string,
): FitVerdict {
	return { ok: false, cause: "no-setting", reason: noSettingMessage(agentType, setting, value) };
}

/**
 * The Model half of the static rule: an Agent that maps no model setting takes
 * no model, and an empty value is left to the Agent.
 *
 * The config file's field checks and the startup Model check ask one setting, so
 * each half stands on its own. `staticFit` answers all three at once.
 */
export function modelSettingFit(
	agent: AgentTypeConfig,
	model: string,
	agentType: string,
): FitVerdict {
	return model === "" || agent.model !== undefined ? pass() : noSetting(agentType, "model", model);
}

/**
 * The Thinking half of the static rule: an Agent that maps no thinking setting
 * takes no level, and an Agent that lists its levels refuses one it does not
 * offer.
 *
 * Durable state keeps a level as a plain string, so an older record can hold one
 * the standard set no longer names: the check reads the value as a string.
 */
export function thinkingSettingFit(
	agent: AgentTypeConfig,
	level: string,
	agentType: string,
): FitVerdict {
	if (level === "") return pass();
	if (agent.thinking === undefined) return noSetting(agentType, "thinking", level);
	const supported: readonly string[] = agent.thinkingValues ?? [];
	if (supported.includes(level)) return pass();
	return { ok: false, cause: "no-level", reason: noLevelMessage(agentType, level, supported) };
}

/**
 * The Context half of the static rule: a count the control plane cannot spell is
 * refused whatever the Agent maps, so the typed path and the file path hold one
 * rule, and a count the Agent maps no template for cannot reach it.
 */
export function contextSettingFit(
	agent: AgentTypeConfig,
	count: string,
	agentType: string,
): FitVerdict {
	if (count === "") return pass();
	if (!isTokenCount(count)) {
		return { ok: false, cause: "no-count", reason: noCountMessage(count) };
	}
	return agent.contextWindow === undefined ? noSetting(agentType, "context", count) : pass();
}

/** The implementation of the shared interface. */
export const settingFit: SettingFit = {
	staticFit(agent, settings, agentType): FitVerdicts {
		return {
			model: modelSettingFit(agent, settings.model, agentType),
			thinking: thinkingSettingFit(agent, settings.thinking, agentType),
			contextWindow: contextSettingFit(agent, settings.contextWindow, agentType),
		};
	},

	modelInList(agent, model, list, agentType): FitVerdict {
		if (model === "" || agent.model === undefined) {
			return model === "" ? pass() : noSetting(agentType, "model", model);
		}
		if (list.includes(model)) return pass();
		return {
			ok: false,
			cause: "not-in-list",
			reason: unavailableModelMessage(agentType, agent.kind, model),
		};
	},

	async modelFit(agentType, agent, model, runner): Promise<FitVerdict> {
		const staticModel = modelSettingFit(agent, model, agentType);
		if (!staticModel.ok) return staticModel;
		if (model === "" || !supportsModelList(agent.kind)) return pass();
		const list = await runner.listModels(agent.kind);
		if (!list.ok) return pass();
		return settingFit.modelInList(agent, model, list.models, agentType);
	},
};

/** Return the first static failure in the handoff order. */
export function firstFailure(verdicts: FitVerdicts): FitVerdict | undefined {
	return [verdicts.model, verdicts.thinking, verdicts.contextWindow].find((verdict) => !verdict.ok);
}

/**
 * Run the complete Setting fit check in the shared order.
 *
 * Static failures stop before a Model list query. The Model list is the last
 * question, and an unavailable list is deliberately a pass.
 */
export async function fitSettings(
	agentType: string,
	agent: AgentTypeConfig,
	settings: SettingValues,
	runner: CommandRunner,
): Promise<FitVerdict | undefined> {
	const staticVerdicts = settingFit.staticFit(agent, settings, agentType);
	const staticFailure = firstFailure(staticVerdicts);
	if (staticFailure !== undefined) return staticFailure;
	const modelFailure = await settingFit.modelFit(agentType, agent, settings.model, runner);
	return modelFailure.ok ? undefined : modelFailure;
}
