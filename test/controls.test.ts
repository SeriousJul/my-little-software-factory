/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "vitest";

import {
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
});
