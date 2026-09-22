/**
 * The Work queue's frame tests (ADR 0034): the section appears the moment a
 * manual start waits for a Parallel limit seat, its rows carry the origin
 * and the ticket's title, u and d reorder the waiting starts, Delete cancels
 * the start under the cursor, and the section goes away again with its queue.
 *
 * The tests boot the real app against a temporary state with a FakeSource,
 * and they seed the queue straight into the state the way a refused manual
 * start leaves it. No test starts an Agent: a queue item is a start waiting
 * to run, and these frames verify the waiting, not the running.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config.ts";
import { baseChoice } from "../src/handoff.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState, workQueueIdentityOf } from "../src/state.ts";
import {
	awaitFrame,
	detailPaneText,
	frameText,
	markerRowOf,
	messageRowOf,
	mouseClick,
	press,
	pressArrow,
	rgb,
	roleColor,
	rowsOf,
	settle,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	agentListJson,
	emptyAgentRunner,
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import {
	issuesConfig,
	issueTicket,
	seedAwaitingTurn,
	seedInFlightTurn,
	success,
} from "./state-fixture.ts";

const FIRST = "github:github.com:I_5";
const SECOND = "github:github.com:I_6";

/** The ticket that holds the factory's one seat in the force-dispatch frames. */
const HELD = FIRST;

/** The open ticket whose start the force-dispatch frames ask for. */
const FORCED = SECOND;

/** The checkout the forced handoff runs in, under the app's home. */
const forceCheckout = () => join(home, "src", "billing");

/**
 * The one-seat state the force-dispatch frames boot on (issue #89): the held
 * ticket owns the factory's only seat behind a live agent, so the cap is full
 * the moment the app boots and no cycle can pick the forced item up out from
 * under a test. The caller owns the state and closes it.
 */
function forcedFixture() {
	const state = openFactoryState(join(home, "state.sqlite"));
	const heldTicket = issueTicket(HELD);
	const forcedTicket = issueTicket(FORCED, {
		externalKey: "#6",
		url: "https://github.com/acme/factory/issues/6",
		title: "Close the stale deploy branch",
	});
	const outcome = success([heldTicket, forcedTicket]);
	// The held seat: a real in-flight handoff with a live agent in the list.
	seedInFlightTurn(state, outcome, HELD);
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], {
		stdout: agentListJson([
			{
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agent: "add-a-webhook-retry-policy",
				status: "working",
			},
		]),
	});
	// The forced start crosses these steps on the item's own captured choice.
	const checkout = forceCheckout();
	mkdirSync(checkout, { recursive: true });
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-2"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-2", "--cwd", checkout, "--no-focus"], {
		stdout: tabCreateJson("pane-2", "tab-2"),
	});
	return {
		state,
		outcome,
		source: new FakeSource("issues", "github-issues", outcome),
		runner,
		config: {
			...issuesConfig,
			maxParallelAgents: 1,
			agentPollIntervalSeconds: 60,
			repos: { "github.com/acme/factory": checkout },
		} satisfies FactoryConfig,
	};
}

/** Put one waiting item in the queue and boot the app around it. */
function forceDispatchApp(fixture: ReturnType<typeof forcedFixture>) {
	const { state, source, runner, config } = fixture;
	const enqueue = (ticketIdentity: string, origin: "open" | "workflow" | "restart" = "open") => {
		const result = state.enqueueWork({
			ticketIdentity,
			origin,
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "",
		});
		if (!result.ok) throw new Error(result.reason);
	};
	const boot = (body: Parameters<typeof withApp>[0]): Promise<void> =>
		withApp(body, WIDTH, 34, { state, config, home, runner, sources: [source] });
	return { enqueue, boot };
}

let home = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-work-queue-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** The two tickets the queue in these frames waits to start. */
function twoTickets() {
	return [
		issueTicket(FIRST),
		issueTicket(SECOND, {
			externalKey: "#6",
			url: "https://github.com/acme/factory/issues/6",
			title: "Close the stale deploy branch",
		}),
	];
}

/** One state with the queue the test enqueues, plus the source that settles it. */
function queuedFixture(state: FactoryState) {
	const tickets = twoTickets();
	const source = new FakeSource("issues", "github-issues", success(tickets));
	const enqueue = (ticketIdentity: string, origin: "open" | "workflow" | "restart" = "open") => {
		const result = state.enqueueWork({
			ticketIdentity,
			origin,
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "",
		});
		if (!result.ok) throw new Error(result.reason);
	};
	const runner: CommandRunner = emptyAgentRunner();
	return { state, source, enqueue, runner };
}

// These frames show the waiting, never a running start, so nothing may pick
// the items up while they walk. A one-seat cap with a held claim keeps the
// free-seat figure at zero, so the observation's pickup never runs: the first
// cycle fires the moment the app boots, before the source settles, and a
// slower runner lets the cycle meet the settled tickets and claim the queue.
// The held claim is a durable handoff attempt the fixture stores for the HELD
// ticket; it holds the seat the same way a live agent would, and the ticket
// keeps its open state, so the counts and the badge the test reads are the
// resting ones.
const zeroSeatConfig: FactoryConfig = {
	...issuesConfig,
	maxParallelAgents: 1,
	agentPollIntervalSeconds: 60,
};

const booted = (
	body: Parameters<typeof withApp>[0],
	state: FactoryState,
	source: FakeSource,
	runner: CommandRunner,
): Promise<void> =>
	withApp(body, WIDTH, 34, {
		state,
		config: zeroSeatConfig,
		home,
		runner,
		sources: [source],
	});

/** The terminal row of the Work section's header, or -1 while it is hidden. */
const workHeaderRow = (frame: string): number =>
	rowsOf(frame).findIndex((row) => /\bWork\b/.test(row));

type AppSetup = Parameters<Parameters<typeof withApp>[0]>[0];

// ADR 0049: the Work section is always visible and starts expanded, so the
// old click-the-header-to-expand helper now lands the cursor on the first
// queue row instead, where the queue's keys and the detail act on it.
async function clickWorkHeader(setup: AppSetup): Promise<void> {
	const row = queueRowIndex(setup.captureCharFrame(), /\[(open|workflow|restart)\]\s+/);
	expect(row).toBeGreaterThanOrEqual(0);
	await mouseClick(setup, 2, row);
}

/**
 * The frame row of a queue row, read by its origin-and-title lead.
 *
 * The Ticket rows carry their state badge between the marker and the title,
 * so `[open] Add a webhook retry policy` leads a queue row and only a queue
 * row at the width these frames hold.
 */
// The live frame carries the styles as escape sequences between the styled
// spans, so a lead that crosses a span boundary strips them first.
// The escape prefix comes from its code point: the linter refuses a
// control character written in the source, and the style it strips is
// exactly this prefix, two or more digits, a semicolon, and an m.
const stripAnsi = (text: string): string =>
	text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const queueRowIndex = (frame: string, lead: RegExp): number =>
	rowsOf(stripAnsi(frame)).findIndex((row) => lead.test(row));

/** The queue rows lead with their origin, padded to a fixed width. */
const openRowLead = /\[open\]\s+Add a webhook retry policy/;
const workflowRowLead = /\[workflow\]\s+Close the stale deploy branch/;

describe("the Work queue section", () => {
	test("an idle factory keeps the three-section frame", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, runner } = queuedFixture(state);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("▾ Tickets"),
						"the Tickets section",
					);
						// The Work section is always visible (ADR 0049): the empty
						// queue keeps its header row with its count, the way the
						// Ticket and Consultation sections do.
						expect(workHeaderRow(frame)).toBeGreaterThanOrEqual(0);
						expect(frameText(frame)).toContain("waiting: 0");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	test("the Work header appears with its count, and the rows carry the origin and the title", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
						// Expanded by default (ADR 0049): the header carries the
						// count, and the rows stand under it.
						expect(frame).toContain("▾ Work");
						// The click lands the cursor on the first queue row.
						await clickWorkHeader(setup);
						const expanded = await awaitFrame(
							setup,
							(f) => f.includes("▾ Work") && f.includes("[open]"),
							"the Work queue item row",
						);
						expect(queueRowIndex(expanded, openRowLead)).toBeGreaterThanOrEqual(0);
					// Queue order: the earlier enqueue leads, and each row
					// carries the origin its start came in with.
					expect(queueRowIndex(expanded, openRowLead)).toBeLessThanOrEqual(
						queueRowIndex(expanded, workflowRowLead),
					);
					expect(frameText(expanded)).toContain(`[workflow] Close the stale deploy branch`);
					// The detail answers for the item under the cursor.
					expect(detailPaneText(expanded)).toContain("Origin: open");
					expect(detailPaneText(expanded)).toContain("place 1 of 2");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The Queue wait (CONTEXT.md): a ticket whose manual start waits in the
	 * queue keeps its open state, and its row and its detail wear the
	 * `queued` badge in the state badge's place, in the open badge's color.
	 * A ticket without a waiting start keeps its open badge, the queue row
	 * keeps its origin, and the cancel gives the open badge back.
	 */
	test("the waiting ticket wears the queued badge in row and detail, and the cancel gives the open badge back", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		// Seed the tickets into the state before the app boots, then hold the
		// one seat with a durable claim for the second ticket. The claim keeps
		// the free-seat figure at zero, so the observation's pickup never runs
		// and the Waiting badge the test reads is the resting one.
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		const held = state.claimHandoff(SECOND, baseChoice("pi", "live-worktree", "implement"), "open");
		if (!held.ok) throw new Error(held.reason);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(outcome);
					// The frame the counts hold: the source has settled, so the
					// badges the assertion reads are the resting ones, not the
					// loading frame the boot pickup warns over.
					const frame = await awaitFrame(
						setup,
						(f) =>
							f.includes("Work") &&
							f.includes("waiting: 1") &&
							frameText(f).includes("open: 2 running: 0 awaiting: 0"),
						"the waiting ticket's count",
					);
					// The ticket keeps its open state: the count says open...
					expect(frameText(frame)).toContain("open: 2 running: 0 awaiting: 0");
					const rows = rowsOf(stripAnsi(frame));
					// ...and the selected row wears the queued badge in its
					// place, in the row and in the detail state line alike.
					const selected = rows.find((row) => row.startsWith("│ ❯"));
					expect(selected).toContain("[queued]");
					expect(detailPaneText(frame)).toContain("[queued]");
					// The ticket without a waiting start keeps its open badge.
					const resting = rows.find((row) => row.includes("Close the stale"));
					expect(resting).toContain("[open]");
					// The badge paints the open role: the ticket is still open.
					expect(spanColors(setup, "[queued]")).toEqual([rgb(roleColor("blue"))]);
					// The queue row keeps its origin, and the cancel gives the
					// open badge back to the row and the detail.
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					expect(queueRowIndex(setup.captureCharFrame(), openRowLead)).toBeGreaterThanOrEqual(0);
					await press(setup, "delete", "the item to cancel", (f) =>
						f.includes(`waiting start for "Add a webhook retry policy"`),
					);
					const returned = await settle(setup);
					expect(stripAnsi(returned)).not.toContain("[queued]");
					expect(frameText(returned)).toContain("open: 2 running: 0 awaiting: 0");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	test("+ and - reorder the waiting starts, and the captured choice stays put", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
						// - takes the first item to the back: the workflow route
						// leads the queue now, and the cursor follows its item.
						const swapped = await press(
							setup,
							"-",
							"the first item to move to the back",
						(f) => queueRowIndex(f, workflowRowLead) < queueRowIndex(f, openRowLead),
					);
					expect(detailPaneText(swapped)).toContain("Origin: open");
					expect(detailPaneText(swapped)).toContain("place 2 of 2");
						// + brings it back, and the queue order leads with the
						// workflow route again.
						const restored = await press(
							setup,
							"+",
							"the item to move back to the front",
						(f) => queueRowIndex(f, openRowLead) < queueRowIndex(f, workflowRowLead),
					);
					expect(detailPaneText(restored)).toContain("place 1 of 2");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	test("Delete cancels the waiting start, and the Message line names the ticket", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					// The cursor holds the first item; Delete cancels its
					// start. The ticket keeps the state it wears while it
					// waits, so the Ticket list still draws it. The line names
					// the ticket by its title while the projection holds it.
					await press(setup, "delete", "the first item to cancel", (f) =>
						f.includes(`waiting start for "Add a webhook retry policy"`),
					);
					const frame = await settle(setup);
					expect(frame).toContain("waiting: 1");
					expect(frameText(frame)).toContain(`[workflow] Close the stale deploy branch`);
					// The Ticket row truncates its title at this width.
					expect(frameText(frame)).toContain("Add a webhook ret");
					// The cancel drops the queue to its last item, and the
					// cursor follows the row that took the place.
					expect(detailPaneText(frame)).toContain("Origin: workflow");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The Consultation section's keys refuse the Work queue too (issue #85,
	 * ADR 0034). The Work queue shares the list surface and the base modes with
	 * the other two sections, so `f` History and the detail pane's `d` reach a
	 * queue mode by way of those shared modes. Both state the owning section's
	 * refusal on the Message line and change nothing: the queue keeps its rows,
	 * its order, and its cursor, and the Consultation section is untouched.
	 */
	test("the Consultation's keys refuse in both Work queue modes, and nothing moves", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					const list = await awaitFrame(
						setup,
						(f) => f.includes("▾ Work"),
						"the expanded Work section",
					);
					const queueRows = (frame: string) =>
						rowsOf(stripAnsi(frame)).filter((row) => /\[(open|workflow|restart)\]/.test(row));
					const before = await settle(setup);
					// In the list `f` is the Consultation's History key, and the
					// queue refuses it. `d` is the queue's own Queue down, so it
					// must NOT carry the refusal: this press moves the item, and the
					// line stays clear of the other section's words.
					let refusal = await press(setup, "f", "the history refusal in the queue list", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					expect(queueRows(refusal)).toEqual(queueRows(before));
					expect(markerRowOf(refusal)).toBe(markerRowOf(list));
					expect(detailPaneText(refusal)).toContain("place 1 of 2");
					// The detail pane: `d` belongs to no queue control here, so the
					// Consultation's Delete resolves and refuses, and the detail
					// keeps the item under its cursor.
					setup.mockInput.pressKey("l");
					const detail = await awaitFrame(
						setup,
						(f) => f.includes("❯ Work queue") === false && f.includes("Origin: open"),
						"the Work queue detail pane",
					);
					const detailBefore = await settle(setup);
					refusal = await press(setup, "d", "the delete refusal in the queue detail", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					expect(queueRows(refusal)).toEqual(queueRows(detailBefore));
					expect(detailPaneText(refusal)).toBe(detailPaneText(detail));
					// The queue still holds both starts at the same depth.
					expect(frameText(refusal)).toContain("waiting: 2");
				},
				state,
				source,
				runner,
			);
			expect(state.workQueue().length).toBe(2);
		} finally {
			state.close();
		}
	});

	/**
	 * The cancel line states only the removal the module measured (ADR 0034).
	 *
	 * A pickup takes a row between the render that drew it and the keypress the
	 * operator aims at it. The frame reaches that window by removing the row
	 * from the state behind the plane's back, which is exactly what a successful
	 * pickup leaves: the list still holds the row the cursor points at, and the
	 * module answers that no row stood. The line then refuses the removal it
	 * never made instead of claiming one.
	 */
	test("a cancel that meets a row its pickup already took claims no removal", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					// The row the cursor holds, taken out from under it.
					expect(state.removeWorkItem(FIRST)).toBe(true);
					const line = await press(setup, "delete", "the cancel of a row already gone", (f) =>
						messageRowOf(f).includes("no longer held a waiting start"),
					);
					expect(messageRowOf(line)).toContain(`"Add a webhook retry policy"`);
					expect(messageRowOf(line)).not.toContain("was removed");
					// The row that stood keeps its place: the queue is at the depth
					// the state holds, and the refusal moved nothing else.
					const frame = await settle(setup);
					expect(frame).toContain("waiting: 1");
					expect(frameText(frame)).toContain(`[workflow] Close the stale deploy branch`);
					expect(state.workQueue().map(workQueueIdentityOf)).toEqual([SECOND]);
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * A route asked at a full cap waits in the queue, through the real decision
	 * modal (ADR 0034, #92 AC1).
	 *
	 * ONE seat, held by a live agent on the second ticket, so the awaiting
	 * ticket's route cannot take a seat and enters the queue with the choice the
	 * workflow edge resolved. The observation cycle never picks it up: the cap
	 * stays full the whole walk, and the long poll interval holds even the
	 * cycle's first pass back, so no pickup races the modal walk.
	 */
	test("a decision-row route at a full cap waits in the Work queue with its choice", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const tickets = twoTickets();
		const outcome = success(tickets);
		// The first ticket ends its turn and awaits its route; the second holds the
		// factory's one seat with a live agent.
		// The settled turn's transition wrote the review position on this
		// ticket: the decision modal offers the handoff from it (ADR 0027).
		seedAwaitingTurn(state, outcome, FIRST, {
			fired: true,
			when: null,
			reason: "",
			ticketFacts: [],
			pullRequestFacts: [],
			autoAdvance: false,
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: "review",
			positionTicketIdentity: FIRST,
		});
		const held = state.claimHandoff(
			SECOND,
			{ ...baseChoice("pi", "live-worktree", "implement") },
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
		state.settleHandoff(held.claim.attemptId, true, undefined, {
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: "ws-9",
		});
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-9",
					agent: "close-the-stale-deploy-branch",
					status: "working",
				},
			]),
		});
		const source = new FakeSource("issues", "github-issues", outcome);
		const config: FactoryConfig = {
			...issuesConfig,
			maxParallelAgents: 1,
			agentPollIntervalSeconds: 60,
		};
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("[awaiting]"), "the awaiting ticket");
					// Enter on the awaiting ticket opens its decision modal.
					await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
					await pressArrow(setup, "down", "the Goto row", (f) => frameText(f).includes("❯ Goto"));
					await pressArrow(setup, "down", "the route row", (f) =>
						frameText(f).includes("❯ Handoff: review"),
					);
					// The route cannot take a seat: it enters the queue, and the Message
					// line says so instead of starting an Agent.
					const queued = await press(setup, "return", "the route to wait", (f) =>
						frameText(f).includes("is in the Work queue"),
					);
					expect(frameText(queued)).toContain("waiting: 1");
					expect(runner.commands().filter((c) => c.startsWith("herdr agent start"))).toEqual([]);
					// The item carries the route's origin and the edge's resolved choice,
					// and the ticket keeps the state it wears while it waits.
					const items = state.workQueue();
					expect(items.map(workQueueIdentityOf)).toEqual([FIRST]);
					if (items[0]?.kind !== "handoff") throw new Error("the waiting item is not a handoff");
					expect(items[0].origin).toBe("workflow");
					expect(items[0].choice.taskType).toBe("review");
					expect(state.ticketState(FIRST)).toBe("awaiting");
					// The trace the route came from is still undecided: the routed
					// handoff never started.
					expect(state.lastCompletion(FIRST)?.decision).toBeNull();
				},
				WIDTH,
				34,
				{ state, config, home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The force-dispatch through the real UI (issue #89, ADR 0034): Enter on a
	 * queue row starts the item now, over a full Parallel limit. The seat the
	 * fixture holds is a live agent in the list, so the cap is full from the
	 * boot, and the frames verify the start, its seat, and the failures' ends.
	 */
	test("Enter force-dispatches the item over a full cap, and the seat stands over it", async () => {
		const fixture = forcedFixture();
		const { enqueue, boot } = forceDispatchApp(fixture);
		enqueue(FORCED);
		try {
			await boot(async (setup) => {
				fixture.source.settle(fixture.outcome);
				await awaitFrame(
					setup,
					(f) => f.includes("Work") && f.includes("waiting: 1"),
					"the Work header",
				);
				await clickWorkHeader(setup);
				await awaitFrame(
					setup,
					(f) => f.includes("place 1 of 1"),
					"the queue's row under the cursor",
				);
				// The cap is full from the boot: the held seat stands on the line.
				expect(setup.captureCharFrame()).toContain("auto: off 1/1");
				const frame = await press(setup, "return", "the force-dispatch message", (f) =>
					f.includes("force-dispatched"),
				);
				// The Message line names the start over the cap, and the seat count
				// stands over the limit: the held seat plus the new one.
				expect(messageRowOf(frame)).toContain(
					`force-dispatched "Close the stale deploy branch" over the Parallel limit`,
				);
				expect(frame).toContain("auto: off 2/1");
				// The item left the queue with the settle, the ticket holds the
				// handoff, and the start ran the real external steps on the item's
				// own captured choice.
				expect(fixture.state.workQueue()).toHaveLength(0);
				expect(fixture.state.ticketState(FORCED)).toBe("handed-off");
				expect(fixture.runner.commands().some((command) => command.includes("agent start"))).toBe(
					true,
				);
			});
		} finally {
			fixture.state.close();
		}
	});

	test("a force-dispatch that fails its start leaves the item and the queue with its warning", async () => {
		const fixture = forcedFixture();
		// The herdr the start meets is down: the first external step fails with
		// herdr's own refusal, before it creates anything.
		fixture.runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: "error: herdr is not running\n",
		});
		const { enqueue, boot } = forceDispatchApp(fixture);
		enqueue(FORCED);
		try {
			await boot(async (setup) => {
				fixture.source.settle(fixture.outcome);
				await awaitFrame(
					setup,
					(f) => f.includes("Work") && f.includes("waiting: 1"),
					"the Work header",
				);
				await clickWorkHeader(setup);
				await awaitFrame(
					setup,
					(f) => f.includes("place 1 of 1"),
					"the queue's row under the cursor",
				);
				const frame = await press(setup, "return", "the start's failure on the Message line", (f) =>
					f.includes("herdr is not running"),
				);
				expect(messageRowOf(frame)).toContain("failed: error: herdr is not running");
				// The ask is answered: the item left the queue, and the ticket keeps
				// the state the failed start never touched.
				expect(fixture.state.workQueue()).toHaveLength(0);
				expect(fixture.state.ticketState(FORCED)).toBe("open");
			});
		} finally {
			fixture.state.close();
		}
	});

	test("a force-dispatch the claim refuses leaves the item and the queue with the warning", async () => {
		const fixture = forcedFixture();
		const { enqueue, boot } = forceDispatchApp(fixture);
		// The item's origin requires the open state; the ticket holds an
		// in-flight state on its seat: the claim the dispatch re-runs refuses
		// the start.
		enqueue(HELD, "open");
		try {
			await boot(async (setup) => {
				fixture.source.settle(fixture.outcome);
				await awaitFrame(
					setup,
					(f) => f.includes("Work") && f.includes("waiting: 1"),
					"the Work header",
				);
				await clickWorkHeader(setup);
				await awaitFrame(
					setup,
					(f) => f.includes("place 1 of 1"),
					"the queue's row under the cursor",
				);
				const frame = await press(setup, "return", "the claim's refusal on the Message line", (f) =>
					f.includes("force-dispatch of"),
				);
				// The refusal names the state the ticket holds, whatever the boot
				// settled it in: the in-flight state the seat keeps.
				expect(messageRowOf(frame)).toContain(`failed: the ticket is now `);
				// The item left the queue with the refusal, and the ticket keeps its
				// state and its own failure surface.
				expect(fixture.state.workQueue()).toHaveLength(0);
				expect(fixture.state.ticketState(HELD)).not.toBe("open");
			});
		} finally {
			fixture.state.close();
		}
	});

	test("the section goes away with its queue, and down crosses into it while it stands", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 2"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					// Up from the first queue row crosses to the Consultation
					// section, and down from there crosses back into the queue
					// while the section stands.
					const up = await press(setup, "k", "the cursor to cross to the Consultations", (f) =>
						f.includes("┌─❯ Consultations"),
					);
					expect(up).toContain("❯ Consultations");
					const across = await press(setup, "j", "the cursor to cross into the Work queue", (f) =>
						detailPaneText(f).includes("Origin: open"),
					);
					expect(across).toContain("[open]");
					// Cancel both items: the queue empties, and the section keeps its
					// header with its count (ADR 0049), the way the other sections do.
					await press(setup, "delete", "the first item to cancel", (f) => f.includes("waiting: 1"));
					await press(setup, "delete", "the last item to cancel", (f) => f.includes("waiting: 0"));
					const empty = await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 0"),
						"the emptied Work section",
					);
					expect(workHeaderRow(empty)).toBeGreaterThanOrEqual(0);
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The queue's own cursor, not the other section's, states the adjacency
	 * (ADR 0034): a direct click on the Work header lands the cursor on a one-row
	 * queue the Consultation cursor never walked through, and up still crosses out
	 * of it. The row count alone used to hold the answer, so that up refused.
	 */
	test("a one-row queue still crosses up after a direct click on its header", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 1"),
						"the Work header",
					);
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					const up = await press(setup, "k", "the cursor to cross to the Consultations", (f) =>
						f.includes("┌─❯ Consultations"),
					);
					expect(up).toContain("❯ Consultations");
					expect(frameText(up)).not.toContain("nowhere to move");
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});
});
