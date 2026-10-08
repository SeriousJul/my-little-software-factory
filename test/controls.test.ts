/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "bun:test";

import {
	type AvailabilityFacts,
	actionBarControls,
	availabilityFacts,
	availabilityFor,
	type ControlDefinition,
	compactKeyLabels,
	controlById,
	controlForKey,
	controlsForMode,
	guideControls,
	type InteractionMode,
	type OwnFacts,
	type StandingFacts,
} from "../src/components/controls.ts";
import { GROUPING_AXES } from "../src/domain/grouping.ts";
import type { Ticket, TicketListFilter } from "../src/domain/ticket.ts";
import type { Consultation } from "../src/state/consultation-record.ts";

/**
 * The plane's standing facts, as this suite reads them.
 *
 * Every mode's Availability facts carry this record beside the facts only that
 * mode's controls read. A test names the facts its assertion is about; the
 * helper below supplies the rest of the mode's own record, so no test spreads
 * a facts record it does not own and no test needs a cast.
 */
const STANDING: StandingFacts = {
	sourceCount: 0,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageRecorded: false,
	consultationTypesConfigured: true,
	interactionExitKey: "f12",
	queuePaused: false,
};

/** The facts a mode's controls read when a test says nothing about them. */
const OWN_FACTS = {
	"ticket-list": {
		selectedTicket: undefined,
		selectedTicketMarker: null,
		ticketListFilter: "active",
		ticketPaneAlive: false,
		ticketPaneForeign: false,
		groupingAxis: "none",
		selectedGroupHeader: null,
		groupHeaderSelected: false,
		selectedGroupPosition: 0,
		visibleGroupHeaderCount: 0,
		listCanMove: true,
		queueItemForSelectedRow: null,
	},
	"ticket-detail": {
		selectedTicket: undefined,
		selectedTicketMarker: null,
		ticketListFilter: "active",
		ticketPaneAlive: false,
		ticketPaneForeign: false,
		groupingAxis: "none",
		selectedGroupHeader: null,
		groupHeaderSelected: false,
		selectedGroupPosition: 0,
		visibleGroupHeaderCount: 0,
		queueItemForSelectedRow: null,
		detailCanScroll: true,
	},
	"consultation-list": {
		selectedConsultation: undefined,
		consultationRefreshAvailable: false,
		consultationAgentStatus: null,
		consultationPaneAlive: false,
		listCanMove: true,
		queueItemForSelectedRow: null,
	},
	"consultation-detail": {
		selectedConsultation: undefined,
		consultationRefreshAvailable: false,
		consultationAgentStatus: null,
		consultationPaneAlive: false,
		queueItemForSelectedRow: null,
		detailCanScroll: true,
	},
	"work-queue-list": {
		selectedWorkQueueItem: null,
		workQueueDepth: 0,
		listCanMove: true,
	},
	"work-queue-detail": {
		selectedWorkQueueItem: null,
		workQueueDepth: 0,
		detailCanScroll: true,
	},
	"consultation-interaction": {},
	"form-field": { fieldHasSelection: false },
	"form-selector": { fieldHasSelection: false, formCycleCount: 0 },
	"form-action": { fieldHasSelection: false, formRefusal: null },
	"decision-modal": {
		actionRowCount: 2,
		editableActionSelected: false,
		planeActionSelected: false,
		bodyScrollable: true,
		bodyEmpty: false,
	},
	"missing-modal": { actionRowCount: 2 },
	"action-panel": { actionRowCount: 2 },
	"live-view": {
		selectedTicket: undefined,
		ticketPaneAlive: false,
		ticketPaneForeign: false,
		bodyScrollable: true,
		bodyEmpty: false,
	},
	"repository-select": { listCanMove: true, repositoryCount: 0, searchText: "", pendingCount: 0 },
	"key-guide": {},
	"message-view": { bodyScrollable: false, bodyEmpty: true },
	"override-list": {},
	"override-model": { fieldHasSelection: false },
	"override-text": { fieldHasSelection: false },
} satisfies { [M in InteractionMode]: OwnFacts<M> };

/** Every fact any mode can name, so a test can name one by name. */
type ModeOwn = OwnFacts<InteractionMode>;

/** The facts of one mode: the mode's own defaults beside what the test names. */
function facts(
	mode: InteractionMode,
	own: Partial<ModeOwn & StandingFacts> = {},
): AvailabilityFacts {
	return availabilityFacts(mode, STANDING, { ...OWN_FACTS[mode], ...own });
}

const consultationWithPane = { paneId: "pane-1" } as unknown as Consultation;

/**
 * The same context with one item under the Work queue's cursor, so the two
 * queue modes hold a real row to move, remove, and read the refusal against.
 */
/**
 * The same facts with one item under the Work queue's cursor, so the two queue
 * modes hold a real row to move, remove, and read the refusal against.
 */
const queueValues: Partial<OwnFacts<"work-queue-list"> & OwnFacts<"work-queue-detail">> = {
	selectedWorkQueueItem: {
		kind: "handoff",
		ticketIdentity: "github:github.com:I_5",
		origin: "open",
		position: 0,
		automatic: false,
		routeFromIdentity: null,
		choice: {
			agentType: "claude",
			environment: "worktree",
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
		},
		previousMessage: "",
		enqueuedAt: "2026-02-17T10:00:00.000Z",
	},
	workQueueDepth: 2,
};

/** The cursor on a Consultation's queue item (issue #90), for the queue's keys. */
/** The cursor on a Consultation's queue item (issue #90), for the queue's keys. */
const queueConsultationValues: Partial<
	OwnFacts<"work-queue-list"> & OwnFacts<"work-queue-detail">
> = {
	selectedWorkQueueItem: {
		kind: "consultation",
		consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
		position: 0,
		enqueuedAt: "2026-02-17T10:00:00.000Z",
	},
	workQueueDepth: 2,
};

const runningTicketWithPane = {
	state: "running",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const awaitingTicketWithPane = {
	state: "awaiting",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const openTicket = { state: "open", handoff: null } as unknown as Ticket;
/** A row of the state the ignore reads, with only the facts the predicate takes. */
const rowTicket = (over: Record<string, unknown>): Ticket => ({ ...over }) as unknown as Ticket;

/** The guide groups that list one control for one context. */
function guideGroupsFor(facts: AvailabilityFacts, id: string): string[] {
	return guideControls(facts)
		.filter(({ control }) => control.id === id)
		.map(({ group }) => group);
}

/**
 * The Grouping axis' split values: the ones that draw a header, so the ones the
 * Action bar can name (issue #159).
 */
const SPLIT_AXES = GROUPING_AXES.filter((axis) => axis !== "none");

// Issue #182 (ADR 0075): `i` splits from the ignore on the row the cursor
// stands on. A Group header under the repository axis runs the Repository
// init, a Group header under any other axis refuses in the init's own words,
// and a Ticket row keeps the ignore's `i`.
test("i runs the Repository init on a repository Group header and refuses elsewhere", () => {
	const repoHeader = facts("ticket-list", {
		groupingAxis: "repository",
		groupHeaderSelected: true,
	});
	const repoControl = controlForKey({ name: "i" }, repoHeader);
	expect(repoControl?.id).toBe("repository-init");
	if (repoControl === undefined) throw new Error("no control resolved for i");
	expect(availabilityFor(repoControl, repoHeader)).toEqual({ available: true });

	// On any other axis the key is the ignore's: the init refuses, the ignore
	// first in the catalogue supplies the refusal, and the operator never reads
	// an init refusal on a row the init does not run on.
	for (const axis of SPLIT_AXES) {
		if (axis === "repository") continue;
		const other = facts("ticket-list", {
			groupingAxis: axis,
			groupHeaderSelected: true,
		});
		expect(controlForKey({ name: "i" }, other)?.id).toBe("ticket-ignore");
	}

	// On a Ticket row the key is the ignore's, whatever the axis.
	const row = facts("ticket-list", {
		groupingAxis: "repository",
		groupHeaderSelected: false,
		selectedTicket: rowTicket({ state: "open", ignored: false }),
	});
	expect(controlForKey({ name: "i" }, row)?.id).toBe("ticket-ignore");
});

// Issue #159: the Grouping axis is one key that steps a fixed cycle, and it
// answers in both Ticket panes wherever the plane does, so a press in a
// collapsed Ticket section still records the operator's choice.
test("Tab cycles the Grouping axis in both Ticket modes, and refuses nowhere", () => {
	for (const mode of ["ticket-list", "ticket-detail"] as const) {
		const context = facts(mode, { groupingAxis: "none" });
		const control = controlForKey({ name: "tab" }, context);
		expect(control?.id).toBe("group-axis");
		if (control === undefined) throw new Error(`Tab answers nothing in ${mode}`);
		expect(availabilityFor(control, context)).toEqual({ available: true });
		// The flat list wears no hint of its own, and the bar hides the entry
		// whole at `none`: the catalogue states no word an operator could never
		// read, so a hint exists only where a Group header stands to explain it.
		expect(control.barLabel?.(context)).toBeUndefined();
		expect(actionBarControls(mode, context).map((entry) => entry.id)).not.toContain("group-axis");
		// Every split axis names itself on the bar, and the guide row carries the
		// whole cycle so the order is documented where it is used.
		for (const axis of SPLIT_AXES) {
			const split = facts(mode, { groupingAxis: axis });
			expect(controlForKey({ name: "tab" }, split)?.barLabel?.(split)).toBe(`Group: ${axis}`);
			expect(actionBarControls(mode, split).map((entry) => entry.id)).toContain("group-axis");
		}
		expect(control.guideNote).toBe(
			"cycles the grouping axis: none, repository, source, task, state, position",
		);
	}
	// The axis control belongs to the Ticket section alone: the other two
	// sections bind no Tab at all, and their bars hint no axis. Their guides
	// carry it only among the controls of another mode, the way they carry the
	// Ticket section's Hand off, Close, and auto-handoff switch.
	for (const mode of [
		"consultation-list",
		"consultation-detail",
		"work-queue-list",
		"work-queue-detail",
	] as const) {
		expect(controlForKey({ name: "tab" }, facts(mode))).toBeUndefined();
		const groups = guideControls(facts(mode));
		expect(
			groups.filter(
				({ control, group }) => control.id === "group-axis" && group === "Current interaction mode",
			),
		).toEqual([]);
		expect(actionBarControls(mode, facts(mode)).map((c) => c.id)).not.toContain("group-axis");
	}
});

// The header fact is the Ticket list's own: a cursor resting on a Group header
// while another section holds the focus leaves that section's `x` the Section
// toggle, in its own words, and no fold anywhere (issue #159, issue #170).
test("a Group header under the Ticket cursor gives no other section a fold", () => {
	for (const mode of [
		"consultation-list",
		"consultation-detail",
		"work-queue-list",
		"work-queue-detail",
	] as const) {
		const context = facts(mode, {
			groupingAxis: "repository",
			groupHeaderSelected: true,
			selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: false },
		});
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
		expect(availabilityFor(controlById("section-toggle"), context)).toEqual({
			available: true,
		});
		// `Space` is the Ticket section's fold key alone: the other sections
		// hold no Groups and answer it nowhere (issue #170).
		expect(controlForKey({ name: "space" }, context)).toBeUndefined();
	}
});

test("the flat list hints no axis, and a grouped list names its own", () => {
	const context = facts("ticket-list", { groupingAxis: "none" });
	expect(actionBarControls("ticket-list", context).map((c) => c.id)).not.toContain("group-axis");
	const grouped = facts("ticket-list", { groupingAxis: "position" });
	expect(actionBarControls("ticket-list", grouped).map((c) => c.id)).toContain("group-axis");
});

/**
 * Issue #170: one key, one meaning, on every row. `Space` is the Group
 * fold's own key, and it answers only on a Group header row; `x` is the
 * Section toggle on every row, a Group header row included. The Action bar
 * states only the meaning the current facts run, and the Key guide names
 * both controls, the way it names every meaning of Enter.
 */
test("Space folds the Group under the cursor, and x toggles the Section on every row", () => {
	const onHeader = facts("ticket-list", {
		groupingAxis: "repository",
		groupHeaderSelected: true,
		selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: false },
	});
	const fold = controlForKey({ name: "space" }, onHeader);
	expect(fold?.id).toBe("group-fold");
	if (fold === undefined) throw new Error("Space answers nothing on a Group header");
	expect(availabilityFor(fold, onHeader)).toEqual({ available: true });
	expect(fold.barLabel?.(onHeader)).toBe("Fold group");
	const collapsed = facts("ticket-list", {
		...onHeader,
		selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: true },
	});
	expect(controlById("group-fold").barLabel?.(collapsed)).toBe("Unfold group");
	// The bar names both keys, each with its one meaning: the fold by `Space`
	// and the section toggle by `x` (issue #170).
	const hinted = actionBarControls("ticket-list", onHeader).map((control) => control.id);
	expect(hinted).toContain("group-fold");
	expect(hinted).toContain("section-toggle");
	// The guide of the same mode names both controls the same way.
	const ids = guideControls(onHeader).map(({ control }) => control.id);
	expect(ids).toContain("section-toggle");
	expect(ids).toContain("group-fold");

	// `x` keeps its one meaning on the header row: the Section toggle.
	expect(controlForKey({ name: "x" }, onHeader)?.id).toBe("section-toggle");
	expect(availabilityFor(controlById("section-toggle"), onHeader)).toEqual({
		available: true,
	});

	// On a ticket row the fold refuses in its own words, and the toggle keeps
	// its key.
	const onRow = facts("ticket-list", {
		groupingAxis: "repository",
		groupHeaderSelected: false,
		selectedGroupHeader: null,
	});
	expect(controlForKey({ name: "space" }, onRow)?.id).toBe("group-fold");
	expect(availabilityFor(controlById("group-fold"), onRow)).toEqual({
		available: false,
		reason: "no Group header is under the cursor",
	});
	expect(controlForKey({ name: "x" }, onRow)?.id).toBe("section-toggle");
	expect(availabilityFor(controlById("section-toggle"), onRow)).toEqual({ available: true });
	// The bar of a ticket row names the toggle and not the fold: the fold's
	// key refuses there, and the bar spends its cells on the keys the row
	// under the cursor answers.
	const rowHints = actionBarControls("ticket-list", onRow).map((control) => control.id);
	expect(rowHints).toContain("section-toggle");
	expect(rowHints).not.toContain("group-fold");
});

test("every Ticket control answers a Group header with no Ticket selected", () => {
	// The shell leaves `selectedTicket` unset where the cursor stands on a
	// header, and each control states that fact itself: no surface swallows
	// the key (story 39).
	const onHeader = facts("ticket-list", {
		groupingAxis: "repository",
		groupHeaderSelected: true,
		selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: false },
		queueItemForSelectedRow: null,
	});
	for (const id of ["handoff", "live-view", "decide-completion", "ticket-goto", "override"]) {
		expect(availabilityFor(controlById(id), onHeader)).toEqual({
			available: false,
			reason: "no Ticket is selected",
		});
	}
	expect(availabilityFor(controlById("ticket-close"), onHeader)).toEqual({
		available: false,
		reason: "no Ticket is selected",
	});
	expect(availabilityFor(controlById("queue-jump"), onHeader)).toEqual({
		available: false,
		reason: "no Ticket is selected",
	});
	// Enter resolves to the section's Hand off, so the refusal the operator
	// reads is the catalogue's own words.
	expect(controlForKey({ name: "return" }, onHeader)?.id).toBe("handoff");
	// The Consultation section keeps its own words for the same row keys:
	// nothing there reads as a missing Ticket.
	const consultation = facts("consultation-list", {
		queueItemForSelectedRow: null,
	});
	expect(availabilityFor(controlById("queue-jump"), consultation)).toEqual({
		available: false,
		reason: "the selected row has no waiting queue item",
	});
});

describe("the shared control catalogue", () => {
	test("x toggles the section under the cursor and is not an Interact alias", () => {
		const context = facts("consultation-detail");
		const interact = guideControls(context).find(
			({ control }) => control.id === "consultation-interact",
		);

		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
		expect(interact?.control.keys("consultation-detail", context)).toEqual(["return"]);
	});

	test("the Ticket guide names the section toggle in its own section", () => {
		const context = facts("ticket-list");
		const entries = guideControls(context);
		const toggle = entries.find(({ control }) => control.id === "section-toggle");

		expect(toggle?.group).toBe("Current interaction mode");
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
	});

	test("the plane-level keys stand in the plane group in every section (issue #319)", () => {
		// The Queue pause's key and the Auto-handoff mode's key left their
		// sections: the guide lists them under Control plane controls wherever
		// the operator is, and the key resolves in the mode they dispatch in.
		const context = facts("consultation-list");
		const entries = guideControls(context);
		const plane = entries.filter(({ control }) => control.scope === "control-plane");
		for (const id of ["queue-pause", "auto-handoff"] as const) {
			const listed = plane.filter(({ control }) => control.id === id);
			expect(listed).toHaveLength(1);
			expect(listed[0].group).toBe("Control plane controls");
		}
		expect(controlForKey({ name: "a" }, context)?.id).toBe("auto-handoff");
		expect(controlForKey({ name: "p" }, context)?.id).toBe("queue-pause");
	});

	test("the Delete key is the Consultation section's own row key, not the section toggle", () => {
		// No Consultation under the cursor: the queue's removal owns the key's
		// words in the Consultation section, and the section toggle keeps `x`.
		const context = facts("consultation-detail");

		expect(controlForKey({ name: "delete" }, context)?.id).toBe("queue-remove");
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
		// A live Consultation under the cursor: the section's own Close is the
		// act, and the removal and the record's removal refuse behind it.
		const live = facts("consultation-detail", {
			selectedConsultation: { state: "working" } as unknown as Consultation,
		});
		expect(controlForKey({ name: "delete" }, live)?.id).toBe("consultation-close");
	});

	// ADR 0122: the Consultation's Close answers the Delete key on every state
	// that holds an Agent - a live one the panel confirms, a broken one that
	// closes direct, and the stuck one the panel recovers. The two states that
	// hold no Agent no longer close at the key: a `queued` record gives it to
	// the queue's removal, and an `unscheduled` one gives it to the record's
	// removal.
	test("the Consultation close answers the Delete key on every state that holds an Agent", () => {
		const close = controlById("consultation-close");
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			expect(availabilityFor(close, facts(mode))).toEqual({
				available: false,
				reason: "no Consultation is selected",
			});
			for (const state of [
				"opening",
				"working",
				"awaiting-response",
				"missing",
				"failed",
				"closing",
			] as const) {
				expect(
					availabilityFor(
						close,
						facts(mode, { selectedConsultation: { state } as unknown as Consultation }),
					),
				).toEqual({ available: true });
			}
			expect(
				availabilityFor(
					close,
					facts(mode, { selectedConsultation: { state: "queued" } as unknown as Consultation }),
				),
			).toEqual({
				available: false,
				reason: "the selected Consultation waits in the Work queue: Delete takes its row out",
			});
			expect(
				availabilityFor(
					close,
					facts(mode, {
						selectedConsultation: { state: "unscheduled" } as unknown as Consultation,
					}),
				),
			).toEqual({
				available: false,
				reason: "the selected Consultation is unscheduled: Delete removes the record and its history",
			});
			expect(
				availabilityFor(
					close,
					facts(mode, { selectedConsultation: { state: "closed" } as unknown as Consultation }),
				),
			).toEqual({
				available: false,
				reason: "the selected Consultation is already closed",
			});
		}
	});

	// Issue #91, ADR 0122: the record removal answers the Delete key on a
	// `closed` and on an `unscheduled` record, and refuses the states that
	// still run - the close or the queue's removal answers them.
	test("the Consultation removal answers the Delete key on the closed and the unscheduled record", () => {
		const remove = controlById("consultation-delete");
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			for (const state of ["closed", "unscheduled"] as const) {
				expect(
					availabilityFor(
						remove,
						facts(mode, { selectedConsultation: { state } as unknown as Consultation }),
					),
				).toEqual({ available: true });
			}
			for (const state of [
				"queued",
				"opening",
				"working",
				"awaiting-response",
				"missing",
				"failed",
				"closing",
			] as const) {
				expect(
					availabilityFor(
						remove,
						facts(mode, { selectedConsultation: { state } as unknown as Consultation }),
					),
				).toEqual({
					available: false,
					reason: "only a closed or unscheduled Consultation can be removed",
				});
			}
		}
	});

	test("z answers nothing in the Consultation section", () => {
		for (const mode of ["consultation-list", "consultation-detail"] as const)
			expect(controlForKey({ name: "z" }, facts(mode))).toBeUndefined();
	});

	test("d resolves nowhere, and f cycles the Ticket section's own filter", () => {
		// ADR 0122: `d` left the catalogue with the record removal's move to the
		// Delete key, so the retired key resolves to no control in any mode, and
		// a press of it states nothing, the way every unclaimed key does.
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
			"work-queue-list",
			"work-queue-detail",
		] as const) {
			expect(controlForKey({ name: "d" }, facts(mode))).toBeUndefined();
		}
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const context = facts(mode);
			// The Ticket section owns `f` in its own modes now (ADR 0060): the key
			// cycles the List filter, and the Consultation section's History keeps
			// its section-only place behind it.
			const filterControl = controlForKey({ name: "f" }, context);
			expect(filterControl?.id).toBe("ticket-filter");
			if (filterControl === undefined) throw new Error("the Ticket section lost its filter");
			expect(availabilityFor(filterControl, context)).toEqual({ available: true });
			expect(availabilityFor(controlById("history"), context)).toEqual({
				available: false,
				reason: "this control is available only in the Consultation section",
			});
		}
		// In the Consultation section the keys keep their own meanings: the
		// record removal answers the Delete key, and History keeps its `f`.
		const consultation = facts("consultation-list");
		expect(controlForKey({ name: "f" }, consultation)?.id).toBe("history");
		const closed = facts("consultation-list", {
			selectedConsultation: { state: "closed" } as unknown as Consultation,
		});
		const closedDelete = controlForKey({ name: "delete" }, closed);
		const closedHistory = controlForKey({ name: "f" }, closed);
		if (closedDelete === undefined || closedHistory === undefined)
			throw new Error("Remove and History are missing from the catalogue");
		expect(closedDelete.id).toBe("consultation-delete");
		expect(availabilityFor(closedDelete, closed).available).toBe(true);
		expect(availabilityFor(closedHistory, closed).available).toBe(true);
	});

	// The ignore's gate is one predicate (ADR 0060): the availability answers with
	// the obligation's words, and the write reads the same rule. The catalogue
	// test takes the facts the row's own face carries - the Ticket state, the
	// newest settled turn, and the poll's missing marker - so the refusal cannot
	// drift from what the list shows.
	test("i ignores in both Ticket panes, and refuses a Ticket that owes a decision", () => {
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const open = facts(mode, { selectedTicket: openTicket });
			const ignore = controlForKey({ name: "i" }, open);
			expect(ignore?.id).toBe("ticket-ignore");
			if (ignore === undefined) throw new Error("the Ticket section lost its ignore");
			expect(availabilityFor(ignore, open)).toEqual({ available: true });
			// The same key on an ignored row takes the Ticket back, whatever state
			// it rests in: clearing hides nothing.
			const ignoredRow = facts(mode, {
				selectedTicket: { ...openTicket, ignored: true, ignoredAt: "2026-09-24T10:00:00Z" },
			});
			expect(availabilityFor(ignore, ignoredRow)).toEqual({ available: true });
			expect(controlById("ticket-ignore").barLabel?.(ignoredRow)).toBe("Un-ignore");
			expect(controlById("ticket-ignore").barLabel?.(open)).toBe("Ignore");
			// The three obligations, in the Message line's own words.
			const awaiting = facts(mode, {
				selectedTicket: rowTicket({ state: "awaiting", ignored: false, lastCompletion: null }),
			});
			expect(availabilityFor(ignore, awaiting)).toEqual({
				available: false,
				reason: "the selected Ticket cannot be ignored: it awaits a decision",
			});
			const held = facts(mode, {
				selectedTicket: rowTicket({
					state: "awaiting",
					ignored: false,
					lastCompletion: { cause: "failed", decision: null },
				}),
			});
			expect(availabilityFor(ignore, held)).toEqual({
				available: false,
				reason: "the selected Ticket cannot be ignored: its held turn awaits a decision",
			});
			const missing = facts(mode, {
				selectedTicket: rowTicket({ state: "running", ignored: false, lastCompletion: null }),
				selectedTicketMarker: "missing",
			});
			expect(availabilityFor(ignore, missing)).toEqual({
				available: false,
				reason: "the selected Ticket cannot be ignored: its Agent is missing",
			});
			// Taking a Ticket back is never refused, so the flag stands under each
			// obligation the row's own face wears: the row that cannot be put away is
			// always the row that can be taken back (ADR 0060, user story 15). The three
			// contexts run the un-ignore past each refusal's own fact.
			for (const owed of [
				facts(mode, {
					selectedTicket: rowTicket({ state: "awaiting", ignored: true, lastCompletion: null }),
				}),
				facts(mode, {
					selectedTicket: rowTicket({
						state: "awaiting",
						ignored: true,
						lastCompletion: { cause: "failed", decision: null },
					}),
				}),
				facts(mode, {
					selectedTicket: rowTicket({ state: "running", ignored: true, lastCompletion: null }),
					selectedTicketMarker: "missing",
				}),
			]) {
				expect(availabilityFor(ignore, owed)).toEqual({ available: true });
				expect(controlById("ticket-ignore").barLabel?.(owed)).toBe("Un-ignore");
			}
			// A blocked Agent owes no decision, so the key stands.
			const blocked = facts(mode, {
				selectedTicket: rowTicket({ state: "running", ignored: false, lastCompletion: null }),
				selectedTicketMarker: "blocked",
			});
			expect(availabilityFor(ignore, blocked)).toEqual({ available: true });
			// No row under the cursor: the key says so, like the section's other keys.
			expect(availabilityFor(ignore, facts(mode))).toEqual({
				available: false,
				reason: "no Ticket is selected",
			});
		}
	});

	// Story 25: the sections that do not own the keys refuse them in the
	// catalogue's words and name them nowhere - each section's guide keeps its
	// own shape (ADR 0060).
	test("i and f refuse outside the Ticket section, and every other guide omits them", () => {
		for (const mode of [
			"consultation-list",
			"consultation-detail",
			"work-queue-list",
			"work-queue-detail",
		] as const) {
			const context = facts(mode, queueValues);
			const ignore = controlForKey({ name: "i" }, context);
			expect(ignore?.id).toBe("ticket-ignore");
			if (ignore === undefined) throw new Error("i answers nothing outside the Ticket section");
			expect(availabilityFor(ignore, context)).toEqual({
				available: false,
				reason: "this control is available only in the Ticket section",
			});
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).not.toContain("ticket-ignore");
			expect(ids).not.toContain("ticket-filter");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).not.toContain("ticket-ignore");
			expect(hinted).not.toContain("ticket-filter");
		}
		// The Ticket section's own guide and bar name both keys, in each pane.
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const context = facts(mode, { selectedTicket: openTicket });
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).toContain("ticket-ignore");
			expect(ids).toContain("ticket-filter");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).toContain("ticket-ignore");
			expect(hinted).toContain("ticket-filter");
		}
	});

	// The `f` cycle names the state it moves to, so the hint says what the key
	// will show before the operator presses it (ADR 0060, widened by ADR 0070).
	test("f names the state the Ticket section's filter moves to", () => {
		const labels: Array<[TicketListFilter, string]> = [
			["active", "Show ignored"],
			["ignored", "Show muted"],
			["muted", "Show all"],
			["all", "Show active"],
		];
		for (const [filter, label] of labels) {
			const context = facts("ticket-list", { ticketListFilter: filter });
			expect(controlById("ticket-filter").barLabel?.(context)).toBe(label);
		}
	});

	// The `u` act on the source flips between Mute and Un-mute, and names the
	// source the act reaches, the way the ignore's word reads its own state
	// (ADR 0070).
	test("u mutes and un-mutes the row's source, and names it on the bar", () => {
		const withSource = (muted: boolean) =>
			facts("ticket-list", {
				selectedTicket: {
					...openTicket,
					muted,
					memberships: [{ sourceName: "acme/factory-issues" }],
				} as unknown as Ticket,
			});
		expect(controlById("ticket-mute").barLabel?.(withSource(false))).toBe(
			"Mute acme/factory-issues",
		);
		expect(controlById("ticket-mute").barLabel?.(withSource(true))).toBe(
			"Un-mute acme/factory-issues",
		);
	});

	// The mute rides on the row in both of the Ticket section's modes, the way
	// the ignore does, and nowhere else (ADR 0070).
	test("u reaches the row in both Ticket panes, and nowhere else", () => {
		for (const mode of ["ticket-list", "ticket-detail", "work-queue-list"] as const) {
			const context = facts(mode, { selectedTicket: openTicket });
			const availability = availabilityFor(controlById("ticket-mute"), context);
			const inTicketSection = mode === "ticket-list" || mode === "ticket-detail";
			expect(availability.available, `${mode}: the mute reaches the row`).toBe(inTicketSection);
			if (!inTicketSection) {
				expect(availability.reason).toContain("Ticket");
			}
		}
		// The row that names no source still rides the act: the key mutes the
		// source the Ticket came in on, and the bar names the act's object alone.
		const bare = facts("ticket-list", {
			selectedTicket: { ...openTicket, memberships: [] },
		});
		expect(availabilityFor(controlById("ticket-mute"), bare).available).toBe(true);
		expect(controlById("ticket-mute").barLabel?.(bare)).toBe("Mute source");
	});

	test("a refused key is never hinted by the bar unless the guide names it, in every base mode", () => {
		// The guard that keeps the catalogue's display rules in step: a control
		// the mode dispatches a key for is either available, named in the guide
		// with its reason, or omitted from the guide and the bar together. A
		// future Consultation-only key that refuses in another section and
		// still shows up in that section's bar fails here. The walk covers all
		// six base modes, so the Work queue's two answer to it too (ADR 0034).
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
			"work-queue-list",
			"work-queue-detail",
		] as const) {
			const context = facts(mode, queueValues);
			const named = new Set(guideControls(context).map(({ control }) => control.id));
			const hinted = new Set(actionBarControls(mode, context).map((control) => control.id));
			for (const control of controlsForMode(mode)) {
				const availability = availabilityFor(control, context);
				expect(
					availability.available || named.has(control.id) || !hinted.has(control.id),
					`${control.id} in ${mode}: the bar hints a key the guide does not name`,
				).toBe(true);
			}
		}
	});

	test("Enter is the force-dispatch on a queue row, and it keeps its refusals", () => {
		// The force-dispatch (issue #89) is the queue's only meaning of Enter, in
		// the pane that holds the rows. A Handoff in flight holds no
		// force-dispatch (ADR 0064): the seat it runs on answers by the
		// module's own seat rules, the way the pickup's does, and a Consultation
		// item runs its own pickup seam and never parks on the herdr seat
		// (issue #90). On an empty queue it carries the queue's row keys' one
		// reason.
		const control = controlForKey({ name: "return" }, facts("work-queue-list", queueValues));
		expect(control?.id).toBe("queue-force-dispatch");
		if (control === undefined) throw new Error("the queue lost its force-dispatch");
		expect(availabilityFor(control, facts("work-queue-list", queueValues))).toEqual({
			available: true,
		});
		// The ask never waits on a run (ADR 0064): a Handoff in flight holds no
		// Handoff item, and the Consultation item stands in the same moment, the
		// way a launcher submit does.
		expect(
			availabilityFor(control, facts("work-queue-list", { ...queueValues, handoffActive: true })),
		).toEqual({ available: true });
		expect(
			availabilityFor(
				control,
				facts("work-queue-list", { ...queueConsultationValues, handoffActive: true }),
			),
		).toEqual({ available: true });
		expect(availabilityFor(control, facts("work-queue-list", queueConsultationValues))).toEqual({
			available: true,
		});
		const empty = facts("work-queue-list");
		expect(availabilityFor(control, empty)).toEqual({
			available: false,
			reason: "no queue item is under the cursor",
		});
		// The key the other section's Enter answers is a different control: the
		// queue's Enter reaches only the queue's list pane.
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
			"work-queue-detail",
		] as const) {
			expect(
				controlsForMode(mode).some((candidate) => candidate.id === "queue-force-dispatch"),
			).toBe(false);
		}
		// The guide names the key in the queue's own section with its note,
		// whatever the item's facts run.
		const entry = guideControls(facts("work-queue-list", queueValues)).find(
			({ control }) => control.id === "queue-force-dispatch",
		);
		expect(entry?.group).toBe("Current interaction mode");
		expect(entry?.control.guideNote).toBe(
			"starts the item over a full Parallel limit; a failure leaves the queue",
		);
	});

	test("the ask controls never wait on a run, and the normal Quit does (ADR 0064)", () => {
		// A Handoff in flight holds no ask: Hand off, Decide, the route edit,
		// and the queue force-dispatch each answer by their own rules - the
		// claim, the state, the seat - and only the normal Quit, which tears
		// the process down mid-run, gates on the fact.
		const busy = { handoffActive: true };
		const open = rowTicket({ state: "open", handoff: null, actionable: true });
		expect(
			availabilityFor(
				controlById("handoff"),
				facts("ticket-list", { ...busy, selectedTicket: open }),
			),
		).toEqual({ available: true });
		expect(
			availabilityFor(
				controlById("decide-completion"),
				facts("ticket-list", { ...busy, selectedTicket: awaitingTicketWithPane }),
			),
		).toEqual({ available: true });
		expect(
			availabilityFor(
				controlById("override"),
				facts("ticket-list", { ...busy, selectedTicket: open }),
			),
		).toEqual({ available: true });
		expect(
			availabilityFor(
				controlById("queue-force-dispatch"),
				facts("work-queue-list", { ...queueValues, ...busy }),
			),
		).toEqual({ available: true });
		// The Quit is the one control that waits on a run, with its own words.
		const quit = controlById("quit");
		expect(availabilityFor(quit, facts("ticket-list", { ...busy }))).toEqual({
			available: false,
			reason: "normal Quit is unavailable during a Handoff",
		});
		expect(availabilityFor(quit, facts("ticket-list"))).toEqual({ available: true });
	});

	// ADR 0122: the Delete key answers in every base section, and each
	// section's guide names the Delete acts its own mode runs - never the other
	// sections' acts, which refuse there in the catalogue's words. The queue's
	// removal is dispatched in every base mode, so every base guide names it
	// among its own rows; the Ticket section's Close and the Consultation
	// section's Close and record removal keep their places in their own guides
	// alone.
	test("each base guide names only the Delete acts its own mode runs", () => {
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const ids = guideControls(facts(mode)).map(({ control }) => control.id);
			expect(ids).not.toContain("history");
			expect(ids).not.toContain("consultation-delete");
			expect(ids).not.toContain("consultation-close");
			expect(ids).toContain("queue-remove");
			const ticketClose = guideControls(facts(mode)).find(
				({ control }) => control.id === "ticket-close",
			);
			expect(ticketClose?.group).toBe("Current interaction mode");
		}
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			const entries = guideControls(facts(mode));
			const ids = entries.map(({ control }) => control.id);
			expect(ids).not.toContain("ticket-close");
			for (const id of ["history", "consultation-delete", "consultation-close", "queue-remove"]) {
				expect(ids).toContain(id);
				expect(entries.find(({ control }) => control.id === id)?.group).toBe(
					"Current interaction mode",
				);
			}
		}
		for (const mode of ["work-queue-list", "work-queue-detail"] as const) {
			const ids = guideControls(facts(mode, queueValues)).map(({ control }) => control.id);
			expect(ids).not.toContain("history");
			expect(ids).not.toContain("consultation-delete");
			expect(ids).not.toContain("consultation-close");
			expect(ids).toContain("queue-remove");
		}
	});

	// The Work queue shares the list surface with the other two sections, so the
	// Consultation section's removal and History reach its modes by way of the
	// common base modes. They refuse there in the owning section's words, and
	// the queue's guide and bar name them nowhere: each section's guide names
	// the keys it dispatches (issue #85, ADR 0034). The queue's own removal is
	// the queue section's own Delete act (ADR 0122), and it answers the key in
	// the queue's own modes with the item under the cursor.
	test("the Delete key removes the queue item in both Work queue modes, and f refuses", () => {
		for (const mode of ["work-queue-list", "work-queue-detail"] as const) {
			const context = facts(mode, queueValues);
			// The queue's removal answers the Delete key with the item under the
			// cursor, and the bar and the guide name it in the queue's own modes.
			const remove = controlForKey({ name: "delete" }, context);
			expect(remove?.id).toBe("queue-remove");
			if (remove === undefined) throw new Error("the queue lost its removal");
			expect(availabilityFor(remove, context)).toEqual({ available: true });
			// An empty queue refuses with the queue's row key's one reason.
			expect(availabilityFor(controlById("queue-remove"), facts(mode))).toEqual({
				available: false,
				reason: "no queue item is under the cursor",
			});
			// `f` now belongs to two lists, so the queue's refusal names both
			// owners instead of the Consultation section alone (ADR 0060).
			const filterControl = controlForKey({ name: "f" }, context);
			if (filterControl === undefined)
				throw new Error("History is missing from the Work queue modes");
			expect(availabilityFor(filterControl, context)).toEqual({
				available: false,
				reason: "this control is available only in the Ticket section and the Consultation section",
			});
			// Either owner may answer the key, and the words are the same: the
			// refusal cannot depend on which candidate the catalogue reaches first.
			expect(availabilityFor(controlById("history"), context)).toEqual({
				available: false,
				reason: "this control is available only in the Ticket section and the Consultation section",
			});
			// The Consultation section's record removal reaches the queue's modes
			// by way of the common base modes, and refuses there in the owning
			// section's words, not its own closed-Consultation reason.
			expect(availabilityFor(controlById("consultation-delete"), context)).toEqual({
				available: false,
				reason: "this control is available only in the Consultation section",
			});
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).not.toContain("history");
			expect(ids).not.toContain("consultation-delete");
			expect(ids).toContain("queue-remove");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).not.toContain("history");
			expect(hinted).not.toContain("consultation-delete");
			expect(hinted).toContain("queue-remove");
		}
		// A closed Consultation under the cursor changes nothing in the queue:
		// the record removal still refuses in the Consultation's words, because
		// the ownership, not the row, decides.
		const withClosedConsultation: Partial<ModeOwn & StandingFacts> = {
			...queueValues,
			selectedConsultation: { state: "closed" } as unknown as Consultation,
		};
		const detail = facts("work-queue-detail", withClosedConsultation);
		const deleteControl = controlById("consultation-delete");
		expect(availabilityFor(deleteControl, detail).available).toBe(false);
	});

	test("p pauses and resumes the queue, and the bar's hint stands while the pause stands", () => {
		// One item under the cursor, unpaused: the key resolves to the pause,
		// and the bar names no hint while the brake is down - the standing
		// brake earns its width, and the Key guide carries the key the rest of
		// the time (issue #319, ADR 0111).
		const open = facts("work-queue-list", { ...queueValues, queuePaused: false });
		const unpaused = controlForKey({ name: "p" }, open);
		expect(unpaused?.id).toBe("queue-pause");
		if (unpaused === undefined) throw new Error("p answers nothing in the queue mode");
		expect(availabilityFor(unpaused, open)).toEqual({ available: true });
		expect(actionBarControls("work-queue-list", open).map((control) => control.id)).not.toContain(
			"queue-pause",
		);
		expect(unpaused.barLabel?.(open)).toBe("Pause queue");
		// Paused: the same key now resolves to the resume, the hint stands in
		// every mode, and the bar's label flips with the fact the shell writes.
		const paused = facts("work-queue-list", { ...queueValues, queuePaused: true });
		const resume = controlForKey({ name: "p" }, paused);
		expect(resume?.id).toBe("queue-pause");
		if (resume === undefined) throw new Error("p answers nothing in the queue mode");
		expect(availabilityFor(resume, paused)).toEqual({ available: true });
		expect(actionBarControls("work-queue-list", paused).map((control) => control.id)).toContain(
			"queue-pause",
		);
		expect(resume.barLabel?.(paused)).toBe("Resume queue");
	});

	/**
	 * Story 48 (ADR 0049, ADR 0052), amended by ADR 0111: the queue's order
	 * keys still refuse outside the queue, in the queue's words. The pause's
	 * key left the queue (issue #319): `p` resolves to the brake in every
	 * section and answers there, the way the mode's key does.
	 */
	test("+ and - refuse outside the Work queue, in the queue's words", () => {
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
		] as const) {
			const context = facts(mode);
			// The brake's key reaches the whole plane: the key resolves and the
			// brake answers from the state it reads in the section.
			const pause = controlForKey({ name: "p" }, context);
			if (pause === undefined || pause.id !== "queue-pause")
				throw new Error(`p does not resolve to queue-pause in ${mode}`);
			expect(availabilityFor(pause, context)).toEqual({ available: true });
			if (mode === "ticket-list" || mode === "ticket-detail") {
				// The Ticket section's own order keys: the Group move owns the
				// key, and it refuses on a row that holds no Group header.
				expect(controlForKey({ name: "+" }, context)?.id).toBe("group-move-up");
				expect(controlForKey({ name: "=" }, context)?.id).toBe("group-move-up");
				expect(controlForKey({ name: "-" }, context)?.id).toBe("group-move-down");
				for (const key of ["+", "-"] as const) {
					const control = controlForKey({ name: key }, context);
					if (control === undefined) throw new Error(`${key} answers nothing in ${mode}`);
					expect(availabilityFor(control, context)).toEqual({
						available: false,
						reason: "no Group header is under the cursor",
					});
				}
			} else {
				for (const key of ["+", "-"] as const) {
					const control = controlForKey({ name: key }, context);
					const expected = key === "+" ? "queue-promote" : "queue-demote";
					if (control === undefined || control.id !== expected)
						throw new Error(`${key} does not resolve to ${expected} in ${mode}`);
					expect(availabilityFor(control, context)).toEqual({
						available: false,
						reason: "this control is available only in the Work queue section",
					});
				}
			}
			// The guide still names none of the queue's order controls here; the
			// brake's key stands in the plane group the guide lists in every mode.
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).toContain("queue-pause");
			expect(ids).not.toContain("queue-promote");
			expect(ids).not.toContain("queue-demote");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			// The brake is down, so its hint stands nowhere, and the order keys
			// name no hint in a section they do not reach.
			expect(hinted).not.toContain("queue-pause");
			expect(hinted).not.toContain("queue-promote");
			expect(hinted).not.toContain("queue-demote");
		}
		// In the queue's own modes the keys keep their meanings: the pause is
		// available, and the order moves answer with their own availability.
		const queue = facts("work-queue-list", queueValues);
		expect(controlForKey({ name: "p" }, queue)?.id).toBe("queue-pause");
		expect(controlForKey({ name: "+" }, queue)?.id).toBe("queue-promote");
		expect(controlForKey({ name: "-" }, queue)?.id).toBe("queue-demote");
	});

	test("the field modes carry the plane keys on the F4 and F5 aliases (issue #319)", () => {
		// The letters type into the rows the field modes own, so the F-keys carry
		// the brake and the mode there, the way F1 and F2 carry Help and
		// Message. The guide shows the alias the mode wears.
		for (const mode of ["form-field", "override-text", "override-model"] as const) {
			const context = facts(mode);
			expect(controlForKey({ name: "f4" }, context)?.id).toBe("queue-pause");
			expect(controlForKey({ name: "f5" }, context)?.id).toBe("auto-handoff");
			const pause = guideControls(context).find(({ control }) => control.id === "queue-pause");
			const modeToggle = guideControls(context).find(
				({ control }) => control.id === "auto-handoff",
			);
			expect(pause?.group).toBe("Control plane controls");
			expect(modeToggle?.group).toBe("Control plane controls");
		}
	});

	test("the agent terminal names the plane keys by absence (issue #319)", () => {
		// The one surface where neither key reaches the plane: the mode owns its
		// keys and forwards them to the Agent, so the keys resolve nowhere, and
		// the guide names the controls by their absence - a key the terminal
		// gives to the Agent is not a key the guide can promise.
		const context = facts("consultation-interaction");
		expect(controlForKey({ name: "p" }, context)).toBeUndefined();
		expect(controlForKey({ name: "a" }, context)).toBeUndefined();
		const ids = guideControls(context).map(({ control }) => control.id);
		expect(ids).not.toContain("queue-pause");
		expect(ids).not.toContain("auto-handoff");
	});

	test("g is Goto in both Consultation panes, and it needs the Agent's pane alive", () => {
		const withAlivePane: Partial<ModeOwn & StandingFacts> = {
			selectedConsultation: consultationWithPane,
			consultationPaneAlive: true,
		};
		const detail = facts("consultation-detail", withAlivePane);
		const list = facts("consultation-list", withAlivePane);
		const found = controlForKey({ name: "g" }, detail);
		const control: ControlDefinition | undefined = found;

		expect(control?.id).toBe("consultation-goto");
		expect(controlForKey({ name: "g" }, list)?.id).toBe("consultation-goto");
		if (control === undefined) throw new Error("Goto is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		const paneGone = facts("consultation-detail", {
			...withAlivePane,
			consultationPaneAlive: false,
		});
		expect(availabilityFor(control, paneGone)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
		expect(availabilityFor(control, facts("consultation-detail")).available).toBe(false);
	});

	test("g is Goto in both Ticket panes, and it needs the pane the way the Consultation names it", () => {
		const inFlight: Partial<ModeOwn & StandingFacts> = {
			selectedTicket: runningTicketWithPane,
			ticketPaneAlive: true,
		};
		const detail = facts("ticket-detail", inFlight);
		const list = facts("ticket-list", inFlight);
		const control: ControlDefinition | undefined = controlForKey({ name: "g" }, detail);

		expect(control?.id).toBe("ticket-goto");
		expect(controlForKey({ name: "g" }, list)?.id).toBe("ticket-goto");
		if (control === undefined) throw new Error("Goto is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		// The in-flight Ticket's pane goes away in the last poll: the
		// Consultation section's own refusal words.
		const paneGone = facts("ticket-detail", { ...inFlight, ticketPaneAlive: false });
		expect(availabilityFor(control, paneGone)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
		// An awaiting Ticket keeps its recorded pane: the poll or a decision
		// still moves it, and Goto is the way to look in the meantime.
		const awaiting = facts("ticket-detail", {
			selectedTicket: awaitingTicketWithPane,
		});
		expect(availabilityFor(control, awaiting).available).toBe(true);
		// An open Ticket has no agent at all: the same refusal.
		const open = facts("ticket-list", { selectedTicket: openTicket });
		expect(availabilityFor(control, open)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
	});

	test("the Delete key is Close in both Ticket panes, on every state but open (ADR 0031)", () => {
		const inFlight: Partial<ModeOwn & StandingFacts> = {
			selectedTicket: runningTicketWithPane,
		};
		const detail = facts("ticket-detail", inFlight);
		const list = facts("ticket-list", inFlight);
		const control: ControlDefinition | undefined = controlForKey({ name: "delete" }, detail);

		expect(control?.id).toBe("ticket-close");
		expect(controlForKey({ name: "delete" }, list)?.id).toBe("ticket-close");
		if (control === undefined) throw new Error("Close is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		// An awaiting ticket has a settled turn to close, and it asks too.
		expect(
			availabilityFor(control, facts("ticket-list", { selectedTicket: awaitingTicketWithPane }))
				.available,
		).toBe(true);
		// An open ticket has no work in flight: the refusal the key states.
		expect(availabilityFor(control, facts("ticket-list", { selectedTicket: openTicket }))).toEqual({
			available: false,
			reason: "the selected Ticket is open: no work is in flight to close",
		});
		// No row at all is its own reason, the way every Ticket control names it.
		expect(availabilityFor(control, facts("ticket-list")).available).toBe(false);
	});

	// ADR 0122: the queue's removal answers the Delete key in the Ticket panes
	// with the row the cursor's item waits with. The state split comes before
	// the row: the Ticket's Close claims every state that holds live or settled
	// work, even one that also waits with a Restart row (ADR 0108), so the
	// removal answers the `open` Ticket alone.
	test("queue-remove answers the Delete key in both Ticket panes, on an open Ticket that waits", () => {
		const remove = controlById("queue-remove");
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			// No row under the cursor: the Ticket's Close owns the key and states
			// its own refusal.
			expect(controlForKey({ name: "delete" }, facts(mode))?.id).toBe("ticket-close");
			// The open Ticket that waits with a row: the removal is the act, and
			// the Ticket's Close refuses the open state first.
			const waiting = facts(mode, {
				selectedTicket: openTicket,
				queueItemForSelectedRow: queueValues.selectedWorkQueueItem,
			});
			expect(controlForKey({ name: "delete" }, waiting)?.id).toBe("queue-remove");
			expect(availabilityFor(remove, waiting)).toEqual({ available: true });
			expect(availabilityFor(remove, facts(mode, { selectedTicket: openTicket }))).toEqual({
				available: false,
				reason: "the selected Ticket has no waiting queue item",
			});
			// The states the Close claims refuse the removal: the Ticket's work
			// cycle stands behind the key.
			for (const state of ["handed-off", "running", "awaiting"] as const) {
				expect(
					availabilityFor(remove, facts(mode, { selectedTicket: rowTicket({ state }) })),
				).toEqual({
					available: false,
					reason: "the selected Ticket is not open: Delete closes its work cycle",
				});
			}
		}
	});

	// ADR 0122: the queue's removal answers the Delete key in the Consultation
	// panes with the row the cursor's record waits with. A `queued` record
	// loses its row and stays `unscheduled` behind it (issue #90), the states
	// the Close runs on refuse the row's removal, and the two states that hold
	// no Agent give the key to the record's removal instead.
	test("queue-remove answers the Delete key in both Consultation panes, on the queued record", () => {
		const remove = controlById("queue-remove");
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			// No row under the cursor: the removal states the queue's row refusal,
			// and it owns the key's words in the Consultation section.
			expect(controlForKey({ name: "delete" }, facts(mode))?.id).toBe("queue-remove");
			expect(availabilityFor(remove, facts(mode))).toEqual({
				available: false,
				reason: "no Consultation is selected",
			});
			// The queued record that waits with a row: the removal takes the row
			// out, and the record stays unscheduled behind it.
			const queued = facts(mode, {
				selectedConsultation: { state: "queued" } as unknown as Consultation,
				queueItemForSelectedRow: queueConsultationValues.selectedWorkQueueItem,
			});
			expect(controlForKey({ name: "delete" }, queued)?.id).toBe("queue-remove");
			expect(availabilityFor(remove, queued)).toEqual({ available: true });
			// A queued record the queue has emptied mid-removal keeps the row's
			// refusal, and the Close refuses the queued state in its own words.
			expect(
				availabilityFor(
					remove,
					facts(mode, { selectedConsultation: { state: "queued" } as unknown as Consultation }),
				),
			).toEqual({
				available: false,
				reason: "the selected row has no waiting queue item",
			});
			// The states the Close answers refuse the row's removal: their work
			// stands behind the key, not a waiting start.
			for (const state of [
				"opening",
				"working",
				"awaiting-response",
				"missing",
				"failed",
				"closing",
			] as const) {
				expect(
					availabilityFor(
						remove,
						facts(mode, {
							selectedConsultation: { state } as unknown as Consultation,
							queueItemForSelectedRow: queueConsultationValues.selectedWorkQueueItem,
						}),
					),
				).toEqual({
					available: false,
					reason: "the selected row has no waiting queue item",
				});
			}
			// The two states that hold no Agent give the key to the record's
			// removal, which takes the record and its history out.
			for (const state of ["closed", "unscheduled"] as const) {
				expect(
					controlForKey({ name: "delete" }, facts(mode, {
						selectedConsultation: { state } as unknown as Consultation,
					}))?.id,
				).toBe("consultation-delete");
			}
		}
	});

	test("a Handoff in flight is no refusal for the Ticket close: the close queues", () => {
		// ADR 0031 holds the close on the shared environment seat instead of
		// refusing it, so a hung start still ends in the close asked for.
		const control = controlById("ticket-close");
		const context = facts("ticket-list", {
			selectedTicket: runningTicketWithPane,
			handoffActive: true,
		});
		expect(availabilityFor(control, context).available).toBe(true);
	});

	// ADR 0122: the two Closes share the Delete key, and the act follows the
	// section under the cursor. Each section's guide names its own Close among
	// its own rows and omits the other section's Close, and the retired `w`
	// resolves nowhere in either section.
	test("the Delete key is each section's own Close, and the guides keep them apart", () => {
		const consultation = facts("consultation-detail", {
			selectedConsultation: consultationWithPane,
		});
		expect(controlForKey({ name: "delete" }, consultation)?.id).toBe("consultation-close");
		expect(guideGroupsFor(consultation, "consultation-close")).toContain(
			"Current interaction mode",
		);
		expect(guideGroupsFor(consultation, "ticket-close")).toEqual([]);
		const ticket = facts("ticket-list", { selectedTicket: runningTicketWithPane });
		expect(controlForKey({ name: "delete" }, ticket)?.id).toBe("ticket-close");
		expect(guideGroupsFor(ticket, "ticket-close")).toContain("Current interaction mode");
		expect(guideGroupsFor(ticket, "consultation-close")).toEqual([]);
		// The retired `w` answers nothing in either section: a press of it
		// states nothing, the way every unclaimed key does.
		expect(controlForKey({ name: "w" }, consultation)).toBeUndefined();
		expect(controlForKey({ name: "w" }, ticket)).toBeUndefined();
	});

	test("the Ticket guide names Goto in its own section, and the Consultation guide omits it", () => {
		const ticket = facts("ticket-detail", {
			selectedTicket: runningTicketWithPane,
			ticketPaneAlive: true,
		});
		expect(
			guideControls(ticket).some(
				({ group, control }) =>
					control.id === "ticket-goto" && group === "Current interaction mode",
			),
		).toBe(true);
		const consultation = facts("consultation-detail", {
			selectedConsultation: consultationWithPane,
			consultationPaneAlive: true,
		});
		const ids = guideControls(consultation).map(({ control }) => control.id);
		expect(ids).not.toContain("ticket-goto");
	});

	/**
	 * Enter answers a Consultation with the surface its state needs: the Agent
	 * or the response on a live one, and the recovery panel on a broken or
	 * stuck one. A closed record answers nothing, in words.
	 */
	const consultationIn = (state: Consultation["state"]) =>
		facts("consultation-list", {
			selectedConsultation: { id: "c1", state, paneId: "pane-1" } as unknown as Consultation,
		});

	test("Enter opens the recovery panel on every broken or stuck Consultation", () => {
		for (const state of ["opening", "missing", "failed", "closing"] as const) {
			const context = consultationIn(state);
			const control = controlForKey({ name: "return" }, context);
			if (control === undefined) throw new Error(`Enter answers nothing on a ${state}`);
			expect(control.id).toBe("consultation-recovery");
			expect(availabilityFor(control, context).available).toBe(true);
		}
	});

	test("Enter keeps Respond and Interact on a live Consultation", () => {
		// An awaiting Agent takes the response; a blocked one takes the
		// Agent, and a working one takes the Agent, whatever the recovery
		// control's own reason says.
		const awaiting = facts("consultation-list", {
			selectedConsultation: {
				state: "awaiting-response",
				paneId: "pane-1",
			} as unknown as Consultation,
			consultationAgentStatus: "idle",
		});
		expect(controlForKey({ name: "return" }, awaiting)?.id).toBe("consultation-respond");
		const blocked = facts("consultation-list", {
			...awaiting,
			consultationAgentStatus: "blocked",
		});
		expect(controlForKey({ name: "return" }, blocked)?.id).toBe("consultation-interact");
		const working = facts("consultation-detail", consultationIn("working"));
		expect(controlForKey({ name: "return" }, working)?.id).toBe("consultation-interact");
	});

	test("Enter on a closed Consultation says it is already closed", () => {
		const context = consultationIn("closed");
		const control = controlById("consultation-recovery");
		expect(controlForKey({ name: "return" }, context)?.id).toBe("consultation-recovery");
		expect(availabilityFor(control, context)).toEqual({
			available: false,
			reason: "the selected Consultation is already closed",
		});
	});

	test("the Key guide names the recovery meaning of Enter in the Consultation section", () => {
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			const context = facts(mode, consultationIn("opening"));
			const entry = guideControls(context).find(
				({ control }) => control.id === "consultation-recovery",
			);
			expect(entry?.group).toBe("Current interaction mode");
			if (entry === undefined) throw new Error("the guide holds no recovery row");
			expect(entry.control.keyLabel).toBe("Enter");
			expect(entry.control.guideNote).toContain("recovery");
		}
	});
});

/**
 * The invariant the facts' interface leans on.
 *
 * `ControlDefinition` declares `keys`, `barLabel`, `showInBar`, and
 * `availability` as methods, so TypeScript checks their parameters
 * bivariantly: a rule that names only the facts of one mode group is accepted
 * on a control whose `modes` name any mode. Nothing in the types writes down
 * the correspondence between a control's `modes` and the facts its rule reads,
 * so a contributor who adds a mode to a control, or drops a section-only
 * marker, gets a green `bun run typecheck` and a rule that reads a fact no
 * surface stated. This test writes the correspondence down: every mode's
 * record is wrapped so a read of a fact that mode does not name throws, and
 * every control the catalogue runs in that mode is reached through the bar,
 * the guide, the hint wording, and the dispatch.
 */
describe("no availability rule reads a fact its mode does not state", () => {
	const STANDING_KEYS = Object.keys(STANDING);

	/**
	 * One mode's facts, wrapped so an unstated read fails the test.
	 *
	 * The stated names are the mode's own defaults plus the standing facts and
	 * the mode itself. `OWN_FACTS` is checked against `OwnFacts<M>`, so its
	 * keys are exactly the facts that mode's record names.
	 */
	function statedOnly(mode: InteractionMode): AvailabilityFacts {
		const stated = new Set<string>([...STANDING_KEYS, "mode", ...Object.keys(OWN_FACTS[mode])]);
		const record = facts(mode);
		return new Proxy(record, {
			get(target, property) {
				if (typeof property === "string" && !stated.has(property)) {
					throw new Error(`${mode} states no fact named ${property}`);
				}
				return Reflect.get(target, property);
			},
		});
	}

	test("every control the catalogue runs in a mode reads only that mode's facts", () => {
		const modes = Object.keys(OWN_FACTS) as InteractionMode[];
		const offenders: string[] = [];
		const read = (what: string, run: () => unknown): void => {
			try {
				run();
			} catch (error) {
				offenders.push(`${what}: ${error instanceof Error ? error.message : error}`);
			}
		};
		for (const mode of modes) {
			const guarded = statedOnly(mode);
			const controls = controlsForMode(mode);
			for (const control of controls) {
				read(`${mode} / ${control.id} availability`, () => availabilityFor(control, guarded));
				read(`${mode} / ${control.id} keys`, () => control.keys(mode, guarded));
				read(`${mode} / ${control.id} compact keys`, () =>
					compactKeyLabels(mode, control, guarded),
				);
				read(`${mode} / ${control.id} section refusal`, () => control.sectionRefusal?.(mode));
			}
			// The bar's own path: it asks for a hint only for the controls it kept,
			// so a section-only control's wording is never read in another section.
			read(`${mode} bar`, () => {
				for (const control of actionBarControls(mode, guarded)) control.barLabel?.(guarded);
			});
			read(`${mode} guide`, () => guideControls(guarded));
			for (const key of new Set(controls.flatMap((control) => [...control.keys(mode, guarded)]))) {
				read(`${mode} dispatch ${key}`, () =>
					controlForKey(key === "ctrl+c" ? { name: "c", ctrl: true } : { name: key }, guarded),
				);
			}
		}
		expect(offenders).toEqual([]);
	});
});
