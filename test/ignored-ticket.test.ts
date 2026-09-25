/**
 * The ignored Ticket through the real UI (ADR 0060).
 *
 * Every test boots the real App against a real SQLite state on a temp path, a
 * fake ticket source, and a fake command runner, with a pinned poll interval, so
 * the observation cycle and the handoff pipeline both run with no herdr session
 * and no GitHub. The assertions stay on what the operator sees and what the
 * factory does: the rendered frame, the Message line, the Action bar, the Key
 * guide, the state file read back through its own API, and the commands the fake
 * runner recorded.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppProps } from "../src/components/app.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { withIssueReferences } from "../src/domain/ticket.ts";
import { agentNameFor } from "../src/naming.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import {
	actionBarRowOf,
	awaitFrame,
	detailPaneText,
	HEIGHT,
	messageRowOf,
	press,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	agentListJson,
	emptyAgentRunner,
	type FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { issuesConfig, issueTicket, seedInFlightTurn, success } from "./state-fixture.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-ignore-"));
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
	const dir = mkdtempSync(join(tmpdir(), "factory-ignore-checkout-"));
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
function rig(
	over: { autoMode?: boolean; config?: Partial<FactoryConfig>; pollIntervalMs?: number } = {},
): Rig {
	const state = openFactoryState(statePath());
	state.initializeSources([{ name: "issues", kind: "github-issues" }]);
	state.applyFetch({ name: "issues", kind: "github-issues" }, success(twoTickets()));
	if (over.autoMode === true) state.setAutoHandoffMode(true);
	const runner = emptyAgentRunner();
	const home = mkdtempSync(join(tmpdir(), "factory-ignore-home-"));
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

/** Stub the git and herdr answers a live-worktree handoff needs. */
function stubHandoff(runner: FakeRunner, path: string): void {
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
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

/**
 * True when the Ticket list - and only the list - holds a row for `lead`.
 *
 * The Work queue's row names the same ticket by title, so a plain frame scan
 * cannot tell the two panes apart; the list's row is the one that carries the
 * task type badge.
 */
function ticketRowHolds(frame: string, lead: string): boolean {
	return rowsOf(frame).some(
		(row) => row.startsWith("│") && row.includes("[implement]") && row.includes(lead),
	);
}

/** The Ticket section's header row. */
function headerRow(frame: string): string {
	return rowsOf(frame).find((row) => row.includes("Tickets")) ?? "";
}

/**
 * Count the attention-bell bytes the app writes to the terminal: the held
 * count's own alert, which a List filter cycle must never ring (ADR 0060).
 */
function countBells(): { count: () => number; restore: () => void } {
	let bells = 0;
	const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
		if (String(chunk).includes("\u0007")) bells += 1;
		return true;
	}) as typeof process.stdout.write);
	return { count: () => bells, restore: () => spy.mockRestore() };
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

describe("the ignore key", () => {
	test("i takes one Ticket out of the list, its counts, and the pile", async () => {
		const { state, src, props, runner } = rig();
		try {
			await withApp(
				async (setup) => {
					const before = await listed(setup, src);
					expect(headerRow(before)).toContain("open: 2");
					expect(headerRow(before)).not.toContain("ignored");
					// One key press, on the row the cursor holds. The commands the
					// runner had already recorded are the startup's repository read
					// and the observation's own polls: the key adds none of its own,
					// because the plane writes nothing to the source for an ignore.
					const commandsBefore = runner.commands().length;
					const frame = await press(
						setup,
						"i",
						"the row to leave the list",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && headerRow(f).includes("ignored: 1"),
					);
					// The row is gone, and the section's counts dropped it with it.
					expect(headerRow(frame)).toContain("open: 1");
					// The header names the pile the filter hides, so a missing row
					// reads as a filter, not as an idle factory.
					expect(headerRow(frame)).toContain("ignored: 1");
					// The Message line states the act in the plane's own words.
					expect(messageRowOf(frame)).toContain(
						`"${firstTitle}" is ignored: no row, no counts, no automatic start`,
					);
					// The ignore is the operator's own judgment, and the plane wrote
					// nothing to the source for it: no label, no close, no comment.
					// The only external command this frame ran is the observation's
					// own read-only agent list.
					// The only command the frame runs after the key is the
					// observation's own read-only agent list.
					expect(
						runner
							.commands()
							.slice(commandsBefore)
							.every((c) => c === "herdr agent list"),
					).toBe(true);
					// The flag is factory state on the state file, read back through
					// the file's own API, and the row's projection carries it.
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					expect(state.projectedTickets([], "implement")).toEqual([
						expect.objectContaining({
							identity: FIRST,
							ignored: true,
							ignoredAt: expect.any(String),
						}),
						expect.objectContaining({ identity: SECOND, ignored: false }),
					]);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the same key on an ignored row takes the Ticket back", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the ignore", (f) => headerRow(f).includes("ignored: 1"));
					// One keypress reveals the pile, and the row keeps its state badge
					// beside the marker of its own.
					const pile = await press(
						setup,
						"f",
						"the ignored view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					const row = rowsOf(pile)[listRowOf(pile, FIRST_LEAD)] ?? "";
					expect(row).toContain("[open]");
					expect(row).toContain("ignored");
					// The Action bar names the same key as the clear, the way the
					// queue pause flips between Pause and Resume.
					expect(actionBarRowOf(pile)).toContain("i Un-ignore");
					// The clear runs from the pile: the row leaves the ignored view,
					// and the header's cell drops with the last flag.
					const cleared = await press(
						setup,
						"i",
						"the clear",
						(f) => !headerRow(f).includes("ignored") && listRowOf(f, FIRST_LEAD) < 0,
					);
					expect(messageRowOf(cleared)).toContain(`"${firstTitle}" is not ignored`);
					expect(state.ignoredTickets().has(FIRST)).toBe(false);
					// Back on the active rows, the Ticket is listed again.
					const active = await press(
						setup,
						"f",
						"the active view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					expect(listRowOf(active, SECOND_LEAD)).toBeGreaterThanOrEqual(0);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("f cycles the filter through active, ignored, and all, and opens on active", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the ignore", (f) => headerRow(f).includes("ignored: 1"));
					// active: the ignored row is not listed, and the rest are.
					const active = await settle(setup);
					expect(listRowOf(active, FIRST_LEAD)).toBe(-1);
					expect(listRowOf(active, SECOND_LEAD)).toBeGreaterThanOrEqual(0);
					// ignored: only the pile.
					const pile = await press(
						setup,
						"f",
						"the ignored view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					// The pile holds the one row, and the header still names it.
					expect(
						rowsOf(pile).filter((r) => r.startsWith("│") && r.includes("ignored")),
					).toHaveLength(1);
					// all: the pile and the rest, in the list's own order.
					const every = await press(
						setup,
						"f",
						"the all view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) >= 0,
					);
					expect(headerRow(every)).toContain("ignored: 1");
					// And back to the active rows, with the header still naming the pile.
					await press(
						setup,
						"f",
						"the active view again",
						(f) => listRowOf(f, FIRST_LEAD) < 0 && headerRow(f).includes("ignored: 1"),
					);
					// A restart opens on the active rows and never on the pile: the
					// filter is a session view fact, and the file's own default read
					// is the active view.
					expect(state.visibleTickets([], "implement").map((ticket) => ticket.identity)).toEqual([
						SECOND,
					]);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0060, user stories 19 and 20: the machine's obligations do not bend
	 * around the operator's view. The section's counts and the held-count bell
	 * read the active view, so a cycle of `f` moves neither of them and rings
	 * nothing, in every filter state.
	 */
	test("cycling the filter moves no count and rings no bell", async () => {
		const state = openFactoryState(statePath());
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		// One held turn rests on the operator's decision, and one open Ticket is
		// judged out: the two facts the header carries beside the steady counts.
		const attempt = seedInFlightTurn(state, outcome, FIRST);
		state.settleTurn({
			ticketIdentity: FIRST,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: "the turn failed",
			turnLog: [{ kind: "text", text: "the turn failed" }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "failed",
		});
		expect(state.setTicketIgnored(SECOND, true, null).ok).toBe(true);
		const runner = emptyAgentRunner();
		const src = new FakeSource("issues", "github-issues", outcome);
		const bells = countBells();
		try {
			await withApp(
				async (setup) => {
					const active = await awaitFrame(
						setup,
						(f) =>
							headerRow(f).includes("awaiting: 1") && rowsOf(f).some((r) => r.includes("held")),
						"the held row",
					);
					expect(headerRow(active)).toContain("ignored: 1");
					expect(headerRow(active)).toContain("open: 0");
					// The boot's own rise rings; the cycle below must add nothing.
					const bellsAfterBoot = bells.count();
					for (const what of ["the pile", "every row", "the active rows"]) {
						const frame = await press(
							setup,
							"f",
							what,
							(f) => listRowOf(f, what === "every row" ? SECOND_LEAD : FIRST_LEAD) >= 0,
						);
						// The same counts in every view: the ignored row leaves the open
						// count, and the held turn is counted wherever the screen stands.
						expect(headerRow(frame)).toContain("open: 0");
						expect(headerRow(frame)).toContain("awaiting: 1");
						expect(headerRow(frame)).toContain("held: 1");
						expect(headerRow(frame)).toContain("ignored: 1");
						expect(bells.count()).toBe(bellsAfterBoot);
					}
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 60_000 },
			);
		} finally {
			bells.restore();
			state.close();
		}
	});

	test("the hint names the state the filter moves to, in both Ticket panes", async () => {
		const { state, src, props } = rig();
		// A frame wide enough to hold the section's whole ladder.
		const wide = 150;
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the ignore", (f) => headerRow(f).includes("ignored: 1"));
					expect(actionBarRowOf(await settle(setup))).toContain("f Show ignored");
					await press(setup, "f", "the pile", (f) => listRowOf(f, FIRST_LEAD) >= 0);
					expect(actionBarRowOf(await settle(setup))).toContain("f Show all");
					await press(setup, "f", "every row", (f) => listRowOf(f, SECOND_LEAD) >= 0);
					expect(actionBarRowOf(await settle(setup))).toContain("f Show active");
					// The detail pane's bar names the same key.
					setup.mockInput.pressKey("l");
					const detailed = await awaitFrame(
						setup,
						(f) => actionBarRowOf(f).includes("f Show"),
						"the detail bar to name the filter",
					);
					expect(actionBarRowOf(detailed)).toContain("f Show");
					// The cursor holds the ignored Ticket, so the same key's hint
					// reads the clear there.
					expect(actionBarRowOf(detailed)).toContain("i Un-ignore");
				},
				wide,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the cursor keeps its Ticket across the filter cycle", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					// The ignore moves the cursor onto the row that took the place.
					await press(setup, "i", "the ignore", (f) => detailPaneText(f).includes(secondTitle));
					// active to ignored: the second Ticket leaves the view, so the
					// cursor moves onto the row that stands.
					const pile = await press(
						setup,
						"f",
						"the pile",
						(f) => listRowOf(f, FIRST_LEAD) >= 0 && listRowOf(f, SECOND_LEAD) < 0,
					);
					expect(detailPaneText(pile)).toContain(firstTitle);
					// ignored to all: the pile's Ticket is still shown, so the cursor
					// keeps it - reading the pile does not lose the place.
					const every = await press(
						setup,
						"f",
						"the all view",
						(f) => listRowOf(f, SECOND_LEAD) >= 0 && detailPaneText(f).includes(firstTitle),
					);
					// The all view shows both rows, and the cursor kept the pile's one.
					expect(listRowOf(every, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
					// all to active: the pile's Ticket is gone, and the cursor takes a
					// row that stands.
					const back = await press(
						setup,
						"f",
						"the active view",
						(f) => listRowOf(f, FIRST_LEAD) < 0,
					);
					expect(detailPaneText(back)).toContain(secondTitle);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the empty active list points at the filter, not at an idle factory", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the first ignore", (f) => headerRow(f).includes("ignored: 1"));
					// The cursor took the row that stayed; one more press hides it too.
					const empty = await press(setup, "i", "the last row to hide", (f) =>
						rowsOf(f).some((r) => r.startsWith("│") && r.includes("no active Tickets")),
					);
					// A hidden pile is not an idle factory: the empty list names the
					// count it hides and the key that shows them.
					expect(empty).toContain("no active Tickets; 2 ignored - press f");
					expect(headerRow(empty)).toContain("ignored: 2");
					// The rows come back from the view that shows them, and the pile
					// names its own emptiness once the last flag clears.
					await press(setup, "f", "the pile", (f) => listRowOf(f, FIRST_LEAD) >= 0);
					await press(setup, "i", "the first un-ignore", (f) =>
						headerRow(f).includes("ignored: 1"),
					);
					const cleared = await press(setup, "i", "the second un-ignore", (f) =>
						rowsOf(f).some((r) => r.startsWith("│") && r.includes("no ignored Tickets")),
					);
					expect(cleared).toContain("no ignored Tickets - press f");
					// And the active view holds both rows again.
					const back = await press(
						setup,
						"f",
						"the active view",
						(f) => listRowOf(f, SECOND_LEAD) >= 0,
					);
					expect(listRowOf(back, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the detail pane names the ignore, its moment, and the key that clears it", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the ignore", (f) => headerRow(f).includes("ignored: 1"));
					const pile = await press(
						setup,
						"f",
						"the ignored view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					const detail = detailPaneText(pile);
					expect(detail).toContain("Ignored");
					expect(detail).toContain("no automatic start, and no row while the Ticket rests");
					expect(detail).toContain("press i to take this Ticket back");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the bar and the guide name the ignore in both Ticket panes", async () => {
		const { state, src, props } = rig();
		try {
			await withApp(
				async (setup) => {
					const frame = await listed(setup, src);
					expect(actionBarRowOf(frame)).toContain("i Ignore");
					// The detail pane's bar names it too.
					setup.mockInput.pressKey("l");
					await awaitFrame(
						setup,
						(f) => actionBarRowOf(f).includes("i Ignore"),
						"the detail bar to name the ignore",
					);
					// And the Key guide opened from the Ticket list holds both rows.
					setup.mockInput.pressKey("?");
					const guide = await awaitFrame(setup, (f) => f.includes("Key guide"), "the Key guide");
					expect(guide).toContain("hides the Ticket from the list and every automatic start");
					expect(guide).toContain("cycles the Ticket list: active, ignored, all");
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

describe("the obligation gate", () => {
	test("the key refuses an awaiting Ticket and states its reason", async () => {
		const state = openFactoryState(statePath());
		const outcome = success([issueTicket(FIRST)]);
		// A settled turn rests on the operator's decision: the row is the way to
		// the Decision modal, so the ignore cannot take it away.
		const attemptId = seedInFlightTurn(state, outcome);
		state.settleTurn({
			ticketIdentity: FIRST,
			handoffId: attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The turn is done.",
			turnLog: [{ kind: "text", text: "The turn is done." }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					const frame = await awaitFrame(
						setup,
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
						"the awaiting row",
					);
					expect(frame).toContain("[awaiting]");
					const refused = await press(setup, "i", "the refusal", (f) =>
						messageRowOf(f).includes("cannot be ignored"),
					);
					expect(messageRowOf(refused)).toContain(
						"the selected Ticket cannot be ignored: it awaits a decision",
					);
					// The refusal is a refusal: the flag never lands, and the row stays.
					expect(state.ignoredTickets().has(FIRST)).toBe(false);
					expect(listRowOf(refused, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
				},
				WIDTH,
				HEIGHT,
				{
					config: fixtureConfig(),
					state,
					sources: [src],
					runner: emptyAgentRunner(),
					pollIntervalMs: 60_000,
				},
			);
		} finally {
			state.close();
		}
	});

	test("the key refuses a missing Agent, and its row keeps the badge the choice lives on", async () => {
		const state = openFactoryState(statePath());
		const outcome = success([issueTicket(FIRST)]);
		seedInFlightTurn(state, outcome);
		const runner = emptyAgentRunner();
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					// The poll lists no Agent in the recorded pane: the row wears
					// `missing`, and the restart-or-abandon is the operator's choice.
					const frame = await awaitFrame(
						setup,
						(f) => rowsOf(f).some((r) => r.startsWith("│") && r.includes("missing")),
						"the missing badge",
					);
					expect(listRowOf(frame, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
					const refused = await press(setup, "i", "the refusal", (f) =>
						messageRowOf(f).includes("its Agent is missing"),
					);
					expect(messageRowOf(refused)).toContain(
						"the selected Ticket cannot be ignored: its Agent is missing",
					);
					expect(state.ignoredTickets().has(FIRST)).toBe(false);
					expect(refused).toContain("missing");
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 60_000 },
			);
		} finally {
			state.close();
		}
	});
});

describe("the ignore and the machine", () => {
	test("a live Agent keeps its seat, its row, and its badge under the ignored marker", async () => {
		const state = openFactoryState(statePath());
		const outcome = success([issueTicket(FIRST)]);
		seedInFlightTurn(state, outcome);
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
					// The live Agent holds a Parallel limit seat the row can be ignored over.
					expect(frame).toContain("auto: off 1/2");
					// The ignore ends where live work begins: the row stays in the active
					// view wearing its own badge beside the `ignored` marker, because the row
					// is how the operator reaches the Live view, the Goto, and the Close.
					const ignored = await press(setup, "i", "the ignore", (f) => {
						const row = rowsOf(f).find((r) => r.startsWith("│") && r.includes("[running]"));
						return row?.includes("ignored") === true;
					});
					expect(ignored).toContain("auto: off 1/2");
					expect(listRowOf(ignored, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
					// The header names the pile the flag made, and the active view still
					// holds the row: the count is the ledger, not a claim that the row is gone.
					expect(headerRow(ignored)).toContain("ignored: 1");
					expect(messageRowOf(ignored)).toContain(
						`"${firstTitle}" is ignored: no automatic start, and its row stays while its work is live`,
					);
					// The flag stands underneath the row, and the same key takes it back.
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					const taken = await press(setup, "i", "the un-ignore", (f) => {
						const row = rowsOf(f).find((r) => r.startsWith("│") && r.includes("[running]"));
						return row !== undefined && !row.includes("ignored");
					});
					expect(messageRowOf(taken)).toContain(
						`"${firstTitle}" is not ignored: the machine may start it again`,
					);
					expect(state.ignoredTickets().has(FIRST)).toBe(false);
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 60_000 },
			);
		} finally {
			state.close();
		}
	});

	test("the ignore removes a start that waits in the Work queue", async () => {
		// One seat, and the fixture Ticket's own Agent holds it: the start the
		// operator asked for waits in the Work queue for the seat, which is the
		// waiting item the ignore takes away with the row.
		const state = openFactoryState(statePath());
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
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
					const ignored = await press(setup, "i", "the start to leave the queue", (f) =>
						messageRowOf(f).includes("its waiting start left the Work queue"),
					);
					expect(messageRowOf(ignored)).toContain(
						`"${secondTitle}" is ignored; its waiting start left the Work queue`,
					);
					// The row is gone, the queue is empty, and the Ticket keeps its
					// open state: the cancel's stated semantics.
					expect(ignored).toContain("waiting: 0");
					expect(state.ticketState(SECOND)).toBe("open");
					expect(state.workQueue()).toEqual([]);
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

	test("a start the operator asks for after the ignore still runs", async () => {
		const { state, src, runner, props, config } = rig();
		const path = Object.values(config.repos)[0];
		stubHandoff(runner, path);
		runner.set("herdr", ["agent", "list"], { stdout: workingAgent() });
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the pile", (f) => headerRow(f).includes("ignored: 1"));
					const pile = await press(
						setup,
						"f",
						"the ignored view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					expect(detailPaneText(pile)).toContain(firstTitle);
					// The manual ask passes the ignore the way it passes the cap and
					// the Same-type hold: the ignore gates the machine, never the ask.
					await press(setup, "return", "the handoff to start", (f) => f.includes("handing off"));
					await awaitFrame(
						setup,
						(f) =>
							rowsOf(f).some((r) => r.startsWith("│") && r.includes("[handed-off]")) ||
							runner.commands().some((c) => c.startsWith("herdr agent start")),
						"the Agent start command",
					);
					expect(runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(true);
					expect(state.ticketState(FIRST)).toBe("handed-off");
					const frame = await settle(setup);
					// The Ticket the operator judged out is now live work, and the flag
					// stands under it: the pile still names it, and its row is back in the
					// active view because there is live work to reach (ADR 0060).
					expect(headerRow(frame)).toContain("ignored: 1");
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					expect(listRowOf(frame, FIRST_LEAD)).toBeGreaterThanOrEqual(0);
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	test("the Work queue's row names the ticket an ignore took from the list", async () => {
		// One seat, held by the second Ticket's own Agent, so the ignored
		// Ticket's asked-for start stays in the queue: the row must name its
		// ticket by title, not by the raw identity the list rule left behind.
		const state = openFactoryState(statePath());
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		seedInFlightTurn(state, outcome, SECOND);
		const runner = emptyAgentRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "pi",
					status: "working",
					name: agentNameFor(secondTitle),
				},
			]),
		});
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src, SECOND_LEAD);
					// The in-flight row leads the attention order, so the cursor crosses
					// to the open row first: that is the one the ignore can withhold.
					await press(setup, "j", "the open row", (f) => detailPaneText(f).includes(firstTitle));
					await press(setup, "i", "the pile", (f) => headerRow(f).includes("ignored: 1"));
					// The row left the active view, so the ask comes from the pile the
					// filter reveals: the ignore gates the machine, never the operator.
					await press(
						setup,
						"f",
						"the pile view",
						(f) => ticketRowHolds(f, FIRST_LEAD) && detailPaneText(f).includes(firstTitle),
					);
					await press(setup, "return", "the start to wait", (f) => f.includes("waiting: 1"));
					// Back to the active rows: the Ticket is nowhere in the list the
					// operator sees, and its waiting start is the queue's own row.
					await press(
						setup,
						"f",
						"every row",
						(f) => ticketRowHolds(f, FIRST_LEAD) && ticketRowHolds(f, SECOND_LEAD),
					);
					const frame = await press(
						setup,
						"f",
						"the active rows",
						(f) => !ticketRowHolds(f, FIRST_LEAD),
					);
					// A waiting start of an ignored Ticket names its ticket, and the
					// raw identity never shows as a fallback.
					expect(frame).toContain(firstTitle.slice(0, 9));
					expect(frame).not.toContain(FIRST);
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

	/**
	 * ADR 0042, ADR 0060: a Work queue row names the Ticket its start waits for,
	 * and so does the line its removal leaves. Both take the projection before the
	 * list rule, so an ignored Ticket that is nowhere in the Ticket list still
	 * names itself by title instead of falling back to the raw identity.
	 */
	test("the queue's cancel line names an ignored Ticket by title", async () => {
		// One seat, held by the second Ticket's own Agent: the ignored Ticket's
		// asked-for start waits in the queue, and its row is nowhere in the list.
		const state = openFactoryState(statePath());
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		seedInFlightTurn(state, outcome, SECOND);
		const runner = emptyAgentRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "pi",
					status: "working",
					name: agentNameFor(secondTitle),
				},
			]),
		});
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src, SECOND_LEAD);
					// The in-flight row leads the attention order, so the cursor crosses
					// to the open row the ignore can take out of the list.
					await press(setup, "j", "the open row", (f) => detailPaneText(f).includes(firstTitle));
					// The row and its ask, from the pile the ignore made.
					await press(setup, "i", "the pile", (f) => headerRow(f).includes("ignored: 1"));
					await press(
						setup,
						"f",
						"the pile view",
						(f) => ticketRowHolds(f, FIRST_LEAD) && detailPaneText(f).includes(firstTitle),
					);
					await press(setup, "return", "the start to wait", (f) => f.includes("waiting: 1"));
					// The queue's own jump: Enter on the piled row lands the cursor on the
					// item its ask made, where Delete removes it. The list rule withholds
					// the Ticket's own row from the active view, so the line has to name the
					// Ticket from the projection before the rule (ADR 0042, ADR 0060).
					await press(setup, "return", "the queue cursor", (f) => f.includes("┌─❯ Work queue"));
					const line = await press(setup, "delete", "the item removed", (f) =>
						messageRowOf(f).includes("was removed"),
					);
					expect(messageRowOf(line)).toContain(`the waiting start for "${firstTitle}" was removed`);
					expect(messageRowOf(line)).not.toContain(FIRST);
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

	test("an ignored Ticket is no Top-up candidate, and the un-ignore makes it one", async () => {
		const { state, src, props } = rig({ autoMode: true });
		expect(state.setTicketIgnored(FIRST, true, null).ok).toBe(true);
		expect(state.setTicketIgnored(SECOND, true, null).ok).toBe(true);
		try {
			await withApp(
				async (setup) => {
					src.settle(success(twoTickets()));
					const frame = await awaitFrame(
						setup,
						(f) => headerRow(f).includes("ignored: 2"),
						"the pile",
					);
					// Auto-handoff is on, the queue is empty, and two open Tickets
					// stand: the cycle asks for nothing, because both are judged out.
					await settle(setup, 500);
					expect(state.workQueue()).toEqual([]);
					expect(state.ticketState(FIRST)).toBe("open");
					// Take one back: its row returns to the active view the walks read.
					expect(state.setTicketIgnored(FIRST, false, null).ok).toBe(true);
					expect(listRowOf(frame, SECOND_LEAD)).toBe(-1);
					expect(state.visibleTickets([], "implement").map((ticket) => ticket.identity)).toEqual([
						FIRST,
					]);
				},
				WIDTH,
				HEIGHT,
				{ ...props, pollIntervalMs: 25 },
			);
		} finally {
			state.close();
		}
	});

	test("the flag survives a source that drops the item, and a second plane on the file", async () => {
		const { state, src, props } = rig();
		const path = state.path;
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src);
					await press(setup, "i", "the ignore", (f) => headerRow(f).includes("ignored: 1"));
					// The source drops the item: with no membership left to project,
					// the Ticket holds no row and no count - and the flag stays on
					// the identity in the file, because the ignore is never a
					// membership fact.
					await refreshed(
						setup,
						src,
						success([issueTicket(SECOND, { title: secondTitle, externalKey: "#6" })]),
					);
					const dropped = await awaitFrame(
						setup,
						(f) => headerRow(f).includes("open: 1") && !headerRow(f).includes("ignored"),
						"the source's drop",
					);
					expect(listRowOf(dropped, SECOND_LEAD)).toBeGreaterThanOrEqual(0);
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					// The item comes back: the flag follows the Ticket, not the
					// membership, and the row stays out of the active view.
					await refreshed(setup, src);
					const back = await awaitFrame(
						setup,
						(f) => headerRow(f).includes("ignored: 1"),
						"the item to return to the source",
					);
					expect(listRowOf(back, FIRST_LEAD)).toBe(-1);
					expect(headerRow(back)).toContain("open: 1");
				},
				WIDTH,
				HEIGHT,
				props,
			);
			// A second plane on the same state file reads the same flag: two planes
			// never disagree about one Ticket.
			const reopened = openFactoryState(path);
			const secondSrc = new FakeSource("issues", "github-issues", success(twoTickets()));
			try {
				expect(reopened.ignoredTickets().has(FIRST)).toBe(true);
				expect(reopened.visibleTickets([], "implement").map((ticket) => ticket.identity)).toEqual([
					SECOND,
				]);
				await withApp(
					async (setup) => {
						await listed(setup, secondSrc, SECOND_LEAD);
						const frame = await settle(setup);
						expect(headerRow(frame)).toContain("ignored: 1");
						expect(listRowOf(frame, FIRST_LEAD)).toBe(-1);
					},
					WIDTH,
					HEIGHT,
					{
						config: fixtureConfig(),
						state: reopened,
						sources: [secondSrc],
						runner: emptyAgentRunner(),
						pollIntervalMs: 60_000,
					},
				);
			} finally {
				reopened.close();
			}
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0060: the ignore ends where an obligation begins, and it is the row that
	 * returns, not a flag the plane clears. An ignored Ticket whose Agent goes
	 * missing keeps its row for the restart-or-abandon, keeps its flag, and takes
	 * no automatic Restart while the flag stands - the operator's own key is what
	 * puts the Ticket back in the machine's way.
	 */
	test("an ignored Ticket whose Agent goes missing keeps its row and its flag", async () => {
		const state = openFactoryState(statePath());
		const outcome = success([issueTicket(FIRST)]);
		seedInFlightTurn(state, outcome);
		// Auto mode from the boot: the Restart is the machine's own move, and the
		// flag is what has to hold it out, cycle after cycle.
		state.setAutoHandoffMode(true);
		const runner = emptyAgentRunner();
		// The Agent lives while the operator puts the running Ticket away, and
		// herdr stops listing it after.
		runner.set("herdr", ["agent", "list"], { stdout: workingAgent() });
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					src.settle(outcome);
					await awaitFrame(
						setup,
						(f) => rowsOf(f).some((r) => r.startsWith("│") && r.includes("[running]")),
						"the running badge",
					);
					await press(setup, "i", "the ignore", (f) => messageRowOf(f).includes("is ignored"));
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
					// The row keeps its badge and its marker, and no line says the flag
					// moved: the row never left, because its work was live.
					const gone = await awaitFrame(
						setup,
						(f) => rowsOf(f).some((r) => r.startsWith("│") && r.includes("missing")),
						"the missing badge",
					);
					expect(gone).toContain("ignored");
					expect(messageRowOf(gone)).not.toContain("no longer ignored");
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					expect(state.ticketObligation(FIRST, "missing")).toBe("missing");
					// The machine starts nothing on it by itself: auto mode is on, the
					// seat is free, and after a hundred cycles of the walk that would
					// otherwise have asked for the restart, the queue is still empty and
					// the flag still stands.
					await settle(setup, 500);
					expect(state.workQueue()).toEqual([]);
					expect(state.ignoredTickets().has(FIRST)).toBe(true);
					// The key that put the Ticket away is the key that puts it back: the
					// row offers Un-ignore beside its own badge, and the restart the flag
					// held out is the operator's own ask from here.
					expect(actionBarRowOf(gone)).toContain("i Un-ignore");
					expect(headerRow(gone)).toContain("running: 1");
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 25 },
			);
		} finally {
			state.close();
		}
	});
});

describe("the ignored marker's frame", () => {
	test("the no-color presentation keeps the ignored marker as a written word", async () => {
		process.env.NO_COLOR = "1";
		const { state, src, props } = rig();
		expect(state.setTicketIgnored(FIRST, true, null).ok).toBe(true);
		try {
			await withApp(
				async (setup) => {
					await listed(setup, src, SECOND_LEAD);
					const pile = await press(
						setup,
						"f",
						"the ignored view",
						(f) => listRowOf(f, FIRST_LEAD) >= 0,
					);
					const row = rowsOf(pile)[listRowOf(pile, FIRST_LEAD)] ?? "";
					// The fact is the written word, never a color alone.
					expect(row).toContain("ignored");
					expect(row).toContain("[open]");
					expect(headerRow(pile)).toContain("ignored: 1");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			// The worker's environment is shared with the files that run beside
			// this one: a NO_COLOR left behind paints their frames white.
			delete process.env.NO_COLOR;
			state.close();
		}
	});

	test("a narrow frame never hides the section's own name behind the ignored cell", async () => {
		const { state, src, props } = rig();
		expect(state.setTicketIgnored(FIRST, true, null).ok).toBe(true);
		try {
			await withApp(
				async (setup) => {
					setup.resize(62, HEIGHT);
					src.settle(success(twoTickets()));
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("ignored"),
						"the header's ignored cell",
					);
					const header = rowsOf(frame).find((r) => r.includes("Tickets")) ?? "";
					// The name leads, so a truncation never hides it.
					expect(header.indexOf("Tickets")).toBeLessThan(header.indexOf("ignored"));
					setup.resize(44, HEIGHT);
					const tiny = await awaitFrame(setup, (f) => f.includes("Tickets"), "the tiny frame");
					const tinyHeader = rowsOf(tiny).find((r) => r.includes("Tickets")) ?? "";
					expect(tinyHeader).toContain("Tickets");
				},
				WIDTH,
				HEIGHT,
				props,
			);
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0042, ADR 0060: a Ticket the operator put away can also be a Ticket the
	 * covered rule takes out of the list - the fixing pull request appears on a
	 * later refresh, after the ignore. The pile is the ledger of the operator's own
	 * act, so the row stands there and nowhere else, and `f` is the only way to
	 * reach the key that puts it back.
	 */
	test("the pile reaches a Ticket the covered rule also hides", async () => {
		const state = openFactoryState(statePath());
		const pull = (closes: boolean): FetchedTicket => ({
			identity: "github:github.com:P_9",
			sourceKind: "github-pull-request",
			externalKey: "#9",
			sourceState: "open",
			url: "https://github.com/acme/factory/pull/9",
			title: "Add the retry policy",
			description: "The implementation of #5.",
			labels: [],
			externalUpdatedAt: "2026-08-31T12:00:00Z",
			repository: {
				identity: repoIdentity,
				displayName: "acme/factory",
				cloneUrl: `https://${repoIdentity}.git`,
			},
			attributes: closes
				? withIssueReferences({}, [{ identity: null, number: 5, repository: "acme/factory" }])
				: {},
		});
		const withPull = success([...twoTickets(), pull(true)]);
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, success(twoTickets()));
		// The ignore lands first, while the Ticket is only ignored.
		expect(state.setTicketIgnored(FIRST, true, null).ok).toBe(true);
		const runner = emptyAgentRunner();
		const src = new FakeSource("issues", "github-issues", success(twoTickets()));
		try {
			await withApp(
				async (setup) => {
					// The ignore stands before the boot, so the first frame shows the
					// row that stayed.
					await listed(setup, src, SECOND_LEAD);
					// The fixing pull request appears on the next refresh: the covered rule
					// now hides the same row the ignore hides.
					await settle(setup, 1_000);
					await refreshed(setup, src, withPull);
					const active = await awaitFrame(
						setup,
						(f) => ticketRowHolds(f, SECOND_LEAD) && !ticketRowHolds(f, FIRST_LEAD),
						"the covered row to leave the active view",
					);
					// Neither the drawn rows nor the count shows it, and the header still
					// names the pile the flag made.
					expect(headerRow(active)).toContain("ignored: 1");
					// `f` reaches the row: the pile holds what no other view shows.
					const pile = await press(setup, "f", "the pile", (f) => ticketRowHolds(f, FIRST_LEAD));
					expect(pile).toContain("ignored");
					expect(detailPaneText(pile)).toContain(firstTitle);
					expect(actionBarRowOf(pile)).toContain("i Un-ignore");
					// And `all` does not show it: the covered rule still holds the list.
					await press(setup, "f", "every row", (f) => ticketRowHolds(f, SECOND_LEAD));
					const every = await settle(setup);
					expect(ticketRowHolds(every, FIRST_LEAD)).toBe(false);
					expect(headerRow(every)).toContain("ignored: 1");
					// The same key on that piled row takes the Ticket back, and the row
					// returns to standing under the covered rule alone. The cycle runs
					// active, ignored, all, so two presses walk from `all` back to the pile.
					await press(setup, "f", "the active rows", (f) => !ticketRowHolds(f, FIRST_LEAD));
					await press(setup, "f", "the pile again", (f) => ticketRowHolds(f, FIRST_LEAD));
					const cleared = await press(setup, "i", "the clear", (f) =>
						messageRowOf(f).includes("is not ignored"),
					);
					expect(headerRow(cleared)).not.toContain("ignored:");
					expect(state.ignoredTickets().has(FIRST)).toBe(false);
				},
				WIDTH,
				HEIGHT,
				{ config: fixtureConfig(), state, sources: [src], runner, pollIntervalMs: 60_000 },
			);
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0060, user story 19: the held count and the bell that rings on it are
	 * the machine's own facts, and the ignored count is the operator's view of a
	 * pile. On a row too short for both conditional cells, the view fact is the
	 * one that goes. The bell's own flash lasts one moment in the running app, so
	 * `test/section-header.test.ts` measures it at the component seam; the held
	 * cell is a steady fact, and this measures it where the operator reads it.
	 */
	test("a narrow frame cuts the ignored cell before the held count", async () => {
		const state = openFactoryState(statePath());
		const outcome = success(twoTickets());
		state.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		// One held turn rests on the operator's decision, and one open Ticket is
		// judged out of the list: the two conditional cells, side by side.
		const attempt = seedInFlightTurn(state, outcome, FIRST);
		state.settleTurn({
			ticketIdentity: FIRST,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: "the turn failed",
			turnLog: [{ kind: "text", text: "the turn failed" }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "failed",
		});
		expect(state.setTicketIgnored(SECOND, true, null).ok).toBe(true);
		const src = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					// Wide enough for both: the row names the held turn and the pile.
					setup.resize(72, HEIGHT);
					src.settle(outcome);
					const wide = await awaitFrame(
						setup,
						(f) => headerRow(f).includes("held") && headerRow(f).includes("ignored"),
						"the header's two conditional cells",
					);
					expect(headerRow(wide)).toContain("held: 1");
					expect(headerRow(wide)).toContain("ignored: 1");
					// A row that cannot hold both spends its last cells on the machine's
					// fact: the held count stands and the ignored count is cut.
					setup.resize(56, HEIGHT);
					const narrow = await awaitFrame(
						setup,
						(f) => headerRow(f).includes("held") && !headerRow(f).includes("ignored"),
						"the cut that drops the ignored cell",
					);
					expect(headerRow(narrow)).toContain("Tickets");
					expect(headerRow(narrow)).toContain("held");
					expect(headerRow(narrow)).not.toContain("ignored");
				},
				WIDTH,
				HEIGHT,
				{
					config: fixtureConfig(),
					state,
					sources: [src],
					runner: emptyAgentRunner(),
					pollIntervalMs: 60_000,
				},
			);
		} finally {
			state.close();
		}
	});
});
