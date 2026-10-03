/**
 * The plane actions (ADR 0068): the tasks the machine resolves with no
 * agent, no worktree, and no seat from the Parallel limit.
 *
 * A task type in the action form names one built-in action from the registry
 * and carries its named settings; the registry
 * ([plane-action-registry.ts](./plane-action-registry.ts)) is the one home of
 * the names the config may name and the methods they accept, so the config
 * validation, the dispatch that runs the action, the surfaces that name the
 * action, and the machine that derives a Next step all read one place and
 * none of them can drift. This module holds the run: the merge as a
 * control-plane action through the command runner - the `gh` merge, with a
 * comment on a blocked pull request - and its outcome fires the task type's
 * transition, the fact on the attempt's record, because no Completion trace
 * stands for it.
 */

import type { TicketSourceConfig } from "./config.ts";
import type { Ticket } from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import type { MergeMethod } from "./plane-action-registry.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./runner.ts";
import { GhAuthenticator } from "./ticket-source.ts";
import { newestMembershipOf, readPullRequestOpenRecord } from "./workflow.ts";

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
	// The repository identity carries the host (`<host>/<owner>/<name>`), which
	// is the form `gh --repo` takes: `gh pr merge` maps no `--hostname` (the
	// `gh api` read above keeps its own flag).
	const args = [
		"pr",
		"merge",
		membership.externalKey,
		mergeFlag(run.method),
		"--repo",
		membership.repository.identity,
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
	// The host rides in the repository identity the same way the merge's does:
	// `gh pr comment` maps no `--hostname`.
	const args = [
		"pr",
		"comment",
		membership.externalKey,
		"--repo",
		membership.repository.identity,
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
