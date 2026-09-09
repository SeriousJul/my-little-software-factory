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
import type { ControlContext } from "../src/components/controls.ts";
import { type AgentModelList, OverridePanel } from "../src/components/override-panel.ts";
import { COLORS } from "../src/components/theme.ts";
import { type AgentTypeConfig, DEFAULT_CONFIG } from "../src/config.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { taskProfileOf } from "../src/setting-resolution.ts";
import {
	awaitFrame,
	frameText,
	HEIGHT,
	press,
	rgb,
	settle,
	spanColors,
	WIDTH,
} from "./app-harness.ts";

/**
 * The Agent types the panel offers: two, both on the pi kind, each one mapping
 * a Model template and the single Thinking level "low". Pilot maps a context
 * window and scribe does not, which is the pair the Context row tests differ on.
 * These are the config's own Agent records, the same facts the Handoff and the
 * Setting fit check read.
 */
const AGENTS: Record<string, AgentTypeConfig> = {
	pilot: {
		kind: "pi",
		model: "--model {value}",
		thinking: "--thinking {value}",
		thinkingValues: ["low"],
		contextWindow: "--context {value}",
	},
	scribe: {
		kind: "pi",
		model: "--model {value}",
		thinking: "--thinking {value}",
		thinkingValues: ["low"],
	},
	// An Agent that maps thinking but names no levels: the row has nothing to
	// offer, and the level a chain resolved still shows on it.
	mute: { kind: "pi", model: "--model {value}", thinking: "--thinking {value}" },
};
const PROFILES = { implement: taskProfileOf(DEFAULT_CONFIG, "implement") };

/** The base control facts the panel is mounted over: the list, idle. */
const BASE_CONTEXT: ControlContext = {
	mode: "ticket-list",
	listCanMove: true,
	detailCanScroll: false,
	sourceCount: 1,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageTruncated: false,
	consultationTypesConfigured: false,
};

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
			profiles: PROFILES,
			modelList,
			onAgentChange: () => undefined,
			initial,
			onConfirm: () => undefined,
			onCancel: () => undefined,
			context: BASE_CONTEXT,
			message: null,
			onEmergencyExit: () => undefined,
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

describe("the panel's warning rows come from the Setting fit verdicts", () => {
	/** The row text of a setting the panel shows in the warning color. */
	async function expectUnfit(
		setup: Awaited<ReturnType<typeof testRender>>,
		value: string,
	): Promise<void> {
		expect(spanColors(setup, value)).toEqual([rgb(COLORS.statusWarning)]);
	}

	test("a Model the Agent's own list does not report wears the warning", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, model: "not-offered/model" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model not-offered/model"),
					"the Model row holding the unfit value",
				);
				// The row keeps the value the Handoff would send, and states it as
				// the failure the Handoff would fail with.
				expect(frameText(frame)).toContain("Model not-offered/model");
				await expectUnfit(setup, "not-offered/model");
			},
		);
	});

	test("a Thinking level the Agent does not offer wears the warning", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, thinking: "high" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Thinking high"),
					"the Thinking row holding the unoffered level",
				);
				expect(frameText(frame)).toContain("Thinking high");
				await expectUnfit(setup, "high");
			},
		);
	});

	test("a Context window the Agent maps no template for wears the warning", async () => {
		await withPanel(
			{ agentType: "scribe", status: { status: "available", models: ["only-for-scribe/model-y"] } },
			{ ...INITIAL, agentType: "scribe", contextWindow: "131072" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Context 131072"),
					"the Context row the Agent cannot take",
				);
				expect(frameText(frame)).toContain("Context 131072");
				await expectUnfit(setup, "131072");
			},
		);
	});

	test("a Context window that is no count wears the warning too", async () => {
		// The same verdict answers both Context causes, so neither row needs a
		// comparison of its own.
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "000" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Context 000"),
					"the Context row holding no count",
				);
				// An all-zero count is no count at all, so the row keeps the
				// operator's digits and wears the warning on them.
				expect(frameText(frame)).toContain("Context 000");
				await expectUnfit(setup, "000");
			},
		);
	});

	test("an Agent that maps thinking but declares no level offers nothing to cycle", async () => {
		await withPanel(
			{ agentType: "mute", status: { status: "available", models: ["only-for-mute/model-y"] } },
			{ ...INITIAL, agentType: "mute", thinking: "low" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Thinking low"),
					"the Thinking row with no level to offer",
				);
				expect(frameText(frame)).toContain("Thinking low");
				await expectUnfit(setup, "low");
				await press(setup, "j", "the Environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the Task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the Model row", (f) => f.includes("❯ Model"));
				// The Model row takes typing, so the arrow key moves past it.
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => f.includes("❯ Thinking"), "the Thinking row");
				// The row holds no option, so a cycle takes it nowhere: the value the
				// Handoff would refuse stays on the row where the operator can clear it.
				setup.mockInput.pressArrow("right");
				const held = frameText(await settle(setup));
				expect(held).toContain("Thinking low");
				expect(held).not.toContain("Stryker");
			},
		);
	});

	test("an Agent that maps no setting keeps every carried value in reach", async () => {
		// One Agent that maps nothing at all, carrying all three settings: each row
		// shows, each wears the warning the Handoff would fail on, and every value
		// stays reachable so the operator can clear it.
		await withPanel(
			{ agentType: "bare", status: { status: "available", models: ["factory-model"] } },
			{
				...INITIAL,
				agentType: "bare",
				model: "factory-model",
				thinking: "low",
				contextWindow: "131072",
			},
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) =>
						frameText(f).includes("Model factory-model") &&
						frameText(f).includes("Thinking low") &&
						frameText(f).includes("Context 131072"),
					"the three warning rows of an Agent that maps nothing",
				);
				expect(frameText(frame)).toContain("Agent bare");
				await expectUnfit(setup, "factory-model");
				await expectUnfit(setup, "low");
				await expectUnfit(setup, "131072");
				// A warning row is an editing row, not a cycle: the selection reaches
				// it and a typed letter lands in the value the Handoff would send.
				await press(setup, "j", "the Environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the Task type row", (f) => f.includes("❯ Task type"));
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => f.includes("❯ Model"), "the Model row");
				await setup.mockInput.typeText("x");
				const typedModel = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model factory-modelx"),
					"the Model row to take the typed letter",
				);
				expect(frameText(typedModel)).toContain("Model factory-modelx");
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => f.includes("❯ Thinking"), "the Thinking row");
				await setup.mockInput.typeText("z");
				const typedThinking = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Thinking lowz"),
					"the Thinking row to take the typed letter",
				);
				expect(frameText(typedThinking)).toContain("Thinking lowz");
			},
		);
	});

	test("an Agent that maps no Model setting warns on its value, list or not", async () => {
		// The no-setting cause outranks the list question: a list that cannot be
		// fetched must not turn a value the Agent cannot take into a fit one.
		for (const status of [
			{ status: "available", models: ["factory-model"] },
			{ status: "unavailable", cause: "no-list" },
		] as const) {
			await withPanel(
				{ agentType: "bare", status },
				{ ...INITIAL, agentType: "bare", model: "factory-model" },
				async (setup) => {
					const frame = await awaitFrame(
						setup,
						(f) => frameText(f).includes("factory-model"),
						"the Model row of an Agent that maps no model",
					);
					expect(frameText(frame)).toContain("Model factory-model");
					await expectUnfit(setup, "factory-model");
				},
			);
		}
	});
});
