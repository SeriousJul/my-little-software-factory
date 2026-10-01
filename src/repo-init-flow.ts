/**
 * The repository init's commit flow (ADR 0075): the one path the plane takes
 * from a confirmed plan to a factory-ready repository.
 *
 * The generator ([repo-init.ts](repo-init.ts)) is the pure source of every
 * byte the act changes. This module is the sequence around that act: it runs
 * the act through the command runner, registers the init's sources in the
 * config they must join, and writes the init fact on the state file so the
 * drift and the re-init the plane reports against the operator's settings
 * stand on a record. It owns the failure words too: a checkout that cannot be
 * read, a label the source will not list, a push the source will not take, and
 * a source name the operator already names.
 *
 * The act runs on a throwaway worktree; the flow's git egress is the command
 * runner, the same single egress the act uses, so the unit tests drive the
 * whole commit with the fake runner and never a live git.
 */

import type {
	FactoryConfig,
	GitHubAuthentication,
	TaskTypeConfig,
	TicketSourceConfig,
	WorkflowState,
} from "./config.ts";
import type { InstructionFileName } from "./repo-init.ts";
import {
	repositoryInitSettingsHash,
	repositoryInitSources,
	runRepositoryInit,
} from "./repo-init.ts";
import type { CommandOptions, CommandRunner } from "./runner.ts";
import type { FactoryState } from "./state.ts";
import { GhAuthenticator } from "./ticket-source.ts";

/**
 * The repository the init commits for, as the plane holds it: the host and
 * the clone URL the sources name, the identity `gh --repo` takes, the display
 * name the sources and the fact name, and the checkout the act works in.
 */
export interface RepositoryInitRepository {
	identity: string;
	displayName: string;
	host: string;
	auth?: GitHubAuthentication;
	cloneUrl: string;
	checkout: string;
}

/** The confirmed plan the operator saw, for the words the result reports. */
export interface RepositoryInitFlowPlan {
	instructionFile: InstructionFileName;
	labelsToCreate: readonly string[];
	fileActions: readonly { path: string; action: string }[];
}

/** Everything the commit needs besides the runner and the state. */
export interface RepositoryInitFlowInput {
	runner: CommandRunner;
	state: FactoryState;
	/** The config the init registers its sources against. */
	config: FactoryConfig;
	repository: RepositoryInitRepository;
	workflowStates: readonly WorkflowState[];
	taskTypes: Record<string, TaskTypeConfig>;
	plan: RepositoryInitFlowPlan;
	/**
	 * The throwaway worktree's path. When the plane names none, the act takes a
	 * fresh directory in the temp area; the test names one it can stand its
	 * fake `rev-parse` on.
	 */
	worktreePath?: string;
}

/**
 * The one answer the commit gives: a message the operator reads, and the
 * sources it registered, which the caller adds to the config and persists.
 * The sources come back to the caller rather than persisted here so the
 * config the UI holds stays the one the operator's pane shows.
 */
export type RepositoryInitFlowResult =
	| { ok: true; message: string; newSources: readonly TicketSourceConfig[] }
	| { ok: false; reason: string };

/**
 * The command options the repository's source auth resolves to; empty when it
 * names none. The resolution is the source's own, so the act runs with the
 * auth the operator configured for that host.
 */
async function ghOptionsFor(
	runner: CommandRunner,
	repository: RepositoryInitRepository,
): Promise<CommandOptions> {
	if (repository.auth === undefined) return {};
	const resolved = await new GhAuthenticator(
		repository.host,
		repository.auth,
		runner,
		process.env,
	).resolve();
	if (!resolved.ok) return {};
	return resolved.options;
}

/**
 * Commits the confirmed init for one repository: runs the act, registers the
 * sources, and writes the init fact. A failure anywhere stops the commit and
 * answers with its reason; nothing the act already pushed is rolled back, so
 * a failure after the push still leaves the repository ready and the sources
 * and the fact stand on their own answers.
 */
export async function commitRepositoryInit(
	input: RepositoryInitFlowInput,
): Promise<RepositoryInitFlowResult> {
	const ghOptions = await ghOptionsFor(input.runner, input.repository);
	const outcome = await runRepositoryInit({
		runner: input.runner,
		checkout: input.repository.checkout,
		identity: input.repository.identity,
		displayName: input.repository.displayName,
		host: input.repository.host,
		workflowStates: input.workflowStates,
		taskTypes: input.taskTypes,
		instructionFile: input.plan.instructionFile,
		ghOptions,
		worktreePath: input.worktreePath,
	});
	if (outcome.ok === false) return { ok: false, reason: outcome.reason };

	const sources = repositoryInitSources(input.repository.displayName, input.repository.host);
	// A source name the operator already names wins: the init does not rename
	// the operator's source, and the collision stands as the reason.
	const existingNames = new Set((input.config.sources ?? []).map((source) => source.name));
	for (const source of sources) {
		if (existingNames.has(source.name)) {
			return {
				ok: false,
				reason: `a source named ${source.name} is already configured`,
			};
		}
	}

	// The fact stands on the settings that generated the labels and the
	// sources, so the drift the plane reports is a change to those settings.
	input.state.setRepositoryInitFact(
		input.repository.identity,
		repositoryInitSettingsHash(input.workflowStates, input.taskTypes),
		outcome.pushedCommit,
	);

	const labels = outcome.labelsCreated.length;
	const changed = input.plan.fileActions.filter((file) => file.action !== "unchanged").length;
	return {
		ok: true,
		message: `${input.repository.displayName}: pushed ${outcome.pushedCommit} to ${outcome.targetBranch}, created ${labels} label${
			labels === 1 ? "" : "s"
		}, changed ${changed} file${changed === 1 ? "" : "s"}`,
		newSources: sources,
	};
}

/**
 * Whether the operator's current settings drifted from the fact recorded when
 * the repository was init'd, so the plane can name it for a re-init. A missing
 * fact is not drift: the repository has never been init'd.
 */
export function repositoryInitDrifted(
	state: FactoryState,
	identity: string,
	workflowStates: readonly WorkflowState[],
	taskTypes: Record<string, TaskTypeConfig>,
): boolean {
	const fact = state.repositoryInitFact(identity);
	if (fact === null) return false;
	return fact.settingsHash !== repositoryInitSettingsHash(workflowStates, taskTypes);
}
