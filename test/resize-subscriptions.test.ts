/**
 * The resize subscriptions one surface costs.
 *
 * Every component that asks the renderer for its dimensions adds one real
 * `resize` listener, and Node warns on an emitter's eleventh listener. That
 * warning is written to the terminal the operator is reading, so a surface
 * may pay for a resize only once: it measures the terminal in its own
 * component and hands the width down to the chrome and the Action bar it
 * renders. Each test counts the live renderer's listeners, so a nested
 * component that subscribes again fails here (issue #9).
 */
import { describe, expect, test } from "bun:test";
import {
	type AppSetup,
	frameUntil,
	HEIGHT,
	markerRowOf,
	pressControl,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";

/** The `resize` listeners one live renderer holds. */
function resizeListeners(setup: AppSetup): number {
	return setup.renderer.listenerCount("resize");
}

/**
 * The listener count once this frame's work has settled.
 *
 * A surface subscribes when it renders, so the count changes one step after
 * the frame that shows it. The read waits for the number to stop moving
 * rather than for a fixed delay: a surface that costs three listeners is
 * reported as three, not as whatever the race happened to catch.
 */
async function settledListeners(setup: AppSetup): Promise<number> {
	let previous = -1;
	for (let tick = 0; tick < 40; tick += 1) {
		const count = resizeListeners(setup);
		if (count === previous) return count;
		previous = count;
		await sleep(25);
	}
	return previous;
}

/**
 * Move down to the first open Ticket.
 *
 * The live rows stand ahead of the open band: the running Ticket on the second
 * list row, the handed-off one on the third, and the first open Ticket, #1, on
 * the fourth, the frame row six. The cursor boots on the first row, the
 * awaiting Ticket, and each press moves one row.
 */
async function toFirstOpenTicket(setup: AppSetup): Promise<void> {
	await pressControl(setup, "move-list", { via: "j", quiet: true });
	await frameUntil(setup, "the running Ticket", (f) => markerRowOf(f) === 4);
	await pressControl(setup, "move-list", { via: "j", quiet: true });
	await frameUntil(setup, "the handed-off Ticket", (f) => markerRowOf(f) === 5);
	await pressControl(setup, "move-list", { via: "j", quiet: true });
	await frameUntil(setup, "the first open Ticket", (f) => markerRowOf(f) === 6);
}

describe("the renderer's resize listeners", () => {
	test("one surface costs one listener, and a nested stack stays under the limit", async () => {
		await withApp(
			async (setup) => {
				// The boot read settles on the seeded snapshot: the open rows
				// stand healthy, and the panel's handoff gate can pass them.
				setup.plane.settleFirstFetch();
				await settle(setup);
				const base = await settledListeners(setup);
				expect(base).toBeGreaterThan(0);

				// The Key guide over the base frame: one component, one listener.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				expect(await settledListeners(setup)).toBe(base + 1);
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);

				// The override panel borrows the same chrome and bar. The panel
				// hands off an open Ticket, so the walk moves off the live rows
				// to the open band first.
				await toFirstOpenTicket(setup);
				await pressControl(setup, "override", { opens: "❯ Agent" });
				expect(await settledListeners(setup)).toBe(base + 1);
				await pressControl(setup, "cancel", { closes: "❯ Agent" });
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);

				// The deepest stack of ordinary work: the Key guide above an
				// open decision, over the base frame. The decision modal opens
				// on the awaiting Ticket, so the walk climbs back up the live
				// rows it moved down, and Decide opens the modal.
				await pressControl(setup, "move-list", { via: "k", quiet: true });
				await frameUntil(setup, "the handed-off Ticket", (f) => markerRowOf(f) === 5);
				await pressControl(setup, "move-list", { via: "k", quiet: true });
				await frameUntil(setup, "the running Ticket", (f) => markerRowOf(f) === 4);
				await pressControl(setup, "move-list", { via: "k", quiet: true });
				await frameUntil(setup, "the awaiting Ticket", (f) => markerRowOf(f) === 3);
				await pressControl(setup, "decide-completion", { opens: "Decision:" });
				expect(await settledListeners(setup)).toBe(base + 1);
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				const deepest = await settledListeners(setup);
				expect(deepest).toBe(base + 2);
				// Node warns at an eleventh listener of one emitter, and the
				// warning lands in the frame the operator is reading.
				expect(deepest).toBeLessThan(10);

				await pressControl(setup, "guide-close", { closes: "Key guide" });
				await pressControl(setup, "cancel-action", { closes: "Decision:" });
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);
			},
			{
				width: WIDTH,
				height: HEIGHT,
			},
		);
	});
});
