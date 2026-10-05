/**
 * The one name a record line gives a Ticket (issue #295 review).
 *
 * The boot's line for a claim a previous run left unsettled names the same
 * Ticket the dispatch named when it started that claim, and the two lines stand
 * in one file. Two name rules can drift, and the drift is invisible until a
 * reader greps for a Ticket and gets half its record, so the rule lives in one
 * module. This suite holds the two answers it gives and refuses a second copy
 * of it anywhere in the plane.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recordTicketName } from "../src/domain/record-name.ts";
import { openFactoryState } from "../src/state.ts";
import { cleanup, fetched, sourceA, success } from "./state/harness.ts";
import { sourceFiles } from "./static-checks.ts";

afterEach(cleanup);

const LISTED = "github:github.com:I_5";

/**
 * The projection the state answers for one listed Ticket. The aggregate makes
 * every projection (ADR 0093), so the test asks for one the same way a surface
 * does instead of building a value the state never ran.
 */
function projection() {
	const state = openFactoryState(":memory:");
	state.sourceFact.initializeSources([sourceA]);
	state.sourceFact.applyFetch(sourceA, success([fetched(LISTED)]));
	return { state, read: state.ticketWorkCycle.ticketProjection([], "implement") };
}

describe("the record's Ticket name (issue #295 review)", () => {
	test("a Ticket the projection holds wears its title in quotes", () => {
		const { state, read } = projection();
		expect(recordTicketName(read, LISTED)).toBe('"Persist source facts"');
		state.close();
	});

	test("a Ticket the projection holds no row for is named by its identity", () => {
		// The Ticket the sources stopped listing, or the one a previous run's
		// attempt names while this run has fetched nothing about it yet.
		const { state, read } = projection();
		expect(recordTicketName(read, "github:github.com:I_9")).toBe("ticket github:github.com:I_9");
		state.close();
	});

	test("no other file restates the name rule", () => {
		// The rule is the pair: the title in quotes, and the identity the line
		// falls back to. Three surfaces read it - the Handoff dispatch, the
		// observation cycle, and the boot - and each had its own copy until
		// issue #295. A fourth copy is the drift the shared module exists to stop.
		const shapes = [/`ticket \$\{[^}]*\}`\s*:\s*`"\$\{/u, /`"\$\{[^}]*\}"`\s*:\s*`ticket \$\{/u];
		const offenders = sourceFiles("src")
			.filter((file) => file !== "src/domain/record-name.ts")
			.filter((file) => {
				const code = readFileSync(file, "utf8");
				return shapes.some((shape) => shape.test(code));
			});
		expect(offenders).toEqual([]);
		// The scan is not vacuous: a copy written the way the four copies were is
		// caught by it. The placeholder and the backticks are escaped, so this file
		// holds no live template of its own.
		const restatement = `const name = title === undefined ? \`ticket \${identity}\` : \`"\${title}"\`;`;
		expect(shapes.some((shape) => shape.test(restatement))).toBe(true);
	});
});
