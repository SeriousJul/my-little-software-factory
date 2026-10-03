/**
 * The muted source (ADR 0070), read through the aggregates that own each half
 * of it (issue #202, re-homed from the flat state suite): the mute as durable
 * factory state on the source row, the gate and the list rule that read the
 * Ticket's facts, and the settles a mute takes with it.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openFactoryState } from "../../src/state.ts";
import {
	choice,
	cleanup,
	fetched,
	sourceA,
	sourceB,
	statePath,
	success,
	textLog,
} from "./harness.ts";

afterEach(cleanup);

describe("the muted source (ADR 0070)", () => {
	test("the flag and its moment are durable factory state on the source row", () => {
		const path = statePath();
		const state = openFactoryState(path, () => Date.parse("2026-09-30T10:00:00Z"));
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: false, mutedAt: null }),
		);

		expect(state.sourceFact.setSourceMuted("issues-a", true)).toEqual({
			ok: true,
			removed: 0,
		});
		expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({
				muted: true,
				mutedAt: "2026-09-30T10:00:00.000Z",
			}),
		);
		// The resting row leaves the active view and stands in the muted view.
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([]);
		expect(state.ticketWorkCycle.ticketListViews([], "implement", "muted").rows).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5", muted: true }),
		]);
		state.close();

		// A second plane on the same file reads the same answer, and the clear
		// costs the same effort as the set, with the moment leaving the flag.
		const reopened = openFactoryState(path);
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: true }),
		);
		expect(reopened.sourceFact.setSourceMuted("issues-a", false)).toEqual({
			ok: true,
			removed: 0,
		});
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: false, mutedAt: null }),
		);
		expect(reopened.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5" }),
		]);
		reopened.close();
	});

	test("the muted view is the ledger of the source acts, beside the pile", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		const rest = fetched();
		const live = fetched("github:github.com:I_6");
		state.sourceFact.applyFetch(sourceA, success([rest, live]));
		// The pile and the ledger are separate ledgers: the ticket's own flag
		// stands on the pile, the source's flag on the mute's.
		expect(state.ticketWorkCycle.setTicketIgnored(rest.identity, true, null).ok).toBe(true);
		const claim = state.handoff.claimHandoff(live.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.sourceFact.setSourceMuted("issues-a", true).ok).toBe(true);
		const identities = (filter: "active" | "ignored" | "muted" | "all") =>
			state.ticketWorkCycle
				.ticketListViews([], "implement", filter)
				.rows.map((ticket) => ticket.identity);
		// The resting row is in no active place - the source's mute withholds
		// it beside its own flag - and the live row keeps its row for its work.
		expect(identities("active")).toEqual([live.identity]);
		// The pile keeps the ticket acts alone, and the ledger holds every
		// ticket of the muted source: the resting one and the live one alike,
		// because only the key on the row ends a mute.
		expect(identities("ignored")).toEqual([rest.identity]);
		expect(identities("muted")).toEqual([live.identity, rest.identity]);
		expect(identities("all")).toEqual([live.identity, rest.identity]);
		// The unmute takes no flag the operator set on a row.
		expect(state.sourceFact.setSourceMuted("issues-a", false).ok).toBe(true);
		expect(state.ticketWorkCycle.ignoredTickets().has(rest.identity)).toBe(true);
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([
			expect.objectContaining({ identity: live.identity }),
		]);
		state.close();
	});

	test("the gate reads the ticket's flag and the source's mute in one read", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched(), fetched("github:github.com:I_6")]));
		expect(state.ticketWorkCycle.automaticStartBlockedTickets()).toEqual(new Set());
		// The ticket's own flag.
		expect(state.ticketWorkCycle.setTicketIgnored("github:github.com:I_5", true, null).ok).toBe(
			true,
		);
		expect(state.ticketWorkCycle.automaticStartBlockedTickets()).toEqual(
			new Set(["github:github.com:I_5"]),
		);
		// The source's mute widens the machine's read, and the pile the
		// operator's view shows stays the ticket acts' own.
		expect(state.sourceFact.setSourceMuted("issues-a", true).ok).toBe(true);
		expect(state.ticketWorkCycle.automaticStartBlockedTickets()).toEqual(
			new Set(["github:github.com:I_5", "github:github.com:I_6"]),
		);
		expect(state.ticketWorkCycle.ignoredTickets()).toEqual(new Set(["github:github.com:I_5"]));
		// A ticket that stands in more than one source is withheld when any
		// of its sources is muted: the second source's mute widens the read
		// to the shared ticket too.
		state.sourceFact.initializeSources([sourceA, sourceB]);
		state.sourceFact.applyFetch(
			sourceB,
			success([
				{
					...fetched("github:github.com:I_6"),
					sourceState: "open",
				},
			]),
		);
		expect(state.ticketWorkCycle.automaticStartBlockedTickets()).toEqual(
			new Set(["github:github.com:I_5", "github:github.com:I_6"]),
		);
		state.close();
	});

	test("the mute settles what waits, in the same write", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		const rest = fetched();
		const routed = fetched("github:github.com:I_6");
		state.sourceFact.applyFetch(sourceA, success([rest, routed]));
		// The waiting start of a ticket of the source, asked by the operator.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: rest.identity,
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		// A routed ticket whose route already died: settled to awaiting, the
		// route's wait landed, and the route's item gone.
		const claim = state.handoff.claimHandoff(routed.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: routed.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the turn is done",
			turnLog: textLog("the turn is done"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: routed.identity,
				handoffId: claim.claim.attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:05:00Z",
			}),
		).toBe(true);
		// The ask ends the cycle in the same write: the routed ticket rests
		// open, and the route's item lands with the decision.
		expect(state.ticketWorkCycle.ticketState(routed.identity)).toBe("open");
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: routed.identity,
				routeFromIdentity: routed.identity,
				origin: "workflow",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		expect(state.workQueue.removeWorkflowRouteItem(routed.identity)).toBe(1);
		const cycleBefore = state.ticketWorkCycle
			.projectedTickets([], "implement")
			.find((ticket) => ticket.identity === routed.identity)?.workCycle;
		// The act is one write: the waiting start is removed. The routed
		// ticket's cycle already ended at its ask, and its item left already,
		// so the mute takes nothing from it.
		expect(state.sourceFact.setSourceMuted("issues-a", true)).toEqual({
			ok: true,
			removed: 1,
		});
		expect(state.workQueue.items()).toEqual([]);
		expect(state.ticketWorkCycle.ticketState(rest.identity)).toBe("open");
		expect(state.ticketWorkCycle.ticketState(routed.identity)).toBe("open");
		const routedAfter = state.ticketWorkCycle
			.projectedTickets([], "implement")
			.find((ticket) => ticket.identity === routed.identity);
		expect(routedAfter?.workCycle).toBe(cycleBefore);
		// And the muted ticket's resting row is nowhere in the active view.
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([]);
		state.close();
	});

	test("removing the source from the config clears its mute", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(state.sourceFact.setSourceMuted("issues-a", true).ok).toBe(true);
		// The stronger act: the source leaves the config, and the plane marks
		// it removed with the mute leaving its row.
		state.sourceFact.initializeSources([]);
		state.close();

		const db = new Database(path, { readonly: true });
		const row = db
			.prepare("SELECT muted, muted_at FROM source_health WHERE source_name = ?")
			.get("issues-a") as { muted: number; muted_at: string | null };
		expect(row).toEqual({ muted: 0, muted_at: null });
		db.close();

		// A re-added source comes back clean: the ticket's projection carries
		// no flag, and a fresh act stands again.
		const reopened = openFactoryState(path);
		reopened.sourceFact.initializeSources([sourceA]);
		reopened.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: false, mutedAt: null }),
		);
		expect(reopened.sourceFact.setSourceMuted("issues-a", true).ok).toBe(true);
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: true }),
		);
		reopened.close();
	});

	test("a file stamped at the target without the mute's column heals on open", () => {
		// The same rule the flag's own columns carry: ask the file, not the
		// stamp. The missing column is the file's own confession, whatever the
		// stamp claims.
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.close();

		const db = new Database(path);
		db.exec("ALTER TABLE source_health DROP COLUMN muted");
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.sourceFact.setSourceMuted("issues-a", true).ok).toBe(true);
		expect(reopened.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
			expect.objectContaining({ muted: true }),
		);
		reopened.close();
	});
});
