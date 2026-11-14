/**
 * The pane screen module's own seam (ADR 0147): a sequence of fake pane
 * reads - unchanged, changed, changed again - and the shaped body, which
 * changes only when the revision or the width changes. The shaping is a
 * pure function of the screen fact and the width, and its cache stands on
 * the (revision, width) pair: a render in between reads, a key press, a
 * poll, a frame, at the same pair reads the stored lines, and no test here
 * needs a terminal, a host, or a renderer.
 */
import { describe, expect, test } from "bun:test";
import {
	ansiScreen,
	ansiScreenLines,
	logScreen,
	logScreenLines,
	PaneScreenReads,
	shapeLogEntries,
	shapeVisibleText,
	TurnLogReads,
	visibleScreen,
	visibleScreenLines,
} from "../src/components/pane-screen.ts";
import { paint } from "../src/components/theme.ts";
import type { TurnLogEntry } from "../src/turn-log.ts";

const entries: readonly TurnLogEntry[] = [
	{ kind: "text", text: "The design keeps the session in memory." },
	{ kind: "tool", name: "bash", target: "npm test", failed: false },
	{ kind: "text", text: "All the tests pass." },
];

describe("PaneScreenReads", () => {
	test("a read that answers the same text hands back the same fact, and the revision stands", () => {
		const reads = new PaneScreenReads();
		const first = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		expect(first.revision).toBe(1);
		const repeat = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		expect(repeat).toBe(first);
		expect(repeat.revision).toBe(1);
	});

	test("a read that differs moves the revision, and the next differing read moves it again", () => {
		const reads = new PaneScreenReads();
		const first = reads.read("herdr", "pane-1", "visible", "first 0");
		const changed = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		expect(changed).not.toBe(first);
		expect(changed.revision).toBe(2);
		const changedAgain = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1\nthird 2");
		expect(changedAgain).not.toBe(changed);
		expect(changedAgain.revision).toBe(3);
	});

	test("a read that differs from the previous read moves the revision, even back to an older body", () => {
		const reads = new PaneScreenReads();
		const first = reads.read("herdr", "pane-1", "visible", "first 0");
		reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		// The comparison stands against the previous read, so a body that
		// returns to an older one is a change of the read, and it moves.
		const back = reads.read("herdr", "pane-1", "visible", "first 0");
		expect(back.revision).toBe(3);
	});

	test("the reads of two panes, of two hosts, and of two kinds keep their revision lines", () => {
		const reads = new PaneScreenReads();
		const paneOne = reads.read("herdr", "pane-1", "visible", "first 0");
		const paneTwo = reads.read("herdr", "pane-2", "visible", "first 0");
		expect(paneTwo.revision).toBe(1);
		const hostTwo = reads.read("herdr-core", "pane-1", "visible", "first 0");
		expect(hostTwo.revision).toBe(1);
		const ansi = reads.read("herdr", "pane-1", "ansi", "first 0");
		expect(ansi.kind).toBe("ansi");
		expect(ansi.revision).toBe(1);
		// A change on one line moves no other line on the same pane.
		const moved = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		expect(moved.revision).toBe(2);
		expect(reads.read("herdr", "pane-2", "visible", "first 0").revision).toBe(1);
		expect(reads.read("herdr-core", "pane-1", "visible", "first 0").revision).toBe(1);
		expect(reads.read("herdr", "pane-1", "ansi", "first 0").revision).toBe(1);
	});
});

describe("TurnLogReads", () => {
	test("a read that answers the same entries hands back the same fact, and the revision stands", () => {
		const reads = new TurnLogReads();
		const first = reads.read("ticket-1", entries);
		expect(first.revision).toBe(1);
		const repeat = reads.read(
			"ticket-1",
			entries.map((entry) => ({ ...entry })),
		);
		expect(repeat).toBe(first);
		expect(repeat.revision).toBe(1);
	});

	test("a read that differs moves the revision, and the logs of two tickets keep their revision lines", () => {
		const reads = new TurnLogReads();
		const first = reads.read("ticket-1", entries);
		const changed = reads.read("ticket-1", [
			...entries,
			{ kind: "text", text: "The last line stands." },
		]);
		expect(changed.revision).toBe(2);
		const other = reads.read("ticket-2", entries);
		expect(other.revision).toBe(1);
		expect(
			reads.read("ticket-1", [...entries, { kind: "text", text: "The last line stands." }])
				.revision,
		).toBe(2);
	});
});

describe("the shaped body of a read sequence", () => {
	const width = 40;
	test("unchanged, changed, changed again: the shaped body changes only when the revision moves", () => {
		const reads = new PaneScreenReads();
		const first = reads.read("herdr", "pane-1", "visible", "first 0");
		const firstLines = visibleScreenLines(first, width);
		// A render in between reads, a key press, a poll, a frame, at the
		// same revision and width reads the stored lines.
		expect(visibleScreenLines(first, width)).toBe(firstLines);
		const repeat = reads.read("herdr", "pane-1", "visible", "first 0");
		expect(visibleScreenLines(repeat, width)).toBe(firstLines);
		const changed = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1");
		const changedLines = visibleScreenLines(changed, width);
		expect(changedLines).not.toBe(firstLines);
		expect(changedLines).toEqual(["first 0", "second 1"]);
		const changedAgain = reads.read("herdr", "pane-1", "visible", "first 0\nsecond 1\nthird 2");
		const againLines = visibleScreenLines(changedAgain, width);
		expect(againLines).not.toBe(changedLines);
		expect(againLines).toEqual(["first 0", "second 1", "third 2"]);
		// The stored bodies of the earlier revisions stand on their own facts.
		expect(visibleScreenLines(changed, width)).toBe(changedLines);
	});
});

describe("shaping a screen fact at a width", () => {
	test("the same screen fact at the same width shapes to the same lines, shaped once", () => {
		const screen = visibleScreen("first 0\nsecond 1", 1);
		const once = visibleScreenLines(screen, 40);
		expect(once).toEqual(["first 0", "second 1"]);
		// A second shaping at the held width reads the cache: the stored
		// lines, not a re-wrap of the body.
		expect(visibleScreenLines(screen, 40)).toBe(once);
	});

	test("a width the fact has not stood on shapes the body once at that width, and the stored lines stand beside it", () => {
		const screen = visibleScreen("a".repeat(90) + " " + "b".repeat(90), 1);
		const wide = visibleScreenLines(screen, 60);
		expect(wide.length).toBeGreaterThan(2);
		expect(visibleScreenLines(screen, 60)).toBe(wide);
		const narrow = visibleScreenLines(screen, 30);
		expect(narrow).not.toBe(wide);
		expect(visibleScreenLines(screen, 30)).toBe(narrow);
		// The held width's lines still stand when the width moves back.
		expect(visibleScreenLines(screen, 60)).toBe(wide);
	});

	test("no shaped line overflows the width the body stands at", () => {
		const screen = visibleScreen(
			"the agent is wrapping a line that is longer than the body stands at",
			1,
		);
		for (const line of visibleScreenLines(screen, 20)) {
			expect(line.length).toBeLessThanOrEqual(20);
		}
	});

	test("the ANSI interpretation of an interaction screen fact shapes once per (revision, width) pair", () => {
		const screen = ansiScreen("\u001b[1mBold.\u001b[0m plain", 1);
		const once = ansiScreenLines(screen, 40);
		expect(once.length).toBeGreaterThan(0);
		// A render at the same pair touches the escape text only through the
		// cached screen: the stored lines, not a re-parse of the pane.
		expect(ansiScreenLines(screen, 40)).toBe(once);
		const atOtherWidth = ansiScreenLines(screen, 20);
		expect(atOtherWidth).not.toBe(once);
		expect(ansiScreenLines(screen, 20)).toBe(atOtherWidth);
	});

	test("the turn log shapes once per (revision, width) pair, and the held width's lines stand beside the new width", () => {
		const screen = logScreen(entries, 1);
		const once = logScreenLines(screen, 40);
		expect(once.length).toBeGreaterThan(1);
		expect(logScreenLines(screen, 40)).toBe(once);
		const atOtherWidth = logScreenLines(screen, 60);
		expect(atOtherWidth).not.toBe(once);
		expect(logScreenLines(screen, 60)).toBe(atOtherWidth);
		expect(logScreenLines(screen, 40)).toBe(once);
	});

	test("the shaping of a fact holds its body kind, and a fact without the body it shapes throws", () => {
		expect(() => visibleScreenLines(logScreen(entries, 1), 40)).toThrow(
			"a screen fact holds no body",
		);
		expect(() => logScreenLines(visibleScreen("first 0", 1), 40)).toThrow(
			"a screen fact holds no log",
		);
	});
});

describe("the pure cores", () => {
	test("the visible text's shaping is a pure function of the body and the width", () => {
		expect(shapeVisibleText("first 0\nsecond 1", 40)).toEqual(["first 0", "second 1"]);
		expect(shapeVisibleText("first 0\nsecond 1", 40)).toEqual(
			shapeVisibleText("first 0\nsecond 1", 40),
		);
		expect(shapeVisibleText("a".repeat(50), 10).join("\n")).not.toBe(
			shapeVisibleText("a".repeat(50), 40).join("\n"),
		);
	});

	test("the log's shaping is a pure function of the entries and the width", () => {
		expect(shapeLogEntries(entries, 40)).toEqual(shapeLogEntries(entries, 40));
		const note = shapeLogEntries([{ kind: "tool", name: "bash", target: "", failed: true }], 40);
		expect(note[0][0].text).toBe("▸ bash");
		// A failed call wears the warning color the theme answers.
		expect(note[0][0].fg).toBe(paint("yellow"));
	});
});
