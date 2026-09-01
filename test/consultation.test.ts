import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	boundedReplacementInput,
	isLiteralText,
	serializeRepositoryOperation,
	translateAgentKey,
	validateConsultationInput,
	validateResponseInput,
} from "../src/consultation.ts";
import { openFactoryState } from "../src/state.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function makeState() {
	const directory = mkdtempSync(join(tmpdir(), "factory-consultation-"));
	directories.push(directory);
	return openFactoryState(join(directory, "state.sqlite"));
}

function createConsultation(state: ReturnType<typeof makeState>, id = "consultation-1") {
	return state.createConsultation({
		id,
		typeName: "grill-with-docs",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		template: "/skill:grill-with-docs {input}",
		initialInput: "Review this repository",
		renderedOpeningPrompt: "/skill:grill-with-docs Review this repository",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: "/tmp/factory",
		},
		agentName: "consultation-11111111",
		createdAt: "2026-09-01T00:00:00.000Z",
	});
}

describe("Consultation input and interaction rules", () => {
	test("limits input by UTF-8 bytes and preserves literal Unicode text", () => {
		expect(validateConsultationInput("😀", 4)).toBeUndefined();
		expect(validateConsultationInput("😀", 3)).toContain("4 UTF-8 bytes");
		expect(validateResponseInput("\n\tanswer")).toBeUndefined();
		expect(validateResponseInput("   ")).toBe("response cannot be empty");
		expect(isLiteralText("é😀\n\t")).toBe(true);
		expect(isLiteralText("safe\u001b[31m")).toBe(false);
	});

	test("maps semantic keys and lets AltGr text pass through", () => {
		expect(translateAgentKey({ name: "up" }, "f12")).toEqual({ kind: "key", key: "up" });
		expect(translateAgentKey({ name: "@", meta: true }, "f12")).toEqual({
			kind: "text",
			text: "@",
		});
		expect(translateAgentKey({ name: "f12" }, "f12")).toBeNull();
		expect(translateAgentKey({ name: "q", ctrl: true }, "f12")).toEqual({
			kind: "key",
			key: "ctrl+q",
		});
	});

	test("bounds replacement context even when the limit cuts through Unicode", () => {
		const result = boundedReplacementInput("😀".repeat(100), [{ input: "é".repeat(100) }], 40);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(40);
		expect(result).toContain("recovery context omitted");
	});
});

describe("durable Consultation lifecycle", () => {
	test("stores turns, snapshots, old drafts, partial output, and replacement context", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "workspace-1",
			sessionId: "session-1",
		});
		expect(state.consultation(consultation.id)?.state).toBe("working");
		expect(state.settleConsultationTurn(consultation.id, 1, "first answer", "idle")).toBe(true);
		state.setConsultationDraft(consultation.id, "draft response");
		const turn = state.acceptConsultationResponse(consultation.id, "second question", 1);
		expect(turn).toBeDefined();
		state.setConsultationDraft(consultation.id, "old draft", true);
		expect(state.recordExternalConsultationTurn(consultation.id, 2)).toBe(false);
		// The Consultation is working after accepting its own second turn.
		expect(state.settleConsultationTurn(consultation.id, 2, "second answer", "blocked")).toBe(true);
		const stored = state.consultation(consultation.id);
		expect(stored).toMatchObject({ state: "awaiting-response", latestSequence: 2 });
		expect(state.consultationSnapshots(consultation.id)).toHaveLength(2);
		expect(state.consultationTurns(consultation.id)).toHaveLength(2);
		expect(state.replacementInput(consultation.id)).toContain("Original input:");
		expect(state.replacementInput(consultation.id)).toContain(
			"Operator response:\nsecond question",
		);
		expect(state.replacementInput(consultation.id)).not.toContain(
			"Operator response:\nReview this repository",
		);
		state.captureConsultationPartial(consultation.id, "partial 😀 output");
		expect(state.consultationSnapshots(consultation.id).some((snapshot) => snapshot.partial)).toBe(
			true,
		);
		state.close();
	});

	test("preserves a draft when a durable response send fails", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "answer");
		state.setConsultationDraft(consultation.id, "follow up");
		const turn = state.beginConsultationResponse(consultation.id, "follow up", 1);
		expect(turn).toBeDefined();
		expect(state.consultation(consultation.id)?.state).toBe("working");
		if (turn === undefined) return;
		expect(state.cancelConsultationResponse(consultation.id, turn.id)).toBe(true);
		expect(state.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.consultationTurns(consultation.id)).toHaveLength(1);
		state.close();
	});

	test("serializes operations for one repository and does not block another", async () => {
		const queues = new Map<string, Promise<void>>();
		const events: string[] = [];
		let release!: () => void;
		const first = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("first-start");
			await new Promise<void>((resolve) => (release = resolve));
			events.push("first-end");
		});
		const second = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("second");
		});
		const other = serializeRepositoryOperation(queues, "github.com/acme/other", async () => {
			events.push("other");
		});
		await other;
		expect(events).toEqual(["first-start", "other"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first-start", "other", "first-end", "second"]);
	});
});
