/**
 * The Work queue through the real UI (ADR 0034, issue #88): a manual
 * handoff at a full Parallel limit enters the queue instead of starting,
 * the depth stands on the section header, `u` and `d` reorder the item
 * under the cursor, and `Del` cancels the queued handoff. Every state the
 * reviewer must see is reached through the keys the operator has.
 *
 * The seat the tests hold is a real in-flight handoff inside its startup
 * grace, the same seat the mode line reads: the cap is full the moment
 * the app boots, so no cycle starts a queued item out from under a test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import type { TicketSource } from "../src/ticket-source.ts";
import {
	awaitFrame,
	detailPaneText,
	HEIGHT,
	messageRowOf,
	press,
	rowsOf,
	type Setup,
	scrollDetailUntil,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	emptyAgentRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { issueTicket, success } from "./state-fixture.ts";

let home = "";
let configPath = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-work-queue-${Math.random().toString(36).slice(2)}`);
	configPath = join(home, "factory", "config.toml");
	mkdirSync(join(home, "src", "billing"), { recursive: true });
	writeFileSync(join(home, "src", "billing", "marker"), "repo");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const checkout = () => join(home, "src", "billing");
const HELD = "github:github.com:I_5";
const FIRST = "github:github.com:I_6";
const SECOND = "github:github.com:I_7";
const FIRST_TITLE = "Ticket 6";
const SECOND_TITLE = "Ticket 7";

const choice = () => ({
	agentType: "pi",
	environment: "live-worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
});

/** The one-seat config the cap tests run on. */
const oneSeatConfig = (): FactoryConfig => ({
	...BASE_CONFIG,
	repos: { "github.com/acme/factory": checkout() },
	maxParallelAgents: 1,
	sources: [
		{
			name: "tickets",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
});

/** One fetched ticket; the title keeps its row distinct in the char frame. */
const ticket = (identity: string): FetchedTicket =>
	issueTicket(identity, {
		externalKey: `#${identity.split("_")[1]}`,
		title: `Ticket ${identity.split("_")[1]}`,
	});

/**
 * The shared fixture: one held seat (the in-flight I_5) and two open
 * tickets, the I_6 the handoff asks for and the I_7 the queue items name.
 * The caller owns the state and closes it.
 */
function seedQueueState() {
	const state = openFactoryState(join(home, "state.sqlite"));
	const source = { name: "tickets", kind: "github-issues" };
	const outcome = success([ticket(HELD), ticket(FIRST), ticket(SECOND)]);
	state.initializeSources([source]);
	state.applyFetch(source, outcome);
	// The held seat: a real in-flight handoff inside its startup grace.
	const claim = state.claimHandoff(
		HELD,
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
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return {
		state,
		outcome,
		// A source that answers at once: the app's own fetches settle, so the
		// source stays healthy and the ticket stays actionable.
		source: {
			name: source.name,
			kind: source.kind,
			refreshIntervalMs: 60_000,
			fetch: async () => outcome,
		} satisfies TicketSource,
	};
}

/** The command runner the flow would need; the queue may run none of it. */
function makeRunner() {
	const runner = emptyAgentRunner();
	const path = checkout();
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
	return runner;
}

/** The Work queue box's rows, in display order, below the section header. */
function workRows(frame: string): string[] {
	const rows = rowsOf(frame);
	const start = rows.findIndex((row) => row.includes("depth")) + 1;
	if (start <= 0) return [];
	return rows.slice(start).filter((row) => row.trim() !== "");
}

/** Whether the queue box shows the row for `identity` under the cursor. */
const selectedRow = (frame: string, identity: string): boolean =>
	workRows(frame).some((row) => row.includes(identity) && row.includes("❯"));

/** The queue box's item rows, in display order: one per waiting item. */
const itemRows = (frame: string): string[] =>
	workRows(frame).filter((row) => row.includes("ticket detail"));

/** Whether a list row shows `text` under the cursor. */
const rowSelected = (frame: string, text: string): boolean =>
	rowsOf(frame).some((row) => row.includes("❯") && row.includes(text));

/**
 * Walk the cursor from the Ticket list down into the Work queue section:
 * the last Ticket crosses to the Consultation list, and the empty
 * Consultation list crosses to the queue's first item.
 */
async function toWorkSection(setup: Setup): Promise<void> {
	await press(setup, "j", "the selection on the first open ticket", (f) => rowSelected(f, FIRST));
	await press(setup, "j", "the selection on the last ticket", (f) => rowSelected(f, SECOND_TITLE));
	await press(setup, "j", "the cursor to cross the Consultation section", (f) =>
		f.includes("❯ Consultations"),
	);
	await press(setup, "j", "the cursor in the Work queue", (f) => f.includes("❯ Work queue"));
}

/** The detail pane's text at the width the frame carries. */
const detailText = (frame: string, width = 120): string => detailPaneText(frame, width);

/** Press `l` and wait for the queue item's detail pane to take the focus. */
const focusQueueDetail = (setup: Setup): Promise<string> =>
	press(setup, "l", "the Work queue detail to take focus", (f) => f.includes("❯ Work queue item"));

describe("the Work queue through the UI (issue #88)", () => {
	test("a manual handoff at a full cap enters the queue instead of starting", async () => {
		const { state, source } = seedQueueState();
		const run = makeRunner();
		try {
			await withApp(
				async (setup) => {
					// The selection starts on the held ticket; one step reaches
					// the open I_6.
					await press(setup, "j", "the selection on the open ticket", (f) =>
						rowSelected(f, FIRST_TITLE),
					);
					const frame = await press(setup, "return", "the handoff queued message", (f) =>
						f.includes("handoff queued"),
					);
					// The Message line says where the handoff stands, and the
					// section header carries the queue's depth.
					expect(messageRowOf(frame)).toContain(
						`handoff queued: ticket ${FIRST} waits in the Work queue`,
					);
					expect(frame).toContain("depth: 1");
					// The item stands in the Work queue box with its origin.
					expect(
						workRows(frame).some((row) => row.includes("ticket detail")) &&
							workRows(frame).some((row) => row.includes(FIRST)),
					).toBe(true);
					const queued = state.workQueue();
					expect(queued).toHaveLength(1);
					expect(queued[0]).toEqual(
						expect.objectContaining({
							kind: "handoff",
							ticketIdentity: FIRST,
							origin: "open",
							choice: expect.objectContaining({
								agentType: "pi",
								environment: "live-worktree",
								taskType: "implement",
							}),
						}),
					);
					// The enqueue ran no external step: it is not a start, and
					// the ticket keeps its open state behind the held seat.
					expect(
						run
							.commands()
							.filter(
								(command) =>
									command.includes("workspace create") || command.includes("agent start"),
							),
					).toEqual([]);
					expect(
						state.visibleTickets([], "implement").find((t) => t.identity === FIRST)?.state,
					).toBe("open");
					// One queue item per ticket (ADR 0034): the same ask issued
					// again at the same full cap is refused, the Message line
					// names the waiting ticket, and the queue's depth holds.
					const refused = await press(setup, "return", "the second handoff refused", (f) =>
						f.includes("handoff refused"),
					);
					expect(messageRowOf(refused)).toContain(
						`handoff refused: ticket ${FIRST} already waits in the Work queue`,
					);
					expect(refused).toContain("depth: 1");
					expect(state.workQueue()).toHaveLength(1);
				},
				WIDTH,
				HEIGHT,
				{
					config: oneSeatConfig(),
					runner: run,
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("`u` and `d` reorder the item under the cursor, durably", async () => {
		const { state, source } = seedQueueState();
		state.enqueueWorkQueueItem({ ticketIdentity: FIRST, origin: "open", choice: choice() });
		state.enqueueWorkQueueItem({ ticketIdentity: SECOND, origin: "open", choice: choice() });
		try {
			await withApp(
				async (setup) => {
					await toWorkSection(setup);
					// The cursor lands on the first item, the I_6; one step
					// reaches the I_7.
					await press(setup, "j", "the selection on the second item", (f) =>
						selectedRow(f, SECOND),
					);
					// `u` swaps the item under the cursor with its neighbour above:
					// the I_7 leads, the cursor keeps the item, and the swap is
					// durable the moment it lands.
					await press(
						setup,
						"u",
						"the I_7 leading the queue",
						(f) => itemRows(f)[0]?.includes(SECOND) === true,
					);
					expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual([SECOND, FIRST]);
					// `d` swaps it back down: the I_6 leads again, and the cursor
					// follows the item to its new row.
					await press(
						setup,
						"d",
						"the I_6 leading the queue",
						(f) => itemRows(f)[0]?.includes(FIRST) === true,
					);
					expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual([FIRST, SECOND]);
				},
				WIDTH,
				HEIGHT,
				{
					config: oneSeatConfig(),
					runner: makeRunner(),
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the detail pane reads the captured facts of the queued start", async () => {
		// The proof the criterion asks for runs through the app's own keys:
		// the cursor walks to a queue row, `l` focuses the detail, and the
		// pane's own lines carry the ticket, the origin, and the choice the
		// operator made at the handoff.
		const { state, source } = seedQueueState();
		state.enqueueWorkQueueItem({
			ticketIdentity: FIRST,
			origin: "open",
			choice: {
				agentType: "codex",
				environment: "container",
				taskType: "review",
				model: "gpt-5.2",
				thinking: "high",
				contextWindow: "272000",
			},
		});
		try {
			await withApp(
				async (setup) => {
					await toWorkSection(setup);
					const frame = await focusQueueDetail(setup);
					const detail = detailText(frame);
					expect(detail).toContain("Work queue item");
					expect(detail).toContain(`Ticket: ${FIRST}`);
					expect(detail).toContain("Origin: ticket detail");
					expect(detail).toContain("Enqueued:");
					expect(detail).toContain("Agent: codex");
					expect(detail).toContain("Environment: container");
					expect(detail).toContain("Task type: review");
					expect(detail).toContain("Model: gpt-5.2");
					expect(detail).toContain("Thinking: high");
					expect(detail).toContain("Context window: 272000");
				},
				WIDTH,
				HEIGHT,
				{
					config: oneSeatConfig(),
					runner: makeRunner(),
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the cursor crosses to and from the queue past a collapsed Consultation section", async () => {
		// The queue is the third section, and the Consultation section between
		// it and the Ticket list can be collapsed. A step then must reach the
		// nearest section the operator holds open, not stop at the closed one:
		// the dead end the first cut left is the bug this walks, in both
		// directions, and the bar's Move hint agrees with the key all the way.
		const { state, source } = seedQueueState();
		state.enqueueWorkQueueItem({ ticketIdentity: FIRST, origin: "open", choice: choice() });
		try {
			await withApp(
				async (setup) => {
					// Down to the Consultation list, and collapse it there.
					await press(setup, "j", "the selection on the first open ticket", (f) =>
						rowSelected(f, FIRST),
					);
					await press(setup, "j", "the selection on the last ticket", (f) =>
						rowSelected(f, SECOND_TITLE),
					);
					await press(setup, "j", "the cursor on the Consultation list", (f) =>
						f.includes("❯ Consultations"),
					);
					await press(setup, "x", "the Consultation section to collapse", (f) =>
						f.includes("▸ Consultations"),
					);
					// Down from the closed section's boundary lands in the Work
					// queue, over it.
					const toQueue = await press(setup, "j", "the cursor in the Work queue", (f) =>
						f.includes("┌─❯ Work queue"),
					);
					expect(toQueue).toContain("▸ Consultations");
					expect(toQueue).toContain("ticket detail");
					// And back up from the queue's first item lands on the last
					// Ticket, again over the closed section.
					const toTickets = await press(setup, "k", "the cursor on the Ticket list", (f) =>
						f.includes("┌─❯ Tickets"),
					);
					expect(toTickets).toContain("▸ Consultations");
					expect(rowSelected(toTickets, SECOND_TITLE)).toBe(true);
				},
				WIDTH,
				HEIGHT,
				{
					config: oneSeatConfig(),
					runner: makeRunner(),
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the queue detail slides to its last fact on a short frame", async () => {
		// A long ticket identity wraps the fact rows past the pane at the
		// small frames, and the pane owns a scroll like every other base
		// detail: the walk reaches the last row instead of cutting it off.
		const { state, source } = seedQueueState();
		const long = "github:github.com:acme/a-repository-with-a-long-name-that-wraps-the-row#1234567";
		state.enqueueWorkQueueItem({
			ticketIdentity: long,
			origin: "open",
			choice: {
				agentType: "codex",
				environment: "container",
				taskType: "review",
				model: "gpt-5.2",
				thinking: "high",
				contextWindow: "272000",
			},
		});
		try {
			await withApp(
				async (setup) => {
					// The short frame cannot pay three boxes at once, so the
					// queue's box answers the crossing rather than a fixed
					// number of steps: walk down until the cursor is on it.
					for (let step = 0; step < 12; step += 1) {
						if (setup.captureCharFrame().includes("┌─❯ Work queue")) break;
						setup.mockInput.pressKey("j");
						await settle(setup, 120);
					}
					expect(setup.captureCharFrame()).toContain("┌─❯ Work queue");
					const focused = await focusQueueDetail(setup);
					expect(detailText(focused, 60)).not.toContain("Context window: 272000");
					const scrolled = await scrollDetailUntil(setup, "the queue detail's last fact", (f) =>
						detailText(f, 60).includes("Context window: 272000"),
					);
					expect(detailText(scrolled, 60)).toContain("Context window: 272000");
					// End answers the same way the wheel and the row keys do.
					await press(setup, "home", "the detail to return to its first line", (f) =>
						detailText(f, 60).includes("Work queue item"),
					);
				},
				60,
				19,
				{
					config: oneSeatConfig(),
					runner: makeRunner(),
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("`Del` cancels the queued handoff, and the depth falls", async () => {
		const { state, source } = seedQueueState();
		state.enqueueWorkQueueItem({ ticketIdentity: FIRST, origin: "open", choice: choice() });
		state.enqueueWorkQueueItem({ ticketIdentity: SECOND, origin: "open", choice: choice() });
		try {
			await withApp(
				async (setup) => {
					await toWorkSection(setup);
					// Cancel the item under the cursor, the I_6.
					setup.mockInput.pressKey("DELETE");
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("the queued handoff was cancelled"),
						"the removal message",
					);
					expect(messageRowOf(frame)).toContain(
						`ticket ${FIRST}: the queued handoff was cancelled`,
					);
					expect(frame).toContain("depth: 1");
					const remaining = state.workQueue();
					expect(remaining).toHaveLength(1);
					expect(remaining[0].ticketIdentity).toBe(SECOND);
					// The ticket keeps its state: the cancellation never
					// touched it.
					expect(
						state.visibleTickets([], "implement").find((t) => t.identity === FIRST)?.state,
					).toBe("open");
				},
				WIDTH,
				HEIGHT,
				{
					config: oneSeatConfig(),
					runner: makeRunner(),
					home,
					configPath,
					state,
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});
});
