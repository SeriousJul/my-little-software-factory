/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "bun:test";

import {
	availabilityFor,
	type ControlContext,
	type ControlDefinition,
	contextFor,
	controlForKey,
	guideControls,
} from "../src/components/controls.ts";
import type { Ticket } from "../src/domain/ticket.ts";
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

const runningTicketWithPane = {
	state: "running",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const awaitingTicketWithPane = {
	state: "awaiting",
	handoff: { paneId: "pane-1" },
} as unknown as Ticket;
const openTicket = { state: "open", handoff: null } as unknown as Ticket;

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

	test("the Consultation close is z, not the section toggle", () => {
		const context = contextFor("consultation-detail", values);

		expect(controlForKey({ name: "z" }, context)?.id).toBe("consultation-close");
		expect(controlForKey({ name: "x" }, context)?.id).toBe("section-toggle");
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
});
