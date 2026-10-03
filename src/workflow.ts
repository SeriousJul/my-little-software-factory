/**
 * The workflow machine's transition (ADR 0027).
 *
 * A completed turn fires the task type's transition once: the plane writes
 * the label facts on the ticket and its fixing pull request, and the machine
 * re-derives every position from the written labels. The transition names no
 * destination. The judgments read from the source at the settle (ADR 0047):
 * the review score from every comment and every review the pull request
 * carries, at the verdict's fixed line (ADRs 0053 and 0057), and the open
 * state from the pull request's own record, with the projection's last
 * refresh as the read's fallback. The branch that holds fires, and its facts
 * and pins take effect.
 *
 * The module also owns the Next step (ADR 0092): the one derivation of the
 * step a fired Transition leaves behind, and the gates that hold it. Auto-
 * handoff mode decides a settled turn from that step, not from a config flag.
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
	externalKeyNumber,
	headBranchOf,
	issueReferencesOf,
	type SourceMembership,
	type Ticket,
} from "./domain/ticket.ts";
import { firstNonEmptyLine } from "./lines.ts";
import { ticketBranchPrefix } from "./naming.ts";
import { isPlaneActionTaskType } from "./plane-action-registry.ts";
import {
	markPullRequestReady,
	pullRequestCarriesWork,
	readTicketOwnPullRequest,
} from "./pull-request.ts";
import { lookupRepositoryMapping } from "./repo.ts";
import {
	type CommandOptions,
	type CommandResult,
	type CommandRunner,
	errorMessage,
} from "./runner.ts";
import type { FactoryState, TicketProjection } from "./state.ts";
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

/**
 * The reason the fire records when the ticket's own pull request stands on
 * the branch with a head that carries no work against its base (ADR 0076):
 * the work has not landed, so nothing is published and no label is written,
 * and the ticket rests where the missing pull request rests. The test is
 * the work - the head's tree against the base's - because the plane's hold
 * commit stands on every fresh factory branch. The re-fire sweep lands the
 * labels when work appears.
 */
export const EMPTY_PULL_REQUEST_SKIP = "the pull request carries no change against its base";

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
 * The markdown a posted line wears that is not part of what it says: the
 * block markers in front of it (a heading, a list bullet, a quote, a table
 * cell) and the emphasis runs inside it. The verdict line the review agent
 * posts carries both, and neither changes the line's meaning.
 */
function withoutMarkdown(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>+\s*|\|+\s*)+/, "")
		.replace(/[*_`]+/g, "");
}

/**
 * The fixed score line: the label, at its line's start or after a lead-in
 * that ends in a mark, its separator, and its number, with an optional
 * scale. The separator is the line's colon or equals sign, or the bar of the
 * table cell a scored row carries.
 *
 * A number that names its own scale is the line's verdict, and what follows
 * the scale is the line's own prose: `Score: 74 / 100 - Specification: Pass`
 * and `Score: 74 / 100 (74 %)` carry the same verdict as the bare line. The
 * scale's own guard is that its total does not run on: `Score: 92 / 1000`
 * names a total the read does not know and reports nothing.
 *
 * A number with no scale must close its line: the line's end, its
 * punctuation, or its dash. That keeps the line's own score out of prose -
 * `Score: 92 out of 100.` writes its scale in words, which is not the line's
 * own form, and `Score: 74 points` names a thing, not a verdict.
 */
const SCORE_LINE =
	/(?:^|[\d)\]}>:;,-]\s*)(?:(?:review|total|final|overall|combined|verdict)\s+)?score\s*[:=|]\s*(\d{1,3}(?:\.\d+)?)(?:\s*(?:%|\/\s*(\d{1,3}(?:\.\d+)?))(?!\d)|(?=\s*(?:$|[,.;:!()[\]}|_\u2013\u2014-])))/gi;

/**
 * The verdict line the label stands alone on its line (ADR 0063): the line
 * is the score label - an optional lead-in that ends in a mark and an
 * optional separator - and nothing else, so the number the line below it
 * opens carries the verdict the label names.
 */
const SCORE_LABEL_LINE = /^(?:^|[\d)\]}>:;,-]\s+)score\s*[:=|]?\s*$/i;

/**
 * The number line under the label line (ADR 0063): the line opens with its
 * number, and the number carries its own scale - a percent or a total. The
 * scale is the line's own: a bare number under the label is prose the label
 * does not make a verdict of, a numbered list under it keeps its list, a
 * scale written in words is not the line's own form, and a total that runs
 * on past three digits is not a scale the read knows. What follows the scale
 * is the line's own prose.
 */
const SCORE_NUMBER_LINE = /^(\d{1,3}(?:\.\d+)?)\s*(?:%|\/\s*(\d{1,3}(?:\.\d+)?))(?!\d)/i;

/**
 * The value one scored number reports on the 100 scale: the number with no
 * scale, or its / 100 scale, stands as it is; a number out of the 0 to 100
 * range is not a score; and a number that names its own total scales to
 * the 100 the threshold stands on, so 18 of 20 is 90.
 */
function scoredValue(value: number, denominator: number | undefined): number | null {
	if (!Number.isFinite(value) || value < 0 || value > 100) return null;
	if (denominator === undefined || denominator === 100) return value;
	if (denominator > 0 && value <= denominator) return (value * 100) / denominator;
	return null;
}

/**
 * The review score a posted verdict reports; null when it carries none. The
 * seed review template's fixed line is `- **Score:** 85 / 100`, and the line
 * is the contract: the score label, its separator, and its number. The read
 * takes the line under the markdown the post wears around it (ADR 0057): a
 * heading's `##`, a list bullet, the emphasis run inside the label, the
 * colon written inside the bold instead of outside it, and the number's
 * scale written as `/ 100`, `/100`, or `%`.
 *
 * The label still decides what is a score line and what is not, so a number
 * named in prose stays out of the judgment: `the mutation score: 79.48 %`
 * names its number after a word, and `Score: 92 out of 100.` writes its
 * scale in words rather than in the line's own form. The label is read only
 * at the start of its line or after a lead-in that ends in a mark, and a
 * number out of the 0 to 100 range is not a score at all.
 *
 * When the line appears more than once, the last one is the verdict: the
 * agent restates the score after the final pass, and the earlier lines are
 * scratch.
 *
 * The label also stands alone on its line: the line is the label - an
 * optional lead-in that ends in a mark and an optional separator - and
 * nothing else, and the number the next spoken line opens carries its own
 * scale, a percent or a total. That is the verdict the agent posts under a
 * Score heading, the number bolded and the prose after it (ADR 0063). The
 * number line must carry its own scale: a bare number under the label is
 * prose, a scale written in words is not the line's own form, and a
 * numbered list under the label keeps its list.
 */
export function scoreFromMessage(message: string): number | null {
	let score: number | null = null;
	const lines = message.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = withoutMarkdown(lines[i]);
		for (const match of line.matchAll(SCORE_LINE)) {
			const value = scoredValue(
				Number(match[1]),
				match[2] === undefined ? undefined : Number(match[2]),
			);
			if (value !== null) score = value;
		}
		// The verdict under its label line (ADR 0063): the line is the label
		// alone, and the number the next spoken line opens carries its own
		// scale. Blank lines part the pair; a spoken line between the label
		// and its number breaks it. The pair decides on its number line, so
		// the last verdict in the body stands in either shape.
		if (SCORE_LABEL_LINE.test(line)) {
			for (let j = i + 1; j < lines.length; j += 1) {
				const next = withoutMarkdown(lines[j]);
				if (next.trim() === "") continue;
				const match = SCORE_NUMBER_LINE.exec(next);
				if (match !== null) {
					const value = scoredValue(
						Number(match[1]),
						match[2] === undefined ? undefined : Number(match[2]),
					);
					if (value !== null) score = value;
				}
				break;
			}
		}
	}
	return score === null || Number.isInteger(score) ? score : Math.round(score);
}

/** Whether the transition's branches test a score judgment. */
function transitionReadsScore(transition: WorkflowTransition): boolean {
	return (transition.branches ?? []).some(
		(branch) => branch.when === "score-above-threshold" || branch.when === "score-below-threshold",
	);
}

/**
 * The score threshold the workflow's score judgment stands on (ADR 0078):
 * the first task type whose transition tests a score judgment carries it,
 * because config validation makes the threshold present when a transition
 * tests a score. The rework prompt's verdict read decides the pass against
 * it. Undefined when no transition tests a score: the verdict fill keeps
 * the body it stood under before the threshold joined it.
 */
export function workflowScoreThreshold(config: FactoryConfig): number | undefined {
	for (const task of Object.values(config.taskTypes)) {
		const transition = task.transition;
		if (transition === undefined) continue;
		if (transitionReadsScore(transition)) return transition.scoreThreshold;
	}
	return undefined;
}

/** Whether the transition's branches test the pull request's open state. */
function transitionReadsPullRequestState(transition: WorkflowTransition): boolean {
	return (transition.branches ?? []).some(
		(branch) => branch.when === "pull-request-open" || branch.when === "pull-request-closed",
	);
}

/**
 * The posting timeline a verdict record stands on: the pull request's
 * issue comments or its reviews.
 */
export type VerdictTimeline = "comment" | "review";

/**
 * The review verdict (ADR 0074): the newest post on a pull request's
 * comment and review timelines that carries the review template's fixed
 * score line, with its posting timeline beside its body and its time.
 */
export interface ReviewVerdict {
	/** The posting timeline the record stands on. */
	timeline: VerdictTimeline;
	/** The post's time, as the source answers it. */
	at: string;
	/** The post's body, unchanged. */
	body: string;
}

/**
 * The outcome of the review verdict read: the record that stands, the fact
 * that no record carries the fixed score line, or the failure with the
 * read's reason when every timeline's read fails.
 */
export type ReviewVerdictRead =
	| { kind: "verdict"; verdict: ReviewVerdict }
	| { kind: "none" }
	| { kind: "failed"; reason: string };

/**
 * The review verdict the pull request's posts carry (ADR 0047, ADR 0053,
 * ADR 0057, ADR 0063, ADR 0074): the newest record that carries the
 * template's fixed score line on the pull request's comment and review
 * timelines. The score judgment at settle and the rework prompt at handoff
 * run this one read, so the two points never decide on different records
 * for the same posts. A review turn posts its verdict as a comment or
 * through its review, and the rule decides on what the agent posted, not on
 * the posting path it chose. The records are read straight from the source,
 * not from the projection: the review posts its verdict to the pull request,
 * and that post is the durable record. Each timeline is read whole - the
 * walk covers every page, because GitHub answers a long thread oldest first
 * and the verdict is the newest post. A read that fails on one timeline
 * contributes nothing, and the records that stand decide. Every timeline's
 * read failing is the failure fact, with the read's reason. No membership,
 * no pull request number, no resolvable source, or no record carrying the
 * fixed score line is the none fact: the read found no verdict.
 */
export async function readReviewVerdict(
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	pullRequest: Ticket,
): Promise<ReviewVerdictRead> {
	const membership = newestMembership(pullRequest.memberships);
	if (membership === undefined) return { kind: "none" };
	const number = externalKeyNumber(membership.externalKey);
	if (number === null) return { kind: "none" };
	const source = sources.find((item) => item.name === membership.sourceName);
	if (source === undefined) return { kind: "none" };
	let ghOptions: CommandOptions = {};
	if (source.auth !== undefined) {
		const resolved = await new GhAuthenticator(
			source.host,
			source.auth,
			runner,
			process.env,
		).resolve();
		if (!resolved.ok) return { kind: "none" };
		ghOptions = resolved.options;
	}
	const repository = membership.repository.displayName;
	const [comments, reviews] = await Promise.all([
		readVerdictTimeline(
			runner,
			source,
			ghOptions,
			`repos/${repository}/issues/${number}/comments?per_page=100`,
			"created_at",
			"comment",
		),
		readVerdictTimeline(
			runner,
			source,
			ghOptions,
			`repos/${repository}/pulls/${number}/reviews?per_page=100`,
			"submitted_at",
			"review",
		),
	]);
	if (comments.records === undefined && reviews.records === undefined) {
		// Every timeline's read failed: the failure is the fact, and the
		// timelines' read reasons stand beside it.
		return {
			kind: "failed",
			reason: `the comment read failed (${comments.reason}); the review read failed (${reviews.reason})`,
		};
	}
	// Newest first across both timelines: the latest record is the one the
	// rule reads.
	const records = [...(comments.records ?? []), ...(reviews.records ?? [])].sort((a, b) =>
		b.at.localeCompare(a.at),
	);
	for (const record of records) {
		if (scoreFromMessage(record.body) !== null) return { kind: "verdict", verdict: record };
	}
	return { kind: "none" };
}

/**
 * One verdict timeline the shared read collects: the pull request's
 * comments or its reviews, each record as its body, its time, and its
 * posting timeline. The read walks every page of its timeline, so a verdict
 * on a long thread is in the list the rule sorts. The failure answer
 * carries the read's reason: the other timeline's records still stand, and
 * every timeline failing is the failure fact.
 */
async function readVerdictTimeline(
	runner: CommandRunner,
	source: TicketSourceConfig,
	ghOptions: CommandOptions,
	path: string,
	timeField: "created_at" | "submitted_at",
	timeline: VerdictTimeline,
): Promise<{ records?: ReviewVerdict[]; reason?: string }> {
	let result: CommandResult;
	try {
		result = await runner.run(
			"gh",
			["api", "--paginate", "--hostname", source.host, path],
			ghOptions,
		);
	} catch (error) {
		return { reason: `the ${timeline} read raised: ${errorMessage(error)}` };
	}
	if (result.code !== 0)
		return { reason: firstNonEmptyLine(result.stderr) ?? `exit ${result.code}` };
	let list: unknown;
	try {
		list = JSON.parse(result.stdout);
	} catch {
		return { reason: `the ${timeline} read answered no list` };
	}
	if (!Array.isArray(list)) return { reason: `the ${timeline} read answered no list` };
	return {
		records: (list as Array<{ body?: unknown; created_at?: unknown; submitted_at?: unknown }>)
			.filter(
				(record): record is { body: string; created_at?: unknown; submitted_at?: unknown } =>
					typeof record.body === "string",
			)
			.map((record) => ({ timeline, body: record.body, at: String(record[timeField] ?? "") })),
	};
}

/**
 * The review score the pull request's verdicts carry: the score the shared
 * verdict read's record reports (ADR 0074). Null when the read found no
 * verdict: no record carries the fixed score line, a read fails on every
 * timeline it answers, or the source cannot be resolved. The records are
 * read straight from the source, not from the projection: the review posts
 * its verdict to the pull request, and that post is the durable record the
 * judgment reads.
 */
async function readPullRequestScore(
	request: FireTransitionRequest,
	pullRequest: Ticket,
): Promise<number | null> {
	const read = await readReviewVerdict(request.runner, request.config.sources, pullRequest);
	if (read.kind !== "verdict") return null;
	return scoreFromMessage(read.verdict.body);
}

/**
 * The pull request's open and merged facts, read straight from the source:
 * the pull's own REST record, live the moment a merge or close lands. The
 * projection's state is the last refresh's, and the search index still lists
 * a merged pull request as open for a while after the merge: the judgment of
 * the turn that merged the pull request must not decide on that, and the
 * merge action's fresh read must not run a merge on a pull request that is
 * already merged (ADR 0068). Null when the key names no number, the source
 * cannot be resolved, the read fails, or the answer carries no state the
 * readers take: the fire falls back to the projection's fact for a null, and
 * the merge runs its command for one.
 */
export interface PullRequestOpenRead {
	/** Whether the pull request is open. */
	open: boolean;
	/** Whether the pull request is merged. */
	merged: boolean;
}

export async function readPullRequestOpenRecord(
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	pullRequest: Ticket,
): Promise<PullRequestOpenRead | null> {
	const membership = newestMembershipOf(pullRequest);
	const number = externalKeyNumber(membership.externalKey);
	if (number === null) return null;
	const source = sources.find((item) => item.name === membership.sourceName);
	if (source === undefined) return null;
	let ghOptions: CommandOptions = {};
	if (source.auth !== undefined) {
		const resolved = await new GhAuthenticator(
			source.host,
			source.auth,
			runner,
			process.env,
		).resolve();
		if (!resolved.ok) return null;
		ghOptions = resolved.options;
	}
	const path = `repos/${membership.repository.displayName}/pulls/${number}`;
	let result: CommandResult;
	try {
		result = await runner.run("gh", ["api", "--hostname", source.host, path], ghOptions);
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
	if (item.merged === true) return { open: false, merged: true };
	if (item.state === "open") return { open: true, merged: false };
	if (item.state === "closed") return { open: false, merged: false };
	return null;
}

/**
 * Whether the pull request is still open, read straight from the source: the
 * direct read's open fact, the way the record read carries it.
 */
async function readPullRequestOpen(
	request: FireTransitionRequest,
	pullRequest: Ticket,
): Promise<boolean | null> {
	const read = await readPullRequestOpenRecord(request.runner, request.config.sources, pullRequest);
	return read === null ? null : read.open;
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
	/**
	 * The stop the fire's owner checks between its reads (ADR 0068): a stop
	 * over the fire's commands closes the state behind it, and a projection
	 * the fire reads after the stop is a closed database.
	 */
	stopped?: () => boolean;
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
	// The stop over the fire's refresh: the state closed behind it, and the
	// projection read below is a closed database. The check and the read are
	// one synchronous step, so a stop between them cannot land.
	if (request.stopped?.() === true) return null;
	// The fire reads the projection before the list rule (ADR 0042): the rule
	// withholds a covered ticket's row from the operator's list, and the
	// machine's fire must still reach the ticket it acts on.
	const tickets = request.state.projectedTickets(
		request.config.workflowStates,
		request.config.defaultTaskType,
	);
	const ticket = tickets.find((item) => item.identity === request.ticketIdentity);
	if (ticket === undefined) return null;
	let pullRequest =
		ticket.sourceKind === "github-pull-request" ? ticket : findFixingPullRequest(tickets, ticket);
	// The pull request publish (ADR 0076): a completed turn of a task type
	// that opens a pull request reaches the ticket's own draft through the
	// direct head-branch read, because a draft the machine has not labeled
	// never stands in the ticket list. The work test of the head against the
	// base comes before the publish: a head that carries no work against its
	// base - the plane's hold commit included - is the missing pull request,
	// on the skip's own reason.
	const opensPullRequest =
		request.config.taskTypes[request.taskType]?.opensPullRequest === true &&
		ticket.sourceKind !== "github-pull-request";
	let emptyOwnPullRequest = false;
	if (opensPullRequest) {
		const own = await readTicketOwnPullRequest(request.runner, request.config.sources, ticket);
		const ownHead = own === null ? null : headBranchOf(own.memberships[0]?.attributes ?? {});
		const ownBase = own === null ? null : (own.memberships[0]?.attributes.baseBranch ?? null);
		// The checkout by the plane's own resolution rule: the case-insensitive
		// lookup over the identity and the display name the handoff and the
		// init read, so a key the operator wrote in another case than the
		// canonical identity still names its checkout.
		const checkout = lookupRepositoryMapping(request.config.repos, [
			ticket.repositoryRef.identity,
			ticket.repositoryRef.displayName,
		]);
		const work =
			own === null || ownHead === null || ownBase === null || checkout === undefined
				? null
				: await pullRequestCarriesWork(request.runner, checkout, ownHead, ownBase);
		if (own === null) {
			pullRequest = null;
		} else if (work !== true) {
			emptyOwnPullRequest = true;
			pullRequest = null;
		} else {
			pullRequest = own;
		}
	}
	// The review verdict is the pull request's own post, the place the review
	// template names for the score: a comment or a review body. It is read
	// only when this transition tests a score judgment and only for a pull
	// request that is there to read.
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
	// The publish stands before the label write (ADR 0076): the draft the
	// plane opened is marked ready for review, so the machine can act on it
	// and the list can hold it, before the fire writes the facts it named.
	// The act runs only for a task type that opens a pull request, and only
	// on a draft: a pull request that is not a draft stands as it stands,
	// and the fire never converts a pull request back to a draft.
	if (opensPullRequest && pullRequest !== null && isDraft(pullRequest)) {
		const number = externalKeyNumber(pullRequest.externalKey);
		const membership = newestMembershipOf(pullRequest);
		const source = request.config.sources.find((item) => item.name === membership.sourceName);
		if (number !== null && source !== undefined) {
			const readyFailure = await markPullRequestReady(
				request.runner,
				source,
				pullRequest.repositoryRef,
				number,
			);
			if (readyFailure !== null) {
				outcome.writeFailure = `marking the pull request ready for review failed: ${readyFailure}`;
				return outcome;
			}
		}
	}
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
	// instead derives no Next step on the ticket's own state, re-firing the
	// same transition on the next turn while the pull request is still
	// missing.
	const missingPullRequest = pullRequest === null && evaluation.pullRequestFacts.length > 0;
	if (missingPullRequest) outcome.reason = NO_LINKED_PULL_REQUEST_SKIP;
	// The empty pull request records its own reason: the Decision screen
	// states why nothing was published, and the re-fire sweep re-fires this
	// skip the way it re-fires the missing one (ADR 0076).
	if (emptyOwnPullRequest) outcome.reason = EMPTY_PULL_REQUEST_SKIP;
	for (const target of surfaces) {
		const write = await writeSurfaceLabels(request, target, machine);
		const applied = applyWrite(outcome, write);
		if (target.kind === "ticket") outcome.ticketWrite = applied;
		else outcome.pullRequestWrite = applied;
	}
	// A failed write stands as the failure fact; the plane does not re-derive
	// a position from labels it did not manage to write.
	if (outcome.writeFailure !== "") return outcome;
	// The fire's convergence (ADR 0079): a write that took lands on the
	// projection's labels at once, so the position the machine derives stands
	// on the labels the machine wrote, not on the labels the source last
	// fetched. The blocked merge is the case the convergence exists for: the
	// block's `needs-work` write leaves the position offering the merge for a
	// whole refresh without it, and the top-up and the operator both read
	// that position. The source's next refresh overwrites the set with its
	// own truth, the way it overwrites every fact the projection holds.
	for (const target of surfaces) {
		const write = target.kind === "ticket" ? outcome.ticketWrite : outcome.pullRequestWrite;
		if (write !== null)
			request.state.convergeMembershipLabels(
				target.ticket.identity,
				postWriteLabels(target.ticket.labels, write),
			);
	}
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
					// The position stands on the identity the source gives the
					// pull request (ADR 0076): the identity the direct read
					// synthesized resolves to the source's, and the consumers
					// look the position up by it.
					const sourceIdentity = await sourceIdentityOfOwnPullRequest(
						request,
						pullRequest,
						opensPullRequest,
					);
					if (sourceIdentity !== null) outcome.positionTicketIdentity = sourceIdentity;
				}
				break;
			}
		}
	}
	return outcome;
}

/**
 * The identity the source gives the pull request the fire's direct read
 * synthesized (ADR 0076).
 *
 * The direct head-branch read builds the pull request's identity from its
 * own record - a form the Stub source happens to answer, but the source a
 * real host runs answers its own global id. The consumers that look the
 * position up in the projection - the auto top-up's walk, the Decision
 * modal's route and merge rows - read the source's id. The publish's ready
 * mark made the pull request listable, and the fire's refresh lands it, so
 * the identity the read gave resolves to the identity the source gives: the
 * pull request the projection lists on the same repository, read by the head
 * branch the read carried. Null when the fire read its pull request from the
 * projection itself - a task type that opens no pull request, or a position
 * on the ticket - and the position keeps the identity it already carries. Null
 * also when the projection lists no such pull request - a source that still
 * withholds it - or a stop closed the state behind the read: the position
 * keeps the identity the read gave, and the consumers read it as they read it.
 */
async function sourceIdentityOfOwnPullRequest(
	request: FireTransitionRequest,
	pullRequest: Ticket | null,
	opensPullRequest: boolean,
): Promise<string | null> {
	if (!opensPullRequest || pullRequest === null) return null;
	if (request.stopped?.() === true) return null;
	const headBranch = headBranchOf(pullRequest.memberships[0]?.attributes ?? {});
	if (headBranch === null) return null;
	// The refresh the position waits on: it lists the pull request the
	// publish made ready, the way the fire's first refresh listed the ticket.
	await request.refresh?.();
	if (request.stopped?.() === true) return null;
	const tickets = request.state.projectedTickets(
		request.config.workflowStates,
		request.config.defaultTaskType,
	);
	const listed = tickets.find(
		(item) =>
			item.sourceKind === "github-pull-request" &&
			item.repositoryRef.identity === pullRequest.repositoryRef.identity &&
			headBranchOf(item.memberships[0]?.attributes ?? {}) === headBranch,
	);
	return listed === undefined ? null : listed.identity;
}

/** The request the plane action's outcome fire needs (ADR 0068). */
export interface FirePlaneActionOutcomeRequest extends FireTransitionRequest {
	/** The attempt the fire's fact lands on. */
	attempt: { id: string; ticketIdentity: string; taskType: string };
}

/**
 * Fire the plane action's task type transition on the action's outcome
 * (ADR 0068).
 *
 * The merge runs with no agent, so no Completion trace stands for it: the
 * fire is the action's own, and its fact lands on the attempt's record. The
 * fire runs on both outcomes alike - a merged pull request and a blocked
 * one - through the same path a settle-time fire takes: the fresh source
 * read with the projection's last refresh as the fallback, the branch
 * selection on the read's facts, and the label writes. The record is
 * conditional: an attempt that already carries its outcome keeps it, so a
 * fire that runs twice - the crash-restart of a blocked merge - writes the
 * fact once, the way the label writes it converges.
 */
export async function firePlaneActionOutcome(
	request: FirePlaneActionOutcomeRequest,
): Promise<TransitionOutcome | null> {
	const outcome = await fireTransition(request);
	// The stop over the fire's label reads: the fact lands on the attempt's
	// record only while the state stands, the way the fire's reads do.
	if (outcome !== null && request.stopped?.() !== true)
		request.state.recordPlaneActionAttemptOutcome(request.attempt.id, outcome);
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
	/**
	 * The forced refresh of the pull request sources; omitted in tests. The
	 * fire the sweep runs is the settle-time fire's kind: it refreshes before
	 * it reads, and the publish it runs lands the pull request the refresh
	 * then lists.
	 */
	refresh?: () => Promise<void>;
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
 * can tell a re-fired outcome from a settle-time one, and route the Next step
 * the skip's closed cycle never took. A fire that finds no
 * transition at all returns nothing and the sweep reads it again next cycle
 * with no command; any outcome the fire produced, a fact it refused with
 * included, lands on the trace once, the way a settle-time outcome does.
 *
 * The sweep reads the projection the loop's refresh just landed, so it takes
 * no refresh of its own: the projection it walks is fresh. The fire it runs
 * carries the refresh the caller gives it, the way the settle-time fire does
 * (ADR 0076): the publish the fire runs makes the pull request listable, and
 * the refresh the fire's position waits on lists it, so the position stands
 * on the identity the source gives it.
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
		if (
			skip.fired !== true ||
			(skip.reason !== NO_LINKED_PULL_REQUEST_SKIP && skip.reason !== EMPTY_PULL_REQUEST_SKIP)
		)
			continue;
		// A pull request ticket is its own fixing pull request: its fire can
		// never record the skip, and the re-fire reads the issue side of the
		// link only.
		if (ticket.sourceKind === "github-pull-request") continue;
		// The awaiting walk keeps the row of a ticket that left every source,
		// so the sweep checks the snapshot itself: the re-fire refuses a
		// ticket its source no longer lists, the way the fire refuses a
		// ticket that left the list.
		if (!request.state.stillListed(ticket.identity)) continue;
		if (request.config.taskTypes[completion.taskType]?.opensPullRequest === true) {
			// The sweep's existence check is the direct head-branch read for a
			// task type that opens a pull request (ADR 0076): a draft with
			// commits still never stands in any projection, labeled or not.
			const own = await readTicketOwnPullRequest(request.runner, request.config.sources, ticket);
			if (own === null) continue;
		} else {
			// The machine acts on the newest non-draft open pull request that
			// fixes the ticket: without one standing now, the skip stands as
			// recorded.
			if (findFixingPullRequest(tickets, ticket) === null) continue;
		}
		const outcome = await fireTransition({
			config: request.config,
			state: request.state,
			runner: request.runner,
			ticketIdentity: ticket.identity,
			taskType: completion.taskType,
			refresh: request.refresh,
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

/**
 * The Next step a settled turn's Transition derives (ADR 0092).
 *
 * The step is the one fact Auto-handoff mode decides a settled turn from: the
 * task type the written labels put the ticket on, the ticket that position
 * stands on, and whether the step runs as a Handoff or as a Plane action. The
 * position is derived, never stored, so the step also carries the gate that
 * holds it when it will not run: the position no longer offers the task, the
 * position is not actionable, the Same-type hold, or the Handoff limit.
 *
 * One derivation serves every reader - the automatic Completion rule, the
 * top-up's continuation walks, and the Decision screen's fact line - so no
 * reader holds its own copy of the gates, and no screen offers a step the
 * machine will not take without saying why.
 */

/**
 * Why a Next step stands while the machine will not run it (ADR 0092).
 *
 * The keys live here, beside the gates the derivation reads, and so do the
 * sentences that state them. Two surfaces read them: the Decision screen's fact
 * line, and the Message line that states a held step in Auto-handoff mode. The
 * module that owns the gates owns the words for them, so neither surface holds a
 * copy and no machine module reaches into the presentation layer for a sentence.
 */
export const NEXT_STEP_GATES = [
	"position-offers-no-task",
	"position-not-actionable",
	"same-type-hold",
	"handoff-limit",
] as const;

export type NextStepGate = (typeof NEXT_STEP_GATES)[number];

/** The sentence each gate is stated in, on either surface that names it. */
export const NEXT_STEP_GATE_LINES: Readonly<Record<NextStepGate, string>> = {
	"position-offers-no-task": "the position no longer offers the task",
	"position-not-actionable": "the position is not actionable",
	"same-type-hold": "the Same-type hold stands on the position",
	"handoff-limit": "the position is at the handoff limit",
};

/** The channel a Next step runs on: the task type's own form (ADR 0068). */
export const NEXT_STEP_KINDS = ["handoff", "plane-action"] as const;
export type NextStepKind = (typeof NEXT_STEP_KINDS)[number];

/** The step a settled turn's Transition derived (ADR 0092). */
export interface NextStep {
	/** The task type the derived position offers. */
	taskType: string;
	/** The ticket the derived position stands on. */
	ticketIdentity: string;
	/** Whether the step is a Handoff or a Plane action. */
	kind: NextStepKind;
	/** The gate that holds the step; null when the machine can run it. */
	gate: NextStepGate | null;
}

/**
 * Derive the Next step of one Transition outcome.
 *
 * The step exists when the fire ran and its label facts landed on a position
 * that offers a task: a fire that did not run, a fire whose write failed, and
 * a fire that lands on a parking state derive none, and the cycle closes where
 * the machine put the ticket.
 *
 * The gates are read on the position the step names, not on the ticket the
 * settled turn ran on: the step starts its work on the position, so the
 * position's standing, its hold, and its limit are the ones that hold it.
 *
 * `projection` is the Ticket projection read the caller already holds, before
 * the list rule (ADR 0042): the position can be a ticket the operator's list
 * withholds. Every caller holds a read of its own - the observation cycle reads
 * its pile once and hands it down - so the derivation never pays for a scan by
 * accident. It is a value the state makes, never an array a caller builds: a
 * read that holds no row is a fact about the tickets, not a mistake at the call
 * site.
 */
export function deriveNextStep(
	config: FactoryConfig,
	state: FactoryState,
	outcome: TransitionOutcome,
	projection: TicketProjection,
): NextStep | null {
	if (outcome.fired !== true) return null;
	// A label write the plane did not make derives no position: the fire returns
	// before it computes one, and the machine does not route from labels it did
	// not write.
	if (outcome.writeFailure !== "") return null;
	if (outcome.positionTaskType === null || outcome.positionTicketIdentity === null) return null;
	const taskType = outcome.positionTaskType;
	const ticketIdentity = outcome.positionTicketIdentity;
	const step: NextStep = {
		taskType,
		ticketIdentity,
		kind: isPlaneActionTaskType(config.taskTypes, taskType) ? "plane-action" : "handoff",
		gate: null,
	};
	const position = projection.rowFor(ticketIdentity);
	// The position is derived, never stored: between the write and the start the
	// ticket can leave its source, and a refresh can move it off the task the
	// fire wrote.
	if (position === undefined || position.suggestedTaskType !== taskType) {
		step.gate = "position-offers-no-task";
		return step;
	}
	// The position's standing, in one test. An awaiting position is the ticket
	// whose own turn just settled, and the claim check at the ask owns its
	// standing, so the open ticket's health is not demanded of it; an in-flight
	// position holds a seat, and a closed one is gone. The unfinished attempt is
	// folded into the open position's `actionable` by the projection.
	if (position.state !== "open" && position.state !== "awaiting") {
		step.gate = "position-not-actionable";
		return step;
	}
	if (position.state === "open" && !position.actionable) {
		step.gate = "position-not-actionable";
		return step;
	}
	if (state.sameTypeHoldActive(position.identity, taskType)) {
		step.gate = "same-type-hold";
		return step;
	}
	if (position.handoffCount >= config.maxHandoffsPerTicket) {
		step.gate = "handoff-limit";
		return step;
	}
	return step;
}
