/**
 * The shared frame-test harness: boot the control plane at a fixed terminal
 * size, press keys, and wait for their effects.
 *
 * Both frame test suites (the shell's and the handoff's) import from here so
 * they wait on the same frame semantics: a stale frame can never pass an
 * assertion, because the wait ends only when the effect appears or the
 * deadline dumps the last frame.
 */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { App, type AppKey, type AppProps } from "../src/components/app.ts";
import { TICKET_STATES, type Ticket } from "../src/domain/ticket.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

export type Setup = Awaited<ReturnType<typeof testRender>>;

export const WIDTH = 120;
export const HEIGHT = 30;
const FRAME_POLL_MS = 10;
const FRAME_DEADLINE_MS = 2000;
/** The dispatch grace `settle` waits out before trusting stability. */
const SETTLE_GRACE_MS = 30;
/** The state badge the list pane renders for each ticket state. */
const STATE_BADGES = TICKET_STATES.map((state) => `[${state}]`);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The panes wrap long text, so substring checks run on the frame with the
// box borders stripped and the whitespace collapsed: wrapped lines merge
// back into the source string at their word-boundary breaks.
export const frameText = (frame: string) => frame.replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ");
export const rowsOf = (frame: string) => frame.replace(/\n$/, "").split("\n");
/** The terminal row of the selected ticket in the list pane. */
export const markerRowOf = (frame: string) =>
	rowsOf(frame).findIndex((row) => row.startsWith("│ ❯"));
/**
 * A stable leading substring of a ticket's description, for frame checks.
 *
 * It ends at a word boundary, so it survives the merge of wrapped lines:
 * the wrap points are word boundaries too. The full description is fragile
 * to a word wider than the pane: the hard wrap cuts the word mid-word, the
 * merge turns the cut into a space, and the check would fail with a
 * confusing last-frame dump at the press helper's deadline.
 */
const descriptionLeadOf = (ticket: Ticket): string =>
	ticket.description.split(" ").slice(0, 4).join(" ");
export const showsTicket = (frame: string, ticket: Ticket) =>
	frameText(frame).includes(descriptionLeadOf(ticket));
/**
 * The text of the detail pane alone, with the list pane stripped.
 *
 * The merged frame interleaves the panes row by row, so a check on the
 * merged frame cannot hold a multi-line detail line intact once the list
 * carries enough tickets to reach the detail's rows.
 */
export const detailPaneText = (frame: string, width = WIDTH): string => {
	const listCols = Math.floor(width / 2);
	return rowsOf(frame)
		.map((row) => row.slice(listCols + 2, width - 2))
		.join(" ")
		.replace(/\s+/g, " ");
};
export const agentRowOf = (frame: string) =>
	rowsOf(frame).findIndex((row) => row.includes("Agent: unassigned"));
/** Assert every ticket state badge is on screen, read off the frame. */
export function expectStateBadges(frame: string): void {
	for (const badge of STATE_BADGES) {
		expect(frame).toContain(badge);
	}
}
/** Frame predicate: the detail pane holds the focus. */
export const detailFocused = (frame: string) =>
	frame.includes("❯ Detail") && !frame.includes("❯ Tickets");
/** Frame predicate: the list pane holds the focus. */
export const listFocused = (frame: string) =>
	frame.includes("❯ Tickets") && !frame.includes("❯ Detail");

let errorCalls: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	errorCalls = [];
	errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errorCalls.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	const unexpected = errorCalls.filter((call) => !/was not wrapped in act/.test(call));
	expect(unexpected, `unexpected console.error output:\n${unexpected.join("\n---\n")}`).toEqual([]);
	errorSpy.mockRestore();
});

/** A booted app: the test renderer plus the app's teardown handle. */
export interface AppSetup extends Setup {
	/**
	 * Stops the app's background loops. The test renderer's unmount does not
	 * run effect cleanups reliably, so tests stop the app explicitly before
	 * closing the state.
	 */
	stopApp: () => void;
}

export async function bootApp(
	props: AppProps = {},
	width = WIDTH,
	height = HEIGHT,
): Promise<AppSetup> {
	// Existing frame tests keep deterministic data at the App seam. A source
	// or state passed explicitly opts into the real empty/loading behavior.
	// A state without an explicit runner gets the empty-agent fake runner, so
	// the observation loop stays hermetic: no test can reach a real herdr.
	const runner = "runner" in props ? props : { runner: emptyAgentRunner() };
	const appProps =
		"state" in props || "sources" in props
			? { ...runner, ...props }
			: { initialTickets: SAMPLE_TICKETS, ...runner, ...props };
	let stopApp: (() => void) | null = null;
	const wired: AppProps =
		"onReady" in appProps ? appProps : { ...appProps, onReady: (ready) => (stopApp = ready.stop) };
	const setup = await testRender(createElement(App, wired), { width, height });
	await setup.flush();
	return { ...setup, stopApp: () => stopApp?.() };
}

/**
 * Boot the app at a fixed size, run `body`, and always destroy the
 * renderer, no matter how the body ends.
 */
export async function withApp(
	body: (setup: AppSetup) => Promise<void>,
	width = WIDTH,
	height = HEIGHT,
	props: AppProps = {},
): Promise<void> {
	const setup = await bootApp(props, width, height);
	try {
		await body(setup);
	} finally {
		await setup.renderer.destroy();
		// Stop the app's loops before the test closes the state: the test
		// renderer's unmount does not run effect cleanups, and a loop that
		// outlives the state reads a closed database.
		setup.stopApp();
	}
}

/**
 * Wait for the rendered frame to satisfy `predicate`, and return it.
 *
 * The wait ends when the effect appears, or the deadline fails the test
 * with the last frame. A stale frame can never pass an assertion.
 */
export async function awaitFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	what: string,
): Promise<string> {
	const deadline = Date.now() + FRAME_DEADLINE_MS;
	let frame = setup.captureCharFrame();
	for (;;) {
		if (predicate(frame)) {
			return frame;
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}\nlast frame:\n${frame}`);
		}
		await sleep(FRAME_POLL_MS);
		frame = setup.captureCharFrame();
	}
}

/** Press a key the shell handles, and wait for the effect it should produce. */
export async function press(
	setup: Setup,
	key: AppKey,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressKey(key);
	return awaitFrame(setup, predicate, what);
}

/** Press an arrow key and wait for the effect it should produce. */
export async function pressArrow(
	setup: Setup,
	direction: "up" | "down" | "left" | "right",
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressArrow(direction);
	return awaitFrame(setup, predicate, what);
}

/** Press `l` and wait for the detail pane to take focus. */
export async function focusDetail(setup: Setup): Promise<string> {
	return press(setup, "l", "the detail pane to take focus", detailFocused);
}

/** Press `h` and wait for the list pane to take focus. */
export async function focusList(setup: Setup): Promise<string> {
	return press(setup, "h", "the list pane to take focus", listFocused);
}

/**
 * Open the override panel, and wait until it owns the keys.
 *
 * Opening the panel renders it in the same commit as the press, but the
 * panel's key handler subscribes in an effect that flushes after the
 * commit. A panel key sent in that window reaches the app below and is
 * lost: the test would time out on its first panel key. The settle after
 * the open closes the window: when this returns, the subscription is live
 * and the next key is safe.
 */
export async function openPanel(setup: Setup): Promise<string> {
	await press(setup, "e", "the override panel to open", (f) => f.includes("Override"));
	return await settle(setup);
}

/**
 * Wait for the frame to stop changing, and return it.
 *
 * For keys that should change nothing, stability is the assertion.
 */
export async function settle(setup: Setup, maxMs = 300): Promise<string> {
	await sleep(SETTLE_GRACE_MS);
	const deadline = Date.now() + maxMs;
	let last = setup.captureCharFrame();
	let stablePolls = 0;
	for (;;) {
		await sleep(FRAME_POLL_MS);
		const current = setup.captureCharFrame();
		if (current === last) {
			stablePolls += 1;
			if (stablePolls >= 2) {
				return current;
			}
		} else {
			stablePolls = 0;
			last = current;
		}
		if (Date.now() >= deadline) {
			return current;
		}
	}
}
