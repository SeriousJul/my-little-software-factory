/**
 * The Consultation detail body (ADR 0025): the Session view from the
 * Agent's session record, the Agent view from the terminal, and the
 * Captured history for a closed Consultation whose record does not render.
 */
import { describe, expect, test } from "vitest";
import {
	consultationDetailBody,
	consultationDetailLines,
	consultationDetailTitle,
} from "../src/components/consultation-detail.ts";
import type { Consultation } from "../src/state.ts";
import type { SessionEntry } from "../src/turn-log.ts";

function consultation(state: "working" | "closed"): Consultation {
	const now = "2026-02-17T10:00:00.000Z";
	return {
		id: "c1c1c1c1-1111-4111-8111-111111111111",
		typeName: "Review",
		agentType: "consultation",
		environment: "worktree",
		model: "openai/gpt-5.1",
		thinking: "",
		contextWindow: "",
		template: "",
		initialInput: "review the auth design",
		renderedOpeningPrompt: "",
		repository: {
			identity: "SeriousJul/my-little-software-factory",
			displayName: "my-little-software-factory",
			cloneUrl: "",
			path: "/tmp/my-little-software-factory",
		},
		state,
		createdAt: now,
		updatedAt: now,
		agentName: "consultation-00000000",
		paneId: "pane-c1",
		tabId: "tab-ws-new",
		workspaceId: "ws-new",
		sessionId: "sess-c1",
		latestSequence: 1,
		draft: "",
		draftUpdatedAt: null,
		draftOld: false,
		failure: null,
		warning: null,
		replacementOf: null,
		closeResult: null,
		attentionAt: null,
		pendingResponse: null,
		resources: [],
	};
}

const session: readonly SessionEntry[] = [
	{ kind: "input", text: "review the auth design" },
	{ kind: "text", text: "The design keeps the session in memory." },
	{ kind: "tool", name: "bash", target: "npm test", failed: false },
	{ kind: "text", text: "All 571 tests pass." },
];

describe("consultationDetailBody", () => {
	test("the readable record wins over the pane read", () => {
		expect(consultationDetailBody(consultation("working"), "pane text", session)).toBe("session");
		expect(consultationDetailBody(consultation("working"), null, session)).toBe("session");
	});

	test("the pane read stands in while the record does not render", () => {
		expect(consultationDetailBody(consultation("working"), "pane text", null)).toBe("agent");
		// A readable record that still holds no messages holds no view:
		// the fallback shows instead of an empty body.
		expect(consultationDetailBody(consultation("working"), "pane text", [])).toBe("agent");
	});

	test("a closed Consultation reads its captured history when nothing renders", () => {
		expect(consultationDetailBody(consultation("closed"), null, null)).toBe("captured");
		// A closed Consultation does not keep its terminal body.
		expect(consultationDetailBody(consultation("closed"), "pane text", null)).toBe("captured");
		// But its session record still renders, for the after-the-fact review.
		expect(consultationDetailBody(consultation("closed"), null, session)).toBe("session");
	});

	test("no Consultation selected shows no live body", () => {
		expect(consultationDetailBody(undefined, "pane text", session)).toBe("captured");
	});
});

describe("consultationDetailTitle", () => {
	test("the record body titles Session view, the rest Agent view", () => {
		expect(consultationDetailTitle("session")).toBe("Session view");
		expect(consultationDetailTitle("agent")).toBe("Agent view");
		expect(consultationDetailTitle("captured")).toBe("Agent view");
	});
});

describe("consultationDetailLines", () => {
	test("the Session view shows the operator's inputs, the agent's text, and one note per tool call", () => {
		const lines = consultationDetailLines(
			consultation("working"),
			[],
			[],
			80,
			"pane text",
			session,
		).map((line) => line.text);
		expect(lines).toContain("Session view:");
		const bodyStart = lines.indexOf("Session view:");
		expect(lines.slice(bodyStart + 1)).toEqual([
			"❯ review the auth design",
			"The design keeps the session in memory.",
			"▸ bash: npm test",
			"All 571 tests pass.",
		]);
		expect(lines).not.toContain("pane text");
	});

	test("a tool note without a target shows its name alone, and a failed note keeps its target", () => {
		const lines = consultationDetailLines(consultation("working"), [], [], 80, null, [
			{ kind: "tool", name: "mcp", target: "", failed: false },
			{ kind: "tool", name: "bash", target: "npm test", failed: true },
		]).map((line) => line.text);
		expect(lines).toContain("▸ mcp");
		expect(lines).toContain("▸ bash: npm test");
		const failed = consultationDetailLines(consultation("working"), [], [], 80, null, [
			{ kind: "tool", name: "bash", target: "npm test", failed: true },
		]).find((line) => line.text === "▸ bash: npm test");
		expect(failed?.fg).not.toEqual(
			consultationDetailLines(consultation("working"), [], [], 80, null, [
				{ kind: "tool", name: "bash", target: "npm test", failed: false },
			]).find((line) => line.text === "▸ bash: npm test")?.fg,
		);
	});

	test("the terminal fallback keeps the Agent view body", () => {
		const lines = consultationDetailLines(
			consultation("working"),
			[],
			[],
			80,
			"Agent: reading src/auth.ts",
			null,
		).map((line) => line.text);
		expect(lines).toContain("Agent view:");
		expect(lines).toContain("Agent: reading src/auth.ts");
	});

	test("a closed Consultation without a readable record shows its captured history", () => {
		const lines = consultationDetailLines(
			consultation("closed"),
			[],
			[],
			80,
			"pane text",
			null,
		).map((line) => line.text);
		expect(lines).toContain("Captured history:");
		expect(lines).not.toContain("pane text");
	});

	test("a long entry wraps within the width, and no line overflows it", () => {
		const long = "word ".repeat(40).trim();
		const lines = consultationDetailLines(consultation("working"), [], [], 40, null, [
			{ kind: "input", text: long },
		]);
		expect(lines.some((line) => line.text.startsWith("❯ word "))).toBe(true);
		for (const line of lines) expect([...line.text].length).toBeLessThanOrEqual(40);
	});
});
