/** The Missing modal keeps recovery choices while its reason scrolls. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, test } from "vitest";

import { MissingModal } from "../src/components/missing-modal.ts";
import { awaitFrame } from "./app-harness.ts";

describe("the Missing modal", () => {
	test("j and k scroll a long reason while arrows move only the recovery rows", async () => {
		const setup = await testRender(
			createElement(MissingModal, {
				title: "Missing: Persist source facts",
				bodyLines: Array.from({ length: 24 }, (_, index) => `reason line ${index + 1}`),
				actions: [
					{ key: "restart", label: "Restart", detail: "same task type, same workspace" },
					{ key: "abandon", label: "Abandon", detail: "end the work cycle" },
				],
				onAction: () => undefined,
				onCancel: () => undefined,
			}),
			{ width: 90, height: 12 },
		);
		try {
			await setup.flush();
			const opened = setup.captureCharFrame();
			expect(opened).toContain("reason line 24");
			expect(opened).toContain("❯ Restart");

			setup.mockInput.pressArrow("down");
			const selected = await awaitFrame(
				setup,
				(frame) => frame.includes("❯ Abandon"),
				"the abandon row to become selected",
			);
			// Arrow navigation does not move the reason window.
			expect(selected).toContain("reason line 24");
			setup.mockInput.pressArrow("up");
			const restored = await awaitFrame(
				setup,
				(frame) => frame.includes("❯ Restart"),
				"the restart row to become selected again",
			);
			expect(restored).toContain("reason line 24");
			setup.mockInput.pressArrow("down");
			await awaitFrame(
				setup,
				(frame) => frame.includes("❯ Abandon"),
				"the abandon row to become selected",
			);

			setup.mockInput.pressKey("k");
			const up = await awaitFrame(
				setup,
				(frame) => frame.includes("reason line 23") && !frame.includes("reason line 24"),
				"the reason to scroll up",
			);
			expect(up).toContain("❯ Abandon");

			setup.mockInput.pressKey("j");
			const down = await awaitFrame(
				setup,
				(frame) => frame.includes("reason line 24"),
				"the reason to scroll down",
			);
			expect(down).toContain("❯ Abandon");
		} finally {
			await setup.renderer.destroy();
		}
	});
});
