/**
 * The fact modules own the screen's facts (issue #201).
 *
 * The spec's rule is story 27: App holds state, effects, key dispatch, and
 * Agent actions, and a fact rule is never found in two places. The four Ticket
 * predicate props this work removed are the shape that rule refuses - a surface
 * that takes `isFailure?: (ticket) => boolean` owns the rule again, and the
 * gallery has to invent an answer for it. These checks read the source and name
 * the drift by file, the way the shared control library's checks do.
 *
 * The rule is a declared dependency rule, not a behavior test: what the operator
 * sees is checked by the frame tests that drive the real screens.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

/** The Ticket surfaces the spec names: the list, the detail, and the Section header. */
const TICKET_SURFACES = [
	"src/components/ticket-list.ts",
	"src/components/ticket-detail.ts",
	"src/components/section-header.ts",
];

/** The domain's fact modules. */
const FACT_MODULES = [
	"src/domain/ticket-facts.ts",
	"src/domain/section-facts.ts",
	"src/domain/decision-facts.ts",
];

/** One file's props interfaces, with their comments stripped. */
function propsCode(file: string): string {
	const source = readFileSync(file, "utf8");
	const blocks = source.match(/interface\s+\w*Props\s*\{[\s\S]*?\n\}/gu) ?? [];
	return blocks.map((block) => block.replace(/\/\*[\s\S]*?\*\//gu, "")).join("\n");
}

describe("the fact modules own the screen's facts", () => {
	test("no Ticket surface takes a fact as a predicate callback prop", () => {
		// A property whose type is a function answering `true` or `false` about a
		// Ticket is the removed prop back again: `isFailure`, `isStarting`,
		// `isQueued`, `isHeld`. The fact module answers those as values, so a
		// surface that asks for the predicate owns the rule and the gallery has
		// to invent one.
		const offenders: string[] = [];
		for (const file of TICKET_SURFACES) {
			for (const line of propsCode(file).split("\n")) {
				const declaration = line.trim();
				if (/^[A-Za-z_$][\w$]*\??\s*:\s*.*=>\s*boolean/u.test(declaration)) {
					offenders.push(`${file}: ${declaration}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the Ticket surfaces take their facts from the fact module", () => {
		// The list and the detail render the fact record the module answers, so a
		// migration cannot quietly hand one of them its Ticket back.
		for (const file of ["src/components/ticket-list.ts", "src/components/ticket-detail.ts"]) {
			expect(readFileSync(file, "utf8"), `${file} must render the fact module's record`).toContain(
				"TicketRowFacts",
			);
		}
	});

	test("no screen re-derives the in-flight fact", () => {
		// `state === "handed-off" || state === "running"`, in either polarity, is
		// the fact the Ticket fact module owns. A screen that spells it holds a
		// second copy the row's badge and the seat count can drift from.
		const patterns = [
			/state\s*===\s*"handed-off"\s*\|\|[^;]{0,80}?state\s*===\s*"running"/u,
			/state\s*!==\s*"handed-off"\s*&&[^;]{0,80}?state\s*!==\s*"running"/u,
		];
		const offenders: string[] = [];
		for (const file of sourceFiles("src/components")) {
			const source = readFileSync(file, "utf8");
			if (patterns.some((pattern) => pattern.test(source))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the shared grouping takes the held fact from the fact module's record", () => {
		// The grouping mechanism is generic over the row it draws. Its Ticket
		// entry point hands it the fact record, so the held rule is not read a
		// second time on the way to a Group header.
		const grouping = readFileSync("src/components/shared/grouping.ts", "utf8");
		expect(grouping).not.toContain("holdsDecision");
		expect(grouping).toContain("TicketRowFacts");
	});

	test("the fact modules hold no renderer and no palette", () => {
		// A fact is a value a surface paints (ADR 0024). A fact module that
		// mounts a renderable or stores a color has taken the surface's job.
		const offenders: string[] = [];
		for (const file of FACT_MODULES) {
			const source = readFileSync(file, "utf8");
			if (/@opentui|createElement|["']#[0-9a-fA-F]{3,8}["']/u.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("no surface holds a copy of the Missing agent rule", () => {
		// `ownAgentInPane` is herdr's name test. The plane's Missing agent rule is
		// the domain's `agentInPane`, and every reader calls it, so the row's
		// badge and the Parallel limit seat count cannot disagree about one pane.
		const offenders: string[] = [];
		for (const file of sourceFiles("src")) {
			if (file === "src/herdr.ts" || file === "src/domain/agent.ts") continue;
			if (/\bownAgentInPane\b/u.test(readFileSync(file, "utf8"))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
