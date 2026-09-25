/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "bun:test";

import {
	actionBarControls,
	availabilityFor,
	type ControlContext,
	type ControlDefinition,
	contextFor,
	controlById,
	controlForKey,
	controlsForMode,
	guideControls,
} from "../src/components/controls.ts";
import { GROUPING_AXES } from "../src/domain/grouping.ts";
import type { Ticket, TicketListFilter } from "../src/domain/ticket.ts";
import type { Consultation } from "../src/state.ts";

const values: Omit<ControlContext, "mode"> = {
	listCanMove: true,
	detailCanScroll: true,
	sourceCount: 0,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageTruncated: false,
	consultationTypesConfigured: true,
};

const consultationWithPane = { paneId: "pane-1" } as unknown as Consultation;

/**
 * The same context with one item under the Work queue's cursor, so the two
 * queue modes hold a real row to move, remove, and read the refusal against.
 */
const queueValues: Omit<ControlContext, "mode"> = {
	...values,
	selectedWorkQueueItem: {
		kind: "handoff",
		ticketIdentity: "github:github.com:I_5",
		origin: "open",
		position: 0,
	} as unknown as ControlContext["selectedWorkQueueItem"],
	workQueueDepth: 2,
};

/** The cursor on a Consultation's queue item (issue #90), for the queue's keys. */
const queueConsultationValues: Omit<ControlContext, "mode"> = {
	...values,
	selectedWorkQueueItem: {
		kind: "consultation",
		consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
		position: 0,
	} as unknown as ControlContext["selectedWorkQueueItem"],
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
function guideGroupsFor(context: ControlContext, id: string): string[] {
	return guideControls(context)
		.filter(({ control }) => control.id === id)
		.map(({ group }) => group);
}

/**
 * The Grouping axis' split values: the ones that draw a header, so the ones the
 * Action bar can name (issue #159).
 */
const SPLIT_AXES = GROUPING_AXES.filter((axis) => axis !== "none");

// Issue #159: the Grouping axis is one key that steps a fixed cycle, and it
// answers in both Ticket panes wherever the plane does, so a press in a
// collapsed Ticket section still records the operator's choice.
test("Tab cycles the Grouping axis in both Ticket modes, and refuses nowhere", () => {
	for (const mode of ["ticket-list", "ticket-detail"] as const) {
		const context = contextFor(mode, { ...values, groupingAxis: "none" });
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
			const split = contextFor(mode, { ...values, groupingAxis: axis });
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
		expect(controlForKey({ name: "tab" }, contextFor(mode, values))).toBeUndefined();
		const groups = guideControls(contextFor(mode, values));
		expect(
			groups.filter(
				({ control, group }) => control.id === "group-axis" && group === "Current interaction mode",
			),
		).toEqual([]);
		expect(actionBarControls(mode, contextFor(mode, values)).map((c) => c.id)).not.toContain(
			"group-axis",
		);
	}
});

// The header fact is the Ticket list's own: a cursor resting on a Group header
// while another section holds the focus leaves that section's `x` the Section
// toggle, in its own words, and no fold anywhere (issue #159).
test("a Group header under the Ticket cursor gives no other section a fold", () => {
	for (const mode of [
		"consultation-list",
		"consultation-detail",
		"work-queue-list",
		"work-queue-detail",
	] as const) {
		const context = contextFor(mode, {
			...values,
			groupingAxis: "repository",
			groupHeaderSelected: true,
			selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: false },
		});
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
		expect(availabilityFor(controlById("section-toggle"), context)).toEqual({
			available: true,
		});
	}
});

test("the flat list hints no axis, and a grouped list names its own", () => {
	const context = contextFor("ticket-list", { ...values, groupingAxis: "none" });
	expect(actionBarControls("ticket-list", context).map((c) => c.id)).not.toContain("group-axis");
	const grouped = contextFor("ticket-list", { ...values, groupingAxis: "position" });
	expect(actionBarControls("ticket-list", grouped).map((c) => c.id)).toContain("group-axis");
});

/**
 * Story 31 and 32: one `x`, two meanings, resolved by the facts under the
 * cursor. On a Group header the fold runs and the Section toggle stands
 * down; on a ticket row the toggle runs and the fold states its reason.
 * The Action bar states only the meaning the current facts run, and the
 * Key guide names both, the way it names every meaning of Enter.
 */
test("x folds the Group under the cursor, and toggles the Section everywhere else", () => {
	const onHeader = contextFor("ticket-list", {
		...values,
		groupingAxis: "repository",
		groupHeaderSelected: true,
		selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: false },
	});
	const fold = controlForKey({ name: "x" }, onHeader);
	expect(fold?.id).toBe("group-fold");
	if (fold === undefined) throw new Error("x answers nothing on a Group header");
	expect(availabilityFor(fold, onHeader)).toEqual({ available: true });
	expect(fold.barLabel?.(onHeader)).toBe("Fold group");
	const collapsed = contextFor("ticket-list", {
		...onHeader,
		selectedGroupHeader: { value: "acme/factory", count: 3, held: 0, collapsed: true },
	});
	expect(controlById("group-fold").barLabel?.(collapsed)).toBe("Unfold group");
	// The bar names the fold and not the section toggle it replaces.
	const hinted = actionBarControls("ticket-list", onHeader).map((control) => control.id);
	expect(hinted).toContain("group-fold");
	expect(hinted).not.toContain("section-toggle");
	// The guide of the same mode still names both meanings of the key.
	const ids = guideControls(onHeader).map(({ control }) => control.id);
	expect(ids).toContain("section-toggle");
	expect(ids).toContain("group-fold");

	// On a ticket row the toggle keeps the key and the fold refuses.
	const onRow = contextFor("ticket-list", {
		...values,
		groupingAxis: "repository",
		groupHeaderSelected: false,
		selectedGroupHeader: null,
	});
	expect(controlForKey({ name: "x" }, onRow)?.id).toBe("section-toggle");
	expect(availabilityFor(controlById("section-toggle"), onRow)).toEqual({ available: true });
	expect(availabilityFor(controlById("group-fold"), onRow)).toEqual({
		available: false,
		reason: "no Group header is under the cursor",
	});
	const rowHints = actionBarControls("ticket-list", onRow).map((control) => control.id);
	expect(rowHints).toContain("section-toggle");
	expect(rowHints).not.toContain("group-fold");
});

test("every Ticket control answers a Group header with no Ticket selected", () => {
	// The shell leaves `selectedTicket` unset where the cursor stands on a
	// header, and each control states that fact itself: no surface swallows
	// the key (story 39).
	const onHeader = contextFor("ticket-list", {
		...values,
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
	const consultation = contextFor("consultation-list", {
		...values,
		queueItemForSelectedRow: null,
	});
	expect(availabilityFor(controlById("queue-jump"), consultation)).toEqual({
		available: false,
		reason: "the selected row has no waiting queue item",
	});
});

describe("the shared control catalogue", () => {
	test("x toggles the section under the cursor and is not an Interact alias", () => {
		const context = contextFor("consultation-detail", values);
		const interact = guideControls(context).find(
			({ control }) => control.id === "consultation-interact",
		);

		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
		expect(interact?.control.keys("consultation-detail", context)).toEqual(["return"]);
	});

	test("the Ticket guide names the section toggle in its own section", () => {
		const context = contextFor("ticket-list", values);
		const entries = guideControls(context);
		const toggle = entries.find(({ control }) => control.id === "section-toggle");

		expect(toggle?.group).toBe("Current interaction mode");
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
	});

	test("the Consultation guide omits Ticket-only controls", () => {
		const context = contextFor("consultation-list", values);
		const ids = guideControls(context).map(({ control }) => control.id);

		expect(ids).not.toContain("auto-handoff");
		expect(controlForKey({ name: "a" }, context)).toBeUndefined();
	});

	test("the Consultation close is w, not the section toggle", () => {
		const context = contextFor("consultation-detail", values);

		expect(controlForKey({ name: "w" }, context)?.id).toBe("consultation-close");
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
	});

	test("z answers nothing in the Consultation section", () => {
		for (const mode of ["consultation-list", "consultation-detail"] as const)
			expect(controlForKey({ name: "z" }, contextFor(mode, values))).toBeUndefined();
	});

	test("d refuses in both Ticket modes, and f cycles the Ticket section's own filter", () => {
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const context = contextFor(mode, values);
			const deleteControl = controlForKey({ name: "d" }, context);
			expect(deleteControl?.id).toBe("consultation-delete");
			if (deleteControl === undefined) throw new Error("Delete is missing from the catalogue");
			expect(availabilityFor(deleteControl, context)).toEqual({
				available: false,
				reason: "this control is available only in the Consultation section",
			});
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
		// In the Consultation section the keys keep their own meanings.
		const consultation = contextFor("consultation-list", values);
		expect(controlForKey({ name: "d" }, consultation)?.id).toBe("consultation-delete");
		expect(controlForKey({ name: "f" }, consultation)?.id).toBe("history");
		const closed = contextFor("consultation-list", {
			...values,
			selectedConsultation: { state: "closed" } as unknown as Consultation,
		});
		const closedDelete = controlForKey({ name: "d" }, closed);
		const closedHistory = controlForKey({ name: "f" }, closed);
		if (closedDelete === undefined || closedHistory === undefined)
			throw new Error("Delete and History are missing from the catalogue");
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
			const open = contextFor(mode, { ...values, selectedTicket: openTicket });
			const ignore = controlForKey({ name: "i" }, open);
			expect(ignore?.id).toBe("ticket-ignore");
			if (ignore === undefined) throw new Error("the Ticket section lost its ignore");
			expect(availabilityFor(ignore, open)).toEqual({ available: true });
			// The same key on an ignored row takes the Ticket back, whatever state
			// it rests in: clearing hides nothing.
			const ignoredRow = contextFor(mode, {
				...values,
				selectedTicket: { ...openTicket, ignored: true, ignoredAt: "2026-09-24T10:00:00Z" },
			});
			expect(availabilityFor(ignore, ignoredRow)).toEqual({ available: true });
			expect(controlById("ticket-ignore").barLabel?.(ignoredRow)).toBe("Un-ignore");
			expect(controlById("ticket-ignore").barLabel?.(open)).toBe("Ignore");
			// The three obligations, in the Message line's own words.
			const awaiting = contextFor(mode, {
				...values,
				selectedTicket: rowTicket({ state: "awaiting", ignored: false, lastCompletion: null }),
			});
			expect(availabilityFor(ignore, awaiting)).toEqual({
				available: false,
				reason: "the selected Ticket cannot be ignored: it awaits a decision",
			});
			const held = contextFor(mode, {
				...values,
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
			const missing = contextFor(mode, {
				...values,
				selectedTicket: rowTicket({ state: "running", ignored: false, lastCompletion: null }),
				selectedTicketMarker: "missing",
			});
			expect(availabilityFor(ignore, missing)).toEqual({
				available: false,
				reason: "the selected Ticket cannot be ignored: its Agent is missing",
			});
			// A blocked Agent owes no decision, so the key stands.
			const blocked = contextFor(mode, {
				...values,
				selectedTicket: rowTicket({ state: "running", ignored: false, lastCompletion: null }),
				selectedTicketMarker: "blocked",
			});
			expect(availabilityFor(ignore, blocked)).toEqual({ available: true });
			// No row under the cursor: the key says so, like the section's other keys.
			expect(availabilityFor(ignore, contextFor(mode, values))).toEqual({
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
			const context = contextFor(mode, queueValues);
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
			const context = contextFor(mode, { ...values, selectedTicket: openTicket });
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).toContain("ticket-ignore");
			expect(ids).toContain("ticket-filter");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).toContain("ticket-ignore");
			expect(hinted).toContain("ticket-filter");
		}
	});

	// The `f` cycle names the state it moves to, so the hint says what the key
	// will show before the operator presses it (ADR 0060).
	test("f names the state the Ticket section's filter moves to", () => {
		const labels: Array<[TicketListFilter, string]> = [
			["active", "Show ignored"],
			["ignored", "Show all"],
			["all", "Show active"],
		];
		for (const [filter, label] of labels) {
			const context = contextFor("ticket-list", { ...values, ticketListFilter: filter });
			expect(controlById("ticket-filter").barLabel?.(context)).toBe(label);
		}
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
			const context = contextFor(mode, queueValues);
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
		// the pane that holds the rows. For a Handoff item it refuses while a
		// Handoff holds the environment seat, the way the Ticket section's Hand
		// off does; a Consultation item never parks on that seat, so the refusal
		// does not reach it (issue #90). On an empty queue it carries the
		// queue's row keys' one reason.
		const control = controlForKey({ name: "return" }, contextFor("work-queue-list", queueValues));
		expect(control?.id).toBe("queue-force-dispatch");
		if (control === undefined) throw new Error("the queue lost its force-dispatch");
		expect(availabilityFor(control, contextFor("work-queue-list", queueValues))).toEqual({
			available: true,
		});
		const busy = contextFor("work-queue-list", { ...queueValues, handoffActive: true });
		expect(availabilityFor(control, busy)).toEqual({
			available: false,
			reason: "a Handoff is active",
		});
		// The Consultation item stands in the same moment: its start runs its
		// own pickup seam, the way a launcher submit does, and a Handoff in
		// flight holds no seat it waits on.
		const busyConsultation = contextFor("work-queue-list", {
			...queueConsultationValues,
			handoffActive: true,
		});
		expect(availabilityFor(control, busyConsultation)).toEqual({ available: true });
		expect(
			availabilityFor(control, contextFor("work-queue-list", queueConsultationValues)),
		).toEqual({ available: true });
		const empty = contextFor("work-queue-list", values);
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
		const entry = guideControls(contextFor("work-queue-list", queueValues)).find(
			({ control }) => control.id === "queue-force-dispatch",
		);
		expect(entry?.group).toBe("Current interaction mode");
		expect(entry?.control.guideNote).toBe(
			"starts the item over a full Parallel limit; a failure leaves the queue",
		);
	});

	test("the Ticket guide omits Delete and History, and the Consultation guide keeps them", () => {
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const ids = guideControls(contextFor(mode, values)).map(({ control }) => control.id);
			expect(ids).not.toContain("history");
			expect(ids).not.toContain("consultation-delete");
		}
		for (const mode of ["consultation-list", "consultation-detail"] as const) {
			const entries = guideControls(contextFor(mode, values));
			for (const id of ["history", "consultation-delete"]) {
				expect(entries.find(({ control }) => control.id === id)?.group).toBe(
					"Current interaction mode",
				);
			}
		}
	});

	// The Work queue shares the list surface with the other two sections, so the
	// Consultation section's Delete and History reach its modes by way of the
	// common base modes. They refuse there in the owning section's words, and
	// the queue's guide and bar name them nowhere: each section's guide names
	// the keys it dispatches (issue #85, ADR 0034).
	test("d and f refuse in both Work queue modes, and its guide and bar omit them", () => {
		for (const mode of ["work-queue-list", "work-queue-detail"] as const) {
			const context = contextFor(mode, queueValues);
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
			// The queue's own `u` and `d` reorder keys are gone (ADR 0049), so no
			// queue key answers `d`: the Consultation's Delete resolves there and
			// states the section refusal, not its own closed-Consultation reason.
			const deleteControl = controlForKey({ name: "d" }, context);
			if (deleteControl === undefined) throw new Error("d answers nothing in the queue modes");
			const deleteAvailability = availabilityFor(deleteControl, context);
			expect(deleteControl.id).toBe("consultation-delete");
			expect(deleteAvailability).toEqual({
				available: false,
				reason: "this control is available only in the Consultation section",
			});
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).not.toContain("history");
			expect(ids).not.toContain("consultation-delete");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).not.toContain("history");
			expect(hinted).not.toContain("consultation-delete");
		}
		// A closed Consultation under the cursor changes nothing in the queue:
		// the queue's modes still refuse the key in the Consultation's words,
		// because the ownership, not the row, decides.
		const withClosedConsultation: Omit<ControlContext, "mode"> = {
			...queueValues,
			selectedConsultation: { state: "closed" } as unknown as Consultation,
		};
		const detail = contextFor("work-queue-detail", withClosedConsultation);
		const deleteControl = controlById("consultation-delete");
		expect(availabilityFor(deleteControl, detail).available).toBe(false);
	});

	test("p pauses and resumes the queue, and the bar's label rides on the pause", () => {
		// One item under the cursor, unpaused: the key resolves to the pause,
		// the bar hints it, and the label names the pause.
		const open = contextFor("work-queue-list", { ...queueValues, queuePaused: false });
		const unpaused = controlForKey({ name: "p" }, open);
		expect(unpaused?.id).toBe("queue-pause");
		if (unpaused === undefined) throw new Error("p answers nothing in the queue mode");
		expect(availabilityFor(unpaused, open)).toEqual({ available: true });
		expect(actionBarControls("work-queue-list", open).map((control) => control.id)).toContain(
			"queue-pause",
		);
		expect(unpaused.barLabel?.(open)).toBe("Pause queue");
		// Paused: the same key now resolves to the resume, and the bar's label
		// flips with the fact the shell writes.
		const paused = contextFor("work-queue-list", { ...queueValues, queuePaused: true });
		const resume = controlForKey({ name: "p" }, paused);
		expect(resume?.id).toBe("queue-pause");
		if (resume === undefined) throw new Error("p answers nothing in the queue mode");
		expect(availabilityFor(resume, paused)).toEqual({ available: true });
		expect(resume.barLabel?.(paused)).toBe("Resume queue");
	});

	/**
	 * Story 48 (ADR 0049, ADR 0052): the queue's own keys refuse outside the
	 * queue. `p`, `+`, and `-` belong to the Work queue alone, so in the
	 * Ticket and Consultation sections the catalogue resolves the key, states
	 * the queue's ownership words, and the guide and bar of each other
	 * section name none of the three.
	 */
	test("p, +, and - refuse outside the Work queue, in the queue's words", () => {
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
		] as const) {
			const context = contextFor(mode, values);
			for (const key of ["p", "+", "-"] as const) {
				const control = controlForKey({ name: key }, context);
				const expected =
					key === "p" ? "queue-pause" : key === "+" ? "queue-promote" : "queue-demote";
				if (control === undefined || control.id !== expected)
					throw new Error(`${key} does not resolve to ${expected} in ${mode}`);
				expect(availabilityFor(control, context)).toEqual({
					available: false,
					reason: "this control is available only in the Work queue section",
				});
			}
			const ids = guideControls(context).map(({ control }) => control.id);
			expect(ids).not.toContain("queue-pause");
			expect(ids).not.toContain("queue-promote");
			expect(ids).not.toContain("queue-demote");
			const hinted = actionBarControls(mode, context).map((control) => control.id);
			expect(hinted).not.toContain("queue-pause");
			expect(hinted).not.toContain("queue-promote");
			expect(hinted).not.toContain("queue-demote");
		}
		// In the queue's own modes the keys keep their meanings: the pause is
		// available, and the order moves answer with their own availability.
		const queue = contextFor("work-queue-list", queueValues);
		expect(controlForKey({ name: "p" }, queue)?.id).toBe("queue-pause");
		expect(controlForKey({ name: "+" }, queue)?.id).toBe("queue-promote");
		expect(controlForKey({ name: "-" }, queue)?.id).toBe("queue-demote");
	});

	test("g is Goto in both Consultation panes, and it needs the Agent's pane alive", () => {
		const withAlivePane: Omit<ControlContext, "mode"> = {
			...values,
			selectedConsultation: consultationWithPane,
			consultationPaneAlive: true,
		};
		const detail = contextFor("consultation-detail", withAlivePane);
		const list = contextFor("consultation-list", withAlivePane);
		const found = controlForKey({ name: "g" }, detail);
		const control: ControlDefinition | undefined = found;

		expect(control?.id).toBe("consultation-goto");
		expect(controlForKey({ name: "g" }, list)?.id).toBe("consultation-goto");
		if (control === undefined) throw new Error("Goto is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		const paneGone = contextFor("consultation-detail", {
			...withAlivePane,
			consultationPaneAlive: false,
		});
		expect(availabilityFor(control, paneGone)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
		expect(availabilityFor(control, contextFor("consultation-detail", values)).available).toBe(
			false,
		);
	});

	test("g is Goto in both Ticket panes, and it needs the pane the way the Consultation names it", () => {
		const inFlight: Omit<ControlContext, "mode"> = {
			...values,
			selectedTicket: runningTicketWithPane,
			ticketPaneAlive: true,
		};
		const detail = contextFor("ticket-detail", inFlight);
		const list = contextFor("ticket-list", inFlight);
		const control: ControlDefinition | undefined = controlForKey({ name: "g" }, detail);

		expect(control?.id).toBe("ticket-goto");
		expect(controlForKey({ name: "g" }, list)?.id).toBe("ticket-goto");
		if (control === undefined) throw new Error("Goto is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		// The in-flight Ticket's pane goes away in the last poll: the
		// Consultation section's own refusal words.
		const paneGone = contextFor("ticket-detail", { ...inFlight, ticketPaneAlive: false });
		expect(availabilityFor(control, paneGone)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
		// An awaiting Ticket keeps its recorded pane: the poll or a decision
		// still moves it, and Goto is the way to look in the meantime.
		const awaiting = contextFor("ticket-detail", {
			...values,
			selectedTicket: awaitingTicketWithPane,
		});
		expect(availabilityFor(control, awaiting).available).toBe(true);
		// An open Ticket has no agent at all: the same refusal.
		const open = contextFor("ticket-list", { ...values, selectedTicket: openTicket });
		expect(availabilityFor(control, open)).toEqual({
			available: false,
			reason: "the Agent's pane is not alive in the last poll",
		});
	});

	test("w is Close in both Ticket panes, on every state but open (ADR 0031)", () => {
		const inFlight: Omit<ControlContext, "mode"> = {
			...values,
			selectedTicket: runningTicketWithPane,
		};
		const detail = contextFor("ticket-detail", inFlight);
		const list = contextFor("ticket-list", inFlight);
		const control: ControlDefinition | undefined = controlForKey({ name: "w" }, detail);

		expect(control?.id).toBe("ticket-close");
		expect(controlForKey({ name: "w" }, list)?.id).toBe("ticket-close");
		if (control === undefined) throw new Error("Close is missing from the catalogue");
		expect(availabilityFor(control, detail).available).toBe(true);
		// An awaiting ticket has a settled turn to close, and it asks too.
		expect(
			availabilityFor(
				control,
				contextFor("ticket-list", { ...values, selectedTicket: awaitingTicketWithPane }),
			).available,
		).toBe(true);
		// An open ticket has no work in flight: the refusal the key states.
		expect(
			availabilityFor(
				control,
				contextFor("ticket-list", { ...values, selectedTicket: openTicket }),
			),
		).toEqual({
			available: false,
			reason: "the selected Ticket is open: no work is in flight to close",
		});
		// No row at all is its own reason, the way every Ticket control names it.
		expect(availabilityFor(control, contextFor("ticket-list", values)).available).toBe(false);
	});

	test("a Handoff in flight is no refusal for the Ticket close: the close queues", () => {
		// ADR 0031 holds the close on the shared environment seat instead of
		// refusing it, so a hung start still ends in the close asked for.
		const control = controlById("ticket-close");
		const context = contextFor("ticket-list", {
			...values,
			selectedTicket: runningTicketWithPane,
			handoffActive: true,
		});
		expect(availabilityFor(control, context).available).toBe(true);
	});

	test("each section's w closes its own section, and only that section claims it", () => {
		// Both sections answer `w` with their own Close: the Consultation's (ADR
		// 0032) and the Ticket work cycle's (ADR 0031). A key belongs to one mode,
		// so the guide lists the other section's Close among the control-plane
		// controls it catalogues on its own terms, never as this mode's key.
		const consultation = contextFor("consultation-detail", {
			...values,
			selectedConsultation: consultationWithPane,
		});
		expect(controlForKey({ name: "w" }, consultation)?.id).toBe("consultation-close");
		expect(guideGroupsFor(consultation, "consultation-close")).toContain(
			"Current interaction mode",
		);
		expect(guideGroupsFor(consultation, "ticket-close")).toEqual([]);
		const ticket = contextFor("ticket-list", { ...values, selectedTicket: runningTicketWithPane });
		expect(controlForKey({ name: "w" }, ticket)?.id).toBe("ticket-close");
		expect(guideGroupsFor(ticket, "ticket-close")).toContain("Current interaction mode");
		expect(guideGroupsFor(ticket, "consultation-close")).toEqual(["Control plane controls"]);
	});

	test("the Ticket guide names Goto in its own section, and the Consultation guide omits it", () => {
		const ticket = contextFor("ticket-detail", {
			...values,
			selectedTicket: runningTicketWithPane,
			ticketPaneAlive: true,
		});
		expect(
			guideControls(ticket).some(
				({ group, control }) =>
					control.id === "ticket-goto" && group === "Current interaction mode",
			),
		).toBe(true);
		const consultation = contextFor("consultation-detail", {
			...values,
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
		contextFor("consultation-list", {
			...values,
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
		const awaiting = contextFor("consultation-list", {
			...values,
			selectedConsultation: {
				state: "awaiting-response",
				paneId: "pane-1",
			} as unknown as Consultation,
			consultationAgentStatus: "idle",
		});
		expect(controlForKey({ name: "return" }, awaiting)?.id).toBe("consultation-respond");
		const blocked = contextFor("consultation-list", {
			...awaiting,
			consultationAgentStatus: "blocked",
		});
		expect(controlForKey({ name: "return" }, blocked)?.id).toBe("consultation-interact");
		const working = contextFor("consultation-detail", consultationIn("working"));
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
			const context = contextFor(mode, consultationIn("opening"));
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
