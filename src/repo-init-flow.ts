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
	isPlaneInitSource,
	repositoryInitSettingsHash,
	repositoryInitSources,
	runRepositoryInit,
} from "./repo-init.ts";
import type { CommandOptions, CommandRunner } from "./runner.ts";
import type { FactoryState, RepositoryInitFact } from "./state.ts";
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

/** The command options the source auth resolves to, or the reason it did not. */
type GhOptionsResolution = { ok: true; options: CommandOptions } | { ok: false; reason: string };

/**
 * The command options the repository's source auth resolves to; empty when it
 * names none. The resolution is the source's own, so the act runs with the
 * auth the operator configured for that host. A configured auth that fails to
 * resolve refuses the flow with the reason: ambient auth is the fallback for
 * a source that names no auth, never for an auth the operator configured, so
 * the label pass and the push never run against the wrong account.
 */
async function ghOptionsFor(
	runner: CommandRunner,
	repository: RepositoryInitRepository,
): Promise<GhOptionsResolution> {
	if (repository.auth === undefined) return { ok: true, options: {} };
	const resolved = await new GhAuthenticator(
		repository.host,
		repository.auth,
		runner,
		process.env,
	).resolve();
	if (!resolved.ok)
		return {
			ok: false,
			reason: `the source's auth for ${repository.host} did not resolve: ${resolved.reason}`,
		};
	return { ok: true, options: resolved.options };
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
	// A source the operator named over one of the act's names wins before any
	// external change (ADR 0075, story 15): the init never renames the
	// operator's source, and a collision found only after the act would stand a
	// pushed commit and created labels with no sources and no fact. The check
	// reads the config alone, so it stands before the act issues a single
	// command. A source the plane already registered (name plus kind plus the
	// repository it serves) is no collision: it is the re-init's own standing
	// fact (story 21), and the re-init stands its fact over it without
	// re-registering it.
	const sources = repositoryInitSources(input.repository.displayName, input.repository.host);
	const configured = input.config.sources ?? [];
	for (const source of sources) {
		for (const held of configured) {
			if (held.name === source.name && !isPlaneInitSource(held, source))
				return { ok: false, reason: `a source named ${source.name} is already configured` };
		}
	}

	const ghResolution = await ghOptionsFor(input.runner, input.repository);
	if (ghResolution.ok === false) return { ok: false, reason: ghResolution.reason };
	const outcome = await runRepositoryInit({
		runner: input.runner,
		checkout: input.repository.checkout,
		identity: input.repository.identity,
		displayName: input.repository.displayName,
		host: input.repository.host,
		workflowStates: input.workflowStates,
		taskTypes: input.taskTypes,
		instructionFile: input.plan.instructionFile,
		ghOptions: ghResolution.options,
		worktreePath: input.worktreePath,
	});
	if (outcome.ok === false) return { ok: false, reason: outcome.reason };

	// The fact stands on the settings that generated the labels and the
	// sources, so the drift the plane reports is a change to those settings.
	input.state.setRepositoryInitFact(
		input.repository.identity,
		repositoryInitSettingsHash(input.workflowStates, input.taskTypes),
		outcome.pushedCommit,
	);

	// The sources the plane already registered stand in the config: the re-init
	// re-runs the act and re-writes the fact, but it registers nothing new, so
	// the config the operator's pane shows gains no duplicate row.
	const newSources = sources.filter(
		(source) => !configured.some((held) => isPlaneInitSource(held, source)),
	);
	const labels = outcome.labelsCreated.length;
	const changed = input.plan.fileActions.filter((file) => file.action !== "unchanged").length;
	return {
		ok: true,
		message: `${input.repository.displayName}: pushed ${outcome.pushedCommit} to ${outcome.targetBranch}, created ${labels} label${
			labels === 1 ? "" : "s"
		}, changed ${changed} file${changed === 1 ? "" : "s"}`,
		newSources,
	};
}

/**
 * The standing one repository's init fact stands on against the current
 * settings (ADR 0075): `uninit` where the plane has never init'd it, `drift`
 * where it init'd it under settings that have since changed, and null where the
 * stored fact matches. The plane's Group marker and the one-time note both read
 * it, and pass the hash they hoist so a render computes it once, not per Group.
 */
export function repositoryInitStanding(
	fact: RepositoryInitFact | null,
	currentHash: string,
): "uninit" | "drift" | null {
	if (fact === null) return "uninit";
	return fact.settingsHash !== currentHash ? "drift" : null;
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
	return (
		repositoryInitStanding(
			state.repositoryInitFact(identity),
			repositoryInitSettingsHash(workflowStates, taskTypes),
		) === "drift"
	);
}
