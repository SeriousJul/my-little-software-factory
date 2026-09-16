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
import type { CommandResult, CommandRunner } from "./runner.ts";
import {
	issueReferencesOf,
	type EnvironmentKind,
	type SourceMembership,
	type Ticket,
} from "./domain/ticket.ts";
import type {
	FactoryConfig,
	TransitionBranch,
	TransitionJudgment,
	TransitionOutcome,
	WorkflowTransition,
} from "./config.ts";
import type { FactoryState } from "./state.ts";
import { firstNonEmptyLine } from "./lines.ts";
import { membershipMatchesState } from "./task-selection.ts";

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
	if (input.score === null && (tested.has("score-above-threshold") || tested.has("score-below-threshold"))) {
		return { ...base, reason: "the completion message carries no score" };
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
 */
export function scoreFromMessage(message: string): number | null {
	let match = /\*\*score:\*\*\s*(\d{1,3})/i.exec(message);
	if (match === null) match = /\bscore\b[:\s]+(\d{1,3})/i.exec(message);
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * The machine's workflow label set: every label a state match names in its
 * all or any set, and every label a transition or branch writes. A label
 * outside the set is not a workflow label, and a write never removes it.
 * The none set names what keeps a ticket out of a state, not what the
 * machine owns.
 */
export function workflowLabelSet(config: FactoryConfig): ReadonlySet<string> {
	const labels = new Set<string>();
	for (const state of config.workflowStates) {
		for (const label of [
			...(state.match.labelsAll ?? []),
			...(state.match.labelsAny ?? []),
		])
			labels.add(label.toLocaleLowerCase());
	}
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
	return newestMembershipOf(ticket).attributes["draft"] === "true";
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
	/** The settled turn's last message: the score judgment reads it. */
	message: string;
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
export async function fireTransition(request: FireTransitionRequest): Promise<TransitionOutcome | null> {
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
	const score = scoreFromMessage(request.message);
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
	const machine = workflowLabelSet(request.config);
	const ticketWrite = await writeSurfaceLabels(
		request,
		"issue",
		ticket,
		evaluation.ticketFacts,
		machine,
	);
	outcome.ticketWrite = applyWrite(outcome, ticketWrite);
	if (pullRequest !== null && pullRequest.identity !== ticket.identity) {
		const pullWrite = await writeSurfaceLabels(
			request,
			"pr",
			pullRequest,
			evaluation.pullRequestFacts,
			machine,
		);
		outcome.pullRequestWrite = applyWrite(outcome, pullWrite);
	} else if (pullRequest !== null) {
		// The ticket is the pull request: one surface, one write.
		outcome.pullRequestWrite = outcome.ticketWrite;
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
	// nothing on it, so the position offers no handoff.
	for (const state of request.config.workflowStates) {
		if (membershipMatchesState(pseudo, state)) {
			if (state.taskType !== undefined) {
				outcome.positionTaskType = state.taskType;
				outcome.positionTicketIdentity = surface.identity;
			}
			break;
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
 * Write one surface's label facts through the command runner (ADR 0027):
 * add the facts the surface does not wear, remove the machine's labels the
 * facts do not name. Returns the write that ran, null when nothing had to
 * change, and the failure as a fact when the command failed.
 */
async function writeSurfaceLabels(
	request: FireTransitionRequest,
	kind: "issue" | "pr",
	surface: Ticket,
	facts: readonly string[],
	machine: ReadonlySet<string>,
): Promise<{ added: string[]; removed: string[]; failure?: string } | null> {
	const have = new Set(surface.labels.map((label) => label.toLocaleLowerCase()));
	const factSet = new Set(facts.map((label) => label.toLocaleLowerCase()));
	const added = facts.filter((label) => !have.has(label.toLocaleLowerCase()));
	const removed = surface.labels.filter(
		(label) => machine.has(label.toLocaleLowerCase()) && !factSet.has(label.toLocaleLowerCase()),
	);
	if (added.length === 0 && removed.length === 0) return null;
	const membership = newestMembershipOf(surface);
	const host =
		request.config.sources.find((source) => source.name === membership.sourceName)?.host ??
		"github.com";
	const args: string[] = [kind, "edit", membership.externalKey];
	if (host !== "github.com") args.push("--hostname", host);
	args.push("--repo", membership.repository.displayName);
	if (added.length > 0) args.push("--add-label", added.join(","));
	if (removed.length > 0) args.push("--remove-label", removed.join(","));
	let result: CommandResult;
	try {
		result = await request.runner.run("gh", args);
	} catch (error) {
		return { added, removed, failure: `gh ${kind} edit ${membership.externalKey} failed: ${String(error)}` };
	}
	if (result.code !== 0) {
		const detail = firstNonEmptyLine(result.stderr) ?? `exit ${result.code}`;
		return { added, removed, failure: `gh ${kind} edit ${membership.externalKey} failed: ${detail}` };
	}
	return { added, removed };
}
