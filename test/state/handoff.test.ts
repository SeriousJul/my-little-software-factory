/**
 * The handoff aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { FetchedTicket } from "../../src/domain/ticket.ts";
import { openFactoryState } from "../../src/state.ts";
import {
	choice,
	cleanup,
	closedCycle,
	fetched,
	labeled,
	POSITION_STATES,
	sourceA,
	statePath,
	success,
	textLog,
} from "./harness.ts";

afterEach(cleanup);

describe("the handoff aggregate", () => {
	test("an in-flight ticket keeps its own matched State from the source facts", () => {
		// The Handoff records the task it started with, and the position is
		// still what the labels say: the two facts stand apart, and the
		// grouping reads the State the machine matched now.
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["needs-review"])]));
		const [open] = state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement");
		expect(open.matchedStateName).toBe("needs-review");
		const claim = state.handoff.claimHandoff(
			open.identity,
			{ ...choice, taskType: "implement" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		const [flight] = state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement");
		expect(flight).toEqual(
			expect.objectContaining({
				state: "handed-off",
				handoff: expect.objectContaining({ taskType: "implement" }),
				matchedStateName: "needs-review",
			}),
		);
		state.close();
	});
	test("the list orders the open bands by ticket number and the live bands by update", () => {
		// ADR 0065: the open pile reads by ticket number ascending, not by the
		// update that moved newest on the last refresh, so the rows hold their
		// place across a re-read. The no-number ticket stands last in its band,
		// a tie breaks by identity, and the live bands keep the newest-update
		// rank they always held (ADR 0050).
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		const ticket = (identity: string, key: string, at: string): FetchedTicket => ({
			...fetched(identity),
			externalKey: key,
			externalUpdatedAt: at,
		});
		state.sourceFact.applyFetch(
			sourceA,
			success([
				ticket("github:github.com:I_5", "#5", "2026-08-31T09:00:00Z"),
				ticket("github:github.com:I_6a", "#6", "2026-08-31T12:00:00Z"),
				ticket("github:github.com:I_6b", "#6", "2026-08-31T08:00:00Z"),
				ticket("github:github.com:I_7", "#7", "2026-08-31T11:00:00Z"),
				ticket("github:github.com:G_1", "ghsa-abc-123", "2026-08-31T13:00:00Z"),
			]),
		);
		const identities = () =>
			state.ticketWorkCycle.visibleTickets([], "implement", "active").map((row) => row.identity);
		expect(identities()).toEqual([
			"github:github.com:I_5",
			"github:github.com:I_6a",
			"github:github.com:I_6b",
			"github:github.com:I_7",
			"github:github.com:G_1",
		]);
		// Live work leaves the pile and keeps the rank it always held: the
		// newest update first, then identity.
		for (const identity of ["github:github.com:I_7", "github:github.com:I_5"]) {
			const claim = state.handoff.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true);
		}
		expect(identities()).toEqual([
			"github:github.com:I_7",
			"github:github.com:I_5",
			"github:github.com:I_6a",
			"github:github.com:I_6b",
			"github:github.com:G_1",
		]);
		state.close();
	});
	test("settles a normal failed handoff so an operator can retry", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const first = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.handoff.settleHandoff(first.claim.attemptId, false, "herdr is unavailable");
		expect(state.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: true }),
		);
		state.close();
	});
	test("a closed decision ends the work cycle: back to open with the cycle incremented", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0].state).toBe("awaiting");

		// The decision records on the trace and ends the cycle.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const [returned] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.lastCompletion?.decision).toBe("closed");

		// The cycle may have changed the source item, so the next handoff
		// waits for the source to re-read the ticket since the close.
		const gated = state.handoff.claimHandoff(returned.identity, choice, "open");
		expect(gated.ok).toBe(false);
		if (gated.ok) return;
		expect(gated.reason).toContain("re-read since its last cycle ended");

		// The re-read lands, and the next handoff runs in work cycle 2.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		const second = state.handoff.claimHandoff(returned.identity, choice, "open");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		state.handoff.settleHandoff(second.claim.attemptId, true);
		const cycles = new Database(path)
			.prepare("SELECT work_cycle FROM handoffs WHERE ticket_identity = ? ORDER BY work_cycle")
			.all(ticket.identity) as Array<{ work_cycle: number }>;
		expect(cycles).toEqual([{ work_cycle: 1 }, { work_cycle: 2 }]);
		state.close();
	});
	test("an open claim waits for the source re-read after a cycle end", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const gated = state.handoff.claimHandoff(identity, choice, "open");
		expect(gated.ok).toBe(false);
		if (gated.ok) return;
		expect(gated.reason).toBe(
			"the ticket's source has not been re-read since its last cycle ended; wait for the source refresh",
		);
		// A failed re-read leaves the membership stale: the claim refuses on
		// its own eligibility, and the gate holds either way.
		state.sourceFact.applyFetch(sourceA, {
			status: "failed",
			reason: "GitHub rate limit exceeded",
		});
		expect(state.handoff.claimHandoff(identity, choice, "open").ok).toBe(false);
		state.close();
	});
	test("a workflow claim needs awaiting, a restart claim needs in-flight", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		// Awaiting: a workflow handoff is allowed, an open claim is not.
		expect(state.handoff.claimHandoff(ticket.identity, choice, "workflow").ok).toBe(true);
		expect(state.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false }),
		);
		// A restart needs an in-flight ticket, and the open workflow claim
		// blocks every further claim until it resolves.
		expect(state.handoff.claimHandoff(ticket.identity, choice, "restart")).toEqual(
			expect.objectContaining({
				ok: false,
				reason: expect.stringContaining("in-flight"),
			}),
		);
		expect(state.handoff.claimHandoff(ticket.identity, choice, "workflow")).toEqual(
			expect.objectContaining({
				ok: false,
				reason: expect.stringContaining("recovery"),
			}),
		);
		state.close();
	});
	test("a v2 database migrates to v3: the trace degrades its log from the last message", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "line one\nline two",
			turnLog: textLog("line one\nline two"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.close();

		// Downgrade the database to v2: a trace without the turn log column,
		// and none of the tables the later versions create.
		const db = new Database(path);
		db.exec(`
			DROP TABLE consultation_pending_responses;
			DROP TABLE consultation_remaining_resources;
			DROP TABLE consultation_resources;
			DROP TABLE consultation_snapshots;
			DROP TABLE consultation_turns;
			DROP TABLE consultations;
			DROP TABLE checkout_conflict_confirmations;
			DROP TABLE queue_pause;
			DROP TABLE auto_handoff_mode;
			DROP TABLE work_queue;
		`);
		// The v9 columns belong to the run after this record: a v2 trace never
		// stored a cause, so the v9 step re-adds it.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN turn_log_json").run();
		// A v2 trace carries no model, thinking, or context window: the v7 and
		// v8 columns go with the v6 ones. The consultations table does not
		// exist at this version.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		// The leftover columns belong to v6: a v2 record never heard of them.
		db.exec(
			"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
				" ALTER TABLE handoffs DROP COLUMN herdr_name;",
		);
		// The v13 fact belongs to the run after this record: a v2 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
		db.prepare("UPDATE schema_version SET version = 2").run();
		db.close();

		const reopened = openFactoryState(path);
		const [restored] = reopened.ticketWorkCycle.visibleTickets([], "implement");
		// The legacy trace reads a null log cell and degrades: its last
		// message, one line per entry, stands in for the log.
		expect(restored.lastCompletion).toEqual(
			expect.objectContaining({
				message: "line one\nline two",
				turnLog: [
					{ kind: "text", text: "line one" },
					{ kind: "text", text: "line two" },
				],
				decision: null,
			}),
		);
		reopened.close();
	});
	test("a v5 database migrates to v8: the handoff gains the leftover columns, the trace the settings", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.close();

		// Downgrade the record to the v5 shape: drop the columns the v6, v7,
		// and v8 migrations add, and rewrite the stored choice without the key
		// the v8 step gives it. A v5 handoff row knows nothing of a leftover or
		// a herdr name, and a v5 trace carries no settings.
		const db = new Database(path);
		db.exec(
			"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
				" ALTER TABLE handoffs DROP COLUMN herdr_name;",
		);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
		// The v9 columns belong to the run after this record: a v5 trace never
		// stored a cause, and neither did its consultation turns.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
		// The v10 facts belong to the run after this record: a v5 database
		// never stored a checkout's confirmed conflict set, and its
		// Consultation never held the one-shot override column.
		db.prepare(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
		).run();
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v5 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v5 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
		db.prepare("UPDATE schema_version SET version = 5").run();
		db.prepare(
			"UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')",
		).run();
		db.close();

		const reopened = openFactoryState(path);
		// The trace survives the two settings steps with their empty defaults:
		// no v5 handoff named a model, a level, or a count.
		expect(reopened.ticketWorkCycle.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				message: "Done.",
				model: "",
				thinking: "",
				contextWindow: "",
			}),
		);
		// The handoff carries no leftover fact, and its stored choice reads
		// back without the key a v5 row never held.
		expect(reopened.handoff.leftoverEnvironment(ticket.identity)).toBe(null);
		const [restored] = reopened.ticketWorkCycle.visibleTickets([], "implement");
		expect(restored.handoff).toEqual(
			expect.objectContaining({ model: "", thinking: "", contextWindow: "" }),
		);
		reopened.close();
	});
	test("a v7 database migrates to v8: the trace and a stored choice gain no context window", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.close();

		// Downgrade the record to the v7 shape: drop the column the v8
		// migration adds, and rewrite a stored choice without the key, which
		// is exactly what a v7 handoff row holds.
		const db = new Database(path);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
		// The v9 columns belong to the run after this record: a v7 trace never
		// stored a cause, and neither did its consultation turns.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
		// The v10 facts belong to the run after this record: a v7 database
		// never stored a checkout's confirmed conflict set, and its
		// Consultation never held the one-shot override column.
		db.prepare(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
		).run();
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v7 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v7 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
		db.prepare("UPDATE schema_version SET version = 7").run();
		db.prepare(
			"UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')",
		).run();
		db.close();

		const reopened = openFactoryState(path);
		// The trace survives, and its context window reads as the empty one
		// the migration's default gives it: no v7 handoff named a count.
		expect(reopened.ticketWorkCycle.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({ message: "Done.", contextWindow: "" }),
		);
		// A choice written before the key existed reads back with it empty, so
		// a Restart of a v7 handoff never carries a count it never chose.
		const [restored] = reopened.ticketWorkCycle.visibleTickets([], "implement");
		expect(restored.handoff).toEqual(expect.objectContaining({ contextWindow: "" }));
		reopened.close();
	});
	test("a fresh state file reads the Auto-handoff mode off (ADR 0036)", () => {
		const state = openFactoryState(":memory:");
		expect(state.handoff.autoHandoffMode()).toBe(false);
		state.close();
	});
	test("the Auto-handoff mode written to a file reads back on that file's reopen", () => {
		const path = statePath();
		const state = openFactoryState(path);
		expect(state.handoff.autoHandoffMode()).toBe(false);
		state.handoff.setAutoHandoffMode(true);
		expect(state.handoff.autoHandoffMode()).toBe(true);
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.handoff.autoHandoffMode()).toBe(true);
		reopened.handoff.setAutoHandoffMode(false);
		reopened.close();

		const reread = openFactoryState(path);
		expect(reread.handoff.autoHandoffMode()).toBe(false);
		reread.close();
	});
	test("a mode write to a state file that is gone reports the file it could not write", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.close();
		expect(() => state.handoff.setAutoHandoffMode(true)).toThrow(
			/Auto-handoff mode at .*state\.sqlite/,
		);
	});
	test("a reclaim records no command and refuses a ticket that is not open", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		// A ticket with no handoff at all cannot be reclaimed.
		expect(
			state.handoff.reclaimHandoff("github:github.com:I_6", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "persist-source-facts",
			}),
		).toBe(null);
		const identity = "github:github.com:I_5";
		// The close's re-read keeps every listed ticket, and clears the gate
		// before the ticket's next cycle claims.
		closedCycle(state, identity, undefined, [fetched("github:github.com:I_6"), fetched()]);
		const claim = state.handoff.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-6" });
		// A running ticket is already tracked: a late poll must not stack handoffs.
		expect(
			state.handoff.reclaimHandoff("github:github.com:I_6", {
				paneId: "pane-6",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "persist-source-facts",
			}),
		).toBe(null);
		// An unresolved attempt blocks the reclaim, exactly as it blocks a handoff.
		closedCycle(state, identity);
		const pending = state.handoff.claimHandoff(identity, choice, "open");
		if (!pending.ok) throw new Error(pending.reason);
		expect(
			state.handoff.reclaimHandoff(identity, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "persist-source-facts",
			}),
		).toBe(null);
		expect(
			state.ticketWorkCycle
				.visibleTickets([], "implement")
				.find((ticket) => ticket.identity === identity),
		).toEqual(expect.objectContaining({ state: "open", handoffCount: 2 }));
		state.close();
	});
	test("records a failed Close cleanup as a leftover environment of the handoff", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const handoffId = closedCycle(state, identity);

		expect(
			state.handoff.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId,
				reason:
					"fatal: the worktree contains modified or untracked files, use --force to delete it",
			}),
		).toEqual({
			handoffId,
			environment: "worktree",
			workspaceId: "ws-1",
			tabId: "tab-1",
			paneId: "pane-1",
			reason: "fatal: the worktree contains modified or untracked files, use --force to delete it",
			at: expect.any(String),
		});
		// The fact rides on the ticket, so the detail pane can name it.
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0]).toEqual(
			expect.objectContaining({
				state: "open",
				workCycle: 2,
				leftover: expect.objectContaining({ handoffId, workspaceId: "ws-1", paneId: "pane-1" }),
			}),
		);

		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(1);
		expect(state.handoff.leftoverEnvironment(identity)).toBe(null);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0].leftover).toBe(null);
		// The handoff row keeps why it was left over: the record survives the clear.
		expect(
			state.handoff
				.leftoverEnvironments(identity)
				.every((leftover) => leftover.handoffId !== handoffId),
		).toBe(true);
		state.close();
	});
	test("a leftover named by a herdr collision lands on the handoff that holds the name", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// The close's re-read keeps the ticket listed, and clears the gate
		// before the next cycle claims.
		closedCycle(state, identity, undefined, [fetched()]);
		// A second closed cycle: the ticket now holds two environments, and the
		// collision names the older one by its pane.
		closedCycle(state, identity, undefined, [fetched()]);

		const recorded = state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			paneId: "pane-1",
			reason: "agent name persist-source-facts is already used",
		});
		expect(recorded?.paneId).toBe("pane-1");
		expect(state.handoff.leftoverEnvironments(identity)).toHaveLength(1);
		// A ticket with no handoff to carry the fact records nothing.
		expect(
			state.handoff.recordLeftoverEnvironment({
				ticketIdentity: "github:github.com:I_9",
				reason: "nothing",
			}),
		).toBe(null);
		// With no handle to go on, the ticket's latest handoff is the one whose
		// cycle closed.
		const latest = state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			reason: "the close cleanup did not run",
		});
		expect(latest?.paneId).toBe("pane-1");
		expect(state.handoff.handoffHandles(identity)).toEqual({
			paneIds: ["pane-1", "pane-1"],
			workspaceIds: ["ws-1", "ws-1"],
		});
		state.close();
	});
	test("a clearing names only the environment it ended", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// The close's re-read keeps the ticket listed, and clears the gate
		// before the next cycle claims.
		const first = closedCycle(state, identity, undefined, [fetched()]);
		// The second cycle lived in the same workspace on another tab: the
		// shape a reclaimed agent leaves, where one workspace holds the tabs of
		// several cycles (ADR 0011).
		const second = closedCycle(
			state,
			identity,
			{ paneId: "pane-2", tabId: "tab-2", workspaceId: "ws-1" },
			[fetched()],
		);
		const record = () => {
			state.handoff.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: first,
				reason: "a",
			});
			state.handoff.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: second,
				reason: "b",
			});
			expect(state.handoff.leftoverEnvironments(identity)).toHaveLength(2);
		};

		// A worktree removal closes the workspace, so it ends both facts: both
		// handoffs ran in the one workspace herdr could not remove.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(2);
		expect(state.handoff.leftoverEnvironments(identity)).toEqual([]);

		// A tab close reaches one tab with the panes inside it, not the
		// workspace around it: the fact of the other tab stands.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { tabId: "tab-1" })).toBe(1);
		expect(state.handoff.leftoverEnvironments(identity)).toEqual([
			expect.objectContaining({ handoffId: second }),
		]);

		// A cleanup that ran no command ends nothing herdr can see, so it
		// resolves only the fact of its own handoff row.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { handoffId: first })).toBe(1);
		expect(state.handoff.leftoverEnvironments(identity)).toEqual([
			expect.objectContaining({ handoffId: second }),
		]);

		// A handle that names no fact clears nothing, so a stale answer cannot
		// resolve a leftover the operator still has to end.
		expect(state.handoff.clearLeftoverEnvironments(identity, { tabId: "tab-9" })).toBe(0);
		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-9" })).toBe(0);
		expect(state.handoff.leftoverEnvironments(identity)).toHaveLength(1);
		state.close();
	});
	test("a handoff records the herdr name its agent started under", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			// The stable name was still held by the ticket's own leftover agent.
			agentName: "persist-source-facts-c2",
		});
		// The completion trace of this handoff's turn names the agent herdr
		// actually runs, not the name the ticket would have wanted.
		expect(state.ticketWorkCycle.agentNameForTicket(identity)).toBe("persist-source-facts-c2");
		state.close();
	});
	test("a handoff that stored no herdr name reads the ticket's stable one", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-1" });
		// A legacy row, and every clean handoff of a free name: the naming
		// rule gives the same answer herdr took.
		expect(state.ticketWorkCycle.agentNameForTicket(identity)).toBe("persist-source-facts");
		state.close();
	});
	test("a reclaim refuses an agent that is not the ticket's own", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		// Herdr handed the closed pane's id out again: a different agent works
		// in it now. The reclaim refuses it, and the ticket stays open.
		expect(
			state.handoff.reclaimHandoff(identity, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "consultation-01234567",
			}),
		).toBe(null);
		expect(state.ticketWorkCycle.ticketsByState(["open"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		// The ticket's own agent in the pane is still reclaimed, and the new
		// handoff records its name.
		const claimed = state.handoff.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			agentName: "persist-source-facts",
		});
		expect(claimed).toEqual({ attemptId: expect.any(String) });
		const ticket = state.ticketWorkCycle
			.visibleTickets([], "implement")
			.find((t) => t.identity === identity);
		expect(ticket?.handoff?.herdrName).toBe("persist-source-facts");
		state.close();
	});
	test("a failed clear leaves the leftover standing with its new reason", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		const handoffId = claim.claim.attemptId;
		state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T10:00:00.000Z",
		});
		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(1);
		expect(state.handoff.leftoverEnvironment(identity)).toBe(null);
		// The clear's own cleanup failed: the fact the operator can act on
		// stands again, with the reason herdr gave this time.
		state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId,
			reason: "herdr refused the removal again",
			at: "2026-09-02T10:05:00.000Z",
		});
		expect(state.handoff.leftoverEnvironment(identity)).toEqual(
			expect.objectContaining({
				handoffId,
				reason: "herdr refused the removal again",
				at: "2026-09-02T10:05:00.000Z",
			}),
		);
		state.close();
	});
});
