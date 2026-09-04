/**
 * The single seam: the rendered terminal frame.
 *
 * The app renders headless through the first-party OpenTUI test renderer.
 * Mock keys drive it, the character frame is captured, and the tests assert
 * on what an operator would see. The sample-data contract is observed the
 * same way: no test reads the sample data directly and passes.
 *
 * Three harness rules keep the suite honest:
 *
 * - Waits end on the effect being asserted, or on a hard deadline. Keys
 *   dispatch through the stdin parser's 20ms escape-sequence timer, which
 *   the renderer's event-driven waits do not cover, so the press helpers
 *   poll the frame until the effect appears and fail loudly at the
 *   deadline. No correctness wait is a fixed sleep.
 * - Stability waits never trust a pre-dispatch frame. In this harness a
 *   frame change lands 14-16 ms after the press, so `settle` waits out a
 *   30 ms dispatch grace first and then requires two consecutive
 *   identical polls. A no-op key cannot read as stable before it was
 *   dispatched.
 * - console.error is captured, not suppressed. The React act() warning is
 *   the known noise of this setup: the test renderer drives real renders
 *   outside act. Anything else is a defect and fails the test.
 *
 * The renderer is a system resource of the test. `withApp` boots it, runs
 * the test body, and destroys it in a finally, so no test body owns its
 * own cleanup.
 */
import { CliRenderEvents } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import stringWidth from "string-width";
import { describe, expect, test, vi } from "vitest";
import { COLORS, STATE_COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import {
	agentRowOf,
	awaitFrame,
	bootApp,
	cellColors,
	detailFocused,
	detailPaneText,
	expectStateBadges,
	focusDetail,
	frameText,
	listFocused,
	listHalfOf,
	markerRowOf,
	mouseClick,
	mouseDrag,
	mousePress,
	mouseWheel,
	openPanel,
	press,
	pressArrow,
	rgb,
	rowsOf,
	scrollDetailUntil,
	settle,
	showsTicket,
	sleep,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

describe("the control plane", () => {
	test("production starts with no configured ticket sources instead of sample data", async () => {
		const state = openFactoryState(":memory:");
		try {
			await withApp(
				async (setup) => {
					const frame = await awaitFrame(
						setup,
						(candidate) => candidate.includes("no ticket sources configured"),
						"the no-sources state",
					);
					expect(frame).not.toContain(SAMPLE_TICKETS[0].title);
				},
				WIDTH,
				30,
				{ state },
			);
		} finally {
			state.close();
		}
	});

	test("list pane shows every sample ticket with its state badge and repository", async () => {
		await withApp(async (setup) => {
			const frame = frameText(setup.captureCharFrame());
			for (const ticket of SAMPLE_TICKETS) {
				expect(frame).toContain(ticket.repository);
			}
			expectStateBadges(frame);
		});
	});

	test("detail pane shows the full detail of the selected ticket", async () => {
		await withApp(async (setup) => {
			const detail = detailPaneText(setup.captureCharFrame());
			const first = SAMPLE_TICKETS[0];
			// The full title and description live in the detail pane.
			expect(detail).toContain(first.description);
			expect(detail).toContain("Agent: pi");
			expect(detail).toContain("Model: left to agent");
			expect(detail).toContain("Thinking: left to agent");
			// A setting the profile leaves out reads the same way: the agent's own
			// default is the only one the control plane does not know.
			expect(detail).toContain("Context: left to agent");
			expect(detail).toContain("Source state: open");
			// The open ticket's task type line says which fact it is.
			expect(detail).toContain("Suggested task type: implement");
			expect(detail).not.toContain("Handoff task type:");
		});
	});

	test("the sample-data contract is observable in the rendered frame", async () => {
		await withApp(async (setup) => {
			// Every ticket state is on screen at once.
			let frame = frameText(setup.captureCharFrame());
			expectStateBadges(frame);

			// The sample set spans more than one repository, read off the
			// frame, not the data.
			const repos = new Set([...frame.matchAll(/\b[a-z]+\/[a-z-]+\b/g)].map((m) => m[0]));
			expect(repos.size).toBeGreaterThanOrEqual(2);

			// A ticket can carry the GitHub closed status. Navigate to the
			// awaiting ticket and read the source fact in the detail pane.
			for (let i = 1; i <= 3; i += 1) {
				await press(setup, "j", `the selection to move to ticket ${i + 1}`, (f) =>
					showsTicket(f, SAMPLE_TICKETS[i]),
				);
			}
			frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Source state: closed");
			// The awaiting ticket is done with its turn: ticket state and
			// GitHub status stay distinct facts.
			expect(frame).toContain("[awaiting]");
		});
	});

	test("j and k move the selection down and up", async () => {
		await withApp(async (setup) => {
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && !showsTicket(f, SAMPLE_TICKETS[0]),
			);
			await press(
				setup,
				"k",
				"the selection to move back to the first ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[0]) && !showsTicket(f, SAMPLE_TICKETS[1]),
			);
		});
	});

	test("the up and down arrows move the selection", async () => {
		await withApp(async (setup) => {
			await pressArrow(setup, "down", "the selection to move to the second ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[1]),
			);
			await pressArrow(
				setup,
				"up",
				"the selection to move back to the first ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[0]) && !showsTicket(f, SAMPLE_TICKETS[1]),
			);
		});
	});

	test("l and h switch pane focus and the vertical keys stay with the focus", async () => {
		await withApp(async (setup) => {
			// Focus starts on the list pane.
			let frame = setup.captureCharFrame();
			expect(frame).toContain("❯ Tickets");
			expect(frame).not.toContain("❯ Detail");

			// l moves the focus to the detail pane.
			frame = await focusDetail(setup);

			// j with the detail focused cannot scroll at this size. The
			// catalogue reports its unavailable reason on the Message line;
			// it does not move the selected Ticket.
			setup.mockInput.pressKey("j");
			const after = await awaitFrame(
				setup,
				(frame) => frame.includes("the Ticket detail has nowhere to scroll"),
				"the unavailable Scroll reason",
			);
			expect(markerRowOf(after)).toBe(2);

			// h moves the focus back to the list pane; the selection is
			// preserved.
			frame = await press(setup, "h", "the list pane to take focus", listFocused);
			expect(markerRowOf(frame)).toBe(2);
			expect(showsTicket(frame, SAMPLE_TICKETS[0])).toBe(true);
		});
	});

	test("the left and right arrows switch pane focus and the selection is preserved", async () => {
		await withApp(async (setup) => {
			// Move the selection to the second ticket while the list is
			// focused.
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && markerRowOf(f) === 3,
			);

			// The right arrow focuses the detail pane. The selection is
			// preserved: the marker stays on the second row and the detail
			// still shows the second ticket.
			const right = await pressArrow(
				setup,
				"right",
				"the detail pane to take focus",
				detailFocused,
			);
			expect(markerRowOf(right)).toBe(3);
			expect(showsTicket(right, SAMPLE_TICKETS[1])).toBe(true);

			// The left arrow focuses the list pane. The selection is
			// preserved.
			const left = await pressArrow(setup, "left", "the list pane to take focus", listFocused);
			expect(markerRowOf(left)).toBe(3);
			expect(showsTicket(left, SAMPLE_TICKETS[1])).toBe(true);
		});
	});

	test("a mouse click moves the pane focus and the borders follow", async () => {
		await withApp(async (setup) => {
			// The list box ends at half the terminal width; the detail box's
			// left border sits one cell further right.
			const detailX = Math.floor(WIDTH / 2);

			// Click the detail pane: it takes the app focus and paints its
			// border with the focused color; the list border relaxes.
			await mouseClick(setup, detailX + 10, 5);
			await awaitFrame(setup, detailFocused, "the detail pane to take click focus");
			expect(cellColors(setup, detailX, 0).fg).toEqual(rgb(COLORS.borderFocused));
			expect(cellColors(setup, 0, 0).fg).toEqual(rgb(COLORS.border));

			// Click the list pane: the focus moves and the detail border
			// follows. The first click also gave the detail's scroll box
			// OpenTUI's own focus; the deactivated border must not keep the
			// focused color.
			await mouseClick(setup, 10, 5);
			await awaitFrame(setup, listFocused, "the list pane to take click focus");
			expect(cellColors(setup, 0, 0).fg).toEqual(rgb(COLORS.borderFocused));
			expect(cellColors(setup, detailX, 0).fg).toEqual(rgb(COLORS.border));
		});
	});

	test("a right press activates no pane: both panes share one mouse policy", async () => {
		await withApp(async (setup) => {
			// The detail pane once took focus on any mouse event. The shared
			// policy activates only on a left press or a vertical wheel, so a
			// right press over the detail changes nothing.
			const before = setup.captureCharFrame();
			await mousePress(setup, Math.floor(WIDTH / 2) + 10, 5, MouseButtons.RIGHT);
			expect(await settle(setup)).toBe(before);
		});
	});

	test("j and k scroll the detail pane when it is focused", async () => {
		await withApp(
			async (setup) => {
				// Focus the detail pane; the list keeps its selection.
				await focusDetail(setup);
				const agentRow = agentRowOf(setup.captureCharFrame());
				expect(agentRow).toBeGreaterThan(0);
				expect(markerRowOf(setup.captureCharFrame())).toBe(2);

				// j translates the native surface one terminal row. The top padding
				// scrolls away first, and every mounted content row moves together.
				const scrolled = await press(
					setup,
					"j",
					"the detail to scroll down one row",
					(f) => agentRowOf(f) === agentRow - 1 && f.includes("Retry policy for webhooks"),
				);
				// The selection did not move.
				expect(markerRowOf(scrolled)).toBe(2);

				// k scrolls back to the top. The title is back.
				const back = await press(
					setup,
					"k",
					"the detail to scroll back to the top",
					(f) => agentRowOf(f) === agentRow && f.includes("Retry policy for webhooks"),
				);
				expect(markerRowOf(back)).toBe(2);
			},
			60,
			10,
		);
	});

	test("the detail scroll stays within its bounds", async () => {
		await withApp(
			async (setup) => {
				await focusDetail(setup);

				// At the top edge, k cannot scroll up.
				const before = setup.captureCharFrame();
				setup.mockInput.pressKey("k");
				const afterTop = await settle(setup);
				expect(afterTop).toBe(before);

				// Press j past the bottom edge, one key at a time. The detail
				// settles on its last page: the final description line is
				// visible and the title is out of view.
				for (let i = 0; i < 30; i += 1) {
					setup.mockInput.pressKey("j");
					await sleep(25);
				}
				const atBottom = await awaitFrame(
					setup,
					(f) =>
						frameText(f).includes("their retries.") && !f.includes("Retry policy for webhooks"),
					"the detail to reach its bottom",
				);

				// One more j at the bottom edge changes nothing.
				setup.mockInput.pressKey("j");
				const afterBottom = await settle(setup);
				expect(afterBottom).toBe(atBottom);

				// The selection never moved.
				expect(markerRowOf(atBottom)).toBe(2);
			},
			60,
			10,
		);
	});

	test("q ends the app", async () => {
		// The app destroys the renderer itself, so this test does not
		// wrap the body in withApp.
		const setup = await bootApp();
		const destroyed = new Promise<boolean>((resolve) => {
			setup.renderer.once(CliRenderEvents.DESTROY, () => resolve(true));
			setTimeout(() => resolve(false), 2000).unref();
		});
		setup.mockInput.pressKey("q");
		expect(await destroyed).toBe(true);
	});

	test("the list pane window slides when the tickets overflow the pane", async () => {
		await withApp(
			async (setup) => {
				// The pane shows two rows at this height: the first two tickets
				// only. The rows carry their state and task type badges as
				// their identity, so a slide is visible in the badges even
				// where a title wraps or truncates.
				let frame = frameText(setup.captureCharFrame());
				expect(frame).toContain("[handed-off]");
				expect(frame).not.toContain("[running]");
				expect(frame).not.toContain("[awaiting]");

				// Moving the selection slides the window: each slide brings the
				// next state badge in and drops the oldest row out.
				await press(
					setup,
					"j",
					"the selection to move to the second ticket",
					(f) => markerRowOf(f) === 3,
				);
				frame = await press(
					setup,
					"j",
					"the window to keep the third ticket in view",
					(f) => frameText(f).includes("[running]") && frameText(f).includes("[handed-off]"),
				);
				expect(frame).not.toContain("[awaiting]");
				// The rows that slid in carry their task type badges.
				const rows = rowsOf(frame);
				expect(rows.find((r) => r.includes("[running]"))?.includes("[fix]")).toBe(true);
				expect(rows.find((r) => r.includes("[handed-off]"))?.includes("[implement]")).toBe(true);

				frame = await press(
					setup,
					"j",
					"the window to slide to the last tickets",
					(f) => frameText(f).includes("[awaiting]") && !frameText(f).includes("[handed-off]"),
				);
				const rows3 = rowsOf(frame);
				expect(rows3.find((r) => r.includes("[awaiting]"))?.includes("[review]")).toBe(true);
				expect(rows3.find((r) => r.includes("[running]"))?.includes("[fix]")).toBe(true);
			},
			WIDTH,
			8,
		);
	});

	test("resizing the terminal keeps the panes on the grid and the selection", async () => {
		await withApp(async (setup) => {
			// Move the selection so the resize has something to preserve.
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && markerRowOf(f) === 3,
			);
			// The badge rides on the selected row at this width.
			expect(setup.captureCharFrame()).toContain("[implement]");

			// Shrink the terminal mid-session, across a width where the badge
			// no longer fits. The new size lands in two renders: the outer
			// grid first, the panes' row geometry second. Wait on the row
			// geometry itself: in the 60-wide layout the [implement] badge
			// and the repository have dropped from the list rows, and the
			// short [fix] badge still rides.
			setup.resize(60, 12);
			const small = await awaitFrame(
				setup,
				(f) => {
					const rows = rowsOf(f);
					return (
						rows.length === 12 &&
						rows.every((row) => row.length === 60) &&
						f.includes("Tickets") &&
						f.includes("Detail") &&
						f.includes("[fix] Migrat") &&
						rows.every((row) => !listHalfOf(row).includes("[implement]")) &&
						rows.every((row) => !listHalfOf(row).includes("acme/"))
					);
				},
				"the frame to take the new size",
			);
			// Both panes and the selection survive the resize.
			expect(small).toContain("Tickets");
			expect(small).toContain("Detail");
			expect(markerRowOf(small)).toBe(3);
			// The badge drops at this width; the repository already did.
			expect(small).not.toContain("[implement]");

			// The detail pane keeps its focus, and its scroll survives.
			await press(setup, "l", "the focus to move to the detail pane", detailFocused);
			const selectedAgentRow = (frame: string) =>
				rowsOf(frame).findIndex((row) => row.includes("Agent: codex"));
			const agentBeforeScroll = selectedAgentRow(setup.captureCharFrame());
			await press(
				setup,
				"j",
				"the detail surface to translate by one row",
				(f) => selectedAgentRow(f) === agentBeforeScroll - 1,
			);
			const scrolled = await settle(setup);
			expect(detailFocused(scrolled)).toBe(true);
			expect(selectedAgentRow(scrolled)).toBe(agentBeforeScroll - 1);

			// Grow it back, waiting on the settled row geometry: the 120-wide
			// layout rides the badge and the repository in the open ticket's
			// row.
			setup.resize(120, 30);
			const large = await awaitFrame(
				setup,
				(f) =>
					rowsOf(f).length === 30 &&
					rowsOf(f).every((row) => row.length === 120) &&
					f.includes("Tickets") &&
					f.includes("Detail") &&
					f.includes("[implement] Retry policy for  acme/billing"),
				"the frame to take the original size",
			);
			expect(large).toContain("Tickets");
			expect(large).toContain("Detail");
			expect(markerRowOf(large)).toBe(3);
			expect(showsTicket(large, SAMPLE_TICKETS[1])).toBe(true);
			// The badge comes back, the focus stays, and the detail scroll
			// clamps to the window that now fits the whole ticket.
			expect(large).toContain("[implement]");
			expect(detailFocused(large)).toBe(true);
			expect(detailPaneText(large)).toContain(SAMPLE_TICKETS[1].title);
		});
	});

	test("the layout adapts to the terminal size", async () => {
		for (const [width, height] of [
			[80, 24],
			[160, 40],
		]) {
			await withApp(
				async (setup) => {
					const rows = rowsOf(setup.captureCharFrame());
					expect(rows).toHaveLength(height);
					for (const row of rows) {
						expect(row.length).toBe(width);
					}
					// Both panes and every sample state survive at this size.
					const frame = frameText(setup.captureCharFrame());
					expect(frame).toContain("Tickets");
					expect(frame).toContain("Detail");
					expectStateBadges(frame);
				},
				width,
				height,
			);
		}
	});

	test("odd terminal widths keep the row width and the pane padding intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(25);
				for (const row of rows) {
					expect(row.length).toBe(75);
				}
				// The split puts the list box on columns 0-36 and the detail
				// box on 37-74. At an odd width a "50%" list would take 38
				// columns, and the shared geometry would then lay text one
				// cell off the rendered box.
				for (const row of rows.slice(1, -3)) {
					expect(row[0]).toBe("│");
					expect(row[36]).toBe("│");
					expect(row[37]).toBe("│");
					expect(row[74]).toBe("│");
					// One cell of padding between every border and the text:
					// no text cell sits adjacent to a border.
					expect(row[1]).toBe(" ");
					expect(row[35]).toBe(" ");
					expect(row[38]).toBe(" ");
					// The detail's right padding cell is the native scrollbar
					// gutter: blank, track, or thumb.
					expect(row[73]).toMatch(/[ ▀▄█]/);
				}
				// The detail pane carries its content at this size.
				expect(frameText(setup.captureCharFrame())).toContain("Source state: open");
			},
			75,
			25,
		);
	});

	test("list rows keep the title and drop the repository when the row cannot hold both", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(12);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(60);
				}
				// At this width the row budget after the badge cannot hold
				// both the repository and a readable title. The title keeps
				// its space, and the repository drops from the list row instead
				// of pushing the title out.
				const row = rows.find((r) => r.includes("[handed-off]"));
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// badge, gap, and the title cut to the cells the row still has.
				const listHalf = (row ?? "").slice(2, 28);
				expect(listHalf).toBe("  [handed-off] Fix pan dri");
				expect(listHalf).not.toContain("acme/");
				// The repository stays reachable in the detail pane of the
				// selected ticket.
				expect(frameText(setup.captureCharFrame())).toContain("acme/billing");
			},
			60,
			12,
		);
	});

	test("narrow terminals drop fields instead of corrupting rows", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(12);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(40);
				}
				// The list row for the handed-off ticket keeps its fields in
				// order. The repository, which no longer fits, is dropped from
				// the list rows instead of interleaved into them.
				const row = rows.find((r) => r.includes("[handed-off]"));
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// marker, badge, gap, and the title cut to the two cells left.
				const listHalf = (row ?? "").slice(2, 18);
				expect(listHalf).toBe("  [handed-off] F");
				// The repository is dropped from the row, not interleaved into it.
				expect(listHalf).not.toContain("acme/");
			},
			40,
			12,
		);
	});

	test("each list row carries the task type badge between the state badge and the title", async () => {
		await withApp(async (setup) => {
			const frame = setup.captureCharFrame();
			const rows = rowsOf(frame);
			const row = (ticket: Ticket) =>
				listHalfOf(rows.find((r) => listHalfOf(r).includes(ticket.title.slice(0, 8))) as string);

			// The selected open ticket wears its suggested type, and every
			// field rides in the row's fixed order.
			const first = SAMPLE_TICKETS[0];
			expect(row(first).slice(2, 16)).toBe("❯ [open]      ");
			expect(row(first).slice(16, 27)).toBe("[implement]");
			expect(row(first).slice(27, 45)).toBe(" Retry policy for ");
			expect(row(first).slice(45, 58)).toBe(" acme/billing");

			// The non-open tickets wear the task type their handoff recorded.
			expect(row(SAMPLE_TICKETS[1]).slice(16, 27)).toBe("[implement]");
			expect(row(SAMPLE_TICKETS[2]).slice(16, 21)).toBe("[fix]");
			expect(row(SAMPLE_TICKETS[3]).slice(16, 24)).toBe("[review]");
		});
	});

	test("an open ticket wears its suggestion, not a stale handoff value", async () => {
		// A ticket that was handed off, returned, and opened again: the row
		// must describe the next handoff, not the closed one.
		const stale: Ticket = {
			...SAMPLE_TICKETS[1],
			state: "open",
			suggestedTaskType: "rework",
			handoff: {
				agentType: "pi",
				environment: "worktree",
				taskType: "review",
				model: "",
				thinking: "",
				contextWindow: "",
				attemptId: "attempt-1",
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "w-1",
			},
			handoffCount: 1,
		};
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[open]")) as string);
				expect(line).toBe("│ ❯ [open]      [rework] Fix pan drift in spli acme/portal │");
				const detail = detailPaneText(setup.captureCharFrame());
				expect(detail).toContain("Suggested task type: rework");
				expect(detail).not.toContain("Handoff task type:");
			},
			WIDTH,
			30,
			{ initialTickets: [stale] },
		);
	});

	test("a non-open ticket keeps its handoff value when the suggestion differs", async () => {
		const drifted: Ticket = { ...SAMPLE_TICKETS[3], suggestedTaskType: "implement" };
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[awaiting]")) as string);
				expect(line).toBe("│ ❯ [awaiting]  [review] Drop the legacy auth  acme/portal │");
				const detail = detailPaneText(setup.captureCharFrame());
				expect(detail).toContain("Handoff task type: review");
				expect(detail).not.toContain("Suggested task type:");
			},
			WIDTH,
			30,
			{ initialTickets: [drifted] },
		);
	});

	test("non-actionable and recovery-required open tickets keep their suggestion", async () => {
		const blocked: Ticket = {
			...SAMPLE_TICKETS[0],
			actionable: false,
			suggestedTaskType: "review",
		};
		const recovery: Ticket = {
			...SAMPLE_TICKETS[0],
			identity: "I_recovery",
			handoffRecoveryRequired: true,
			suggestedTaskType: "review",
		};
		await withApp(
			async (setup) => {
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				// Both rows wear the suggestion... and the badges are intact.
				expect(rows.filter((r) => listHalfOf(r).includes("[review]")).length).toBe(2);
				// ...and the detail says so for the selected ticket.
				expect(detailPaneText(frame)).toContain("Suggested task type: review");

				await press(setup, "j", "the selection to move to the recovery ticket", (f) =>
					detailPaneText(f).includes("Handoff: recovery required"),
				);
				const detail = detailPaneText(setup.captureCharFrame());
				expect(detail).toContain("Handoff: recovery required");
				expect(detail).toContain("Suggested task type: review");
			},
			WIDTH,
			30,
			{ initialTickets: [blocked, recovery] },
		);
	});

	test("a non-open ticket without a handoff wears the warning [unknown]", async () => {
		const orphan: Ticket = { ...SAMPLE_TICKETS[2], handoff: null };
		await withApp(
			async (setup) => {
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[unknown]")) as string);
				expect(line).toBe("│ ❯ [running]   [unknown] Migrate scheduler to acme/ingest │");
				// The missing-data badge is the only warning-colored text in
				// the row; the configured types keep the neutral style.
				expect(spanColors(setup, "[unknown]")).toEqual([rgb(COLORS.statusWarning)]);
				expect(spanColors(setup, "[running]")).toEqual([rgb(STATE_COLORS.running)]);
				// The detail carries the explicit line for the missing data.
				const detail = detailPaneText(frame);
				expect(detail).toContain("Handoff task type: unknown");
				expect(detail).not.toContain("Suggested task type:");
			},
			WIDTH,
			30,
			{ initialTickets: [orphan] },
		);
	});

	test("configured task types share one neutral badge style", async () => {
		await withApp(async (setup) => {
			const neutral = rgb(COLORS.text);
			expect(spanColors(setup, "[implement]")).toEqual([neutral]);
			expect(spanColors(setup, "[fix]")).toEqual([neutral]);
			expect(spanColors(setup, "[review]")).toEqual([neutral]);
		});
	});

	test("the badge is complete or absent as the width changes, never truncated", async () => {
		const selectedRowAt = async (width: number, height: number): Promise<string> => {
			let row = "";
			await withApp(
				async (setup) => {
					const frame = setup.captureCharFrame();
					const rows = rowsOf(frame);
					expect(rows).toHaveLength(height);
					// Every terminal row is exactly as wide as the terminal:
					// nothing wrapped or overflowed.
					for (const r of rows) {
						expect(stringWidth(r)).toBe(width);
					}
					row = listHalfOf(rows[markerRowOf(frame)]);
				},
				width,
				height,
			);
			return row;
		};

		// 120: marker, state, badge, title, and repository all ride.
		expect(await selectedRowAt(120, 30)).toBe(
			"│ ❯ [open]      [implement] Retry policy for  acme/billing │",
		);
		// 80: the badge keeps its place; the repository drops before the
		// title does.
		expect(await selectedRowAt(80, 24)).toBe("│ ❯ [open]      [implement] Retry poli │");
		// 60: the badge no longer fits beside the title minimum, so it
		// drops complete. A short type on another row still fits.
		const narrow = await selectedRowAt(60, 12);
		expect(narrow).toBe("│ ❯ [open]       Retry polic │");
		// 40: nothing but the marker and the state badge fits.
		expect(await selectedRowAt(40, 12)).toBe("│ ❯ [open]       R │");
	});

	test("the badge drops when its complete text cannot fit, and the detail keeps the value", async () => {
		await withApp(
			async (setup) => {
				// Select the handed-off ticket: its row is where the
				// [implement] badge and the title minimum do not share the 12
				// cells the row has left, so the badge drops and the title
				// keeps the cells.
				await press(setup, "j", "the selection to move to the second ticket", (f) =>
					listHalfOf(rowsOf(f).find((r) => r.startsWith("│ ❯")) as string).includes("[handed-off]"),
				);
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[handed-off]")) as string);
				expect(line).toBe("│ ❯ [handed-off] Fix pan dri │");
				expect(line).not.toContain("[implem");
				// The detail carries the full value the row dropped. Its profile
				// rows take the short viewport first, so scroll down to the Task
				// type row instead of assuming it is initially visible.
				await focusDetail(setup);
				const detail = await scrollDetailUntil(setup, "the handoff task type line", (candidate) =>
					detailPaneText(candidate, 60).includes("Handoff task type: implement"),
				);
				expect(detailPaneText(detail, 60)).toContain("Handoff task type: implement");
			},
			60,
			14,
		);
	});

	test("a long task type and wide Unicode titles keep every row exact", async () => {
		const longConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				consultation: { template: "Consult the record.", autoClose: false },
			},
		};
		const wide: Ticket = {
			...SAMPLE_TICKETS[0],
			identity: "I_wide",
			title: "中文 webhook 重试策略",
			suggestedTaskType: "consultation",
		};
		const props = { initialTickets: [wide], config: longConfig };

		await withApp(
			async (setup) => {
				// At the normal width the long badge rides complete, and the
				// wide title truncates on cell boundaries without splitting a
				// character.
				const rows = rowsOf(setup.captureCharFrame());
				for (const r of rows) {
					expect(stringWidth(r)).toBe(120);
				}
				expect(listHalfOf(rows[markerRowOf(setup.captureCharFrame())])).toBe(
					"│ ❯ [open]      [consultation] 中文 webhook   acme/billing │",
				);
				// The full value still lives in the detail pane.
				expect(detailPaneText(setup.captureCharFrame())).toContain(
					"Suggested task type: consultation",
				);
			},
			120,
			30,
			props,
		);

		await withApp(
			async (setup) => {
				// At the narrow width the long badge cannot fit complete, so
				// it drops, and the row still keeps its exact width.
				const rows = rowsOf(setup.captureCharFrame());
				for (const r of rows) {
					expect(stringWidth(r)).toBe(60);
				}
				expect(listHalfOf(rows[markerRowOf(setup.captureCharFrame())])).toBe(
					"│ ❯ [open]       中文 webhoo │",
				);
				// The detail keeps the full value the row dropped. Its profile
				// rows take the short viewport first, so scroll down to the Task
				// type row instead of assuming it is initially visible.
				await focusDetail(setup);
				await scrollDetailUntil(setup, "the suggested task type line", (candidate) =>
					detailPaneText(candidate, 60).includes("Suggested task type: consultation"),
				);
			},
			60,
			12,
			props,
		);
	});

	test("the detail pane carries one explicit task type line for every ticket", async () => {
		await withApp(async (setup) => {
			// The open ticket: the suggestion, labeled as a suggestion.
			let detail = detailPaneText(setup.captureCharFrame());
			expect(detail).toContain("Suggested task type: implement");
			expect(detail).not.toContain("Handoff task type:");

			// The handed-off ticket: the recorded value, labeled as a handoff.
			await press(setup, "j", "the selection to move to the second ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[1]),
			);
			detail = detailPaneText(setup.captureCharFrame());
			expect(detail).toContain("Handoff task type: implement");
			expect(detail).not.toContain("Suggested task type:");
		});
	});

	test("detail keyboard paging and direct edges use the native viewport", async () => {
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				const top = setup.captureCharFrame();
				const page = await press(
					setup,
					"pagedown",
					"the detail to move one viewport with context",
					(frame) => !frame.includes("Retry policy for webhooks"),
				);
				expect(page).toContain("❯ [open]");
				const end = await press(setup, "end", "the detail to reach its end", (frame) =>
					frameText(frame).includes("their retries."),
				);
				expect(end).toContain("❯ [open]");
				const home = await press(setup, "home", "the detail to return to its start", (frame) =>
					frame.includes("Retry policy for webhooks"),
				);
				setup.mockInput.pressKey("HOME");
				expect(await settle(setup)).toBe(home);
				expect(top).not.toBe(page);
			},
			60,
			12,
		);
	});

	test("list page and edge controls select tickets without a separate list scroll", async () => {
		await withApp(
			async (setup) => {
				const selectedState = (frame: string) =>
					rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "";
				await press(setup, "pagedown", "the list to move one visible page", (frame) =>
					selectedState(frame).includes("[running]"),
				);
				await press(setup, "end", "the list to select its last ticket", (frame) =>
					selectedState(frame).includes("Ticket id i"),
				);
				await press(setup, "home", "the list to select its first ticket", (frame) =>
					selectedState(frame).includes("Retry polic"),
				);
			},
			60,
			8,
		);
	});

	test("mouse input focuses and moves its Ticket surface through OpenTUI hit testing", async () => {
		await withApp(
			async (setup) => {
				// A visible list row is a direct selection target.
				await mouseClick(setup, 4, 3);
				await awaitFrame(
					setup,
					(frame) =>
						listFocused(frame) &&
						(rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "").includes("[handed-off]"),
					"the clicked Ticket to become selected",
				);
				// List wheels select exactly one adjacent Ticket. They have no
				// detail speed profile or acceleration.
				await mouseWheel(setup, 4, 3, "down");
				await awaitFrame(
					setup,
					(frame) =>
						listFocused(frame) &&
						(rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "").includes("[running]"),
					"one list wheel event to select one Ticket",
				);

				// Detail content receives a normal wheel event and takes focus.
				const before = setup.captureCharFrame();
				await mouseWheel(setup, 45, 3, "down");
				const scrolled = await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && frame !== before,
					"the detail wheel event to move its surface",
				);
				expect(markerRowOf(scrolled)).toBe(4);

				// Horizontal and Shift-wheel gestures are inert for wrapped detail text.
				const stable = setup.captureCharFrame();
				await mouseWheel(setup, 45, 3, "left");
				await mouseWheel(setup, 45, 3, "down", true);
				expect(await settle(setup)).toBe(stable);
			},
			60,
			10,
		);
	});

	test("a fitting detail reserves an empty gutter instead of a false scrollbar", async () => {
		await withApp(async (setup) => {
			const frame = setup.captureCharFrame();
			expect(frame).not.toMatch(/[▀▄█]/);
			// The final inner detail column remains blank: text uses the same
			// width before a later overflow makes the control visible.
			expect(rowsOf(frame)[2].at(-2)).toBe(" ");
		});
	});

	test("the overflowing detail has an interactive native scrollbar", async () => {
		await withApp(
			async (setup) => {
				// At this size the rightmost inner column is OpenTUI's thumb and
				// track. It is not present on a fitting detail.
				const initial = setup.captureCharFrame();
				expect(initial).toMatch(/[▀▄█]/);
				// The panes sit above the Message line and Action bar, so the
				// track spans the pane's inner rows one to four.
				await mouseClick(setup, 58, 4);
				const trackJump = await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && frame !== initial,
					"a scrollbar track click to jump to a proportional detail position",
				);
				expect(markerRowOf(trackJump)).toBe(2);
				const thumbRow = rowsOf(trackJump).findIndex((row) => /[▀▄█]/.test(row.slice(58, 59)));
				await mouseDrag(setup, [58, thumbRow], [58, 1]);
				await awaitFrame(
					setup,
					(frame) => frame.includes("Retry policy for webhooks"),
					"a scrollbar thumb drag to move toward the start",
				);
			},
			60,
			8,
		);
	});

	test("a custom Config controls fixed detail key movement", async () => {
		const config = {
			...DEFAULT_CONFIG,
			scroll: { speed: 2, acceleration: 0, maximumSpeed: 2 },
		};
		await withApp(
			async (setup) => {
				await focusDetail(setup);
				const before = agentRowOf(setup.captureCharFrame());
				await press(
					setup,
					"j",
					"the detail to move by the configured two rows",
					(frame) => agentRowOf(frame) === before - 2,
				);
			},
			60,
			10,
			{ config },
		);
	});

	test("a custom Config controls the first detail wheel step", async () => {
		const config = {
			...DEFAULT_CONFIG,
			scroll: { speed: 2, acceleration: 0, maximumSpeed: 2 },
		};
		await withApp(
			async (setup) => {
				const before = agentRowOf(setup.captureCharFrame());
				await mouseWheel(setup, 45, 3, "down");
				await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && agentRowOf(frame) === before - 2,
					"the configured linear wheel step to move two rows",
				);
			},
			60,
			10,
			{ config },
		);
	});

	test("a timed wheel burst accelerates the visible native detail surface", async () => {
		await withApp(
			async (setup) => {
				const wheelAt = async (now: number) => {
					const clock = vi.spyOn(Date, "now").mockReturnValue(now);
					try {
						await mouseWheel(setup, 45, 3, "down");
					} finally {
						clock.mockRestore();
					}
				};
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(1_000);
				await awaitFrame(
					setup,
					(frame) => detailFocused(frame) && agentRowOf(frame) === start - 1,
					"the precise first wheel step",
				);
				await wheelAt(1_050);
				await awaitFrame(
					setup,
					(frame) => agentRowOf(frame) === start - 3,
					"the accelerated second wheel step",
				);
			},
			60,
			10,
		);
	});

	test("rapid detail input records only complete native terminal frames", async () => {
		const config = {
			...DEFAULT_CONFIG,
			scroll: { speed: 1, acceleration: 0, maximumSpeed: 1 },
		};
		await withApp(
			async (setup) => {
				const frames: string[] = [];
				const record = () => frames.push(setup.captureCharFrame());
				setup.renderer.on(CliRenderEvents.FRAME, record);
				try {
					for (let event = 0; event < 10; event += 1) {
						await mouseWheel(setup, 45, 3, "down");
					}
					await sleep(80);
				} finally {
					setup.renderer.off(CliRenderEvents.FRAME, record);
				}
				expect(frames.length).toBeGreaterThan(0);
				for (const frame of frames) {
					const rows = rowsOf(frame);
					expect(rows).toHaveLength(10);
					expect(rows.every((row) => row.length === 60)).toBe(true);
					expect(rows[0]).toContain("┌");
					// The panes sit above the Message line and Action bar.
					expect(rows.at(-3)).toContain("└");
					expect(detailPaneText(frame, 60).trim()).not.toBe("");
				}
			},
			60,
			10,
			{ config },
		);
	});

	test("mouse input below an open modal leaves both Ticket surfaces inert", async () => {
		await withApp(
			async (setup) => {
				await openPanel(setup);
				const before = setup.captureCharFrame();
				await mouseWheel(setup, 45, 3, "down");
				await mouseClick(setup, 4, 3);
				expect(await settle(setup)).toBe(before);
			},
			60,
			8,
		);
	});

	test("the Key guide the app opens lists the mode's controls above the global ones", async () => {
		// The operator's own path: the app's key handler opens the guide, and
		// the ordering the app computes is the ordering on screen. A hint
		// priority that moves reorders these rows.
		const state = openFactoryState(":memory:");
		try {
			await withApp(
				async (setup) => {
					const frame = await press(setup, "?", "the Key guide", (candidate) =>
						candidate.includes("Key guide"),
					);
					// The guide opens on this mode's section, and the sections
					// keep the catalogue's order on screen. A hint priority
					// that moves reorders these rows.
					const rows = rowsOf(frame);
					const indexOf = (needle: string) => rows.findIndex((row) => row.includes(needle));
					const modeIdx = indexOf("Current interaction mode");
					const globalIdx = indexOf("Global controls");
					const controlPlaneIdx = indexOf("Control plane controls");
					expect(modeIdx).toBeGreaterThan(0);
					expect(globalIdx).toBeGreaterThan(modeIdx);
					expect(controlPlaneIdx).toBeGreaterThan(globalIdx);
					const modeSection = rows.slice(modeIdx, globalIdx).join("\n");
					expect(modeSection).toContain("Move");
					expect(modeSection).toContain("Hand off");
					// The three meanings of Enter each keep their own row.
					expect(modeSection).toContain("Live view");
					expect(modeSection).toContain("Decide");
					const globalSection = rows.slice(globalIdx, controlPlaneIdx).join("\n");
					expect(globalSection).toContain("Quit");
					// Closing the guide returns to the tickets view.
					setup.mockInput.pressEscape();
					await awaitFrame(
						setup,
						(candidate) => !candidate.includes("Key guide"),
						"the Key guide to close",
					);
				},
				WIDTH,
				30,
				{ state },
			);
		} finally {
			state.close();
		}
	});

	test("tiny terminals stay intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(8);
				for (const row of rows) {
					expect(row.length).toBe(8);
				}
			},
			8,
			8,
		);
	});
});
