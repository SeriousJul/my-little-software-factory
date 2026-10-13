/**
 * The frame suites open the Seeded plane, not the state file, and they build
 * no Ticket of the default by hand.
 *
 * A frame test that imports the app harness boots the whole App, so its state
 * is the plane's: state, config path, home, and checkout all come through the
 * plane's props. A frame file that still calls the state opener by hand owns a
 * second state the plane does not know about, and the App renders one while the
 * test asserts on the other. The rule is a declared dependency rule, the way
 * the shared-control check is one: it reads the sources and refuses the
 * bypass, and the flow tests that drive the real frames carry the behavior.
 *
 * The plane's own re-open seam is not the bypass: a suite that re-opens the
 * plane's state file through the plane's `reopenState` still reads the state
 * the plane opened, so the check refuses only the raw state opener.
 *
 * A frame suite that spells the default Ticket's title in a fetched ticket, a
 * naming derivation, or a frame pin holds its own copy of the plane's default
 * Ticket: the plane stands the default on one identity, one title, and one
 * naming fact, and a frame suite that re-spells the title can pass on a
 * Ticket no other reader of the plane would build. The check refuses the
 * title's text anywhere in the frame suites, a pin's quoted word among it,
 * and the suites take the title from the shared fact module, their pins
 * composed from its one copy.
 *
 * The module suites are not frame suites: they take the plane's parts, not its
 * props, and they may open a state of their own, so the check reads only the
 * files that import the harness.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { DEFAULT_TICKET_TITLE } from "./fact-fixtures.ts";
import { sourceFiles } from "./static-checks.ts";

/**
 * The app harness import at any relative depth: a suite nested in a
 * subdirectory of the test directory reaches the harness through `../` and
 * deeper, and the frame suites stand at every depth the tree holds, so the
 * match takes the relative path, not its length.
 */
const HARNESS_IMPORT = /from\s+"(?:\.\.?\/)+app-harness\.ts"/u;

const frameSuites = sourceFiles(
	"test",
	(file) =>
		file.endsWith(".test.ts") &&
		file !== "test/seeded-plane-check.test.ts" &&
		HARNESS_IMPORT.test(readFileSync(file, "utf8")),
);

/** A state opener a frame suite must not reach for: the plane owns the opening. */
const OPENS_STATE = /openFactoryState\s*\(/u;

/**
 * The quoted title as the fact module defines it, split so this check's own
 * source holds no match for the rule it applies.
 */
const QUOTED_TITLE = '"Persist source ' + 'facts"';
/**
 * A frame file that holds the title's text anywhere, a pin's quoted word
 * among it, builds or reads the default Ticket outside the plane's one copy
 * of it. The guard is what follows the text: a pin ends the title at a quote
 * or other mark, and the sample's other ticket, the one whose title carries
 * this one's words before more of its own, keeps them running on the same
 * line. The rule takes the title as one word, not as a run of letters, and
 * the gap the first draft left is closed: a title that ends at a line end
 * or at the end of the text stands finished, the way a pin's does, and the
 * continuation that passes is a word or a hyphen on the title's own line.
 */
const SPELLS_DEFAULT_TITLE = (source: string): boolean =>
	new RegExp(
		DEFAULT_TICKET_TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?!(?:[ \\t]*[\\w-]))",
		"u",
	).test(source);

describe("the frame suites open state through the Seeded plane", () => {
	test("a frame suite never opens a state file by hand", () => {
		const offenders: string[] = [];
		for (const file of frameSuites) {
			const source = readFileSync(file, "utf8");
			if (OPENS_STATE.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the check reads a real set of frame suites", () => {
		// A rule that matches nothing proves nothing: the harness is imported
		// by the app frame suite and the handoff frame suite at least, so the
		// walked set cannot be empty while the tree holds those files.
		expect(frameSuites.length).toBeGreaterThan(10);
		expect(frameSuites).toContain("test/app.test.ts");
		// The harness import match holds at any relative depth, a nested
		// suite's `../` among them.
		expect(HARNESS_IMPORT.test('import { settle } from "./app-harness.ts";')).toBe(true);
		expect(HARNESS_IMPORT.test('import { settle } from "../app-harness.ts";')).toBe(true);
		expect(HARNESS_IMPORT.test('import { settle } from "../../app-harness.ts";')).toBe(true);
		expect(HARNESS_IMPORT.test('import { settle } from "app-harness.ts";')).toBe(false);
		// The default title stands in the fact module, the one owner of it.
		expect(readFileSync("test/fact-fixtures.ts", "utf8")).toContain(QUOTED_TITLE);
	});

	test("a frame suite never spells the default Ticket's title by hand", () => {
		const offenders: string[] = [];
		for (const file of frameSuites) {
			if (SPELLS_DEFAULT_TITLE(readFileSync(file, "utf8"))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the opener pattern still matches the bypass it refuses", () => {
		expect(OPENS_STATE.test("const state = openFactoryState(path);")).toBe(true);
		expect(SPELLS_DEFAULT_TITLE('title: "Persist source facts"')).toBe(true);
		expect(SPELLS_DEFAULT_TITLE('f.includes("Close: Persist source facts")')).toBe(true);
		// The sample's other ticket keeps the title's words running on the
		// same line, and the guard lets its pin stand.
		expect(SPELLS_DEFAULT_TITLE('title: "Persist source facts in state"')).toBe(false);
		expect(SPELLS_DEFAULT_TITLE("title: DEFAULT_TICKET_TITLE")).toBe(false);
		// The line-end gap is closed: a title that stands finished at a line
		// end or at the end of the text is a spelling, and the guard takes it.
		expect(SPELLS_DEFAULT_TITLE('title: "Persist source facts"\n')).toBe(true);
		expect(SPELLS_DEFAULT_TITLE('"Persist source facts"')).toBe(true);
	});
});
