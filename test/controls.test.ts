/** The shared catalogue gives each section key one meaning. */
import { describe, expect, test } from "vitest";

import {
	availabilityFor,
	type ControlContext,
	type ControlDefinition,
	contextFor,
	controlForKey,
	guideControls,
} from "../src/components/controls.ts";
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
});
