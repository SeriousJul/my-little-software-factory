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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppProps } from "../src/components/app.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { agentNameFor } from "../src/naming.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import {
	actionBarRowOf,
	awaitFrame,
	detailPaneText,
	frameText,
	HEIGHT,
	messageRowOf,
	press,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { agentListJson, emptyAgentRunner, type FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { issuesConfig, issueTicket, seedInFlightTurn, success } from "./state-fixture.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-mute-"));
	paths.push(dir);
	return join(dir, "state.sqlite");
}

const FIRST = "github:github.com:I_5";
const SECOND = "github:github.com:I_6";
const firstTitle = "Add a webhook retry policy";
const secondTitle = "Watch agent turns";
/** The list row truncates its title, so a row is found by its leading cells. */
const FIRST_LEAD = "Add a w";
const SECOND_LEAD = "Watch a";
const repoIdentity = "github.com/acme/factory";
/** The name the handoff of the fixture Ticket expects its Agent to run under. */
const firstAgent = agentNameFor(firstTitle);

function twoTickets(): FetchedTicket[] {
	return [
		issueTicket(FIRST, { title: firstTitle }),
		issueTicket(SECOND, { title: secondTitle, externalKey: "#6" }),
	];
}

function checkout(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-mute-checkout-"));
	paths.push(dir);
	return dir;
}

/** The config with the one issue source and a checkout the handoff can use. */
function fixtureConfig(over: Partial<FactoryConfig> = {}): FactoryConfig {
	return { ...issuesConfig, repos: { [repoIdentity]: checkout() }, ...over };
}

interface Rig {
	state: FactoryState;
	src: FakeSource;
	runner: FakeRunner;
	props: Partial<AppProps>;
	config: FactoryConfig;
}

/**
 * A state that lists two open Tickets, with the app props that match it.
 *
 * The poll interval is pinned long so the loop runs its first cycle and waits;
 * a test that wants the loop to keep turning passes a `pollIntervalMs` of its own.
 */
function rig(over: { config?: Partial<FactoryConfig>; pollIntervalMs?: number } = {}): Rig {
	const state = openFactoryState(statePath());
	// Hold the flat axis: the frames read the unsplit list (ADR 0066).
	state.grouping.setGroupingAxis("tickets", "none");
	state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
	state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, success(twoTickets()));
	const runner = emptyAgentRunner();
	const home = mkdtempSync(join(tmpdir(), "factory-mute-home-"));
	paths.push(home);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config = fixtureConfig(over.config ?? {});
	const src = new FakeSource("issues", "github-issues", success(twoTickets()));
	return {
		state,
		src,
		runner,
		config,
		props: {
			config,
			state,
			runner,
			home,
			configPath,
			sources: [src],
			pollIntervalMs: over.pollIntervalMs ?? 60_000,
		},
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
function headerRow(frame: string): string {
	return rowsOf(frame).find((row) => row.includes("Tickets")) ?? "";
}

/** Settle the source's first fetch and wait for the Ticket rows to paint. */
async function listed(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	src: FakeSource,
	lead = FIRST_LEAD,
): Promise<string> {
	src.settle(success(twoTickets()));
	return await awaitFrame(setup, (f) => listRowOf(f, lead) >= 0, "the Ticket rows");
}

/** Start a refresh with the `r` key and let its source fetch land. */
async function refreshed(
	setup: Parameters<Parameters<typeof withApp>[0]>[0],
	src: FakeSource,
	outcome = success(twoTickets()),
): Promise<void> {
	// The refresh control reaches the source on the next frame, and the fake
	// holds that fetch until this test settles it.
	const before = src.calls;
	setup.mockInput.pressKey("r");
	await awaitFrame(setup, () => src.calls > before, "the refresh to reach the source", 5_000);
	src.settle(outcome);
	await awaitFrame(
		setup,
		(f) => !messageRowOf(f).includes("refreshing"),
		"the refresh to land",
		5_000,
	);
}

describe("the mute key", () => {
	test("u mutes the source the row's Ticket came in on, for every ticket of it", async () => {
		const { state, src, props, runner } = rig();
		try {
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
					const frame = await press(
						setup,
						"u",
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
					await press(
						setup,
						"f",
						"the empty pile",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					await press(setup, "f", "the muted view", (f) => listRowOf(f, FIRST_LEAD) >= 0);
					// The key flips from the ledger's row: the ledger empties with the
					// last act, and the rows come back to the view the cycle walks to.
					const back = await press(setup, "u", "the unmute", (f) => f.includes("no muted Tickets"));
					expect(messageRowOf(back)).toContain(
						"source issues is not muted: its rows come back from the list, and the machine may start them",
					);
					expect(headerRow(back)).not.toContain("muted");
					expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
						expect.objectContaining({ muted: false, mutedAt: null }),
					);
					const rowsBack = await press(
						setup,
						"f",
						"every row",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
					);
					expect(headerRow(rowsBack)).toContain("open: 2");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the bar names the source the mute reaches, in both Ticket panes", async () => {
		const { state, src, props } = rig();
		// A frame wide enough to hold the section's whole ladder.
		const wide = 150;
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					setup.resize(wide, HEIGHT);
					const bar = await awaitFrame(
						setup,
						(f) => actionBarRowOf(f).includes("u Mute issues"),
						"the bar to name the mute",
					);
					expect(actionBarRowOf(bar)).toContain("u Mute issues");
					await press(setup, "u", "the mute", (f) => headerRow(f).includes("muted: 2"));
					// The ledger holds the rows the mute took, and the bar's hint
					// flips on the row the ledger stands on.
					await press(
						setup,
						"f",
						"the empty pile",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					const ledger = await press(
						setup,
						"f",
						"the muted view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					const flipped = await awaitFrame(
						setup,
						(f) => actionBarRowOf(f).includes("u Un-mute issues"),
						"the bar to flip",
					);
					expect(actionBarRowOf(flipped)).toContain("u Un-mute issues");
					// The detail pane's bar names the same key for the same source.
					setup.mockInput.pressKey("l");
					const detailed = await awaitFrame(
						setup,
						(f) => actionBarRowOf(f).includes("u Un-mute issues"),
						"the detail bar to name the mute",
					);
					expect(actionBarRowOf(detailed)).toContain("u Un-mute issues");
					expect(listRowOf(ledger, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
				},
				wide,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the muted view is the ledger of the source acts, with the marker on its rows", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "u", "the mute", (f) => headerRow(f).includes("muted: 2"));
					// The cycle walks the empty pile past, and the ledger holds both
					// rows, in the list's own order, each wearing the marker.
					await press(
						setup,
						"f",
						"the empty pile",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					const ledger = await press(
						setup,
						"f",
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
					await press(setup, "f", "every row", (f) => listRowOf(f, SECOND_LEAD) >= 0);
					const active = await press(
						setup,
						"f",
						"the active rows",
						(f) => listRowOf(f, FIRST_LEAD) < 0,
					);
					expect(headerRow(active)).toContain("muted: 2");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("a live ticket of the muted source keeps its row beside the marker", async () => {
		// ADR 0070: the mute ends where live work begins, in the ignore's own
		// shape. The row is how the operator reaches the Live view, the Goto,
		// and the Close.
		const state = openFactoryState(statePath());
		state.grouping.setGroupingAxis("tickets", "none");
		const outcome = success([
			issueTicket(FIRST),
			issueTicket(SECOND, { title: secondTitle, externalKey: "#6" }),
		]);
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		seedInFlightTurn(state, outcome, FIRST);
		const runner = emptyAgentRunner();
		runner.set("herdr", ["agent", "list"], { stdout: workingAgent() });
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					src.settle(outcome);
					const frame = await awaitFrame(
						setup,
						(f) => rowsOf(f).some((r) => r.startsWith("│") && r.includes("[running]")),
						"the running badge",
					);
					// The live Agent holds a Parallel limit seat the mute rides over.
					expect(frame).toContain("auto: off 1/2");
					// The cursor holds the live row. The mute takes the resting
					// sibling out of the list and leaves the live row standing,
					// wearing its own marker beside the badge.
					const muted = await press(setup, "u", "the mute", (f) => {
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
						state.ticketWorkCycle
							.projectedTickets([], "implement")
							.find((t) => t.identity === FIRST)?.muted,
					).toBe(true);
					const taken = await press(setup, "u", "the unmute", (f) => {
						const row = rowsOf(f).find((r) => r.startsWith("│") && r.includes("[running]"));
						return row !== undefined && !row.includes("muted");
					});
					expect(messageRowOf(taken)).toContain(
						"source issues is not muted: its rows come back from the list, and the machine may start them",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 60_000 },
			);
		} finally {
			state.close();
		}
	});

	test("the mute removes a start that waits in the Work queue, in the same write", async () => {
		// One seat, held by the first Ticket's own Agent: the start the operator
		// asked for on the second waits in the Work queue, which is the waiting
		// item the mute takes away with the rows.
		const state = openFactoryState(statePath());
		state.grouping.setGroupingAxis("tickets", "none");
		const outcome = success(twoTickets());
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		seedInFlightTurn(state, outcome, FIRST);
		const runner = emptyAgentRunner();
		runner.set("herdr", ["agent", "list"], { stdout: workingAgent() });
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					const frame = await listed(setup, src, SECOND_LEAD);
					// The running Ticket holds the one seat, so the second ticket's
					// start waits in the queue.
					expect(frame).toContain("auto: off 1/1");
					await press(setup, "j", "the open row", (f) => detailPaneText(f).includes(secondTitle));
					await press(setup, "return", "the start to wait", (f) => f.includes("waiting: 1"));
					// The act and its settle are one write: the waiting start leaves
					// the queue, and the message states it beside the act.
					const muted = await press(setup, "u", "the start to leave the queue", (f) =>
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
				WIDTH,
				HEIGHT,
				{
					config: fixtureConfig({ maxParallelAgents: 1 }),
					state,
					sources: [src],
					runner,
					pollIntervalMs: 60_000,
				},
			);
		} finally {
			state.close();
		}
	});

	test("a muted source keeps refreshing, and the unmute brings its rows back current", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "u", "the mute", (f) => headerRow(f).includes("muted: 2"));
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
					await press(
						setup,
						"f",
						"the empty pile",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					await press(
						setup,
						"f",
						"the muted view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
					);
					const back = await press(setup, "u", "the unmute", (f) => f.includes("no muted Tickets"));
					expect(messageRowOf(back)).toContain(
						"source issues is not muted: its rows come back from the list, and the machine may start them",
					);
					expect(state.ticketWorkCycle.projectedTickets([], "implement")[0]).toEqual(
						expect.objectContaining({ muted: false }),
					);
					const rowsBack = await press(
						setup,
						"f",
						"every row",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
					);
					expect(headerRow(rowsBack)).toContain("open: 2");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the empty active list points at the muted ledger, not at an idle factory", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					const empty = await press(setup, "u", "the last rows to hide", (f) =>
						rowsOf(f).some((r) => r.startsWith("│") && r.includes("no active Tickets")),
					);
					// The empty list names the count it hides and the key that
					// shows them, the way the ignore's pile does.
					expect(empty).toContain("no active Tickets; 2 muted - press f");
					expect(headerRow(empty)).toContain("muted: 2");
					// The ledger holds both rows, and the empty pile names its own
					// emptiness on the way past.
					await press(setup, "f", "the empty pile", (f) => listRowOf(f, FIRST_LEAD) < 0);
					const ledger = await press(
						setup,
						"f",
						"the muted view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
					);
					expect(headerRow(ledger)).toContain("muted: 2");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the detail pane names the mute, its moment, and the key that takes it back", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "u", "the mute", (f) => headerRow(f).includes("muted: 2"));
					await press(
						setup,
						"f",
						"the empty pile",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					const ledger = await press(
						setup,
						"f",
						"the muted view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					const detail = detailPaneText(ledger);
					expect(detail).toContain("Muted source");
					expect(detail).toContain("no automatic start, and no row while the Ticket rests");
					expect(detail).toContain("press u to take the mute back");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});
});

/**
 * ADR 0070's in-memory shell: the mute is durable factory state on the
 * source's row, and the shell holds no state file for it. The key says so on
 * the Message line and leaves the list standing, so the press does not read
 * as a view change the frame cannot show.
 */
test("the no-state shell refuses u with the missing fact", async () => {
	const seeded = openFactoryState(statePath());
	seeded.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
	seeded.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, success(twoTickets()));
	const projection = seeded.ticketWorkCycle.ticketListViews([], "implement").rows;
	seeded.close();
	await withApp(
		async (setup) => {
			await awaitFrame(
				setup,
				(f) => rowsOf(f).some((r) => r.startsWith("│") && r.includes("[implement]")),
				"the shell's Ticket row",
			);
			const refused = await press(setup, "u", "the mute refusal", (f) =>
				messageRowOf(f).includes("needs SQLite state"),
			);
			expect(messageRowOf(refused)).toContain("muting a source needs SQLite state");
			// The refusal is a refusal: the list stands where it was handed.
			expect(frameText(refused)).toContain(firstTitle.slice(0, 9));
			expect(refused).not.toContain("muted:");
		},
		WIDTH,
		HEIGHT,
		{
			config: fixtureConfig(),
			runner: emptyAgentRunner(),
			initialTickets: projection,
			pollIntervalMs: 60_000,
		},
	);
});
