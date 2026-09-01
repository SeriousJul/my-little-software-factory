/**
 * The permanent Message line and the Message view behind it.
 *
 * The line sits between the panes and the Action bar in every frame, and the
 * frame never shifts for or against it. Facts stay separate behind it: an
 * operation error, a working, an operation warning, and the source-health
 * warning, in that priority. Long messages truncate to the terminal width
 * and only then earn the m Message hint and the view, which holds the text
 * it opened with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { COLORS } from "../src/components/theme.ts";
import { padToWidth, truncateToWidth } from "../src/components/text.ts";
import {
	actionBarRowOf,
	awaitFrame,
	markerRowOf,
	messageRowOf,
	press,
	pressF1,
	pressF2,
	rgb,
	rowsOf,
	settle,
	sleep,
	spanColorAt,
	HEIGHT,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { DelayedRunner } from "./delayed-runner.ts";
import { FakeRunner, agentListJson } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import {
	callsReached,
	cleanupStateFixtures,
	freshState,
	issueTicket,
	issuesConfig,
	RATE_LIMITED,
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
				// An unavailable refresh explains itself on the line.
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				const frame = await settle(setup);
				expect(markerRowOf(frame)).toBe(markerRowOf(before));
				expect(actionBarRowOf(frame)).toBe(actionBarRowOf(before));
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("wears the severity prefix, and only the line wears the color", async () => {
		// Warning.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).startsWith("Warning: "),
				);
				const frame = await settle(setup);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
				expect(spanColorAt(setup, row, "Warning:")).toEqual(rgb(COLORS.statusWarning));
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
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
				expect(spanColorAt(setup, row, "Working:")).toEqual(rgb(COLORS.statusWorking));
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
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				const frame = await settle(setup);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Error: error: the daemon is down");
				expect(spanColorAt(setup, row, "Error:")).toEqual(rgb(COLORS.statusError));
			},
			WIDTH,
			HEIGHT,
			{
				config: DEFAULT_CONFIG,
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
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).startsWith("Error: "),
					"the error",
					8000,
				);
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					"Error: error: the daemon is down",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	}, 20000);

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
						(f) =>
							messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
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
						(f) =>
							messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
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
					// Its failure becomes the error, covering the working.
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).startsWith("Error: "),
						"the handoff error",
						15000,
					);
					expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
						"Error: error: the daemon is down",
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
					// A refused refresh sets an operation warning, covering it.
					await press(setup, "r", "the second refresh", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					await press(setup, "r", "the refusal", (f) =>
						messageRowOf(f).includes("every Ticket source is already refreshing"),
					);
					await callsReached(source, 3);
					source.settle(RATE_LIMITED);
					// The operation warning survives the settle: it covers the health one.
					expect(messageRowOf(await settle(setup)).trim()).toBe(
						"Warning: every Ticket source is already refreshing",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source], runner },
			);
		} finally {
			state.close();
		}
	}, 30000);

	test("truncates to the terminal width, and only then offers the Message view", async () => {
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				const frame = await settle(setup);
				const expected = padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, WIDTH), WIDTH);
				expect(messageRowOf(frame)).toBe(expected);
				expect(actionBarRowOf(frame)).toContain("m Message");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// A fitting message earns no hint.
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(actionBarRowOf(await settle(setup))).not.toContain("m Message");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the view holds the text it opened with, across a working-to-error turn", async () => {
		const runner = new DelayedRunner(failingHandoffRunner(), 2500);
		await withApp(
			async (setup) => {
				await press(setup, "return", "the working", (f) =>
					messageRowOf(f).startsWith("Working: handing off"),
				);
				// The truncated working earns the view.
				await press(setup, "m", "the message view", (f) =>
					f.includes("Message view - Working"),
				);
				// The failure lands while the view is open.
				await sleep(4000);
				const frame = await settle(setup);
				expect(frame).toContain("Message view - Working");
				expect(frame).toContain("handing off");
				expect(frame).not.toContain("the daemon is down");
				// The base turned to the error behind the view.
				await press(setup, "escape", "the view to close", (f) =>
					!f.includes("Message view"),
				);
				expect(messageRowOf(await settle(setup)).trim()).toBe(
					"Error: error: the daemon is down",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: [WORKING_TICKET] },
		);
	}, 20000);

	test("wraps, scrolls with a range, and closes on Esc and F2", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		const line = `error: the daemon refused the request after the outage. ${"x".repeat(2000)}`;
		runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${line}\n` });
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				pressF2(setup);
				await awaitFrame(setup, (f) => f.includes("Message view - Error"), "the view");
				let frame = await settle(setup);
				// 2056 characters wrap to 22 rows; 20 fit.
				expect(frame).toContain("1-20/22");
				await press(setup, "j", "the scroll down", (f) => f.includes("2-21/22"));
				frame = await settle(setup);
				expect(frame).toContain("2-21/22");
				await press(setup, "k", "the scroll up", (f) => f.includes("1-20/22"));
				// Esc closes; the error is back on the base line.
				await press(setup, "escape", "the view to close", (f) =>
					!f.includes("Message view"),
				);
				expect(messageRowOf(await settle(setup))).toContain("the daemon refused");
				// F2 closes too.
				pressF2(setup);
				await awaitFrame(setup, (f) => f.includes("Message view - Error"), "the view");
				pressF2(setup);
				await awaitFrame(setup, (f) => !f.includes("Message view"), "the view to close");
				expect(messageRowOf(setup.captureCharFrame())).toContain("the daemon refused");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("hands the keys to the Key guide on F1 and ?", async () => {
		// F1.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				await press(setup, "m", "the message view", (f) => f.includes("Message view - Error"));
				pressF1(setup);
				await awaitFrame(
					setup,
					(f) => f.includes("Key guide - Ticket list"),
					"the guide from the view",
				);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
				// The view closed with the guide: the base holds the truncated error.
				expect(messageRowOf(await settle(setup)).trim()).toBe(
					truncateToWidth(`Error: ${LONG_LINE}`, WIDTH),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// Question mark.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				await press(setup, "m", "the message view", (f) => f.includes("Message view - Error"));
				await press(setup, "?", "the guide from the view", (f) =>
					f.includes("Key guide - Ticket list"),
				);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					truncateToWidth(`Error: ${LONG_LINE}`, WIDTH),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);
	});

	test("stays visible in the below-minimum frame, with the important line for errors", async () => {
		// Error: the compact frame keeps the line twice - the important one in
		// the box, the full one in the permanent row.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				setup.resize(25, 10);
				const rows = rowsOf(await settle(setup));
				expect(rows[1]).toContain("Terminal too small");
				expect(rows[2].trim()).toBe(truncateToWidth(`Error: ${LONG_LINE}`, 23));
				expect(rows[8]).toBe(padToWidth(truncateToWidth(`Error: ${LONG_LINE}`, 25), 25));
				expect(rows[9].trim()).toBe("? Help");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner: new FakeRunner(), initialTickets: SAMPLE_TICKETS },
		);

		// Error round trip: the truncation and the hint return with the width.
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
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
			{ config: DEFAULT_CONFIG, runner: longLineHandoffRunner(), initialTickets: SAMPLE_TICKETS },
		);
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
