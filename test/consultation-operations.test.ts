import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import {
	type ConsultationOperations,
	type ConsultationStatus,
	createConsultationOperations,
} from "../src/consultation-operations.ts";
import { consultationBranchName } from "../src/naming.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { FakeRunner, worktreeCreateJson } from "./fake-runner.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function makeFixture(environment: "worktree" | "live-worktree" = "worktree", model = "") {
	const directory = mkdtempSync(join(tmpdir(), "factory-consultation-operations-"));
	directories.push(directory);
	const checkout = join(directory, "checkout");
	mkdirSync(checkout, { recursive: true });
	const state = openFactoryState(join(directory, "state.sqlite"));
	const config: FactoryConfig = {
		...DEFAULT_CONFIG,
		repos: { "github.com/acme/factory": checkout },
		consultationTypes: {
			grill: {
				agent: "pi",
				environment,
				template: "/grill {input}",
			},
		},
	};
	const consultation = state.createConsultation({
		id: "consultation-1",
		typeName: "grill",
		agentType: "pi",
		environment,
		model,
		template: "/grill {input}",
		initialInput: "review auth",
		renderedOpeningPrompt: "/grill review auth",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: checkout,
		},
		agentName: "consultation-11111111",
		createdAt: "2026-09-01T00:00:00.000Z",
	});
	return { state, config, consultation, checkout };
}

function makeOperations(
	state: FactoryState,
	config: FactoryConfig,
	runner: CommandRunner,
	statuses: ConsultationStatus[] = [],
): ConsultationOperations {
	return createConsultationOperations({
		state,
		runner,
		config: () => config,
		home: "/tmp",
		tickets: () => [],
		callbacks: {
			onStatus: (status) => {
				if (status !== null) statuses.push(status);
			},
			onConsultationsChanged: () => undefined,
			onSafetyConflict: () => undefined,
		},
	});
}

function configureWorktreeStart(
	runner: FakeRunner,
	checkout: string,
	consultationId: string,
): void {
	const branch = consultationBranchName(consultationId, "grill");
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	runner.set("git", ["-C", checkout, "branch", "--list", branch], { stdout: "" });
	runner.set("git", ["-C", checkout, "rev-parse", "HEAD"], { stdout: "abc123\n" });
	runner.set(
		"herdr",
		["worktree", "create", "--cwd", checkout, "--branch", branch, "--base", "abc123", "--no-focus"],
		{ stdout: worktreeCreateJson("workspace-1", "pane-1") },
	);
}

describe("Consultation operations", () => {
	test("runs the setting fit check before repository work", async () => {
		const { state, config, consultation } = makeFixture("worktree", "gpt-4o");
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const operations = makeOperations(state, config, runner);

		await operations.launch(consultation);

		expect(state.consultation(consultation.id)?.state).toBe("failed");
		expect(state.consultation(consultation.id)?.failure).toContain('has no model "gpt-4o"');
		expect(runner.calls).toHaveLength(0);
		expect(runner.modelListCalls).toEqual(["pi"]);
	});

	test("launches a Consultation through the module and records its resources", async () => {
		const { state, config, consultation, checkout } = makeFixture();
		const runner = new FakeRunner();
		configureWorktreeStart(runner, checkout, consultation.id);
		const statuses: ConsultationStatus[] = [];
		const operations = makeOperations(state, config, runner, statuses);

		await operations.launch(consultation);

		const current = state.consultation(consultation.id);
		expect(current?.state).toBe("working");
		expect(current?.paneId).toBe("pane-1");
		expect(current?.resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "workspace", resourceId: "workspace-1" }),
				expect.objectContaining({ kind: "worktree", resourceId: "workspace-1" }),
				expect.objectContaining({ kind: "pane", resourceId: "pane-1" }),
			]),
		);
		expect(runner.commands()).toContain(
			"herdr agent prompt consultation-11111111 /grill review auth",
		);
		expect(statuses.some((status) => status.text.includes("resolving-repository"))).toBe(true);
	});

	test("keeps a response draft when Herdr rejects delivery", async () => {
		const { state, config, consultation } = makeFixture();
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "first answer");
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "prompt", consultation.agentName, "follow up"], {
			code: 1,
			stderr: "agent rejected the prompt\n",
		});
		const operations = makeOperations(state, config, runner);

		await operations.respond(consultation, "follow up");

		expect(state.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.pendingConsultationResponse(consultation.id)).toBeNull();
	});

	test("owns ordered terminal input and flushes it", async () => {
		const { state, config } = makeFixture();
		const runner = new FakeRunner();
		const operations = makeOperations(state, config, runner);

		operations.enqueue("pane-1", { kind: "text", text: "hello" });
		await operations.enqueue("pane-1", { kind: "key", key: "enter" });
		await operations.flush();

		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 hello",
			"herdr pane send-keys pane-1 enter",
		]);
	});

	test("force-close records resources without issuing cleanup commands", () => {
		const { state, config, consultation } = makeFixture();
		state.setConsultationAgent(consultation.id, { paneId: "pane-1", workspaceId: "workspace-1" });
		state.recordConsultationResource(consultation.id, {
			kind: "worktree",
			resourceId: "workspace-1",
			owned: true,
			details: "Consultation worktree",
		});
		state.recordConsultationResource(consultation.id, {
			kind: "pane",
			resourceId: "pane-1",
			owned: true,
			details: "Consultation pane",
		});
		state.beginConsultationClose(consultation.id);
		const runner = new FakeRunner();
		const operations = makeOperations(state, config, runner);

		operations.forceClose(consultation);

		expect(state.consultation(consultation.id)?.state).toBe("closed");
		expect(state.consultationRemainingResources(consultation.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "worktree", resourceId: "workspace-1" }),
				expect.objectContaining({ kind: "pane", resourceId: "pane-1" }),
			]),
		);
		expect(runner.calls).toHaveLength(0);
	});
});
