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
import { modelSettingFit, settingFit } from "./setting-fit.ts";
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
	agentType: string;
	kind: string;
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
		const agent = config.agents[check.agentType];
		if (agent === undefined || agent.model === undefined) continue;
		if (!supportsModelList(check.kind) || lists.has(check.kind)) continue;
		lists.set(check.kind, await runner.listModels(check.kind));
	}

	const errors: string[] = [];
	const warnings: string[] = [];
	const warned = new Set<string>();
	for (const check of checks) {
		// Every check names an Agent the config holds: configuredModelChecks
		// reads the same record to build it.
		const agent = config.agents[check.agentType];
		const staticVerdict = modelSettingFit(agent, check.value, check.agentType);
		if (!staticVerdict.ok) {
			errors.push(`config: ${check.key}: ${staticVerdict.reason}`);
			continue;
		}

		const list = lists.get(check.kind);
		if (list === undefined) continue;
		if (!list.ok) {
			if (!warned.has(check.kind)) {
				warned.add(check.kind);
				warnings.push(
					`agent kind "${check.kind}": its model list is unavailable (${list.reason}), so the configured model values were not checked`,
				);
			}
			continue;
		}
		const verdict = settingFit.modelInList(agent, check.value, list.models, check.agentType);
		if (!verdict.ok) errors.push(`config: ${check.key}: ${verdict.reason}`);
	}
	return { errors, warnings };
}

/** Every Model value the config resolves onto a determinate Agent type. */
function configuredModelChecks(config: FactoryConfig): ModelCheck[] {
	const checks: ModelCheck[] = [];
	const seen = new Set<string>();
	const add = (check: ModelCheck) => {
		// One Task profile and one Consultation type can resolve the same value
		// onto the same Agent type. Report that value once.
		const id = `${check.agentType}\u0000${check.value}`;
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
			agentType: profile.agentType,
			kind: agent.kind,
			value: profile.model,
		});
	}
	for (const [name, consultation] of Object.entries(config.consultationTypes)) {
		if (consultation.model === undefined) continue;
		const agent = config.agents[consultation.agent];
		if (agent === undefined) continue;
		add({
			key: `consultation-types.${name}.model`,
			agentType: consultation.agent,
			kind: agent.kind,
			value: consultation.model,
		});
	}
	return checks;
}
