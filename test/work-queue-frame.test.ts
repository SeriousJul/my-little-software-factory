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
import { type FactoryState, openFactoryState } from "../src/state.ts";
import {
	awaitFrame,
	detailPaneText,
	frameText,
	mouseClick,
	press,
	pressArrow,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { agentListJson, emptyAgentRunner, FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { issuesConfig, issueTicket, seedAwaitingTurn, success } from "./state-fixture.ts";

const FIRST = "github:github.com:I_5";
const SECOND = "github:github.com:I_6";

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

// A zero Parallel limit: the queue holds its items the whole frame test,
// because neither the cap gate nor the pickup runs at a limit of zero.
const zeroSeatConfig = { ...issuesConfig, maxParallelAgents: 0 };

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

/** Click the Work header, the same toggle x takes for the cursor. */
type AppSetup = Parameters<Parameters<typeof withApp>[0]>[0];

async function clickWorkHeader(setup: AppSetup): Promise<void> {
	const row = workHeaderRow(setup.captureCharFrame());
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
	test("an idle factory keeps the two-section frame", async () => {
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
					expect(workHeaderRow(frame)).toBe(-1);
					// `awaiting` holds the word `waiting` inside it, so the
					// count form is what the Work header would add.
					expect(frameText(frame)).not.toMatch(/\bwaiting/);
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
					// Collapsed by default: the header carries the count, the
					// rows wait behind it.
					expect(frame).toContain("▸ Work");
					// The click expands, and the cursor lands on the first row.
					await clickWorkHeader(setup);
					const expanded = await awaitFrame(
						setup,
						(f) => f.includes("▾ Work"),
						"the expanded Work section",
					);
					expect(expanded).toContain("❯ Work queue");
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

	test("u and d reorder the waiting starts, and the captured choice stays put", async () => {
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
					// d takes the first item to the back: the workflow route
					// leads the queue now, and the cursor follows its item.
					const swapped = await press(
						setup,
						"d",
						"the first item to move to the back",
						(f) => queueRowIndex(f, workflowRowLead) < queueRowIndex(f, openRowLead),
					);
					expect(detailPaneText(swapped)).toContain("Origin: open");
					expect(detailPaneText(swapped)).toContain("place 2 of 2");
					// u brings it back, and the queue order leads with the
					// workflow route again.
					const restored = await press(
						setup,
						"u",
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
	 * A route asked at a full cap waits in the queue, through the real decision
	 * modal (ADR 0034, #92 AC1).
	 *
	 * ONE seat, held by a live agent on the second ticket, so the awaiting
	 * ticket's route cannot take a seat and enters the queue with the choice the
	 * workflow edge resolved. The observation cycle never picks it up: the cap
	 * stays full the whole walk.
	 */
	test("a decision-row route at a full cap waits in the Work queue with its choice", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const tickets = twoTickets();
		const outcome = success(tickets);
		// The first ticket ends its turn and awaits its route; the second holds the
		// factory's one seat with a live agent.
		seedAwaitingTurn(state, outcome, FIRST);
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
			workflows: [{ from: "implement", to: ["review"] }],
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
					expect(items.map((item) => item.ticketIdentity)).toEqual([FIRST]);
					expect(items[0]?.origin).toBe("workflow");
					expect(items[0]?.choice.taskType).toBe("review");
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
					expect(across).toContain("❯ Work queue");
					// Cancel both items: the queue empties, and the section
					// hides with it.
					await press(setup, "delete", "the first item to cancel", (f) => f.includes("waiting: 1"));
					await press(setup, "delete", "the last item to cancel", (f) => f.includes("waiting: 0"));
					await clickWorkHeader(setup);
					const empty = await awaitFrame(
						setup,
						(f) => !f.includes("Work"),
						"the Work section to hide",
					);
					expect(workHeaderRow(empty)).toBe(-1);
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
