/** Deterministic wheel-burst policy tests for the native Ticket detail viewport. */
import { describe, expect, test } from "bun:test";
import {
	type DetailLine,
	detailLines,
	newWheelBurst,
	WHEEL_ACCELERATION_PAUSE_MS,
	wheelRows,
} from "../src/components/ticket-detail.ts";
import type { ScrollConfig } from "../src/config.ts";
import type { Handoff, Ticket } from "../src/domain/ticket.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { roleColor } from "./app-harness.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const settings: ScrollConfig = { speed: 1, acceleration: 0.8, maximumSpeed: 6 };

/** The cells one line paints: a plain line is one cell of its own text. */
const cellsOf = (line: DetailLine) => line.cells ?? [{ text: line.text, fg: line.fg }];

/** Whether the content states the fact in one of its cells, in the given color. */
const hasCell = (lines: DetailLine[], text: string, fg?: string) =>
	lines.some((line) =>
		cellsOf(line).some(
			(cell) => cell.text.trimEnd() === text && (fg === undefined || cell.fg === fg),
		),
	);

/** The Agent column's fact lines, in screen order. */
const leftOrder = (lines: DetailLine[]): string[] =>
	lines
		.map((line) => line.cells?.[0]?.text.trimEnd())
		.filter((text): text is string => text !== undefined && text !== "");

/** The choices one closed work cycle left behind on its ticket. */
const recordedHandoff: Handoff = {
	agentType: "codex",
	environment: "worktree",
	taskType: "implement",
	model: "old-cycle-model",
	thinking: "high",
	contextWindow: "65536",
	attemptId: "attempt-old-cycle",
	paneId: "pane-old-cycle",
	tabId: "tab-old-cycle",
	workspaceId: "ws-old-cycle",
	herdrName: "persist-source-facts",
};

/** The choice an open ticket's profile resolves to: pi, and nothing named. */
const nextChoice: HandoffChoice = {
	agentType: "pi",
	environment: "live-worktree",
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

describe("Ticket detail task profile", () => {
	test("shows the suggested effective settings and dims values left to the agent", () => {
		const ticket = SAMPLE_TICKETS[0];
		if (ticket === undefined) throw new Error("missing sample ticket");
		const lines = detailLines(ticket, 100, 10, {
			agentType: "codex",
			environment: "live-worktree",
			taskType: "implement",
			model: "task-model",
			thinking: "",
			contextWindow: "272000",
		});
		expect(hasCell(lines, "Agent: codex", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Model: task-model", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Thinking: left to agent", roleColor("subtext0"))).toBe(true);
		// A count the profile names reads like any other value; the digits are
		// the value, so the detail never reformats them.
		expect(hasCell(lines, "Context: 272000", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Environment: live-worktree", roleColor("text"))).toBe(true);
		// The rows read in the order the override panel offers them: where a
		// Handoff runs, then what it runs with.
		const order = leftOrder(lines);
		expect(order.indexOf("Environment: live-worktree")).toBeGreaterThan(
			order.indexOf("Agent: codex"),
		);
		expect(order.indexOf("Model: task-model")).toBeGreaterThan(
			order.indexOf("Environment: live-worktree"),
		);
	});

	test("takes the Ticket state as the switch between the two choices", () => {
		const open = SAMPLE_TICKETS[0];
		if (open === undefined) throw new Error("missing sample ticket");
		// A close leaves the Handoff record behind while the ticket returns to
		// open, so an open ticket reads its next Handoff's choice: the record's
		// settings are history, and the rows must state what Enter starts.
		const secondCycle: Ticket = {
			...open,
			handoff: recordedHandoff,
			handoffCount: 1,
		};
		const next = detailLines(secondCycle, 100, 10, nextChoice);
		expect(hasCell(next, "Agent: pi", roleColor("text"))).toBe(true);
		expect(hasCell(next, "Model: left to agent", roleColor("subtext0"))).toBe(true);
		expect(hasCell(next, "Environment: live-worktree", roleColor("text"))).toBe(true);
		expect(next.some((line) => line.text.includes("old-cycle-model"))).toBe(false);

		// A ticket inside a cycle shows that cycle's own Handoff, because those
		// are the settings its running agent started with.
		const running: Ticket = { ...secondCycle, state: "running" };
		const shown = detailLines(running, 100, 10, nextChoice);
		expect(hasCell(shown, "Agent: codex", roleColor("text"))).toBe(true);
		expect(hasCell(shown, "Model: old-cycle-model", roleColor("text"))).toBe(true);
		expect(hasCell(shown, "Thinking: high", roleColor("text"))).toBe(true);
		expect(hasCell(shown, "Context: 65536", roleColor("text"))).toBe(true);
		expect(hasCell(shown, "Environment: worktree", roleColor("text"))).toBe(true);
	});
});

describe("Ticket detail wheel acceleration", () => {
	test("starts precisely, accelerates during a burst, and caps speed", () => {
		const burst = newWheelBurst();
		expect(wheelRows(settings, burst, "down", 0, true)).toBe(1);
		expect(wheelRows(settings, burst, "down", 50, true)).toBeGreaterThan(1);
		for (let now = 55; now < 100; now += 5) {
			wheelRows(settings, burst, "down", now, true);
		}
		expect(wheelRows(settings, burst, "down", 105, true)).toBeLessThanOrEqual(6);
	});

	test("resets after a pause, reversal, or blocked movement", () => {
		const burst = newWheelBurst();
		expect(wheelRows(settings, burst, "down", 0, true)).toBe(1);
		expect(wheelRows(settings, burst, "down", 50, true)).toBeGreaterThan(1);
		expect(wheelRows(settings, burst, "down", 50 + WHEEL_ACCELERATION_PAUSE_MS + 1, true)).toBe(1);
		expect(wheelRows(settings, burst, "up", 250, true)).toBe(1);
		expect(wheelRows(settings, burst, "up", 260, false)).toBe(0);
		expect(wheelRows(settings, burst, "up", 270, true)).toBe(1);
	});

	test("keeps wheel movement linear when either Config limit disables acceleration", () => {
		for (const linear of [
			{ speed: 3, acceleration: 0, maximumSpeed: 8 },
			{ speed: 3, acceleration: 4, maximumSpeed: 3 },
		] satisfies ScrollConfig[]) {
			const burst = newWheelBurst();
			expect(wheelRows(linear, burst, "down", 0, true)).toBe(3);
			expect(wheelRows(linear, burst, "down", 1, true)).toBe(3);
			expect(wheelRows(linear, burst, "down", 2, true)).toBe(3);
		}
	});
});
