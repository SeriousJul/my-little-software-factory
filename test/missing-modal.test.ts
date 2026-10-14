/** The Missing modal keeps recovery choices while its reason scrolls. */

import { describe, expect, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import type { StandingFacts } from "../src/components/controls.ts";
import { MissingModal } from "../src/components/missing-modal.ts";
import { frameUntil, pressControl } from "./app-harness.ts";
import { DEFAULT_TICKET_TITLE } from "./fact-fixtures.ts";

/** The base control facts a modal is mounted over: the list, idle. */
const BASE_STANDING: StandingFacts = {
	sourceCount: 1,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageRecorded: false,
	consultationTypesConfigured: false,
	interactionExitKey: "f12",
	queuePaused: false,
};

describe("the Missing modal", () => {
	test("j and k scroll a long reason while arrows move only the recovery rows", async () => {
		const setup = await testRender(
			createElement(MissingModal, {
				title: `Missing: ${DEFAULT_TICKET_TITLE}`,
				bodyLines: Array.from({ length: 24 }, (_, index) => `reason line ${index + 1}`),
				actions: [
					{ key: "restart", label: "Restart", detail: "same task type, same workspace" },
					{ key: "abandon", label: "Abandon", detail: "end the work cycle" },
				],
				onAction: () => undefined,
				onCancel: () => undefined,
				standing: BASE_STANDING,
				message: null,
				onEmergencyExit: () => undefined,
				// The plane-level keys resolve to the catalogue's controls; the
				// modal's own frame is what this suite measures (issue #319).
				onQueuePause: () => undefined,
				onAutoHandoff: () => undefined,
			}),
			{ width: 90, height: 12 },
		);
		try {
			await setup.flush();
			const opened = setup.captureCharFrame();
			expect(opened).toContain("reason line 24");
			expect(opened).toContain("❯ Restart");

			// Arrow navigation does not move the reason window: the selection
			// walks down and back, and the window keeps its last row. The
			// last walk settles on a quiet frame before the scroll keys go out.
			const selected = await pressControl(setup, "select-action", {
				via: "↓",
				shows: "❯ Abandon",
			});
			expect(selected).toContain("reason line 24");
			const restored = await pressControl(setup, "select-action", {
				via: "↑",
				shows: "❯ Restart",
			});
			expect(restored).toContain("reason line 24");
			await pressControl(setup, "select-action", { via: "↓", quiet: true });

			// The modal's own scroll control owns j and k on its bar, and the
			// waits name the window the scroll reveals.
			await pressControl(setup, "scroll-message", { via: "k", quiet: true });
			const up = await frameUntil(
				setup,
				"the reason to scroll up",
				(frame) => frame.includes("reason line 23") && !frame.includes("reason line 24"),
				);
			expect(up).toContain("❯ Abandon");

			await pressControl(setup, "scroll-message", { via: "j", quiet: true });
			const down = await frameUntil(setup, "the reason to scroll down", (frame) =>
				frame.includes("reason line 24"),
			);
			expect(down).toContain("❯ Abandon");
		} finally {
			await setup.renderer.destroy();
		}
	});
});
