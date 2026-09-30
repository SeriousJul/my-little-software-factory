/**
 * The plane actions (ADR 0068): the tasks the machine resolves with no
 * agent, no worktree, and no seat from the Parallel limit.
 *
 * A task type in the action form names one built-in action from this
 * registry and carries its named settings. The registry is the one home of
 * the names the config may name and the methods they accept: the config
 * validation names them here, the dispatch that runs the action reads them
 * here, and the surfaces that name the action read them here, so none of
 * the three can drift. The action form has no template and no profile keys:
 * its settings are the named ones from this registry, never a free string.
 * The merge runs as a control-plane action through the command runner -
 * the `gh` merge, with a comment on a blocked pull request - and its
 * outcome fires the task type's transition, the fact on the attempt's
 * record, because no Completion trace stands for it.
 */

import type { TaskTypeConfig, TicketSourceConfig } from "./config.ts";
import { externalKeyNumber, type Ticket } from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./runner.ts";
import { GhAuthenticator } from "./ticket-source.ts";
import { newestMembershipOf, readPullRequestOpenRecord } from "./workflow.ts";

/** The built-in plane actions, by the name the config's action form may use. */
export const PLANE_ACTION_NAMES = ["merge-pull-request"] as const;
export type PlaneActionName = (typeof PLANE_ACTION_NAMES)[number];

/** The merge methods the merge action runs with, by their config name. */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The method a merge action runs with when its settings name none. */
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash";

/**
 * The named settings of the one plane action: the merge of the ticket's
 * pull request, with the method it runs with. A task type in the action
 * form carries the name in its `action` cell and the method in its
 * `method` cell, and this is the one place that reads the pair back as a
 * setting: an omitted method resolves to the registry's default.
 */
export interface PlaneActionSetting {
	readonly name: PlaneActionName;
	readonly method: MergeMethod;
}

/** Whether the value names a built-in plane action. */
export function isPlaneActionName(value: unknown): value is PlaneActionName {
	return (PLANE_ACTION_NAMES as readonly string[]).includes(value as string);
}

/** Whether the value names a merge method. */
export function isMergeMethod(value: unknown): value is MergeMethod {
	return (MERGE_METHODS as readonly string[]).includes(value as string);
}

/**
 * The plane action of one task type, from its action form; null when the
 * type carries no action form or names an action the registry does not
 * hold. The config validation holds the form to the registry's names, so a
 * caller that reads a validated config gets the settings it runs.
 */
export function planeActionSettingOf(
	taskTypes: Record<string, TaskTypeConfig>,
	taskType: string,
): PlaneActionSetting | null {
	const task = taskTypes[taskType];
	const name = task?.action;
	if (name === undefined || !isPlaneActionName(name)) return null;
	return { name, method: task.method ?? DEFAULT_MERGE_METHOD };
}

/** Whether the task type carries the plane action form. */
export function isPlaneActionTaskType(
	taskTypes: Record<string, TaskTypeConfig>,
	taskType: string,
): boolean {
	return planeActionSettingOf(taskTypes, taskType) !== null;
}

/** The `gh pr merge` flag of one merge method. */
export function mergeFlag(method: MergeMethod): string {
	return `--${method}`;
}

/**
 * The merge of one pull request as a control-plane action (ADR 0068).
 *
 * The run takes the pull request the caller resolved - the action's ticket
 * or its fixing pull request - and the method its task type names. It reads
 * the pull request fresh from the source before it runs, the way the
 * transition fire reads it: a pull request the fresh read finds already
 * merged settles as merged without running a command, and the merge's own
 * answer decides the rest. A merge the source refuses is the blocked
 * outcome with the source's reason, and the block's comment posts on the
 * pull request before the outcome is answered: a comment that cannot post
 * does not move the outcome, the block stands with the source's reason.
 */
export interface MergeRun {
	runner: CommandRunner;
	/** The configured sources; the pull request's source supplies the host and the auth. */
	sources: readonly TicketSourceConfig[];
	/** The pull request the merge runs on. */
	pullRequest: Ticket;
	/** The method the task type's action names. */
	method: MergeMethod;
}

/** The one answer the merge run gives: the outcome, the reason, and the idempotency fact. */
export type MergeRunResult =
	| { outcome: "merged"; reason: ""; alreadyMerged: boolean }
	| { outcome: "blocked"; reason: string; alreadyMerged: false };

/** The comment a blocked merge posts on the pull request. */
export function blockedMergeComment(reason: string): string {
	return `The factory's merge was blocked: ${reason}`;
}

/** The source the membership lists on, by its name. */
function sourceOf(
	sources: readonly TicketSourceConfig[],
	sourceName: string,
): TicketSourceConfig | undefined {
	return sources.find((item) => item.name === sourceName);
}

/** The command options the source's auth resolves to; empty when it names none. */
async function ghOptionsFor(
	runner: CommandRunner,
	source: TicketSourceConfig | undefined,
): Promise<CommandOptions> {
	if (source?.auth === undefined) return {};
	const resolved = await new GhAuthenticator(
		source.host,
		source.auth,
		runner,
		process.env,
	).resolve();
	if (!resolved.ok) return {};
	return resolved.options;
}

export async function runMergePullRequest(run: MergeRun): Promise<MergeRunResult> {
	const membership = newestMembershipOf(run.pullRequest);
	const source = sourceOf(run.sources, membership.sourceName);
	if (source === undefined)
		return {
			outcome: "blocked",
			reason: "the pull request's source is not configured",
			alreadyMerged: false,
		};
	// The fresh read: the pull request's own record, live the moment a merge
	// lands. A read that finds the pull request already merged settles it as
	// merged without running a command, and a read that fails runs the merge
	// anyway: the source's own answer to the merge is the outcome.
	const fresh = await readPullRequestOpenRecord(run.runner, run.sources, run.pullRequest);
	if (fresh?.merged === true) return { outcome: "merged", reason: "", alreadyMerged: true };
	const ghOptions = await ghOptionsFor(run.runner, source);
	const args = [
		"pr",
		"merge",
		membership.externalKey,
		mergeFlag(run.method),
		"--hostname",
		source.host,
		"--repo",
		membership.repository.displayName,
	];
	let result: CommandResult;
	try {
		result = await run.runner.run("gh", args, ghOptions);
	} catch (error) {
		const reason =
			firstNonEmptyLine(String(error)) ?? `gh pr merge ${membership.externalKey} could not be run`;
		await postBlockedComment(run, reason);
		return { outcome: "blocked", reason, alreadyMerged: false };
	}
	if (result.code === 0) return { outcome: "merged", reason: "", alreadyMerged: false };
	const reason = firstNonEmptyLine(result.stderr ?? "") ?? `exit ${result.code}`;
	await postBlockedComment(run, reason);
	return { outcome: "blocked", reason, alreadyMerged: false };
}

/** The block's comment on the pull request; a refused post leaves the outcome standing. */
async function postBlockedComment(run: MergeRun, reason: string): Promise<void> {
	const membership = newestMembershipOf(run.pullRequest);
	const source = sourceOf(run.sources, membership.sourceName);
	if (source === undefined) return;
	const ghOptions = await ghOptionsFor(run.runner, source);
	const args = [
		"pr",
		"comment",
		membership.externalKey,
		"--hostname",
		source.host,
		"--repo",
		membership.repository.displayName,
		"--body",
		blockedMergeComment(reason),
	];
	try {
		await run.runner.run("gh", args, ghOptions);
	} catch {
		// The comment is the block's note, not the block: a refused post
		// leaves the outcome standing with the source's reason.
	}
}

/**
 * Whether the value names the merge method the config takes: the named
 * check the config's validation runs, with the registry's list in its
 * refusal.
 */
export function mergeMethodList(): string {
	return MERGE_METHODS.join(", ");
}

/**
 * Whether the task type's pull request number names a mergeable pull
 * request: the key must carry a number the `gh` command can aim at. The
 * check the dispatch runs at the pickup, beside the ticket's standing, so
 * a row no merge can aim at drops with a named reason instead of running
 * a command the source would refuse.
 */
export function pullRequestNumberOf(pullRequest: Ticket): number | null {
	return externalKeyNumber(newestMembershipOf(pullRequest).externalKey);
}
