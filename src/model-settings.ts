/**
 * The Model list checks (ADR 0010).
 *
 * The agent runtime, not the config file, owns the set of models it can run,
 * so the control plane reads that set from the runtime's own CLI and uses it
 * at two boundaries:
 *
 * - Startup: a configured model that its agent does not offer stops the boot
 *   with a readable error, so the operator fixes the config before any
 *   handoff runs. A list that cannot be fetched only warns: one unavailable
 *   agent kind must not block the others.
 * - Handoff: a model or thinking level that does not fit the resolved agent
 *   fails the handoff before its first external change, so the ticket stays
 *   open with a reason instead of dying inside the agent's terminal.
 */
import type { AgentTypeConfig, FactoryConfig } from "./config.ts";
import type { CommandRunner, ModelListResult } from "./runner.ts";
import { supportsModelList } from "./runner.ts";
import { taskProfileOf } from "./setting-resolution.ts";

/** What the startup check found, in readable lines. */
export interface ModelValidation {
	/** A configured model its agent does not offer. The boot stops on these. */
	errors: string[];
	/** A list that could not be fetched, so those values stayed unchecked. */
	warnings: string[];
}

/** One configured model value and the agent it has to fit. */
interface ModelCheck {
	/** The config key the value came from, for the error message. */
	key: string;
	agentType: string;
	kind: string;
	value: string;
}

/**
 * Check every configured model value whose agent is determinate at startup:
 * each Task profile's resolved model and each consultation type's model.
 *
 * A profile's resolved model carries the `default-model` leg of the chain, so
 * a default the operator typo-fixes is seen here, against every agent it can
 * land on. A value with no determinate agent at startup is left to the handoff
 * fit check. A kind with no list command is skipped silently: it never offered
 * a list, so there is nothing to report.
 */
export async function validateConfiguredModels(
	config: FactoryConfig,
	runner: CommandRunner,
): Promise<ModelValidation> {
	const checks = configuredModelChecks(config);
	// One fetch per kind, and only for a kind with a value to check.
	const lists = new Map<string, ModelListResult>();
	for (const check of checks) {
		if (!supportsModelList(check.kind) || lists.has(check.kind)) continue;
		lists.set(check.kind, await runner.listModels(check.kind));
	}
	const errors: string[] = [];
	const warnings: string[] = [];
	const warned = new Set<string>();
	for (const check of checks) {
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
		if (!list.models.includes(check.value)) {
			errors.push(
				`config: ${check.key}: agent "${check.agentType}" (${check.kind}) has no model "${check.value}": check the model id and its provider auth`,
			);
		}
	}
	return { errors, warnings };
}

/** Every model value the config resolves onto a determinate agent. */
function configuredModelChecks(config: FactoryConfig): ModelCheck[] {
	const checks: ModelCheck[] = [];
	const seen = new Set<string>();
	const add = (check: ModelCheck) => {
		// One task type's profile and one consultation type can resolve the same
		// default onto the same agent: report that value once.
		const id = `${check.kind}\u0000${check.value}`;
		if (seen.has(id)) return;
		seen.add(id);
		checks.push(check);
	};
	for (const name of Object.keys(config.taskTypes)) {
		const profile = taskProfileOf(config, name);
		if (profile.model === "") continue;
		const agent = config.agents[profile.agentType];
		if (agent === undefined) continue;
		// Name the key the value came from, and the profile that resolved it:
		// a default model is one value, but every profile can land it on a
		// different agent.
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

/** The outcome of the handoff fit check: a pass, or the reason it fails. */
export type SettingFit = { ok: true } | { ok: false; reason: string };

/**
 * Check one handoff's settings against the resolved agent, before the handoff
 * touches anything outside the control plane.
 *
 * A non-empty model must be in the list the agent's runtime reports, and a
 * non-empty thinking level must be in the levels the agent declares. A setting
 * the agent does not map at all is dropped by the start command, so it is not
 * an unfit setting: the agent never sees it.
 *
 * A list that cannot be fetched skips the model check: the handoff proceeds,
 * and the agent's own rejection stands. There is no cache: the list is fresh
 * here, at startup, and when the override panel opens.
 */
export async function checkSettingFit({
	agentType,
	agent,
	model,
	thinking,
	runner,
}: {
	agentType: string;
	agent: AgentTypeConfig;
	model: string;
	thinking: string;
	runner: CommandRunner;
}): Promise<SettingFit> {
	// Durable state keeps a level a plain string, so an older record can hold
	// a value the set no longer names: the check reads it as a string.
	if (thinking !== "" && agent.thinking !== undefined) {
		const supported: readonly string[] = agent.thinkingValues ?? [];
		if (!supported.includes(thinking)) {
			return {
				ok: false,
				reason: `agent "${agentType}" does not support the thinking level "${thinking}"; it supports: ${supported.join(", ")}`,
			};
		}
	}
	if (model === "" || agent.model === undefined || !supportsModelList(agent.kind)) {
		return { ok: true };
	}
	const list = await runner.listModels(agent.kind);
	if (!list.ok) return { ok: true };
	if (!list.models.includes(model)) {
		return {
			ok: false,
			reason: `agent "${agentType}" (${agent.kind}) has no model "${model}": check the model id and its provider auth`,
		};
	}
	return { ok: true };
}
