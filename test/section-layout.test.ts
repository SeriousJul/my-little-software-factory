/**
 * The Main view's one Section table (ADR 0019, ADR 0034).
 *
 * The left column's row plan and the cursor's flow read the same shape, so a
 * review can check the frame's arithmetic and the crossing's rule in one
 * place instead of measuring a terminal. The frames that prove the same rules
 * on the running app live in `test/main-view-frame.test.ts` and
 * `test/work-queue-frame.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
	type MainSectionId,
	planSectionBoxes,
	type SectionFlowEntry,
	stepSectionFlow,
} from "../src/components/geometry.ts";

/** The rows a box holds: two borders and two padding rows around its text. */
const CHROME = 4;
const MINIMUM = 3 + CHROME;
const FLOOR = 1 + CHROME;

const plan = (
	totalRows: number,
	cursor: MainSectionId,
	depths: Record<MainSectionId, number>,
	open: Partial<Record<MainSectionId, boolean>> = {},
) =>
	planSectionBoxes({
		totalRows,
		minimumRows: MINIMUM,
		floorRows: FLOOR,
		cursor,
		sections: (["ticket", "consultation", "work"] as const).map((section) => ({
			section,
			open: open[section] ?? true,
			depth: depths[section],
		})),
	});

const flow = (
	entries: Array<[MainSectionId, boolean, boolean, number, number]>,
): SectionFlowEntry[] =>
	entries.map(([section, open, held, depth, index]) => ({ section, open, held, depth, index }));

describe("the Main view's Section row plan (issue #88)", () => {
	test("the cursor's section takes the rest after the others claim their minimum", () => {
		// 120x30: the body shares 24 rows among the boxes.
		const boxes = plan(24, "ticket", { ticket: 9, consultation: 2, work: 1 });
		expect(boxes.ticket).toEqual({ open: true, rows: 10 });
		expect(boxes.consultation).toEqual({ open: true, rows: MINIMUM });
		expect(boxes.work).toEqual({ open: true, rows: MINIMUM });
	});

	test("an empty section claims its floor, not its minimum", () => {
		// The rows an empty list does not use go to the list being worked.
		const boxes = plan(18, "ticket", { ticket: 9, consultation: 0, work: 0 });
		expect(boxes.consultation.rows).toBe(FLOOR);
		expect(boxes.work.rows).toBe(FLOOR);
		expect(boxes.ticket.rows).toBe(18 - FLOOR * 2);
	});

	test("a section that cannot hold its floor collapses, and its header stays", () => {
		// 40x19: the body holds 13 rows, which pays the cursor's minimum and
		// one floor box, and nothing more.
		const boxes = plan(13, "ticket", { ticket: 9, consultation: 1, work: 0 });
		expect(boxes.ticket.open).toBe(true);
		expect(boxes.consultation).toEqual({ open: true, rows: FLOOR });
		expect(boxes.work).toEqual({ open: false, rows: 0 });
	});

	test("the lowest section gives way first, and an empty one before that", () => {
		// The Work queue holds rows, the Consultation list holds none, and the
		// body pays two boxes: the empty Consultation section gives way, not
		// the queue the operator is waiting on.
		const boxes = plan(14, "ticket", { ticket: 9, consultation: 0, work: 2 });
		expect(boxes.consultation.open).toBe(false);
		expect(boxes.work.open).toBe(true);
		// And with both lower sections holding rows, the lowest one gives way.
		const both = plan(14, "ticket", { ticket: 9, consultation: 2, work: 2 });
		expect(both.consultation.open).toBe(true);
		expect(both.work.open).toBe(false);
	});

	test("the cursor's section never gives way, wherever it rests", () => {
		for (const cursor of ["ticket", "consultation", "work"] as const) {
			const boxes = plan(7, cursor, { ticket: 2, consultation: 2, work: 2 });
			expect(boxes[cursor]).toEqual({ open: true, rows: 7 });
			for (const section of ["ticket", "consultation", "work"] as const) {
				if (section === cursor) continue;
				expect(boxes[section].open, `${cursor} holds the rows against ${section}`).toBe(false);
			}
		}
	});

	test("a section the operator collapsed claims nothing", () => {
		const boxes = plan(
			18,
			"ticket",
			{ ticket: 9, consultation: 3, work: 2 },
			{
				consultation: false,
			},
		);
		expect(boxes.consultation).toEqual({ open: false, rows: 0 });
		expect(boxes.ticket.rows + boxes.work.rows).toBe(18);
		expect(boxes.work.rows).toBe(MINIMUM);
	});

	test("no body rows pays no box", () => {
		const boxes = plan(0, "ticket", { ticket: 1, consultation: 1, work: 1 });
		expect(boxes.ticket).toEqual({ open: false, rows: 0 });
	});
});

describe("the Main view's cursor flow (issue #88)", () => {
	const allOpen = flow([
		["ticket", true, true, 3, 0],
		["consultation", true, true, 2, 0],
		["work", true, true, 2, 0],
	]);

	test("a step moves the row inside the section, and crosses at its edge", () => {
		expect(stepSectionFlow(allOpen, "ticket", 1)).toEqual({ section: "ticket", index: 1 });
		const atLast = flow([
			["ticket", true, true, 3, 2],
			["consultation", true, true, 2, 0],
			["work", true, true, 2, 0],
		]);
		expect(stepSectionFlow(atLast, "ticket", 1)).toEqual({ section: "consultation", index: 0 });
		expect(stepSectionFlow(allOpen, "consultation", -1)).toEqual({
			section: "ticket",
			index: 2,
		});
	});

	test("a step past the flow's ends answers nothing", () => {
		expect(stepSectionFlow(allOpen, "ticket", -1)).toBeNull();
		const atWorkLast = flow([
			["ticket", true, true, 3, 0],
			["consultation", true, true, 2, 0],
			["work", true, true, 2, 1],
		]);
		expect(stepSectionFlow(atWorkLast, "work", 1)).toBeNull();
	});

	test("the cross skips a section the operator collapsed, both ways", () => {
		const consultationClosed = flow([
			["ticket", true, true, 3, 2],
			["consultation", false, false, 2, 0],
			["work", true, true, 2, 0],
		]);
		expect(stepSectionFlow(consultationClosed, "ticket", 1)).toEqual({
			section: "work",
			index: 0,
		});
		const onWorkFirst = flow([
			["ticket", true, true, 3, 2],
			["consultation", false, false, 2, 0],
			["work", true, true, 2, 0],
		]);
		expect(stepSectionFlow(onWorkFirst, "work", -1)).toEqual({
			section: "ticket",
			index: 2,
		});
	});

	test("the cross reaches a section the frame cannot show, and holds its last row", () => {
		// The Work queue is off screen because the body cannot pay its floor
		// box, and the operator still holds it open: the step lands on it, and
		// the row plan gives it its minimum on the cursor's own claim.
		const queueHidden = flow([
			["ticket", true, true, 3, 2],
			["consultation", true, true, 2, 1],
			["work", false, true, 2, 0],
		]);
		expect(stepSectionFlow(queueHidden, "consultation", 1)).toEqual({
			section: "work",
			index: 0,
		});
		const onQueue = flow([
			["ticket", true, true, 3, 2],
			["consultation", true, true, 2, 1],
			["work", false, true, 2, 0],
		]);
		expect(stepSectionFlow(onQueue, "work", -1)).toEqual({ section: "consultation", index: 1 });
	});

	test("an empty section still holds the row the cursor takes", () => {
		const emptyQueue = flow([
			["ticket", true, true, 3, 2],
			["consultation", true, true, 0, 0],
			["work", true, true, 2, 1],
		]);
		expect(stepSectionFlow(emptyQueue, "ticket", 1)).toEqual({
			section: "consultation",
			index: 0,
		});
		// And a step out of the empty row goes to the first row of the
		// section below it.
		expect(stepSectionFlow(emptyQueue, "consultation", 1)).toEqual({
			section: "work",
			index: 0,
		});
	});
});
