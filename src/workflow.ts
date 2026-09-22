/**
 * The workflow machine's transition (ADR 0027).
 *
 * A completed turn fires the task type's transition once: the plane writes
 * the label facts on the ticket and its fixing pull request, and the machine
 * re-derives every position from the written labels. The transition names no
 * destination. The judgments read from the source at the settle (ADR 0047):
 * the review score from the pull request's comments, and the open state from
 * the pull request's own record, with the projection's last refresh as the
 * read's fallback. The branch that holds fires, and its facts and pins take
 * effect.
 */

import type {
	FactoryConfig,
	TicketSourceConfig,
	TransitionBranch,
	TransitionJudgment,
	TransitionOutcome,
	WorkflowTransition,
} from "./config.ts";
import {
	type EnvironmentKind,
	headBranchOf,
	issueReferencesOf,
	type SourceMembership,
	type Ticket,
} from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import { ticketBranchPrefix } from "./naming.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "./runner.ts";
import type { FactoryState } from "./state.ts";
import { membershipMatchesState, newestMembership } from "./task-selection.ts";
import { GhAuthenticator } from "./ticket-source.ts";

/**
 * The reason the fire records when no fixing pull request stands for the
 * ticket and the transition named facts for one (ADR 0027, ADR 0042). The
 * skip is the fire's visible fact on the settled turn's trace, and the only
 * trace the refresh-time re-fire re-fires: a trace that recorded any other
 * fact re-fires nothing.
 */
export const NO_LINKED_PULL_REQUEST_SKIP = "no linked pull request was found for the ticket";

/** The inputs the transition's judgments read. */
export interface TransitionJudgmentInput {
	/** The review score the completed turn reported; null when there is none. */
	score: number | null;
	/** Whether the fixing pull request is still open; null when there is none. */
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

/** Whether the transition's branches test the pull request's open state. */
function transitionReadsPullRequestState(transition: WorkflowTransition): boolean {
	return (transition.branches ?? []).some(
		(branch) => branch.when === "pull-request-open" || branch.when === "pull-request-closed",
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
	const number = externalKeyNumber(membership.externalKey);
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
 * Whether the pull request is still open, read straight from the source: the
 * pull's own REST record, live the moment a merge or close lands. The
 * projection's state is the last refresh's, and the search index still lists
 * a merged pull request as open for a while after the merge: the judgment of
 * the turn that merged the pull request must not decide on that. Null when
 * the key names no number, the source cannot be resolved, the read fails, or
 * the answer carries no state the judgment reads; the fire falls back to the
 * projection's fact for a null.
 */
async function readPullRequestOpen(
	request: FireTransitionRequest,
	pullRequest: Ticket,
): Promise<boolean | null> {
	const membership = newestMembershipOf(pullRequest);
	const number = externalKeyNumber(membership.externalKey);
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
	const path = `repos/${membership.repository.displayName}/pulls/${number}`;
	let result: CommandResult;
	try {
		result = await request.runner.run("gh", ["api", "--hostname", source.host, path], ghOptions);
	} catch {
		return null;
	}
	if (result.code !== 0) return null;
	let record: unknown;
	try {
		record = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const item = record as { state?: unknown; merged?: unknown };
	if (item.merged === true) return false;
	if (item.state === "open") return true;
	if (item.state === "closed") return false;
	return null;
}

/**
 * The pull request's open fact the judgments read: the direct read when a
 * branch tests it, else the projection's fact alone. The direct read's null
 * - a failed or unreadable answer - falls back to the projection's fact, the
 * way the fire reads the fact before the read exists.
 */
async function readPullRequestState(
	request: FireTransitionRequest,
	transition: WorkflowTransition,
	pullRequest: Ticket,
): Promise<boolean | null> {
	const direct = transitionReadsPullRequestState(transition)
		? await readPullRequestOpen(request, pullRequest)
		: null;
	if (direct !== null) return direct;
	switch (pullRequest.sourceState) {
		case "open":
			return true;
		case "closed":
			return false;
		default:
			return null;
	}
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
 * The number a source-visible external key carries (`#5` is 5), or null
 * when the key names none.
 */
export function externalKeyNumber(key: string): number | null {
	const match = /^#(\d+)$/.exec(key);
	return match === null ? null : Number(match[1]);
}

/** Whether the ticket's newest membership reads draft. */
export function isDraft(ticket: Ticket): boolean {
	return newestMembershipOf(ticket).attributes.draft === "true";
}

/** The ticket's newest membership by external update time. */
export function newestMembershipOf(ticket: Ticket): SourceMembership {
	const newest = newestMembership(ticket.memberships);
	if (newest === undefined) throw new Error(`the ticket ${ticket.identity} lists on no source`);
	return newest;
}

/**
 * Whether a pull request fixes a ticket (ADR 0042), from the source facts
 * alone: the pull request closes the ticket - by the ticket's identity, or
 * by repository and number when the source never learned the identity - or
 * it is in the ticket's own repository and its head branch carries the
 * ticket's `factory/<ticket id>-` prefix. The prefix match is on the ticket
 * id alone, so a title the upstream source changes cannot sever the link.
 *
 * The fact is structural: a closed pull request still fixes the ticket, and
 * the callers decide what an open one stands for.
 */
export function pullRequestFixesTicket(pullRequest: Ticket, ticket: Ticket): boolean {
	if (pullRequest.sourceKind !== "github-pull-request") return false;
	// The repository identity is case-insensitive on GitHub: the link holds
	// across the owner casing an older plane stored, the legacy pair among
	// them (ADR 0042).
	const ticketNumbers = new Map<string, number>();
	for (const membership of ticket.memberships) {
		const number = externalKeyNumber(membership.externalKey);
		if (number !== null) ticketNumbers.set(membership.repository.identity.toLowerCase(), number);
	}
	for (const membership of pullRequest.memberships) {
		for (const reference of issueReferencesOf(membership.attributes)) {
			if (reference.identity !== null && reference.identity === ticket.identity) return true;
			if (
				reference.identity === null &&
				ticketNumbers.get(membership.repository.identity.toLowerCase()) === reference.number
			)
				return true;
		}
	}
	const headBranch = headBranchOf(newestMembershipOf(pullRequest).attributes);
	if (headBranch === null) return false;
	return (
		newestMembershipOf(pullRequest).repository.identity.toLowerCase() ===
			newestMembershipOf(ticket).repository.identity.toLowerCase() &&
		headBranch.startsWith(ticketBranchPrefix(ticket.externalKey))
	);
}

/**
 * The ticket's fixing pull requests (ADR 0042): the open pull requests that
 * fix it. Derived from the source facts of the projection it reads; never
 * stored. A draft fixing pull request counts: the work is in flight, and the
 * rule's job is to withhold the ticket's task.
 */
export function fixingPullRequests(tickets: readonly Ticket[], ticket: Ticket): Ticket[] {
	return tickets.filter(
		(candidate) =>
			candidate.sourceKind === "github-pull-request" &&
			candidate.identity !== ticket.identity &&
			candidate.sourceState === "open" &&
			pullRequestFixesTicket(candidate, ticket),
	);
}

/**
 * The fixing pull request the machine acts on (ADR 0042): the newest
 * non-draft among the ticket's open fixing pull requests. Null when the
 * ticket has none, or only draft ones.
 */
export function findFixingPullRequest(tickets: readonly Ticket[], ticket: Ticket): Ticket | null {
	const candidates = fixingPullRequests(tickets, ticket).filter((candidate) => !isDraft(candidate));
	if (candidates.length === 0) return null;
	return candidates.sort(
		(a, b) =>
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
			a.identity.localeCompare(b.identity),
	)[0];
}

/**
 * The tickets a pull request fixes (ADR 0042), read from the pull request's
 * side: the tickets it closes, or the tickets its head branch carries. The
 * rank inheritance reads this side.
 */
export function fixedTickets(tickets: readonly Ticket[], pullRequest: Ticket): Ticket[] {
	return tickets.filter(
		(candidate) =>
			candidate.identity !== pullRequest.identity && pullRequestFixesTicket(pullRequest, candidate),
	);
}

/**
 * Whether a ticket is covered by an open fixing pull request (ADR 0042):
 * the ticket is open, and at least one open pull request fixes it. The list
 * rule withholds a covered ticket's row, and a draft fixing pull request
 * counts. The in-flight states are never covered: live work stays reachable
 * for its Live view, its Close, and its decision.
 */
export function isCoveredByFixingPullRequest(tickets: readonly Ticket[], ticket: Ticket): boolean {
	return ticket.state === "open" && fixingPullRequests(tickets, ticket).length > 0;
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
 * find the fixing pull request, read the judgments, fire the branch, write
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
	// The fire reads the projection before the list rule (ADR 0042): the rule
	// withholds a covered ticket's row from the operator's list, and the
	// machine's fire must still reach the ticket it acts on.
	const tickets = request.state.projectedTickets(
		request.config.workflowStates,
		request.config.defaultTaskType,
	);
	const ticket = tickets.find((item) => item.identity === request.ticketIdentity);
	if (ticket === undefined) return null;
	const pullRequest =
		ticket.sourceKind === "github-pull-request" ? ticket : findFixingPullRequest(tickets, ticket);
	// The review verdict is the pull request's own comment, the place the
	// review template names for the score. It is read only when this
	// transition tests a score judgment and only for a pull request that is
	// there to read.
	const score =
		transitionReadsScore(transition) && pullRequest !== null
			? await readPullRequestScore(request, pullRequest)
			: null;
	const pullRequestOpen =
		pullRequest === null ? null : await readPullRequestState(request, transition, pullRequest);
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
	// The two surfaces the facts name. A pull request ticket is its own fixing
	// pull request, so one surface carries both fact lists and the plane
	// converges it once: a second write would strip what the first wrote.
	const surfaces: PullRequestSurface[] =
		ticket.sourceKind === "github-pull-request"
			? [
					{
						kind: "pull-request",
						command: editCommandFor(ticket),
						ticket,
						facts: [...new Set([...evaluation.ticketFacts, ...evaluation.pullRequestFacts])],
					},
				]
			: [
					{
						kind: "ticket",
						command: editCommandFor(ticket),
						ticket,
						facts: evaluation.ticketFacts,
					},
					...(pullRequest === null
						? []
						: [
								{
									kind: "pull-request" as const,
									command: editCommandFor(pullRequest),
									ticket: pullRequest,
									facts: evaluation.pullRequestFacts,
								},
							]),
				];
	// No fixing pull request, and the transition named facts for one: the skip
	// is the fire's visible fact, not a silent gap in the written labels. The
	// fire derives no position from it either: the position the facts were
	// meant to stand on is the pull request's, and deriving one on the ticket
	// instead would auto-advance into the ticket's own state, re-firing the
	// same transition on the next turn while the pull request is still
	// missing.
	const missingPullRequest = pullRequest === null && evaluation.pullRequestFacts.length > 0;
	if (missingPullRequest) outcome.reason = NO_LINKED_PULL_REQUEST_SKIP;
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
	// nothing on it, so the position offers no handoff. A missing fixing
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
 * One surface a fire writes on: the ticket, the fixing pull request, or - on
 * a pull request ticket - the one surface that holds both roles.
 */
interface PullRequestSurface {
	kind: "ticket" | "pull-request";
	/** The `gh` subcommand that edits this surface's item. */
	command: "issue" | "pr";
	ticket: Ticket;
	facts: readonly string[];
}

/** The request the re-fire of the recorded skips needs (ADR 0042). */
export interface RefireRecordedSkipsRequest {
	config: FactoryConfig;
	state: FactoryState;
	runner: CommandRunner;
}

/**
 * One recorded skip the sweep re-fired: the re-fired outcome now stands on
 * the ticket's newest completion trace in place of the skip it replaced.
 */
export interface RefiredSkip {
	ticketIdentity: string;
	outcome: TransitionOutcome;
}

/**
 * The re-fire of the recorded skips (ADR 0042).
 *
 * A refresh that found a fixing pull request for a ticket re-fires the
 * newest completion trace of that ticket that recorded the skip reason:
 * the fire writes the facts the skip left unwritten - the pull request's -
 * and derives the position the fire derives, and the trace takes the
 * re-fired outcome in place of the skip. The sweep is bounded to the skip:
 * a trace that recorded any other fact re-fires nothing, a ticket without
 * an open fixing pull request re-fires nothing, and a ticket that left its
 * source is not in the projection at all. The fire is idempotent, so a
 * label set that already matches its spec writes nothing, and the swap of
 * the outcome onto the trace is the "once": a trace that no longer records
 * the skip re-fires nothing, whatever the sweeps that follow read.
 *
 * The outcome the trace records carries `refired`, so the observation loop
 * can tell a re-fired outcome from a settle-time one, and route the
 * auto-advance the skip's closed cycle never ran. A fire that finds no
 * transition at all returns nothing and the sweep reads it again next cycle
 * with no command; any outcome the fire produced, a fact it refused with
 * included, lands on the trace once, the way a settle-time outcome does.
 */
export async function refireRecordedSkips(
	request: RefireRecordedSkipsRequest,
): Promise<RefiredSkip[]> {
	// The sweep reads the projection before the list rule (ADR 0042): the rule
	// withholds a covered ticket's row from the operator's list, and the
	// re-fire must still reach the ticket it acts on.
	const tickets = request.state.projectedTickets(
		request.config.workflowStates,
		request.config.defaultTaskType,
	);
	const refired: RefiredSkip[] = [];
	for (const ticket of tickets) {
		const completion = ticket.lastCompletion;
		const skip = completion?.transition ?? null;
		if (completion === null || skip === null) continue;
		if (skip.fired !== true || skip.reason !== NO_LINKED_PULL_REQUEST_SKIP) continue;
		// A pull request ticket is its own fixing pull request: its fire can
		// never record the skip, and the re-fire reads the issue side of the
		// link only.
		if (ticket.sourceKind === "github-pull-request") continue;
		// The awaiting walk keeps the row of a ticket that left every source,
		// so the sweep checks the snapshot itself: the re-fire refuses a
		// ticket its source no longer lists, the way the fire refuses a
		// ticket that left the list.
		if (!request.state.stillListed(ticket.identity)) continue;
		// The machine acts on the newest non-draft open pull request that fixes
		// the ticket: without one standing now, the skip stands as recorded.
		if (findFixingPullRequest(tickets, ticket) === null) continue;
		const outcome = await fireTransition({
			config: request.config,
			state: request.state,
			runner: request.runner,
			ticketIdentity: ticket.identity,
			taskType: completion.taskType,
		});
		if (outcome === null) continue;
		const recorded: TransitionOutcome = { ...outcome, refired: true };
		if (request.state.recordSkipRefire(ticket.identity, recorded))
			refired.push({ ticketIdentity: ticket.identity, outcome: recorded });
	}
	return refired;
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
	return writeMembershipLabels(
		request.config.sources,
		request.runner,
		newestMembershipOf(item),
		kind,
		added,
		removed,
	);
}

/**
 * The `gh` subcommand that edits the item (ADR 0027, ADR 0045): the pull
 * request edit on a pull request item, the issue edit on an issue item. The
 * transition fire and the ticket placement name their writes through this
 * one mapping, so the two paths cannot drift.
 */
export function editCommandFor(item: { readonly sourceKind: string }): "issue" | "pr" {
	return item.sourceKind === "github-pull-request" ? "pr" : "issue";
}

/**
 * One label write on one source membership through the command runner
 * (ADR 0027, ADR 0045): add the labels given, remove the labels given, on
 * the source the membership lists. The transition fire and the ticket
 * placement share it: one write, one failure format, one auth resolution.
 *
 * Returns the write that ran, null when nothing had to change, and the
 * failure as a fact when the command failed.
 */
export async function writeMembershipLabels(
	sources: readonly TicketSourceConfig[],
	runner: CommandRunner,
	membership: SourceMembership,
	command: "issue" | "pr",
	added: readonly string[],
	removed: readonly string[],
): Promise<{ added: string[]; removed: string[]; failure?: string } | null> {
	if (added.length === 0 && removed.length === 0) return null;
	// The write runs as the source the item lists on: the source's auth
	// table resolves to a token the command carries in its environment, so
	// the labels the plane writes and the items it reads come from the same
	// account. A source with no auth table runs on gh's current
	// authentication, as the reads do.
	const source = sources.find((item) => item.name === membership.sourceName);
	let ghOptions: CommandOptions = {};
	if (source?.auth !== undefined) {
		const resolved = await new GhAuthenticator(
			source.host,
			source.auth,
			runner,
			process.env,
		).resolve();
		if (!resolved.ok)
			return {
				added: [...added],
				removed: [...removed],
				failure: `gh ${command} edit ${membership.externalKey} failed: ${resolved.reason}`,
			};
		ghOptions = resolved.options;
	}
	// The repository identity carries the host (`<host>/<owner>/<name>`), which
	// is the form `gh --repo` takes: `gh <kind> edit` maps no `--hostname`.
	const args: string[] = [
		command,
		"edit",
		membership.externalKey,
		"--repo",
		membership.repository.identity,
	];
	if (added.length > 0) args.push("--add-label", added.join(","));
	if (removed.length > 0) args.push("--remove-label", removed.join(","));
	let result: CommandResult;
	try {
		result = await runner.run("gh", args, ghOptions);
	} catch (error) {
		return {
			added: [...added],
			removed: [...removed],
			failure: `gh ${command} edit ${membership.externalKey} failed: ${String(error)}`,
		};
	}
	if (result.code !== 0) {
		const detail = firstNonEmptyLine(result.stderr) ?? `exit ${result.code}`;
		return {
			added: [...added],
			removed: [...removed],
			failure: `gh ${command} edit ${membership.externalKey} failed: ${detail}`,
		};
	}
	return { added: [...added], removed: [...removed] };
}
