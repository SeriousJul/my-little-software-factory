/** Contextual controls stay visible and their help keeps operator priority. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, test } from "vitest";

import { ActionBar, ActionGuide } from "../src/components/consultation-actions.ts";
import { frameText } from "./app-harness.ts";

const ticketContext = {
	view: "tickets" as const,
	focusedPane: "list" as const,
	selectedConsultation: undefined,
	status: null,
	launcher: false,
	modal: false,
	responseEditor: false,
	interaction: false,
	interactionExitKey: "f12",
	agentStatus: null,
};

describe("contextual controls", () => {
	test("the Action bar shows the controls of the current interaction mode", async () => {
		const setup = await testRender(
			createElement(ActionBar, {
				context: { ...ticketContext, interaction: true, interactionExitKey: "ctrl+x" },
			}),
			{ width: 80, height: 4 },
		);
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Ctrl+X exit");
			expect(frame).not.toContain("Enter hand off");
			expect(frame).not.toContain("↑↓/jk move");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the Key guide lists current controls before the global close control", async () => {
		const setup = await testRender(
			createElement(ActionGuide, {
				context: ticketContext,
				utility: "guide",
				onClose: () => undefined,
				onMessage: () => undefined,
			}),
			{ width: 100, height: 30 },
		);
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("↑↓/jk move");
			expect(frame).toContain("Enter hand off");
			expect(frame).toContain("Esc closes this guide.");
			expect(frame.indexOf("Enter hand off")).toBeLessThan(frame.indexOf("Esc closes this guide."));
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the Message view renders all text of a long warning", async () => {
		const warning =
			"The configured source is stale because the remote API is unavailable. " +
			"The last known ticket states remain visible until a healthy refresh succeeds. " +
			"Check the network connection and retry the refresh when service returns.";
		const setup = await testRender(
			createElement(ActionGuide, {
				context: { ...ticketContext, status: { kind: "warning" as const, text: warning } },
				utility: "message",
				onClose: () => undefined,
				onMessage: () => undefined,
			}),
			{ width: 60, height: 30 },
		);
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("warning:");
			expect(frame).toContain(warning);
		} finally {
			await setup.renderer.destroy();
		}
	});
});
