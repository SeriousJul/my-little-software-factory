/**
 * The shared Parallel limit seat count (issue #87, ADR 0034): the one source
 * the automatic start gates and the mode line read. A seat is held by an
 * in-flight ticket whose agent the poll listed or that is still inside its
 * startup grace, by every in-progress handoff, and by every Consultation in
 * opening or working.
 */
import { describe, expect, test } from "bun:test";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { parallelSeatCount } from "../src/parallel.ts";
import { type ConsultationState, type FactoryState, openFactoryState } from "../src/state.ts";

const source = { name: "issues", kind: "github-issues" };
const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};
const NOW = Date.parse("2026-08-31T11:00:00Z");
const GRACE = 30_000;

function fetched(identity: string): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: `#${identity.split("I_")[1]}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${identity.split("I_")[1]}`,
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

/** A state holding three open tickets, on the pinned clock. */
function freshState(now = NOW): FactoryState {
	const state = openFactoryState(":memory:", () => now);
	state.initializeSources([source]);
	state.applyFetch(source, {
		status: "success",
		fetchedAt: "2026-08-31T10:00:00Z",
		tickets: [
			fetched("github:github.com:I_5"),
			fetched("github:github.com:I_6"),
			fetched("github:github.com:I_7"),
		],
	});
	return state;
}

/** Claim and settle a handoff of the ticket, storing the given pane. */
function handOut(state: FactoryState, identity: string, paneId: string | null): void {
	const claim = state.claimHandoff(identity, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
}

/** Leave a handoff claimed and unsettled: an in-progress handoff. */
function claimOnly(state: FactoryState, identity: string): void {
	const claim = state.claimHandoff(identity, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
}

function consultationIn(state: FactoryState, id: string, stateName: ConsultationState): void {
	state.createConsultation({
		id,
		typeName: "grill",
		agentType: "pi",
		environment: "worktree",
		template: "/grill {input}",
		initialInput: "review auth",
		renderedOpeningPrompt: "/grill review auth",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: "/tmp/factory",
		},
		agentName: `consultation-${id}`,
	});
	if (stateName !== "opening") state.setConsultationState(id, stateName);
}

function listed(paneId: string): HerdrAgent {
	return {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
		agent: "factory-implement",
		status: "working",
		sessionId: "",
	};
}

describe("parallelSeatCount", () => {
	test("holds a seat for an in-flight ticket whose agent the poll listed", () => {
		const state = freshState();
		try {
			handOut(state, "github:github.com:I_5", "pane-5");
			expect(
				parallelSeatCount({ state, agents: [listed("pane-5")], now: NOW, startupGraceMs: GRACE }),
			).toBe(1);
			// The same poll without the pane: the started agent is inside its
			// startup grace, so it still holds the seat.
			expect(parallelSeatCount({ state, agents: [], now: NOW, startupGraceMs: GRACE })).toBe(1);
			// A started agent with no stored pane holds its in-progress seat
			// the same way.
			const bare = freshState();
			handOut(bare, "github:github.com:I_5", null);
			expect(parallelSeatCount({ state: bare, agents: [], now: NOW, startupGraceMs: GRACE })).toBe(
				1,
			);
			bare.close();
		} finally {
			state.close();
		}
	});

	test("releases the seat of a missing agent past the startup grace", () => {
		const state = freshState();
		try {
			handOut(state, "github:github.com:I_5", "pane-5");
			const past = NOW + GRACE + 1;
			// The state clock is pinned, so age the handoff by reading it
			// later: a started agent past the grace with no live pane holds
			// no seat.
			expect(
				parallelSeatCount({
					state,
					agents: [listed("pane-other")],
					now: past,
					startupGraceMs: GRACE,
				}),
			).toBe(0);
		} finally {
			state.close();
		}
	});

	test("counts an in-progress handoff once, even for a counted ticket", () => {
		const state = freshState();
		try {
			claimOnly(state, "github:github.com:I_6");
			expect(parallelSeatCount({ state, agents: [], now: NOW, startupGraceMs: GRACE })).toBe(1);
			// A claimed handoff whose ticket also holds a listed seat is one
			// seat, not two.
			handOut(state, "github:github.com:I_5", "pane-5");
			expect(
				parallelSeatCount({ state, agents: [listed("pane-5")], now: NOW, startupGraceMs: GRACE }),
			).toBe(2);
		} finally {
			state.close();
		}
	});

	test("holds a seat for opening and working Consultations, and for no other state", () => {
		const state = freshState();
		try {
			consultationIn(state, "c-opening", "opening");
			consultationIn(state, "c-working", "working");
			const count = parallelSeatCount({ state, agents: [], now: NOW, startupGraceMs: GRACE });
			expect(count).toBe(2);
			for (const other of [
				"awaiting-response",
				"missing",
				"failed",
				"closing",
				"closed",
			] as const) {
				const bare = freshState();
				try {
					consultationIn(bare, `c-${other}`, other);
					expect(
						parallelSeatCount({ state: bare, agents: [], now: NOW, startupGraceMs: GRACE }),
					).toBe(0);
				} finally {
					bare.close();
				}
			}
		} finally {
			state.close();
		}
	});

	test("combines the ticket and Consultation seats into one count", () => {
		const state = freshState();
		try {
			handOut(state, "github:github.com:I_5", "pane-5");
			consultationIn(state, "c-working", "working");
			// The mode line's own example: one live ticket and one working
			// Consultation read 2 against a cap of 2.
			expect(
				parallelSeatCount({ state, agents: [listed("pane-5")], now: NOW, startupGraceMs: GRACE }),
			).toBe(2);
		} finally {
			state.close();
		}
	});

	test("before the first successful poll only booting, in-progress, and Consultation seats count", () => {
		const state = freshState();
		try {
			handOut(state, "github:github.com:I_5", "pane-5");
			consultationIn(state, "c-working", "working");
			// No agent list yet: the ticket holds its booting seat and the
			// Consultation holds its state seat.
			expect(parallelSeatCount({ state, agents: null, now: NOW, startupGraceMs: GRACE })).toBe(2);
			// Past the grace with no live pane: the ticket drops its seat, and
			// the Consultation's seat alone remains.
			expect(
				parallelSeatCount({ state, agents: null, now: NOW + GRACE + 1, startupGraceMs: GRACE }),
			).toBe(1);
		} finally {
			state.close();
		}
	});
});
