/**
 * The Live view: the in-flight ticket's own screen. Enter on a handed-off or
 * running ticket opens it near-fullscreen, streaming the agent's terminal
 * output in plain text on the one-second cadence. The one row is the Goto;
 * the bottom pin follows new output until the operator scrolls. When the
 * turn settles and the factory waits for the operator, the same box carries
 * the Decision modal's body and rows; when the agent leaves herdr it
 * carries the Missing modal; a routed handoff keeps the screen and streams
 * the new pane.
 *
 * The list-level tests run the real app on the Seeded plane's standing -
 * the sample tickets, the flat list, the held loop - with a fake command
 * runner standing in for herdr. The factory-level tests stand one in-flight
 * ticket through the state API and run the observation loop on a pinned
 * poll interval, so the settles, the markers, and the transforms happen the
 * way they happen in production.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeyEvent } from "@opentui/core";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import {
	type AppSetup,
	awaitBaseKeyHandlers,
	awaitFrame,
	type BaseKeyHandlers,
	baseKeyHandlers,
	frameText,
	HEIGHT,
	keyHandlerListeners,
	markerRowOf,
	openGuide,
	openPanel,
	press,
	pressArrow,
	pressEnterQuiet,
	pressScrollKey,
	rgb,
	roleColor,
	rowsOf,
	settle,
	sleep,
	spanColors,
	startingFaceOf,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	agentListJson,
	FakeRunner,
	tabCreateJson,
	workspaceGetJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { flushPassiveNow } from "./passive-flush-hold.ts";
import { plane, type SeededPlane, ticketOf } from "./seeded-plane.ts";

/** The pane read the Live view's stream runs, for a pane and its tail. */
const READ = (pane: string) =>
	[
		"agent",
		"read",
		pane,
		"--lines",
		"200",
		"--source",
		"recent-unwrapped",
		"--format",
		"text",
	] as const;

/** The exact command string a pane read records in the runner. */
const READ_COMMAND = (pane: string) =>
	`herdr agent read ${pane} --lines 200 --source recent-unwrapped --format text`;

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The path of a pi session record of one completed turn, the way herdr
 * reports it. The turn's end is in the record, so the settle is immediate,
 * without the startup grace (ADR 0017): these tests watch the screen's
 * transforms, not the boot window.
 */
function settledSession(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-live-view-"));
	paths.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			timestamp: "2026-08-31T11:00:00Z",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text }],
			},
		})}\n`,
		"utf8",
	);
	return file;
}

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const repoIdentity = "github.com/acme/factory";

function fetched(index = 5, title = "Persist source facts"): FetchedTicket {
	return {
		identity: `github:github.com:I_${index}`,
		sourceKind: "github-issue",
		externalKey: `#${index}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${index}`,
		title,
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: `https://${repoIdentity}.git`,
		},
		attributes: {},
	};
}

/** Stub the git answers for the checkout the plane's config maps to. */
function stubCheckoutInto(fake: FakeRunner, home: string): void {
	const path = join(home, "src", "factory");
	fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
}

/** The source config the standing lists its ticket on. */
const sourceConfig = {
	name: "issues",
	kind: "github-issues" as const,
	refreshIntervalSeconds: 60,
	repositories: [repoIdentity],
	host: "github.com",
};

/**
 * The plane the factory-level tests stand on: the ticket in flight -
 * claimed, settled to the stored herdr handles, and resting in handed-off -
 * on the flat Grouping axis, under the config the case names over the base,
 * on the pinned clock the fixture day writes from. The handoff starts inside
 * the fixture day, so a session record stamped on it is this run's, not the
 * run before: the staleness guard keeps the settle's `completed` cause.
 */
async function seededPlane(extra: Partial<FactoryConfig> = {}): Promise<SeededPlane> {
	const ticket = ticketOf(fetched(), {
		state: "handed-off",
		workCycle: 2,
		handoff: {
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
			attemptId: "attempt-implement",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			herdrName: "persist-source-facts",
		},
	});
	return await plane({
		groupingAxis: "none",
		now: () => Date.parse("2026-08-31T10:30:00Z"),
		sources: [{ config: sourceConfig, tickets: [ticket] }],
		repos: { [repoIdentity]: "src/factory" },
		config: {
			// The issue-side machine these tests fire: the implement transition
			// writes the review fact, and the state it lands on offers the review.
			workflowStates: [
				{
					name: "ready-for-review",
					taskType: "review",
					match: { labelsAny: ["ready-for-review"] },
				},
			],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
				},
			},
			...extra,
		},
	});
}

/** Enter through the real key path, then wait for its effect. */
async function pressReturn(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	return await awaitFrame(setup, predicate, what);
}

/**
 * The ticket's list row, by its title.
 *
 * The dual-list frame (ADR 0019) truncates the list row's title, so the row
 * is found by the selection marker and the title's leading cells, with the
 * full-title row (the detail pane, the modal's title) as the fallback a
 * modal frame offers.
 */
function ticketRow(frame: string, title = "Persist source facts"): string {
	const rows = rowsOf(frame);
	const row =
		rows.find((line) => line.includes("❯") && line.includes(title.slice(0, 3))) ??
		rows.find((line) => line.includes(title));
	if (row === undefined) throw new Error(`no ticket row for ${title} in frame:\n${frame}`);
	return row;
}

/**
 * The in-flight face the row wears (ADR 0030): the Starting window's
 * spinner face while the window holds, or the `[running]` badge once the
 * observation has seen the work.
 */
const inFlightFace = (row: string): boolean =>
	startingFaceOf(row) !== null || row.includes("[running]");

/**
 * Wait for a route's ask to end the Live view: the list drawn again, and the
 * keys the closed surfaces held given back.
 *
 * The fallback is a transition of its own. The confirm's own frame can still
 * hold the Live view, streaming the new pane, with the start's line already on
 * the Message line, and that frame is exactly as quiet as the one after the
 * swap, so no `settle` result carries the assertion (issue #304). The wait takes
 * the list's own box back on screen - the Live view paints the terminal alone,
 * so the border's return is the fallback drawn - beside the absence the case
 * then narrows, so a frame with nothing drawn cannot pass it either.
 *
 * The keys go next. The frame falls back before the closing surface's effect
 * cleanup removes its handler, and a press sent in that window reaches the stale
 * handler, which acts with the closed surface's meaning: the plane carries that
 * race as issue #317, and the walk's next press stands on the release.
 */
async function awaitFallbackToTheList(setup: AppSetup, base: BaseKeyHandlers): Promise<string> {
	const listFrame = await awaitFrame(
		setup,
		(f) => f.includes("┌─❯ Tickets") && !f.includes("Live:"),
		"the Live view to fall back to the list",
	);
	await awaitBaseKeyHandlers(setup, base, "the Live view to release the keys");
	return listFrame;
}

describe("the Live view on the ticket list", () => {
	test("g on an open ticket refuses with the Consultation section's words", async () => {
		const fake = new FakeRunner();
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				// The walk lands on the open ticket: it holds no agent and no
				// pane, so `g` states the Consultation section's own refusal
				// on the Message line and focuses nothing.
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);
				await press(setup, "j", "the open ticket", (f) => markerRowOf(f) === 6);
				const frame = await press(setup, "g", "the refusal", (f) =>
					f.includes("the Agent's pane is not alive in the last poll"),
				);
				expect(frame).toContain("Warning:");
				expect(fake.commands()).not.toContain("herdr agent focus");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("enter on an in-flight ticket opens the Live view above the list", async () => {
		const fake = new FakeRunner();
		fake.set("herdr", [...READ("pane-implement")], {
			stdout: "the layout math is off by one\n",
		});
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				// The walk lands on the Starting ticket: its handoff already
				// records the pane the Live view streams.
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				// The pop-in settles before the geometry is measured.
				await sleep(250);
				// Near-fullscreen: the box's border sits one cell in from the
				// terminal's edge on top, and the shared chrome keeps the box
				// above its own Message line, so the bottom border stands two
				// cells in from the edge.
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				expect(rows[1].slice(0, 2)).toBe(" ┌");
				expect(rows[HEIGHT - 3].slice(0, 2)).toBe(" └");
				// The context line names the repository, the task, the agent.
				expect(frame).toContain("acme/portal · implement · codex");
				// The pane carries the stream, and the bar names the Goto confirm.
				expect(frame).toContain("Agent view");
				expect(frame).toContain("Enter Goto");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the stream shows the agent's output as plain text", async () => {
		const fake = new FakeRunner();
		fake.set("herdr", [...READ("pane-implement")], {
			stdout: "line one of the agent work\nline two of the agent work\n",
		});
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("line one of the agent work"),
					"the stream",
				);
				expect(frame).toContain("line two of the agent work");
				// The pop-in settles before the color is measured.
				await sleep(250);
				// Plain text in the palette's prose voice: no ANSI, no styling.
				expect(spanColors(setup, "line one of the agent work")).toContainEqual(
					rgb(roleColor("text")),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the stream refreshes on the one-second cadence", async () => {
		const fake = new FakeRunner();
		fake.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[
				{ stdout: "first tick\n" },
				{ stdout: "first tick\nsecond tick\n" },
				{ stdout: "first tick\nsecond tick\n" },
			],
		);
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				await awaitFrame(setup, (f) => f.includes("first tick"), "the first read");
				// The next read lands on the cadence: the new line arrives
				// without any key press.
				await awaitFrame(setup, (f) => f.includes("second tick"), "the refresh");
				expect(
					fake.commands().filter((c) => c === READ_COMMAND("pane-implement")).length,
				).toBeGreaterThanOrEqual(2);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("new output pins the stream to the bottom", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join("\n");
		const fake = new FakeRunner();
		fake.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[{ stdout: `${many(30)}\n` }, { stdout: `${many(35)}\n` }, { stdout: `${many(35)}\n` }],
		);
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const first = await awaitFrame(
					setup,
					(f) => f.includes("tick 30"),
					"the first read at the bottom",
				);
				// The body is shorter than the output: the bottom is in view,
				// the top has scrolled past.
				expect(first).not.toContain("tick 01");
				// The next read appends: the pin follows the newest line, and
				// what the pin pushed out stays out.
				await awaitFrame(setup, (f) => f.includes("tick 35"), "the next read");
				expect(frameText(setup.captureCharFrame())).not.toContain("tick 10");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a manual scroll releases the bottom pin", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join("\n");
		const fake = new FakeRunner();
		fake.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[{ stdout: `${many(30)}\n` }, { stdout: `${many(35)}\n` }, { stdout: `${many(35)}\n` }],
		);
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const first = await awaitFrame(
					setup,
					(f) => f.includes("tick 30"),
					"the first read at the bottom",
				);
				expect(first).not.toContain("tick 01");
				// Three rows up: the operator is reading, not following. The
				// window is short of the full tail, so the last tick leaves on
				// the first press, and tick 10 comes in on the third.
				await press(setup, "k", "the first scroll row", (f) => !f.includes("tick 30"));
				await press(setup, "k", "the second scroll row", (f) => f.includes("tick 11"));
				await press(setup, "k", "the third scroll row", (f) => f.includes("tick 10"));
				// The next read arrives while the operator reads: the window
				// holds where the operator put it.
				await sleep(1300);
				expect(
					fake.commands().filter((c) => c === READ_COMMAND("pane-implement")).length,
				).toBeGreaterThanOrEqual(2);
				expect(frameText(setup.captureCharFrame())).not.toContain("tick 35");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("reaching the bottom by key re-pins the stream", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join("\n");
		const fake = new FakeRunner();
		fake.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[{ stdout: `${many(30)}\n` }, { stdout: `${many(35)}\n` }, { stdout: `${many(35)}\n` }],
		);
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const first = await awaitFrame(
					setup,
					(f) => f.includes("tick 30"),
					"the first read at the bottom",
				);
				expect(first).not.toContain("tick 01");
				// Two rows up: the pin releases, like a read while the operator
				// reads. The window is short of the full tail, so the last tick
				// leaves on the first press.
				await press(setup, "k", "the first scroll row", (f) => !f.includes("tick 30"));
				await press(setup, "k", "the second scroll row", (f) => f.includes("tick 12"));
				// End reaches the bottom: the pin comes back, and the newest
				// line of the next read comes into view without asking.
				await pressScrollKey(setup, "end", "the stream at its bottom", (f) =>
					f.includes("tick 30"),
				);
				await awaitFrame(setup, (f) => f.includes("tick 35"), "the re-pinned stream");
				expect(frameText(setup.captureCharFrame())).not.toContain("tick 01");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a failed read keeps the last lines under the stale note", async () => {
		const fake = new FakeRunner();
		fake.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[
				{ stdout: "last good lines\n" },
				{ code: 1, stderr: "the pane is gone" },
				{ code: 1, stderr: "the pane is gone" },
			],
		);
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);

				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				await awaitFrame(setup, (f) => f.includes("last good lines"), "the first read");
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Stale Agent output: the last lines stand"),
					"the stale note",
				);
				// The last lines stand under the note, and the note is dim.
				expect(frame).toContain("last good lines");
				expect(spanColors(setup, "Stale Agent output")).toContainEqual(rgb(roleColor("subtext0")));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("esc closes the Live view without side effects", async () => {
		const fake = new FakeRunner();
		fake.set("herdr", [...READ("pane-implement")], { stdout: "the agent works\n" });
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const frame = await pressEscape(setup, "the view to close", (f) => !f.includes("Live:"));
				// The ticket stays where it is, and nothing ran but the reads.
				// Its `handed-off` state wears the Starting window's face
				// (ADR 0030), the badge itself never drawn.
				expect(startingFaceOf(frame)).not.toBeNull();
				expect(fake.commands().join("\n")).not.toContain("agent focus");
				expect(fake.commands().every((c) => c === READ_COMMAND("pane-implement"))).toBe(true);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a ticket without a recorded pane shows the note and reads nothing", async () => {
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{ config: sourceConfig, tickets: [ticketOf(fetched())] }],
		});
		// The handoff is claimed and settled with no herdr handles: the ticket
		// rests in flight with no pane to read.
		const claim = planeRecord.state.handoff.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		planeRecord.state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, undefined);

		await withApp(
			async (setup) => {
				const frame = await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Persist source facts"),
				);
				expect(frame).toContain("no agent pane is recorded for this ticket");
				// The context line names the repository, the task type, and the
				// agent: the handoff's own choice stands behind the row.
				expect(frame).toContain("acme/factory · implement · pi");
				// The bar names the Goto confirm, once.
				expect(frame.match(/Goto/g)?.length).toBe(1);
				expect(frame).toContain("Enter Goto");
				// No pane to read: the runner was never asked for one.
				expect(planeRecord.fakeRunner.calls).toHaveLength(0);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the Key guide names the live-view mode and its controls", async () => {
		const fake = new FakeRunner();
		fake.set("herdr", [...READ("pane-implement")], { stdout: "the agent works\n" });
		const planeRecord = await plane({ runner: () => fake });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the starting ticket", (f) => markerRowOf(f) === 5);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				// The guide names the mode of its own: the streaming sub-mode
				// carries the body's scroll, the Goto confirm, and the leave,
				// beside the plane's global keys.
				await openGuide(setup, "?", "Key guide - Live view");
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
				const between = (top: number, bottom: number) => rows.slice(top + 1, bottom).map(contentOf);
				expect(between(indexOf("Current interaction mode"), indexOf("Global controls"))).toEqual([
					"F1/? Help",
					"F2 Message - no message has been recorded yet",
					"j/k Scroll body",
					"Esc Cancel",
					// The fake runner lists no agent, so the Goto's pane is not
					// alive in the last poll and the row states its reason.
					"Enter Goto - the Agent's pane is not alive in the last poll",
				]);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});
});

/** Collapse the guide's padded key and label columns into single spaces. */
const norm = (row: string): string => row.replace(/\s+/g, " ").trim();

/** A row's content with the modal's box borders stripped, or "" for a blank row. */
const contentOf = (row: string): string =>
	row
		.replace(/[│┌┐└┘─]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** Escape through the real key path, then wait for its effect. */
async function pressEscape(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEscape();
	return await awaitFrame(setup, predicate, what);
}

describe("the Live view against a running factory", () => {
	test("goto from the Live view focuses the pane and records no decision", async () => {
		const planeRecord = await seededPlane();
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], { stdout: "working on the layout\n" });
		planeRecord.fakeRunner.set("herdr", ["workspace", "get", "ws-1"], {
			stdout: workspaceGetJson("ws-1", "live-worktree"),
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				// Enter confirms the Goto: the focus runs, the view closes. The
				// confirmation is a result, not a warning, and names the
				// workspace herdr's view must switch to: since herdr 0.9 a CLI
				// focus no longer moves an attached client's view.
				const frame = await pressReturn(setup, "the focus", (f) =>
					f.includes("in workspace live-worktree"),
				);
				expect(frame).toContain(`Info: focused the agent of ticket ${identity}`);
				expect(planeRecord.fakeRunner.commands()).toContain("herdr agent focus pane-1");
				// The focus is pure: no completion trace exists, and the
				// ticket is still in flight under its badge.
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)).toBeNull();
				expect(planeRecord.state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(0);
				expect(frame).not.toContain("Live:");
				expect(inFlightFace(ticketRow(await settle(setup)))).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("g in the Ticket base mode focuses the pane and moves no state", async () => {
		const planeRecord = await seededPlane();
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], { stdout: "working on the layout\n" });
		planeRecord.fakeRunner.set("herdr", ["workspace", "get", "ws-1"], {
			stdout: workspaceGetJson("ws-1", "live-worktree"),
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				// `g` is the base-mode Goto (ADR 0033): it focuses the agent's
				// pane without opening a surface, and the ticket stays in flight
				// under the face the poll wears.
				const frame = await press(setup, "g", "the focus", (f) =>
					f.includes("in workspace live-worktree"),
				);
				expect(frame).toContain(`Info: focused the agent of ticket ${identity}`);
				expect(planeRecord.fakeRunner.commands()).toContain("herdr agent focus pane-1");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)).toBeNull();
				expect(planeRecord.state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(0);
				expect(frame).not.toContain("Live:");
				expect(inFlightFace(ticketRow(await settle(setup)))).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("the view turns into the Decision modal when the turn settles", async () => {
		const planeRecord = await seededPlane();
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
					sessionId: settledSession("The fix is in the layout math."),
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "The fix is in the layout math.\n",
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("The fix is in the layout math."), "the stream");
				// The agent reports done: the observation settles the turn,
				// and the same box turns into the decision.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
							sessionId: settledSession("The fix is in the layout math."),
						},
					]),
				});
				// The settle re-titles the border in place: the box is the
				// decision now, and the Live title is gone (ADR 0040).
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				expect(frame).not.toContain("Live: Persist source facts");
				// The settled turn's log stands in the pane under its own title,
				// and the decision's rows sit below it.
				expect(frame).toContain("Turn log");
				expect(frame).toContain("The fix is in the layout math.");
				expect(frame).toContain("Close");
				expect(frame).toContain("Goto");
				// The plane wrote the labels itself (ADR 0027): the completed
				// settle fired the implement transition through the command
				// runner, converged the ticket to its facts, and the review
				// row stands on the position those labels derived.
				expect(planeRecord.fakeRunner.commands()).toContain(
					"gh issue edit #5 --repo github.com/acme/factory --add-label ready-for-review",
				);
				const stored = planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.transition;
				expect(stored).toEqual(
					expect.objectContaining({
						fired: true,
						ticketWrite: { added: ["ready-for-review"], removed: [] },
						positionTaskType: "review",
					}),
				);
				// The bar follows the mode: the decision's hints, the stream's
				// gone.
				expect(frame).toContain("j/k Scroll body");
				expect(frame).toContain("Enter Confirm action");
				expect(frame).not.toContain("Enter Goto");
				// Close is selected by default; confirming it ends the cycle.
				await pressReturn(setup, "the close", (f) => f.includes("[open]"));
				expect(ticketRow(await settle(setup))).toContain("[open]");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("a settled turn Auto-handoff mode parks for the operator keeps streaming", async () => {
		// The implement transition writes ready-for-review, so its Next step is
		// the review position on the ticket itself. The task type carries the
		// Operator-decides flag, so the machine decides nothing (ADR 0085) and the
		// turn rests awaiting with its decision unwritten. Auto-handoff mode owns
		// the Live view's body (ADR 0092): the stream stands where the operator
		// left it, and no decision row appears.
		const planeRecord = await seededPlane({
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					operatorDecides: true,
					transition: {
						ticketFacts: ["ready-for-review"],
						pullRequestFacts: [],
					},
				},
			},
		});
		planeRecord.state.handoff.setAutoHandoffMode(true);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
					sessionId: settledSession("the agent is finishing up"),
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the agent is finishing up\n",
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				// The agent reports done. The turn settles, and the factory decides
				// nothing for it: the Operator-decides flag parks the completion
				// ahead of every outcome check, so the ticket rests awaiting.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
							sessionId: settledSession("the agent is finishing up"),
						},
					]),
				});
				const deadline = Date.now() + 2000;
				while (
					planeRecord.state.ticketWorkCycle.ticketState(identity) !== "awaiting" &&
					Date.now() < deadline
				) {
					await sleep(20);
				}
				expect(planeRecord.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				const frame = setup.captureCharFrame();
				// The mode owns the body, not the outcome: the stream stands where
				// the operator left it, and no decision rows appear at all while the
				// parked turn waits.
				expect(frame).toContain("Live: Persist source facts");
				expect(frame).toContain("the agent is finishing up");
				expect(frame).not.toContain("Handoff: review");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(planeRecord.state.workQueue.items()).toEqual([]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("the view turns into the Missing modal when the agent leaves herdr", async () => {
		const planeRecord = await seededPlane();
		const list = (status: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status,
				},
			]);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("working") });
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], { stdout: "the agent works\n" });

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the agent works"), "the stream");
				// The agent leaves herdr: the box carries the missing modal.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Missing: Persist source facts"),
					"the missing modal",
				);
				expect(frame).toContain("Restart");
				expect(frame).toContain("Abandon");
				// The agent is back in the list: the stream returns in the
				// same screen.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Live: Persist source facts") && !f.includes("Missing:"),
					"the stream to return",
				);
				expect(planeRecord.state.ticketWorkCycle.ticketState(identity)).toBe("running");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("a routed handoff from the decision sub-mode falls back to the list, and the Live view follows the new pane (ADR 0072)", async () => {
		const planeRecord = await seededPlane();
		stubCheckoutInto(planeRecord.fakeRunner, planeRecord.home);
		const checkoutPath = join(planeRecord.home, "src", "factory");
		// The settled agent's pane and the new agent's pane, both live, so
		// the stream can move to the new pane the moment the handoff settles.
		const list = (status1: string, status9: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status1,
					sessionId: settledSession("the implementer is finishing"),
				},
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status9,
				},
			]);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("working", "working") });
		// The stored workspace still holds: the route reuses it in a new tab.
		planeRecord.fakeRunner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath }]),
		});
		planeRecord.fakeRunner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-9")], { stdout: "the reviewer is on it\n" });

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				// The base mode's key handlers, taken at rest on the list before this
				// walk mounts anything, which is the only place a base means something:
				// the release wait at the fallback refuses a snapshot that never saw a
				// surface take the keys.
				const baseHandlers = baseKeyHandlers(setup);
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the implementer is finishing"), "the stream");
				// The agent reports done: the same box turns into the decision,
				// the border re-titled in place.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("done", "working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				// Close is the default; the workflow handoff is the last row.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				// The confirm ended the ticket's cycle in the same write that
				// landed the decision (ADR 0072): the screen reads the list, the
				// start runs in the new tab, and the row stands with the start's
				// face.
				await press(
					setup,
					"return",
					"the confirmed route",
					(f) =>
						f.includes("Persist source facts") && !f.includes("Decision: Persist source facts"),
				);
				const listFrame = await awaitFallbackToTheList(setup, baseHandlers);
				expect(listFrame).not.toContain("Live: Persist source facts");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"handed-off",
				);
				// No Ticket-state line stands here. The fallback lands at the ask,
				// before the queue's pickup claims the next cycle, so the state the
				// frame is drawn over is a window (`open`, then `handed-off`, then
				// `running`) and not a fact. What is durable is the decision above and
				// the new pane the walk streams next.
				// The Live view reopens on the row and streams the new pane: the
				// stream follows the handoff, and no focus, which is the Goto's
				// alone.
				await pressReturn(
					setup,
					"the Live view again",
					(f) => f.includes("Live: Persist source facts") && f.includes("the reviewer is on it"),
				);
				expect(planeRecord.fakeRunner.commands()).toContain(READ_COMMAND("pane-9"));
				expect(planeRecord.fakeRunner.commands().join("\n")).not.toContain("agent focus");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	/**
	 * The key a window reproduction dispatches to a stale handler: the walk's
	 * Enter, read off the same fields the dispatch loop reads.
	 */
	function windowKey(): KeyEvent {
		return {
			name: "return",
			ctrl: false,
			meta: false,
			shift: false,
			option: false,
			preventDefault(): void {},
		} as unknown as KeyEvent;
	}

	test("an Enter in the window between the Live view's last frame and its key release runs no stale behavior (issue #317)", async () => {
		const planeRecord = await seededPlane();
		stubCheckoutInto(planeRecord.fakeRunner, planeRecord.home);
		const checkoutPath = join(planeRecord.home, "src", "factory");
		const list = (status1: string, status9: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status1,
					sessionId: settledSession("the implementer is finishing"),
				},
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status9,
				},
			]);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("working", "working") });
		planeRecord.fakeRunner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath }]),
		});
		planeRecord.fakeRunner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-9")], { stdout: "the reviewer is on it\n" });

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				// The base mode's key handlers, taken at rest on the list before this
				// walk mounts anything, the release wait's witness.
				const base = baseKeyHandlers(setup);
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the implementer is finishing"), "the stream");
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("done", "working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				// The bus while the Live view owns the keys, its mount's subscribe
				// landed in the rig's own turn. The view's own dispatch is the one
				// subscription the base mode did not hold.
				flushPassiveNow();
				const whileLive = keyHandlerListeners(setup);
				const stale = whileLive.filter((handler) => !base.base.includes(handler));
				expect(stale.length).toBe(1);
				// The confirm: the route lands, the close's commit draws the fallback
				// frame, and the view's layout cleanup drops the liveness flag in that
				// same commit, before the frame is drawn.
				setup.mockInput.pressEnter();
				await awaitFrame(
					setup,
					(f) => f.includes("┌─❯ Tickets") && !f.includes("Live: Persist source facts"),
					"the fallback to the list",
				);
				// The window is the gap between that fallback frame and the close's
				// passive cleanup removing the stale subscription from the bus, and the
				// key bus probe is the measure of it: until the cleanup lands, the view's
				// handler still stands on the bus, and a key the bus dispatches reaches it.
				// The release wait lands the removal and proves the handler left.
				await awaitBaseKeyHandlers(setup, base, "the Live view to release the keys");
				// The window's key, dispatched to the stale handler: the walk's Enter, the
				// key that confirms the route row. In the window the bus dispatches it to
				// this handler - the subscription the close's cleanup had not yet removed -
				// and the guard makes the handler of the undrawn surface run nothing: it
				// claims the key no, runs no behavior, and reports nothing.
				const claimed = (stale[0] as (key: KeyEvent) => boolean)(windowKey());
				expect(claimed).toBe(false);
				// The closed surface ran no behavior on the window's key: the route never
				// ran twice, the confirm's one decision stands, and the screen is still the
				// list with no warning the closed view would have written.
				flushPassiveNow();
				const frame = setup.captureCharFrame();
				expect(frame).not.toContain("already decided");
				expect(frame).toContain("┌─❯ Tickets");
				expect(frame).not.toContain("Live: Persist source facts");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"handed-off",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("esc on the override returns to the Live view, not the decision modal", async () => {
		const planeRecord = await seededPlane();
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
					sessionId: settledSession("the implementer is finishing"),
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				// The agent reports done: the same box turns into the decision.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
							sessionId: settledSession("the implementer is finishing"),
						},
					]),
				});
				await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				// The workflow handoff row, then e: the override opens on the
				// route's choice.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await openPanel(setup);
				// Esc drops the edit and returns to the panel it opened from:
				// the Live view's decision sub-mode, the same box it left, not a
				// second surface.
				const frame = await pressEscape(
					setup,
					"the Live view to return",
					(f) =>
						f.includes("Decision: Persist source facts") &&
						f.includes("Handoff: review") &&
						!f.includes("Override"),
				);
				expect(frame).toContain("Turn log");
				// Only the edit is dropped: the turn is still undecided, and no
				// handoff was claimed.
				expect(planeRecord.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(null);
				expect(planeRecord.state.handoff.handoffCount(identity)).toBe(1);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("a route confirmed through the override falls back to the list, and the Live view follows the new pane (ADR 0072)", async () => {
		const planeRecord = await seededPlane();
		stubCheckoutInto(planeRecord.fakeRunner, planeRecord.home);
		const checkoutPath = join(planeRecord.home, "src", "factory");
		const list = (implementerStatus: string, reviewerStatus: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: implementerStatus,
					sessionId: settledSession("the implementer is finishing"),
				},
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: reviewerStatus,
				},
			]);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("working", "working") });
		planeRecord.fakeRunner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath }]),
		});
		planeRecord.fakeRunner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-9")], { stdout: "the reviewer is on it\n" });

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				// The base mode's key handlers for the same release wait, taken at the
				// same place: at rest on the list, before this walk mounts anything.
				const baseHandlers = baseKeyHandlers(setup);
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the implementer is finishing"), "the stream");
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: list("done", "working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				// e opens the override on the route's choice; Enter confirms it
				// from the panel.
				await openPanel(setup);
				// The confirm ended the ticket's cycle in the same write that
				// landed the decision (ADR 0072): the screen reads the list, and
				// the start runs in the new tab.
				await press(
					setup,
					"return",
					"the confirmed route",
					(f) =>
						f.includes("Persist source facts") && !f.includes("Decision: Persist source facts"),
				);
				// The same fallback as the decision sub-mode's case, waited for the
				// same way: the override's confirm leaves the Live view on screen for
				// a moment, and the frame that moment holds is quiet (issue #304).
				const listFrame = await awaitFallbackToTheList(setup, baseHandlers);
				expect(listFrame).not.toContain("Live: Persist source facts");
				expect(listFrame).not.toContain("Edit handoff");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"handed-off",
				);
				// No Ticket-state line, for the reason the case above states: the
				// state at the fallback is a window, the decision is the fact.
				// The Live view reopens on the row and streams the new pane.
				await pressReturn(
					setup,
					"the Live view again",
					(f) => f.includes("Live: Persist source facts") && f.includes("the reviewer is on it"),
				);
				expect(planeRecord.fakeRunner.commands()).toContain(READ_COMMAND("pane-9"));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("the view ends on the work cycle it opened on, with no frame holding the open state (ADR 0110)", async () => {
		// The route's ask ends the cycle in one write, and the queue's pickup claims
		// the next cycle's start before the plane next reads the projection, so the
		// screen can be handed the next cycle's frame and never see the open state
		// at all (issue #304). The two writes run here by hand, with no projection
		// read between them, and the view still has to end: the cycle it opened on
		// is the fact it ends on, not the state a frame happens to catch.
		const planeRecord = await seededPlane();
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
					sessionId: settledSession("the implementer is finishing"),
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the implementer is finishing"), "the stream");
				// The turn settles, so the Ticket rests awaiting with the ask owed:
				// the state the route's ask ends.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
							sessionId: settledSession("the implementer is finishing"),
						},
					]),
				});
				await awaitFrame(
					setup,
					(f) => f.includes("Decision: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				const attempt = planeRecord.state.handoff.latestHandoff(identity);
				expect(attempt).not.toBeNull();
				// The ask's write: the decision lands and the cycle ends with it.
				expect(
					planeRecord.state.ticketWorkCycle.applyCompletionDecision({
						ticketIdentity: identity,
						handoffId: attempt?.handoffId ?? "",
						decision: "handed-off",
						decidedAt: "2026-08-31T11:00:00Z",
					}),
				).toBe(true);
				// The pickup's claim, in the same turn of the event loop: the Ticket
				// goes straight from its settled turn to the next cycle's in-flight
				// state, and no read of the projection can stand between them.
				const claim = planeRecord.state.handoff.claimHandoff(
					identity,
					{
						agentType: "pi",
						environment: "live-worktree",
						taskType: "review",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					"open",
				);
				if (!claim.ok) throw new Error(claim.reason);
				planeRecord.state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
				});
				expect(planeRecord.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
				// The new agent is live in herdr, so the observation reports it and
				// the plane reads the projection again: the first read that can see
				// the Ticket at all finds it in the next cycle, in flight.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-9",
							tabId: "tab-9",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "working",
						},
					]),
				});
				planeRecord.fakeRunner.set("herdr", [...READ("pane-9")], {
					stdout: "the reviewer is on it\n",
				});
				// The screen ends on the cycle, so the list is drawn again with the
				// Ticket's own row on it.
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("┌─❯ Tickets") && !f.includes("Live:"),
					"the Live view to end with its work cycle",
				);
				expect(frameText(frame)).toContain("Persist source facts");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});

	test("the cycle ending while the view is open closes the screen", async () => {
		// A task type the factory closes by itself: the transition fires and
		// derives no Next step, so the turn can only end the cycle, never hand
		// off. The machine decides a settled turn only in Auto mode (ADR 0051,
		// ADR 0092), so the mode stands on when the view opens.
		const planeRecord = await seededPlane({
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					transition: { ticketFacts: [], pullRequestFacts: [] },
				},
			},
		});
		planeRecord.state.handoff.setAutoHandoffMode(true);
		planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
					sessionId: settledSession("the agent is wrapping up"),
				},
			]),
		});
		planeRecord.fakeRunner.set("herdr", [...READ("pane-1")], {
			stdout: "the agent is wrapping up\n",
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the agent is wrapping up"), "the stream");
				// The agent reports done. The turn settles, the auto-close type
				// decides for the factory, and the cycle ends while the operator
				// watches: the screen closes on its own.
				planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
							sessionId: settledSession("the agent is wrapping up"),
						},
					]),
				});
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("[open]") && !f.includes("Live: Persist source facts"),
					"the screen to close",
				);
				// The factory decided the turn, and the screen is gone with the
				// cycle: no choice rows, no box.
				expect(frame).not.toContain("Handoff: review");
				expect(planeRecord.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"auto-closed",
				);
				expect(planeRecord.state.ticketWorkCycle.ticketState(identity)).toBe("open");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.state.close();
	});
});
