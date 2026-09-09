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
	test("t returns to Tickets from Consultation detail and is not an Interact alias", () => {
		const context = contextFor("consultation-detail", values);
		const interact = guideControls(context).find(
			({ control }) => control.id === "consultation-interact",
		);

		expect(controlForKey({ name: "t" }, context)?.id).toBe("open-tickets");
		expect(interact?.control.keys("consultation-detail", context)).toEqual(["return"]);
	});
});
