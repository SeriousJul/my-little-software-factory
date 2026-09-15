/** Deterministic wheel-burst policy tests for the native Ticket detail viewport. */
import { describe, expect, test } from "vitest";
import { COLORS } from "../src/components/theme.ts";
import {
	type DetailLine,
	detailContent,
	detailLines,
	newWheelBurst,
	WHEEL_ACCELERATION_PAUSE_MS,
	wheelRows,
} from "../src/components/ticket-detail.ts";
import type { ScrollConfig } from "../src/config.ts";
import { type Handoff, type Ticket, UNRANKED_PRIORITY } from "../src/domain/ticket.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const settings: ScrollConfig = { speed: 1, acceleration: 0.8, maximumSpeed: 6 };

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
		expect(lines).toContainEqual({ text: "Agent: codex", fg: COLORS.text });
		expect(lines).toContainEqual({ text: "Model: task-model", fg: COLORS.text });
		expect(lines).toContainEqual({ text: "Thinking: left to agent", fg: COLORS.dim });
		// A count the profile names reads like any other value; the digits are
		// the value, so the detail never reformats them.
		expect(lines).toContainEqual({ text: "Context: 272000", fg: COLORS.text });
		expect(lines).toContainEqual({ text: "Environment: live-worktree", fg: COLORS.text });
		// The rows read in the order the override panel offers them: where a
		// Handoff runs, then what it runs with.
		const order = lines.map((line) => line.text);
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
		expect(next).toContainEqual({ text: "Agent: pi", fg: COLORS.text });
		expect(next).toContainEqual({ text: "Model: left to agent", fg: COLORS.dim });
		expect(next).toContainEqual({ text: "Environment: live-worktree", fg: COLORS.text });
		expect(next.some((line) => line.text.includes("old-cycle-model"))).toBe(false);

		// A ticket inside a cycle shows that cycle's own Handoff, because those
		// are the settings its running agent started with.
		const running: Ticket = { ...secondCycle, state: "running" };
		const shown = detailLines(running, 100, 10, nextChoice);
		expect(shown).toContainEqual({ text: "Agent: codex", fg: COLORS.text });
		expect(shown).toContainEqual({ text: "Model: old-cycle-model", fg: COLORS.text });
		expect(shown).toContainEqual({ text: "Thinking: high", fg: COLORS.text });
		expect(shown).toContainEqual({ text: "Context: 65536", fg: COLORS.text });
		expect(shown).toContainEqual({ text: "Environment: worktree", fg: COLORS.text });
	});
});

describe("Ticket detail priority fact (ADR 0022)", () => {
	const base = SAMPLE_TICKETS[0];
	if (base === undefined) throw new Error("missing sample ticket");

	function withPriority(p: Ticket["priority"], override: string | null = null): DetailLine[] {
		return detailLines({ ...base, priority: p }, 100, 10, undefined, override);
	}

	test("a label rank states its label and its own source", () => {
		const lines = withPriority({ rank: 0, label: "critical", source: "label" });
		expect(lines).toContainEqual({
			text: "Priority: critical (its own label)",
			fg: COLORS.text,
		});
	});

	test("an override rank states its label and the operator's source", () => {
		const lines = withPriority({ rank: 1, label: "high", source: "override" }, "high");
		expect(lines).toContainEqual({ text: "Priority: high (set by you)", fg: COLORS.text });
	});

	test("off states the override that forces the ticket unranked", () => {
		const lines = withPriority({ rank: null, label: "off", source: "override" }, "off");
		expect(lines).toContainEqual({ text: "Priority: off (set by you)", fg: COLORS.text });
	});

	test("an unranked ticket with no override reads none, dim", () => {
		const lines = withPriority(UNRANKED_PRIORITY, null);
		expect(lines).toContainEqual({ text: "Priority: none", fg: COLORS.dim });
	});

	test("a stale override states its stored label, agreeing with the override row", () => {
		// The stored label left the config list: the rank is none, but the
		// fact line and the row's choiceValue name the same stored label.
		const content = detailContent(
			{ ...base, priority: { rank: null, label: "critical", source: "override" } },
			100,
			10,
			undefined,
			"critical",
		);
		expect(content.lines).toContainEqual({
			text: "Priority: critical (set by you)",
			fg: COLORS.text,
		});
		expect(content.choiceValue).toBe("critical");
	});

	test("the override row states the stored value, or default", () => {
		expect(detailContent(base, 100, 10, undefined, null).choiceValue).toBe("default");
		expect(detailContent(base, 100, 10, undefined, "high").choiceValue).toBe("high");
		expect(detailContent(base, 100, 10, undefined, "off").choiceValue).toBe("off");
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
