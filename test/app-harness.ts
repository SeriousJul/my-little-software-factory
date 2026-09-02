/**
 * The shared frame-test harness: boot the control plane at a fixed terminal
 * size, press keys, and wait for their effects.
 *
 * Both frame test suites (the shell's and the handoff's) import from here so
 * they wait on the same frame semantics: a stale frame can never pass an
 * assertion, because the wait ends only when the effect appears or the
 * deadline dumps the last frame.
 */
import { type MouseButton, MouseButtons } from "@opentui/core/testing";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { App, type AppProps } from "../src/components/app.ts";
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
/** The permanent Message line is immediately above the Action bar. */
export const messageRowOf = (frame: string) => rowsOf(frame).at(-2) ?? "";
/** The permanent Action bar is the last terminal row. */
export const actionBarRowOf = (frame: string) => rowsOf(frame).at(-1) ?? "";
/**
 * The list pane's half of a terminal row, with its right border.
 *
 * A terminal row interleaves the two panes row by row, so an exact check
 * on a list row must run on the left half alone. The split runs on the
 * pane-divider substring, so it holds for wide-character rows too.
 */
export const listHalfOf = (row: string): string => `${row.split("││")[0]}│`;
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

/**
 * The distinct foreground colors the renderer used to paint the exact text
 * `text`, as `[r, g, b]` triplets, scanning every occurrence in the frame.
 *
 * Styled-span capture reads what the renderer painted, not the source's
 * props, so a check through it verifies the terminal output. The colors
 * come back in first-paint order.
 */
export function spanColors(setup: Setup, text: string): [number, number, number][] {
	const frame = setup.captureSpans();
	const order: [number, number, number][] = [];
	const seen = new Set<string>();
	for (const line of frame.lines) {
		const full = line.spans.map((span) => span.text).join("");
		let from = 0;
		for (;;) {
			const at = full.indexOf(text, from);
			if (at < 0) break;
			let spanStart = 0;
			for (const span of line.spans) {
				const spanEnd = spanStart + span.text.length;
				const overlaps = spanEnd > at && spanStart < at + text.length;
				if (overlaps) {
					const [r, g, b] = span.fg.toInts();
					const key = `${r},${g},${b}`;
					if (!seen.has(key)) {
						seen.add(key);
						order.push([r, g, b]);
					}
				}
				spanStart = spanEnd;
			}
			from = at + text.length;
		}
	}
	return order;
}

/** A `#rrggbb` color as the `[r, g, b]` triplet `spanColors` reports. */
export const rgb = (hex: string): [number, number, number] => [
	Number.parseInt(hex.slice(1, 3), 16),
	Number.parseInt(hex.slice(3, 5), 16),
	Number.parseInt(hex.slice(5, 7), 16),
];

/** The rendered foreground and background colors at one terminal cell. */
export function cellColors(
	setup: Setup,
	x: number,
	y: number,
): { fg: [number, number, number]; bg: [number, number, number] } {
	const line = setup.captureSpans().lines[y];
	if (line === undefined) throw new Error(`frame has no row ${y}`);
	let start = 0;
	for (const span of line.spans) {
		const end = start + span.width;
		if (x >= start && x < end) {
			const [fgRed, fgGreen, fgBlue] = span.fg.toInts();
			const [bgRed, bgGreen, bgBlue] = span.bg.toInts();
			return { fg: [fgRed, fgGreen, fgBlue], bg: [bgRed, bgGreen, bgBlue] };
		}
		start = end;
	}
	throw new Error(`frame row ${y} has no column ${x}`);
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
	// Match src/factory.ts: the renderer does not own Ctrl+C. The app's
	// emergency-exit dispatch is what destroys the renderer under test, so
	// the frame tests verify the catalogue's control, not OpenTUI's built-in.
	const setup = await testRender(createElement(App, wired), {
		width,
		height,
		exitOnCtrlC: false,
	});
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
 * with the last frame. A stale frame can never pass an assertion. A test
 * that holds a seat with a timed command can pass a longer deadline.
 */
export async function awaitFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	what: string,
	deadlineMs: number = FRAME_DEADLINE_MS,
): Promise<string> {
	const deadline = Date.now() + deadlineMs;
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

/**
 * The keys `press` can send: one pressable character or named key.
 * Arrow keys, F1, F2, and Ctrl+C have their own helpers: the mock input
 * types a bare `"f1"` string as two characters, and arrows need their
 * escape sequences. Any single character is typable, which the override
 * text rows accept.
 */
export type PressKey = (string & {}) | "return" | "escape" | "backspace";

/**
 * Press a key the shell handles, and wait for the effect it should produce.
 *
 * `return`, `escape`, and `backspace` dispatch their real key events: the
 * mock's `pressKey` only resolves exact `KeyCodes` names, so a lowercase
 * name would be typed as literal text. Every other key goes through the
 * mock's `pressKey` as a single character.
 */
export async function press(
	setup: Setup,
	key: PressKey,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	if (key === "return") setup.mockInput.pressEnter();
	else if (key === "escape") setup.mockInput.pressEscape();
	else if (key === "backspace") setup.mockInput.pressBackspace();
	else setup.mockInput.pressKey(scrollKeyInput(key));
	return awaitFrame(setup, predicate, what);
}

/**
 * The raw input of the scroll keys.
 *
 * The mock input accepts named Home and End codes, but the page keys use
 * their standard terminal escape sequences: sending their words would type
 * letters into the app instead of exercising the production parser.
 */
function scrollKeyInput(key: string): string {
	if (key === "pageup") return "\u001b[5~";
	if (key === "pagedown") return "\u001b[6~";
	if (key === "home") return "HOME";
	if (key === "end") return "END";
	return key;
}

/**
 * The raw input bytes of the scroll keys the mock input cannot name.
 *
 * The mock input sends a plain string as typed characters, so the page and
 * jump keys must go out as their terminal sequences.
 */
const SCROLL_KEY_BYTES: Record<"pageup" | "pagedown" | "home" | "end", string> = {
	pageup: "\u001B[5~",
	pagedown: "\u001B[6~",
	home: "\u001B[H",
	end: "\u001B[F",
};

/** Press a page or jump key by name, and wait for the effect it produces. */
export async function pressScrollKey(
	setup: Setup,
	key: "pageup" | "pagedown" | "home" | "end",
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressKey(SCROLL_KEY_BYTES[key]);
	return awaitFrame(setup, predicate, what);
}

/** Press the F1 key. The mock input takes the KeyCodes name, not `"f1"`. */
export const pressF1 = (setup: Setup): void => {
	setup.mockInput.pressKey("F1");
};

/** Press the F2 key. The mock input takes the KeyCodes name, not `"f2"`. */
export const pressF2 = (setup: Setup): void => {
	setup.mockInput.pressKey("F2");
};

/** Press Ctrl+C: the emergency exit control in every interaction mode. */
export const pressCtrlC = (setup: Setup): void => {
	setup.mockInput.pressCtrlC();
};

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

/** Send production-format mouse input through OpenTUI parsing and hit testing. */
export async function mouseClick(setup: Setup, x: number, y: number): Promise<void> {
	await setup.mockMouse.click(x, y);
}

/** Send one mouse press with a named button through real hit testing. */
export async function mousePress(
	setup: Setup,
	x: number,
	y: number,
	button: MouseButton = MouseButtons.LEFT,
): Promise<void> {
	await setup.mockMouse.click(x, y, button);
}

/** Send one terminal wheel or trackpad event through real hit testing. */
export async function mouseWheel(
	setup: Setup,
	x: number,
	y: number,
	direction: "up" | "down" | "left" | "right",
	shift = false,
): Promise<void> {
	await setup.mockMouse.scroll(x, y, direction, { modifiers: shift ? { shift: true } : {} });
}

/** Drag through parsed mouse input, including the native scrollbar hit path. */
export async function mouseDrag(
	setup: Setup,
	from: readonly [x: number, y: number],
	to: readonly [x: number, y: number],
): Promise<void> {
	// OpenTUI captures a drag target on its first drag event, not its mouse
	// down event. Send one drag at the source before moving: the slider then
	// receives all later positions even when the pointer leaves its thumb.
	await setup.mockMouse.pressDown(from[0], from[1]);
	await setup.mockMouse.moveTo(from[0], from[1]);
	await setup.mockMouse.moveTo(to[0], to[1]);
	await setup.mockMouse.release(to[0], to[1]);
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
	// The Action bar always shows the e Override hint, so the panel's own
	// first row is the real open signal.
	await press(setup, "e", "the override panel to open", (f) => f.includes("❯ Agent"));
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

/** One captured span with its foreground resolved to rgb. */
export interface SpanInfo {
	text: string;
	fg: [number, number, number] | null;
	bg: [number, number, number] | null;
}

function resolveColor(value: unknown): [number, number, number] | null {
	const color = value as { toInts?: () => readonly number[] } | null | undefined;
	if (typeof color?.toInts !== "function") return null;
	const [r, g, b] = color.toInts();
	return [r, g, b];
}

/** The spans of one captured row, with their colors resolved. */
export function rowSpans(setup: Setup, row: number): SpanInfo[] {
	const line = setup.captureSpans().lines[row];
	return (line?.spans ?? []).map((span) => ({
		text: span.text,
		fg: resolveColor(span.fg),
		bg: resolveColor(span.bg),
	}));
}

/**
 * The foreground of the first span containing `needle` on the row.
 * Query the key part ("→/l ") and the label part ("Detail") separately:
 * the renderer merges only spans of equal color, so a full hint spans two.
 */
export function spanColorAt(
	setup: Setup,
	row: number,
	needle: string,
): [number, number, number] | null {
	for (const span of rowSpans(setup, row)) {
		if (span.text.includes(needle)) return span.fg;
	}
	return null;
}
