/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "vitest";

import {
	availabilityFor,
	type ControlContext,
	contextFor,
	controlForKey,
	guideControls,
} from "../src/components/controls.ts";

const values: Omit<ControlContext, "mode"> = {
	listCanMove: true,
	detailCanScroll: true,
	sourceCount: 0,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageTruncated: false,
	consultationTypesConfigured: true,
};

describe("the shared control catalogue", () => {
	test("t returns to Tickets from Consultation detail and is not an Interact alias", () => {
		const context = contextFor("consultation-detail", values);
		const interact = guideControls(context).find(
			({ control }) => control.id === "consultation-interact",
		);

		expect(controlForKey({ name: "t" }, context)?.id).toBe("open-tickets");
		expect(interact?.control.keys("consultation-detail", context)).toEqual(["return"]);
	});

	test("the Consultation guide omits Ticket-only controls", () => {
		const context = contextFor("consultation-list", values);
		const ids = guideControls(context).map(({ control }) => control.id);

		expect(ids).not.toContain("auto-handoff");
		expect(ids).not.toContain("consultations");
		expect(ids).toContain("open-tickets");
		expect(controlForKey({ name: "a" }, context)).toBeUndefined();
		expect(controlForKey({ name: "v" }, context)).toBeUndefined();
	});

	test("the hidden Consultation list refuses h and Left", () => {
		const context = contextFor("consultation-detail", {
			...values,
			consultationListVisible: false,
		});
		const control = controlForKey({ name: "h" }, context);

		expect(control?.id).toBe("consultation-list");
		if (control === undefined) throw new Error("the hidden list control is missing");
		expect(availabilityFor(control, context)).toEqual({
			available: false,
			reason: "the Consultation list is hidden below 80 columns",
		});
	});
});
