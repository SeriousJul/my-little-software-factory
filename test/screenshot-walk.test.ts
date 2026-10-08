/**
 * The screenshot fixture's walk, driven at the unit layer.
 *
 * The load flake (issue #303): the walk pressed a key and slept 150 ms, and
 * on a loaded runner the repaint landed later than the sleep, so the next
 * step read the frame the previous press had not yet painted, and a late
 * repaint spent a step of the budget. The reproduction here is the same race
 * at the unit layer: a fake screen whose repaint is held 250 ms behind its
 * presses, run on a fake clock. The old fixed-sleep walk goes red under the
 * hold, and the frame-waiting walk goes green under the same hold.
 *
 * The second half of the flake: a frame caught mid-redraw (the section
 * border or the cursor mark briefly undrawn) read as a move that did not
 * happen, and the walk pressed on while its model of the cursor stood a row
 * behind the screen's. The walk now reads the row's index and text from one
 * parse and acts only on a row two polls confirm, and these tests hold the
 * glitch frames the capture met under load.
 */

import { describe, expect, it } from "bun:test";
import {
	PRESS_DEADLINE_MS,
	type ScreenWalk,
	stepUntilRow,
	WALK_DEADLINE_MS,
} from "../scripts/screenshot-fixture.ts";

/**
 * The old walk, kept here as the reproduction, not the implementation: a
 * fixed 150 ms sleep after each press.
 */
async function stepUntilRowOnFixedSleeps(
	screen: ScreenWalk,
	fields: {
		match: string;
		keyName: string;
		maxSteps: number;
		sleep: (ms: number) => Promise<void>;
	},
): Promise<void> {
	const { match, keyName, maxSteps, sleep } = fields;
	for (let steps = 0; steps < maxSteps; steps++) {
		if (screen.cursorRow().text.includes(match)) return;
		screen.key(keyName);
		await sleep(150);
	}
	if (!screen.cursorRow().text.includes(match)) {
		throw new Error(
			`the cursor never reached a row matching "${match}" within ${maxSteps} "${keyName}" steps`,
		);
	}
}

interface FakeScreen extends ScreenWalk {
	/** Advance the fake clock by one poll. */
	sleepFn(ms: number): Promise<void>;
	/** The fake clock the walk's deadline runs on. */
	now(): number;
	/** Every key the walk pressed, in order. */
	presses: string[];
	/** The row the cursor holds. */
	cursorIndex(): number;
}

/**
 * A fake screen over a fixed row list. A press schedules the cursor's move
 * for `repaintDelayMs` behind the press, and the walk only sees it when the
 * fake clock passes that time: the renderer holding its frame.
 *
 * With `glitchEvery`, every Nth read of the cursor's row reports the
 * mid-redraw frame - index -1, no text - the way a section transition
 * leaves the border and the mark briefly undrawn.
 */
function fakeScreen(
	rows: string[],
	start: number,
	repaintDelayMs: number,
	glitchEvery = 0,
): FakeScreen {
	let clockMs = 0;
	let cursor = start;
	let reads = 0;
	const due: { at: number; run: () => void }[] = [];
	const presses: string[] = [];
	const advance = (ms: number): void => {
		clockMs += ms;
		for (let i = due.length - 1; i >= 0; i--) {
			if (due[i].at <= clockMs) {
				const job = due[i];
				due.splice(i, 1);
				job.run();
			}
		}
	};
	return {
		cursorRow: () => {
			reads += 1;
			if (glitchEvery > 0 && reads % glitchEvery === 0) return { index: -1, text: "" };
			return { index: cursor, text: rows[cursor] };
		},
		gridText: () => rows.join("\n"),
		key: (bytes: string) => {
			presses.push(bytes);
			const delta = bytes === "j" ? 1 : bytes === "k" ? -1 : 0;
			const target = Math.max(0, Math.min(rows.length - 1, cursor + delta));
			if (target === cursor) return;
			due.push({
				at: clockMs + repaintDelayMs,
				run: () => {
					cursor = target;
				},
			});
		},
		sleepFn: async (ms: number) => {
			advance(ms);
		},
		now: () => clockMs,
		presses,
		cursorIndex: () => cursor,
	};
}

// The geometry of the capture's first step: the cursor starts on the Group
// header, and the target row sits three rows below it.
const ROWS = [
	"SeriousJul/my-little-software-factory (3)",
	"Split the README into published guides",
	"Retry failed webhook deliveries with a bounded backoff",
	"Rank tickets by priority label",
];
const MATCH = "Rank tickets by priori";
const MAX_STEPS = 3;
// The hold the flake met under load: the repaint lands later than the old
// fixed sleep.
const HELD_REPAINT_MS = 250;

describe("the screenshot fixture's walk", () => {
	it("the fixed-sleep walk goes red under a held repaint", async () => {
		const screen = fakeScreen(ROWS, 0, HELD_REPAINT_MS);
		await expect(
			stepUntilRowOnFixedSleeps(screen, {
				match: MATCH,
				keyName: "j",
				maxSteps: MAX_STEPS,
				sleep: screen.sleepFn,
			}),
		).rejects.toThrow(`never reached a row matching "${MATCH}"`);
	});

	it("goes green under the same held repaint, on the frame", async () => {
		const screen = fakeScreen(ROWS, 0, HELD_REPAINT_MS);
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		expect(screen.presses).toEqual(["j", "j", "j"]);
	});

	it("steps a fast screen one row per press", async () => {
		const screen = fakeScreen(ROWS, 0, 0);
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		expect(screen.presses).toEqual(["j", "j", "j"]);
	});

	it("presses no key when the cursor already holds the match", async () => {
		const screen = fakeScreen(ROWS, 3, 0);
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.presses).toEqual([]);
	});

	it("re-presses a dropped key without charging the step budget", async () => {
		// The screen swallows the first press of each pair: the boot window
		// eats the key the list has not yet taken. The walk has to land the
		// rows it counts, dropped presses excluded.
		let pressed = 0;
		const screen = fakeScreen(ROWS, 0, 0);
		const realKey = screen.key;
		screen.key = (bytes: string) => {
			pressed += 1;
			if (pressed % 2 === 1) return;
			realKey(bytes);
		};
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		expect(pressed).toBe(6); // three dropped, three landed
	});

	it("fails at the walk's deadline when the screen never repaints", async () => {
		const screen = fakeScreen(ROWS, 0, Number.POSITIVE_INFINITY);
		await expect(
			stepUntilRow(screen, MATCH, "j", {
				maxSteps: MAX_STEPS,
				sleepFn: screen.sleepFn,
				now: screen.now,
			}),
		).rejects.toThrow(`never reached a row matching "${MATCH}"`);
		// One press at the start, one re-press every press deadline up to the
		// walk's deadline: the walk's budget in press-deadlines, the harness's
		// doubling in CI included.
		expect(screen.presses.length).toBe(WALK_DEADLINE_MS / PRESS_DEADLINE_MS);
	});

	it("does not count a mid-redraw frame as a move", async () => {
		// Every third read of the cursor's row is the mid-redraw frame the
		// capture met crossing a section border: the border and the mark
		// briefly undrawn, index -1. The walk has to press exactly the rows
		// it counts - no press spent on a frame that showed no row.
		const screen = fakeScreen(ROWS, 0, 0, 3);
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		expect(screen.presses).toEqual(["j", "j", "j"]);
	});

	it("does not charge a dropped press when the glitch spans two polls", async () => {
		// The glitch window lasts two polls: two reads back to back stand on
		// the mid-redraw frame, the hold the capture met crossing a section
		// border, and the screen swallows the walk's first press, the boot
		// window. The two together hand the walk a confirmed -1 row, and the
		// dropped press then meets the first confirmed real row: the index
		// differs from -1, so the press the screen spent no row on reads as a
		// move and spends a step of the budget the cursor never crossed.
		const screen = fakeScreen(ROWS, 0, 0);
		const realCursorRow = screen.cursorRow;
		let reads = 0;
		screen.cursorRow = () => {
			reads += 1;
			// Two real reads, then two glitch reads, then two real: the
			// glitch window spans the walk's poll gap, the way a section
			// transition's did under load.
			if ((reads - 1) % 4 >= 2) return { index: -1, text: "" };
			return realCursorRow();
		};
		let pressed = 0;
		const realKey = screen.key;
		screen.key = (bytes: string) => {
			pressed += 1;
			if (pressed === 1) return;
			realKey(bytes);
		};
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		// One press dropped in the boot window, three rows landed: the
		// dropped press spent no row, so it spent no step of the three-step
		// budget.
		expect(pressed).toBe(4);
		expect(screen.presses).toEqual(["j", "j", "j"]);
	});

	it("does not press on past a match a stale frame held back", async () => {
		// The repaint lands one press behind the walk's poll, the late
		// repaint the loaded runner held. When the target's frame finally
		// stands still, the walk stands with it: the press count equals the
		// rows the cursor crossed, never one ahead of the screen.
		const screen = fakeScreen(ROWS, 0, 30);
		await stepUntilRow(screen, MATCH, "j", {
			maxSteps: MAX_STEPS,
			sleepFn: screen.sleepFn,
			now: screen.now,
		});
		expect(screen.cursorIndex()).toBe(3);
		expect(screen.presses).toEqual(["j", "j", "j"]);
	});
});
