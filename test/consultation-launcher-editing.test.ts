/**
 * The launcher's operator-facing editing contract, through the real flow.
 *
 * Every check here opens the launcher the way an operator does - `c` from the
 * Ticket view - and judges the frame and the observable result the flow
 * produces. The reported failures the shared control standard answers all live
 * here: Enter in a Draft field must not start Agent work, closing must keep
 * unfinished text, discarding must be its own deliberate action, and the Key
 * guide must name the editing keys a field owns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { FactoryConfig } from "../src/config.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { Setup } from "./app-harness.ts";
import {
	awaitFrame,
	frameText,
	HEIGHT,
	openLauncher,
	press,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { FakeRunner } from "./fake-runner.ts";
import { cleanupStateFixtures, freshState } from "./state-fixture.ts";

const IDENTITY = "github.com/acme/repo";
let checkout: string;

function launcherConfig(): FactoryConfig {
	return {
		defaultAgent: "demo",
		defaultEnvironment: "live-worktree",
		defaultTaskType: "implement",
		agents: { demo: { kind: "demo" } },
		taskTypes: { implement: { template: "Implement {title}", autoClose: false } },
		consultationTypes: {
			grill: { agent: "demo", environment: "live-worktree", template: "/grill {input}" },
			design: { agent: "demo", environment: "live-worktree", template: "/design {input}" },
		},
		attentionBell: false,
		interactionExitKey: "f12",
		autoHandoff: false,
		maxParallelAgents: 2,
		agentPollIntervalSeconds: 60,
		completionMessageLines: 20,
		maxHandoffsPerTicket: 3,
		scroll: { speed: 2, acceleration: 0, maximumSpeed: 4 },
		workflows: [],
		repos: { [IDENTITY]: checkout },
		sources: [],
		taskRules: [],
	};
}

/** A runner that verifies the mapped checkout and holds no herdr agent. */
function launcherRunner(): FakeRunner {
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], { stdout: '{"agents":[]}' });
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/repo.git\n",
	});
	return runner;
}

beforeAll(() => {
	checkout = mkdtempSync(join(tmpdir(), "factory-launcher-"));
});

afterAll(() => {
	rmSync(checkout, { recursive: true, force: true });
	cleanupStateFixtures();
});

/** Tab `count` slots forward and wait for the frame to name the new one. */
async function tabUntil(setup: Setup, count: number, what: string): Promise<string> {
	for (let step = 0; step < count; step += 1) setup.mockInput.pressTab();
	return awaitFrame(setup, (f) => frameText(f).includes(what), `the focus on ${what}`);
}

/** Tab to the Draft field, and wait until the field really holds the keys. */
async function focusDraft(setup: Setup): Promise<void> {
	await tabUntil(setup, 2, "❯ Initial input");
}

/** Run one launcher flow at the real app seam, with its own fake runner. */
async function withLauncher(
	body: (setup: Setup & { runner: FakeRunner; state: FactoryState }) => Promise<void>,
): Promise<void> {
	const runner = launcherRunner();
	const state = freshState();
	await withApp(
		async (setup) => {
			await body(Object.assign(setup, { runner, state }));
		},
		WIDTH,
		HEIGHT,
		{ config: launcherConfig(), runner, initialTickets: [], state },
	);
}

describe("the Consultation launcher's editing baseline", () => {
	test("a plain Enter in the Draft field adds a line instead of launching", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await focusDraft(setup);
			await setup.mockInput.typeText("first line");
			setup.mockInput.pressEnter();
			await setup.mockInput.typeText("second line");
			const frame = await awaitFrame(
				setup,
				(f) => frameText(f).includes("first line second line"),
				"the two lines the operator typed",
			);
			// The Consultation is still not open: an ordinary editing key never
			// started Agent work on the operator's behalf.
			expect(frameText(frame)).toContain("Consultation launcher");
			expect(setup.state.consultations("open")).toEqual([]);

			// The visible Launch action is what submits the draft.
			await tabUntil(setup, 1, "❯ Launch Consultation");
			setup.mockInput.pressEnter();
			await awaitFrame(
				setup,
				(f) => !frameText(f).includes("Consultation launcher"),
				"the Launch action to open the Consultation",
			);
			const opened = setup.state.consultations("open");
			expect(opened).toHaveLength(1);
			// Both lines the operator typed are the Consultation's own input: the
			// newline is text, not a key that meant something else.
			expect(opened[0]?.initialInput).toBe("first line\nsecond line");
		});
	});

	test("closing keeps the unfinished text and states that a restart would not", async () => {
		await withLauncher(async (setup) => {
			const draft = "a draft with several words";
			await openLauncher(setup);
			await focusDraft(setup);
			await setup.mockInput.typeText(draft);
			setup.mockInput.pressEscape();
			await awaitFrame(setup, (f) => !frameText(f).includes("Consultation launcher"), "close");
			const reopened = await press(setup, "c", "the launcher to reopen", (f) =>
				frameText(f).includes("Consultation launcher"),
			);
			expect(frameText(reopened)).toContain(draft);
			expect(frameText(reopened)).toContain("not saved across restarts");
		});
	});

	test("Discard is the only route that deletes unfinished text", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await focusDraft(setup);
			await setup.mockInput.typeText("text worth keeping");
			tabUntil(setup, 2, "❯ Discard");
			setup.mockInput.pressEnter();
			await awaitFrame(setup, (f) => !frameText(f).includes("Consultation launcher"), "closed");
			const reopened = await press(setup, "c", "the launcher to reopen", (f) =>
				frameText(f).includes("Consultation launcher"),
			);
			expect(frameText(reopened)).not.toContain("text worth keeping");
		});
	});

	test("the Repository and Consultation type stay with the retained text", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			// One cycle on the Type choice moves it to the other configured type.
			await tabUntil(setup, 0, "❯ Type");
			setup.mockInput.pressArrow("right");
			await awaitFrame(setup, (f) => frameText(f).includes("Type design"), "the other type");
			await focusDraft(setup);
			await setup.mockInput.typeText("a held draft");
			setup.mockInput.pressEscape();
			await awaitFrame(setup, (f) => !frameText(f).includes("Consultation launcher"), "close");
			const reopened = await press(setup, "c", "the launcher to reopen", (f) =>
				frameText(f).includes("Consultation launcher"),
			);
			expect(frameText(reopened)).toContain("Repository acme/repo");
			expect(frameText(reopened)).toContain("Type design");
			expect(frameText(reopened)).toContain("a held draft");
		});
	});

	test("Help above the launcher keeps the draft, the caret, and the selection", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await focusDraft(setup);
			await setup.mockInput.typeText("draft before help");
			setup.mockInput.pressKey("HOME");
			setup.mockInput.pressArrow("right", { shift: true });
			setup.mockInput.pressArrow("right", { shift: true });
			await setup.flush();
			setup.mockInput.pressKey("F1");
			const guide = await awaitFrame(setup, (f) => frameText(f).includes("Key guide"), "the guide");
			// The guide names field editing, so basic editing is no operator's
			// private knowledge.
			expect(frameText(guide)).toContain("Undo");
			expect(frameText(guide)).toContain("Insert a new line");
			setup.mockInput.pressEscape();
			await awaitFrame(
				setup,
				(f) => frameText(f).includes("Consultation launcher"),
				"the launcher",
			);
			// The two-cell selection is still the selection: asking for help changed
			// nothing about the operator's work.
			setup.mockInput.pressKey("q");
			await awaitFrame(
				setup,
				(f) => frameText(f).includes("qaft before help"),
				"the typed character to replace the selection",
			);
		});
	});

	test("an oversized draft stays editable and states its size and limit", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await focusDraft(setup);
			await setup.mockInput.pasteBracketedText("x".repeat(64 * 1024 + 1));
			const frame = await awaitFrame(
				setup,
				(f) => frameText(f).includes("65537 UTF-8 bytes"),
				"the size and the limit",
			);
			expect(frameText(frame)).toContain("the limit is 65536");
			// The text stands: the operator shortens it rather than retyping it.
			expect(frameText(frame)).toContain("xxxxxxxxxx");
		});
	});

	test("Tab reaches every field and action, and the bar names them", async () => {
		await withLauncher(async (setup) => {
			const opened = await openLauncher(setup);
			expect(frameText(opened)).toContain("❯ Type");
			const repository = await tabUntil(setup, 1, "❯ Repository");
			expect(frameText(repository)).toContain("Repository acme/repo");
			await tabUntil(setup, 1, "❯ Initial input");
			const launch = await tabUntil(setup, 1, "❯ Launch Consultation");
			expect(frameText(launch)).toContain("Discard");
			// The bar names a control the launcher actually dispatches.
			const rows = frameText(launch).split(" ");
			expect(rows.join(" ")).toContain("Enter Confirm");
		});
	});

	test("an unavailable action states why it cannot run", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			// An empty draft is not a Consultation: the visible action refuses, and
			// states why instead of failing in silence.
			tabUntil(setup, 3, "❯ Launch Consultation");
			setup.mockInput.pressEnter();
			const refused = await awaitFrame(
				setup,
				(f) => frameText(f).includes("initial input cannot be empty"),
				"the refusal",
			);
			expect(frameText(refused)).toContain("Consultation launcher");
			expect(setup.runner.commands().some((call) => call.startsWith("herdr"))).toBe(false);
		});
	});
});
