/**
 * The override panel on its own, apart from the app that mounts it.
 *
 * Every other panel test boots the whole app, so the app's own state machine
 * sits between a key and a row. These tests render the panel directly, because
 * the contract they pin belongs to the panel alone: a Model list the control
 * plane tagged for another agent is not an answer this panel may show, whatever
 * the caller above it does about stale answers.
 */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test } from "vitest";
import {
	type AgentModelList,
	type AgentSettings,
	OverridePanel,
} from "../src/components/override-panel.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { taskProfileOf } from "../src/setting-resolution.ts";
import { awaitFrame, frameText, HEIGHT, WIDTH } from "./app-harness.ts";

/** The rows the panel offers: two agents, one task type, both settings mapped. */
const AGENTS = ["pilot", "scribe"];
const SETTINGS: Record<string, AgentSettings> = {
	pilot: { model: true, thinking: true, thinkingValues: ["low"] },
	scribe: { model: true, thinking: true, thinkingValues: ["low"] },
};
const PROFILES = { implement: taskProfileOf(DEFAULT_CONFIG, "implement") };

/** The choice the panel opens on: the pilot agent, no setting chosen. */
const INITIAL: HandoffChoice = {
	agentType: "pilot",
	environment: "worktree",
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

/** Tear the renderer down whatever the body asserted. */
let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/** Boot the panel at the default size with one Model list, and run the body. */
async function withPanel(
	modelList: AgentModelList,
	initial: HandoffChoice,
	body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
): Promise<void> {
	const setup = await testRender(
		createElement(OverridePanel, {
			agents: AGENTS,
			environments: ["live-worktree", "worktree"],
			taskTypes: ["implement"],
			agentSettings: SETTINGS,
			profiles: PROFILES,
			modelList,
			onAgentChange: () => undefined,
			initial,
			onConfirm: () => undefined,
			onCancel: () => undefined,
		}),
		{ width: WIDTH, height: HEIGHT },
	);
	await setup.flush();
	renderer = setup.renderer;
	await body(setup);
}

/** Move the selection from the Agent row down to the Model row. */
async function moveToModelRow(setup: Awaited<ReturnType<typeof testRender>>): Promise<string> {
	await setup.mockInput.pressKeys(["j", "j", "j"]);
	return awaitFrame(setup, (f) => frameText(f).includes("❯ Model"), "the Model row to be selected");
}

describe("the Model row's list belongs to the agent the panel is on", () => {
	test("a list tagged for another agent never reaches the row", async () => {
		// The control plane drops a stale answer before it gets here, and the row
		// checks the tag too: while pilot is selected, scribe's models are not a
		// list this panel may offer, cycle, or confirm.
		await withPanel(
			{
				agentType: "scribe",
				status: { status: "available", models: ["only-for-scribe/model-x"] },
			},
			INITIAL,
			async (setup) => {
				const opened = await moveToModelRow(setup);
				expect(frameText(opened)).toContain("Model (loading...)");
				expect(frameText(opened)).not.toContain("only-for-scribe");

				// The row takes no typing and no cycle while it waits, so a foreign
				// value cannot be chosen by accident.
				await setup.mockInput.typeText("mode");
				await setup.mockInput.pressArrow("right");
				const held = setup.captureCharFrame();
				expect(frameText(held)).toContain("Model (loading...)");
				expect(frameText(held)).not.toContain("only-for-scribe");
			},
		);
	});

	test("a list tagged for the agent the row is on is offered", async () => {
		await withPanel(
			{
				agentType: "pilot",
				status: { status: "available", models: ["only-for-pilot/model-y"] },
			},
			INITIAL,
			async (setup) => {
				await moveToModelRow(setup);
				await setup.mockInput.pressArrow("right");
				const shown = await awaitFrame(
					setup,
					(f) => frameText(f).includes("only-for-pilot/model-y"),
					"the agent's own model to cycle in",
				);
				expect(frameText(shown)).toContain("Model only-for-pilot/model-y");
			},
		);
	});
});
