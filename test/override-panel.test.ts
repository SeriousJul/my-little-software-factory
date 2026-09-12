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
import {
	type AgentModelList,
	OverridePanel,
	panelNoteCells,
} from "../src/components/override-panel.ts";
import { inkFor } from "../src/components/shared/presentation.ts";
import { type AgentTypeConfig, DEFAULT_CONFIG } from "../src/config.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { type FitVerdict, settingFit } from "../src/setting-fit.ts";
import { taskProfileOf } from "../src/setting-resolution.ts";
import {
	awaitFrame,
	frameText,
	HEIGHT,
	press,
	rgb,
	rowSelected,
	rowsOf,
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
/**
 * A panel wide enough to hold a whole status sentence under a value.
 *
 * A row's note holds what the box leaves, so the test that pins "the row
 * states the Handoff's sentence" asks for the room a normal workstation
 * terminal gives it.
 */
const WIDE = 220;
/** The unset value of every setting, for a check that asks about one of them. */
const NO_SETTINGS = { model: "", thinking: "", contextWindow: "" };
/** The list state of a kind that reports none, as the panel is told it. */
const NO_LIST = { status: "unavailable", cause: "no-list" } as const;

/**
 * The color one shared palette role paints in the presentation these tests run
 * in. A panel that painted a color of its own would not match it.
 */
function tone(role: "warning" | "error"): [number, number, number] {
	const foreground = inkFor("dark")[role].fg;
	if (foreground === null) throw new Error(`the dark palette paints no ${role}`);
	return rgb(foreground);
}

/** Read the exact refusal sentence from a verdict. */
function sentence(verdict: FitVerdict): string {
	if (verdict.ok) throw new Error("the test expects an unfit verdict");
	return verdict.reason;
}

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

/** What the panel reported as refused, so a test can read the refusal itself. */
let refusals: string[] = [];

/**
 * Boot the panel with one Model list, and run the body.
 *
 * The default size is the one the panel is designed for; a test that pins what
 * a narrow panel can state passes its own size. A refusal a row makes is
 * reported to the app above, so the test collects what it reported.
 */
async function withPanel(
	modelList: AgentModelList,
	initial: HandoffChoice,
	body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
	options: { width?: number; height?: number } = {},
): Promise<void> {
	refusals = [];
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
			onUnavailable: (reason: string) => refusals.push(reason),
			onEmergencyExit: () => undefined,
		}),
		{ width: options.width ?? WIDTH, height: options.height ?? HEIGHT },
	);
	await setup.flush();
	renderer = setup.renderer;
	await body(setup);
}

/** Move the selection from the Agent row down to the Model row. */
async function moveToModelRow(setup: Awaited<ReturnType<typeof testRender>>): Promise<string> {
	await setup.mockInput.pressKeys(["j", "j", "j"]);
	return awaitFrame(setup, (f) => rowSelected(f, "Model"), "the Model row to be selected");
}

/**
 * The rendered row that holds `label`, from a character frame.
 *
 * A character frame paints no color at all: what a row states in it, it states
 * in characters, which is what makes these checks the no-color regressions of a
 * warning row.
 */
function rowOf(frame: string, label: string): string {
	const row = rowsOf(frame).find((r) => r.includes(label));
	if (row === undefined) throw new Error(`no rendered row holds ${label}`);
	return row;
}

/** The digits the Context row holds, or its empty hint when it holds none. */
function contextDigitsOf(frame: string): string {
	return frameText(rowOf(frame, "Context")).match(/Context (\S+)/u)?.[1] ?? "";
}

/**
 * The rendered row that states why the row labelled `label` cannot be used.
 *
 * The shared control writes a reason under the row it belongs to, so a warning
 * is never only a tone: this row is what a terminal that paints no color keeps.
 */
function noteOf(frame: string, label: string): string {
	const row = rowsOf(frame).find((r) => r.includes(`Error: ${label}:`));
	if (row === undefined) throw new Error(`no rendered note states a reason for ${label}`);
	return row;
}

/** The written reason a row states under itself, with the frame's padding gone. */
function reasonOf(frame: string, label: string): string {
	return frameText(noteOf(frame, label)).trim();
}

/** Walk the rows to the Context row, the panel's one digits-only field. */
async function moveToContextRow(setup: Awaited<ReturnType<typeof testRender>>): Promise<string> {
	await moveToModelRow(setup);
	await setup.mockInput.pressArrow("down");
	await awaitFrame(setup, (f) => rowSelected(f, "Thinking"), "the Thinking row");
	await setup.mockInput.pressArrow("down");
	return awaitFrame(setup, (f) => rowSelected(f, "Context"), "the Context row to be selected");
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
				// The row's list is the agent's own, so its search answers with a
				// value from that list. Arrows move the caret here, not the value.
				await setup.mockInput.typeText("model-y");
				const shown = await awaitFrame(
					setup,
					(f) => frameText(f).includes("only-for-pilot/model-y"),
					"the agent's own model to match the search",
				);
				expect(frameText(shown)).toContain("Model only-for-pilot/model-y");
			},
		);
	});

	test("the Model search exposes Copy selection and removes it when the caret collapses it", async () => {
		await withPanel(
			{
				agentType: "pilot",
				status: { status: "available", models: ["only-for-pilot/model-y"] },
			},
			INITIAL,
			async (setup) => {
				await moveToModelRow(setup);
				await setup.mockInput.typeText("model-y");
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right", { shift: true });
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("F3 Copy selection"),
					"Copy selection on the Model search",
				);
				setup.mockInput.pressArrow("right");
				await awaitFrame(
					setup,
					(f) => !frameText(f).includes("F3 Copy selection"),
					"Copy selection to leave the bar when the selection collapses",
				);
			},
		);
	});
});

describe("the panel's warning rows come from the Setting fit verdicts", () => {
	/**
	 * One row the Setting fit check refuses: its value wears the warning tone,
	 * and the note under it states the reason in words, so the row never carries
	 * its meaning on the tone alone.
	 */
	function expectUnfit(
		setup: Awaited<ReturnType<typeof testRender>>,
		label: string,
		value: string,
	): void {
		expect(spanColors(setup, value)).toEqual([tone("warning"), tone("error")]);
		expect(reasonOf(setup.captureCharFrame(), label)).toContain(`Error: ${label}:`);
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
				expectUnfit(setup, "Model", "not-offered/model");
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
				expectUnfit(setup, "Thinking", "high");
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
				expectUnfit(setup, "Context", "131072");
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
				expectUnfit(setup, "Context", "000");
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
				expectUnfit(setup, "Thinking", "low");
				await press(setup, "j", "the Environment row", (f) => rowSelected(f, "Environment"));
				await press(setup, "j", "the Task type row", (f) => rowSelected(f, "Task type"));
				await press(setup, "j", "the Model row", (f) => rowSelected(f, "Model"));
				// The Model row takes typing, so the arrow key moves past it.
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => rowSelected(f, "Thinking"), "the Thinking row");
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
				expectUnfit(setup, "Model", "factory-model");
				expectUnfit(setup, "Thinking", "low");
				expectUnfit(setup, "Context", "131072");
				// A warning row is an editing row, not a cycle: the selection reaches
				// it and a typed letter lands in the value the Handoff would send.
				await press(setup, "j", "the Environment row", (f) => rowSelected(f, "Environment"));
				await press(setup, "j", "the Task type row", (f) => rowSelected(f, "Task type"));
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => rowSelected(f, "Model"), "the Model row");
				await setup.mockInput.typeText("x");
				const typedModel = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model factory-modelx"),
					"the Model row to take the typed letter",
				);
				expect(frameText(typedModel)).toContain("Model factory-modelx");
				setup.mockInput.pressArrow("down");
				await awaitFrame(setup, (f) => rowSelected(f, "Thinking"), "the Thinking row");
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
					expectUnfit(setup, "Model", "factory-model");
				},
			);
		}
	});
});

test("FACTORY_PRESENTATION=mono keeps a warning row readable without color", async () => {
	const previous = process.env.FACTORY_PRESENTATION;
	process.env.FACTORY_PRESENTATION = "mono";
	try {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, model: "not-offered/model" },
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => rowsOf(f).some((r) => r.includes("Error: Model:")),
					"the warning row in the mono presentation",
				);
				const expected = sentence(
					settingFit.modelInList({ agentType: "pilot", agent: AGENTS.pilot }, "not-offered/model", [
						"only-for-pilot/model-y",
					]),
				);
				// With no color to paint, the row keeps its value and states the whole
				// sentence under it, so the warning is the writing alone.
				expect(rowOf(frame, "Model")).toContain("not-offered/model");
				expect(reasonOf(frame, "Model")).toBe(`Error: Model: ${expected}`);
				expect(spanColors(setup, "not-offered/model")).not.toContainEqual(tone("warning"));
			},
			{ width: WIDE, height: HEIGHT },
		);
	} finally {
		if (previous === undefined) delete process.env.FACTORY_PRESENTATION;
		else process.env.FACTORY_PRESENTATION = previous;
	}
});

describe("an unfit row states the Handoff's own sentence", () => {
	test("a Model the Agent's list does not report states that refusal on its row", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, model: "not-offered/model" },
			async (setup) => {
				const expected = sentence(
					settingFit.modelInList({ agentType: "pilot", agent: AGENTS.pilot }, "not-offered/model", [
						"only-for-pilot/model-y",
					]),
				);
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes(expected),
					"the Model row to state the Handoff's sentence",
				);
				// The value the Handoff would send stays on its row, and the row under
				// it states the sentence the Handoff would fail with.
				expect(rowOf(frame, "Model")).toContain("not-offered/model");
				expect(reasonOf(frame, "Model")).toBe(`Error: Model: ${expected}`);
			},
			{ width: WIDE, height: HEIGHT },
		);
	});

	test("a Thinking level the Agent does not offer states that refusal on its row", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, thinking: "high" },
			async (setup) => {
				const expected = sentence(
					settingFit.staticFit(
						{ agentType: "pilot", agent: AGENTS.pilot },
						{ ...NO_SETTINGS, thinking: "high" },
					).thinking,
				);
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes(expected),
					"the Thinking row to state the Handoff's sentence",
				);
				expect(reasonOf(frame, "Thinking")).toBe(`Error: Thinking: ${expected}`);
			},
			{ width: WIDE, height: HEIGHT },
		);
	});

	test("a Context count the Agent maps no template for states that refusal on its row", async () => {
		await withPanel(
			{ agentType: "scribe", status: { status: "available", models: ["only-for-scribe/model-y"] } },
			{ ...INITIAL, agentType: "scribe", contextWindow: "131072" },
			async (setup) => {
				const expected = sentence(
					settingFit.staticFit(
						{ agentType: "scribe", agent: AGENTS.scribe },
						{ ...NO_SETTINGS, contextWindow: "131072" },
					).contextWindow,
				);
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes(expected),
					"the Context row to state the Handoff's sentence",
				);
				expect(reasonOf(frame, "Context")).toBe(`Error: Context: ${expected}`);
			},
			{ width: WIDE, height: HEIGHT },
		);
	});

	test("a Context row that holds no count states that refusal on its row", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "000" },
			async (setup) => {
				const expected = sentence(
					settingFit.staticFit(
						{ agentType: "pilot", agent: AGENTS.pilot },
						{ ...NO_SETTINGS, contextWindow: "000" },
					).contextWindow,
				);
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes(expected),
					"the Context row to state the count rule",
				);
				expect(reasonOf(frame, "Context")).toBe(`Error: Context: ${expected}`);
			},
			{ width: WIDE, height: HEIGHT },
		);
	});

	test("a panel too narrow for the sentence still states it in characters", async () => {
		// 46 columns leave a note far less than a whole sentence. What fits is
		// written, so the row is never only the tone the terminal may not paint.
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, model: "not-offered/model" },
			async (setup) => {
				const cells = panelNoteCells(46, HEIGHT);
				const expected = sentence(
					settingFit.modelInList({ agentType: "pilot", agent: AGENTS.pilot }, "not-offered/model", [
						"only-for-pilot/model-y",
					]),
				);
				const frame = await awaitFrame(
					setup,
					(f) => rowsOf(f).some((r) => r.includes("Error: Model:")),
					"the Model row to state its reason",
				);
				expect(rowOf(frame, "Model")).toContain("not-offered/model");
				expect(reasonOf(frame, "Model")).toBe(`Error: Model: ${expected}`.slice(0, cells).trim());
				expect(frameText(rowOf(frame, "Agent"))).not.toContain("Error:");
			},
			{ width: 46, height: HEIGHT },
		);
	});
});

// The sentence is characters, not color, and the note has a fixed number of
// them: this pins what a row states and exactly how much of it fits, one cell
// of the sentence at a time.
test("a warning row states exactly the sentence its note cells hold", async () => {
	await withPanel(
		{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
		{ ...INITIAL, thinking: "high" },
		async (setup) => {
			const expected = sentence(
				settingFit.staticFit(
					{ agentType: "pilot", agent: AGENTS.pilot },
					{ ...NO_SETTINGS, thinking: "high" },
				).thinking,
			);
			const note = `Error: Thinking: ${expected}`;
			// The panel states how much of a sentence one terminal size holds, so
			// this check reads that width instead of mirroring the box's arithmetic.
			const cells = panelNoteCells(WIDTH, HEIGHT);
			expect(note.length).toBeGreaterThan(cells);
			const frame = await awaitFrame(
				setup,
				(f) => f.includes(note.slice(0, cells)),
				"the Thinking row to fill its note",
			);
			expect(reasonOf(frame, "Thinking")).toBe(note.slice(0, cells).trim());
		},
		{ width: WIDTH, height: HEIGHT },
	);
});

describe("the Context row refuses an entry it cannot take", () => {
	/**
	 * The frame in which the Context row states its own refusal.
	 *
	 * The refusal is the field's own news, so the shared field writes it under
	 * the row it refused on: no surface has to repeat it in its own words.
	 */
	function refusedFrame(setup: Awaited<ReturnType<typeof testRender>>): Promise<string> {
		return awaitFrame(
			setup,
			(f) => rowsOf(f).some((r) => r.includes("Error: Context:")),
			"the Context row to state its refusal",
		);
	}

	test("a paste that is no digits is refused whole, and never picked over", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "" },
			async (setup) => {
				await moveToContextRow(setup);
				// The whole paste is refused: the row never keeps the digits that
				// sat inside it, which is how `1e3` could otherwise become `13`.
				await setup.mockInput.pasteBracketedText("1e3");
				const refused = await refusedFrame(setup);
				expect(contextDigitsOf(refused)).toBe("(empty)");
				expect(reasonOf(refused, "Context")).toBe(
					"Error: Context: Context window accepts digits only: the pasted text was refused as a whole",
				);
				// The field states its own refusal, so the panel says it once and not
				// again on the Message line.
				expect(refusals).toEqual([]);
			},
		);
	});

	test("a mixed-character paste leaves a count and its caret where they were", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "272000" },
			async (setup) => {
				await moveToContextRow(setup);
				// The caret stands after the first digit, where the arrows left it.
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right");
				await setup.mockInput.pasteBracketedText("12ab34");
				const refused = await refusedFrame(setup);
				expect(contextDigitsOf(refused)).toBe("272000");
				// The refusal changed nothing, so the next digit still lands where the
				// caret stood before it: between the first digit and the rest.
				await setup.mockInput.typeText("9");
				const inserted = await awaitFrame(
					setup,
					(f) => contextDigitsOf(f) === "2972000",
					"the digit to land at the caret the refusal left",
				);
				expect(contextDigitsOf(inserted)).toBe("2972000");
			},
		);
	});

	test("a refused paste leaves a selection in place", async () => {
		/**
		 * The count the row holds after a selection, an optional refused paste, and
		 * one digit.
		 *
		 * The refused paste has to leave the editing state alone, so the run with it
		 * and the run without it end on the same count: no assumption about how many
		 * cells a selection covers is needed to say that.
		 */
		async function digitsAfterPaste(refuse: boolean): Promise<string> {
			let final = "";
			await withPanel(
				{
					agentType: "pilot",
					status: { status: "available", models: ["only-for-pilot/model-y"] },
				},
				{ ...INITIAL, contextWindow: "272000" },
				async (setup) => {
					await moveToContextRow(setup);
					setup.mockInput.pressKey("HOME");
					for (const _ of "27") setup.mockInput.pressArrow("right", { shift: true });
					if (refuse) await setup.mockInput.pasteBracketedText("1x2");
					await settle(setup);
					setup.mockInput.pressKey("9");
					final = contextDigitsOf(await settle(setup));
				},
			);
			return final;
		}

		// The refusal stated itself, and nothing else changed.
		expect(await digitsAfterPaste(true)).toBe(await digitsAfterPaste(false));
	});

	test("a paste of digits is taken as the count it is", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "" },
			async (setup) => {
				await moveToContextRow(setup);
				await setup.mockInput.pasteBracketedText("131072");
				const taken = await awaitFrame(
					setup,
					(f) => contextDigitsOf(f) === "131072",
					"the digits to land as the count",
				);
				expect(contextDigitsOf(taken)).toBe("131072");
				expect(refusals).toEqual([]);
				// A paste the row took states nothing: a note is the news of a refusal.
				expect(rowsOf(taken).some((r) => r.includes("Error: Context:"))).toBe(false);
			},
		);
	});

	test("a paste with a newline or Unicode is refused as a whole", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "272000" },
			async (setup) => {
				await moveToContextRow(setup);
				await setup.mockInput.pasteBracketedText("12\n٣4");
				const refused = await refusedFrame(setup);
				expect(contextDigitsOf(refused)).toBe("272000");
				expect(reasonOf(refused, "Context")).toContain("refused as a whole");
			},
		);
	});

	test("a typed character that is no digit is refused and leaves the count unchanged", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "1" },
			async (setup) => {
				await moveToContextRow(setup);
				// A letter with an accent and a digit from another script are both
				// characters this row cannot take, whatever a terminal reports them as.
				await setup.mockInput.typeText("é١");
				const refused = await refusedFrame(setup);
				expect(contextDigitsOf(refused)).toBe("1");
				expect(reasonOf(refused, "Context")).toBe(
					"Error: Context: Context window accepts digits only",
				);
			},
		);
	});

	test("a typed letter is refused on its own, and the digits beside it stand", async () => {
		await withPanel(
			{ agentType: "pilot", status: { status: "available", models: ["only-for-pilot/model-y"] } },
			{ ...INITIAL, contextWindow: "" },
			async (setup) => {
				await moveToContextRow(setup);
				await setup.mockInput.typeText("1");
				await awaitFrame(setup, (f) => contextDigitsOf(f) === "1", "the first digit");
				// The `e` of `1e3` never reaches the field at all, so the row keeps
				// the one digit it holds and says why nothing happened.
				await setup.mockInput.typeText("e");
				const refused = await refusedFrame(setup);
				expect(contextDigitsOf(refused)).toBe("1");
				expect(reasonOf(refused, "Context")).toBe(
					"Error: Context: Context window accepts digits only",
				);
				expect(refusals).toEqual([]);
				await setup.mockInput.typeText("3");
				const next = await awaitFrame(
					setup,
					(f) => contextDigitsOf(f) === "13",
					"the row to keep taking digits",
				);
				expect(contextDigitsOf(next)).toBe("13");
				// An entry the row took ends the refusal: the reason was about the key
				// that did not go in, so it never lingers under a count that moved on.
				expect(rowsOf(next).some((r) => r.includes("Error: Context:"))).toBe(false);
			},
		);
	});

	test("a row that is not the Context row takes the same text whole", async () => {
		// The refusal belongs to the digits row alone: a Model field still takes
		// every character the operator can type.
		await withPanel(
			{ agentType: "mute", status: NO_LIST },
			{ ...INITIAL, agentType: "mute" },
			async (setup) => {
				await moveToModelRow(setup);
				await setup.mockInput.pasteBracketedText("1e3");
				const taken = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model 1e3"),
					"the Model field to take the paste",
				);
				expect(frameText(taken)).toContain("Model 1e3");
				expect(refusals).toEqual([]);
			},
		);
	});
});
