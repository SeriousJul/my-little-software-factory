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
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	type AppSetup,
	HEIGHT,
	markerRowOf,
	press,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { FakeRunner } from "./fake-runner.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

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

/** Move to the awaiting sample Ticket (#4) and open its decision modal. */
async function openDecision(setup: AppSetup): Promise<void> {
	// The list holds the four sample Tickets; each press moves one row.
	await press(setup, "j", "the handed-off Ticket", (f) => markerRowOf(f) === 3);
	await press(setup, "j", "the running Ticket", (f) => markerRowOf(f) === 4);
	await press(setup, "j", "the awaiting Ticket", (f) => markerRowOf(f) === 5);
	await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
}

describe("the renderer's resize listeners", () => {
	test("one surface costs one listener, and a nested stack stays under the limit", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await settle(setup);
				const base = await settledListeners(setup);
				expect(base).toBeGreaterThan(0);

				// The Key guide over the base frame: one component, one listener.
				await press(setup, "?", "the Key guide", (f) => f.includes("Key guide"));
				expect(await settledListeners(setup)).toBe(base + 1);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);

				// The override panel borrows the same chrome and bar.
				await press(setup, "e", "the override panel", (f) => f.includes("❯ Agent"));
				expect(await settledListeners(setup)).toBe(base + 1);
				await press(setup, "escape", "the panel to close", (f) => !f.includes("❯ Agent"));
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);

				// The deepest stack of ordinary work: the Key guide above an
				// open decision, over the base frame.
				await openDecision(setup);
				expect(await settledListeners(setup)).toBe(base + 1);
				await press(setup, "?", "the Key guide", (f) => f.includes("Key guide"));
				const deepest = await settledListeners(setup);
				expect(deepest).toBe(base + 2);
				// Node warns at an eleventh listener of one emitter, and the
				// warning lands in the frame the operator is reading.
				expect(deepest).toBeLessThan(10);

				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
				await press(setup, "escape", "the decision to close", (f) => !f.includes("Decision:"));
				await settle(setup);
				expect(await settledListeners(setup)).toBe(base);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});
});
