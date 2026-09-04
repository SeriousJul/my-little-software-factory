/** Contextual controls stay visible and their help keeps operator priority. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, test } from "vitest";

import { ActionBar, ActionGuide } from "../src/components/consultation-actions.ts";
import type { Consultation } from "../src/state.ts";
import { frameText, overlayRows } from "./app-harness.ts";

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

/**
 * The guide rows as the terminal shows them, top row first.
 *
 * The Key guide orders its rows by hint priority, so the row order an
 * operator reads is the assertion: a priority that moves reorders this list.
 */
const guideRows = (frame: string) => overlayRows(frame);

/** The two Consultation fields the control hints read. */
function selectedConsultation(state: Consultation["state"], paneId: string | null): Consultation {
	return { state, paneId } as Consultation;
}

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

	test("a narrow Action bar keeps the highest priority controls of its mode", async () => {
		// The bar packs by priority and drops what does not fit, so the row it
		// can hold is the order the operator reads: the move control, then the
		// handoff, and nothing of lower priority.
		const setup = await testRender(createElement(ActionBar, { context: ticketContext }), {
			width: 28,
			height: 4,
		});
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame()).trim();
			expect(frame).toBe("Enter hand off ↑↓/jk move");
			expect(frame).not.toContain("e override");
			expect(frame).not.toContain("q quit");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the Key guide lists the ticket controls in priority order", async () => {
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
			expect(guideRows(setup.captureCharFrame())).toEqual([
				"↑↓/jk move",
				"Enter hand off",
				"e override",
				"v Consultations",
				"c launch",
				"r refresh",
				"? help",
				"q quit",
				"Live view: j/k scroll, pgup/pgdn page, home/end, enter goto, esc close",
				"Esc closes this guide. F2 or m opens the full Message view.",
			]);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the Key guide lists a Consultation's own controls above the global ones", async () => {
		const setup = await testRender(
			createElement(ActionGuide, {
				context: {
					...ticketContext,
					view: "consultations" as const,
					status: { kind: "warning" as const, text: "the agent stopped" },
					selectedConsultation: selectedConsultation("awaiting-response", "pane-1"),
				},
				utility: "guide",
				onClose: () => undefined,
				onMessage: () => undefined,
			}),
			{ width: 100, height: 30 },
		);
		try {
			await setup.flush();
			expect(guideRows(setup.captureCharFrame())).toEqual([
				"↑↓/jk move",
				"Enter respond",
				"c launch",
				"m message",
				"f history",
				"x close",
				"t Tickets",
				"r refresh",
				"? help",
				"q quit",
				"Launcher: Tab fields, arrows choose, Shift+Enter newline",
				"Response: Enter submit, Shift+Enter newline, Esc keep draft",
				"Agent view: End follows output; interaction exits with F12",
				"Esc closes this guide. F2 or m opens the full Message view.",
			]);
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

	test("the Action bar names the Live view for an in-flight selection", async () => {
		const setup = await testRender(
			createElement(ActionBar, { context: { ...ticketContext, selectedInFlight: true } }),
			{ width: 80, height: 4 },
		);
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Enter live");
			expect(frame).not.toContain("hand off");
		} finally {
			await setup.renderer.destroy();
		}
	});
});
