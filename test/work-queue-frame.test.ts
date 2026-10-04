/**
 * The Work queue's frame tests (ADR 0049): the section stands on the Main
 * view whatever the queue holds, its rows carry the origin and the ticket's
 * title, + and - move the selected item, Delete cancels the start under the
 * cursor, and the emptied section keeps its header with its count.
 *
 * The tests boot the real app against a temporary state with a FakeSource,
 * and they seed the queue straight into the state the way a refused manual
 * start leaves it. No test starts an Agent: a queue item is a start waiting
 * to run, and these frames verify the waiting, not the running.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config.ts";
import { baseChoice } from "../src/handoff.ts";
import type { Logger } from "../src/logging.ts";
import type { CommandRunner } from "../src/runner.ts";
import { workQueueIdentityOf } from "../src/state/work-queue.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import {
	actionBarRowOf,
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
import { recordLogger } from "./record-logger.ts";
import {
	DEFAULT_AGENT_NAME,
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
	// Hold the flat axis: the frames read the unsplit list (ADR 0066).
	state.grouping.setGroupingAxis("tickets", "none");
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
				agent: DEFAULT_AGENT_NAME,
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
	const enqueue = (
		ticketIdentity: string,
		origin: "open" | "workflow" | "restart" = "open",
		automatic = false,
	) => {
		const result = state.workQueue.enqueueWork({
			ticketIdentity,
			origin,
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "",
			automatic,
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

/**
 * One state with the queue the test enqueues, plus the source that settles it.
 *
 * The one seat is held from boot: a durable claim on the second ticket keeps
 * the free-seat figure at zero, so the observation's pickup never runs and
 * the frame the test reads is the resting one. A test that claims the
 * second ticket itself boots with the seat free.
 */
function queuedFixture(state: FactoryState, holdSeat = true) {
	const tickets = twoTickets();
	const source = new FakeSource("issues", "github-issues", success(tickets));
	const enqueue = (
		ticketIdentity: string,
		origin: "open" | "workflow" | "restart" = "open",
		automatic = false,
	) => {
		const result = state.workQueue.enqueueWork({
			ticketIdentity,
			origin,
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "",
			automatic,
		});
		if (!result.ok) throw new Error(result.reason);
	};
	const runner: CommandRunner = emptyAgentRunner();
	if (holdSeat) {
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, success(tickets));
		const held = state.handoff.claimHandoff(
			SECOND,
			baseChoice("pi", "live-worktree", "implement"),
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
	}
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
	logger?: Logger,
): Promise<void> =>
	withApp(body, WIDTH, 34, {
		state,
		config: zeroSeatConfig,
		home,
		runner,
		sources: [source],
		...(logger === undefined ? {} : { logger }),
	});

/** The terminal row of the Work section's header, or -1 while it is hidden. */
const workHeaderRow = (frame: string): number =>
	rowsOf(frame).findIndex((row) => /\bWork\b/.test(row));

type AppSetup = Parameters<Parameters<typeof withApp>[0]>[0];

// ADR 0049: the Work section is always visible and starts expanded, so the
// old click-the-header-to-expand helper now lands the cursor on the first
// queue row instead, where the queue's keys and the detail act on it.
async function clickWorkHeader(setup: AppSetup): Promise<void> {
	// The click lands on the first queue row inside the Work queue's own box:
	// the Ticket rows lead with the same origin-looking state badges, so the
	// walk starts below the queue's top border, not at the frame's first
	// match.
	const rows = rowsOf(stripAnsi(setup.captureCharFrame()));
	const boxTop = rows.findIndex((row) => row.includes("Work queue"));
	expect(boxTop).toBeGreaterThanOrEqual(0);
	const row = rows.slice(boxTop + 1).findIndex((row) => /\[(open|workflow|restart)\]\s+/.test(row));
	expect(row).toBeGreaterThanOrEqual(0);
	await mouseClick(setup, 2, boxTop + 1 + row);
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

/** The queue's own rows, by origin lead, for the before-and-after compares. */
const queueRowsOf = (frame: string): string[] =>
	rowsOf(stripAnsi(frame)).filter((row) => /\[(open|workflow|restart)\]\s+/.test(row));

/** The queue rows lead with their origin, padded to a fixed width. */
const openRowLead = /\[open\]\s+Add a webhook retry policy/;
const workflowRowLead = /\[workflow\]\s+Close the stale deploy branch/;

describe("the Work queue section", () => {
	/**
	 * ADR 0051: the queue holds two kinds of waiting start, and the origin word
	 * alone cannot tell them apart - the operator's route and the factory's
	 * continuation are both `workflow`. The detail names whose start the row
	 * is, so the depth the header carries reads as the operator's queue with
	 * the factory's adds marked where they stand.
	 */
	test("the detail says whose start a waiting row is", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST, "workflow", true);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => f.includes("waiting: 2"), "the Work header");
					await clickWorkHeader(setup);
					// The top-up's item, first in the queue: the detail says the
					// factory asked, and names the origin it waits on.
					const automaticFrame = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Origin: workflow"),
						"the first item's detail",
					);
					expect(detailPaneText(automaticFrame)).toContain("Asked by: the factory's auto top-up");
					// The operator's own row reads the other way. The shared
					// cursor walks to it with the list's own key.
					await press(setup, "j", "the second item", (f) =>
						detailPaneText(f).includes("Asked by: the operator"),
					);
					expect(detailPaneText(setup.captureCharFrame())).toContain("Origin: workflow");
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
	 * ADR 0052: the pause is durable factory state, and the write that refuses
	 * is an operation fact the operator must hear. The `p` key reports the
	 * refused write on the Message line and leaves the pause where it stood,
	 * the way the Auto-handoff mode's toggle reports its own failure - two
	 * facts of one kind must not fail two ways.
	 */
	test("p reports a state file that will not take the write, and moves nothing", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					await clickWorkHeader(setup);
					// The state file refuses every write, the way a read-only
					// volume or a full disk does.
					const pauseSpy = spyOn(state.workQueue, "setQueuePaused").mockImplementation(() => {
						throw new Error("cannot store the queue pause: read-only file system");
					});
					const refused = await press(setup, "p", "the refused write", (f) =>
						messageRowOf(f).includes("the queue pause did not move"),
					);
					expect(messageRowOf(refused)).toContain("read-only file system");
					// The key reached the write and the write refused it.
					expect(pauseSpy).toHaveBeenCalledWith(true);
					// The pause stands where it was: the header carries no pause
					// fact, and the state file holds none either.
					expect(frameText(refused)).not.toContain("paused");
					expect(state.workQueue.queuePaused()).toBe(false);
					pauseSpy.mockRestore();
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	test("p pauses the queue's drain, and p again resumes it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					// The header carries no pause fact while the drain runs.
					const resting = await settle(setup);
					expect(frameText(resting)).toContain("waiting: 1");
					expect(frameText(resting)).not.toContain("paused");
					// The cursor lands on the queue row, and p stands by its keys.
					await clickWorkHeader(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("┌─❯ Work queue"),
						"the cursor on the queue row",
					);
					// The bar offers the pause while the queue holds a waiting row.
					expect(actionBarRowOf(setup.captureCharFrame())).toContain("p Pause queue");
					// p stands the pause: the header carries the fact and the line
					// says what happened. The bar's own label flip (Pause queue to
					// Resume queue) is measured where the bar reads the context: in
					// the catalogue test for the queue-pause control.
					const paused = await press(setup, "p", "the queue pause", (f) =>
						messageRowOf(f).includes("Work queue paused"),
					);
					// The pause fact stands by its count on the header's own row, in
					// the raw frame: the two spaces are the header's own padding.
					expect(paused).toContain("waiting: 1  paused");
					expect(messageRowOf(paused)).toContain("Work queue paused");
					// p again resumes: the fact leaves the header and the line
					// says so.
					const resumed = await press(setup, "p", "the queue resume", (f) =>
						messageRowOf(f).includes("Work queue resumed"),
					);
					expect(frameText(resumed)).toContain("waiting: 1");
					expect(frameText(resumed)).not.toContain("paused");
					// The pause was the file's own fact while it stood, and the
					// resume wrote the off back: the store reads it either way.
					expect(state.workQueue.queuePaused()).toBe(false);
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
	 * The pause in the plane's record (issue #223). The pause and the mode are the
	 * two facts the operator sets by key, and they decide every automatic walk in
	 * the run; until now neither left a line anywhere, so a reviewer could not tell
	 * a held run from a broken one.
	 */
	test("p and its resume each leave one line in the record", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		const lines: string[] = [];
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					await clickWorkHeader(setup);
					await press(setup, "p", "the queue pause", (f) =>
						messageRowOf(f).includes("Work queue paused"),
					);
					await press(setup, "p", "the queue resume", (f) =>
						messageRowOf(f).includes("Work queue resumed"),
					);
					// One line per key, in the order the keys landed. The `queue:` prefix is the
					// record's family for the facts the operator sets by key. The cycle's own
					// record lines - the holds its automatic walks state - are the other family
					// the same logger carries, and they are not this fact's lines.
					expect(lines.filter((line) => line.startsWith("queue:"))).toEqual([
						"queue: the Work queue is paused",
						"queue: the Work queue resumed",
					]);
				},
				state,
				source,
				runner,
				recordLogger(lines),
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The notice's rank, decided (ADR 0052).
	 *
	 * `p` answers with a notice, not a warning: a control that ran has nothing
	 * to warn about. A notice holds its own slot below the fact an operation
	 * wrote, so a `p` press that lands while a refusal still stands on the
	 * line leaves that refusal readable, and the pause is still readable on
	 * the header. This is the walk that makes the ranking a decided fact and
	 * not an accident of the slot order.
	 */
	test("p behind a standing warning keeps the warning on the line and the pause on the header", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					await clickWorkHeader(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("┌─❯ Work queue"),
						"the cursor on the queue row",
					);
					// An operation writes its refusal on the line, and it stands:
					// this config ships no Consultation type, so the launch key
					// refuses and says why.
					await press(setup, "c", "the refusal on the line", (f) =>
						messageRowOf(f).startsWith("Warning:"),
					);
					const beforePause = setup.captureCharFrame();
					expect(messageRowOf(beforePause)).toContain("no Consultation types configured");
					// The pause's notice lands behind it, so the line keeps the
					// refusal, and the header carries the pause the line cannot show.
					setup.mockInput.pressKey("p");
					await awaitFrame(
						setup,
						(f) => f.includes("waiting: 1  paused"),
						"the pause on the header",
					);
					const paused = setup.captureCharFrame();
					expect(messageRowOf(paused)).toBe(messageRowOf(beforePause));
					expect(messageRowOf(paused)).not.toContain("Work queue paused");
					expect(state.workQueue.queuePaused()).toBe(true);
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
	 * Story 10 (ADR 0049): the Work section starts expanded and collapses
	 * with `x` like the other two. The collapsed header keeps its count: the
	 * section is always on the Main view, and only its list leaves.
	 */
	test("x collapses the Work section, and the header keeps its count", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					// The cursor is on the queue row, and the list stands.
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("┌─❯ Work queue"), "the queue cursor");
					// `x` collapses the section: the header's arrow turns, the list
					// leaves, and the header keeps its count on the frame.
					const collapsed = await press(setup, "x", "the Work section to collapse", (f) =>
						f.includes("▸ Work"),
					);
					expect(collapsed).toContain("waiting: 1");
					expect(queueRowIndex(collapsed, openRowLead)).toBe(-1);
					// The cursor left with the list: the cross now walks the two
					// standing sections, and `x` again brings the queue back.
					const expanded = await press(
						setup,
						"x",
						"the Work section to expand",
						(f) => queueRowIndex(f, openRowLead) >= 0,
					);
					expect(expanded).toContain("▾ Work");
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
	 * Story 12 (ADR 0050): the retired priority keys answer nothing. `u` is
	 * no longer a ControlKey at all, so a stray press is silent in every
	 * mode: no dispatch, no Message line, no queue movement.
	 */
	test("a stray u press is silent in the queue and in the Ticket list", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		enqueue(SECOND, "workflow");
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => queueRowIndex(f, openRowLead) >= 0, "the queued start");
					await clickWorkHeader(setup);
					const before = await settle(setup);
					// In the queue list: the press leaves the rows, the order, and
					// the Message line as they stood.
					const pressed = await press(setup, "u", "the retired key to do nothing", (f) =>
						f.includes("waiting: 2"),
					);
					expect(pressed).toContain("waiting: 2");
					expect(queueRowsOf(pressed)).toEqual(queueRowsOf(before));
					expect(messageRowOf(pressed)).toBe(messageRowOf(before));
				},
				state,
				source,
				runner,
			);
		} finally {
			state.close();
		}
	});

	test("an idle factory keeps the three-section frame", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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

	/**
	 * ADR 0049: the Work section keeps its header row while it is empty, exactly
	 * as the other two sections do, and the cursor is no exception: the empty
	 * message is the row the cursor rests on. The cross from the last
	 * Consultation into an empty queue stays there - the focus marker holds on
	 * the queue's box in the settled frame - and the detail says that no item
	 * is selected.
	 */
	test("the cursor crosses into the empty Work queue, and the focus stays", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, runner } = queuedFixture(state);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => f.includes("waiting: 0"), "the empty queue's header");
					// The walk down: the last Ticket row, the empty Consultation
					// list, and the empty Work queue, one step each.
					await press(setup, "j", "the last Ticket row", (f) =>
						detailPaneText(f).includes("Close the stale deploy branch"),
					);
					await press(setup, "j", "the empty Consultation list", (f) =>
						f.includes("┌─❯ Consultations"),
					);
					await press(setup, "j", "the empty Work queue", (f) => f.includes("┌─❯ Work queue"));
					// The focus holds: the settled frame still marks the queue's
					// box, and the detail answers for the empty selection.
					const settled = await settle(setup);
					expect(settled).toContain("┌─❯ Work queue");
					expect(detailPaneText(settled)).toContain("no queue item is selected");
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
	 * The cursor never rests on a queue that no longer holds its row: the
	 * operator's Delete cancels the one waiting start, the queue empties under
	 * the cursor, and the selection comes home to the Ticket list, where the
	 * cursor's box keeps the marker.
	 */
	test("a Delete that empties the queue sends the selection home", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state);
		enqueue(FIRST);
		try {
			await booted(
				async (setup) => {
					source.settle(success(twoTickets()));
					await awaitFrame(setup, (f) => f.includes("waiting: 1"), "the queue's wait");
					await clickWorkHeader(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("┌─❯ Work queue"),
						"the cursor on the queue row",
					);
					// Delete cancels the one waiting start: the queue empties
					// under the cursor, and the selection comes home.
					await press(setup, "delete", "the one start to cancel", (f) =>
						f.includes(`waiting start for "Add a webhook retry policy"`),
					);
					const settled = await settle(setup);
					expect(settled).toContain("┌─❯ Tickets");
					expect(settled).not.toContain("┌─❯ Work queue");
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, enqueue, runner } = queuedFixture(state, false);
		// Seed the tickets into the state before the app boots, then hold the
		// one seat with this test's own durable claim for the second ticket.
		// The claim keeps the free-seat figure at zero, so the observation's
		// pickup never runs and the Waiting badge the test reads is the resting
		// one.
		const outcome = success(twoTickets());
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, outcome);
		const held = state.handoff.claimHandoff(
			SECOND,
			baseChoice("pi", "live-worktree", "implement"),
			"open",
		);
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

	/**
	 * The Queue wait of a route (ADR 0064, ADR 0072): the ask ends the
	 * source's cycle on its own write, and the wait is the position's own
	 * fact: the item the ask enqueues names its position, and the position's
	 * row wears the `queued` badge in the state badge's place, the way the
	 * open ticket's waiting start already does.
	 */
	test("the route's wait wears the queued badge on the position's row (ADR 0072)", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, runner } = queuedFixture(state, false);
		const outcome = success(twoTickets());
		// The first ticket's turn settles and routes to the second's position:
		// the decision records at the ask and ends the source's cycle in the
		// same write, so the source rests open. The second ticket's own
		// durable claim holds the factory's one seat, so the route waits.
		const attemptId = seedAwaitingTurn(state, outcome, FIRST);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: FIRST,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		const held = state.handoff.claimHandoff(
			SECOND,
			baseChoice("pi", "live-worktree", "implement"),
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
		const enqueued = state.workQueue.enqueueWork({
			ticketIdentity: SECOND,
			routeFromIdentity: FIRST,
			origin: "workflow",
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "the turn is done",
		});
		if (!enqueued.ok) throw new Error(enqueued.reason);
		try {
			await booted(
				async (setup) => {
					source.settle(outcome);
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 1"),
						"the queue's wait",
					);
					const rows = rowsOf(stripAnsi(frame));
					// The source rests open behind the wait: its row wears the
					// open badge, and no awaiting stands.
					const settledRow = rows.find((row) => row.includes("Add a webhook retry policy"));
					expect(settledRow).toContain("[open]");
					// The wait is the position's own fact: its row wears the
					// queued badge in the state badge's place.
					const positionRow = rows.find((row) => row.includes("Close the stale"));
					expect(positionRow).toContain("[queued]");
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
	 * ADR 0072: the cycle already ended at the ask, so the operator's Delete
	 * on a route item takes the item and marks the route on the turn's trace,
	 * the way the re-fired skip marks its trace. The row leaves the queue, and
	 * the `[queued]` badge the position's row wore leaves in the same frame
	 * the item leaves, while the source keeps the open state the ask left
	 * and the decision the ask recorded.
	 */
	test("Delete on the route item takes the item and marks the turn (ADR 0072)", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
		const { source, runner } = queuedFixture(state, false);
		const outcome = success(twoTickets());
		// The first ticket's turn settles and routes to the second's position:
		// the decision records at the ask and ends the source's cycle in the
		// same write, and the second ticket's durable claim holds the one
		// seat, so the route's item waits in the queue. The settled turn's
		// transition carries the route the ask decides, which the Delete's
		// mark lands on.
		const attemptId = seedAwaitingTurn(state, outcome, FIRST, {
			fired: true,
			when: null,
			reason: "",
			ticketFacts: [],
			pullRequestFacts: [],
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: "implement",
			positionTicketIdentity: SECOND,
		});
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: FIRST,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		const held = state.handoff.claimHandoff(
			SECOND,
			baseChoice("pi", "live-worktree", "implement"),
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
		const enqueued = state.workQueue.enqueueWork({
			ticketIdentity: SECOND,
			routeFromIdentity: FIRST,
			origin: "workflow",
			choice: baseChoice("pi", "live-worktree", "implement"),
			previousMessage: "the turn is done",
		});
		if (!enqueued.ok) throw new Error(enqueued.reason);
		try {
			await booted(
				async (setup) => {
					source.settle(outcome);
					const waiting = await awaitFrame(
						setup,
						(f) => f.includes("Work") && f.includes("waiting: 1"),
						"the queue's wait",
					);
					// The position's row stands with the queued badge while the
					// route waits, and the source rests open behind it.
					expect(frameText(waiting)).toContain("[queued]");
					// The operator's Delete takes the route's item.
					await clickWorkHeader(setup);
					await awaitFrame(setup, (f) => f.includes("▾ Work"), "the expanded Work section");
					await press(setup, "delete", "the route item to cancel", (f) =>
						f.includes(`waiting start for "Close the stale deploy branch"`),
					);
					const after = await settle(setup);
					// The ticket's row rests open with the state badge again, and
					// the queue stands empty behind it.
					const row = rowsOf(stripAnsi(after)).find(
						(candidate) =>
							candidate.includes("Add a webhook") && /\[(open|queued)\]/.test(candidate),
					);
					expect(row).toContain("[open]");
					expect(frameText(after)).not.toContain("[queued]");
					// The cycle ended once at the ask, the decision stands where
					// the ask put it, and the removal's mark stands on the trace.
					const ticket = state.ticketWorkCycle
						.ticketListViews([], "implement")
						.rows.find((candidate) => candidate.identity === FIRST);
					expect(ticket?.state).toBe("open");
					expect(ticket?.workCycle).toBe(2);
					expect(state.ticketWorkCycle.lastCompletion(FIRST)?.decision).toBe("handed-off");
					expect(state.ticketWorkCycle.lastCompletion(FIRST)?.transition?.routeRemoved).toBe(true);
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
					// In the list `f` is a filter key of two sections - the Ticket
					// section's List filter and the Consultation section's history - and
					// the queue owns neither, so it refuses the key in the two owners'
					// words (ADR 0060): the refusal moves nothing, and the queue keeps
					// its rows and its depth.
					let refusal = await press(setup, "f", "the filter refusal in the queue list", (f) =>
						messageRowOf(f).includes("only in the Ticket section and the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain(
						"only in the Ticket section and the Consultation section",
					);
					expect(queueRows(refusal)).toEqual(queueRows(before));
					expect(markerRowOf(refusal)).toBe(markerRowOf(list));
					expect(detailPaneText(refusal)).toContain("place 1 of 2");
					// The detail pane: ADR 0049 retired the queue's own `d` reorder
					// key, so the Consultation's Delete resolves and refuses, and the
					// detail keeps the item under its cursor.
					setup.mockInput.pressKey("l");
					const detail = await awaitFrame(
						setup,
						(f) => f.includes("❯ Work queue") === false && f.includes("Origin: open"),
						"the Work queue detail pane",
					);
					// The first press puts the Consultation refusal on the Message
					// line, so the line the queue's own `f` refusal left stands aside
					// before the pane is compared: the frame the key writes is measured
					// against the frame the same line already held.
					await press(setup, "d", "the delete refusal in the queue detail", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					const detailBefore = await settle(setup);
					refusal = await press(setup, "d", "the delete refusal again in the queue detail", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					expect(queueRows(refusal)).toEqual(queueRows(detail));
					expect(detailPaneText(refusal)).toBe(detailPaneText(detailBefore));
					// The queue still holds both starts at the same depth.
					expect(frameText(refusal)).toContain("waiting: 2");
				},
				state,
				source,
				runner,
			);
			expect(state.workQueue.items().length).toBe(2);
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
					expect(state.workQueue.removeWorkItem(FIRST)).toBe(true);
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
					expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([SECOND]);
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: "review",
			positionTicketIdentity: FIRST,
		});
		const held = state.handoff.claimHandoff(
			SECOND,
			{ ...baseChoice("pi", "live-worktree", "implement") },
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
		state.handoff.settleHandoff(held.claim.attemptId, true, undefined, {
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
					// The item carries the route's origin and the edge's resolved
					// choice, and the ask ends the ticket's cycle in the same
					// write (ADR 0072): open behind the item it waits on.
					const items = state.workQueue.items();
					expect(items.map(workQueueIdentityOf)).toEqual([FIRST]);
					if (items[0]?.kind !== "handoff") throw new Error("the waiting item is not a handoff");
					expect(items[0].origin).toBe("workflow");
					expect(items[0].choice.taskType).toBe("review");
					expect(state.ticketWorkCycle.ticketState(FIRST)).toBe("open");
					// The decision records at the ask (ADR 0064): the routed
					// handoff records its handed-off decision the moment it takes
					// the queue, not when a seat frees it.
					expect(state.ticketWorkCycle.lastCompletion(FIRST)?.decision).toBe("handed-off");
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
				expect(setup.captureCharFrame()).toContain("● manual 1/1");
				const frame = await press(setup, "return", "the force-dispatch message", (f) =>
					f.includes("force-dispatched"),
				);
				// The Message line names the start over the cap, and the seat count
				// stands over the limit: the held seat plus the new one.
				expect(messageRowOf(frame)).toContain(
					`force-dispatched "Close the stale deploy branch" over the Parallel limit`,
				);
				expect(frame).toContain("● manual 2/1");
				// The item left the queue with the settle, the ticket holds the
				// handoff, and the start ran the real external steps on the item's
				// own captured choice.
				expect(fixture.state.workQueue.items()).toHaveLength(0);
				expect(fixture.state.ticketWorkCycle.ticketState(FORCED)).toBe("handed-off");
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
				expect(fixture.state.workQueue.items()).toHaveLength(0);
				expect(fixture.state.ticketWorkCycle.ticketState(FORCED)).toBe("open");
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
				expect(fixture.state.workQueue.items()).toHaveLength(0);
				expect(fixture.state.ticketWorkCycle.ticketState(HELD)).not.toBe("open");
			});
		} finally {
			fixture.state.close();
		}
	});

	test("the emptied section keeps its header with its count, and down crosses into it while it stands", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
		// Hold the flat axis: the frames read the unsplit list (ADR 0066).
		state.grouping.setGroupingAxis("tickets", "none");
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
