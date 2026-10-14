/**
 * The muted source through the real UI (ADR 0070).
 *
 * Every test boots the real App against a real SQLite state on a temp path, a
 * fake ticket source, and a fake command runner, with a pinned poll interval,
 * so the observation cycle and the handoff pipeline both run with no herdr
 * session and no GitHub. The assertions stay on what the operator sees and
 * what the factory does: the rendered frame, the Message line, the Action bar,
 * the state file read back through its own API, and the commands the fake
 * runner recorded.
 */

import { describe, expect, test } from "bun:test";

import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { FetchedTicket, Ticket } from "../src/domain/ticket.ts";
import { agentNameFor } from "../src/naming.ts";
import type { FactoryState } from "../src/state.ts";
import {
	actionBarRowOf,
	detailPaneText,
	FRAME_DEADLINE_MS,
	frameUntil,
	guideKey,
	HEIGHT,
	messageRowOf,
	pressControl,
	rowsOf,
	settle,
	sleep,
	WIDTH,
	waitSourceHealthy,
	withApp,
} from "./app-harness.ts";
import { fetchSuccess, issueTicket, ticketOf } from "./fact-fixtures.ts";
import { agentListJson, type FakeRunner } from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { type Plane, plane } from "./plane.ts";

const FIRST = "github:github.com:I_5";
const SECOND = "github:github.com:I_6";
const firstTitle = "Add a webhook retry policy";
const secondTitle = "Watch agent turns";
/** The list row truncates its title, so a row is found by its leading cells. */
const FIRST_LEAD = "Add a w";
const SECOND_LEAD = "Watch a";
const _repoIdentity = "github.com/acme/factory";
/** The name the handoff of the fixture Ticket expects its Agent to run under. */
const firstAgent = agentNameFor({ identity: FIRST, title: firstTitle });

function twoTickets(): FetchedTicket[] {
	return [
		issueTicket(FIRST, { title: firstTitle }),
		issueTicket(SECOND, { title: secondTitle, externalKey: "#6" }),
	];
}

/** The one issues source the suite stands its planes on. */
const issuesSourceConfig: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

/** The two resting rows the plane lists, the first live where the test names it. */
function restingRows(liveFirst: boolean): readonly Ticket[] {
	return [
		liveFirst
			? ticketOf(issueTicket(FIRST, { title: firstTitle }), {
					state: "handed-off",
					handoff: {
						agentType: "pi",
						environment: "live-worktree",
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
						attemptId: "seeded-first",
						paneId: "pane-1",
						tabId: "tab-1",
						workspaceId: "ws-1",
						herdrName: firstAgent,
						startedAt: "2026-01-01T00:00:00Z",
					},
					handoffCount: 1,
				})
			: ticketOf(issueTicket(FIRST, { title: firstTitle })),
		ticketOf(issueTicket(SECOND, { title: secondTitle, externalKey: "#6" })),
	];
}

interface Rig {
	plane: Plane;
	state: FactoryState;
	src: FakeSource;
	runner: FakeRunner;
}

/**
 * A plane that lists two open Tickets, the first live where the test names it.
 *
 * The loop runs on the plane's own schedule; the first cycle lands and waits,
 * the way the pinned poll the suite ran on did.
 */
async function rig(over: { config?: Partial<FactoryConfig>; live?: boolean } = {}): Promise<Rig> {
	const live = over.live === true;
	const planeRecord = await plane({
		groupingAxis: "none",
		sources: [{ config: issuesSourceConfig, tickets: restingRows(live) }],
		config: over.config,
		...(live
			? { commands: (fake) => fake.set("herdr", ["agent", "list"], { stdout: workingAgent() }) }
			: {}),
	});
	return {
		plane: planeRecord,
		state: planeRecord.state,
		src: planeRecord.sources[0] as FakeSource,
		runner: planeRecord.fakeRunner,
	};
}

/** The herdr answer for the fixture Ticket's own Agent working in its pane. */
function workingAgent(name = firstAgent): string {
	return agentListJson([
		{ paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", agent: "pi", status: "working", name },
	]);
}

/** The row of a title inside the list pane only, so the detail cannot hide it. */
function listRowOf(frame: string, lead: string): number {
	return rowsOf(frame).findIndex((row) => {
		if (!row.startsWith("│")) return false;
		const left = row.split("││")[0] ?? "";
		return left.includes(lead);
	});
}

/** The Ticket section's header row. */
/**
 * Press the List filter's guide key until the frame holds the facts the press
 * must leave, re-sending inside the rig's one deadline where a key can land
 * mid-update and the plane drops it.
 */
async function filterTo(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const deadline = Date.now() + FRAME_DEADLINE_MS - 500;
	for (;;) {
		await guideKey(setup, "ticket-filter", "f", { quiet: true });
		const frame = setup.captureCharFrame();
		if (predicate(frame)) return settle(setup);
		if (Date.now() >= deadline) throw new Error(`the filter key never left ${what}`);
		await sleep(300);
	}
}

/**
 * Press the mute's guide key until the frame holds the facts the press must
 * leave, re-sending inside the rig's one deadline where a key can land
 * mid-update and the plane drops it.
 */
async function muteTo(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const deadline = Date.now() + FRAME_DEADLINE_MS - 500;
	for (;;) {
		await guideKey(setup, "ticket-mute", "u", { quiet: true });
		const frame = setup.captureCharFrame();
		if (predicate(frame)) return settle(setup);
		if (Date.now() >= deadline) throw new Error(`the mute key never left ${what}`);
		await sleep(300);
	}
}

function headerRow(frame: string): string {
	return rowsOf(frame).find((row) => row.includes("Tickets")) ?? "";
}

/** Settle the source's first fetch and wait for the Ticket rows to paint. */
async function listed(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	src: FakeSource,
	lead = FIRST_LEAD,
): Promise<string> {
	src.settle(fetchSuccess(twoTickets()));
	// The settle lands on a later frame; wait for the health to stand, so a
	// key that asks for an actionable row reads the settle, not the loading.
	await waitSourceHealthy(setup.plane.state);
	return await frameUntil(setup, "the Ticket rows", (f) => listRowOf(f, lead) >= 0);
}

/** Start a refresh with the `r` key and let its source fetch land. */
async function refreshed(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	src: FakeSource,
	outcome = fetchSuccess(twoTickets()),
): Promise<void> {
	// The refresh control reaches the source on the next frame, and the fake
	// holds that fetch until this test settles it.
	const before = src.calls;
	await pressControl(setup, "refresh", { quiet: true });
	await frameUntil(setup, "the refresh to reach the source", () => src.calls > before);
	src.settle(outcome);
	await frameUntil(setup, "the refresh to land", (f) => !messageRowOf(f).includes("refreshing"));
}

describe("the mute key", () => {
	test("u mutes the source the row's Ticket came in on, for every ticket of it", async () => {
		const { plane, state, src, runner } = await rig();
		await withApp(
			async (setup) => {
				const before = await listed(setup, src);
				expect(headerRow(before)).toContain("open: 2");
				expect(headerRow(before)).not.toContain("muted");
				// One key press, on the row the cursor holds. The plane writes
				// nothing to the source for a mute: no label, no close, no
				// comment. The only command the frame runs after the key is
				// the observation's own read-only agent list.
				const commandsBefore = runner.commands().length;
				const frame = await muteTo(
					setup,
					"the rows to leave the list",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && headerRow(f).includes("muted: 2"),
				);
				// Both resting rows are gone - the mute is retroactive to every
				// ticket the source brought in - and the header names the
				// ledger the filter hides.
				expect(listRowOf(frame, SECOND_LEAD)).toBe(-1);
				expect(headerRow(frame)).toContain("muted: 2");
				expect(headerRow(frame)).toContain("open: 0");
				// The Message line states the act on the source in the plane's
				// own words.
				expect(messageRowOf(frame)).toContain(
					"source issues is muted: no row while its tickets rest, no automatic start",
				);
				expect(
					runner
						.commands()
						.slice(commandsBefore)
						.every((c) => c === "herdr agent list"),
				).toBe(true);
				// The flag is factory state on the source's row, read back
				// through the file's own API, and the row's projection carries
				// it with its moment.
				expect(state.ticketWorkCycle.projectedTickets([], "implement")).toEqual([
					expect.objectContaining({
						identity: FIRST,
						muted: true,
						mutedAt: expect.any(String),
					}),
					expect.objectContaining({ identity: SECOND, muted: true }),
				]);
				// The flag follows the Ticket into the state the rows stand in:
				// the resting rows left the active view and the machine's own
				// read sees them withheld.
				expect(state.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([]);
				expect(state.ticketWorkCycle.automaticStartBlockedTickets()).toEqual(
					new Set([FIRST, SECOND]),
				);
				// The same key takes the mute back, from the row the ledger
				// holds: the cycle walks the empty pile past, and the ledger's
				// row is the act's own undo.
				await filterTo(
					setup,
					"the empty pile",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
				);
				await filterTo(setup, "the muted view", (f) => listRowOf(f, FIRST_LEAD) >= 0);
				// The key flips from the ledger's row: the ledger empties with the
				// last act, and the rows come back to the view the cycle walks to.
				const back = await muteTo(setup, "the unmute", (f) => f.includes("no muted Tickets"));
				expect(messageRowOf(back)).toContain(
					"source issues is not muted: its rows come back from the list, and the machine may start them",
				);
				expect(headerRow(back)).not.toContain("muted");
				expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
					expect.objectContaining({ muted: false, mutedAt: null }),
				);
				const rowsBack = await filterTo(
					setup,
					"every row",
					(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
				);
				expect(headerRow(rowsBack)).toContain("open: 2");
			},
			{ width: WIDTH, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});

	test("the bar names the source the mute reaches, in both Ticket panes", async () => {
		const { plane, src } = await rig();
		// A frame wide enough to hold the section's whole ladder, the
		// Delete key's wider hint included (ADR 0122).
		const wide = 156;
		await withApp(
			async (setup) => {
				await listed(setup, src);
				setup.resize(wide, HEIGHT);
				const bar = await frameUntil(setup, "the bar to name the mute", (f) =>
					actionBarRowOf(f).includes("u Mute issues"),
				);
				expect(actionBarRowOf(bar)).toContain("u Mute issues");
				await muteTo(setup, "the mute", (f) => f.includes("muted: 2"));
				// The ledger holds the rows the mute took, and the bar's hint
				// flips on the row the ledger stands on.
				await filterTo(
					setup,
					"the empty pile",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
				);
				const ledger = await filterTo(
					setup,
					"the muted view",
					(f) => listRowOf(f, FIRST_LEAD) >= 0,
				);
				const flipped = await frameUntil(setup, "the bar to flip", (f) =>
					actionBarRowOf(f).includes("u Un-mute issues"),
				);
				expect(actionBarRowOf(flipped)).toContain("u Un-mute issues");
				// The detail pane's bar names the same key for the same source.
				const detailed = await pressControl(setup, "detail", { shows: "u Un-mute issues" });
				expect(actionBarRowOf(detailed)).toContain("u Un-mute issues");
				expect(listRowOf(ledger, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
			},
			{ width: wide, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});

	test("the muted view is the ledger of the source acts, with the marker on its rows", async () => {
		const { plane, src } = await rig();
		await withApp(
			async (setup) => {
				await listed(setup, src);
				await muteTo(setup, "the mute", (f) => f.includes("muted: 2"));
				// The cycle walks the empty pile past, and the ledger holds both
				// rows, in the list's own order, each wearing the marker.
				await filterTo(
					setup,
					"the empty pile",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
				);
				const ledger = await filterTo(
					setup,
					"the muted view",
					(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
				);
				const rows = rowsOf(ledger);
				const firstRow = rows[listRowOf(ledger, FIRST_LEAD)] ?? "";
				const secondRow = rows[listRowOf(ledger, SECOND_LEAD)] ?? "";
				expect(firstRow).toContain("muted");
				expect(secondRow).toContain("muted");
				expect(headerRow(ledger)).toContain("muted: 2");
				// The ledger keeps the badge the state wears: resting, open.
				expect(firstRow).toContain("[open]");
				// The every-row view holds them too, and back to the active
				// rows, where they are gone.
				await filterTo(setup, "every row", (f) => listRowOf(f, SECOND_LEAD) >= 0);
				const active = await filterTo(
					setup,
					"the active rows",
					(f) => listRowOf(f, FIRST_LEAD) < 0,
				);
				expect(headerRow(active)).toContain("muted: 2");
			},
			{ width: WIDTH, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});

	test("a live ticket of the muted source keeps its row beside the marker", async () => {
		// ADR 0070: the mute ends where live work begins, in the ignore's own
		// shape. The row is how the operator reaches the Live view, the Goto,
		// and the Close.
		const { plane, state, src } = await rig({ live: true });
		await withApp(
			async (setup) => {
				src.settle(fetchSuccess(twoTickets()));
				const frame = await frameUntil(setup, "the running badge", (f) =>
					rowsOf(f).some((r) => r.startsWith("│") && r.includes("[running]")),
				);
				// The live Agent holds a Parallel limit seat the mute rides over.
				expect(frame).toContain("● manual 1/2");
				// The cursor holds the live row. The mute takes the resting
				// sibling out of the list and leaves the live row standing,
				// wearing its own marker beside the badge.
				const muted = await muteTo(setup, "the mute", (f) => {
					const row = rowsOf(f).find((r) => r.startsWith("│") && r.includes("[running]"));
					return row?.includes("muted") === true && listRowOf(f, SECOND_LEAD) < 0;
				});
				expect(listRowOf(muted, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
				expect(headerRow(muted)).toContain("muted: 2");
				expect(messageRowOf(muted)).toContain(
					"source issues is muted: no row while its tickets rest, no automatic start",
				);
				// The live row's projection carries the flag underneath the
				// row, and the same key takes the mute back.
				expect(
					state.ticketWorkCycle.projectedTickets([], "implement").find((t) => t.identity === FIRST)
						?.muted,
				).toBe(true);
				const taken = await muteTo(setup, "the unmute", (f) => {
					const row = rowsOf(f).find((r) => r.startsWith("│") && r.includes("[running]"));
					return row !== undefined && !row.includes("muted");
				});
				expect(messageRowOf(taken)).toContain(
					"source issues is not muted: its rows come back from the list, and the machine may start them",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane,
				loopPolicy: { kind: "polled", intervalMs: 60_000 },
			},
		);
	});

	test("the mute removes a start that waits in the Work queue, in the same write", async () => {
		// One seat, held by the first Ticket's own Agent: the start the operator
		// asked for on the second waits in the Work queue, which is the waiting
		// item the mute takes away with the rows.
		const { plane, state, src } = await rig({ config: { maxParallelAgents: 1 }, live: true });
		await withApp(
			async (setup) => {
				const frame = await listed(setup, src, SECOND_LEAD);
				// The running Ticket holds the one seat, so the second ticket's
				// start waits in the queue.
				expect(frame).toContain("● manual 1/1");
				await pressControl(setup, "move-list", { quiet: true, via: "j" });
				await frameUntil(setup, "the open row", (f) => detailPaneText(f).includes(secondTitle));
				await pressControl(setup, "handoff", { shows: "waiting: 1" });
				// The act and its settle are one write: the waiting start leaves
				// the queue, and the message states it beside the act.
				const muted = await muteTo(setup, "the start to leave the queue", (f) =>
					messageRowOf(f).includes("waiting start left the Work queue"),
				);
				expect(messageRowOf(muted)).toContain(
					"source issues is muted: no row while its tickets rest, no automatic start; 1 waiting start left the Work queue",
				);
				// The queue is empty, and the Ticket keeps its open state: the
				// cancel's stated semantics, the way the operator's own removal
				// already settles.
				expect(muted).toContain("waiting: 0");
				expect(state.ticketWorkCycle.ticketState(SECOND)).toBe("open");
				expect(state.workQueue.items()).toEqual([]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane,
				loopPolicy: { kind: "polled", intervalMs: 60_000 },
			},
		);
	});

	test("a muted source keeps refreshing, and the unmute brings its rows back current", async () => {
		const { plane, state, src } = await rig();
		await withApp(
			async (setup) => {
				await listed(setup, src);
				await muteTo(setup, "the mute", (f) => f.includes("muted: 2"));
				// The mute does not stop the read: a refresh reaches the source,
				// its tickets keep their source facts fresh, and the resting
				// rows stay withheld while the flag stands.
				await refreshed(setup, src);
				const frame = await settle(setup);
				expect(listRowOf(frame, FIRST_LEAD)).toBe(-1);
				expect(headerRow(frame)).toContain("muted: 2");
				// The unmute rides on the ledger's row: the cycle walks the
				// empty pile past, the key flips from the row that stands, and
				// the rows come back to the view the cycle walks to.
				await filterTo(
					setup,
					"the empty pile",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
				);
				await filterTo(
					setup,
					"the muted view",
					(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
				);
				const back = await muteTo(setup, "the unmute", (f) => f.includes("no muted Tickets"));
				expect(messageRowOf(back)).toContain(
					"source issues is not muted: its rows come back from the list, and the machine may start them",
				);
				expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
					expect.objectContaining({ muted: false }),
				);
				const rowsBack = await filterTo(
					setup,
					"every row",
					(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
				);
				expect(headerRow(rowsBack)).toContain("open: 2");
			},
			{ width: WIDTH, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});

	test("the empty active list points at the muted ledger, not at an idle factory", async () => {
		const { plane, src } = await rig();
		await withApp(
			async (setup) => {
				await listed(setup, src);
				const empty = await muteTo(setup, "the last rows to hide", (f) =>
					rowsOf(f).some((r) => r.startsWith("│") && r.includes("no active Tickets")),
				);
				// The empty list names the count it hides and the key that
				// shows them, the way the ignore's pile does.
				expect(empty).toContain("no active Tickets; 2 muted - press f");
				expect(headerRow(empty)).toContain("muted: 2");
				// The ledger holds both rows, and the empty pile names its own
				// emptiness on the way past.
				await filterTo(setup, "the empty pile", (f) => listRowOf(f, FIRST_LEAD) < 0);
				const ledger = await filterTo(
					setup,
					"the muted view",
					(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
				);
				expect(headerRow(ledger)).toContain("muted: 2");
			},
			{ width: WIDTH, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});

	test("the detail pane names the mute, its moment, and the key that takes it back", async () => {
		const { plane, src } = await rig();
		await withApp(
			async (setup) => {
				await listed(setup, src);
				await muteTo(setup, "the mute", (f) => f.includes("muted: 2"));
				await filterTo(
					setup,
					"the empty pile",
					(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
				);
				const ledger = await filterTo(
					setup,
					"the muted view",
					(f) => listRowOf(f, FIRST_LEAD) >= 0,
				);
				const detail = detailPaneText(ledger);
				expect(detail).toContain("Muted source");
				expect(detail).toContain("no automatic start, and no row while the Ticket rests");
				expect(detail).toContain("press u to take the mute back");
			},
			{ width: WIDTH, height: HEIGHT, plane, loopPolicy: { kind: "polled", intervalMs: 60_000 } },
		);
	});
});
