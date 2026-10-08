/**
 * The pull request lifecycle the plane owns (ADR 0076): the open of the
 * ticket's pull request as a draft on its factory branch, the publish that
 * marks it ready for review at settle, and the cycle-end close of the draft
 * the ticket still wears.
 *
 * The agent never creates, merges, or edits the pull request; it works the
 * branch the pull request already stands on. Every command in this module
 * goes through the one command runner with the source's own auth, the way
 * the label writes do: no other egress, no second seam. The direct
 * head-branch read is the read that reaches a draft: a draft pull request
 * the machine has not labeled never stands in the ticket projection.
 */
import type { TicketSourceConfig } from "./config.ts";
import type { RepositoryRef, SourceMembership, Ticket } from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import { branchNameFor } from "./naming.ts";
import {
	type CommandOptions,
	type CommandResult,
	type CommandRunner,
	errorMessage,
} from "./runner.ts";
import { newestMembership } from "./task-selection.ts";
import { GhAuthenticator } from "./ticket-source.ts";

/**
 * One open pull request on one head branch, as the direct read answers it:
 * the number the `gh pr` commands take, the draft fact the publish tests,
 * the head and base branches the commit count reads, and the url the prompt
 * and the Decision screen name.
 */
export interface OpenPullRequestRecord {
	number: number;
	state: string;
	draft: boolean;
	url: string;
	headBranch: string;
	baseBranch: string;
	labels: string[];
}

/**
 * The source auth options one `gh` command carries: the source's auth table
 * resolved to a token in the environment, the way the label writes do. A
 * source with no auth table runs on gh's current authentication.
 */
async function sourceGhOptions(
	runner: CommandRunner,
	source: TicketSourceConfig,
): Promise<CommandOptions | { fail: string }> {
	if (source.auth === undefined) return {};
	const resolved = await new GhAuthenticator(
		source.host,
		source.auth,
		runner,
		process.env,
	).resolve();
	return resolved.ok ? resolved.options : { fail: resolved.reason };
}

/**
 * The open pull requests of one head branch, read straight from the source.
 * The read is by the branch, not by the projection: a draft the machine has
 * not labeled never stands in the ticket list, and this read is the one that
 * reaches it. Null-answer failures come back as a reason, not a throw.
 */
export async function listOpenPullRequestsByHeadBranch(
	runner: CommandRunner,
	source: TicketSourceConfig,
	repository: RepositoryRef,
	branch: string,
): Promise<OpenPullRequestRecord[] | { fail: string }> {
	const auth = await sourceGhOptions(runner, source);
	if ("fail" in auth) return auth;
	// The head parameter is `<head owner account>:<branch>`: the account the
	// head repository sits under, the repository's owner.
	const owner = repository.displayName.split("/")[0] ?? repository.displayName;
	const path = `repos/${repository.displayName}/pulls?state=open&head=${encodeURIComponent(
		`${owner}:${branch}`,
	)}`;
	let result: CommandResult;
	try {
		result = await runner.run("gh", ["api", "--hostname", source.host, path], auth);
	} catch (error) {
		return { fail: `the pull request read raised: ${errorMessage(error)}` };
	}
	if (result.code !== 0) return { fail: firstNonEmptyLine(result.stderr) ?? `exit ${result.code}` };
	let list: unknown;
	try {
		list = JSON.parse(result.stdout);
	} catch {
		return { fail: "the pull request read answered no list" };
	}
	if (!Array.isArray(list)) return { fail: "the pull request read answered no list" };
	const records: OpenPullRequestRecord[] = [];
	for (const item of list) {
		const record = item as Record<string, unknown>;
		if (
			typeof record.number !== "number" ||
			typeof record.state !== "string" ||
			typeof record.draft !== "boolean" ||
			typeof record.html_url !== "string"
		)
			return { fail: "the pull request read answered an unreadable pull request" };
		const head = record.head as { ref?: unknown } | undefined;
		const base = record.base as { ref?: unknown } | undefined;
		if (typeof head?.ref !== "string" || typeof base?.ref !== "string")
			return { fail: "the pull request read answered a pull request with no head or base" };
		const labels = Array.isArray(record.labels)
			? (record.labels as Array<{ name?: unknown }>)
					.map((label) => label.name)
					.filter((name): name is string => typeof name === "string")
			: [];
		records.push({
			number: record.number,
			state: record.state,
			draft: record.draft,
			url: record.html_url,
			headBranch: head.ref,
			baseBranch: base.ref,
			labels,
		});
	}
	return records;
}

/**
 * The window the draft create retries its one transient answer (ADR 0076).
 * The handoff's push has reached the source's git server, but the source's
 * GraphQL layer may not carry the fresh branch's commits yet when the create
 * runs straight after the push. The create then answers `No commits exist`
 * on a branch that stands: the read has not caught up, and the answer clears
 * once it does.
 */
const PULL_REQUEST_CREATE_RETRY_DELAY_MS = 500;
const PULL_REQUEST_CREATE_RETRY_WINDOW_MS = 5_000;

/**
 * The one failure the draft create retries: the fresh branch's commits not
 * standing in the source's read yet. Every other answer is final, and keeps
 * its original failure path and cleanup.
 */
function freshBranchNotStanding(result: CommandResult): boolean {
	return result.code !== 0 && result.stderr.includes("No commits exist");
}

/**
 * The open of the ticket's pull request as a draft (ADR 0076): the title the
 * ticket carries, the body the plane writes, on the branch the handoff just
 * pushed. The pull request's url comes back the way the command answers it,
 * with its number parsed from the url for the commands that take a number.
 *
 * The create that answers the fresh branch's replication lag is retried for
 * a bounded window, the way a busy fresh pane's start is: only that exact
 * answer retries, and a create that never clears it fails with the last
 * answer the source gave.
 */
export async function openDraftPullRequest(
	runner: CommandRunner,
	source: TicketSourceConfig,
	fields: { repository: RepositoryRef; branch: string; title: string; body: string },
): Promise<{ number: number; url: string } | { fail: string }> {
	const { repository, branch, title, body } = fields;
	const auth = await sourceGhOptions(runner, source);
	if ("fail" in auth) return auth;
	const args = [
		"pr",
		"create",
		"--repo",
		repository.identity,
		"--head",
		branch,
		"--draft",
		"--title",
		title,
		"--body",
		body,
	];
	const deadline = Date.now() + PULL_REQUEST_CREATE_RETRY_WINDOW_MS;
	let result: CommandResult;
	while (true) {
		try {
			result = await runner.run("gh", args, auth);
		} catch (error) {
			return { fail: `the pull request create raised: ${errorMessage(error)}` };
		}
		if (result.code === 0 || !freshBranchNotStanding(result)) break;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise<void>((resolve) =>
			setTimeout(resolve, Math.min(PULL_REQUEST_CREATE_RETRY_DELAY_MS, remaining)),
		);
	}
	if (result.code !== 0) return { fail: firstNonEmptyLine(result.stderr) ?? `exit ${result.code}` };
	const url = [...result.stdout.split(/\r?\n/)].reverse().find((line) => line.trim() !== "") ?? "";
	const number = numberFromPullUrl(url);
	if (number === null)
		return { fail: `the pull request create answered no pull request url: ${url}` };
	return { number, url };
}

/** The number the pull request url carries, null when it does not. */
function numberFromPullUrl(url: string): number | null {
	const match = /\/pull\/(\d+)/.exec(url);
	return match === null ? null : Number(match[1]);
}

/**
 * The publish (ADR 0076): the draft the plane opened is marked ready for
 * review, so the machine can act on it and the list can hold it. A pull
 * request that is not a draft stands as it stands: the act is a no-op, and
 * it is never converted back to a draft.
 */
export async function markPullRequestReady(
	runner: CommandRunner,
	source: TicketSourceConfig,
	repository: RepositoryRef,
	number: number,
): Promise<string | null> {
	const auth = await sourceGhOptions(runner, source);
	if ("fail" in auth) return auth.fail;
	let result: CommandResult;
	try {
		result = await runner.run(
			"gh",
			["pr", "ready", String(number), "--repo", repository.identity],
			auth,
		);
	} catch (error) {
		return `the pull request ready raised: ${errorMessage(error)}`;
	}
	if (result.code !== 0)
		return firstNonEmptyLine(result.stderr) ?? `the pull request ready exited ${result.code}`;
	return null;
}

/** The close of one pull request through the command runner. */
export async function closePullRequest(
	runner: CommandRunner,
	source: TicketSourceConfig,
	repository: RepositoryRef,
	number: number,
): Promise<string | null> {
	const auth = await sourceGhOptions(runner, source);
	if ("fail" in auth) return auth.fail;
	let result: CommandResult;
	try {
		result = await runner.run(
			"gh",
			["pr", "close", String(number), "--repo", repository.identity],
			auth,
		);
	} catch (error) {
		return `the pull request close raised: ${errorMessage(error)}`;
	}
	if (result.code !== 0)
		return firstNonEmptyLine(result.stderr) ?? `the pull request close exited ${result.code}`;
	return null;
}

/**
 * The work the pull request's head carries against its base, read in the
 * checkout the fire runs from (ADR 0076): the head and the base fetched
 * from the remote, the trees compared. The test is the work, not the commit
 * count, because the plane's hold commit stands on every fresh factory
 * branch: a head whose tree equals its base's carries no work, hold commit
 * or not. True when the trees differ, false when they stand alike, and null
 * when the read fails - a remote that refuses, a base the remote does not
 * carry - and the caller treats the null the way it treats an unworked head:
 * as the pull request the work has not landed in yet.
 */
export async function pullRequestCarriesWork(
	runner: CommandRunner,
	checkout: string,
	headBranch: string,
	baseBranch: string,
): Promise<boolean | null> {
	const fetched = await runner.run(
		"git",
		["-C", checkout, "fetch", "origin", headBranch, baseBranch],
		{ env: { GIT_TERMINAL_PROMPT: "0" } },
	);
	if (fetched.code !== 0) return null;
	const diffed = await runner.run("git", [
		"-C",
		checkout,
		"diff",
		"--quiet",
		`origin/${baseBranch}`,
		`origin/${headBranch}`,
	]);
	// git diff --quiet answers 0 when the trees stand alike, 1 when they
	// differ, and a higher code when the read itself fails.
	if (diffed.code === 0) return false;
	if (diffed.code === 1) return true;
	return null;
}

/**
 * The body the plane writes on the open of the ticket's pull request
 * (ADR 0076). The ticket's work closes the ticket, so an issue ticket's
 * pull request carries the closing reference, the ticket's url, and its
 * description. A security item is not an issue the pull request closes:
 * the item's url stands as a plain reference, with the item's facts in the
 * ticket's description.
 */
export function pullRequestBodyFor(ticket: Ticket): string {
	if (ticket.sourceKind === "github-issue")
		return `Closes ${ticket.externalKey}\n\n${ticket.url}\n\n${ticket.description}`;
	return `${ticket.url}\n\n${ticket.description}`;
}

/**
 * The pull request the ticket's factory branch stands on, read straight
 * from the source by its head branch (ADR 0076): the Ticket the fire writes
 * on, synthesized from the read's record. Null when the ticket lists on no
 * source, its source is not configured, the read fails, or the branch
 * carries no open pull request.
 */
export async function readTicketOwnPullRequest(
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	ticket: Ticket,
): Promise<Ticket | null> {
	const membership = newestMembership(ticket.memberships);
	if (membership === undefined) return null;
	const source = sources.find((item) => item.name === membership.sourceName);
	if (source === undefined) return null;
	const records = await listOpenPullRequestsByHeadBranch(
		runner,
		source,
		ticket.repositoryRef,
		branchNameFor(ticket),
	);
	if ("fail" in records) return null;
	const record = records[0];
	if (record === undefined) return null;
	return ticketFromOpenPullRequestRecord(source, ticket, record);
}

/**
 * The Ticket one read record stands for: the identity the source would give
 * the pull request, the external key its number carries, and the membership
 * the fire's label write names it with. The draft and the head and base
 * branches ride in the attributes, the source facts every membership of a
 * pull request carries. The ticket the record stands for is the ticket it
 * was read for: the surrogate inherits that ticket's factory facts and only
 * its pull request identity is written.
 */
export function ticketFromOpenPullRequestRecord(
	source: TicketSourceConfig,
	ticket: Ticket,
	record: OpenPullRequestRecord,
): Ticket {
	const repository = ticket.repositoryRef;
	const membership: SourceMembership = {
		sourceName: source.name,
		health: "healthy",
		identity: `github:${source.host.toLowerCase()}:pull-${source.host}/${repository.displayName}/${record.number}`,
		sourceKind: "github-pull-request",
		externalKey: `#${record.number}`,
		sourceState: record.state,
		url: record.url,
		title: "",
		description: "",
		labels: [...record.labels],
		externalUpdatedAt: "",
		repository,
		attributes: {
			draft: String(record.draft),
			headBranch: record.headBranch,
			baseBranch: record.baseBranch,
		},
	};
	return {
		...ticket,
		identity: membership.identity,
		title: "",
		description: "",
		sourceKind: "github-pull-request",
		externalKey: `#${record.number}`,
		sourceState: record.state,
		url: record.url,
		labels: [...record.labels],
		externalUpdatedAt: "",
		memberships: [membership],
	};
}

/**
 * The cycle-end close of the draft (ADR 0076): the read of the ticket's
 * factory branch, and the close of the draft it carries. A pull request the
 * machine has published is never touched: only a draft is closed, and only
 * one the branch still carries open. The null answer closes nothing - a
 * branch with no open pull request, or a published one - and a failure comes
 * back as its reason for the caller to report.
 */
export async function closeCycleEndDraftPullRequest(
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	ticket: Ticket,
): Promise<string | null> {
	const membership = newestMembership(ticket.memberships);
	if (membership === undefined) return `ticket ${ticket.identity} lists on no source`;
	const source = sources.find((item) => item.name === membership.sourceName);
	if (source === undefined)
		return `the source ${membership.sourceName} the ticket lists on is not configured`;
	const records = await listOpenPullRequestsByHeadBranch(
		runner,
		source,
		ticket.repositoryRef,
		branchNameFor(ticket),
	);
	if ("fail" in records) return records.fail;
	const record = records[0];
	if (record === undefined || !record.draft) return null;
	return closePullRequest(runner, source, ticket.repositoryRef, record.number);
}
