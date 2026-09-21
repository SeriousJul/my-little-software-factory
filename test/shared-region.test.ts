/** The shared region module owns the Decision region's selection behavior. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createElement, useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import type { ActionRow } from "../src/components/modal-chrome.ts";
import { rangeTextOf, useDecisionRegion } from "../src/components/shared/region.ts";
import { awaitFrame, frameText } from "./app-harness.ts";

let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/** One decision row, from its key. */
const row = (key: string): ActionRow => ({ key, label: `Row ${key}` });

/** The six rows every harness window cuts. */
const SIX: readonly ActionRow[] = ["a", "b", "c", "d", "e", "f"].map(row);

interface HarnessProps {
	rows: readonly ActionRow[];
	visibleRows: number;
	onConfirm: (key: string) => void;
}

/**
 * The harness a region test drives: one window of the region's rows, the
 * selected row's marker, and the range text the bar would state.
 *
 * The keys take the region's own behavior: down and j move one step, up and k
 * move back, and Enter confirms the selected row. The harness keeps no
 * selection of its own - the frame reads the module's state.
 */
function RegionHarness({ rows, visibleRows, onConfirm }: HarnessProps) {
	const region = useDecisionRegion(rows, visibleRows);
	useKeyboard((key: KeyEvent) => {
		if (key.name === "down" || key.name === "j") region.move(1);
		else if (key.name === "up" || key.name === "k") region.move(-1);
		else if (key.name === "return") region.confirm((r) => onConfirm(r.key));
		else return false;
		return true;
	});
	return createElement(
		"box",
		{ style: { flexDirection: "column", width: "100%", height: "100%" } },
		...region.window.map((r) =>
			createElement(
				"text",
				{ key: r.key, style: { height: 1, width: "100%" } },
				`${r.key === rows[region.at]?.key ? "❯ " : "  "}${r.label}`,
			),
		),
		createElement(
			"text",
			{ key: "range", style: { height: 1, width: "100%" } },
			`range: ${region.rangeText ?? "none"}`,
		),
	);
}

/** Render one region at a fixed size, and hand the test the frame setup. */
async function withRegion(
	rows: readonly ActionRow[],
	visibleRows: number,
	onConfirm: (key: string) => void,
	body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
): Promise<void> {
	const setup = await testRender(createElement(RegionHarness, { rows, visibleRows, onConfirm }), {
		width: 40,
		height: visibleRows + 2,
	});
	await setup.flush();
	renderer = setup.renderer;
	await body(setup);
}

/** The selected row's label, read off the frame's marker. */
const selectedLabel = (frame: string): string => {
	const markerRow = frame.split("\n").find((line) => line.trim().startsWith("❯"));
	return markerRow === undefined ? "" : markerRow.trim().replace(/^❯\s*/, "");
};

/** The region's range text, read off the frame's range line. */
const rangeOf = (frame: string): string | undefined => {
	const line = frame
		.split("\n")
		.find((l) => l.trim().startsWith("range:"))
		?.trim();
	if (line === undefined) throw new Error("the frame states no range line");
	return line === "range: none" ? undefined : line.slice("range: ".length);
};

describe("the shared range readout", () => {
	test("states first-last of total from the window's top", () => {
		expect(rangeTextOf(0, 10, 24)).toBe("1-10/24");
		expect(rangeTextOf(14, 10, 24)).toBe("15-24/24");
		expect(rangeTextOf(0, 6, 6)).toBe("1-6/6");
	});

	test("never names a row past the total, and states nothing of zero", () => {
		// A window taller than the rows holds the rows, not the padding.
		expect(rangeTextOf(0, 10, 3)).toBe("1-3/3");
		// An empty body of any window is `0-0/0`, the way the bar reads it.
		expect(rangeTextOf(0, 0, 0)).toBe("0-0/0");
	});
});

describe("the region's selection, its wrap, and its window", () => {
	test("moves the selection one row per step and wraps at both edges", async () => {
		await withRegion(
			SIX,
			6,
			() => undefined,
			async (setup) => {
				// All six rows fit, so the window holds them all and states no range.
				expect(rangeOf(setup.captureCharFrame())).toBeUndefined();
				expect(selectedLabel(setup.captureCharFrame())).toBe("Row a");

				// Down walks the rows to the last.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row b",
					"one step down",
				);
				for (const label of ["Row c", "Row d", "Row e", "Row f"]) {
					setup.mockInput.pressKey("j");
					await awaitFrame(
						setup,
						() => selectedLabel(setup.captureCharFrame()) === label,
						`the step to ${label}`,
					);
				}

				// The next step wraps to the first row instead of stopping.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row a",
					"the wrap from the last row",
				);

				// And the wrap runs at the other edge too: the region starts
				// where the operator left it, so k from the first row takes the
				// last.
				setup.mockInput.pressKey("k");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row f",
					"the wrap from the first row",
				);
			},
		);
	});

	test("keeps the cursor's row visible: the window slides when the step would leave it", async () => {
		await withRegion(
			SIX,
			3,
			() => undefined,
			async (setup) => {
				// The window opens on the first three rows.
				let frame = setup.captureCharFrame();
				expect(frame).toContain("Row a");
				expect(frame).toContain("Row c");
				expect(frame).not.toContain("Row d");
				expect(rangeOf(frame)).toBe("1-3/6");

				// Two steps stay inside the window: it does not move.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row b",
					"the step to Row b",
				);
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row c",
					"the step to Row c",
				);
				expect(rangeOf(setup.captureCharFrame())).toBe("1-3/6");

				// The step that would leave the window slides it down with the
				// cursor: Row d comes in, Row a goes.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row d",
					"the step to Row d",
				);
				frame = setup.captureCharFrame();
				expect(frame).toContain("Row d");
				expect(frame).not.toContain("Row a");
				expect(rangeOf(frame)).toBe("2-4/6");

				// To the last row, and the window holds it.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row e",
					"the step to Row e",
				);
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row f",
					"the step to Row f",
				);
				frame = setup.captureCharFrame();
				expect(frame).toContain("Row f");
				expect(frame).not.toContain("Row b");
				expect(rangeOf(frame)).toBe("4-6/6");

				// A step back that stays in the window does not slide it: e and d
				// both stand in the window it holds.
				for (const label of ["Row e", "Row d"]) {
					setup.mockInput.pressKey("k");
					await awaitFrame(
						setup,
						() => selectedLabel(setup.captureCharFrame()) === label,
						`the step back to ${label}`,
					);
					expect(rangeOf(setup.captureCharFrame())).toBe("4-6/6");
				}

				// The step that leaves the window at its top slides it up: c
				// comes in, f goes.
				setup.mockInput.pressKey("k");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row c",
					"the step back to Row c",
				);
				frame = setup.captureCharFrame();
				expect(frame).toContain("Row c");
				expect(frame).not.toContain("Row f");
				expect(rangeOf(frame)).toBe("3-5/6");

				// And back down, the window slides when the step would leave it,
				// then the wrap from the last row re-opens at the first, window
				// included.
				for (const label of ["Row d", "Row e"]) {
					setup.mockInput.pressKey("j");
					await awaitFrame(
						setup,
						() => selectedLabel(setup.captureCharFrame()) === label,
						`the step to ${label}`,
					);
					expect(rangeOf(setup.captureCharFrame())).toBe("3-5/6");
				}
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row f",
					"the step to Row f",
				);
				expect(rangeOf(setup.captureCharFrame())).toBe("4-6/6");
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					() => selectedLabel(setup.captureCharFrame()) === "Row a",
					"the wrap from the last row",
				);
				frame = setup.captureCharFrame();
				expect(frame).toContain("Row a");
				expect(frame).not.toContain("Row f");
				expect(rangeOf(frame)).toBe("1-3/6");
			},
		);
	});

	test("shows no window and no range for a region with no rows", async () => {
		await withRegion(
			[],
			3,
			() => undefined,
			async (setup) => {
				const frame = setup.captureCharFrame();
				expect(frameText(frame)).not.toContain("❯");
				expect(rangeOf(frame)).toBeUndefined();
				// A step with nothing to land on changes nothing.
				const before = frameText(frame);
				setup.mockInput.pressKey("j");
				expect(frameText(setup.captureCharFrame())).toBe(before);
			},
		);
	});

	test("confirms the selected row and returns the region to its first row", async () => {
		const onConfirm = mock();
		await withRegion(SIX, 3, onConfirm, async (setup) => {
			setup.mockInput.pressKey("j");
			await awaitFrame(
				setup,
				() => selectedLabel(setup.captureCharFrame()) === "Row b",
				"the step to Row b",
			);
			setup.mockInput.pressKey("j");
			await awaitFrame(
				setup,
				() => selectedLabel(setup.captureCharFrame()) === "Row c",
				"the step to Row c",
			);
			setup.mockInput.pressEnter();
			await awaitFrame(
				setup,
				() => onConfirm.mock.calls.length === 1,
				"the confirm of the selected row",
			);
			expect(onConfirm.mock.calls[0]?.[0]).toBe("c");
			// The confirm clears the selection: the first row stands again,
			// and the window with it.
			await awaitFrame(
				setup,
				() => selectedLabel(setup.captureCharFrame()) === "Row a",
				"the selection cleared by the confirm",
			);
			const frame = setup.captureCharFrame();
			expect(selectedLabel(frame)).toBe("Row a");
			expect(rangeOf(frame)).toBe("1-3/6");
		});
	});
});
