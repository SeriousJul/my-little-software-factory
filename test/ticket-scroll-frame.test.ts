/** Rendered-frame coverage for the native Ticket detail viewport. */

import { describe, expect, spyOn, test } from "bun:test";
import { CliRenderEvents } from "@opentui/core";

import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { FetchedTicket, Ticket } from "../src/domain/ticket.ts";

import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	agentRowOf,
	announceFramePass,
	cellColors,
	detailFocused,
	frameUntil,
	guideKey,
	listFocused,
	markerRowOf,
	mouseClick,
	mouseDrag,
	mouseWheel,
	pageKey,
	paneRow,
	pressControl,
	type RenderAskWitness,
	rgb,
	roleColor,
	rowsOf,
	type Setup,
	settle,
	stillFrame,
	withApp,
	withholdEveryRenderAsk,
	withholdRenderAsksButThePlanesOwn,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { SAMPLE_TICKETS } from "./fact-fixtures.ts";
import type { FakeSource } from "./fake-source.ts";
import { callsReached, issuesSourceConfig, plane, reopenState } from "./plane.ts";

const SCROLL_WIDTH = 60;
// The minimum terminal that holds the dual-list frame (ADR 0019): the scroll
// tests boot the smallest frame the detail viewport can take.
const SCROLL_HEIGHT = 27;
const GUTTER_X = SCROLL_WIDTH - 2;
/**
 * The detail pane's terminal row, from its inner-area row i.
 *
 * The full-width Ticket header (ADR 0019) owns the body's first row, so the
 * split boxes - and the detail's inner area - start one row below where the
 * list pane's do: the detail's row i is the list's row i plus one.
 */
const detailRow = (i: number): number => paneRow(i) + 1;
const LONG_SCROLL_CONFIG: FactoryConfig = {
	...BASE_CONFIG,
	scroll: { speed: 1, acceleration: 0.8, maximumSpeed: 6 },
};

function lastDescriptionRow(frame: string): number {
	return rowsOf(frame).findIndex((row) => row.includes("its feature flag."));
}

function thumbRows(frame: string): number[] {
	// The gutter holds scrollbar glyphs only on the thumb; the track is a
	// background cell, and the pane border row holds a box-drawing char.
	return rowsOf(frame).flatMap((row, y) =>
		y > 0 && y < rowsOf(frame).length - 1 && /[\u2580\u2584\u2588]/.test(row[GUTTER_X]) ? [y] : [],
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
	const clock = spyOn(Date, "now").mockReturnValue(now);
	try {
		await mouseWheel(setup, { x: 45, y: detailRow(3), direction });
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

/**
 * The sample tickets with a description long enough to overflow the detail
 * pane at the test sizes: the native viewport is the behavior under test,
 * and a detail that fits has nothing to scroll.
 */
const OVERFLOW_TICKETS: readonly Ticket[] = [
	{
		...SAMPLE_TICKETS[0],
		description:
			`${SAMPLE_TICKETS[0].description}\n` +
			Array.from(
				{ length: 12 },
				(_, index) =>
					`A longer note ${index + 1} about the payloads the dead-letter queue holds and why each one waited.`,
			).join("\n"),
	},
	...SAMPLE_TICKETS.slice(1),
];

const sourceConfig: FactoryConfig = {
	...BASE_CONFIG,
	sources: [issuesSourceConfig],
};

/** The source standing the overflow tickets ride: every repository the samples name. */
const overflowSource: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing", "acme/portal", "acme/ingest"],
	host: "github.com",
};

describe("native Ticket detail viewport", () => {
	test("renders a proportional, dim scrollbar track and a focused-color thumb", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				const thumb = thumbRows(initial);
				// The thumb is proportional to the hidden content: it starts on
				// the first inner row and spans as many rows as the overflow
				// earns it at this size.
				expect(thumb.at(0)).toBe(detailRow(0));
				expect(cellColors(setup, GUTTER_X, thumb[0])).toEqual({
					fg: rgb(roleColor("accent")),
					bg: rgb(roleColor("subtext0")),
				});
				expect(cellColors(setup, GUTTER_X, detailRow(2)).bg).toEqual(rgb(roleColor("subtext0")));

				await mouseClick(setup, 45, detailRow(3));
				await frameUntil(setup, "the detail to take click focus", detailFocused);
				expect(cellColors(setup, GUTTER_X, thumb[0]).fg).toEqual(rgb(roleColor("accent")));

				// The track spans the pane's inner rows. The thumb marks the
				// offset, so the end click lands on the track below it.
				await mouseClick(setup, GUTTER_X, detailRow(11));
				const end = await frameUntil(
					setup,
					"the scrollbar thumb to move to its lower proportional position",
					(frame) => frame !== initial && !frame.includes("Drop the legacy auth shim"),
				);
				const endThumb = thumbRows(end);
				expect(endThumb.at(-1)).toBeGreaterThan(thumb[0]);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("handles track clicks at both edges and the middle, then thumb drags in both directions", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				await mouseClick(setup, GUTTER_X, detailRow(11));
				const end = await frameUntil(
					setup,
					"the end track click",
					(frame) => detailFocused(frame) && frame !== initial,
				);
				expect(end).not.toContain("Drop the legacy auth shim");

				await mouseClick(setup, GUTTER_X, detailRow(1));
				const start = await frameUntil(setup, "the start track click", (frame) =>
					frame.includes("Drop the legacy auth shim"),
				);
				expect(start).not.toContain("its feature flag.");

				await mouseClick(setup, GUTTER_X, detailRow(6));
				const middle = await frameUntil(
					setup,
					"the middle track click",
					(frame) => frame !== start && frame !== end,
				);
				expect(detailFocused(middle)).toBe(true);

				await mouseClick(setup, GUTTER_X, detailRow(1));
				await mouseDrag(setup, [GUTTER_X, detailRow(1)], [GUTTER_X, detailRow(11)]);
				const draggedDown = await frameUntil(
					setup,
					"a thumb drag toward the end",
					(frame) => frame !== start && !frame.includes("Drop the legacy auth shim"),
				);
				expect(thumbRows(draggedDown).at(-1)).toBeGreaterThan(detailRow(1));
				await mouseDrag(setup, [GUTTER_X, detailRow(11)], [GUTTER_X, detailRow(1)]);
				await frameUntil(setup, "a thumb drag toward the start", (frame) =>
					frame.includes("Drop the legacy auth shim"),
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("moves detail state from content, gutter, track, and thumb wheel targets", async () => {
		for (const [name, x, y] of [
			["content", 45, detailRow(3)],
			["gutter", GUTTER_X, detailRow(2)],
			["track", GUTTER_X, detailRow(6)],
			["thumb", GUTTER_X, detailRow(0)],
		] as const) {
			const planeRecord = await plane();
			await withApp(
				async (setup) => {
					const before = setup.captureCharFrame();
					await mouseWheel(setup, { x: x, y: y, direction: "down" });
					const moved = await frameUntil(
						setup,
						`a detail wheel event over its ${name}`,
						(frame) => detailFocused(frame) && stillFrame(frame) !== stillFrame(before),
					);
					expect(markerRowOf(moved)).toBe(3);
				},
				{
					width: SCROLL_WIDTH,
					height: SCROLL_HEIGHT,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
		}
	});

	test("keeps a page key with the pane that the prior focus key selected", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				await pressControl(setup, "detail", { via: "l", quiet: true });
				await pageKey(setup, "end", { quiet: true });
				const page = await frameUntil(
					setup,
					"the End key to move the detail the focus key just took",
					(frame) => detailFocused(frame) && !frame.includes("Drop the legacy auth shim"),
				);
				expect(markerRowOf(page)).toBe(3);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("uses fixed detail keys and all page and edge controls", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				const initial = agentRowOf(setup.captureCharFrame());
				await pressControl(setup, "scroll-detail", { via: "↓", quiet: true });
				const down = await frameUntil(
					setup,
					"the detail to move one row down",
					(frame) => agentRowOf(frame) === initial - 1,
				);
				await pressControl(setup, "scroll-detail", { via: "↑", quiet: true });
				await frameUntil(
					setup,
					"the detail to move one row back",
					(frame) => agentRowOf(frame) === agentRowOf(down) + 1,
				);
				await pageKey(setup, "pagedown", { hides: "Drop the legacy auth shim" });
				await pageKey(setup, "pageup", { shows: "Drop the legacy auth shim" });
				await pageKey(setup, "end", { shows: "its feature flag." });
				const home = await pageKey(setup, "home", { shows: "Drop the legacy auth shim" });
				const again = await pageKey(setup, "home", { quiet: true });
				expect(stillFrame(again)).toBe(stillFrame(home));
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("uses list arrows, pages, edges, row clicks, and wheel boundary no-ops", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				const top = setup.captureCharFrame();
				await mouseWheel(setup, { x: 4, y: paneRow(2), direction: "up" });
				expect(stillFrame(await settle(setup))).toBe(stillFrame(top));

				await pressControl(setup, "move-list", { via: "↓", moved: "[running]" });
				await pressControl(setup, "move-list", { via: "↑", moved: "[awaiting]" });
				// The list window holds six rows at this size, so a page from
				// the first ticket lands on the seventh.
				await pageKey(setup, "pagedown", { quiet: true });
				await frameUntil(setup, "the list page to land on its seventh Ticket", (frame) =>
					selectedRow(frame).includes("Run the con"),
				);
				await pageKey(setup, "pageup", { quiet: true });
				await frameUntil(setup, "the list to return one page", (frame) =>
					selectedRow(frame).includes("[awaiting]"),
				);
				await pageKey(setup, "end", { quiet: true });
				await frameUntil(setup, "the list to select its final Ticket", (frame) =>
					selectedRow(frame).includes("Ticket id"),
				);
				const bottom = setup.captureCharFrame();
				await mouseWheel(setup, { x: 4, y: paneRow(3), direction: "down" });
				expect(stillFrame(await settle(setup))).toBe(stillFrame(bottom));
				await pageKey(setup, "home", { quiet: true });
				await frameUntil(setup, "the list to select its first Ticket", (frame) =>
					selectedRow(frame).includes("[awaiting]"),
				);

				// The list's first two rows on the Seeded plane's boot: the
				// awaiting run leads, the running one stands under it. The rows
				// truncate the title at this width, so the pick reads the row's
				// state cell, and the frame the detail pane's whole title.
				const picks: Array<{ row: string; title: string }> = [
					{ row: "[awaiting]", title: "Drop the legacy auth shim" },
					{ row: "[running]", title: "Migrate scheduler" },
				];
				for (const [index, pick] of picks.entries()) {
					await mouseClick(setup, 4, paneRow(index + 2));
					const selected = await frameUntil(
						setup,
						`visible Ticket row ${index + 1} to select its Ticket`,
						(frame) =>
							listFocused(frame) &&
							selectedRow(frame).includes(pick.row) &&
							frame.includes(pick.title),
					);
					expect(selectedRow(selected)).toContain(pick.row);
				}
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("applies slow speed, caps a rapid burst, resets after a pause, and resets on reversal", async () => {
		const planeRecord = await plane({ config: LONG_SCROLL_CONFIG });
		await withApp(
			async (setup) => {
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await frameUntil(
					setup,
					"the first base wheel step",
					(frame) => agentRowOf(frame) === start - 1,
				);
				await wheelAt(setup, 1_200, "down");
				await frameUntil(
					setup,
					"a slow base wheel step",
					(frame) => agentRowOf(frame) === start - 2,
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		const capped = {
			...BASE_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 3 },
		};
		const planeRecord2 = await plane({ config: capped });
		await withApp(
			async (setup) => {
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await frameUntil(
					setup,
					"the cap burst base step",
					(frame) => agentRowOf(frame) === start - 1,
				);
				await wheelAt(setup, 1_001, "down");
				await frameUntil(
					setup,
					"the maximum-speed cap",
					(frame) => agentRowOf(frame) === start - 4,
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord2,
				loopPolicy: { kind: "held" },
			},
		);

		const reset = {
			...BASE_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 2 },
		};
		const planeRecord3 = await plane({ config: reset });
		await withApp(
			async (setup) => {
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await frameUntil(
					setup,
					"the reset burst base step",
					(frame) => agentRowOf(frame) === start - 1,
				);
				await wheelAt(setup, 1_001, "down");
				await frameUntil(
					setup,
					"the accelerated reset burst step",
					(frame) => agentRowOf(frame) === start - 3,
				);
				await wheelAt(setup, 1_200, "down");
				await frameUntil(
					setup,
					"the 150 ms reset step",
					(frame) => agentRowOf(frame) === start - 4,
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord3,
				loopPolicy: { kind: "held" },
			},
		);
		const planeRecord4 = await plane({ config: reset });
		await withApp(
			async (setup) => {
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(setup, 1_000, "down");
				await frameUntil(
					setup,
					"the reversal burst base step",
					(frame) => agentRowOf(frame) === start - 1,
				);
				await wheelAt(setup, 1_001, "down");
				await frameUntil(
					setup,
					"the reversal burst acceleration",
					(frame) => agentRowOf(frame) === start - 3,
				);
				await wheelAt(setup, 1_002, "up");
				await frameUntil(
					setup,
					"the reversed base step",
					(frame) => agentRowOf(frame) === start - 2,
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord4,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("does not bank wheel acceleration at either detail edge", async () => {
		const config = {
			...BASE_CONFIG,
			scroll: { speed: 1, acceleration: 5, maximumSpeed: 3 },
		};
		const planeRecord = await plane({ config });
		await withApp(
			async (setup) => {
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				const top = setup.captureCharFrame();
				await wheelAt(setup, 1_000, "up");
				expect(stillFrame(await settle(setup))).toBe(stillFrame(top));
				const initialAgent = agentRowOf(top);
				await wheelAt(setup, 1_001, "down");
				await frameUntil(
					setup,
					"the precise first step away from the top edge",
					(frame) => agentRowOf(frame) === initialAgent - 1,
				);

				await pageKey(setup, "end", { shows: "its feature flag." });
				const bottom = setup.captureCharFrame();
				const bottomDescription = lastDescriptionRow(bottom);
				await wheelAt(setup, 1_002, "down");
				expect(stillFrame(await settle(setup))).toBe(stillFrame(bottom));
				await wheelAt(setup, 1_003, "up");
				await frameUntil(
					setup,
					"the precise first step away from the lower edge",
					(frame) => lastDescriptionRow(frame) === bottomDescription + 1,
				);
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("records monotonic complete frames and applies every rapid accepted wheel event", async () => {
		const linear = {
			...BASE_CONFIG,
			scroll: { speed: 1, acceleration: 0, maximumSpeed: 1 },
		};
		// Ten base steps need a detail taller than the minimum frame's
		// viewport, so the ticket carries a description that fills it.
		const longTicket = sourceTicket(
			`${SAMPLE_TICKETS[0].description} ${SAMPLE_TICKETS[0].description} ${SAMPLE_TICKETS[0].description}`,
		);
		const reference: string[] = [];
		const state = reopenState(":memory:");
		const planeRecord = await plane({
			existing: state,
			groupingAxis: "none",
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: linear,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(sourceSuccess([longTicket]));
				await frameUntil(setup, "the source Ticket", (f) => f.includes("Keep detail offset"));
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				reference.push(setup.captureCharFrame());
				for (let step = 1; step <= 10; step += 1) {
					reference.push(await pressControl(setup, "scroll-detail", { via: "j", quiet: true }));
				}
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		await withApp(
			async (setup) => {
				// The remounted app starts its own fetch of the same ticket;
				// settle it so the burst scrolls the settled detail.
				source.settle(sourceSuccess([longTicket]));
				await frameUntil(setup, "the source Ticket", (f) => f.includes("Keep detail offset"));
				const frames: string[] = [];
				const record = () => frames.push(setup.captureCharFrame());
				setup.renderer.on(CliRenderEvents.FRAME, record);
				try {
					for (let event = 0; event < 10; event += 1) {
						await mouseWheel(setup, { x: 45, y: detailRow(3), direction: "down" });
					}
					const final = await frameUntil(
						setup,
						"the rapid burst to apply all accepted events",
						(frame) => frame === reference[10],
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
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("spends no terminal row on the mode cell through a resize", async () => {
		const state = reopenState(":memory:");
		const planeRecord = await plane({ existing: state, groupingAxis: "none", sources: [] });
		await withApp(
			async (setup) => {
				setup.resize(73, 27);
				const frame = await frameUntil(
					setup,
					"the panes to stay above the live mode cell after a resize",
					(candidate) => {
						const rows = rowsOf(candidate);
						// One frame: the body with its three sections, then the
						// reserved Message line and the Action bar. The Ticket
						// header's mode cell rides the body's first row.
						return (
							rows.length === 27 &&
							rows.every((row) => row.length === 73) &&
							rows[0]?.includes("● manual 0/2") === true &&
							rows.at(-3)?.includes("└") === true
						);
					},
				);
				expect(rowsOf(frame).at(-2)).not.toContain("manual");
			},
			{ width: 73, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("resets a new Ticket, preserves same-Ticket refresh offsets, clamps, and survives resize", async () => {
		const planeRecord = await plane();
		await withApp(
			async (setup) => {
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				await pageKey(setup, "end", { shows: "its feature flag." });
				await pressControl(setup, "tickets", { via: "h", moved: "tickets" });
				await mouseClick(setup, 4, paneRow(3));
				const nextTicket = await frameUntil(
					setup,
					"a different Ticket to start at its detail top",
					(frame) => frame.includes("Migrate scheduler"),
				);
				expect(nextTicket).toContain("Migrate scheduler");
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		const state = reopenState(":memory:");
		const longDescription = `${SAMPLE_TICKETS[0].description} ${SAMPLE_TICKETS[0].description}`;
		const planeRecord2 = await plane({
			existing: state,
			groupingAxis: "none",
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: sourceConfig,
			settledReads: false,
		});
		const source = planeRecord2.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(sourceSuccess([sourceTicket(longDescription)]));
				await frameUntil(setup, "the source Ticket", (frame) =>
					frame.includes("Keep detail offset"),
				);
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				for (let step = 0; step < 4; step += 1) {
					await pressControl(setup, "scroll-detail", { via: "j", quiet: true });
				}
				const beforeRefresh = agentRowOf(setup.captureCharFrame());
				await guideKey(setup, "refresh", "r", { quiet: true });
				await callsReached(source, 2);
				source.settle(sourceSuccess([sourceTicket(longDescription, "closed", "#11-refresh")]));
				// The source field is below this small viewport at the preserved
				// offset. Grow the terminal only to observe that refresh, then
				// return to the original viewport to verify the native offset.
				setup.resize(SCROLL_WIDTH, SCROLL_HEIGHT + 3);
				await frameUntil(setup, "the same Ticket refresh", (frame) =>
					frame.includes("External key: #11-refresh"),
				);
				setup.resize(SCROLL_WIDTH, SCROLL_HEIGHT);
				await frameUntil(
					setup,
					"the restored viewport to keep its Ticket offset",
					(frame) => agentRowOf(frame) === beforeRefresh,
				);

				await pageKey(setup, "end", { shows: "their retries." });
				await guideKey(setup, "refresh", "r", { quiet: true });
				await callsReached(source, 3);
				source.settle(
					sourceSuccess([sourceTicket("Short refreshed detail.", "closed", "#11-short")]),
				);
				const clamped = await frameUntil(
					setup,
					"the shortened same Ticket detail to clamp",
					(frame) => frame.includes("Short refreshed detail."),
				);
				expect(clamped).toContain("Detail");
			},
			{
				width: SCROLL_WIDTH,
				height: SCROLL_HEIGHT,
				plane: planeRecord2,
				loopPolicy: { kind: "held" },
			},
		);

		const planeRecord3 = await plane({
			sources: [{ config: overflowSource, tickets: OVERFLOW_TICKETS }],
		});
		await withApp(
			async (setup) => {
				const initial = setup.captureCharFrame();
				expectGrid(initial, 80, SCROLL_HEIGHT);
				setup.resize(75, SCROLL_HEIGHT);
				const oddStart = await frameUntil(
					setup,
					"an odd-width resize at the detail start",
					(frame) => rowsOf(frame).every((row) => row.length === 75) && frame.includes("Detail"),
				);
				expect(oddStart).toContain("Drop the legacy auth shim");

				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				for (let step = 0; step < 8; step += 1) {
					await pressControl(setup, "scroll-detail", { via: "j", quiet: true });
				}
				const middle = await frameUntil(
					setup,
					"a middle detail offset",
					(frame) => !frame.includes("Drop the legacy auth shim"),
				);
				setup.resize(40, SCROLL_HEIGHT);
				const narrowMiddle = await frameUntil(
					setup,
					"a narrow resize at the middle detail offset",
					(frame) => rowsOf(frame).every((row) => row.length === 40) && frame.includes("Detail"),
				);
				expect(narrowMiddle).not.toBe(middle);

				// The phrase wraps at this width, so the end is read on the
				// tail that one line still holds whole.
				await pageKey(setup, "end", { shows: "feature flag." });
				setup.resize(8, 8);
				const tinyEnd = await frameUntil(
					setup,
					"a tiny resize to the compact frame",
					(frame) =>
						rowsOf(frame).length === 8 &&
						rowsOf(frame).every((row) => row.length === 8) &&
						frame.includes("Termin"),
				);
				expect(tinyEnd).not.toMatch(/[▀▄█]/);

				// The compact frame unmounted the panes. The remounted detail
				// resumes from the offset the unmount saved, clamped to the
				// wider viewport, instead of restarting at the top. The tail
				// wraps here, so the end is read on its last word.
				setup.resize(80, SCROLL_HEIGHT);
				await frameUntil(
					setup,
					"the normal width with the restored detail offset",
					(frame) =>
						rowsOf(frame).every((row) => row.length === 80) &&
						frame.includes("flag.") &&
						frame.match(/[▀▄█]/) !== null,
				);
			},
			{ width: 80, height: SCROLL_HEIGHT, plane: planeRecord3, loopPolicy: { kind: "held" } },
		);
	});

	/**
	 * The scroll and the drop below the minimum size every case below walks: take
	 * the detail focus, scroll the overflowing detail off its own title, then drop
	 * the terminal below the minimum size so the compact frame unmounts the panes.
	 * The terminal is left below the minimum, idle, with the offset the unmount
	 * saved held in the pane's slot.
	 */
	async function scrollOffTheTitleAndDropBelowTheMinimum(setup: Setup): Promise<void> {
		await pressControl(setup, "detail", { via: "l", moved: "detail" });
		// Scroll to a middle offset: the detail title leaves the viewport.
		let frame = setup.captureCharFrame();
		for (let step = 0; step < 20 && frame.includes("Drop the legacy auth shim"); step += 1) {
			frame = await pressControl(setup, "scroll-detail", { via: "j", quiet: true });
		}
		const middle = await frameUntil(
			setup,
			"a middle detail offset with the title out of view",
			(f) => f.includes("Detail") && !f.includes("Drop the legacy auth shim"),
		);
		expect(middle).toMatch(/[▀▄█]/);

		// Below the minimum size the compact frame unmounts the panes.
		setup.resize(39, 12);
		const compact = await frameUntil(setup, "the compact frame", (f) =>
			f.includes("Terminal too small"),
		);
		expect(compact).not.toMatch(/[▀▄█]/);
		await settle(setup);
	}

	/**
	 * The below-minimum resize round trip both round-trip cases below walk: scroll
	 * the overflowing detail off its own title, drop the terminal below the minimum
	 * size so the compact frame unmounts the panes, take the terminal back, and
	 * read the remounted detail.
	 *
	 * With `holdAsks`, every render ask but the control plane's own is held back
	 * from the moment the terminal comes back: the rig's resize ask, and the asks
	 * the remount's own renderable mutations make, never schedule a pass. So the
	 * remounted box still answers no size when the restore effect runs - the branch
	 * the unheld case takes only while the runner is quiet - and the only pass that
	 * can lay the box out is the one the Ticket detail asks for itself (issue #302).
	 * The witness then states how many asks that one remount cost the pane.
	 *
	 * Where this pin bites, written as steps a reviewer can re-run. Each probe
	 * edits one file, runs `bun test test/ticket-scroll-frame.test.ts --isolate
	 * --timeout=30000`, and is then reverted. Every count and timing below is what
	 * the probe produced on this head, and each left the other records in the file
	 * green.
	 *
	 * Probe D, the ask the pane owes itself. In the restore effect of
	 * `src/components/ticket-detail.ts`, delete the line `renderer.requestRender();`.
	 * 2 records go red, with the other 12 in the file green: the held case at
	 * 10228.18 ms, the local 10000 ms `FRAME_DEADLINE_MS`, because with every
	 * outside ask swallowed no pass lands, the box never lays out, and the offset
	 * never comes back - its dump is blank rows, since after the resize nothing
	 * repainted the buffer at all; and "the Ticket detail asks for one pass and
	 * stops when its box never lays out" at 518.80 ms, with the witness at 0 asks
	 * where the record expects 1. The unheld round-trip case stays green, which is
	 * the gap the review of the first round named: the rig's own resize ask used to
	 * supply the pass the pane owes itself.
	 *
	 * Probe E, the one-ask bound. In the same effect, delete `let passAsked = false;`,
	 * `if (passAsked) return;` and `passAsked = true;`. 1 record goes red, "the
	 * Ticket detail asks for one pass and stops when its box never lays out", at
	 * 521.26 ms, with the witness at 6 asks where the record expects 1: the
	 * unbounded restore asks again on every pass the rig announces. The other 13
	 * stay green - the pass the pane asks for lays the box out, so no round-trip
	 * case reaches the bound. The case below is what reaches it.
	 *
	 * Probe F, the hold letting an outside ask through. In `renderAskComesFromThePlane`
	 * in `test/app-harness.ts`, drop the `!caller.includes("node_modules")` half of the
	 * caller test, so OpenTUI's own asks count as the plane's. 2 records go red, with
	 * the other 12 green: the held case at 258.36 ms on the hold's own swallowed-count
	 * line - the rig's resize ask is waved through at once, the hold swallows nothing,
	 * and a hold that swallowed nothing says so instead of leaving the case to pass on
	 * a pass the pane never asked for - and the new case at 522.47 ms on its ask-count
	 * line, because the rig's resize ask reads as the pane's own.
	 */
	async function resizeBelowTheMinimumAndBack(setup: Setup, holdAsks: boolean): Promise<void> {
		await scrollOffTheTitleAndDropBelowTheMinimum(setup);

		// Back at normal size, the remounted detail resumes from the offset the
		// unmount saved: the title stays out of view instead of the viewport
		// restarting at its top. The hold goes up only once the screen is idle, so
		// a pass scheduled before it cannot land between the resize and the restore.
		const handAsksBack = holdAsks ? withholdRenderAsksButThePlanesOwn(setup) : null;
		setup.resize(80, SCROLL_HEIGHT);
		let witness: RenderAskWitness | null = null;
		try {
			await frameUntil(
				setup,
				"the detail offset to resume below the title",
				(f) =>
					rowsOf(f).every((row) => row.length === 80) &&
					f.includes("Detail") &&
					f.match(/[▀▄█]/) !== null &&
					!f.includes("Drop the legacy auth shim"),
			);
		} finally {
			if (handAsksBack !== null) witness = handAsksBack();
		}
		if (witness !== null) {
			expect(
				witness.planeAsks,
				"one remount of the Ticket detail asked the renderer for a pass more than once",
			).toBe(1);
		}
	}

	test("restores the detail offset across a round-trip resize below the minimum size", async () => {
		const planeRecord = await plane({
			sources: [{ config: overflowSource, tickets: OVERFLOW_TICKETS }],
		});
		await withApp(
			async (setup) => {
				await resizeBelowTheMinimumAndBack(setup, false);
			},
			{ width: 80, height: SCROLL_HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("restores the detail offset across a below-minimum resize on its own render ask alone", async () => {
		const planeRecord = await plane({
			sources: [{ config: overflowSource, tickets: OVERFLOW_TICKETS }],
		});
		await withApp(
			async (setup) => {
				await resizeBelowTheMinimumAndBack(setup, true);
			},
			{ width: 80, height: SCROLL_HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the Ticket detail asks for one pass and stops when its box never lays out", async () => {
		const planeRecord = await plane({
			sources: [{ config: overflowSource, tickets: OVERFLOW_TICKETS }],
		});
		await withApp(
			async (setup) => {
				await scrollOffTheTitleAndDropBelowTheMinimum(setup);
				// Every ask is held, the pane's own included, so no pass can run and
				// the remounted box never lays out. The rig announces the passes the
				// restore registers for, and the pane meets its no-size answer on each
				// one: the give-up path, which no reachable app state puts a box on.
				const handAsksBack = withholdEveryRenderAsk(setup);
				setup.resize(80, SCROLL_HEIGHT);
				await settle(setup);
				for (let pass = 0; pass < 5; pass += 1) {
					announceFramePass(setup);
					await settle(setup);
				}
				const witness = handAsksBack();
				expect(
					witness.planeAsks,
					"a Ticket detail whose box never lays out asked the renderer for a pass more than once",
				).toBe(1);
				// No pass ran, so nothing repainted after the resize: the buffer
				// holds no detail pane and no thumb, and the saved offset was never
				// applied to anything the operator can see.
				const painted = setup.captureCharFrame();
				expect(painted).not.toContain("Detail");
				expect(painted).not.toMatch(/[▀▄█]/);
			},
			{ width: 80, height: SCROLL_HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});
});
