/**
 * Startup orchestration for the Model list (ADR 0010).
 *
 * The Setting fit module owns the per-setting rule and wording. This module
 * keeps only the startup concerns: which configured values are determinate,
 * one list query per Agent kind, and one warning for an unavailable list.
 */
import type { FactoryConfig } from "./config.ts";
import type { CommandRunner, ModelListResult } from "./runner.ts";
import { supportsModelList } from "./runner.ts";
import { modelSettingFit, type ResolvedAgentType, settingFit } from "./setting-fit.ts";
import { taskProfileOf } from "./setting-resolution.ts";

/** What startup found, in readable lines. */
export interface ModelValidation {
	/** A configured setting that cannot fit. Boot stops on these. */
	errors: string[];
	/** A list that could not be fetched, so those values stayed unchecked. */
	warnings: string[];
}

/** One configured Model value and the Agent type it has to fit. */
interface ModelCheck {
	/** The config key the value came from, for the error message. */
	key: string;
	/** The Agent type the value has to reach, with the key that names it. */
	agent: ResolvedAgentType;
	value: string;
}

/**
 * Check every configured Model value whose Agent type is determinate at
 * startup. Static fit is checked first. Available Model lists are then shared
 * by kind so startup asks each runtime only once.
 */
export async function validateConfiguredModels(
	config: FactoryConfig,
	runner: CommandRunner,
): Promise<ModelValidation> {
	const checks = configuredModelChecks(config);
	const lists = new Map<string, ModelListResult>();
	for (const check of checks) {
		const agent = check.agent.agent;
		if (agent.model === undefined) continue;
		if (!supportsModelList(agent.kind) || lists.has(agent.kind)) continue;
		lists.set(agent.kind, await runner.listModels(agent.kind));
	}

	const errors: string[] = [];
	const warnings: string[] = [];
	const warned = new Set<string>();
	for (const check of checks) {
		const kind = check.agent.agent.kind;
		validateModelCheck(check, lists.get(kind), { kind, errors, warnings, warned });
	}
	return { errors, warnings };
}

/** The verdicts one configured Model value earns: its static fit, then its list fit. */
function validateModelCheck(
	check: ModelCheck,
	list: ModelListResult | undefined,
	outcome: { kind: string; errors: string[]; warnings: string[]; warned: Set<string> },
): void {
	const staticVerdict = modelSettingFit(check.agent, check.value);
	if (!staticVerdict.ok) {
		outcome.errors.push(`config: ${check.key}: ${staticVerdict.reason}`);
		return;
	}
	if (list === undefined) return;
	if (!list.ok) {
		if (!outcome.warned.has(outcome.kind)) {
			outcome.warned.add(outcome.kind);
			outcome.warnings.push(
				`agent kind "${outcome.kind}": its model list is unavailable (${list.reason}), so the configured model values were not checked`,
			);
		}
		return;
	}
	const verdict = settingFit.modelInList(check.agent, check.value, list.models);
	if (!verdict.ok) outcome.errors.push(`config: ${check.key}: ${verdict.reason}`);
}

/** Every Model value the config resolves onto a determinate Agent type. */
function configuredModelChecks(config: FactoryConfig): ModelCheck[] {
	const checks: ModelCheck[] = [];
	const seen = new Set<string>();
	const add = (check: ModelCheck) => {
		// One Task profile and one Consultation type can resolve the same value
		// onto the same Agent type. Report that value once.
		const id = `${check.agent.agentType}\u0000${check.value}`;
		if (seen.has(id)) return;
		seen.add(id);
		checks.push(check);
	};
	for (const name of Object.keys(config.taskTypes)) {
		const profile = taskProfileOf(config, name);
		if (profile.model === "") continue;
		const agent = config.agents[profile.agentType];
		if (agent === undefined) continue;
		const source =
			config.taskTypes[name]?.model === undefined
				? `default-model, resolved by task type "${name}"`
				: `task-types.${name}.model`;
		add({
			key: source,
			agent: { agentType: profile.agentType, agent },
			value: profile.model,
		});
	}
	for (const [name, consultation] of Object.entries(config.consultationTypes)) {
		if (consultation.model === undefined) continue;
		const agent = config.agents[consultation.agent];
		if (agent === undefined) continue;
		add({
			key: `consultation-types.${name}.model`,
			agent: { agentType: consultation.agent, agent },
			value: consultation.model,
		});
	}
	return checks;
}
