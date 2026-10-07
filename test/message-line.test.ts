/**
 * The permanent Message line and the Message view behind it.
 *
 * The line sits between the panes and the Action bar in every frame, and the
 * frame never shifts for or against it. Facts stay separate behind it: an
 * operation error, a working, an operation warning, and the source-health
 * warning, in that priority. Messages truncate to the terminal width, and the
 * record behind them earns the m Message hint as soon as it holds a fact
 * (ADR 0119): the view is a near-fullscreen record of the run's facts, oldest
 * first, pinned to the newest, each entry wearing its datetime and its
 * severity chip. Progress lines never enter the record.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { padToWidth, truncateToWidth, widthOf } from "../src/components/text.ts";
import {
	actionBarRowOf,
	awaitFrame,
	closeOverlay,
	frameText,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	openGuide,
	openLauncher,
	openMessageView,
	press,
	pressArrow,
	rgb,
	roleColor,
	rowsOf,
	settle,
	spanColorAt,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { DelayedRunner } from "./delayed-runner.ts";
import {
	agentListJson,
	FakeRunner,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import {
	callsReached,
	cleanupStateFixtures,
	freshState,
	issuesConfig,
	issueTicket,
	RATE_LIMITED,
	seedAwaitingTurn,
	success,
} from "./state-fixture.ts";

afterEach(() => {
	cleanupStateFixtures();
	rmSync(home, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "factory-message-line-"));

function stubCheckout(runner: FakeRunner): void {
	const path = join(home, "src", "billing");
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** The failing-handoff stubs: the handoff dies on its workspace list. */
function failingHandoffRunner(): FakeRunner {
	const runner = new FakeRunner();
	stubCheckout(runner);
	runner.set("herdr", ["workspace", "list"], {
		code: 1,
		stderr: "error: the daemon is down\n",
	});
	return runner;
}

/** The notification commands the runner recorded, whatever the platform. */
function notificationCalls(runner: FakeRunner): string[] {
	return runner.calls
		.filter(
			(call) =>
				call.command === "notify-send" ||
				call.command === "osascript" ||
				call.command === "powershell",
		)
		.map((call) => call.args.join(" "));
}

/** The history entries one chip wears in a Message view frame. */
function historyEntries(view: string, chip: "INFO" | "WARN" | "ERROR"): number {
	const face = new RegExp(`\\d{2}:\\d{2}:\\d{2} ${chip} `);
	return view.split("\n").filter((row) => face.test(row)).length;
}

/** A handoff that fails on a deliberately long stderr line. */
const LONG_LINE = `error: the daemon refused the request after the outage. ${"x".repeat(240)}`;

function longLineHandoffRunner(): FakeRunner {
	const runner = new FakeRunner();
	stubCheckout(runner);
	runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${LONG_LINE}\n` });
	return runner;
}

const WORKING_TICKET = {
	...SAMPLE_TICKETS[0],
	identity: "local:1",
	title: `Drop the legacy auth shim after the ${"m".repeat(140)} migration`,
};

describe("the permanent Message line", () => {
	test("never shifts the layout for or against it", async () => {
		await withApp(
			async (setup) => {
				const before = await settle(setup);
				expect(actionBarRowOf(before)).not.toContain("m Message");
				// An unavailable refresh explains itself on the line.
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				const frame = await settle(setup);
				// The fact is recorded, so the Message hint lands on the row the bar
				// always wears: the layout never shifts for or against the line, and
				// the marker never moves for the hint or the fact it names.
				expect(markerRowOf(frame)).toBe(markerRowOf(before));
				expect(actionBarRowOf(frame)).toContain("m Message");
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
				// Changing auto-handoff is not an operation. It must not clear the
				// durable warning that the rejected refresh produced.
				setup.mockInput.pressKey("a");
				expect(messageRowOf(await settle(setup)).trim()).toBe("Warning: no Ticket sources exist");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("wears the severity prefix, and only the line wears the color", async () => {
		// Warning.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) => messageRowOf(f).startsWith("Warning: "));
				const frame = await settle(setup);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
				expect(spanColorAt(setup, row, "Warning:")).toEqual(rgb(roleColor("yellow")));
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// A refused refresh warns on the line. A source app needs state to
		// own the refresh coordinator at all.
		const refused = new FakeSource("issues", "github-issues", success([issueTicket()]));
		await withApp(
			async (setup) => {
				// While the first fetch runs, a refresh is refused on the line.
				await press(setup, "r", "the refusal", (f) =>
					messageRowOf(f).includes("every Ticket source is already refreshing"),
				);
				const frame = await settle(setup);
				expect(messageRowOf(frame).trim()).toBe(
					"Warning: every Ticket source is already refreshing",
				);
				refused.settle(success([issueTicket()]));
			},
			WIDTH,
			HEIGHT,
			{ config: issuesConfig, state: freshState(), sources: [refused] },
		);

		// Working.
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		await withApp(
			async (setup) => {
				source.settle(success([issueTicket()]));
				await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
				// A manual refresh shows its working, and settles back to clear.
				await press(setup, "r", "the working", (f) =>
					messageRowOf(f).includes("refreshing 1 sources"),
				);
				const frame = await settle(setup);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Working: refreshing 1 sources");
				expect(spanColorAt(setup, row, "Working:")).toEqual(rgb(roleColor("blue")));
				source.settle(success([issueTicket()]));
				await awaitFrame(setup, (f) => messageRowOf(f).trim() === "", "the working to clear");
			},
			WIDTH,
			HEIGHT,
			{ config: issuesConfig, state: freshState(), sources: [source] },
		);

		// Error.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				const frame = await settle(setup);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Error: error: the daemon is down");
				expect(spanColorAt(setup, row, "Error:")).toEqual(rgb(roleColor("red")));
			},
			WIDTH,
			HEIGHT,
			{
				config: BASE_CONFIG,
				runner: failingHandoffRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("lets an error cover its own working", async () => {
		const runner = new DelayedRunner(failingHandoffRunner(), 1500);
		await withApp(
			async (setup) => {
				await press(setup, "return", "the working", (f) =>
					messageRowOf(f).startsWith("Working: handing off"),
				);
				// The failure lands after the delay: the error covers the working.
				await awaitFrame(setup, (f) => messageRowOf(f).startsWith("Error: "), "the error", 8000);
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					"Error: error: the daemon is down",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("lets a manual refresh cover a stale source, and the warning return", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// A failed refresh leaves the source stale: the line warns.
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					source.settle(RATE_LIMITED);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the stale warning",
					);
					// A new refresh covers the warning with its working.
					await press(setup, "r", "the working", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					await callsReached(source, 3);
					source.settle(RATE_LIMITED);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the warning to return",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The source warnings' channel: a refresh that absorbs a peripheral
	 * failure says so once, and the line carries the sentence. ADR 0050
	 * retired the referenced-issue read that first used it; the security
	 * sources still write it, when a repository has the feed's feature off
	 * (the reason the live case below carries).
	 */
	test("surfaces a source refresh's absorbed failure as one warning on the line", async () => {
		const state = freshState();
		const source = new FakeSource("pulls", "github-pull-requests", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					// The first refresh settles cleanly.
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// The next refresh absorbs one feed's failure: the source still
					// succeeds, and its one warning line surfaces on the line.
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					const disabled = "Dependabot alerts are disabled for acme/factory";
					source.settle({
						status: "success",
						fetchedAt: "2026-08-31T10:02:00Z",
						tickets: [issueTicket()],
						warnings: [disabled],
					});
					const frame = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("Dependabot alerts are disabled for"),
						"the warning",
					);
					expect(messageRowOf(frame).trim()).toBe(`Warning: ${disabled}`);
					source.settle(success([issueTicket()]));
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("runs the facts in priority order, and covered warnings return", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		const inner = new FakeRunner();
		stubCheckout(inner);
		inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		inner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: "error: the daemon is down\n",
		});
		// Delay every command call: the handoff must stay in flight long
		// enough for its Working line to be read.
		const runner = new DelayedRunner(inner, 1200, Number.POSITIVE_INFINITY);
		try {
			await withApp(
				async (setup) => {
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// The in-flight handoff's working.
					await press(setup, "return", "the handoff working", (f) =>
						messageRowOf(f).startsWith("Working: handing off"),
					);
					// Its pickup fails: the item drops with the warning that names
					// the operation and the reason (ADR 0049), covering the working.
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).startsWith("Warning: queued handoff"),
						"the handoff drop warning",
						15000,
					);
					expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
						'Warning: queued handoff for "Add a webhook retry policy" was not run: error: the daemon is down',
					);
					// A new operation replaces the error with its own working.
					await press(setup, "r", "the refresh working", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					await callsReached(source, 2);
					source.settle(RATE_LIMITED);
					// The refresh working cleared: the stale source's warning returns.
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the source-health warning",
					);
					// A second refresh: its working covers the stale health.
					await press(setup, "r", "the second refresh", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					// A refused refresh while that one runs: the refusal is an
					// operation Warning, and active progress outranks it
					// (user story 51), so the Working line stays.
					await press(setup, "r", "the refused refresh", (f) => {
						const row = messageRowOf(f);
						return row.includes("already refreshing") || row.includes("refreshing 1 sources");
					});
					expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
						"Working: refreshing 1 sources",
					);
					await callsReached(source, 3);
					source.settle(RATE_LIMITED);
					// The progress clears with the refresh: the refusal returns,
					// and it outranks the source-health warning (story 52).
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).trim() === "Warning: every Ticket source is already refreshing",
						"the refusal after the refresh",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source], runner },
			);
		} finally {
			state.close();
		}
	});

	test("leaves an in-flight refresh's progress to the refresh that owns it", async () => {
		const state = freshState();
		// The fixture Ticket ends its turn and awaits its decision, with the
		// herdr handles the decision's actions read from stored against it.
		seedAwaitingTurn(state, success([issueTicket()]));
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// The cycle-end draft close reads the branch's open pull requests:
		// the branch carries none, so the close says nothing, and the line
		// keeps the in-flight refresh's progress.
		runner.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/acme/factory/pulls?state=open&head=${encodeURIComponent(
					"acme:factory/5-add-a-webhook-retry-policy",
				)}`,
			],
			{ stdout: "[]" },
		);
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					// The boot fetch has to land before the test asks for its own.
					await callsReached(source, 1);
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("[awaiting]"), "the awaiting ticket");
					await settle(setup);
					// A manual refresh is in flight, and its progress owns the line.
					await press(setup, "r", "the working", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					// Close ends the decision's outcome. It writes no progress line of
					// its own, so it clears nothing another operation still runs.
					await press(setup, "return", "the decision", (f) => f.includes("Decision:"));
					await press(setup, "return", "the Close to run", (f) => !f.includes("Decision:"));
					expect(messageRowOf(await settle(setup)).trim()).toBe("Working: refreshing 1 sources");
					// The refresh settles, and only then does its line clear.
					source.settle(success([issueTicket()]));
					await awaitFrame(
						setup,
						(f) => !messageRowOf(f).includes("refreshing 1 sources"),
						"the working to clear",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source], runner },
			);
		} finally {
			state.close();
		}
	});

	test("truncates to the terminal width, and offers the view once a fact is recorded", async () => {
		// The line is cut at the terminal edge, and the fact earns the hint.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				const frame = await settle(setup);
				const expected = padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, WIDTH), WIDTH);
				expect(messageRowOf(frame)).toBe(expected);
				expect(actionBarRowOf(frame)).toContain("m Message");
				// The view holds the whole fact the line cut: the entry wraps the
				// text, and it leads with its datetime and its chip.
				const view = await openMessageView(setup, "m", "Message view");
				expect(view).toContain("the daemon refused the request after the outage");
				expect(view).toContain("ERROR");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// A fact that fits on the line still earns the view: the record is the
		// point, not the cut.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(actionBarRowOf(await settle(setup))).toContain("m Message");
				const view = await openMessageView(setup, "m", "Message view");
				expect(view).toContain("WARN");
				expect(view).toContain("no Ticket sources exist");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// No fact at all: the control refuses on the line, and the record stays
		// what the record is.
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("m");
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).trim() === "Warning: no message has been recorded yet",
					"the refusal on the line",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("F2 opens the view from inside a field, and the field keeps its work", async () => {
		await withApp(
			async (setup) => {
				// A truncated error on the line: the view has text to hold.
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				// The launcher's Draft field holds the keys, and F2 is the field mode's
				// own alias: the view opens from inside the field, not only from the
				// base panes.
				await openLauncher(setup);
				setup.mockInput.pressTab();
				setup.mockInput.pressTab();
				await awaitFrame(setup, (f) => f.includes("❯ Initial input"), "the draft field");
				await setup.mockInput.typeText("draft before the view");
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right", { shift: true });
				setup.mockInput.pressArrow("right", { shift: true });
				const view = await openMessageView(setup, "F2", "Message view");
				expect(view).toContain("the daemon refused the request after the outage");
				await closeOverlay(setup, "Message view", "the view to close");
				// The field kept the text, the caret, and the selection: asking to read
				// a Message changed nothing about the operator's work.
				setup.mockInput.pressKey("q");
				await awaitFrame(
					setup,
					(f) => f.includes("qaft before the view"),
					"the typed character to replace the selection",
				);
			},
			WIDTH,
			HEIGHT,
			{
				config: {
					...BASE_CONFIG,
					consultationTypes: {
						grill: { agent: "claude", environment: "live-worktree", template: "/grill {input}" },
					},
				},
				runner: longLineHandoffRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("the working is no fact, and the record shows the turn it covered", async () => {
		const runner = new DelayedRunner(failingHandoffRunner(), 2500);
		await withApp(
			async (setup) => {
				await press(setup, "return", "the working", (f) =>
					messageRowOf(f).startsWith("Working: handing off"),
				);
				// The working is progress, not a fact: while it runs the record
				// holds nothing, and the refusal to open waits behind the working
				// line, where a refusal ranks. The failure settles behind the
				// working and takes the line from it.
				setup.mockInput.pressKey("m");
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).trim() === "Error: error: the daemon is down",
					"the error to take the line",
				);
				// The record holds the refusal and the error, and no Working line
				// of the handoff: progress was never a fact.
				const view = await openMessageView(setup, "m", "Message view");
				expect(view).toContain("no message has been recorded yet");
				expect(view).toContain("the daemon is down");
				expect(view).not.toContain("handing off");
				// The record is oldest first: the refusal stands above the error.
				const rows = view.split("\n");
				const refusalRow = rows.findIndex((row) =>
					row.includes("no message has been recorded yet"),
				);
				const errorRow = rows.findIndex((row) => row.includes("the daemon is down"));
				expect(refusalRow).toBeGreaterThan(-1);
				expect(errorRow).toBeGreaterThan(refusalRow);
				// The view's own Message line carries the fact that landed, the
				// way every surface's line does.
				expect(view).toContain("Error: error: the daemon is down");
				// And the base frame behind it says the same.
				await closeOverlay(setup, "Message view", "the view to close");
				expect(messageRowOf(await settle(setup)).trim()).toBe("Error: error: the daemon is down");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: [WORKING_TICKET] },
		);
	});

	test("states a plain notice, and lets a refusal take the line back", async () => {
		await withApp(
			async (setup) => {
				// The mode is factory state, not a config default (ADR 0036): the
				// operator's `a` key is the only way onto it. A plane with no state
				// draws no mode cell, so the flip is not visible here; the notice it
				// produces is what this test reads.
				setup.mockInput.pressKey("a");
				await settle(setup);
				for (const row of [4, 5, 6]) {
					await press(setup, "j", "the next ticket", (f) => markerRowOf(f) === row);
				}
				// Enter belongs to the factory in auto mode. The fact says so with
				// the plain info the record wears: no operation failed, so the line
				// carries no warning's word.
				await press(setup, "return", "the notice", (f) =>
					messageRowOf(f).includes("the factory decides this ticket"),
				);
				const notice = await settle(setup);
				expect(messageRowOf(notice).trim()).toBe(
					"Info: auto-handoff is on: the factory decides this ticket",
				);
				expect(messageRowOf(notice)).not.toContain("Working:");
				expect(spanColorAt(setup, rowsOf(notice).length - 2, "Info:")).toEqual(
					rgb(roleColor("text")),
				);
				// The notice is a fact the record holds: the view shows it, beside
				// its chip.
				const view = await openMessageView(setup, "F2", "Message view");
				expect(view).toContain("INFO");
				expect(view).toContain("the factory decides this ticket");
				await closeOverlay(setup, "Message view", "the view to close");
				// The notice must not pin the line: a refused control takes it
				// back, the way every operation fact outranks a notice.
				setup.mockInput.pressKey("r");
				const refused = await awaitFrame(
					setup,
					(f) => messageRowOf(f).trim() === "Warning: no Ticket sources exist",
					"the refusal to take the line back",
				);
				expect(refused).not.toContain("auto-handoff is on");
			},
			WIDTH,
			HEIGHT,
			{
				config: BASE_CONFIG,
				runner: new FakeRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("wraps, scrolls with a range, and closes on Esc and F2", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		const line = `error: the daemon refused the request after the outage. ${"x".repeat(2000)}`;
		runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${line}\n` });
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				const frame = await openMessageView(setup, "F2", "Message view");
				// The entry wraps to more rows than the pane shows: the bar's range
				// says so, and the view opens pinned to the newest row of the
				// record, the bottom of the record's one entry.
				const rangeOf = (f: string): number[] | null => {
					const match = f.match(/(\d+)-(\d+)\/(\d+)/);
					return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
				};
				const range = rangeOf(frame);
				expect(range).not.toBeNull();
				if (range === null) return;
				const [top, bottom, total] = range;
				const visible = bottom - top + 1;
				expect(bottom).toBe(total);
				// The gutter holds the scrollbar the record needs: every row of
				// the window wears the track or the thumb, the thumb standing
				// on the rows the position covers, the way the Decision
				// modal's turn log paints it.
				// The gutter holds the scrollbar the record needs: the body's
				// last column, the pane's border and the box's border standing to
				// its right. Every row of the window wears the track, and the
				// thumb stands on the rows the position covers, the way the
				// Decision modal's turn log paints it.
				const trimmed = frame.split("\n").map((row) => row.trimEnd());
				const thumb = trimmed.filter((row) => row.endsWith("█ │ │")).length;
				const track = trimmed.filter((row) => row.endsWith("│ │ │")).length;
				expect(thumb + track).toBe(visible);
				expect(thumb).toBeGreaterThanOrEqual(1);
				// k steps up one row of the record, and j returns to the bottom.
				await press(setup, "k", "the scroll up", (f) =>
					f.includes(`${top - 1}-${bottom - 1}/${total}`),
				);
				await press(setup, "j", "the scroll down", (f) => f.includes(`${top}-${bottom}/${total}`));
				// home takes the record's first row.
				await press(setup, "home", "the jump to the top", (f) =>
					f.includes(`1-${visible}/${total}`),
				);
				// Esc closes; the error is back on the base line.
				await closeOverlay(setup, "Message view", "the view to close");
				expect(messageRowOf(await settle(setup))).toContain("the daemon refused");
				// F2 closes too.
				await openMessageView(setup, "F2", "Message view");
				await closeOverlay(setup, "Message view", "the view to close", "F2");
				expect(messageRowOf(setup.captureCharFrame())).toContain("the daemon refused");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("its bar names the Close control down to one whole key", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${LONG_LINE}\n` });
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				await openMessageView(setup, "F2", "Message view");
				// The view's Close owns the row's end cells, so a frame that
				// cannot hold the hint states one whole key instead. It never
				// states part of a key, and only falls silent where no key of
				// this control fits at all (user stories 66 and 73). The bar row is
				// the one inside the frame that states the Close's key, above the
				// frame's bottom border.
				const barRowOf = (rows: string[]) =>
					rows.find((row) => /Esc|F2|Close/.test(row))?.trim() ?? "";
				for (let width = 20; width >= 1; width -= 1) {
					setup.resize(width, 8);
					const rows = rowsOf(await settle(setup));
					for (const row of rows) expect(widthOf(row)).toBe(width);
					const bar = barRowOf(rows);
					if (width >= 12) expect(bar).toContain("Esc/F2 Close");
					else if (width >= 3) expect(bar).toContain("Esc");
					else if (width === 2) expect(bar).toContain("F2");
					else expect(bar).toBe("");
				}
				// The row is the surface's own again at a usable width.
				setup.resize(30, 8);
				await awaitFrame(
					setup,
					(f) => barRowOf(rowsOf(f)).includes("Esc/F2 Close"),
					"the view's full Close hint",
				);
				await closeOverlay(setup, "Message view", "the view to close");
				expect(actionBarRowOf(await settle(setup))).toContain("Help");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("hands the keys to the Key guide on F1 and ?", async () => {
		// F1.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				await openMessageView(setup, "m", "Message view");
				await openGuide(setup, "F1", "Key guide - Ticket list");
				await closeOverlay(setup, "Key guide", "the guide to close");
				// The view closed with the guide: the base holds the truncated error.
				expect(messageRowOf(await settle(setup)).trim()).toBe(
					truncateToWidth(`Error: ${LONG_LINE}`, WIDTH),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// Question mark.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				await openMessageView(setup, "m", "Message view");
				await openGuide(setup, "?", "Key guide - Ticket list");
				await closeOverlay(setup, "Key guide", "the guide to close");
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					truncateToWidth(`Error: ${LONG_LINE}`, WIDTH),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("stays visible in the below-minimum frame, with the important line for errors", async () => {
		// Error: the compact frame keeps the line twice - the important one in
		// the box, the full one in the permanent row.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				setup.resize(25, 10);
				const rows = rowsOf(await settle(setup));
				expect(rows[1]).toContain("Terminal too small");
				expect(rows[2].trim()).toBe(truncateToWidth(`Error: ${LONG_LINE}`, 23));
				expect(rows[8]).toBe(padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, 25), 25));
				expect(rows[9].trim()).toBe("? Help");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// Warning: no important line - warnings are not important below the
		// minimum, the permanent row carries them.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				setup.resize(25, 10);
				const rows = rowsOf(await settle(setup));
				expect(rows[1]).toContain("Terminal too small");
				expect(rows[2].trim()).toBe("");
				expect(rows[8]).toBe(
					padToWidth(truncateToWidth("Warning: no Ticket sources exist", 25), 25),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("survives a resize across the minimum", async () => {
		// Warning round trip.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				setup.resize(30, 10);
				expect(messageRowOf(await settle(setup))).toBe(
					padToWidth(truncateToWidth("Warning: no Ticket sources exist", 30), 30),
				);
				setup.resize(WIDTH, HEIGHT);
				expect(messageRowOf(await settle(setup))).toContain("no Ticket sources exist");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// Error round trip: the truncation and the hint return with the width.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				setup.resize(30, 10);
				expect(messageRowOf(await settle(setup))).toBe(
					padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, 30), 30),
				);
				setup.resize(WIDTH, HEIGHT);
				const frame = await settle(setup);
				expect(messageRowOf(frame)).toBe(
					padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, WIDTH), WIDTH),
				);
				expect(actionBarRowOf(frame)).toContain("m Message");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the queue's own words stand on the line, in the queue's own place", async () => {
		// The one-seat config runs the first start, and holds the second in
		// the Work queue while the seat stays full. The queue's lines are the
		// module's facts read back on the Message line: the enqueue's notice
		// says where the start waits, the queue's Delete says where it went,
		// and the pickup's notice says where it ran.
		const cappedConfig = { ...issuesConfig, maxParallelAgents: 1 };
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		// The fake herdr answers every command with no body; the workspace
		// list the pickup asks needs its JSON, or the start fails on the
		// unreadable answer the queue line would not carry.
		const runner = new FakeRunner();
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.setDefault({ stdout: workspaceCreateJson("ws-1") });
		try {
			await withApp(
				async (setup) => {
					// Two open tickets: the first takes the seat, the second
					// waits behind it in the queue.
					const secondTicket = issueTicket("github:github.com:I_6", {
						title: "Keep tickets across starts",
					});
					source.settle(success([issueTicket(), secondTicket]));
					await awaitFrame(
						setup,
						(f) => rowsOf(f).some((row) => row.includes("Keep tickets acro")),
						"the second ticket",
					);
					await press(setup, "return", "the first start", (f) =>
						messageRowOf(f).includes("started from the Work queue"),
					);
					// The queue takes the second start while the seat stays
					// full, and its notice stands on the line.
					await pressArrow(setup, "down", "the cursor to the second ticket", (f) =>
						rowsOf(f).some((row) => row.includes("Keep tickets acro")),
					);
					const queued = await press(setup, "return", "the second start", (f) =>
						messageRowOf(f).includes("is in the Work queue; it starts when a seat frees"),
					);
					expect(frameText(queued)).toContain("waiting: 1");
					// The queue's Delete removes the item, and its own words
					// stand on the line.
					await press(setup, "return", "the queue-jump to the item", (f) =>
						f.includes("┌─❯ Work queue"),
					);
					await press(setup, "delete", "the item removed", (f) =>
						messageRowOf(f).includes("was removed"),
					);
					const frame = await settle(setup);
					expect(messageRowOf(frame)).toContain(
						`the waiting start for "Keep tickets across starts" was removed`,
					);
					expect(frameText(frame)).toContain("waiting: 0");
				},
				WIDTH,
				HEIGHT,
				{ config: cappedConfig, state, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("records the source health at the change, stays silent while it stands, and names the recovery", async () => {
		const state = freshState();
		const runner = new FakeRunner();
		// The observation loop's own read stays hermetic, the way the
		// notification's tests do: a readable agent list, so its only fact
		// is the one with no state change at all.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					// The boot's own refresh settles clean.
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// A source that goes stale lands one warning entry and one
					// notification, at the change.
					await press(setup, "r", "the working", (f) => f.includes("refreshing 1 sources"));
					await callsReached(source, 2);
					source.settle(RATE_LIMITED);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the stale warning",
					);
					const sent = notificationCalls(runner);
					expect(sent).toHaveLength(1);
					expect(sent[0]).toContain("issues: stale - GitHub rate limit exceeded");
					const changed = await openMessageView(setup, "m", "Message view");
					expect(historyEntries(changed, "WARN")).toBe(1);
					expect(historyEntries(changed, "INFO")).toBe(0);
					await closeOverlay(setup, "Message view", "the view to close");
					// The next refresh fails on the same standing fact: the source
					// stays stale, so no second entry and no second send.
					await press(setup, "r", "the working", (f) => f.includes("refreshing 1 sources"));
					await callsReached(source, 3);
					source.settle(RATE_LIMITED);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the standing stale warning",
					);
					expect(notificationCalls(runner)).toHaveLength(1);
					const standing = await openMessageView(setup, "m", "Message view");
					expect(historyEntries(standing, "WARN")).toBe(1);
					expect(historyEntries(standing, "INFO")).toBe(0);
					await closeOverlay(setup, "Message view", "the view to close");
					// A clean refresh recovers the source: one info entry names
					// the recovery, and the info fact sends no notification.
					await press(setup, "r", "the working", (f) => f.includes("refreshing 1 sources"));
					await callsReached(source, 4);
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => messageRowOf(f).trim() === "", "the line to clear");
					expect(notificationCalls(runner)).toHaveLength(1);
					const healed = await openMessageView(setup, "m", "Message view");
					expect(historyEntries(healed, "WARN")).toBe(1);
					expect(historyEntries(healed, "INFO")).toBe(1);
					expect(healed).toContain("issues: recovered");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source], runner },
			);
		} finally {
			state.close();
		}
	});

	test("is silent for scheduled refreshes, and warns on a failed fetch", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					// The scheduled fetch runs silent: the list loads, the line stays clear.
					await awaitFrame(setup, (f) => f.includes("loading tickets..."), "the loading list");
					expect(messageRowOf(setup.captureCharFrame()).trim()).toBe("");
					// A failed fetch warns in the source's own words.
					source.settle(RATE_LIMITED);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the stale warning",
					);
					// A successful refresh heals the source and clears the line.
					await press(setup, "r", "the working", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					await callsReached(source, 2);
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => messageRowOf(f).trim() === "", "the line to clear");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});
});
