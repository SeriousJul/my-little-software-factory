/**
 * The Shared checkout hold's own state machine, on its own (issue #297,
 * ADR 0109, issue #297 review).
 *
 * `test/checkout-hold.test.ts` drives the same rule through the Handoff
 * dispatch, which is how an end-to-end reader sees it: the Work queue's rows,
 * the commands the plane reached, and the record's lines. This file drives the
 * module behind that - `CheckoutHoldLedger` - with the four facts it is told
 * (a clock, a config, a holder-stands answer, a row-stands answer) and nothing
 * else, so the two clocks of the bound, the release match, and the two sweeps
 * are measurable without the dispatch's rig, the fake runner, or a state file.
 *
 * The assertions read the gate's answer and the record's lines: the two things
 * the ledger owns. What a row does with the answer - keeps its place, leaves
 * the queue - belongs to the caller, and the dispatch suite owns those.
 */

import { describe, expect, test } from "bun:test";
import {
	CHECKOUT_HOLD_OVER_BUDGET_FACT,
	CHECKOUT_ROW_OVER_BUDGET_FACT,
	CHECKOUT_WORK_BUDGET_MS,
	type CheckoutHoldFacts,
	CheckoutHoldLedger,
	type CheckoutSide,
	checkoutStartOf,
} from "../src/checkout-hold.ts";
import type { FactoryConfig } from "../src/config.ts";
import { recordConsultationName } from "../src/domain/record-name.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type { TicketProjection } from "../src/state/ticket-work-cycle.ts";
import type { WorkQueueHandoffItem, WorkQueuePlaneActionItem } from "../src/state/work-queue.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { queueItem, ticket } from "./fact-fixtures.ts";
import { infoLine, type RecordedLine, recordLogger, warnLine } from "./record-logger.ts";

// The two Repositories, and the Ticket each one holds.
const FACTORY = "github.com/acme/factory";
const BILLING = "github.com/acme/billing";
const FACTORY_TICKET = ticket({
	identity: "I_1",
	title: "Retry policy",
	repositoryRef: repo(FACTORY),
});
const OTHER_TICKET = ticket({ identity: "I_2", title: "Audit log", repositoryRef: repo(FACTORY) });
// A third start of the same Repository, so a test can hand the checkout to a new
// holder and keep the waiting row on its own clock.
const NEXT_TICKET = ticket({
	identity: "I_4",
	title: "Dead letter queue",
	repositoryRef: repo(FACTORY),
});
const BILLING_TICKET = ticket({
	identity: "I_3",
	title: "Invoice pdf",
	repositoryRef: repo(BILLING),
});
// One Consultation record, for the Consultation side of the hold (issue #315):
// the id every record line names by its prefix, and the type it wears beside it.
const CONSULTATION = "c0ffee00-1111-4222-8333-abcdefabcdef";
const CONSULTATION_TYPE = "grill";

function repo(identity: string): NonNullable<Ticket["repositoryRef"]> {
	return { identity, displayName: identity, cloneUrl: "" };
}

/** One worktree Handoff row for one Ticket - the start that takes a hold. */
function worktreeRow(ticketIdentity: string): WorkQueueHandoffItem {
	return queueItem(ticketIdentity, "open") as WorkQueueHandoffItem;
}

/** One merge row for one Ticket - the other start that takes a hold. */
function mergeRow(ticketIdentity: string): WorkQueuePlaneActionItem {
	return {
		kind: "plane-action",
		position: 1,
		ticketIdentity,
		routeFromIdentity: null,
		automatic: false,
		origin: "open",
		taskType: "merge",
		enqueuedAt: "2026-01-01T00:00:00Z",
	};
}

const CONFIG: FactoryConfig = {
	...BASE_CONFIG,
	taskTypes: {
		...BASE_CONFIG.taskTypes,
		merge: { action: "merge-pull-request", method: "squash" },
	},
};

interface Rig {
	ledger: CheckoutHoldLedger;
	lines: RecordedLine[];
	/** Move the clock both budgets measure. */
	advance: (ms: number) => void;
	/** Say whether one start stands - the merge run's mark, the Handoff attempt. */
	holder: (side: CheckoutSide, ticketIdentity: string, stands: boolean) => void;
	/** Say whether the Work queue still holds one row. */
	row: (ticketIdentity: string, stands: boolean) => void;
	/** Say which Repository and type one Consultation record works (issue #315). */
	consultation: (id: string, repository: string, typeName: string) => void;
	/** The projection the gate and the drop line read. */
	projection: () => TicketProjection;
	/** The one read the caller hands the gate and the sweeps. */
	reader: () => TicketProjection;
	/** How many times that read has been asked. */
	reads: () => number;
}

function rig(): Rig {
	let clock = Date.parse("2026-09-01T00:00:00Z");
	const standing = new Set<string>();
	const rows = new Set<string>([
		FACTORY_TICKET.identity,
		OTHER_TICKET.identity,
		BILLING_TICKET.identity,
		NEXT_TICKET.identity,
	]);
	const lines: RecordedLine[] = [];
	const consultations = new Map<string, { repository: string; typeName: string }>();
	const rows_ = [FACTORY_TICKET, OTHER_TICKET, BILLING_TICKET, NEXT_TICKET];
	const projection: TicketProjection = {
		rows: rows_,
		rowFor: (identity: string) => rows_.find((candidate) => candidate.identity === identity),
	};
	let reads = 0;
	const facts: CheckoutHoldFacts = {
		now: () => clock,
		config: () => CONFIG,
		holderStands: (side, ticketIdentity) => standing.has(`${side}:${ticketIdentity}`),
		rowStands: (ticketIdentity) => rows.has(ticketIdentity),
		consultationRepository: (consultationId) => consultations.get(consultationId)?.repository,
		consultationTypeName: (consultationId) => consultations.get(consultationId)?.typeName,
		log: recordLogger(lines),
	};
	const reader = () => {
		reads += 1;
		return projection;
	};
	return {
		ledger: new CheckoutHoldLedger(facts),
		lines,
		advance: (ms) => {
			clock += ms;
		},
		holder: (side, ticketIdentity, stands) => {
			const key = `${side}:${ticketIdentity}`;
			if (stands) standing.add(key);
			else standing.delete(key);
		},
		row: (ticketIdentity, stands) => {
			if (stands) rows.add(ticketIdentity);
			else rows.delete(ticketIdentity);
		},
		consultation: (id, repository, typeName) => {
			consultations.set(id, { repository, typeName });
		},
		projection: () => projection,
		reader,
		reads: () => reads,
	};
}

/** The holder phrase a Consultation start wears in the record's lines. */
function checkoutHoldPhrase(): string {
	return `consultation of ${recordConsultationName(CONSULTATION_TYPE, CONSULTATION)}`;
}

/** Take a hold for one start, the way a claim does: cross, then take. */
function takeHold(r: Rig, item: WorkQueueHandoffItem | WorkQueuePlaneActionItem): void {
	const gate = r.ledger.cross(item, r.reader);
	if (!gate.ok) throw new Error("the fixture's first start never waits");
	r.holder(item.kind === "plane-action" ? "plane-action" : "handoff", item.ticketIdentity, true);
	r.ledger.take(item, gate.checkoutKey);
}

describe("the Shared checkout hold's own state machine (issue #297, ADR 0109)", () => {
	test("one Repository holds one checkout, and the second start waits with its fact", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		const gate = r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
		expect(gate).toEqual({
			ok: false,
			outcome: "waiting",
			fact: `the shared checkout is at work: the handoff of "${FACTORY_TICKET.title}" holds it`,
		});
		// The wait is a standing fact: once while it stands, never once per poll
		// (issue #231).
		const again = r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
		expect(again.ok).toBe(false);
		expect(r.lines.filter((line) => line.message.startsWith("handoff waits:"))).toHaveLength(1);
	});

	test("a second Repository crosses beside the first hold", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		expect(r.ledger.cross(worktreeRow(BILLING_TICKET.identity), r.reader).ok).toBe(true);
	});

	test("one Repository spelled two ways is one checkout", () => {
		const r = rig();
		// The key is the Operation serializer's spelling, so the short name and the
		// host form name one checkout (issue #203, ADR 0053).
		const short = ticket({
			identity: "I_4",
			title: "Short spelling",
			repositoryRef: repo("acme/factory"),
		});
		const rows = [...r.projection().rows, short];
		const projection: TicketProjection = {
			rows,
			rowFor: (identity: string) => rows.find((candidate) => candidate.identity === identity),
		};
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		const gate = r.ledger.cross(worktreeRow(short.identity), () => projection);
		expect(gate.ok).toBe(false);
	});

	test("the hold's age ends the hold and states its own line", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		// The holder stands, and it has stood a whole budget: the plane reads a start
		// that stopped answering, ends the hold, and lets the next start cross
		// (issue #297 review).
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
		expect(r.lines).toContainEqual(
			warnLine(
				`checkout hold dropped: the handoff of "${FACTORY_TICKET.title}" (${CHECKOUT_HOLD_OVER_BUDGET_FACT})`,
			),
		);
	});

	test("the row's own wait ends the row, and its fact names a busy Repository", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
		// The checkout keeps changing hands: every holder is young, so the hold's age
		// never fires, and the row's own wait is what bounds it (issue #297 review).
		r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
		r.ledger.release("handoff", FACTORY_TICKET.identity);
		r.holder("handoff", FACTORY_TICKET.identity, false);
		takeHold(r, worktreeRow(NEXT_TICKET.identity));
		r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader)).toEqual({
			ok: false,
			outcome: "refused",
			fact: CHECKOUT_ROW_OVER_BUDGET_FACT,
			// The refusal carries the classification the gate made, so the caller that
			// drops the row names the channel the wait line named.
			start: { side: "handoff", channel: "handoff" },
		});
		// The refusal carries no Repository key: no reader of a dropped row reads one
		// (issue #297 review).
		expect(r.lines.some((line) => line.message.startsWith("checkout hold dropped:"))).toBe(false);
	});

	test("a hold whose holder no longer stands is dropped by the read", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		// The attempt settled on a path that let nothing go: a bookkeeping miss, not
		// work. The plane keeps the Repository working rather than lock it out, and
		// says nothing, because no run stopped answering.
		r.holder("handoff", FACTORY_TICKET.identity, false);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
		expect(r.lines).toEqual([]);
	});

	test("the sweep ends a hung holder no start asks about again, once", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		r.ledger.sweepHolds(r.reader);
		expect(r.lines).toEqual([
			warnLine(
				`checkout hold dropped: the handoff of "${FACTORY_TICKET.title}" (${CHECKOUT_HOLD_OVER_BUDGET_FACT})`,
			),
		]);
		// The hold is gone, so the next sweep has nothing to end and the next start
		// crosses (issue #297 review).
		r.ledger.sweepHolds(r.reader);
		expect(r.lines).toHaveLength(1);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
	});

	test("the sweep reads the projection only when a hold ends", () => {
		const r = rig();
		r.ledger.sweepHolds(r.reader);
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		const reads = r.reads();
		r.ledger.sweepHolds(r.reader);
		expect(r.reads()).toBe(reads);
		// And a hold that ends does read it, because the line names the holder.
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		r.ledger.sweepHolds(r.reader);
		expect(r.reads()).toBe(reads + 1);
	});

	test("the sweep forgets the waits whose row is gone", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
		r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
		r.row(OTHER_TICKET.identity, false);
		r.ledger.sweepWaits();
		// The row left and a new row for the same Ticket is a new fact, so its wait
		// starts on a fresh reading instead of the budget the old row spent. The
		// holder is replaced on the way, so it is the row's clock and not the hold's
		// age that this test could have fired.
		r.ledger.release("handoff", FACTORY_TICKET.identity);
		r.holder("handoff", FACTORY_TICKET.identity, false);
		takeHold(r, worktreeRow(NEXT_TICKET.identity));
		r.row(OTHER_TICKET.identity, true);
		r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
		const gate = r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.outcome).toBe("waiting");
	});

	test("a release matches the side and the Ticket, never a later holder", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		// The wrong side settles nothing: the merge's run cannot let go of a hold a
		// Handoff took, and the word the record wears stays the holder's.
		expect(r.ledger.release("plane-action", FACTORY_TICKET.identity)).toBe(false);
		expect(r.ledger.release("handoff", BILLING_TICKET.identity)).toBe(false);
		expect(r.ledger.release("handoff", FACTORY_TICKET.identity)).toBe(true);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
	});

	test("a holder the budget dropped cannot release a later start's hold", () => {
		const r = rig();
		takeHold(r, worktreeRow(FACTORY_TICKET.identity));
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		r.ledger.sweepHolds(r.reader);
		// The dropped holder still stands, and its settle still runs. It must not
		// take the checkout the second start holds in its place (issue #297 review).
		takeHold(r, worktreeRow(OTHER_TICKET.identity));
		expect(r.ledger.release("handoff", FACTORY_TICKET.identity)).toBe(false);
		expect(r.ledger.cross(worktreeRow(BILLING_TICKET.identity), r.reader).ok).toBe(true);
		expect(r.ledger.cross(worktreeRow(FACTORY_TICKET.identity), r.reader).ok).toBe(false);
	});

	test("a start that works no checkout crosses and takes no hold", () => {
		const r = rig();
		const live = queueItem(FACTORY_TICKET.identity, "open", {
			choice: { ...worktreeRow(FACTORY_TICKET.identity).choice, environment: "live-worktree" },
		}) as WorkQueueHandoffItem;
		const gate = r.ledger.cross(live, r.reader);
		expect(gate).toEqual({ ok: true, checkoutKey: null });
		r.ledger.take(live, gate.ok ? gate.checkoutKey : null);
		expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
	});

	describe("the Consultation side of the hold (issue #315, ADR 0109)", () => {
		test("a worktree Consultation crosses, takes the hold, and the next start waits behind it", () => {
			const r = rig();
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate.ok).toBe(true);
			if (!gate.ok) return;
			r.holder("consultation", CONSULTATION, true);
			r.ledger.takeConsultation(CONSULTATION, gate.checkoutKey);
			const fact = `the shared checkout is at work: the ${checkoutHoldPhrase()} holds it`;
			const other = r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader);
			expect(other).toEqual({ ok: false, outcome: "waiting", fact });
			expect(r.lines).toContainEqual(infoLine(`handoff waits: "${OTHER_TICKET.title}" (${fact})`));
		});

		test("a Consultation row waits behind a handoff hold, with its own wait line", () => {
			const r = rig();
			takeHold(r, worktreeRow(FACTORY_TICKET.identity));
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			const fact = `the shared checkout is at work: the handoff of "${FACTORY_TICKET.title}" holds it`;
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate).toEqual({ ok: false, outcome: "waiting", fact });
			// The wait line wears the Consultation's own name - its type beside its
			// identity prefix - and states once while it stands (issue #231).
			const name = recordConsultationName(CONSULTATION_TYPE, CONSULTATION);
			expect(r.lines).toContainEqual(infoLine(`consultation waits: ${name} (${fact})`));
			r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(r.lines.filter((line) => line.message.startsWith("consultation waits:"))).toHaveLength(
				1,
			);
		});

		test("a start that holds no queue row waits on no entry and leaves no line", () => {
			const r = rig();
			takeHold(r, worktreeRow(FACTORY_TICKET.identity));
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			// No `r.row(CONSULTATION, true)`: the record holds no Work queue row, the
			// operator's direct start now.
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			// The gate still answers the wait, so the caller can answer the key with
			// the fact - but the queue holds no row, so the record states nothing.
			if (!gate.ok) expect(gate.outcome).toBe("waiting");
			expect(r.lines).toEqual([]);
		});

		test("the Consultation row's own wait ends it with the refusal", () => {
			const r = rig();
			takeHold(r, worktreeRow(FACTORY_TICKET.identity));
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			r.ledger.crossConsultation(CONSULTATION, r.reader);
			// The checkout keeps changing hands: every holder is young, so the hold's
			// age never fires, and the row's own wait is what bounds it (issue #297
			// review), the way the handoff row's refusal test runs.
			r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
			r.ledger.release("handoff", FACTORY_TICKET.identity);
			r.holder("handoff", FACTORY_TICKET.identity, false);
			takeHold(r, worktreeRow(NEXT_TICKET.identity));
			r.advance(CHECKOUT_WORK_BUDGET_MS / 2);
			expect(r.ledger.crossConsultation(CONSULTATION, r.reader)).toEqual({
				ok: false,
				outcome: "refused",
				fact: CHECKOUT_ROW_OVER_BUDGET_FACT,
				// The refusal carries the classification the gate made, so the caller
				// that drops the row names the channel the wait line named.
				start: { side: "consultation", channel: "consultation" },
			});
		});

		test("a Consultation crosses beside a hold of another Repository", () => {
			const r = rig();
			takeHold(r, worktreeRow(FACTORY_TICKET.identity));
			r.consultation(CONSULTATION, BILLING, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			expect(r.ledger.crossConsultation(CONSULTATION, r.reader).ok).toBe(true);
		});

		test("a Consultation record the state no longer holds crosses and takes no hold", () => {
			const r = rig();
			takeHold(r, worktreeRow(FACTORY_TICKET.identity));
			// The record is gone: no Repository, no key, no wait - the way a ticket the
			// projection dropped crosses the gate above with no key.
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate).toEqual({ ok: true, checkoutKey: null });
		});

		test("a release matches the side and the id, and a Consultation hold settles", () => {
			const r = rig();
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate.ok).toBe(true);
			if (!gate.ok) return;
			r.holder("consultation", CONSULTATION, true);
			r.ledger.takeConsultation(CONSULTATION, gate.checkoutKey);
			// The wrong side settles nothing, and the right side lets the next start
			// cross.
			expect(r.ledger.release("handoff", CONSULTATION)).toBe(false);
			expect(r.ledger.release("consultation", CONSULTATION)).toBe(true);
			expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
		});

		test("a hold whose Consultation record left opening is dropped by the read", () => {
			const r = rig();
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate.ok).toBe(true);
			if (!gate.ok) return;
			r.holder("consultation", CONSULTATION, true);
			r.ledger.takeConsultation(CONSULTATION, gate.checkoutKey);
			// The record moved off `opening` on a path that let nothing go: the plane
			// keeps the Repository working rather than lock it out, and says nothing.
			r.holder("consultation", CONSULTATION, false);
			expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
			expect(r.lines).toEqual([]);
		});

		test("the hold's age ends a Consultation hold and states its line", () => {
			const r = rig();
			r.consultation(CONSULTATION, FACTORY, CONSULTATION_TYPE);
			r.row(CONSULTATION, true);
			const gate = r.ledger.crossConsultation(CONSULTATION, r.reader);
			expect(gate.ok).toBe(true);
			if (!gate.ok) return;
			r.holder("consultation", CONSULTATION, true);
			r.ledger.takeConsultation(CONSULTATION, gate.checkoutKey);
			r.advance(CHECKOUT_WORK_BUDGET_MS);
			expect(r.ledger.cross(worktreeRow(OTHER_TICKET.identity), r.reader).ok).toBe(true);
			const name = recordConsultationName(CONSULTATION_TYPE, CONSULTATION);
			expect(r.lines).toContainEqual(
				warnLine(
					`checkout hold dropped: the consultation of ${name} (${CHECKOUT_HOLD_OVER_BUDGET_FACT})`,
				),
			);
		});
	});

	test("one classification names a start's side and its word together", () => {
		// The release path needs the side and the record line needs the word, and the
		// two come from one reading of the item so they cannot drift (issue #297
		// review). The Plane action's word is the registry's.
		expect(checkoutStartOf(worktreeRow(FACTORY_TICKET.identity), CONFIG)).toEqual({
			side: "handoff",
			channel: "handoff",
		});
		expect(checkoutStartOf(mergeRow(FACTORY_TICKET.identity), CONFIG)).toEqual({
			side: "plane-action",
			channel: "merge",
		});
		// A task type the registry holds no action for names no channel, and its
		// run's own gate refuses it.
		expect(
			checkoutStartOf({ ...mergeRow(FACTORY_TICKET.identity), taskType: "implement" }, CONFIG),
		).toBeNull();
	});
});
