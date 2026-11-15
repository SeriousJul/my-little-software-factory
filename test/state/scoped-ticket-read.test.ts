/**
 * The scoped ticket read suite (issue #428, ADR 0151): the ticket work
 * cycle's scoped read answers the same row value the full projection makes
 * for the identity, in every state the plane decides on, and it answers the
 * ticket's pull request link. The link's rows are the pull request rows the
 * ticket's repositories list, and the suite pins the split that restriction
 * causes beside the full-array rule (ADR 0151). The read costs a constant
 * number of statements that does not grow with the record's ticket count, and
 * the full projection keeps its statement count.
 *
 * Every case runs on the shared state harness: real state on a real store.
 * The statement-count pins count the statements a read prepares, the outside
 * measurement of the read's cost.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { FetchedTicket, IssueReference, Ticket } from "../../src/domain/ticket.ts";
import { withHeadBranch, withIssueReferences } from "../../src/domain/ticket.ts";
import { branchNameFor } from "../../src/naming.ts";
import type { FactoryState } from "../../src/state.ts";
import { fixingPullRequests, isCoveredByFixingPullRequest } from "../../src/workflow.ts";
import { DEFAULT_REPOSITORY, fetchedTicket, fetchSuccess } from "../fact-fixtures.ts";
import {
	claim,
	cleanup,
	fetched,
	seeded,
	settleAttempt,
	sourceA,
	success,
	turn,
} from "./harness.ts";

afterEach(() => cleanup());

const pulls = { name: "pulls", kind: "github-pull-requests" };
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_7";
const otherRepository = {
	identity: "github.com/acme/other",
	displayName: "acme/other",
	cloneUrl: "https://github.com/acme/other.git",
};

const reference: IssueReference = {
	identity: issueIdentity,
	number: 5,
	repository: DEFAULT_REPOSITORY.displayName,
};

/** One open pull request ticket on the sample repository, attributes named. */
function pullFetched(
	attributes: Record<string, string>,
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	return fetchedTicket({
		identity: pullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#7",
		url: "https://github.com/acme/factory/pull/7",
		labels: [],
		attributes,
		...over,
	});
}

/** The full projection's row for the identity; throws when no row stands. */
function projectionRow(state: FactoryState, identity: string): Ticket {
	const ticket = state.ticketWorkCycle.ticketProjection([], "implement").rowFor(identity);
	if (ticket === undefined) throw new Error(`no row stands for ${identity} in the projection`);
	return ticket;
}

/** The ticket listed, with the open pull request on its factory head branch. */
function factoryBranchWorld(draft: "true" | "false") {
	const { state } = seeded();
	state.sourceFact.initializeSources([sourceA, pulls]);
	state.sourceFact.applyFetch(sourceA, success([fetched()]));
	const ticket = projectionRow(state, issueIdentity);
	const branch = branchNameFor({ externalKey: ticket.externalKey, title: ticket.title });
	state.sourceFact.applyFetch(
		pulls,
		fetchSuccess([pullFetched(withHeadBranch({ draft }, branch))]),
	);
	return state;
}

/** A file of the named ticket count, on the sample source. */
function fileOf(count: number) {
	const tickets: FetchedTicket[] = [];
	for (let number = 1; number <= count; number += 1)
		tickets.push(fetched(`github:github.com:I_${number}`));
	return tickets;
}

/** Count the statements a body prepares on the store's database. */
function countStatements<T>(body: () => T): { result: T; statements: number } {
	const prepare = Database.prototype.prepare;
	let statements = 0;
	Database.prototype.prepare = function (this: Database, sql: string) {
		statements += 1;
		return prepare.call(this, sql);
	} as typeof prepare;
	try {
		return { result: body(), statements };
	} finally {
		Database.prototype.prepare = prepare;
	}
}

describe("the scoped ticket read's row stands on the projection's row", () => {
	test("a listed ticket answers the same row value", () => {
		const { state } = seeded();
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		expect(read.pullRequestLink.fixing).toEqual([]);
		expect(read.pullRequestLink.opened).toBeNull();
		state.close();
	});

	test("a covered ticket answers its withheld row, beside the link that covers it", () => {
		const { state } = seeded();
		state.sourceFact.initializeSources([sourceA, pulls]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(
			pulls,
			fetchSuccess([pullFetched(withIssueReferences({}, [reference]))]),
		);
		const projected = state.ticketWorkCycle.projectedTickets([], "implement");
		const item = projected.find((ticket) => ticket.identity === issueIdentity);
		if (item === undefined) throw new Error("the ticket is missing from the projection");
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		// The list rule withholds the covered ticket, and the scoped read
		// answers the row the rule withholds, the same value the projection holds.
		expect(
			state.ticketWorkCycle.ticketListViews([], "implement").rows.map((ticket) => ticket.identity),
		).toEqual([pullIdentity]);
		if (read.ticket === null)
			throw new Error("the scoped read answers no row for the covered ticket");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		// The link answers what the full-array rule answered, and the covered
		// rule holds on the link's narrowed input.
		expect(read.pullRequestLink.fixing.map((ticket) => ticket.identity)).toEqual(
			fixingPullRequests(projected, item).map((ticket) => ticket.identity),
		);
		expect(isCoveredByFixingPullRequest(read.ticket, read.pullRequestLink.fixing)).toBe(true);
		state.close();
	});

	test("an in-flight ticket the sources dropped answers its standing row", () => {
		const { state } = seeded();
		const attemptId = claim(state, issueIdentity);
		settleAttempt(state, attemptId);
		state.sourceFact.applyFetch(sourceA, success([]));
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		expect(read.pullRequestLink.fixing).toEqual([]);
		state.close();
	});

	test("an awaiting ticket answers its standing row", () => {
		const { state } = seeded();
		const attemptId = claim(state, issueIdentity);
		settleAttempt(state, attemptId);
		turn(state, issueIdentity, attemptId);
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		expect(read.ticket).not.toBeNull();
		state.close();
	});

	test("an ignored ticket answers its standing row", () => {
		const { state } = seeded();
		const ignored = state.ticketWorkCycle.setTicketIgnored(issueIdentity, true);
		if (!ignored.ok) throw new Error(ignored.reason);
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		state.close();
	});

	test("a muted ticket answers its standing row", () => {
		const { state } = seeded();
		const muted = state.sourceFact.setSourceMuted(sourceA.name, true);
		if (!muted.ok) throw new Error(muted.reason);
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toEqual(projectionRow(state, issueIdentity));
		state.close();
	});

	test("a ticket the sources stopped listing answers as no row", () => {
		const { state } = seeded();
		state.sourceFact.applyFetch(sourceA, success([]));
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		expect(read.ticket).toBeNull();
		expect(read.pullRequestLink.fixing).toEqual([]);
		expect(read.pullRequestLink.opened).toBeNull();
		expect(
			state.ticketWorkCycle.ticketProjection([], "implement").rowFor(issueIdentity),
		).toBeUndefined();
		state.close();
	});

	test("an identity the record never listed answers as no row", () => {
		const { state } = seeded();
		const read = state.ticketWorkCycle.ticketOf("github:github.com:I_999", [], "implement");
		expect(read.ticket).toBeNull();
		expect(read.pullRequestLink.fixing).toEqual([]);
		expect(read.pullRequestLink.opened).toBeNull();
		state.close();
	});
});

describe("the ticket's pull request link", () => {
	test("the opened identity is the listed pull request on the ticket's factory branch", () => {
		const state = factoryBranchWorld("false");
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		// The head-branch pull request fixes the ticket and is the pull
		// request the ticket opened.
		expect(read.pullRequestLink.fixing.map((linked) => linked.identity)).toEqual([pullIdentity]);
		expect(read.pullRequestLink.opened).toBe(pullIdentity);
		state.close();
	});

	test("a draft opens and fixes the ticket alike", () => {
		const state = factoryBranchWorld("true");
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		if (read.ticket === null) throw new Error("the scoped read answers no row for the ticket");
		// The draft counts toward the link: it covers the ticket, and it is
		// the pull request the ticket opened.
		expect(isCoveredByFixingPullRequest(read.ticket, read.pullRequestLink.fixing)).toBe(true);
		expect(read.pullRequestLink.opened).toBe(pullIdentity);
		state.close();
	});

	test("a cross-repository closing reference withholds the ticket in the list but stands off the link", () => {
		const { state } = seeded();
		state.sourceFact.initializeSources([sourceA, pulls]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(
			pulls,
			fetchSuccess([
				pullFetched(withIssueReferences({}, [reference]), {
					repository: otherRepository,
				}),
			]),
		);
		// The full-array rule answers in any watched repository: its
		// closing-reference half matches the reference identity, and that
		// identity carries no repository. The rule covers the ticket, and the
		// list withholds it.
		const projected = state.ticketWorkCycle.projectedTickets([], "implement");
		const item = projected.find((ticket) => ticket.identity === issueIdentity);
		if (item === undefined) throw new Error("the ticket is missing from the projection");
		const fullArray = fixingPullRequests(projected, item);
		expect(fullArray.map((ticket) => ticket.identity)).toEqual([pullIdentity]);
		expect(isCoveredByFixingPullRequest(item, fullArray)).toBe(true);
		expect(
			state.ticketWorkCycle.ticketListViews([], "implement").rows.map((ticket) => ticket.identity),
		).toEqual([pullIdentity]);
		// The scoped read answers the row the rule withholds, beside the link
		// that answers no fixing pull request: the restriction is the decision
		// of ADR 0151, and the two reads split in this world.
		const read = state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement");
		if (read.ticket === null)
			throw new Error("the scoped read answers no row for the withheld ticket");
		expect(read.pullRequestLink.fixing).toEqual([]);
		expect(read.pullRequestLink.opened).toBeNull();
		state.close();
	});
});

describe("the source fact's pull request link operation", () => {
	test("the operation answers the ticket's repositories' open pull request rows", () => {
		const { state } = seeded();
		state.sourceFact.initializeSources([sourceA, pulls]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(
			pulls,
			fetchSuccess([
				pullFetched({ draft: "false" }, { repository: otherRepository }),
				pullFetched(
					{ draft: "false" },
					{
						identity: "github:github.com:P_8",
						externalKey: "#8",
					},
				),
			]),
		);
		const link = state.sourceFact.openPullRequestLink(issueIdentity, "open");
		// The ticket's repositories' open pull request rows: the pull request
		// on another repository stands off the link.
		expect(link.pullRequestRows.map((row) => row.identity)).toEqual(["github:github.com:P_8"]);
		expect(link.opened).toBeNull();
		state.close();
	});

	test("the operation answers the opened identity on the factory head branch", () => {
		const state = factoryBranchWorld("false");
		const link = state.sourceFact.openPullRequestLink(issueIdentity, "open");
		expect(link.opened).toBe(pullIdentity);
		state.close();
	});

	test("the operation answers the ticket's own rows beside the link", () => {
		const { state } = seeded();
		state.sourceFact.initializeSources([sourceA, pulls]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const link = state.sourceFact.openPullRequestLink(issueIdentity, "open");
		expect(link.pullRequestRows).toEqual([]);
		expect(link.opened).toBeNull();
		state.close();
	});
});

describe("the per-identity unresolved-attempt fact", () => {
	test("the per-identity form stands beside the global form", () => {
		const { state } = seeded();
		expect(state.handoff.hasUnresolvedAttempt(issueIdentity)).toBe(false);
		expect(state.handoff.openAttemptTickets()).not.toContain(issueIdentity);
		const attemptId = claim(state, issueIdentity);
		expect(state.handoff.hasUnresolvedAttempt(issueIdentity)).toBe(true);
		expect(state.handoff.openAttemptTickets()).toContain(issueIdentity);
		settleAttempt(state, attemptId);
		expect(state.handoff.hasUnresolvedAttempt(issueIdentity)).toBe(false);
		expect(state.handoff.openAttemptTickets()).not.toContain(issueIdentity);
		state.close();
	});
});

describe("the scoped read's statement count", () => {
	test("the scoped read costs the same statements on a small file and a large file", () => {
		const small = seeded({ tickets: fileOf(5) });
		const large = seeded({ tickets: fileOf(300) });
		const smallCount = countStatements(() =>
			small.state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement"),
		).statements;
		const largeCount = countStatements(() =>
			large.state.ticketWorkCycle.ticketOf(issueIdentity, [], "implement"),
		).statements;
		expect(largeCount).toBe(smallCount);
		small.state.close();
		large.state.close();
	});

	test("the full projection keeps its statement count, chunk by chunk", () => {
		const small = seeded({ tickets: fileOf(5) });
		const large = seeded({ tickets: fileOf(300) });
		const smallCount = countStatements(() =>
			small.state.ticketWorkCycle.ticketProjection([], "implement"),
		).statements;
		const largeCount = countStatements(() =>
			large.state.ticketWorkCycle.ticketProjection([], "implement"),
		).statements;
		// The projection's statements follow its chunk count, not its ticket
		// count: a file of five tickets and a file of three hundred hold one
		// chunk each, and the projection's price is unchanged by the scoped
		// read beside it.
		expect(largeCount).toBe(smallCount);
		small.state.close();
		large.state.close();
	});
});
