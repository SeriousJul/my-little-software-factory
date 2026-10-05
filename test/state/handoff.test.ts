/**
 * The handoff aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { FetchedTicket, LeftoverEnvironment } from "../../src/domain/ticket.ts";
import type { FactoryState } from "../../src/state.ts";
import { openFactoryState, SCHEMA_VERSION } from "../../src/state.ts";
import {
	choice,
	cleanup,
	closedCycle,
	fetched,
	HARNESS_AGENT_NAME,
	labeled,
	POSITION_STATES,
	sourceA,
	statePath,
	success,
	textLog,
} from "./harness.ts";

afterEach(cleanup);

/**
 * The standing leftover facts of one Ticket (issue #202 review). The Handoff
 * aggregate answers the facts for a list of Tickets, so the test reads its own
 * Ticket out of that answer instead of a per-Ticket read the interface does not
 * carry.
 */
function leftoversOf(state: FactoryState, identity: string): LeftoverEnvironment[] {
	return state.handoff.leftoverEnvironmentsFor([identity]).get(identity) ?? [];
}

describe("the handoff aggregate", () => {
	test("an in-flight ticket keeps its own matched State from the source facts", () => {
		// The Handoff records the task it started with, and the position is
		// still what the labels say: the two facts stand apart, and the
		// grouping reads the State the machine matched now.
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["needs-review"])]));
		const [open] = state.ticketWorkCycle.ticketListViews(POSITION_STATES, "implement").rows;
		expect(open.matchedStateName).toBe("needs-review");
		const claim = state.handoff.claimHandoff(
			open.identity,
			{ ...choice, taskType: "implement" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		const [flight] = state.ticketWorkCycle.ticketListViews(POSITION_STATES, "implement").rows;
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
			state.ticketWorkCycle
				.ticketListViews([], "implement", "active")
				.rows.map((row) => row.identity);
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows[0].state).toBe("awaiting");

		// The decision records on the trace and ends the cycle.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const [returned] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [restored] = reopened.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [restored] = reopened.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		const [restored] = reopened.ticketWorkCycle.ticketListViews([], "implement").rows;
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
				.ticketListViews([], "implement")
				.rows.find((ticket) => ticket.identity === identity),
		).toEqual(
			expect.objectContaining({
				state: "open",
				// The attempt ledger, not the started-handoff table (ADR 0101): the
				// two closed cycles and the claim this test left unresolved. No reclaim
				// added a row of its own.
				handoffCount: 3,
			}),
		);
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
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows[0]).toEqual(
			expect.objectContaining({
				state: "open",
				workCycle: 2,
				leftover: expect.objectContaining({ handoffId, workspaceId: "ws-1", paneId: "pane-1" }),
			}),
		);

		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(1);
		expect(state.handoff.leftoverEnvironment(identity)).toBe(null);
		expect(state.ticketWorkCycle.ticketListViews([], "implement").rows[0].leftover).toBe(null);
		// The handoff row keeps why it was left over: the record survives the clear.
		expect(leftoversOf(state, identity).every((leftover) => leftover.handoffId !== handoffId)).toBe(
			true,
		);
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
		expect(leftoversOf(state, identity)).toHaveLength(1);
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
			expect(leftoversOf(state, identity)).toHaveLength(2);
		};

		// A worktree removal closes the workspace, so it ends both facts: both
		// handoffs ran in the one workspace herdr could not remove.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(2);
		expect(leftoversOf(state, identity)).toEqual([]);

		// A tab close reaches one tab with the panes inside it, not the
		// workspace around it: the fact of the other tab stands.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { tabId: "tab-1" })).toBe(1);
		expect(leftoversOf(state, identity)).toEqual([expect.objectContaining({ handoffId: second })]);

		// A cleanup that ran no command ends nothing herdr can see, so it
		// resolves only the fact of its own handoff row.
		record();
		expect(state.handoff.clearLeftoverEnvironments(identity, { handoffId: first })).toBe(1);
		expect(leftoversOf(state, identity)).toEqual([expect.objectContaining({ handoffId: second })]);

		// A handle that names no fact clears nothing, so a stale answer cannot
		// resolve a leftover the operator still has to end.
		expect(state.handoff.clearLeftoverEnvironments(identity, { tabId: "tab-9" })).toBe(0);
		expect(state.handoff.clearLeftoverEnvironments(identity, { workspaceId: "ws-9" })).toBe(0);
		expect(leftoversOf(state, identity)).toHaveLength(1);
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
		expect(state.ticketWorkCycle.agentNameForTicket(identity)).toBe(HARNESS_AGENT_NAME);
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
			agentName: HARNESS_AGENT_NAME,
		});
		expect(claimed).toEqual({ attemptId: expect.any(String) });
		const ticket = state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((t) => t.identity === identity);
		expect(ticket?.handoff?.herdrName).toBe(HARNESS_AGENT_NAME);
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

/**
 * The failed start's hold, and the start count the Handoff limit reads
 * (ADR 0077 as extended by ADR 0101, issue #217).
 *
 * The state clock stands at 11:00 so an attempt's own time is the fixture's, and
 * the source's last read stands at 10:01 until a test re-reads the Ticket.
 */
const ATTEMPT_NOW = () => Date.parse("2026-08-31T11:00:00Z");
const TICKET = "github:github.com:I_5";

/** One open Ticket, and the automatic start that never reached its Agent. */
function failedStartState() {
	const state = openFactoryState(":memory:", ATTEMPT_NOW);
	state.sourceFact.initializeSources([sourceA]);
	state.sourceFact.applyFetch(sourceA, success([fetched()]));
	const claim = state.handoff.claimHandoff(TICKET, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
	return state;
}

/** The Ticket's newest Handoff attempt settled `failed`. */
function failAnotherStart(state: FactoryState, reason: string): void {
	const claim = state.handoff.claimHandoff(TICKET, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, false, reason);
}

describe("the failed start's hold (ADR 0077, ADR 0101)", () => {
	test("a failed start reads as unrefreshed until the source re-reads the Ticket", () => {
		const state = failedStartState();
		// The last successful read of the Ticket's source (10:01) stands before
		// the failed start (11:00): the hold stands.
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched()],
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		state.close();
	});

	test("the hold is the newest attempt's fact, not any attempt's", () => {
		const state = failedStartState();
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		// The re-ask ran on the refresh and reached its Agent: the newest attempt
		// started work, so the older failure no longer stands.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched()],
		});
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		state.close();
	});

	test("a started handoff, and a Ticket with no attempt, never read as unrefreshed", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		state.close();
	});

	test("an attempt still in flight holds nothing: the claim gate owns that one", () => {
		const state = failedStartState();
		// The failed start released on the refresh, and the next claim is still
		// running. An attempt with no outcome yet is not a failure to wait out;
		// the unresolved attempt is what holds the next claim (ADR 0041).
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched()],
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		const pending = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!pending.ok) throw new Error(pending.reason);
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		expect(state.handoff.handoffInFlight(TICKET)).toBe(true);
		state.close();
	});

	test("the hold survives the state file being closed and reopened", () => {
		const path = statePath();
		const state = openFactoryState(path, ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
		state.close();
		const reopened = openFactoryState(path, ATTEMPT_NOW);
		expect(reopened.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		reopened.close();
	});

	test("the wait is measured from the outcome's time, not the claim's", () => {
		// The claim lands at 11:00 and herdr refuses it at 11:10. A source read
		// between the two is not the release: the Ticket's facts were no different
		// then than they were before the start, and the failure was not yet a fact
		// (ADR 0101).
		let nowMs = Date.parse("2026-08-31T11:00:00Z");
		const state = openFactoryState(":memory:", () => nowMs);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		nowMs = Date.parse("2026-08-31T11:10:00Z");
		state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:05:00Z",
			tickets: [fetched()],
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:10:01Z",
			tickets: [fetched()],
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		state.close();
	});

	test("two attempts claimed in the same millisecond: the later claim is the newest", () => {
		// The clock stands still, so both attempt rows carry one `created_at`. The
		// newest read breaks the tie on the insert order, and the hold follows the
		// attempt that actually ran last: the start that reached its Agent.
		const state = failedStartState();
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(false);
		state.close();
	});

	test("the newest-attempt index reaches a file written before it (ADR 0101)", () => {
		// The hold reads the Ticket's newest attempt for every candidate the walk
		// reaches. On a Ticket carrying thousands of attempts that read needs an
		// index behind it, so the v27 file gains `attempts_ticket_latest` on the
		// next open and the hold keeps its answer across the migration.
		const path = statePath();
		const state = openFactoryState(path, ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
		state.close();

		const db = new Database(path);
		db.exec("DROP INDEX attempts_ticket_latest");
		db.prepare("UPDATE schema_version SET version = 27").run();
		db.close();

		const reopened = openFactoryState(path, ATTEMPT_NOW);
		expect(reopened.handoff.handoffBlockedUnrefreshed(TICKET)).toBe(true);
		reopened.close();
		const check = new Database(path, { readonly: true });
		const indexes = (
			check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexes).toContain("attempts_ticket_latest");
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});
});

/**
 * The run of failed starts the Failed-start park counts (issue #298, ADR 0106).
 *
 * The same ledger the Attempt hold reads answers the run, but the run is a length
 * and not a wait: it is the Ticket's newest attempts read back until one settled
 * otherwise or is still in flight. The state clock stands at 11:00, so an
 * attempt's own time is the fixture's.
 */
describe("the run of failed Handoff starts (issue #298)", () => {
	/** One start that reached its Agent, on a Ticket with no attempts yet. */
	function startOne(state: FactoryState): void {
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
	}

	test("the run is the failed settles claimed after the last start that reached an Agent", () => {
		const state = failedStartState();
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(1);
		failAnotherStart(state, "herdr refused the start");
		failAnotherStart(state, "herdr refused the start");
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(3);
		state.close();
	});

	test("a start that reaches its Agent ends the run", () => {
		// The operator's own Handoff that works, or the automatic re-ask that finally
		// lands, is the end of the run: the park the run stands on leaves with it.
		const state = failedStartState();
		failAnotherStart(state, "herdr refused the start");
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(2);
		startOne(state);
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(0);
		state.close();
	});

	test("an attempt still in flight ends the run", () => {
		// An attempt with no outcome yet is not a failed start, and the next claim
		// cannot run behind it (ADR 0041): the run stops at it.
		const state = failedStartState();
		failAnotherStart(state, "herdr refused the start");
		const pending = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!pending.ok) throw new Error(pending.reason);
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(0);
		state.handoff.settleHandoff(pending.claim.attemptId, false, "herdr refused the start");
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(3);
		state.close();
	});

	test("a Ticket whose whole ledger failed is one run, and a Ticket with no attempt has none", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(
			sourceA,
			success([fetched(), { ...fetched(), externalKey: "I_9" }]),
		);
		for (let i = 0; i < 4; i += 1) failAnotherStart(state, "herdr refused the start");
		const streaks = state.handoff.failedStartStreaksFor([TICKET, "github:github.com:I_9"]);
		expect(streaks.get(TICKET)).toBe(4);
		// A Ticket the read holds no row for answers zero, not absent: the caller
		// folds the run into every row it lists.
		expect(streaks.get("github:github.com:I_9")).toBe(0);
		state.close();
	});

	test("two claims in the same millisecond: the later claim is the boundary", () => {
		// The clock stands still, so both rows carry one `created_at`. The run counts
		// by the claim order, so the start that actually ran last ends it, and a
		// failure claimed before it is not counted as a failure after it.
		const state = failedStartState();
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(1);
		startOne(state);
		expect(state.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(0);
		state.close();
	});

	test("the run's indexes reach a file written before them (issue #298)", () => {
		// The projection reads the run for every Ticket it lists, in one statement.
		// On a file carrying thousands of attempts that statement needs the two
		// partial indexes behind it, so a v28 file gains them on the next open and
		// the run keeps its answer across the migration.
		const path = statePath();
		const state = openFactoryState(path, ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		failAnotherStart(state, "herdr refused the start");
		failAnotherStart(state, "herdr refused the start");
		state.close();

		const db = new Database(path);
		for (const index of ["attempts_ticket_failed", "attempts_ticket_reached"]) {
			db.exec(`DROP INDEX ${index}`);
		}
		db.prepare("UPDATE schema_version SET version = 28").run();
		db.close();

		const reopened = openFactoryState(path, ATTEMPT_NOW);
		expect(reopened.handoff.failedStartStreaksFor([TICKET]).get(TICKET)).toBe(2);
		reopened.close();
		const check = new Database(path, { readonly: true });
		const indexes = (
			check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexes).toContain("attempts_ticket_failed");
		expect(indexes).toContain("attempts_ticket_reached");
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});
});

describe("the Handoff limit counts every attempt (ADR 0005, ADR 0101)", () => {
	test("a start that never reached an Agent counts beside one that did", () => {
		const state = failedStartState();
		// The failed start wrote an attempt row and no handoff row: the count the
		// limit reads sees it (issue #217).
		expect(state.handoff.handoffCount(TICKET)).toBe(1);
		failAnotherStart(state, "herdr refused the name");
		expect(state.handoff.handoffCount(TICKET)).toBe(2);
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// A start that reached its Agent keeps its one row in the ledger, so the
		// count a Ticket that never failed carries is the number it carried
		// before: one per start, not two.
		expect(state.handoff.handoffCount(TICKET)).toBe(3);
		expect(
			state.ticketWorkCycle
				.ticketListViews([], "implement")
				.rows.find((ticket) => ticket.identity === TICKET)?.handoffCount,
		).toBe(3);
		expect(state.handoff.handoffCountsFor([TICKET]).get(TICKET)).toBe(3);
		state.close();
	});

	test("a Ticket with no start carries zero, and every Ticket carries its own", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		failAnotherStart(state, "the worktree path already exists");
		const counts = state.handoff.handoffCountsFor(["github:github.com:I_6", TICKET]);
		expect([...counts]).toEqual([
			["github:github.com:I_6", 0],
			[TICKET, 1],
		]);
		state.close();
	});
});

/**
 * What one settle leaves in the attempt's own record (issue #295). The record
 * line a failed Handoff start states reads its reason out of this answer, so the
 * file and the ledger cannot state two endings for one start, and the line
 * follows the settle's one write.
 */
describe("the settle answers with the attempt's own record (issue #295)", () => {
	test("a failed settle answers with the reason its row stores, and a repeat answers nothing", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		expect(
			state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists"),
		).toEqual({
			ticketIdentity: TICKET,
			failureReason: "the worktree path already exists",
		});
		// The attempt settled once. A settle that reaches it again - a recovery
		// that got there first, a run that outlived its own settle - answers no
		// record, so its caller writes no second line for one attempt.
		expect(state.handoff.settleHandoff(claim.claim.attemptId, false, "a later reason")).toBeNull();
		state.close();
	});

	test("a failed settle that names no reason answers no reason", () => {
		// The door the record line's fallback stands behind. It is a guard: every
		// start this plane settles names its reason, so no live run reaches this
		// answer. The settle's own interface still lets a failed settle name no
		// reason, and the attempt's reason column is nullable in every schema
		// version, so the answer carries the empty cell rather than making an
		// ending up (issue #295 review).
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		expect(state.handoff.settleHandoff(claim.claim.attemptId, false)).toEqual({
			ticketIdentity: TICKET,
			failureReason: null,
		});
		state.close();
	});

	test("the stage a start advanced through never answers for the ending", () => {
		// The start ran through its stages before herdr refused it. The settle
		// writes its ending over those stages, and the answer reads the row the
		// write left: the reason the line states is the one this settle stored, not
		// anything the stages before it hold (issue #295 review).
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.advanceHandoffAttempt(claim.claim.attemptId, "creating-environment");
		state.handoff.advanceHandoffAttempt(claim.claim.attemptId, "starting-agent");
		expect(
			state.handoff.settleHandoff(claim.claim.attemptId, false, "herdr is unavailable"),
		).toEqual({
			ticketIdentity: TICKET,
			failureReason: "herdr is unavailable",
		});
		state.close();
	});

	test("a settle that reached its Agent stores no reason", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		expect(
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-1" }),
		).toEqual({
			ticketIdentity: TICKET,
			failureReason: null,
		});
		state.close();
	});

	test("the boot's recovery answers each unsettled attempt with the reason it wrote", () => {
		const state = openFactoryState(":memory:", ATTEMPT_NOW);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(TICKET, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		// The run ends with the claim unresolved. The next boot settles it, and
		// answers with the record it settled, the way the dispatch's own settle
		// answers for a start that reached no Agent.
		expect(state.handoff.recoverUnsettledHandoffs()).toEqual([
			{
				ticketIdentity: TICKET,
				failureReason: "the run that claimed this handoff ended before it settled it",
			},
		]);
		// Nothing stands unsettled, so the next recovery has nothing to record.
		expect(state.handoff.recoverUnsettledHandoffs()).toEqual([]);
		state.close();
	});
});
