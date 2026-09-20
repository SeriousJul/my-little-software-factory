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
import type { Ticket } from "../src/domain/ticket.ts";
import type { Consultation, WorkQueueItem } from "../src/state.ts";

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

const runningTicketWithPane = {
	state: "running",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const awaitingTicketWithPane = {
	state: "awaiting",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const openTicket = { state: "open", handoff: null } as unknown as Ticket;

/** The guide groups that list one control for one context. */
function guideGroupsFor(context: ControlContext, id: string): string[] {
	return guideControls(context)
		.filter(({ control }) => control.id === id)
		.map(({ group }) => group);
}

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

	test("d and f refuse in both Ticket modes, in the Consultation section's words", () => {
		for (const mode of ["ticket-list", "ticket-detail"] as const) {
			const context = contextFor(mode, values);
			const deleteControl = controlForKey({ name: "d" }, context);
			const historyControl = controlForKey({ name: "f" }, context);
			expect(deleteControl?.id).toBe("consultation-delete");
			expect(historyControl?.id).toBe("history");
			if (deleteControl === undefined || historyControl === undefined)
				throw new Error("Delete and History are missing from the catalogue");
			expect(availabilityFor(deleteControl, context)).toEqual({
				available: false,
				reason: "this control is available only in the Consultation section",
			});
			expect(availabilityFor(historyControl, context)).toEqual({
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

	test("the Consultation Delete never reaches the Work queue's modes", () => {
		// The queue's `d` is its own Move down, whatever the Consultation
		// section's selection stands at. A Consultation control declared in
		// the queue's modes could delete a Consultation the cursor cannot see
		// (issue #88 review), so the catalogue keeps the two apart.
		for (const mode of ["work-list", "work-detail"] as const) {
			expect(controlsForMode(mode).map((control) => control.id)).not.toContain(
				"consultation-delete",
			);
			const queueValues = {
				...values,
				selectedConsultation: { state: "closed" } as unknown as Consultation,
				selectedWorkQueueItem: { id: "item-1" } as unknown as WorkQueueItem,
				workQueueDepth: 2,
			};
			const queueContext = contextFor(mode, { ...queueValues, workQueueIndex: 0 });
			expect(controlForKey({ name: "d" }, queueContext)?.id).toBe("work-move-down");
			expect(availabilityFor(controlById("work-move-down"), queueContext).available).toBe(true);
			// At the last row the key answers with the queue's own refusal, not
			// with the Consultation's words.
			const lastContext = contextFor(mode, { ...queueValues, workQueueIndex: 1 });
			const refused = controlForKey({ name: "d" }, lastContext);
			expect(refused?.id).toBe("work-move-down");
			if (refused === undefined) throw new Error("the queue lost its Move down");
			expect(availabilityFor(refused, lastContext)).toEqual({
				available: false,
				reason: "the item is already last in the Work queue",
			});
		}
	});

	test("Enter is the force-dispatch in both Work queue panes, and it keeps its refusals", () => {
		// The force-dispatch (issue #89) is the queue's only meaning of Enter,
		// from either pane. It refuses while a Handoff holds the environment
		// seat, the way the Ticket section's Hand off does, and on an empty
		// queue it carries the queue's row keys' one reason.
		for (const mode of ["work-list", "work-detail"] as const) {
			const withItem = contextFor(mode, {
				...values,
				selectedWorkQueueItem: { id: "item-1" } as unknown as WorkQueueItem,
				workQueueIndex: 0,
				workQueueDepth: 1,
			});
			const control = controlForKey({ name: "return" }, withItem);
			expect(control?.id).toBe("work-force-dispatch");
			if (control === undefined) throw new Error("the queue lost its force-dispatch");
			expect(availabilityFor(control, withItem)).toEqual({ available: true });
			const busy = contextFor(mode, { ...withItem, handoffActive: true });
			expect(availabilityFor(control, busy)).toEqual({
				available: false,
				reason: "a Handoff is active",
			});
			const empty = contextFor(mode, values);
			expect(availabilityFor(control, empty)).toEqual({
				available: false,
				reason: "no Work queue item is selected",
			});
			// The guide names the key in the queue's own section with its note,
			// whatever the item's facts run.
			const entry = guideControls(withItem).find(
				({ control }) => control.id === "work-force-dispatch",
			);
			expect(entry?.group).toBe("Current interaction mode");
		}
	});

	test("a refused key is never hinted by the bar unless the guide names it, in every base mode", () => {
		// The guard that keeps the catalogue's display rules in step: a control
		// the mode dispatches a key for is either available, named in the guide
		// with its reason, or omitted from the guide and the bar together. A
		// future Consultation-only key that refuses in the Ticket section and
		// still shows up in its bar fails here.
		for (const mode of [
			"ticket-list",
			"ticket-detail",
			"consultation-list",
			"consultation-detail",
		] as const) {
			const context = contextFor(mode, values);
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
