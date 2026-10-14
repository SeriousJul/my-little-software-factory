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

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import type { FactoryState } from "../src/state.ts";
import type { Setup } from "./app-harness.ts";
import {
	fieldKey,
	frameText,
	frameUntil,
	guideKey,
	HEIGHT,
	pasteText,
	pressControl,
	settle,
	tabUntilSlot,
	typeText,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import type { FakeRunner } from "./fake-runner.ts";
import { plane } from "./plane.ts";

const IDENTITY = "github.com/acme/repo";

function launcherConfig(): Partial<FactoryConfig> {
	return {
		defaultAgent: "demo",
		defaultEnvironment: "live-worktree",
		defaultTaskType: "implement",
		agents: { demo: { kind: "demo" } },
		taskTypes: { implement: { template: "Implement {title}" } },
		consultationTypes: {
			grill: { agent: "demo", environment: "live-worktree", template: "/grill {input}" },
			design: { agent: "demo", environment: "live-worktree", template: "/design {input}" },
		},
		attentionBell: false,
		desktopNotification: false,
		interactionExitKey: "f12",
		maxParallelAgents: 2,
		agentPollIntervalSeconds: 60,
		completionMessageLines: 20,
		maxHandoffsPerTicket: 3,
		scroll: { speed: 2, acceleration: 0, maximumSpeed: 4 },
		workflowStates: [],
		sources: [],
	};
}

/** Tab to the Draft field, and wait until the field really holds the keys. */
async function focusDraft(setup: Setup): Promise<void> {
	await tabUntilSlot(setup, "❯ Initial input");
}

/** Run one launcher flow at the real app seam, with its own fake runner. */
async function withLauncher(
	body: (setup: Setup & { runner: FakeRunner; state: FactoryState }) => Promise<void>,
): Promise<void> {
	const planeRecord = await plane({
		config: launcherConfig(),
		sources: [],
		repos: { [IDENTITY]: "checkout" },
		commands: (fake, home) => {
			const checkout = join(home, "checkout");
			fake.set("git", ["-C", checkout, "rev-parse", "--git-dir"], {
				stdout: ".git\n",
			});
			fake.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
				stdout: "https://github.com/acme/repo.git\n",
			});
		},
	});
	await withApp(
		async (setup) => {
			await body(
				Object.assign(setup, {
					runner: setup.plane.fakeRunner,
					state: setup.plane.state,
				}),
			);
		},
		{
			width: WIDTH,
			height: HEIGHT,
			plane: planeRecord,
		},
	);
}

describe("the Consultation launcher's editing baseline", () => {
	test("a plain Enter in the Draft field adds a line instead of launching", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await typeText(setup, "first line");
			fieldKey(setup, "enter");
			await typeText(setup, "second line");
			const frame = await frameUntil(setup, "the two lines the operator typed", (f) =>
				frameText(f).includes("first line second line"),
			);
			// The Consultation is still not open: an ordinary editing key never
			// started Agent work on the operator's behalf.
			expect(frameText(frame)).toContain("Consultation launcher");
			expect(setup.state.consultationRecord.consultations("open")).toEqual([]);

			// The visible Launch action is what submits the draft.
			await tabUntilSlot(setup, "❯ Launch Consultation");
			await pressControl(setup, "confirm-choice", { closes: "Consultation launcher" });
			const opened = setup.state.consultationRecord.consultations("open");
			expect(opened).toHaveLength(1);
			// Both lines the operator typed are the Consultation's own input: the
			// newline is text, not a key that meant something else.
			expect(opened[0]?.initialInput).toBe("first line\nsecond line");
		});
	});

	test("closing keeps the unfinished text and states that a restart would not", async () => {
		await withLauncher(async (setup) => {
			const draft = "a draft with several words";
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await typeText(setup, draft);
			await pressControl(setup, "close-form", { closes: "Consultation launcher" });
			const reopened = await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			expect(frameText(reopened)).toContain(draft);
			expect(frameText(reopened)).toContain("not saved across restarts");
		});
	});

	test("Discard is the only route that deletes unfinished text", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await typeText(setup, "text worth keeping");
			await tabUntilSlot(setup, "❯ Discard");
			await pressControl(setup, "confirm-choice", { closes: "Consultation launcher" });
			const reopened = await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			expect(frameText(reopened)).not.toContain("text worth keeping");
		});
	});

	test("the Repository and Consultation type stay with the retained text", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			// One cycle on the Type choice moves it to the other configured type.
			await tabUntilSlot(setup, "❯ Type");
			await pressControl(setup, "cycle-choice", { via: "→", shows: "Type design" });
			await focusDraft(setup);
			await typeText(setup, "a held draft");
			await pressControl(setup, "close-form", { closes: "Consultation launcher" });
			const reopened = await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			expect(frameText(reopened)).toContain("Repository acme/repo");
			expect(frameText(reopened)).toContain("Type design");
			expect(frameText(reopened)).toContain("a held draft");
		});
	});

	test("Help above the launcher keeps the draft, the caret, and the selection", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await typeText(setup, "draft before help");
			fieldKey(setup, "home");
			fieldKey(setup, "shift+right");
			fieldKey(setup, "shift+right");
			await settle(setup);
			const guide = await pressControl(setup, "help", { opens: "Key guide" });
			// The guide names field editing, so basic editing is no operator's
			// private knowledge.
			expect(frameText(guide)).toContain("Undo");
			expect(frameText(guide)).toContain("Insert a new line");
			await guideKey(setup, "guide-close", "Esc", { closes: "Key guide" });
			// The two-cell selection is still the selection: asking for help changed
			// nothing about the operator's work.
			await typeText(setup, "q");
			await frameUntil(setup, "the typed character to replace the selection", (f) =>
				frameText(f).includes("qaft before help"),
			);
		});
	});

	test("Ctrl+A selects the whole draft, and F3 copies it as news on the Message line", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await typeText(setup, "copy this part");
			// The Key guide names Ctrl+A for Select all, and the field obeys the key
			// the guide names: the bar offers the copy while a selection is held.
			fieldKey(setup, "ctrl+a");
			await frameUntil(setup, "the bar to name the copy", (f) => f.includes("F3 Copy selection"));
			const frame = await pressControl(setup, "copy-selection", {
				shows: "Copied 14 cells of selected text",
			});
			// The success is news the field reports, not a refusal wearing a warning.
			expect(frameText(frame)).toContain("Info: Copied 14 cells of selected text");
			expect(frameText(frame)).not.toContain("Warning:");
		});
	});

	test("an oversized draft stays editable and states its size and limit", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			await focusDraft(setup);
			await pasteText(setup, "x".repeat(64 * 1024 + 1));
			const frame = await frameUntil(setup, "the size and the limit", (f) =>
				frameText(f).includes("65537 UTF-8 bytes"),
			);
			expect(frameText(frame)).toContain("the limit is 65536");
			// The text stands: the operator shortens it rather than retyping it.
			expect(frameText(frame)).toContain("xxxxxxxxxx");
		});
	});

	test("Tab reaches every field and action, and the bar names them", async () => {
		await withLauncher(async (setup) => {
			const opened = await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			expect(frameText(opened)).toContain("❯ Type");
			const repository = await tabUntilSlot(setup, "❯ Repository");
			expect(frameText(repository)).toContain("Repository acme/repo");
			await tabUntilSlot(setup, "❯ Initial input");
			const launch = await tabUntilSlot(setup, "❯ Launch Consultation");
			expect(frameText(launch)).toContain("Discard");
			// The bar names a control the launcher actually dispatches.
			const rows = frameText(launch).split(" ");
			expect(rows.join(" ")).toContain("Enter Confirm");
		});
	});

	test("an unavailable action states why it cannot run", async () => {
		await withLauncher(async (setup) => {
			await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
			// An empty draft is not a Consultation: the visible action refuses, and
			// states why instead of failing in silence.
			await tabUntilSlot(setup, "❯ Launch Consultation");
			await pressControl(setup, "confirm-choice", { quiet: true });
			const refused = await frameUntil(setup, "the refusal", (f) =>
				frameText(f).includes("initial input cannot be empty"),
			);
			expect(frameText(refused)).toContain("Consultation launcher");
			expect(setup.runner.commands().some((call) => call.startsWith("herdr"))).toBe(false);
		});
	});
});
