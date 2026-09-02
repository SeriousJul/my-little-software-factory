/** Rendered-frame coverage for the native Ticket detail viewport. */
import { CliRenderEvents } from "@opentui/core";
import { describe, expect, test, vi } from "vitest";

import { COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	awaitFrame,
	cellColors,
	detailFocused,
	focusDetail,
	listFocused,
	markerRowOf,
	mouseClick,
	mouseDrag,
	mouseWheel,
	press,
	pressArrow,
	rgb,
	rowsOf,
	settle,
	withApp,
} from "./app-harness.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const SCROLL_WIDTH = 60;
const SCROLL_HEIGHT = 10;
const GUTTER_X = SCROLL_WIDTH - 2;
const LONG_SCROLL_CONFIG: FactoryConfig = {
	...DEFAULT_CONFIG,
	scroll: { speed: 1, acceleration: 0.8, maximumSpeed: 6 },
};

function agentRow(frame: string): number {
	return rowsOf(frame).findIndex((row) => row.includes("Agent:"));
}

function lastDescriptionRow(frame: string): number {
	return rowsOf(frame).findIndex((row) => row.includes("their retries."));
}

function thumbRows(frame: string): number[] {
	return rowsOf(frame).flatMap((row, y) =>
		y > 0 && y < rowsOf(frame).length - 1 && row[GUTTER_X] !== " " ? [y] : [],
	);
}

function expectGrid(frame: string, width: number, height: number): void {
	const rows = rowsOf(frame);
	expect(rows).toHaveLength(height);
	expect(rows.every((row) => row.length === width)).toBe(true);
}

async function wheelAt(
	setup: Parameters<typeof mouseWheel>[0],
	now: number,
	direction: "up" | "down",
): Promise<void> {
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		await mouseWheel(setup, 45, 3, direction);
	} finally {
		clock.mockRestore();
	}
}

const selectedRow = (frame: string) => rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "";

function sourceTicket(
	description: string,
	sourceState = "open",
	externalKey = "#11",
): FetchedTicket {
	return {
		identity: "github:github.com:I_11",
		sourceKind: "github-issue",
		externalKey,
		sourceState,
		url: "https://github.com/acme/factory/issues/11",
		title: "Keep detail offset through source refresh",
		description,
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-09-01T12:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

const sourceSuccess = (tickets: FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-09-01T12:00:00Z",
	tickets,
});

const sourceConfig: FactoryConfig = {
	...DEFAULT_CONFIG,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
};

describe("native Ticket detail viewport", () => {
	test("renders a proportional, dim scrollbar track and a focused-color thumb", async () => {
		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				const thumb = thumbRows(initial);
				expect(thumb).toEqual([1]);
				expect(cellColors(setup, GUTTER_X, thumb[0])).toEqual({
					fg: rgb(COLORS.borderFocused),
					bg: rgb(COLORS.dim),
				});
				expect(cellColors(setup, GUTTER_X, 2).bg).toEqual(rgb(COLORS.dim));

				await mouseClick(setup, 45, 3);
				await awaitFrame(setup, detailFocused, "the detail to take click focus");
				expect(cellColors(setup, GUTTER_X, thumb[0]).fg).toEqual(rgb(COLORS.borderFocused));

				await mouseClick(setup, GUTTER_X, 8);
				const end = await awaitFrame(
					setup,
					(frame) => frame !== initial && !frame.includes("Retry policy for webhooks"),
					"the scrollbar thumb to move to its lower proportional position",
				);
				const endThumb = thumbRows(end);
				expect(endThumb.at(-1)).toBeGreaterThan(thumb[0]);
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
		);
	});

	test("handles track clicks at both edges and the middle, then thumb drags in both directions", async () => {
		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				await mouseClick(setup, GUTTER_X, 6);
				const end = await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && frame !== initial,
					"the end track click",
				);
				expect(end).not.toContain("Retry policy for webhooks");

				await mouseClick(setup, GUTTER_X, 1);
				const start = await awaitFrame(
					setup,
					(frame) => frame.includes("Retry policy for webhooks"),
					"the start track click",
				);
				expect(start).not.toContain("their retries.");

				await mouseClick(setup, GUTTER_X, 3);
				const middle = await awaitFrame(
					setup,
					(frame) => frame !== start && frame !== end,
					"the middle track click",
				);
				expect(detailFocused(middle)).toBe(true);

				await mouseClick(setup, GUTTER_X, 1);
				await mouseDrag(setup, [GUTTER_X, 1], [GUTTER_X, 5]);
				const draggedDown = await awaitFrame(
					setup,
					(frame) => frame !== start && !frame.includes("Retry policy for webhooks"),
					"a thumb drag toward the end",
				);
				expect(thumbRows(draggedDown).at(-1)).toBeGreaterThan(1);
				await mouseDrag(setup, [GUTTER_X, 5], [GUTTER_X, 1]);
				await awaitFrame(
					setup,
					(frame) => frame.includes("Retry policy for webhooks"),
					"a thumb drag toward the start",
				);
			},
			SCROLL_WIDTH,
			8,
		);
	});

	test("moves detail state from content, gutter, track, and thumb wheel targets", async () => {
		for (const [name, x, y] of [
			["content", 45, 3],
			["gutter", GUTTER_X, 2],
			["track", GUTTER_X, 8],
			["thumb", GUTTER_X, 1],
		] as const) {
			await withApp(
				async (setup) => {
					const before = setup.captureCharFrame();
					await mouseWheel(setup, x, y, "down");
					const moved = await awaitFrame(
						setup,
						(frame) => detailFocused(frame) && frame !== before,
						`a detail wheel event over its ${name}`,
					);
					expect(markerRowOf(moved)).toBe(2);
				},
				SCROLL_WIDTH,
				SCROLL_HEIGHT,
			);
		}
	});

	test("keeps an immediate page key with the pane that the prior focus key selected", async () => {
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("l");
				setup.mockInput.pressKey("\u001b[6~");
				const page = await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && !frame.includes("Retry policy for webhooks"),
					"a PageDown immediately after detail focus to move the detail",
				);
				expect(markerRowOf(page)).toBe(2);
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
		);
	});

	test("uses fixed detail keys and all page and edge controls", async () => {
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				const initial = agentRow(setup.captureCharFrame());
				const down = await pressArrow(
					setup,
					"down",
					"Down to move the detail one row",
					(frame) => agentRow(frame) === initial - 1,
				);
				await pressArrow(
					setup,
					"up",
					"Up to move the detail one row back",
					(frame) => agentRow(frame) === agentRow(down) + 1,
				);
				await press(
					setup,
					"pagedown",
					"PageDown to move the detail viewport",
					(frame) => !frame.includes("Retry policy for webhooks"),
				);
				await press(setup, "pageup", "PageUp to return through the detail viewport", (frame) =>
					frame.includes("Retry policy for webhooks"),
				);
				await press(setup, "end", "End to move the detail to its edge", (frame) =>
					frame.includes("their retries."),
				);
				const home = await press(setup, "home", "Home to return to the detail start", (frame) =>
					frame.includes("Retry policy for webhooks"),
				);
				setup.mockInput.pressKey("HOME");
				expect(await settle(setup)).toBe(home);
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
		);
	});

	test("uses list arrows, pages, edges, row clicks, and wheel boundary no-ops", async () => {
		await withApp(
			async (setup) => {
				const top = setup.captureCharFrame();
				await mouseWheel(setup, 4, 2, "up");
				expect(await settle(setup)).toBe(top);

				await pressArrow(setup, "down", "Down to select the second Ticket", (frame) =>
					selectedRow(frame).includes("[handed-off]"),
				);
				await pressArrow(setup, "up", "Up to select the first Ticket", (frame) =>
					selectedRow(frame).includes("[open]"),
				);
				await press(setup, "pagedown", "PageDown to select one list page", (frame) =>
					selectedRow(frame).includes("[running]"),
				);
				await press(setup, "pageup", "PageUp to return one list page", (frame) =>
					selectedRow(frame).includes("[open]"),
				);
				await press(setup, "end", "End to select the final Ticket", (frame) =>
					selectedRow(frame).includes("Ticket id"),
				);
				const bottom = setup.captureCharFrame();
				await mouseWheel(setup, 4, 3, "down");
				expect(await settle(setup)).toBe(bottom);
				await press(setup, "home", "Home to select the first Ticket", (frame) =>
					selectedRow(frame).includes("Retry polic"),
				);

				for (const [index, ticket] of SAMPLE_TICKETS.slice(0, 2).entries()) {
					await mouseClick(setup, 4, index + 2);
					const selected = await awaitFrame(
						setup,
						(frame) =>
							listFocused(frame) &&
							selectedRow(frame).includes(ticket.title.slice(0, 8)) &&
							frame.includes(ticket.title.slice(0, 12)),
						`visible Ticket row ${index + 1} to select its Ticket`,
					);
					expect(selectedRow(selected)).toContain(ticket.title.slice(0, 8));
				}
			},
			SCROLL_WIDTH,
			6,
		);
	});

	test("applies slow speed, caps a rapid burst, resets after a pause, and resets on reversal", async () => {
		await withApp(
			async (setup) => {
				const start = agentRow(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 1,
					"the first base wheel step",
				);
				await wheelAt(setup, 1_200, "down");
				await awaitFrame(setup, (frame) => agentRow(frame) === start - 2, "a slow base wheel step");
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: LONG_SCROLL_CONFIG },
		);

		const capped = {
			...DEFAULT_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 3 },
		};
		await withApp(
			async (setup) => {
				const start = agentRow(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 1,
					"the cap burst base step",
				);
				await wheelAt(setup, 1_001, "down");
				await awaitFrame(setup, (frame) => agentRow(frame) === start - 4, "the maximum-speed cap");
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: capped },
		);

		const reset = {
			...DEFAULT_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 2 },
		};
		await withApp(
			async (setup) => {
				const start = agentRow(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 1,
					"the reset burst base step",
				);
				await wheelAt(setup, 1_001, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 3,
					"the accelerated reset burst step",
				);
				await wheelAt(setup, 1_200, "down");
				await awaitFrame(setup, (frame) => agentRow(frame) === start - 4, "the 150 ms reset step");
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: reset },
		);
		await withApp(
			async (setup) => {
				const start = agentRow(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 1,
					"the reversal burst base step",
				);
				await wheelAt(setup, 1_001, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === start - 3,
					"the reversal burst acceleration",
				);
				await wheelAt(setup, 1_002, "up");
				await awaitFrame(setup, (frame) => agentRow(frame) === start - 2, "the reversed base step");
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: reset },
		);
	});

	test("does not bank wheel acceleration at either detail edge", async () => {
		const config = {
			...DEFAULT_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 3 },
		};
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				const top = setup.captureCharFrame();
				await wheelAt(setup, 1_000, "up");
				expect(await settle(setup)).toBe(top);
				const initialAgent = agentRow(top);
				await wheelAt(setup, 1_001, "down");
				await awaitFrame(
					setup,
					(frame) => agentRow(frame) === initialAgent - 1,
					"the precise first step away from the top edge",
				);

				await press(setup, "end", "the detail to reach the lower edge", (frame) =>
					frame.includes("their retries."),
				);
				const bottom = setup.captureCharFrame();
				const bottomDescription = lastDescriptionRow(bottom);
				await wheelAt(setup, 1_002, "down");
				expect(await settle(setup)).toBe(bottom);
				await wheelAt(setup, 1_003, "up");
				await awaitFrame(
					setup,
					(frame) => lastDescriptionRow(frame) === bottomDescription + 1,
					"the precise first step away from the lower edge",
				);
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config },
		);
	});

	test("records monotonic complete frames and applies every rapid accepted wheel event", async () => {
		const linear = {
			...DEFAULT_CONFIG,
			scroll: { speed: 1, acceleration: 0, maximumSpeed: 1 },
		};
		const reference: string[] = [];
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				reference.push(setup.captureCharFrame());
				for (let step = 1; step <= 10; step += 1) {
					const before = reference.at(-1) ?? "";
					setup.mockInput.pressKey("j");
					reference.push(
						await awaitFrame(setup, (frame) => frame !== before, `reference detail step ${step}`),
					);
				}
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: linear },
		);

		await withApp(
			async (setup) => {
				const frames: string[] = [];
				const record = () => frames.push(setup.captureCharFrame());
				setup.renderer.on(CliRenderEvents.FRAME, record);
				try {
					for (let event = 0; event < 10; event += 1) {
						await mouseWheel(setup, 45, 3, "down");
					}
					const final = await awaitFrame(
						setup,
						(frame) => frame === reference[10],
						"the rapid burst to apply all accepted events",
					);
					frames.push(final);
				} finally {
					setup.renderer.off(CliRenderEvents.FRAME, record);
				}
				expect(frames.length).toBeGreaterThan(0);
				const positions = frames.map((frame) => reference.indexOf(frame));
				expect(positions.every((position) => position >= 0)).toBe(true);
				expect(positions).toEqual([...positions].sort((left, right) => left - right));
				expect(positions.at(-1)).toBe(10);
				for (const frame of frames) {
					expectGrid(frame, SCROLL_WIDTH, SCROLL_HEIGHT);
					expect(frame).toContain("┌");
					expect(frame).toContain("└");
					expect(frame.slice(GUTTER_X, GUTTER_X + 1)).toBeDefined();
				}
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
			{ config: linear },
		);
	});

	test("reserves a terminal row for the live mode line through a resize", async () => {
		const state = openFactoryState(":memory:");
		try {
			await withApp(
				async (setup) => {
					setup.resize(73, 18);
					const frame = await awaitFrame(
						setup,
						(candidate) => {
							const rows = rowsOf(candidate);
							return (
								rows.length === 18 &&
								rows.every((row) => row.length === 73) &&
								rows.at(-2)?.includes("└") === true &&
								rows.at(-1)?.startsWith("auto: off 0/2") === true
							);
						},
						"the panes to stay above the live mode line after a resize",
					);
					expect(rowsOf(frame).at(-2)).not.toContain("auto:");
				},
				73,
				18,
				{ state, sources: [] },
			);
		} finally {
			state.close();
		}
	});

	test("resets a new Ticket, preserves same-Ticket refresh offsets, clamps, and survives resize", async () => {
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				await press(setup, "end", "the first detail to reach its end", (frame) =>
					frame.includes("their retries."),
				);
				await press(setup, "h", "the list to take focus", listFocused);
				await mouseClick(setup, 4, 3);
				const nextTicket = await awaitFrame(
					setup,
					(frame) => frame.includes("Fix pan drift in split"),
					"a different Ticket to start at its detail top",
				);
				expect(nextTicket).toContain("Fix pan drift in split");
			},
			SCROLL_WIDTH,
			SCROLL_HEIGHT,
		);

		const state = openFactoryState(":memory:");
		const longDescription = `${SAMPLE_TICKETS[0].description} ${SAMPLE_TICKETS[0].description}`;
		const source = new FakeSource(
			"issues",
			"github-issues",
			sourceSuccess([sourceTicket(longDescription)]),
		);
		try {
			await withApp(
				async (setup) => {
					source.settle(sourceSuccess([sourceTicket(longDescription)]));
					await awaitFrame(
						setup,
						(frame) => frame.includes("Keep detail offset"),
						"the source Ticket",
					);
					await focusDetail(setup);
					for (let step = 0; step < 4; step += 1) {
						setup.mockInput.pressKey("j");
						await settle(setup);
					}
					const beforeRefresh = agentRow(setup.captureCharFrame());
					setup.mockInput.pressKey("r");
					await awaitFrame(setup, () => source.calls >= 2, "the second source refresh to start");
					source.settle(sourceSuccess([sourceTicket(longDescription, "closed", "#11-refresh")]));
					// The source field is below this small viewport at the preserved
					// offset. Grow the terminal only to observe that refresh, then
					// return to the original viewport to verify the native offset.
					setup.resize(SCROLL_WIDTH, 18);
					await awaitFrame(
						setup,
						(frame) => frame.includes("External key: #11-refresh"),
						"the same Ticket refresh",
					);
					setup.resize(SCROLL_WIDTH, SCROLL_HEIGHT);
					await awaitFrame(
						setup,
						(frame) => agentRow(frame) === beforeRefresh,
						"the restored viewport to keep its Ticket offset",
					);

					await press(setup, "end", "the refreshed detail to reach its end", (frame) =>
						frame.includes("their retries."),
					);
					setup.mockInput.pressKey("r");
					await awaitFrame(setup, () => source.calls >= 3, "the clamping refresh to start");
					source.settle(
						sourceSuccess([sourceTicket("Short refreshed detail.", "closed", "#11-short")]),
					);
					const clamped = await awaitFrame(
						setup,
						(frame) => frame.includes("Short refreshed detail."),
						"the shortened same Ticket detail to clamp",
					);
					expect(clamped).toContain("Detail");
				},
				SCROLL_WIDTH,
				SCROLL_HEIGHT,
				{ config: sourceConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}

		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				expectGrid(initial, 80, 12);
				setup.resize(75, 12);
				const oddStart = await awaitFrame(
					setup,
					(frame) => rowsOf(frame).every((row) => row.length === 75) && frame.includes("Detail"),
					"an odd-width resize at the detail start",
				);
				expect(oddStart).toContain("Retry policy for webhooks");

				await focusDetail(setup);
				for (let step = 0; step < 8; step += 1) setup.mockInput.pressKey("j");
				const middle = await awaitFrame(
					setup,
					(frame) => !frame.includes("Retry policy for webhooks"),
					"a middle detail offset",
				);
				setup.resize(40, 12);
				const narrowMiddle = await awaitFrame(
					setup,
					(frame) => rowsOf(frame).every((row) => row.length === 40) && frame.includes("Detail"),
					"a narrow resize at the middle detail offset",
				);
				expect(narrowMiddle).not.toBe(middle);

				await press(setup, "end", "the narrow detail to reach its end", (frame) =>
					frame.includes("retries."),
				);
				setup.resize(8, 8);
				const tinyEnd = await awaitFrame(
					setup,
					(frame) =>
						rowsOf(frame).length === 8 &&
						rowsOf(frame).every((row) => row.length === 8) &&
						frame.includes("┌"),
					"a tiny resize at the detail end",
				);
				// The one remaining inner detail column still carries text; the
				// scrollbar has yielded its gutter instead of taking that column.
				expect(rowsOf(tinyEnd).some((row) => row[6] !== " ")).toBe(true);
				expect(tinyEnd).not.toMatch(/[▀▄█]/);

				setup.resize(80, 12);
				const restored = await awaitFrame(
					setup,
					(frame) =>
						rowsOf(frame).every((row) => row.length === 80) &&
						frame.includes("their retries.") &&
						frame.match(/[▀▄█]/) !== null,
					"the normal width and scrollbar to return",
				);
				expect(restored).not.toContain("Retry policy for webhooks");
			},
			80,
			12,
		);
	});
});
