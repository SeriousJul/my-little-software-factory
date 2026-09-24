/**
 * The fixing pull request tests (ADR 0042): the list rule that withholds a
 * covered open ticket's row, and the rank inheritance that reads the
 * tickets a pull request fixes.
 *
 * Every test runs on a real in-memory state with isolated test tickets: an
 * issue or a security item, and a pull request that fixes it through a
 * closing reference or a factory branch name. No test reaches GitHub.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket, IssueReference } from "../src/domain/ticket.ts";
import { withHeadBranch, withIssueReferences } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import { isCoveredByFixingPullRequest } from "../src/workflow.ts";
import { awaitFrame, HEIGHT, rowsOf, WIDTH, withApp } from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeSource } from "./fake-source.ts";
import { issueTicket, success } from "./state-fixture.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-fixing-pr-"));
	paths.push(dir);
	return join(dir, "state.sqlite");
}

const issues = { name: "issues", kind: "github-issues" } as const;
const pulls = { name: "pulls", kind: "github-pull-requests" } as const;
const security = { name: "security", kind: "github-dependabot-alert" } as const;
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_7";
const securityIdentity = "github:github.com:SEC_9";
const securityPullIdentity = "github:github.com:P_97";

const repository = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};

const ref = (identity: string, number: number): IssueReference => ({
	identity,
	number,
	repository: "acme/factory",
});

/** One pull request ticket on the shared sample repository. */
function pullTicket(
	identity: string,
	number: number,
	attributes: Record<string, string>,
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-pull-request",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/pulls/${number}`,
		title: `Pull ${number}`,
		description: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository,
		attributes,
		...over,
	};
}

/** One security item ticket on the shared sample repository. */
function securityTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: securityIdentity,
		sourceKind: "github-dependabot-alert",
		externalKey: "#9",
		sourceState: "open",
		url: "https://github.com/acme/factory/security/dependabot/9",
		title: "Patch the vulnerable dependency",
		description: "The Dependabot alert.",
		labels: ["high"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository,
		attributes: {},
		...over,
	};
}

/** The branch a worktree handoff of the security item would create. */
const securityBranch = "factory/9-patch-the-vulnerable-dependency";

/** A pull request that fixes its security item by the factory branch alone. */
function securityPullTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return pullTicket(securityPullIdentity, 97, withHeadBranch({ draft: "false" }, securityBranch), {
		title: "Patch the vulnerable dependency",
		externalUpdatedAt: "2026-08-31T10:30:00Z",
		...over,
	});
}

/** A pull request that fixes issue #5 through its closing reference. */
function closingPullTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return pullTicket(
		pullIdentity,
		7,
		withIssueReferences(withHeadBranch({ draft: "false" }, "factory/5-persist-source-facts"), [
			ref(issueIdentity, 5),
		]),
		over,
	);
}

describe("the list rule", () => {
	test("an open ticket with an open fixing pull request leaves the list, and the pull request stays", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([issueTicket(issueIdentity)]));
		state.applyFetch(pulls, success([closingPullTicket()]));
		// The projection before the list rule holds both; the list withholds
		// the covered issue's row and keeps the pull request's.
		const projected = state.projectedTickets([], "implement");
		expect(projected.map((ticket) => ticket.identity).sort()).toEqual([
			issueIdentity,
			pullIdentity,
		]);
		const visible = state.visibleTickets([], "implement");
		expect(visible.map((ticket) => ticket.identity)).toEqual([pullIdentity]);
		state.close();
	});

	test("the rule holds for every source kind: a security item rests behind its branch-named pull request", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([security, pulls]);
		state.applyFetch(security, success([securityTicket()]));
		state.applyFetch(pulls, success([securityPullTicket()]));
		const projected = state.projectedTickets([], "implement");
		const item = projected.find((ticket) => ticket.identity === securityIdentity);
		if (item === undefined) throw new Error("the security item is missing from the projection");
		expect(isCoveredByFixingPullRequest(projected, item)).toBe(true);
		const visible = state.visibleTickets([], "implement");
		expect(visible.map((ticket) => ticket.identity)).toEqual([securityPullIdentity]);
		state.close();
	});

	test("a draft fixing pull request covers the ticket", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([issueTicket(issueIdentity)]));
		state.applyFetch(
			pulls,
			success([
				pullTicket(
					pullIdentity,
					7,
					withHeadBranch({ draft: "true" }, "factory/5-persist-source-facts"),
				),
			]),
		);
		const visible = state.visibleTickets([], "implement");
		// The draft's work is in flight: the issue rests, and the draft is the
		// row that stands for the work.
		expect(visible.map((ticket) => ticket.identity)).toEqual([pullIdentity]);
		state.close();
	});

	test("an in-flight ticket stays listed whatever pull requests exist", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([issueTicket(issueIdentity)]));
		state.applyFetch(pulls, success([closingPullTicket()]));
		// The ticket leaves open behind: the rule suppresses only the open
		// state, and the in-flight ticket stays reachable for its decision.
		const claim = state.claimHandoff(
			issueIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		const handedOff = state.visibleTickets([], "implement");
		expect(handedOff.map((ticket) => ticket.identity).sort()).toEqual([
			issueIdentity,
			pullIdentity,
		]);
		state.settleTurn({
			ticketIdentity: issueIdentity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The turn is done.",
			turnLog: [{ kind: "text", text: "The turn is done." }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		const awaiting = state.visibleTickets([], "implement");
		expect(awaiting.map((ticket) => ticket.identity).sort()).toEqual([issueIdentity, pullIdentity]);
		state.close();
	});

	test("a ticket whose fixing pull request closed unmerged re-enters on the next refresh", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([issueTicket(issueIdentity)]));
		state.applyFetch(pulls, success([closingPullTicket()]));
		expect(state.visibleTickets([], "implement").map((ticket) => ticket.identity)).toEqual([
			pullIdentity,
		]);
		// The next refresh lists the pull request closed and unmerged: it no
		// longer fixes the ticket, and the ticket re-enters the list.
		state.applyFetch(pulls, success([closingPullTicket({ sourceState: "closed" })]));
		const reentered = state.visibleTickets([], "implement");
		expect(reentered.map((ticket) => ticket.identity).sort()).toEqual([
			issueIdentity,
			pullIdentity,
		]);
		// The next refresh drops the pull request from the source the same way.
		state.applyFetch(pulls, success([]));
		const back = state.visibleTickets([], "implement");
		expect(back.map((ticket) => ticket.identity)).toEqual([issueIdentity]);
		state.close();
	});

	test("the branch link holds across the repository identity casing an older plane stored", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([security, pulls]);
		state.applyFetch(security, success([securityTicket()]));
		// A plane that predates the canonical lowercase identity stored the
		// pull request's repository with the API's owner casing. The link is
		// on the same repository, and the repository identity is
		// case-insensitive on GitHub, so the link still holds (ADR 0042).
		state.applyFetch(
			pulls,
			success([
				securityPullTicket({
					repository: {
						identity: "github.com/Acme/Factory",
						displayName: "Acme/Factory",
						cloneUrl: "https://github.com/Acme/Factory.git",
					},
				}),
			]),
		);
		const visible = state.visibleTickets([], "implement");
		expect(visible.map((ticket) => ticket.identity)).toEqual([securityPullIdentity]);
		state.close();
	});

	test("a pull request that fixes nothing covers nothing", () => {
		const state = openFactoryState(statePath());
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([issueTicket(issueIdentity)]));
		state.applyFetch(
			pulls,
			success([
				pullTicket(
					pullIdentity,
					7,
					withHeadBranch({ draft: "false" }, "factory/6-some-other-ticket"),
				),
			]),
		);
		const visible = state.visibleTickets([], "implement");
		expect(visible.map((ticket) => ticket.identity).sort()).toEqual([issueIdentity, pullIdentity]);
		state.close();
	});
});

describe("the section header counts", () => {
	const sourcesConfig: FactoryConfig = {
		...BASE_CONFIG,
		sources: [
			{
				name: "issues",
				kind: "github-issues",
				refreshIntervalSeconds: 60,
				repositories: ["acme/factory"],
				host: "github.com",
			},
			{
				name: "pulls",
				kind: "github-pull-requests",
				refreshIntervalSeconds: 60,
				repositories: ["acme/factory"],
				host: "github.com",
			},
		],
	};

	/** The row of a title inside the list pane only, so the detail pane cannot hide it. */
	const listRowOf = (frame: string, title: string): number => {
		const listCols = Math.floor(WIDTH / 2);
		return rowsOf(frame).findIndex((row) => row.slice(0, listCols).includes(title));
	};

	test("exclude a covered ticket, and the list shows the pull request for it", async () => {
		const state = openFactoryState(statePath());
		const issuesSource = new FakeSource(
			"issues",
			"github-issues",
			success([issueTicket(issueIdentity)]),
		);
		const pullsSource = new FakeSource(
			"pulls",
			"github-pull-requests",
			success([closingPullTicket({ title: "Persist source facts" })]),
		);
		try {
			await withApp(
				async (setup) => {
					issuesSource.settle(success([issueTicket(issueIdentity)]));
					pullsSource.settle(success([closingPullTicket({ title: "Persist source facts" })]));
					const frame = await awaitFrame(
						setup,
						// The list row truncates the title: match on its lead.
						(f) => listRowOf(f, "Persist source fa") >= 0,
						"the pull request row",
					);
					// The covered issue is not listed, and the header count does
					// not count it: one open ticket stands, the pull request's.
					expect(listRowOf(frame, "Add a webhook retry policy")).toBe(-1);
					const header = rowsOf(frame).find((row) => row.includes("Tickets")) ?? "";
					expect(header).toContain("open: 1");
				},
				WIDTH,
				HEIGHT,
				{ config: sourcesConfig, state, sources: [issuesSource, pullsSource] },
			);
		} finally {
			state.close();
		}
	});
});
