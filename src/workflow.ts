/**
 * The workflow machine's transition (ADR 0027).
 *
 * A completed turn fires the task type's transition once: the plane writes
 * the label facts on the ticket and its linked pull request, and the machine
 * re-derives every position from the written labels. The transition names no
 * destination. The judgments read from the settled turn's last message and
 * the pulled-source pull request, the branch that holds fires, and its facts
 * and pins take effect.
 */

import type {
	FactoryConfig,
	TransitionBranch,
	TransitionJudgment,
	TransitionOutcome,
	WorkflowTransition,
} from "./config.ts";
import {
	type EnvironmentKind,
	issueReferencesOf,
	type SourceMembership,
	type Ticket,
} from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./runner.ts";
import type { FactoryState } from "./state.ts";
import { membershipMatchesState } from "./task-selection.ts";
import { GhAuthenticator } from "./ticket-source.ts";

/** The inputs the transition's judgments read. */
export interface TransitionJudgmentInput {
	/** The review score the completed turn reported; null when there is none. */
	score: number | null;
	/** Whether the linked pull request is still open; null when there is none. */
	pullRequestOpen: boolean | null;
}

/** The evaluation of one transition against its judgment inputs. */
export interface TransitionEvaluation {
	fired: boolean;
	/** The judgment that fired; null for a fact-only transition or fallback. */
	when: TransitionJudgment | null;
	/** Why the transition did not fire; empty when it did. */
	reason: string;
	ticketFacts: string[];
	pullRequestFacts: string[];
	autoAdvance: boolean;
	agent?: string;
	environment?: EnvironmentKind;
}

/**
 * Evaluate a transition against its judgments. With no branches, the
 * transition is fact-only and always fires. With branches, the first
 * judgment branch whose judgment holds fires; the branch without a judgment
 * is the fallback and fires when no judgment branch does. A branch's facts
 * and pins replace the transition's for the field it names.
 */
export function evaluateTransition(
	transition: WorkflowTransition,
	input: TransitionJudgmentInput,
): TransitionEvaluation {
	const base: TransitionEvaluation = {
		fired: false,
		when: null,
		reason: "",
		ticketFacts: transition.ticketFacts,
		pullRequestFacts: transition.pullRequestFacts,
		autoAdvance: transition.autoAdvance ?? false,
		...(transition.agent === undefined ? {} : { agent: transition.agent }),
		...(transition.environment === undefined ? {} : { environment: transition.environment }),
	};
	const branches = transition.branches;
	if (branches === undefined || branches.length === 0) return { ...base, fired: true };
	let fallback: TransitionEvaluation | undefined;
	for (const branch of branches) {
		if (branch.when === undefined) {
			fallback = effective(branch, transition, null);
			continue;
		}
		if (!judgmentHolds(branch.when, transition.scoreThreshold, input)) continue;
		return effective(branch, transition, branch.when);
	}
	if (fallback !== undefined) return fallback;
	const tested = new Set(branches.map((branch) => branch.when));
	if (
		input.score === null &&
		(tested.has("score-above-threshold") || tested.has("score-below-threshold"))
	) {
		return { ...base, reason: "the pull request carries no review score" };
	}
	if (
		input.pullRequestOpen === null &&
		(tested.has("pull-request-open") || tested.has("pull-request-closed"))
	) {
		return { ...base, reason: "no pull request was found for the ticket" };
	}
	return { ...base, reason: "no judgment held" };
}

/** One judgment against its inputs. */
function judgmentHolds(
	judgment: TransitionJudgment,
	threshold: number | undefined,
	input: TransitionJudgmentInput,
): boolean {
	switch (judgment) {
		case "score-above-threshold":
			return input.score !== null && threshold !== undefined && input.score >= threshold;
		case "score-below-threshold":
			return input.score !== null && threshold !== undefined && input.score < threshold;
		case "pull-request-open":
			return input.pullRequestOpen === true;
		case "pull-request-closed":
			return input.pullRequestOpen === false;
	}
}

/** The effective evaluation a fired branch carries. */
function effective(
	branch: TransitionBranch,
	transition: WorkflowTransition,
	when: TransitionJudgment | null,
): TransitionEvaluation {
	return {
		fired: true,
		when,
		reason: "",
		ticketFacts: branch.ticketFacts ?? transition.ticketFacts,
		pullRequestFacts: branch.pullRequestFacts ?? transition.pullRequestFacts,
		autoAdvance: branch.autoAdvance ?? transition.autoAdvance ?? false,
		...(branch.agent !== undefined
			? { agent: branch.agent }
			: transition.agent === undefined
				? {}
				: { agent: transition.agent }),
		...(branch.environment !== undefined
			? { environment: branch.environment }
			: transition.environment === undefined
				? {}
				: { environment: transition.environment }),
	};
}

/**
 * The review score a completion message reports; null when the message
 * carries none. The seed review template ends in `- **Score:** 85 / 100`.
 * The line is the fixed format the template carries, and a number in loose
 * prose is not a score. When the line appears more than once, the last
 * occurrence is the verdict: the agent restates the score after the final
 * pass, and the earlier lines are scratch.
 */
export function scoreFromMessage(message: string): number | null {
	const matches = [...message.matchAll(/\*\*score:\*\*\s*(\d{1,3})/gi)];
	if (matches.length === 0) return null;
	const value = Number(matches[matches.length - 1][1]);
	return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/** Whether the transition's branches test a score judgment. */
function transitionReadsScore(transition: WorkflowTransition): boolean {
	return (transition.branches ?? []).some(
		(branch) => branch.when === "score-above-threshold" || branch.when === "score-below-threshold",
	);
}

/**
 * The review score the pull request's comments carry: the newest comment
 * that reports one in the template's fixed line. Null when no comment
 * reports a score, when the comment read fails, or when the source cannot be
 * resolved. The comments are read straight from the source, not from the
 * projection: the review posts its verdict to the pull request, and that
 * comment is the durable record the judgment reads.
 */
async function readPullRequestScore(
	request: FireTransitionRequest,
	pullRequest: Ticket,
): Promise<number | null> {
	const membership = newestMembershipOf(pullRequest);
	const number = numberFromExternalKey(membership.externalKey);
	if (number === null) return null;
	const source = request.config.sources.find((item) => item.name === membership.sourceName);
	if (source === undefined) return null;
	let ghOptions: CommandOptions = {};
	if (source.auth !== undefined) {
		const resolved = await new GhAuthenticator(
			source.host,
			source.auth,
			request.runner,
			process.env,
		).resolve();
		if (!resolved.ok) return null;
		ghOptions = resolved.options;
	}
	const path = `repos/${membership.repository.displayName}/issues/${number}/comments?per_page=100`;
	let result: CommandResult;
	try {
		result = await request.runner.run("gh", ["api", "--hostname", source.host, path], ghOptions);
	} catch {
		return null;
	}
	if (result.code !== 0) return null;
	let comments: unknown;
	try {
		comments = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(comments)) return null;
	// Newest first: the latest review verdict is the one the judgment reads.
	const bodies = (comments as Array<{ body?: unknown; created_at?: unknown }>)
		.filter(
			(comment): comment is { body: string; created_at?: string } =>
				typeof comment.body === "string",
		)
		.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
	for (const comment of bodies) {
		const score = scoreFromMessage(comment.body);
		if (score !== null) return score;
	}
	return null;
}

/**
 * The labels the machine's writes own: every label a transition or branch
 * writes, across all task types. A write removes only a label in this set
 * that the write's facts do not name.
 *
 * A label a state match names in its all or any set, but that no transition
 * writes, is the operator's: a scoping label that gates the state (for
 * example `labels-all = ["factory"]`). The fire never removes it, so a state
 * that scopes on an operator label keeps the label it matched on. The none
 * set names what keeps a ticket out of a state, not what the machine owns.
 */
export function transitionLabelSet(config: FactoryConfig): ReadonlySet<string> {
	const labels = new Set<string>();
	for (const task of Object.values(config.taskTypes)) {
		const transition = task.transition;
		if (transition === undefined) continue;
		for (const label of [
			...transition.ticketFacts,
			...transition.pullRequestFacts,
			...(transition.branches ?? []).flatMap((branch) => [
				...(branch.ticketFacts ?? []),
				...(branch.pullRequestFacts ?? []),
			]),
		])
			labels.add(label.toLocaleLowerCase());
	}
	return labels;
}

/**
 * The pull request a ticket links, from the plane's own ticket list (ADR
 * 0023): the newest non-draft pull request whose issue references name the
 * ticket, by identity or by repository and number. Null when none is found.
 */
export function findLinkedPullRequest(tickets: readonly Ticket[], issue: Ticket): Ticket | null {
	const issueIdentities = new Set(issue.memberships.map((membership) => membership.identity));
	const issueNumbers = new Map<string, number>();
	for (const membership of issue.memberships) {
		const number = numberFromExternalKey(membership.externalKey);
		if (number !== null) issueNumbers.set(membership.repository.identity, number);
	}
	const candidates = tickets.filter(
		(ticket) =>
			ticket.sourceKind === "github-pull-request" &&
			!isDraft(ticket) &&
			ticket.memberships.some((membership) =>
				issueReferencesOf(membership.attributes).some(
					(reference) =>
						(reference.identity !== null && issueIdentities.has(reference.identity)) ||
						(reference.identity === null &&
							issueNumbers.get(membership.repository.identity) === reference.number),
				),
			),
	);
	if (candidates.length === 0) return null;
	return candidates.sort(
		(a, b) =>
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
			a.identity.localeCompare(b.identity),
	)[0];
}

/** Whether the ticket's newest membership reads draft. */
export function isDraft(ticket: Ticket): boolean {
	return newestMembershipOf(ticket).attributes.draft === "true";
}

/** The ticket's newest membership by external update time. */
export function newestMembershipOf(ticket: Ticket): SourceMembership {
	return [...ticket.memberships].sort(
		(a, b) =>
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
			a.sourceName.localeCompare(b.sourceName),
	)[0];
}

function numberFromExternalKey(key: string): number | null {
	const match = /^#(\d+)$/.exec(key);
	return match === null ? null : Number(match[1]);
}

/** The request one transition fire needs. */
export interface FireTransitionRequest {
	config: FactoryConfig;
	state: FactoryState;
	runner: CommandRunner;
	ticketIdentity: string;
	taskType: string;
	/** The forced refresh of the pull request sources; omitted in tests. */
	refresh?: () => Promise<void>;
}

/**
 * Fire the task type's transition on a completed turn: pull the sources,
 * find the linked pull request, read the judgments, fire the branch, write
 * the label facts, and compute the new position. Returns null when the task
 * type has no transition or the ticket has left the list; the fire is
 * idempotent, so a second fire on the same labels writes nothing.
 */
export async function fireTransition(
	request: FireTransitionRequest,
): Promise<TransitionOutcome | null> {
	const transition = request.config.taskTypes[request.taskType]?.transition;
	if (transition === undefined) return null;
	await request.refresh?.();
	const tickets = request.state.visibleTickets(
		request.config.workflowStates,
		request.config.defaultTaskType,
		[],
	);
	const ticket = tickets.find((item) => item.identity === request.ticketIdentity);
	if (ticket === undefined) return null;
	const pullRequest =
		ticket.sourceKind === "github-pull-request" ? ticket : findLinkedPullRequest(tickets, ticket);
	// The review verdict is the pull request's own comment, the place the
	// review template names for the score. It is read only when this
	// transition tests a score judgment and only for a pull request that is
	// there to read.
	const score =
		transitionReadsScore(transition) && pullRequest !== null
			? await readPullRequestScore(request, pullRequest)
			: null;
	const pullRequestOpen =
		pullRequest === null
			? null
			: pullRequest.sourceState === "open"
				? true
				: pullRequest.sourceState === "closed"
					? false
					: null;
	const evaluation = evaluateTransition(transition, { score, pullRequestOpen });
	const outcome: TransitionOutcome = {
		fired: evaluation.fired,
		when: evaluation.when,
		reason: evaluation.reason,
		ticketFacts: evaluation.ticketFacts,
		pullRequestFacts: evaluation.pullRequestFacts,
		autoAdvance: evaluation.autoAdvance,
		...(evaluation.agent === undefined ? {} : { agent: evaluation.agent }),
		...(evaluation.environment === undefined ? {} : { environment: evaluation.environment }),
		ticketWrite: null,
		pullRequestWrite: null,
		pullRequestIdentity: pullRequest === null ? null : pullRequest.identity,
		pullRequestKey: pullRequest === null ? null : pullRequest.externalKey,
		writeFailure: "",
		positionTaskType: null,
		positionTicketIdentity: null,
	};
	if (!evaluation.fired) return outcome;
	const machine = transitionLabelSet(request.config);
	// The two surfaces the facts name. A pull request ticket is its own linked
	// pull request, so one surface carries both fact lists and the plane
	// converges it once: a second write would strip what the first wrote.
	const surfaces: PullRequestSurface[] =
		ticket.sourceKind === "github-pull-request"
			? [
					{
						kind: "pull-request",
						command: "pr",
						ticket,
						facts: [...new Set([...evaluation.ticketFacts, ...evaluation.pullRequestFacts])],
					},
				]
			: [
					{ kind: "ticket", command: "issue", ticket, facts: evaluation.ticketFacts },
					...(pullRequest === null
						? []
						: [
								{
									kind: "pull-request" as const,
									command: "pr" as const,
									ticket: pullRequest,
									facts: evaluation.pullRequestFacts,
								},
							]),
				];
	// No linked pull request, and the transition named facts for one: the skip
	// is the fire's visible fact, not a silent gap in the written labels. The
	// fire derives no position from it either: the position the facts were
	// meant to stand on is the pull request's, and deriving one on the ticket
	// instead would auto-advance into the ticket's own state, re-firing the
	// same transition on the next turn while the pull request is still
	// missing.
	const missingPullRequest = pullRequest === null && evaluation.pullRequestFacts.length > 0;
	if (missingPullRequest) outcome.reason = "no linked pull request was found for the ticket";
	for (const target of surfaces) {
		const write = await writeSurfaceLabels(request, target, machine);
		const applied = applyWrite(outcome, write);
		if (target.kind === "ticket") outcome.ticketWrite = applied;
		else outcome.pullRequestWrite = applied;
	}
	// A failed write stands as the failure fact; the plane does not re-derive
	// a position from labels it did not manage to write.
	if (outcome.writeFailure !== "") return outcome;
	const surface = pullRequest ?? ticket;
	const surfaceWrite = pullRequest !== null ? outcome.pullRequestWrite : outcome.ticketWrite;
	const postLabels = postWriteLabels(surface.labels, surfaceWrite);
	const pseudo: SourceMembership = {
		...newestMembershipOf(surface),
		labels: postLabels,
	};
	// The new position: the first state whose match holds on the surface's
	// post-write labels. A parking state offers no task: the plane does
	// nothing on it, so the position offers no handoff. A missing linked
	// pull request derives no position: see the skip above.
	if (!missingPullRequest) {
		for (const state of request.config.workflowStates) {
			if (membershipMatchesState(pseudo, state)) {
				if (state.taskType !== undefined) {
					outcome.positionTaskType = state.taskType;
					outcome.positionTicketIdentity = surface.identity;
				}
				break;
			}
		}
	}
	return outcome;
}

/**
 * Fold one surface write into the outcome: the write that ran, or the
 * failure as a fact when the command failed. A failed write is not a write:
 * the outcome names what was attempted only in the failure.
 */
function applyWrite(
	outcome: TransitionOutcome,
	write: { added: string[]; removed: string[]; failure?: string } | null,
): { added: string[]; removed: string[] } | null {
	if (write === null) return null;
	if (write.failure !== undefined) {
		outcome.writeFailure =
			outcome.writeFailure === "" ? write.failure : `${outcome.writeFailure}; ${write.failure}`;
		return null;
	}
	return { added: write.added, removed: write.removed };
}

/** The labels a surface wears after its write: the current set, converged. */
function postWriteLabels(
	current: readonly string[],
	write: { added: string[]; removed: string[] } | null,
): string[] {
	if (write === null) return [...current];
	const removed = new Set(write.removed.map((label) => label.toLocaleLowerCase()));
	return current.filter((label) => !removed.has(label.toLocaleLowerCase())).concat(write.added);
}

/**
 * One surface a fire writes on: the ticket, the linked pull request, or - on
 * a pull request ticket - the one surface that holds both roles.
 */
interface PullRequestSurface {
	kind: "ticket" | "pull-request";
	/** The `gh` subcommand that edits this surface's item. */
	command: "issue" | "pr";
	ticket: Ticket;
	facts: readonly string[];
}

/**
 * Write one surface's label facts through the command runner (ADR 0027):
 * add the facts the surface does not wear, remove the machine's labels the
 * facts do not name. Returns the write that ran, null when nothing had to
 * change, and the failure as a fact when the command failed.
 */
async function writeSurfaceLabels(
	request: FireTransitionRequest,
	surface: PullRequestSurface,
	machine: ReadonlySet<string>,
): Promise<{ added: string[]; removed: string[]; failure?: string } | null> {
	const { command: kind, ticket: item, facts } = surface;
	const have = new Set(item.labels.map((label) => label.toLocaleLowerCase()));
	const factSet = new Set(facts.map((label) => label.toLocaleLowerCase()));
	const added = facts.filter((label) => !have.has(label.toLocaleLowerCase()));
	const removed = item.labels.filter(
		(label) => machine.has(label.toLocaleLowerCase()) && !factSet.has(label.toLocaleLowerCase()),
	);
	if (added.length === 0 && removed.length === 0) return null;
	const membership = newestMembershipOf(item);
	// The write runs as the source the item lists on: the source's auth
	// table resolves to a token the command carries in its environment, so
	// the labels the plane writes and the items it reads come from the same
	// account. A source with no auth table runs on gh's current
	// authentication, as the reads do.
	const source = request.config.sources.find((item2) => item2.name === membership.sourceName);
	let ghOptions: CommandOptions = {};
	if (source?.auth !== undefined) {
		const resolved = await new GhAuthenticator(
			source.host,
			source.auth,
			request.runner,
			process.env,
		).resolve();
		if (!resolved.ok)
			return {
				added,
				removed,
				failure: `gh ${kind} edit ${membership.externalKey} failed: ${resolved.reason}`,
			};
		ghOptions = resolved.options;
	}
	// The repository identity carries the host (`<host>/<owner>/<name>`), which
	// is the form `gh --repo` takes: `gh <kind> edit` maps no `--hostname`.
	const args: string[] = [
		kind,
		"edit",
		membership.externalKey,
		"--repo",
		membership.repository.identity,
	];
	if (added.length > 0) args.push("--add-label", added.join(","));
	if (removed.length > 0) args.push("--remove-label", removed.join(","));
	let result: CommandResult;
	try {
		result = await request.runner.run("gh", args, ghOptions);
	} catch (error) {
		return {
			added,
			removed,
			failure: `gh ${kind} edit ${membership.externalKey} failed: ${String(error)}`,
		};
	}
	if (result.code !== 0) {
		const detail = firstNonEmptyLine(result.stderr) ?? `exit ${result.code}`;
		return {
			added,
			removed,
			failure: `gh ${kind} edit ${membership.externalKey} failed: ${detail}`,
		};
	}
	return { added, removed };
}
