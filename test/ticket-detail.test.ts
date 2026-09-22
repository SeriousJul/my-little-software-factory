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
import { type Handoff, type Ticket, UNRANKED_PRIORITY } from "../src/domain/ticket.ts";
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

describe("Ticket detail priority fact (ADR 0022)", () => {
	const base = SAMPLE_TICKETS[0];
	if (base === undefined) throw new Error("missing sample ticket");

	function withPriority(p: Ticket["priority"]): DetailLine[] {
		return detailLines({ ...base, priority: p }, 100, 10);
	}

	test("a label rank states its label and its own source", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "label",
			inheritedFrom: null,
		});
		expect(hasCell(lines, "Priority: critical (its own label)", roleColor("text"))).toBe(true);
	});

	test("an inherited rank names the issue that supplied it (ADR 0023)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-issue", externalKey: "#12" },
		});
		expect(hasCell(lines, "Priority: critical (issue #12)", roleColor("text"))).toBe(true);
	});

	test("an inherited rank names the fixing alert by its number (ADR 0042)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-dependabot-alert", externalKey: "#9" },
		});
		expect(hasCell(lines, "Priority: critical (alert #9)", roleColor("text"))).toBe(true);
	});

	test("an inherited rank names the fixing advisory by its key, not a number (ADR 0042)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-security-advisory", externalKey: "GHSA-j8wj-q3wj-c945" },
		});
		expect(
			hasCell(lines, "Priority: critical (advisory GHSA-j8wj-q3wj-c945)", roleColor("text")),
		).toBe(true);
	});

	test("an override rank states its label and the operator's source", () => {
		const lines = withPriority({ rank: 1, label: "high", source: "override", inheritedFrom: null });
		expect(hasCell(lines, "Priority: high (set by you)", roleColor("text"))).toBe(true);
	});

	test("off states the override that forces the ticket unranked", () => {
		const lines = withPriority({
			rank: null,
			label: "off",
			source: "override",
			inheritedFrom: null,
		});
		expect(hasCell(lines, "Priority: off (set by you)", roleColor("text"))).toBe(true);
	});

	test("an unranked ticket with no override reads none, dim", () => {
		const lines = withPriority(UNRANKED_PRIORITY);
		expect(hasCell(lines, "Priority: none", roleColor("subtext0"))).toBe(true);
	});

	test("a stale override states its stored label", () => {
		// The stored label left the config list: the rank is none, but the
		// fact line - the selector's own face - still names the stored label.
		const lines = detailLines(
			{
				...base,
				priority: { rank: null, label: "critical", source: "override", inheritedFrom: null },
			},
			100,
			10,
		);
		expect(hasCell(lines, "Priority: critical (set by you)", roleColor("text"))).toBe(true);
	});
});

describe("Ticket detail grouped layout", () => {
	const first = SAMPLE_TICKETS[0];
	if (first === undefined) throw new Error("missing sample ticket");
	// A ticket with a settled turn: its completion stands as the log group.
	const withLog = SAMPLE_TICKETS[3];
	if (withLog === undefined) throw new Error("missing sample ticket");

	test("the title and repository flow on shared lines, the title in its accent bold", () => {
		const lines = detailLines(first, 100, 10);
		// The identity is one logical line: the title's accent bold, the join
		// space riding with the title, then the repository's dim.
		expect(lines).toContainEqual({
			text: "Retry policy for webhooks acme/billing",
			fg: roleColor("accent"),
			cells: [
				{ text: "Retry policy for webhooks ", fg: roleColor("accent"), bold: true },
				{ text: "acme/billing", fg: roleColor("subtext0") },
			],
		});
	});

	test("a wrapped title carries the repository on its last line", () => {
		const long: Ticket = {
			...first,
			title: "Promote the Work queue to the single start channel (ADRs 0049-0052)",
		};
		const lines = detailLines(long, 55, 10);
		// The identity takes the first two lines, and the break never splits
		// the repository into the title's color: the title's cells end where
		// the repository's dim begins.
		expect(lines[1]?.cells).toEqual([
			{ text: "(ADRs 0049-0052) ", fg: roleColor("accent"), bold: true },
			{ text: "acme/billing", fg: roleColor("subtext0") },
		]);
	});

	test("the link to the ticket's GitHub page wears the blue role", () => {
		const lines = detailLines(first, 100, 10);
		expect(lines).toContainEqual({
			text: "GitHub: https://github.com/acme/billing/issues/1",
			fg: roleColor("blue"),
		});
	});

	test("one blank closes the static groups and opens the description", () => {
		const lines = detailLines(withLog, 100, 10);
		const texts = lines.map((line) => line.text);
		// Exactly one blank, and it stands on the description's left: the
		// columns, the warnings, the link, and the turn's log all stand above
		// it, and the ticket's own words begin below.
		expect(texts.filter((t) => t === " ").length).toBe(1);
		const blankAt = texts.indexOf(" ");
		expect(texts[blankAt + 1].startsWith("The legacy auth shim")).toBe(true);
	});

	test("the work stands in two columns: the Agent facts beside the Source facts", () => {
		const lines = detailLines(first, 100, 10, nextChoice);
		// The block's joined rows carry the cells the pane paints, one per
		// column, the Agent column first.
		const joined = lines.filter((line) => line.cells !== undefined);
		expect(joined.length).toBeGreaterThan(0);
		for (const line of joined) expect(line.cells).toHaveLength(2);
		// The Agent column holds the handoff's facts.
		expect(hasCell(lines, "Agent: pi", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Handoffs: 0/10", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Priority: none", roleColor("subtext0"))).toBe(true);
		// The Source column holds the source's facts.
		expect(hasCell(lines, "Source kind: github-issue", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "External key: #1", roleColor("text"))).toBe(true);
		expect(hasCell(lines, "Source state: open", roleColor("text"))).toBe(true);
	});

	test("the turn's log stands apart in its green label and indented dim", () => {
		const lines = detailLines(withLog, 100, 10);
		const texts = lines.map((line) => line.text);
		const at = (text: string) => {
			const i = texts.indexOf(text);
			if (i === -1) throw new Error(`missing detail line: ${text}`);
			return i;
		};
		// The green label opens the log.
		expect(
			lines[at("Last completion: 2026-01-01 12:00 review by factory-review-I_4 (claude) pending")]
				.fg,
		).toBe(roleColor("green"));
		// The message indents under its label, dim, on every wrapped line.
		expect(texts[at("  The auth shim and its flag are removed.")]).toBe(
			"  The auth shim and its flag are removed.",
		);
		expect(lines[at("  The auth shim and its flag are removed.")].fg).toBe(roleColor("subtext0"));
		expect(texts[at("  All 142 tests pass. I left the migration note in docs/auth.md.")]).toBe(
			"  All 142 tests pass. I left the migration note in docs/auth.md.",
		);
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
