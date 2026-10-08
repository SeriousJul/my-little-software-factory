/**
 * The shared frame-test harness: boot the control plane at a fixed terminal
 * size, press keys, and wait for their effects.
 *
 * Both frame test suites (the shell's and the handoff's) import from here so
 * they wait on the same frame semantics: a stale frame can never pass an
 * assertion, because the wait ends only when the effect appears or the
 * deadline dumps the last frame.
 */

import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import { type MouseButton, MouseButtons } from "@opentui/core/testing";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { App, type AppProps } from "../src/components/app.ts";
import { SPINNER_FRAMES } from "../src/components/shared/spinner.ts";
import { resolveTheme, type ThemeRole } from "../src/components/shared/theme.ts";
import { TICKET_STATES, type Ticket } from "../src/domain/ticket.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
import { flushPassiveNow } from "./passive-flush-hold.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import "./theme-isolation.ts";

export type Setup = Awaited<ReturnType<typeof testRender>>;

export const WIDTH = 120;
export const HEIGHT = 30;
const FRAME_POLL_MS = 10;
/**
 * How long one frame wait may run before the effect is called missing.
 *
 * The suite runs a real renderer, a real state database, and the machine's
 * other work at the same time, and an effect can cross a process boundary on
 * the way to the frame: the heaviest waits here launch a Handoff or an Agent
 * through a command runner. A deadline tuned to a quiet machine fails such a
 * wait by a few hundred ms under load, and the run reads as a broken app
 * rather than a busy one. A test whose effect never arrives still fails, only
 * at this deadline; the runner's own budget (the test script's `--timeout`)
 * stays above the sum of a test's waits.
 *
 * CI hosts set `CI`, and their shared runners run the suite under a load the
 * deadline was not tuned for. Doubling it there keeps a slow runner slow
 * instead of red; a test whose effect never arrives still fails, at 20000 ms
 * instead of 10000.
 *
 * The #311 sweep counts every wait that stands on this deadline, at the
 * fix's head: 814 direct `awaitFrame` sites in 34 test files (813 on this
 * deadline, one on its own 350 ms in `ticket-grouping-frame`), 986
 * press-family sites that each await one frame through this file (647
 * `press`, 217 `pressArrow`, 89 `pressReturn`, 19 `pressEnterQuiet`, 12
 * `pressScrollKey`, 2 `pressQuiet`), and 188 open- and close-helper sites
 * (32 `closeOverlay`, 13 `confirmPanel`, 143 open helpers) that each await
 * one frame plus one key handler. The 193 key handler waits - 5 direct
 * (4 `awaitNewKeyHandler`, 1 `awaitBaseKeyHandlers`) and the rest through
 * the helpers - are the ones that can end only on a pass the plane does
 * not owe. They end on React's
 * passive-effect flush - the mount subscribe and the unmount unsubscribe -
 * scheduled at the normal priority, and owed to the reconciler, not to the
 * renderer. The plane paints on
 * invalidation, so no frame ends them on its own (the #302/#310 class was
 * the renderer-pass mirror of the same shape). `awaitFrameChecking`, the
 * wait that landed for issue #312 after the sweep's head, stands on the
 * same deadline at its call, and its loop is the one the direct `awaitFrame`
 * sites run. Every wait above runs `flushPassiveNow` per poll before it
 * reads, so each of them ends on what it waits for instead of on the
 * scheduler's next turn.
 */
export const FRAME_DEADLINE_MS = process.env.CI ? 20000 : 10000;
/** The dispatch grace `settle` waits out before trusting stability. */
const SETTLE_GRACE_MS = 30;
/**
 * The state badge the list pane renders for each resting ticket state.
 *
 * `handed-off` is not among them (ADR 0030): the `[handed-off]` badge is
 * never drawn, and the ticket's Starting window wears the spinner face in
 * its place instead. The frames the sample data carries a `handed-off`
 * ticket, so a frame with every badge also carries one face.
 *
 */
const STATE_BADGES = TICKET_STATES.filter((state) => state !== "handed-off").map(
	(state) => `[${state}]`,
);

/**
 * The spinner face a ticket's Starting window wears in place of its state
 * badge (ADR 0030), read off a frame.
 *
 * The face steps its braille frame every ~100 ms, so a frame holds exactly
 * one glyph beside the written word: the check runs on the word and any of
 * the shared frames, never on one frame's glyph alone. A frame snapshot pins
 * the first frame the face stands on; the animation itself is not something
 * the frame snapshots verify.
 */
export const startingFaceOf = (frame: string | undefined): string | null =>
	frame === undefined
		? null
		: (SPINNER_FRAMES.find((glyph) => frame.includes(`${glyph} starting`)) ?? null);

/**
 * The frame with the animated face standing on its first frame.
 *
 * The face steps a braille glyph every ~100 ms, so an exact frame
 * comparison over that interval reads the glyph, not the screen it sits
 * in. A stability check or an equality between two captures normalizes the
 * glyph to the first frame first, so the face reads as the still it is for
 * the screen: the word beside it carries the fact, the glyph is the motion
 * (ADR 0030).
 */
export const stillFrame = (frame: string): string =>
	SPINNER_FRAMES.slice(1).reduce(
		(out, glyph) => out.replaceAll(`${glyph} starting`, `${SPINNER_FRAMES[0]} starting`),
		frame,
	);

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
 * The content rows of a full-screen overlay, in the order the operator reads them.
 *
 * An overlay draws one bordered box, so a content row is a terminal row that
 * holds the box's left and right border. The border rows, the box's blank
 * spacers, and the screen around the box drop out. The key column's padding
 * collapses to one space, because the row text is wrapped on word boundaries
 * before it reaches the screen.
 */
export const overlayRows = (frame: string): string[] =>
	rowsOf(frame)
		.map((row) => /^\s*│(.*)│\s*$/.exec(row)?.[1])
		.filter((row): row is string => row !== undefined)
		.map((row) => row.trim().replace(/\s+/g, " "))
		.filter((row) => row !== "");
/**
 * The list pane's half of a terminal row, with its right border.
 *
 * A terminal row interleaves the two panes row by row, so an exact check
 * on a list row must run on the left half alone. The split runs on the
 * pane-divider substring, so it holds for wide-character rows too.
 */
export const listHalfOf = (row: string): string => `${row.split("││")[0]}│`;
/**
 * The Ticket section header: the Ticket list box starts one row lower than
 * it did when the section owned the whole frame (ADR 0019). The Consultation
 * section header sits between the two list boxes, so it is not part of this
 * offset.
 *
 * Frame tests that point at a pane row or click a pane cell state their
 * target relative to this constant, so the header stays one fact instead of
 * a repeated magic number. The Auto-handoff mode cell rides the Ticket
 * header's own row, so the offset holds with factory state and without it.
 */
export const HEADER_ROWS = 1;
/** The terminal row a frame-relative pane row holds under the header. */
export const paneRow = (row: number): number => HEADER_ROWS + row;
/**
 * The terminal row of the selected entry in the list that holds the cursor.
 *
 * The Ticket list sits above the Consultation list, so a row that starts
 * with the marker is the Ticket selection's row while a Ticket holds the
 * cursor, and the Consultation selection's row while a Consultation does.
 */
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

/**
 * The terminal row the detail pane holds its `Agent:` line on.
 *
 * The probe reads the detail pane's text column alone, at the width the frame
 * carries, and only where a line starts with the label, so neither the list
 * pane beside it nor a ticket title that carries the word "Agent:" can move
 * it: the merged frame interleaves the two panes row by row, so a check on a
 * whole row would.
 */
export const agentRowOf = (frame: string): number => {
	const rows = rowsOf(frame);
	// The frame carries its own width, so the probe follows the terminal the
	// test booted rather than the one this harness defaults to.
	const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
	const detailFrom = Math.floor(width / 2) + 2;
	return rows.findIndex((row) =>
		row
			.slice(detailFrom, width - 2)
			.trimStart()
			.startsWith("Agent: "),
	);
};
/**
 * Assert every resting ticket state badge is on screen, read off the frame,
 * and the Starting window wears its spinner face in place of the badge it
 * replaced (ADR 0030).
 */
export function expectStateBadges(frame: string): void {
	for (const badge of STATE_BADGES) {
		expect(frame).toContain(badge);
	}
	expect(startingFaceOf(frame)).not.toBeNull();
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

/**
 * One theme role's painted color, the hex a test asserts its frame against.
 *
 * This resolves the standalone theme in color through the pure resolver, so
 * the expected value never reads the test process's environment: the test
 * files share one process and run concurrently, and another file's test body
 * can hold `NO_COLOR` at the instant an assertion resolves, a window in which
 * `paint` answers `undefined`. The role-to-old-palette mapping stands as
 * before: the `text` role for the old `COLORS.text`, `subtext0` for `dim`,
 * `accent` for `borderFocused`, `blue` for `statusWorking`, `yellow` for
 * `statusWarning`, `red` for `statusError`, `panel_bg` for `overlay`, and so
 * on. The emphasis the old palette carried in a brighter text color
 * (`textBright`) now rides on bold, so a test asserts the `text` role for it.
 * The standalone palette paints every role, so the value is always a color.
 */
export const roleColor = (role: ThemeRole): string => resolveTheme(null, false).theme.roles[role];

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

/**
 * True when the frame marks the override panel row labelled `label` as the
 * selected one.
 */
export const rowSelected = (frame: string, label: string): boolean =>
	frame.includes(`\u276f ${label}`);

/**
 * The tones of a row whose value cannot reach its Agent.
 *
 * The value wears the warning tone and the reason written under it wears the
 * error tone, so a test that asks for a warning row asks for both: a row that
 * carried its meaning on a tone alone would paint only the first.
 */
export const unfitTones = (): [number, number, number][] => [
	rgb(roleColor("yellow")),
	rgb(roleColor("red")),
];

/** Frame predicate: the detail pane holds the focus. */
export const detailFocused = (frame: string) =>
	frame.includes("❯ Detail") && !frame.includes("❯ Tickets");
/** Frame predicate: the list pane holds the focus. */
export const listFocused = (frame: string) =>
	frame.includes("❯ Tickets") && !frame.includes("❯ Detail");

let errorCalls: string[];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	errorCalls = [];
	errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
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
	props: Partial<AppProps> = {},
	width = WIDTH,
	height = HEIGHT,
	rendererOptions: { kittyKeyboard?: boolean } = {},
): Promise<AppSetup> {
	// Existing frame tests keep deterministic data at the App seam. A source
	// or state passed explicitly opts into the real empty/loading behavior.
	// A state without an explicit runner gets the empty-agent fake runner, so
	// the observation loop stays hermetic: no test can reach a real herdr.
	// A suite that names no config runs on the base config fixture: the app
	// itself carries no in-code default config.
	const runner = "runner" in props ? props : { runner: emptyAgentRunner() };
	const appProps: AppProps =
		"state" in props || "sources" in props
			? { config: BASE_CONFIG, ...runner, ...props }
			: { initialTickets: SAMPLE_TICKETS, config: BASE_CONFIG, ...runner, ...props };
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
		...rendererOptions,
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
	fields: {
		width?: number;
		height?: number;
		props?: Partial<AppProps>;
		rendererOptions?: { kittyKeyboard?: boolean };
	} = {},
): Promise<void> {
	const { width = WIDTH, height = HEIGHT, props = {}, rendererOptions = {} } = fields;
	const setup = await bootApp(props, width, height, rendererOptions);
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
 * Take the renderer's `frame` event away from every surface, and hand back the
 * key that puts it back.
 *
 * The renderer paints on invalidation, not on a free-running loop: a booted and
 * idle plane emits no frames at all. A surface that waits for the next `frame`
 * pass can therefore wait forever, and the plane is under no obligation to give
 * one (issue #302). With the event withheld, the passes the app's own updates
 * cause still paint, but no surface can be woken by one: only a change that
 * asks for nothing shows on the screen. The harness's own waits read the painted
 * buffer, never the event, so they keep working while it is held back.
 *
 * The key counts what it swallowed and refuses to hand the event back on an
 * empty count, and it refuses a hold that leaked. The renderer only announces a
 * pass behind its own `listenerCount("frame") > 0` guard, so a fixed restore,
 * which registers no listener, would leave the count at zero and say nothing.
 * The harness therefore keeps one listener of its own on the event: the guard
 * stays open, the wrapper intercepts every announcement a surface could have
 * been woken by, and the witness counts the ones that reached it anyway. A
 * future OpenTUI that announces a pass along another path trips the witness
 * instead of leaving the pin to pass green on a wait nobody tested.
 */
export function withholdFrameEvents(setup: Setup): () => void {
	const renderer = setup.renderer;
	const emit = renderer.emit.bind(renderer);
	let framesSwallowed = 0;
	let framesWitnessed = 0;
	renderer.emit = (event: string | symbol, ...args: unknown[]) => {
		if (event !== CliRenderEvents.FRAME) return emit(event, ...args);
		framesSwallowed += 1;
		return true;
	};
	const witness = () => {
		framesWitnessed += 1;
	};
	renderer.on(CliRenderEvents.FRAME, witness);
	return () => {
		renderer.removeListener(CliRenderEvents.FRAME, witness);
		renderer.emit = emit;
		expect(
			framesSwallowed,
			"withholdFrameEvents swallowed no `frame` emission, so the hold proved nothing",
		).toBeGreaterThan(0);
		expect(
			framesWitnessed,
			"withholdFrameEvents leaked a `frame` emission to its own listener, so the hold did not hold",
		).toBe(0);
	};
}

/** What a render-ask hold saw while it held. */
export interface RenderAskWitness {
	/** How many render asks the hold swallowed. */
	asksHeld: number;
	/**
	 * How many asks came from the control plane's own code. `withholdRenderAsks
	 * ButThePlanesOwn` lets its first one through; `withholdEveryRenderAsk`
	 * swallows it along with every other ask and counts it.
	 */
	planeAsks: number;
}

/**
 * True when the caller of the `requestRender` wrapper is the control plane.
 *
 * The wrapper's own frame is on the stack, so the caller is the frame above it.
 * A path under the repository's own `src/` is a surface asking the renderer
 * directly; OpenTUI's files, `node_modules/` included, are not the plane, so a
 * renderable's own ask reads as a renderable's ask.
 */
function renderAskComesFromThePlane(): boolean {
	const caller = (new Error().stack ?? "").split("\n")[3] ?? "";
	return !caller.includes("node_modules") && /\/src\/[\w./-]+\.ts:\d+:\d+/.test(caller);
}

/**
 * Hold back every render ask but the control plane's own, and hand back the key
 * that puts them back, with what the hold witnessed.
 *
 * The renderer paints on invalidation: a surface that changes a renderable asks
 * for the next pass, and a resting plane asks for nothing (issue #302). A pane
 * that needs a pass to lay itself out cannot count on some other surface's ask
 * to supply one. With this hold up, the rig's own resize ask and the asks a
 * remount's renderable mutations make are all swallowed, so no pass can land
 * until the control plane asks for one. That also fixes the geometry the pane
 * meets: with no pass able to run first, a remounted scroll box still answers no
 * size when its restore effect runs, which is the branch the unheld case takes
 * only while the runner is quiet.
 *
 * The hold reads the direct caller of `requestRender` off the call stack. A
 * renderable's own ask reaches the renderer from inside OpenTUI, so it is held
 * like the rig's; only a surface that calls the renderer itself gets through.
 * The first ask that gets through puts the hold down: the pass it schedules is
 * the one under test, and the repaint that carries its result to the screen
 * belongs to the buffer the assertion reads.
 *
 * The key counts what it swallowed and refuses to hand the asks back on an empty
 * count: a hold that swallowed nothing is indistinguishable from no hold at all.
 */
export function withholdRenderAsksButThePlanesOwn(setup: Setup): () => RenderAskWitness {
	const renderer = setup.renderer;
	const ask = renderer.requestRender.bind(renderer);
	let held = true;
	const witness: RenderAskWitness = { asksHeld: 0, planeAsks: 0 };
	renderer.requestRender = () => {
		if (renderAskComesFromThePlane()) {
			witness.planeAsks += 1;
			held = false;
			return ask();
		}
		if (!held) return ask();
		witness.asksHeld += 1;
		return undefined;
	};
	return () => {
		renderer.requestRender = ask;
		expect(
			witness.asksHeld,
			"withholdRenderAsksButThePlanesOwn swallowed no render ask, so the hold proved nothing",
		).toBeGreaterThan(0);
		return witness;
	};
}

/**
 * Hold back every render ask, the control plane's own included, and hand back
 * the key that puts them back with what the hold witnessed.
 *
 * `withholdRenderAsksButThePlanesOwn` lets the pane's own ask schedule the pass
 * under test. This hold lets none through, so no pass ever runs and a scroll box
 * remounted under it never lays out: it answers no content height and no
 * viewport on every pass the rig announces. That is the state the restore
 * effect's give-up path is about, and no reachable app state puts a box there -
 * the pass the pane asks for always lays it out - so the rig announces the
 * passes itself with `announceFramePass`.
 *
 * The witness counts the asks the control plane made directly on the renderer,
 * which is what the restore's one-ask bound bounds: an unbounded restore asks
 * again on every announced pass, forever. The key refuses to hand the asks back
 * on an empty swallowed count, as the other hold does.
 */
export function withholdEveryRenderAsk(setup: Setup): () => RenderAskWitness {
	const renderer = setup.renderer;
	const ask = renderer.requestRender.bind(renderer);
	const witness: RenderAskWitness = { asksHeld: 0, planeAsks: 0 };
	renderer.requestRender = () => {
		if (renderAskComesFromThePlane()) witness.planeAsks += 1;
		witness.asksHeld += 1;
		return undefined;
	};
	return () => {
		renderer.requestRender = ask;
		expect(
			witness.asksHeld,
			"withholdEveryRenderAsk swallowed no render ask, so the hold proved nothing",
		).toBeGreaterThan(0);
		return witness;
	};
}

/**
 * Announce one render pass to the surfaces that registered for it.
 *
 * The renderer announces a pass when a pass runs, and no pass can run while
 * every ask is held. This calls the renderer's own `frame` announcement, which
 * is what a surface registered with `once("frame", ...)` meets. It is the rig
 * speaking, not a pass: nothing lays the tree out, so a box that answered no
 * size before the announcement answers no size after it.
 */
export function announceFramePass(setup: Setup): void {
	setup.renderer.emit(CliRenderEvents.FRAME);
}

/**
 * Wait for the rendered frame to satisfy `predicate`, and return it.
 *
 * The wait ends when the effect appears, or the deadline fails the test
 * with the last frame. A stale frame can never pass an assertion. A test
 * that holds a seat with a timed command can pass a longer deadline.
 *
 * The wait is `awaitFrameChecking` with no check on the frames it passes,
 * so the per-poll flush that lands there runs here, too: each poll first
 * flushes what React still owes at the normal priority, and the commit a
 * keypress or a source answer scheduled, and the passive flush that commit
 * queued, land in the rig's own turn before the frame the poll captures. On
 * a loaded runner that flush landed 2 to 6 ms after the frame the same
 * commit drew, and a wait that ended on it missed `FRAME_DEADLINE_MS` even
 * though the app was sound (issue #311).
 */
export async function awaitFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	what: string,
	deadlineMs: number = FRAME_DEADLINE_MS,
): Promise<string> {
	return awaitFrameChecking(setup, {
		until: predicate,
		what,
		check: () => undefined,
		pollMs: FRAME_POLL_MS,
		deadlineMs,
	});
}

/**
 * Wait for the rendered frame to satisfy `until`, running `check` on every
 * frame read on the way, the frame that ends the wait included, and return
 * that frame.
 *
 * The wait steps the frame stream the way `awaitFrame` does: it ends when the
 * effect appears or the deadline dumps the last frame, and it never stands on
 * a wall-clock window the effect can land outside of (the rule on the quality
 * gate page). A case that must hold on every painted frame between two states
 * - the decision modal's pop-in edge, issue #312 - waits for the end state
 * this way and checks each frame the stream gives it, instead of sampling a
 * fixed window that a loaded runner can outrun and miss.
 *
 * The buffer holds only the frame last painted, so a painted frame stands to
 * be read only until the next paint replaces it. `pollMs` is how often the
 * wait reads the buffer, and a caller that must read every painted frame the
 * stream gives it polls faster than the paint's own interval, the way the
 * pop-in case does against its 16 ms tick.
 *
 * `awaitFrame` is this loop with a no-op check, and every poll runs
 * `flushPassiveNow` before it reads, the way the wait it stands for does
 * (issue #311): a frame wait that reads the buffer before the flush that
 * commits the paint would be the same failure class as the wall-clock
 * window this loop replaces (issue #312).
 */
export async function awaitFrameChecking(
	setup: Setup,
	fields: {
		until: (frame: string) => boolean;
		what: string;
		check: (frame: string) => void;
		pollMs?: number;
		deadlineMs?: number;
	},
): Promise<string> {
	const { until, what, check, pollMs = FRAME_POLL_MS, deadlineMs = FRAME_DEADLINE_MS } = fields;
	const deadline = Date.now() + deadlineMs;
	let frame = setup.captureCharFrame();
	for (;;) {
		check(frame);
		if (until(frame)) return frame;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}\nlast frame:\n${frame}`);
		}
		await sleep(pollMs);
		flushPassiveNow();
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
	// Settle before the key lands: a press right after a surface closed or
	// opened can fall in the window where the intended handler is not live
	// yet, and the key is dropped. On a slow host that window is wide.
	// settle is bounded, so a frame that never settles still gets the key.
	await settle(setup);
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
	// The mock types a word it does not know as literal text, so the Delete
	// key goes out as its escape sequence like the page keys do.
	if (key === "delete") return "\u001b[3~";
	// The space key's word types the word "space", so it goes out as its one
	// character.
	if (key === "space") return " ";
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
	// Settle before the key lands, for the reason `press` states: a key sent
	// into a surface transition is dropped on a slow host.
	await settle(setup);
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
	// Settle before the key lands, for the reason `press` states: a key sent
	// into a surface transition is dropped on a slow host.
	await settle(setup);
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
	event: {
		x: number;
		y: number;
		direction: "up" | "down" | "left" | "right";
		shift?: boolean;
	},
): Promise<void> {
	const { x, y, direction, shift = false } = event;
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

/**
 * Scroll the focused detail pane until one line shows, and return that frame.
 *
 * The detail is taller than a short terminal, so a test that needs a row
 * below the fold has to scroll to it, and the pane's row count is a product
 * decision that changes with the settings a Ticket carries. The walk presses
 * `j` until the line shows, so a test states what it looks for instead of
 * counting rows.
 */
export async function scrollDetailUntil(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
	maxSteps = 24,
): Promise<string> {
	for (let step = 0; step <= maxSteps; step += 1) {
		const frame = setup.captureCharFrame();
		if (predicate(frame)) return frame;
		setup.mockInput.pressKey("j");
		await settle(setup, SCROLL_STEP_MS);
	}
	throw new Error(`the detail never showed ${what}\nlast frame:\n${setup.captureCharFrame()}`);
}

/** How long one scroll step of the walk may take to go quiet. */
const SCROLL_STEP_MS = 150;

/** Press `h` and wait for the list pane to take focus. */
export async function focusList(setup: Setup): Promise<string> {
	return press(setup, "h", "the list pane to take focus", listFocused);
}

/**
 * The keypress handlers live on the renderer's key bus.
 *
 * Every surface that owns keys (the override panel, the modals, both utility
 * overlays, the Consultation launcher, the Consultation action panel)
 * subscribes one stable handler in a passive effect when it mounts, and the
 * effect's cleanup removes it when the surface unmounts. React flushes those
 * effects after the commit that opened or closed the surface, and under load
 * the flush can lag the drawn frame by far more than a fixed grace: the frame
 * never proves the key routing is settled, but the subscription list moves
 * only when a surface's handler appears or leaves.
 *
 * The list holds the stable wrapper of each mounted hook instance, so the
 * helpers below snapshot it around a key and compare by identity, never by
 * length: a swap, where one overlay replaces another, leaves the count
 * unchanged while a new handler appears and an old one leaves.
 */
export function keyHandlerListeners(setup: Setup): unknown[] {
	return setup.renderer.keyInput.listeners("keypress");
}

/**
 * Poll the key bus until `settled` accepts its subscription list.
 *
 * The three waits below are this loop over the same list, and they differ only
 * in the fact they wait on: a handler that joined, a handler that left, or no
 * handler outside a base set. The deadline matches the frame waits, and a
 * timeout dumps the list size and the last frame.
 */
async function awaitKeyBus(
	setup: Setup,
	what: string,
	settled: (now: unknown[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + FRAME_DEADLINE_MS;
	for (;;) {
		// The bus takes and drops its handlers in passive effects, and the
		// flush a commit queues lands on the scheduler's clock, not on any
		// frame (issue #311): run it in the wait's own turn before the read.
		flushPassiveNow();
		const now = keyHandlerListeners(setup);
		if (settled(now)) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out waiting for ${what} (key handlers: ${now.length})\nlast frame:\n${setup.captureCharFrame()}`,
			);
		}
		await sleep(FRAME_POLL_MS);
	}
}

/**
 * Wait until the key bus holds a subscription that `before` did not.
 *
 * That is the moment a mounting surface's key handler takes the keys: until
 * it is subscribed, a key for the surface is dropped by the shell below.
 */
export async function awaitNewKeyHandler(
	setup: Setup,
	before: unknown[],
	what: string,
): Promise<void> {
	return awaitKeyBus(setup, what, (now) => now.some((handler) => !before.includes(handler)));
}

/**
 * Wait until the key bus drops one of the subscriptions `before` held.
 *
 * That is the moment an unmounting surface's key handler releases the keys:
 * until it is unsubscribed, a key still reaches the stale handler, which can
 * act on it with the closed surface's meaning.
 */
export async function awaitGoneKeyHandler(
	setup: Setup,
	before: unknown[],
	what: string,
): Promise<void> {
	return awaitKeyBus(setup, what, (now) => before.some((handler) => !now.includes(handler)));
}

/**
 * The key bus at rest in a base mode, taken by the harness for the release wait.
 *
 * `baseKeyHandlers` snapshots the subscriptions while the plane rests in the
 * mode a walk returns to, and keeps watching the bus until the wait ends, so
 * the wait can tell a release it watched from a wait that never had anything to
 * watch. See `awaitBaseKeyHandlers`.
 */
export interface BaseKeyHandlers {
	/** The subscriptions the bus held when the snapshot was taken. */
	readonly base: readonly unknown[];
	/**
	 * Whether a handler outside `base` joined the bus after the snapshot: the
	 * moment a surface the walk opened took the keys.
	 */
	readonly grew: boolean;
	/** Stop watching the bus. The release wait calls it. */
	stop(): void;
}

/**
 * Snapshot the key bus at rest in the base mode, and watch it from here.
 *
 * A test takes this *before* it opens the surface whose release it later waits
 * for, which is the only place the base means anything: the base is the set of
 * handlers the mode the walk returns to already held.
 *
 * The watch is the harness's, not the caller's. The bus announces a subscription
 * before it lands, so the snapshot sees a surface take the keys even when that
 * surface let them go before the wait's first poll, and the wait can then say
 * whether the walk ever mounted one. A snapshot taken too late - after the
 * surface mounted - is caught by the wait instead of passing silently.
 */
export function baseKeyHandlers(setup: Setup): BaseKeyHandlers {
	const base = keyHandlerListeners(setup);
	const bus = setup.renderer.keyInput;
	let grew = false;
	// The bus announces `newListener` as (event name, listener), which is not
	// Node's documented order, so the observer takes two arguments and picks the
	// name out of them by type rather than by place.
	const observe = (first: unknown, second: unknown): void => {
		const [event, listener] =
			typeof first === "string" || typeof first === "symbol" ? [first, second] : [second, first];
		if (event === "keypress" && !base.includes(listener)) grew = true;
	};
	bus.on("newListener", observe);
	return {
		base,
		get grew(): boolean {
			return grew;
		},
		stop(): void {
			bus.off("newListener", observe);
		},
	};
}

/**
 * Wait until the key bus holds no subscription outside the snapshot's base.
 *
 * `awaitGoneKeyHandler` names the handler whose release a test waits on, and a
 * test cannot name one when the surface that holds the keys was mounted and
 * unmounted between two facts the test can see: a panel a confirm returns to
 * can have its reopen elided altogether when the transition that closes it
 * lands in the same render, so no handler of that surface ever joins the bus.
 * The fact that covers both branches is the one this waits on - every handler
 * the bus holds is one of the surfaces that already held keys when the base was
 * taken, so no closed surface is left holding a key the base mode means to
 * take.
 *
 * The wait would return at once when the bus holds only the base, and that is
 * the branch a caller could fall into by taking the snapshot too late. The
 * snapshot watches the bus for its whole life, so the wait refuses that case
 * out loud: a walk that never mounted a surface with keys to release has no
 * release to wait for, and it should name its handler with
 * `awaitGoneKeyHandler` instead.
 */
export async function awaitBaseKeyHandlers(
	setup: Setup,
	snapshot: BaseKeyHandlers,
	what: string,
): Promise<void> {
	try {
		await awaitKeyBus(
			setup,
			what,
			(now) => !now.some((handler) => !snapshot.base.includes(handler)),
		);
	} finally {
		snapshot.stop();
	}
	if (!snapshot.grew) {
		throw new Error(
			`waiting for ${what} proved nothing: no key handler outside the base snapshot ever joined the bus, so this walk never mounted a surface that had a key to release. Take the snapshot before the surface opens, or wait with awaitGoneKeyHandler on the named handler`,
		);
	}
}

/**
 * Press a key, wait for its effect, then wait for the app to go quiet.
 *
 * A key that lands while an update chain is still in flight - an observation
 * tick, a modal's pop-in, a render pass that subscribes the next handler -
 * can be dropped or can reach two handlers at once. A press whose effect
 * depends on what ran before it therefore waits for the frame to stop
 * changing before the next key goes out.
 */
export async function pressQuiet(
	setup: Setup,
	key: Parameters<typeof press>[1],
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const frame = await press(setup, key, what, predicate);
	await settle(setup);
	return frame;
}

/** Press Enter, wait for its effect, then wait for the app to go quiet. */
export async function pressEnterQuiet(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	const frame = await awaitFrame(setup, predicate, what);
	await settle(setup);
	return frame;
}

/**
 * Open the override panel, and wait until it owns the keys.
 *
 * Opening the panel renders it in the same commit as the press, but the
 * panel's key handler subscribes in an effect that flushes after the
 * commit. A panel key sent in that window reaches the app below and is
 * lost: the test would time out on its first panel key. The wait on the
 * key bus subscription closes the window deterministically: when this
 * returns, the panel's handler is live and the next key is safe.
 */
export async function openPanel(setup: Setup): Promise<string> {
	const before = keyHandlerListeners(setup);
	// The Action bar always shows the e Override hint, so the panel's own
	// first row is the real open signal.
	await press(setup, "e", "the override panel to open", (f) => f.includes("❯ Agent"));
	await awaitNewKeyHandler(setup, before, "the override panel to take the keys");
	return await settle(setup);
}

/**
 * Open the Key guide, and wait until it owns the keys.
 *
 * The open renders the guide in the same commit as the press, but the guide's
 * key handler subscribes in an effect that flushes after the commit. A guide
 * key sent in that window reaches the shell below, which drops non-emergency
 * keys while a utility is open, so the first guide key is lost and the test
 * times out on it. The wait on the key bus subscription closes the window
 * deterministically: when this returns, the guide's handler is live and the
 * next key is safe.
 *
 * `opener` is the key that opens the guide from the current mode: `?` in most
 * modes, `F1` where that is the mode's help alias. `title` is the open
 * signal, usually the guide's mode cell.
 */
export async function openGuide(
	setup: Setup,
	opener: "?" | "F1" = "?",
	title = "Key guide",
): Promise<string> {
	const before = keyHandlerListeners(setup);
	if (opener === "F1") {
		pressF1(setup);
		await awaitFrame(setup, (f) => f.includes(title), "the key guide to open");
	} else {
		await press(setup, "?", "the key guide to open", (f) => f.includes(title));
	}
	await awaitNewKeyHandler(setup, before, "the key guide to take the keys");
	return await settle(setup);
}

/**
 * Open the Message view, and wait until it owns the keys.
 *
 * The view mounts in the open's commit and its key handler subscribes after
 * it, so the first view key must wait for the subscription the same way the
 * Key guide does. `opener` is the key that opens the view from the current
 * mode: F2 anywhere, or `m` from the Message line's own hint.
 */
export async function openMessageView(
	setup: Setup,
	opener: "m" | "F2" = "F2",
	title = "Message view",
): Promise<string> {
	const before = keyHandlerListeners(setup);
	if (opener === "F2") {
		pressF2(setup);
	} else {
		setup.mockInput.pressKey("m");
	}
	await awaitFrame(setup, (f) => f.includes(title), "the message view to open");
	await awaitNewKeyHandler(setup, before, "the message view to take the keys");
	return await settle(setup);
}

/**
 * Tab until the frame names the slot the focus is on.
 *
 * A shared form paints its focus marker where the keyboard is, so the marker is
 * the fact a test can wait on. Sending the next key before the frame says so
 * would hand it to the slot the operator left, and the test would then blame
 * the form for its own timing.
 */
export async function tabUntilSlot(setup: Setup, slot: string, steps = 6): Promise<string> {
	let frame = await settle(setup);
	for (let step = 0; step < steps; step += 1) {
		if (frameText(frame).includes(slot)) return frame;
		setup.mockInput.pressTab();
		frame = await settle(setup);
	}
	throw new Error(`Tab never reached ${slot}\nlast frame:\n${frame}`);
}

/**
 * Type the launcher's initial input and run its visible Launch action.
 *
 * The launcher's Enter belongs to the Draft field, so the route an operator
 * walks is Tab to the action and Enter there. This helper is that route, and
 * every launcher test takes it, so no test can launch by an editing key.
 */
export async function launchConsultationDraft(setup: Setup, input: string): Promise<void> {
	await tabUntilSlot(setup, "❯ Initial input");
	await setup.mockInput.typeText(input);
	await tabUntilSlot(setup, "❯ Launch Consultation");
	setup.mockInput.pressEnter();
}

/**
 * Run the response editor's visible Send action.
 *
 * The editor's Enter belongs to the Draft field, so a reply is sent from the
 * action the operator tabs to. Every response test takes this route, so none of
 * them can send a response with an editing key.
 */
export async function sendResponseDraft(setup: Setup): Promise<void> {
	await tabUntilSlot(setup, "❯ Send response");
	setup.mockInput.pressEnter();
}

/**
 * Open the Consultation launcher, and wait until it owns the keys.
 *
 * The launcher's fields take the first keys after the open: Tab to the input,
 * the typed request, Enter to launch. A key sent before the launcher's key
 * handler subscribes is dropped by the shell below, so the wait on the key
 * bus subscription runs before any of them.
 */
export async function openLauncher(setup: Setup, title = "Consultation launcher"): Promise<string> {
	const before = keyHandlerListeners(setup);
	await press(setup, "c", "the launcher to open", (f) => f.includes(title));
	await awaitNewKeyHandler(setup, before, "the Consultation launcher to take the keys");
	return await settle(setup);
}

/**
 * Close an open key-owning surface, and wait until it releases the keys.
 *
 * The close unmounts the surface in the same commit, but the surface's key
 * handler is removed in an effect cleanup that flushes after it. A key sent
 * in that window reaches both the shell in the base mode and the stale
 * surface handler, and the two can act on it with different meanings: the
 * classic case is a guide closed and immediately reopened, where the stale
 * handler's close lands after the shell's open and the guide never appears.
 * The wait on the key bus subscription closes the window deterministically:
 * when this returns, no handler of the closed surface is still subscribed,
 * so the next key is safe.
 *
 * `title` is the substring that marks the surface open, and `closeKey` the
 * key that closes it (Escape by default, F1 or F2 where that is the
 * surface's own close alias).
 */
export async function closeOverlay(
	setup: Setup,
	title: string,
	what: string,
	closeKey: "escape" | "F1" | "F2" = "escape",
): Promise<string> {
	// The snapshot must hold the closing surface's own handler. The surface
	// is mounted and drawn, but its subscribe is a passive effect that the
	// scheduler has not run yet, and a snapshot taken in that window holds
	// only the shell's handlers, which never leave the bus: the gone-wait
	// that follows can end on nothing and misses the deadline (issue #311).
	// The flush lands every pending subscribe before the snapshot, in the
	// rig's own turn, whatever the scheduler's clock is doing.
	flushPassiveNow();
	const before = keyHandlerListeners(setup);
	if (closeKey === "F1") pressF1(setup);
	else if (closeKey === "F2") pressF2(setup);
	else setup.mockInput.pressEscape();
	await awaitFrame(setup, (f) => !f.includes(title), what);
	await awaitGoneKeyHandler(setup, before, `${what} to release the keys`);
	return await settle(setup);
}

/**
 * Open a key-owning surface on a key, and wait until it owns the keys.
 *
 * The decision and missing modals open this way: Enter from the base mounts
 * the modal in the open's commit, and the test then sends the modal's own
 * keys. The modal's key handler subscribes in the passive effect after the
 * commit, so the wait on the key bus subscription runs before any modal key.
 */
export async function openSurface(
	setup: Setup,
	key: string,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const before = keyHandlerListeners(setup);
	await press(setup, key, what, predicate);
	await awaitNewKeyHandler(setup, before, `${what} to take the keys`);
	return await settle(setup);
}

/**
 * Delete, d, and Enter open a confirmation panel over the Consultation detail
 * for the states that need one. The panel's key handler subscribes after the
 * open commit, and the next key in the test is the panel's own, so wait for
 * the panel's subscription the same way.
 */
export async function openConsultationPanel(
	setup: Setup,
	key: "delete" | "d" | "return",
	what: string,
	predicate: (frame: string) => boolean,
): Promise<void> {
	const before = keyHandlerListeners(setup);
	await press(setup, key, what, predicate);
	await awaitNewKeyHandler(setup, before, "the confirmation panel to take the keys");
}
/**
 * Walk the unified cursor into the Consultation list, and wait for it there.
 *
 * The Main view is one visible flow: the Ticket rows, then the Consultation
 * rows. `j` from the last visible Ticket crosses the boundary and lands on
 * the first Consultation row (ADR 0019). The walk presses `j` until the
 * Consultation list shows the focus marker, so a test states that it is
 * across instead of counting the Ticket rows it crossed.
 */
export async function crossToConsultations(setup: Setup, maxSteps = 30): Promise<string> {
	// The frame marks each list's retained row at once, so the cursor is on
	// the Consultation list only while the Consultation box title carries the
	// focus marker, and on the Ticket list only while its box title does.
	const onConsultations = (frame: string) =>
		frame.includes("┌─❯ Consultations") && !frame.includes("┌─❯ Tickets");
	if (!onConsultations(setup.captureCharFrame())) {
		// The detail holds the cursor: bring it back to the Ticket list first.
		if (!setup.captureCharFrame().includes("┌─❯ Tickets"))
			await press(setup, "h", "the list to take focus", (f) => f.includes("┌─❯ Tickets"));
	}
	for (let step = 0; step < maxSteps; step += 1) {
		const frame = setup.captureCharFrame();
		if (onConsultations(frame)) return frame;
		setup.mockInput.pressKey("j");
		await settle(setup, 200);
	}
	throw new Error(
		`the cursor never crossed to the Consultation list\nlast frame:\n${setup.captureCharFrame()}`,
	);
}
/**
 * Walk the unified cursor back to the Ticket list, and wait for it there.
 *
 * `k` from the first visible Consultation crosses the boundary to the last
 * Ticket row, the same walk in reverse (ADR 0019).
 *
 * The frame shows the marker on two boxes at once: the Ticket box while the
 * cursor holds the Consultation list (its retained row), and the
 * Consultation box while it holds the Ticket list. The cursor is on the
 * Ticket list once the Consultation marker row holds no Consultation row of
 * its own, that is, once the Consultation box title carries no focus marker.
 */
export async function crossToTickets(setup: Setup, maxSteps = 30): Promise<string> {
	const onTickets = (frame: string) =>
		frame.includes("┌─❯ Tickets") && !frame.includes("┌─❯ Consultations");
	if (!onTickets(setup.captureCharFrame())) {
		// The detail holds the cursor: bring it back to the Consultation list first.
		if (!setup.captureCharFrame().includes("┌─❯ Consultations"))
			await press(setup, "h", "the list to take focus", (f) => f.includes("┌─❯ Consultations"));
	}
	for (let step = 0; step < maxSteps; step += 1) {
		const frame = setup.captureCharFrame();
		if (onTickets(frame)) return frame;
		setup.mockInput.pressKey("k");
		await settle(setup, 200);
	}
	throw new Error(
		`the cursor never crossed back to the Ticket list\nlast frame:\n${setup.captureCharFrame()}`,
	);
}

/**
 * Confirm an open action panel on Enter, and wait until the panel
 * releases the keys. A key sent while the panel's unsubscribe is still
 * pending reaches the stale handler, which would run the panel's own action
 * again on the same key.
 */
export async function confirmPanel(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const before = keyHandlerListeners(setup);
	setup.mockInput.pressEnter();
	const frame = await awaitFrame(setup, predicate, what);
	await awaitGoneKeyHandler(setup, before, `${what} to release the keys`);
	return frame;
}

/**
 * Wait for the frame to stop changing, and return it.
 *
 * For keys that should change nothing, stability is the assertion, and this is
 * the wait for them: a refused control, a key a surface does not take, a row
 * that keeps its badge.
 *
 * What this does not measure is *finished*. A transition that has not started
 * is exactly as quiet as one that is over, and under a loaded runner the swap
 * is the thing that has not started, so an assertion that a frame must *not*
 * hold something a transition takes away cannot stand on this wait: it passes
 * on the frame before the swap and the test goes red on a stable screen
 * (issue #304). Such a test waits with `awaitFrame` on the fact it then
 * asserts, and asserts on the frame that wait returned.
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
