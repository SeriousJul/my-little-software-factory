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
 * exact title literal in the frame suites; the suites take the title from the
 * shared fact module, and their builders take the ticket from the shared
 * `fetchedTicket` builder.
 *
 * The module suites are not frame suites: they take the plane's parts, not its
 * props, and they may open a state of their own, so the check reads only the
 * files that import the harness.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sourceFiles } from "./static-checks.ts";

const frameSuites = sourceFiles(
	"test",
	(file) =>
		file.endsWith(".test.ts") &&
		file !== "test/seeded-plane-check.test.ts" &&
		readFileSync(file, "utf8").includes('from "./app-harness.ts"'),
);

/** A state opener a frame suite must not reach for: the plane owns the opening. */
const OPENS_STATE = /openFactoryState\s*\(/u;

/**
 * The default Ticket's title, quoted, split so this check's own source holds
 * no match for the rule it applies. A frame file that spells this literal
 * builds or reads the default Ticket outside the plane's one copy of it.
 */
const DEFAULT_TITLE_LITERAL = '"Persist source ' + 'facts"';
const SPELLS_DEFAULT_TITLE = new RegExp(DEFAULT_TITLE_LITERAL, "u");

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
		// The default title stands in the fact module, the one owner of it.
		expect(readFileSync("test/fact-fixtures.ts", "utf8")).toContain(DEFAULT_TITLE_LITERAL);
	});

	test("a frame suite never spells the default Ticket's title by hand", () => {
		const offenders: string[] = [];
		for (const file of frameSuites) {
			const source = readFileSync(file, "utf8");
			if (SPELLS_DEFAULT_TITLE.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the opener pattern still matches the bypass it refuses", () => {
		expect(OPENS_STATE.test("const state = openFactoryState(path);")).toBe(true);
		expect(SPELLS_DEFAULT_TITLE.test('title: "Persist source facts"')).toBe(true);
		expect(SPELLS_DEFAULT_TITLE.test("title: DEFAULT_TICKET_TITLE")).toBe(false);
	});
});
