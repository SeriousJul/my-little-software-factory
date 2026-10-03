/**
 * The ignored Ticket flag (ADR 0060), read through the Ticket work cycle
 * aggregate that owns it (issue #202, re-homed from the flat state suite): the
 * flag and its moment as durable factory state, the obligation and the marker
 * that refuse the write, and the views the flag moves a row between.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { FetchedTicket } from "../../src/domain/ticket.ts";
import { withIssueReferences } from "../../src/domain/ticket.ts";
import { openFactoryState, SCHEMA_VERSION } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success, textLog } from "./harness.ts";

afterEach(cleanup);

describe("the ignored Ticket (ADR 0060)", () => {
	test("the flag and its moment are durable factory state on the ticket row", () => {
		const path = statePath();
		const state = openFactoryState(path, () => Date.parse("2026-09-24T10:00:00Z"));
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(ticket.ignored).toBe(false);
		expect(ticket.ignoredAt).toBeNull();

		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null)).toEqual({
			ok: true,
		});
		expect(state.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		state.close();

		// A second plane on the same file - another operator, or a restart -
		// reads the same answer, and the row's projection carries it.
		const reopened = openFactoryState(path);
		expect(reopened.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		expect(reopened.ticketWorkCycle.visibleTickets([], "implement")).toEqual([]);
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")).toEqual([
			expect.objectContaining({
				identity: ticket.identity,
				ignored: true,
				ignoredAt: "2026-09-24T10:00:00.000Z",
			}),
		]);
		// The clear costs the same effort as the set, and the moment leaves
		// with the flag.
		expect(reopened.ticketWorkCycle.setTicketIgnored(ticket.identity, false, null)).toEqual({
			ok: true,
		});
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ ignored: false, ignoredAt: null }),
		);
		reopened.close();
	});

	test("the flag follows the Ticket across a source that drops it and brings it back", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null).ok).toBe(true);
		// The source stops listing the item: the membership goes inactive,
		// and the ticket row stays with its flag.
		state.sourceFact.applyFetch(sourceA, success([]));
		expect(state.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		// The item returns to the source: the same identity reads ignored, and
		// the active view holds it out again.
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(state.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")).toEqual([]);
		expect(
			state.ticketWorkCycle.visibleTickets([], "implement", "ignored").map((row) => row.identity),
		).toEqual([ticket.identity]);
		state.close();
	});

	test("the write refuses a Ticket that owes a decision, in the obligation's words", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		// An open ticket owes nothing: the act runs.
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null)).toEqual({
			ok: true,
		});
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, false, null)).toEqual({
			ok: true,
		});
		// A settled turn rests on the operator's decision.
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the turn is done",
			turnLog: textLog("the turn is done"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(state.ticketWorkCycle.ticketObligation(ticket.identity, null)).toBe("awaiting");
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null)).toEqual({
			ok: false,
			reason: "the selected Ticket cannot be ignored: it awaits a decision",
		});
		// A held turn names its own fact.
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the turn failed",
			turnLog: textLog("the turn failed"),
			completedAt: "2026-08-31T11:05:00Z",
			cause: "failed",
		});
		expect(state.ticketWorkCycle.ticketObligation(ticket.identity, null)).toBe("held");
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null)).toEqual({
			ok: false,
			reason: "the selected Ticket cannot be ignored: its held turn awaits a decision",
		});
		state.close();
	});

	test("a missing Agent refuses the ignore, and the flag never leaves by itself", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The agent works: no obligation, and the key runs.
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, null)).toEqual({
			ok: true,
		});
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, false, null)).toEqual({
			ok: true,
		});
		// The poll's marker says the Agent is gone: the write refuses it, and
		// only for the Ticket the marker stands on.
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, "missing")).toEqual({
			ok: false,
			reason: "the selected Ticket cannot be ignored: its Agent is missing",
		});
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, true, "blocked").ok).toBe(true);
		// ADR 0060: nothing but the operator's own key clears the flag. The row's
		// face is what the list rule reads, so a live or awaiting Ticket keeps its
		// row while the flag stands, and a resting one loses it again.
		expect(state.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		expect(
			state.ticketWorkCycle.visibleTickets([], "implement").map((row) => row.identity),
		).toEqual([ticket.identity]);
		state.ticketWorkCycle.closeWorkCycle(ticket.identity);
		expect(state.ticketWorkCycle.ignoredTickets().has(ticket.identity)).toBe(true);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")).toEqual([]);
		// Taking the Ticket back is never refused, and it costs the flag.
		expect(state.ticketWorkCycle.setTicketIgnored(ticket.identity, false, "missing")).toEqual({
			ok: true,
		});
		expect(
			state.ticketWorkCycle.visibleTickets([], "implement").map((row) => row.identity),
		).toEqual([ticket.identity]);
		state.close();
	});

	test("the ignore withholds a resting row and reveals a live or awaiting one", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		const rest = fetched();
		const live = fetched("github:github.com:I_6");
		state.sourceFact.applyFetch(sourceA, success([rest, live]));
		expect(state.ticketWorkCycle.setTicketIgnored(rest.identity, true, null).ok).toBe(true);
		const claim = state.handoff.claimHandoff(live.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.ticketWorkCycle.setTicketIgnored(live.identity, true, null).ok).toBe(true);
		const identities = (filter: "active" | "ignored" | "all") =>
			state.ticketWorkCycle
				.visibleTickets([], "implement", filter)
				.map((ticket) => ticket.identity);
		// The resting row leaves the active view; the live one stays for its work.
		expect(identities("active")).toEqual([live.identity]);
		// The pile names both: the ledger of what the operator put away.
		expect(identities("ignored")).toEqual([live.identity, rest.identity]);
		expect(identities("all")).toEqual([live.identity, rest.identity]);
		// Settle the live turn: awaiting owes a decision, so its row stays in the
		// active view, and the flag still stands on it.
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: live.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the turn is done",
			turnLog: textLog("the turn is done"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(identities("active")).toEqual([live.identity]);
		expect(state.ticketWorkCycle.ticketObligation(live.identity, null)).toBe("awaiting");
		expect(state.ticketWorkCycle.ignoredTickets().has(live.identity)).toBe(true);
		// Close its cycle: the Ticket rests, and the same flag takes the row back.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: live.identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		expect(identities("active")).toEqual([]);
		// Both rest, and the pile keeps the list's own order: the attention band,
		// then the band's own second rank (ADR 0050, ADR 0065).
		expect(identities("ignored")).toEqual([rest.identity, live.identity]);
		state.close();
	});

	test("the projection's three filter states hold the covered rule beside them", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		const issue = fetched();
		const pull = {
			...fetched("github:github.com:P_7"),
			sourceKind: "github-pull-request",
			externalKey: "#7",
			title: "Pull 7",
			attributes: withIssueReferences({}, [
				{ identity: null, number: 5, repository: "acme/factory" },
			]),
		};
		state.sourceFact.applyFetch(sourceA, success([issue, pull]));
		const identities = (filter: "active" | "ignored" | "all") =>
			state.ticketWorkCycle
				.visibleTickets([], "implement", filter)
				.map((ticket) => ticket.identity);
		// The covered issue leaves the active view beside its pull request.
		expect(identities("active")).toEqual(["github:github.com:P_7"]);
		expect(state.ticketWorkCycle.setTicketIgnored("github:github.com:P_7", true, null).ok).toBe(
			true,
		);
		// The ignored view holds the ignored row, the active view holds the
		// rest, and `all` holds both - and the covered issue is in none of
		// them, because the covered rule says nothing about the ignore.
		expect(identities("ignored")).toEqual(["github:github.com:P_7"]);
		expect(identities("all")).toEqual(["github:github.com:P_7"]);
		expect(identities("active")).toEqual([]);
		// The empty active view is the filtered list, not an idle factory:
		// the rows the ignore took away are the pile `f` shows.
		state.close();
	});

	test("the pile holds a Ticket that is both ignored and covered", () => {
		// ADR 0060: the pile is the ledger of what the operator put away, so
		// every row the flag stands on stands in it. The two causes are not
		// symmetric: the covered rule takes a row out of the list, and the
		// ignore is the operator's own act, recorded. A Ticket that is both
		// must stay reachable, because the only key that clears the flag is the
		// one on its row (user story 6).
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		const coveredIssue = fetched();
		const pull = {
			...fetched("github:github.com:P_7"),
			sourceKind: "github-pull-request",
			externalKey: "#7",
			title: "Pull 7",
			attributes: withIssueReferences({}, [
				{ identity: null, number: 5, repository: "acme/factory" },
			]),
		};
		state.sourceFact.applyFetch(sourceA, success([coveredIssue, pull]));
		// Rest first: the issue is covered, so it is out of the list before the
		// operator ever touches it, and a fixing pull request appearing after an
		// ignore reaches the same state by the ordinary refresh path.
		expect(
			state.ticketWorkCycle
				.visibleTickets([], "implement", "active")
				.map((ticket) => ticket.identity),
		).toEqual(["github:github.com:P_7"]);
		expect(state.ticketWorkCycle.setTicketIgnored(coveredIssue.identity, true, null).ok).toBe(true);
		const identities = (filter: "active" | "ignored" | "all") =>
			state.ticketWorkCycle
				.visibleTickets([], "implement", filter)
				.map((ticket) => ticket.identity)
				.sort();
		// Neither the active view nor the `all` list shows it: the covered rule
		// still holds the list (ADR 0042), and the ignore never reaches it.
		expect(identities("active")).toEqual(["github:github.com:P_7"]);
		expect(identities("all")).toEqual(["github:github.com:P_7"]);
		// The pile shows it, and it stands nowhere else: `f` is the only way to
		// reach the row, and the row is the only place the `i` key runs.
		expect(identities("ignored")).toEqual([coveredIssue.identity]);
		// The gate reads the flag, so the machine holds the Ticket out either way.
		expect(state.ticketWorkCycle.ignoredTickets().has(coveredIssue.identity)).toBe(true);
		expect(
			state.ticketWorkCycle
				.ticketListViews([], "implement", "ignored")
				.ignored.map((ticket) => ticket.identity),
		).toEqual(expect.arrayContaining([coveredIssue.identity]));
		expect(state.ticketWorkCycle.setTicketIgnored(coveredIssue.identity, false, null).ok).toBe(
			true,
		);
		expect(identities("ignored")).toEqual([]);
		state.close();
	});

	test("the ignored view keeps the attention bands and the open bands' number order", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		// Three Tickets with three external update times that disagree with
		// the numbers: the pile reads by the attention band first and the
		// open bands' ticket number after, the order the active list holds
		// (ADR 0059's one rule for the ignored view, ADR 0065's second rank).
		const dated = (identity: string, key: string, at: string): FetchedTicket => ({
			...fetched(identity),
			externalKey: key,
			externalUpdatedAt: at,
		});
		state.sourceFact.applyFetch(
			sourceA,
			success([
				dated("github:github.com:I_5", "#5", "2026-08-31T09:00:00Z"),
				dated("github:github.com:I_6", "#6", "2026-08-31T09:30:00Z"),
				dated("github:github.com:I_7", "#7", "2026-08-31T12:00:00Z"),
			]),
		);
		for (const identity of [
			"github:github.com:I_5",
			"github:github.com:I_6",
			"github:github.com:I_7",
		]) {
			expect(state.ticketWorkCycle.setTicketIgnored(identity, true, null).ok).toBe(true);
		}
		// I_5 runs an Agent, so it leads the pile; the rest read by ticket
		// number ascending, exactly as the active list sorts them, and the
		// newest update (I_7) does not pull its row ahead of I_6.
		const running = state.handoff.claimHandoff("github:github.com:I_5", choice, "open");
		if (!running.ok) throw new Error(running.reason);
		state.handoff.settleHandoff(running.claim.attemptId, true);
		expect(
			state.ticketWorkCycle
				.visibleTickets([], "implement", "ignored")
				.map((ticket) => [ticket.identity, ticket.state]),
		).toEqual([
			["github:github.com:I_5", "handed-off"],
			["github:github.com:I_6", "open"],
			["github:github.com:I_7", "open"],
		]);
		state.close();
	});

	test("a v21 file migrates to v22: the flag lands off, and the rows keep their state", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff("github:github.com:I_5", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.close();

		// The older file: the stamp at 21, and no flag column at all.
		const db = new Database(path);
		db.exec("ALTER TABLE tickets DROP COLUMN ignored");
		db.exec("ALTER TABLE tickets DROP COLUMN ignored_at");
		db.prepare("UPDATE schema_version SET version = 21").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(false);
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5", ignored: false }),
		]);
		expect(reopened.ticketWorkCycle.setTicketIgnored("github:github.com:I_5", true, null).ok).toBe(
			true,
		);
		reopened.close();

		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});
});
