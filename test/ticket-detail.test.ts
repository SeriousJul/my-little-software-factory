/** Deterministic wheel-burst policy tests for the native Ticket detail viewport. */
import { describe, expect, test } from "bun:test";
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
import { roleColor } from "./app-harness.ts";
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
		expect(lines).toContainEqual({ text: "Agent: codex", fg: roleColor("text") });
		expect(lines).toContainEqual({ text: "Model: task-model", fg: roleColor("text") });
		expect(lines).toContainEqual({ text: "Thinking: left to agent", fg: roleColor("subtext0") });
		// A count the profile names reads like any other value; the digits are
		// the value, so the detail never reformats them.
		expect(lines).toContainEqual({ text: "Context: 272000", fg: roleColor("text") });
		expect(lines).toContainEqual({ text: "Environment: live-worktree", fg: roleColor("text") });
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
		expect(next).toContainEqual({ text: "Agent: pi", fg: roleColor("text") });
		expect(next).toContainEqual({ text: "Model: left to agent", fg: roleColor("subtext0") });
		expect(next).toContainEqual({ text: "Environment: live-worktree", fg: roleColor("text") });
		expect(next.some((line) => line.text.includes("old-cycle-model"))).toBe(false);

		// A ticket inside a cycle shows that cycle's own Handoff, because those
		// are the settings its running agent started with.
		const running: Ticket = { ...secondCycle, state: "running" };
		const shown = detailLines(running, 100, 10, nextChoice);
		expect(shown).toContainEqual({ text: "Agent: codex", fg: roleColor("text") });
		expect(shown).toContainEqual({ text: "Model: old-cycle-model", fg: roleColor("text") });
		expect(shown).toContainEqual({ text: "Thinking: high", fg: roleColor("text") });
		expect(shown).toContainEqual({ text: "Context: 65536", fg: roleColor("text") });
		expect(shown).toContainEqual({ text: "Environment: worktree", fg: roleColor("text") });
	});
});

describe("Ticket detail priority fact (ADR 0022)", () => {
	const base = SAMPLE_TICKETS[0];
	if (base === undefined) throw new Error("missing sample ticket");

	function withPriority(p: Ticket["priority"], override: string | null = null): DetailLine[] {
		return detailLines({ ...base, priority: p }, 100, 10, undefined, override);
	}

	test("a label rank states its label and its own source", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "label",
			inheritedFrom: null,
		});
		expect(lines).toContainEqual({
			text: "Priority: critical (its own label)",
			fg: roleColor("text"),
		});
	});

	test("an inherited rank names the issue that supplied it (ADR 0023)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-issue", externalKey: "#12" },
		});
		expect(lines).toContainEqual({
			text: "Priority: critical (issue #12)",
			fg: roleColor("text"),
		});
	});

	test("an inherited rank names the fixing alert by its number (ADR 0042)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-dependabot-alert", externalKey: "#9" },
		});
		expect(lines).toContainEqual({
			text: "Priority: critical (alert #9)",
			fg: roleColor("text"),
		});
	});

	test("an inherited rank names the fixing advisory by its key, not a number (ADR 0042)", () => {
		const lines = withPriority({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: { sourceKind: "github-security-advisory", externalKey: "GHSA-j8wj-q3wj-c945" },
		});
		expect(lines).toContainEqual({
			text: "Priority: critical (advisory GHSA-j8wj-q3wj-c945)",
			fg: roleColor("text"),
		});
	});

	test("an override rank states its label and the operator's source", () => {
		const lines = withPriority(
			{ rank: 1, label: "high", source: "override", inheritedFrom: null },
			"high",
		);
		expect(lines).toContainEqual({ text: "Priority: high (set by you)", fg: roleColor("text") });
	});

	test("off states the override that forces the ticket unranked", () => {
		const lines = withPriority(
			{ rank: null, label: "off", source: "override", inheritedFrom: null },
			"off",
		);
		expect(lines).toContainEqual({ text: "Priority: off (set by you)", fg: roleColor("text") });
	});

	test("an unranked ticket with no override reads none, dim", () => {
		const lines = withPriority(UNRANKED_PRIORITY, null);
		expect(lines).toContainEqual({ text: "Priority: none", fg: roleColor("subtext0") });
	});

	test("a stale override states its stored label, agreeing with the override row", () => {
		// The stored label left the config list: the rank is none, but the
		// fact line and the row's choiceValue name the same stored label.
		const content = detailContent(
			{
				...base,
				priority: { rank: null, label: "critical", source: "override", inheritedFrom: null },
			},
			100,
			10,
			undefined,
			"critical",
		);
		expect(content.lines).toContainEqual({
			text: "Priority: critical (set by you)",
			fg: roleColor("text"),
		});
		expect(content.choiceValue).toBe("critical");
	});

	test("the override row states the stored value, or default", () => {
		expect(detailContent(base, 100, 10, undefined, null).choiceValue).toBe("default");
		expect(detailContent(base, 100, 10, undefined, "high").choiceValue).toBe("high");
		expect(detailContent(base, 100, 10, undefined, "off").choiceValue).toBe("off");
	});
});

describe("Ticket detail grouped layout", () => {
	const first = SAMPLE_TICKETS[0];
	if (first === undefined) throw new Error("missing sample ticket");
	// A ticket with a settled turn: its completion stands as the log group.
	const withLog = SAMPLE_TICKETS[3];
	if (withLog === undefined) throw new Error("missing sample ticket");

	test("the title wears the accent role and the bold, and the repository dims", () => {
		const lines = detailLines(first, 100, 10);
		expect(lines).toContainEqual({
			text: "Retry policy for webhooks",
			fg: roleColor("accent"),
			bold: true,
		});
		expect(lines).toContainEqual({ text: "acme/billing", fg: roleColor("subtext0") });
	});

	test("the link to the ticket's GitHub page wears the blue role", () => {
		const lines = detailLines(first, 100, 10);
		expect(lines).toContainEqual({
			text: "GitHub: https://github.com/acme/billing/issues/1",
			fg: roleColor("blue"),
		});
	});

	test("one blank closes the interactive group and opens the read-only groups", () => {
		const lines = detailLines(withLog, 100, 10);
		const texts = lines.map((line) => line.text);
		const at = (text: string) => {
			const i = texts.indexOf(text);
			if (i === -1) throw new Error(`missing detail line: ${text}`);
			return i;
		};
		// The blank stands on the Priority fact's right, where the override
		// row renders, and no other row in the pane takes a blank.
		expect(texts[at("Priority: none") + 1]).toBe(" ");
		expect(texts.filter((t) => t === " ").length).toBe(1);
		// The description follows the source facts on its dim alone.
		expect(texts[at("Labels: none") + 1]).not.toBe(" ");
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
