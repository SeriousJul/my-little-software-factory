/**
 * The merged Main view: one surface, two sections, one shared detail pane.
 *
 * These frame tests hold the product decisions of ADR 0019 (which supersedes
 * the one-expanded-section layout of ADR 0013): both the Ticket and the
 * Consultation section are visible at the same time, each with its own
 * header row and list box, and one detail pane on the right answers for the
 * section under the cursor. `x` collapses the section the cursor is in, or
 * expands it back on its retained row; a step past a section's last visible
 * row crosses the boundary into the other section. The Ticket header carries
 * the steady counts, the Consultation header the Consultation facts, and one
 * Message line, one Action bar, and one control catalog answer for both.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { TicketSource } from "../src/ticket-source.ts";
import {
	actionBarRowOf,
	awaitFrame,
	crossToConsultations,
	crossToTickets,
	detailPaneText,
	focusDetail,
	markerRowOf,
	messageRowOf,
	mouseClick,
	overlayRows,
	press,
	pressScrollKey,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { emptyAgentRunner, FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

let home = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-main-view-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const config: FactoryConfig = {
	...BASE_CONFIG,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
	consultationTypes: {
		grill: { agent: "pi", environment: "worktree", template: "/grill {input}" },
	},
};

/** The source outcome that carries the sample Ticket facts. */
const sampleOutcome = () => ({
	status: "success" as const,
	fetchedAt: "2026-09-01T10:00:00.000Z",
	tickets: SAMPLE_TICKETS.map((ticket) => ({
		identity: ticket.identity,
		sourceKind: ticket.sourceKind,
		externalKey: ticket.externalKey,
		sourceState: ticket.sourceState,
		url: ticket.url,
		title: ticket.title,
		description: ticket.description,
		labels: ticket.labels,
		externalUpdatedAt: ticket.externalUpdatedAt,
		repository: ticket.repositoryRef,
		attributes: {},
	})),
});

function seedConsultation(
	state: FactoryState,
	id: string,
	createdAt = "2026-09-01T10:00:00.000Z",
): void {
	state.createConsultation({
		id,
		typeName: "grill",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		contextWindow: "",
		template: "/grill {input}",
		initialInput: "review the design",
		renderedOpeningPrompt: "/grill review the design",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: join(home, "checkout"),
		},
		agentName: `consultation-${id.slice(0, 8)}`,
		createdAt,
	});
	state.setConsultationAgent(id, {
		paneId: `pane-${id.slice(0, 8)}`,
		tabId: `tab-${id.slice(0, 8)}`,
		workspaceId: `ws-${id.slice(0, 8)}`,
		sessionId: `sess-${id.slice(0, 8)}`,
	});
	state.settleConsultationTurn(id, null, "the design holds", "idle");
}

const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;

/**
 * Seed a Consultation whose Agent the observation finds working.
 *
 * A working Consultation settles no turn, so the seeded state - and the row
 * order a navigation walk observes - stays put under the observation loop.
 */
function seedWorking(state: FactoryState, id: string): { paneId: string; sessionId: string } {
	const short = id.slice(0, 8);
	state.createConsultation({
		id,
		typeName: "grill",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		contextWindow: "",
		template: "/grill {input}",
		initialInput: "review the design",
		renderedOpeningPrompt: "/grill review the design",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: join(home, "checkout"),
		},
		agentName: `consultation-${short}`,
		createdAt: "2026-09-01T10:00:00.000Z",
	});
	const handles = {
		paneId: `pane-${short}`,
		tabId: `tab-${short}`,
		workspaceId: `ws-${short}`,
		sessionId: `sess-${short}`,
	};
	state.setConsultationAgent(id, handles);
	return { paneId: handles.paneId, sessionId: handles.sessionId };
}

/** One herdr `agent list` entry, with the sequence the observation settles on. */
interface ListedTestAgent {
	pane: string;
	status: string;
	sess: string;
	seq?: number;
}

/** A herdr `agent list` answer the observation matches by pane and session. */
const agentList = (agents: readonly ListedTestAgent[]): string =>
	JSON.stringify({
		result: {
			agents: agents.map((agent) => ({
				pane_id: agent.pane,
				tab_id: `tab-${agent.pane.slice(5)}`,
				workspace_id: `ws-${agent.pane.slice(5)}`,
				agent: `consultation-${agent.pane.slice(5)}`,
				agent_status: agent.status,
				session_id: agent.sess,
				...(agent.seq === undefined ? {} : { sequence: agent.seq }),
			})),
		},
	});

/** The plain-text pane read the output refresh timer issues. */
const paneReadArgs = (paneId: string): readonly string[] => [
	"agent",
	"read",
	paneId,
	"--lines",
	"200",
	"--source",
	"recent-unwrapped",
	"--format",
	"text",
];

/** An Agent output taller than any pane the tests boot, so the detail scrolls. */
const paneOutput = (lead: string): string =>
	Array.from({ length: 30 }, (_, index) => `${lead} output line ${index + 1}`).join("\n");

/** A runner whose Agent list and pane output the test rewrites mid-flight. */
function observationRunner(paneId: string, sessionId: string, output: string): FakeRunner {
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], {
		stdout: agentList([{ pane: paneId, status: "working", sess: sessionId, seq: 1 }]),
	});
	runner.set("herdr", paneReadArgs(paneId), { stdout: output });
	return runner;
}

/**
 * The herdr answer that keeps the seeded Consultations' Agents alive.
 *
 * The observation loop must not move a seeded Consultation into a recovery
 * state while the test is still in the Ticket section: a Consultation that
 * needs the operator becomes the row a navigation walk selects, and which
 * row that is depends on which poll caught the missing Agent first. A live
 * Agent leaves every seeded state in place, so the navigation keys answer
 * the rows the test seeds, on any machine and at any poll speed.
 */
function liveConsultationAgents(ids: readonly string[]): FakeRunner {
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], {
		stdout: agentList(
			ids.map((id) => ({
				pane: `pane-${id.slice(0, 8)}`,
				status: "working",
				sess: `sess-${id.slice(0, 8)}`,
			})),
		),
	});
	return runner;
}

/** The section header text: the row's left-column half, before the detail. */
const headerOf = (frame: string, section: "Tickets" | "Consultations"): string =>
	rowsOf(frame)
		.find((row) => row.includes(section))
		?.split(/┌|│/)[0]
		.trim() ?? "";

/** The frame's list-box top border rows: one per expanded section. */
const paneTopRows = (frame: string): number =>
	rowsOf(frame).filter((row) => row.startsWith("┌─")).length;

/**
 * The frame row of the Consultation selection.
 *
 * Each list marks its own retained selection at once, and the Consultation
 * list always sits below the Ticket list: the last marked row is the
 * Consultation's.
 */
const consultMarkerRowOf = (frame: string): number => {
	let row = -1;
	rowsOf(frame).forEach((candidate, index) => {
		if (candidate.startsWith("│ ❯")) row = index;
	});
	return row;
};

/**
 * Boot the Main view on a state.
 *
 * Tickets are deterministic only where the test holds them: a test that
 * asserts the steady counts boots stateless with `initialTickets`, and a
 * test that walks the rows seeds a FakeSource that settles the sample
 * facts into the state projection.
 */
const booted = (
	body: Parameters<typeof withApp>[0],
	state: FactoryState,
	options: { sources?: readonly TicketSource[] } = {},
	width = WIDTH,
	height = 32,
	runner: CommandRunner = emptyAgentRunner(),
): Promise<void> => withApp(body, width, height, { state, config, home, runner, ...options });

describe("the merged Main view", () => {
	test("one frame holds both sections, one shared detail pane, and the steady Ticket counts", async () => {
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				// Stateless: the Ticket header leads, with its steady counts,
				// then the Ticket list, then the Consultation header, and then
				// the Consultation list: all of it in one frame.
				const rows = rowsOf(frame);
				expect(rows[0]).toContain("▾ Tickets  open: 5  running: 2  awaiting: 1");
				expect(headerOf(frame, "Tickets").startsWith("▾")).toBe(true);
				expect(headerOf(frame, "Consultations").startsWith("▾")).toBe(true);
				// Both sections own a list box at the same time, and the
				// steady zero for held keeps its row unclaimed: the held
				// count shows only above zero.
				expect(paneTopRows(frame)).toBe(2);
				expect(headerOf(frame, "Tickets")).not.toContain("held");
				// One detail pane answers for the section under the cursor:
				// it shows the selected Ticket while the cursor is in the
				// Ticket section.
				expect(detailPaneText(frame)).toContain("Retry policy for webhooks");
				// The frame's own Message line and Action bar sit below, and
				// the bar names the toggle.
				expect(actionBarRowOf(frame)).toContain("x Section");
			},
			WIDTH,
			32,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("the Ticket header adds the held count when, and only when, a turn is held", async () => {
		// The sample carries no held turn: ticket #4 waits on a decision, but
		// its completion ended completed, so the held count stays off the
		// header even though a ticket is awaiting.
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(headerOf(setup.captureCharFrame(), "Tickets")).toBe(
					"▾ Tickets  open: 5  running: 2  awaiting: 1",
				);
			},
			WIDTH,
			32,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
		// The same ticket with a held turn (a failed end, no decision yet) is
		// what the held count exists for: the header adds it, and only then.
		const heldLast = SAMPLE_TICKETS[3].lastCompletion;
		if (heldLast === null) throw new Error("the held sample ticket has no last completion");
		const held: Ticket = {
			...SAMPLE_TICKETS[3],
			lastCompletion: { ...heldLast, cause: "failed" },
		};
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(headerOf(setup.captureCharFrame(), "Tickets")).toBe(
					"▾ Tickets  open: 5  running: 2  awaiting: 1  held: 1",
				);
			},
			WIDTH,
			32,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: [...SAMPLE_TICKETS.slice(0, 3), held, ...SAMPLE_TICKETS.slice(4)],
			},
		);
	});

	test("the Ticket header uses the narrow count form below sixty columns", async () => {
		// The header owns the terminal's full width on its row, so below
		// sixty columns it carries the narrow form - no colons - whole, and
		// on the minimum frame the form is the row's full width (user
		// stories 11 to 14, 29).
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(headerOf(setup.captureCharFrame(), "Tickets")).toBe(
					"▾ Tickets  open 5  running 2  awaiting 1",
				);
			},
			59,
			24,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
		// At the minimum frame the same row holds the same text, edge to
		// edge: the counts are the longest text the frame keeps.
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(rowsOf(setup.captureCharFrame())[0]).toBe(
					"▾ Tickets  open 5  running 2  awaiting 1",
				);
			},
			40,
			19,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("the Ticket header keeps the held count whole in the narrow form", async () => {
		// A held turn on a terminal under sixty columns: the held count rides
		// the narrow form. The bell stays off at boot - it means the count
		// rose while this app ran, and the held turn's flow asserts it.
		const heldLast = SAMPLE_TICKETS[3].lastCompletion;
		if (heldLast === null) throw new Error("the held sample ticket has no last completion");
		const held: Ticket = {
			...SAMPLE_TICKETS[3],
			lastCompletion: { ...heldLast, cause: "failed" },
		};
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(headerOf(setup.captureCharFrame(), "Tickets")).toBe(
					"▾ Tickets  open 5  running 2  awaiting 1  held 1",
				);
			},
			59,
			24,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: [...SAMPLE_TICKETS.slice(0, 3), held, ...SAMPLE_TICKETS.slice(4)],
			},
		);
	});

	test("the Ticket header shows zero counts while no tickets exist", async () => {
		// An empty pipeline keeps the header's shape: all three counts
		// render, as zero, and the held count stays off the row (user
		// stories 14, 25).
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("▾ Tickets"), "the Tickets");
				expect(headerOf(setup.captureCharFrame(), "Tickets")).toBe(
					"▾ Tickets  open: 0  running: 0  awaiting: 0",
				);
			},
			WIDTH,
			32,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: [],
			},
		);
	});

	test("x collapses the section under the cursor, and x again restores it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("c"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// The collapse keeps the detail on the retained Ticket: the
					// section gives up its box rows, not its selection.
					const collapsed = await press(setup, "x", "the Ticket section to collapse", (f) =>
						headerOf(f, "Tickets").startsWith("▸"),
					);
					expect(headerOf(collapsed, "Consultations").startsWith("▾")).toBe(true);
					expect(paneTopRows(collapsed)).toBe(1);
					expect(detailPaneText(collapsed)).toContain("Retry policy for webhooks");
					// The step out of the collapsed section crosses to the first
					// visible Consultation.
					const across = await press(setup, "j", "the cursor to cross to the Consultation", (f) =>
						detailPaneText(f).includes("consultation-cccccccc"),
					);
					expect(across).toContain("❯ Consultations");
					// The toggle now answers the Consultation section, and once
					// more restores its box on the retained row.
					const collapsedAgain = await press(
						setup,
						"x",
						"the Consultation section to collapse",
						(f) => headerOf(f, "Consultations").startsWith("▸"),
					);
					// Both sections are collapsed now: their headers stay, their
					// boxes are gone, and the detail keeps the retained row.
					expect(headerOf(collapsedAgain, "Tickets").startsWith("▸")).toBe(true);
					expect(paneTopRows(collapsedAgain)).toBe(0);
					expect(detailPaneText(collapsedAgain)).toContain("consultation-cccccccc");
					const restored = await press(
						setup,
						"x",
						"the Consultation section to expand again",
						(f) => headerOf(f, "Consultations").startsWith("▾"),
					);
					// The Ticket section stayed collapsed: only the Consultation
					// box came back.
					expect(paneTopRows(restored)).toBe(1);
					expect(restored).toContain("┌─❯ Consultations");
				},
				state,
				{ sources: [source] },
				WIDTH,
				32,
				liveConsultationAgents([uid("c")]),
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("a step past the last visible row crosses the section boundary", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const ids = [uid("c"), uid("d")];
		seedConsultation(state, ids[0], "2026-09-01T10:00:00.000Z");
		seedConsultation(state, ids[1], "2026-09-01T10:01:00.000Z");
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// The walk crosses the boundary: the detail follows the
					// cursor into the Consultation section, and a key after the
					// cross uses the Consultation list.
					await crossToConsultations(setup);
					const second = await press(setup, "j", "the second Consultation", (f) =>
						detailPaneText(f).includes("consultation-dddddddd"),
					);
					expect(detailPaneText(second)).toContain("consultation-dddddddd");
					// The auto-handoff switch has no meaning in the Consultation
					// section: the mode line stays put.
					setup.mockInput.pressKey("a");
					const afterAuto = await settle(setup);
					expect(afterAuto).toContain("auto: off");
					expect(afterAuto).not.toContain("auto: on");
					// The walk back lands on the last visible Ticket, and the
					// next step moves the Ticket list, not the Consultation
					// detail left behind.
					await crossToTickets(setup);
					const back = await settle(setup);
					expect(back).toContain("Ticket id in the agent name");
					expect(back).toContain("❯ Tickets");
					const moved = await press(setup, "k", "the previous Ticket", (f) =>
						f.includes("Run the container env"),
					);
					expect(markerRowOf(moved)).toBe(10);
				},
				state,
				{ sources: [source] },
				WIDTH,
				32,
				liveConsultationAgents(ids),
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("a key after a cross uses the newly focused list", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const ids = [uid("c"), uid("d")];
		seedConsultation(state, ids[0], "2026-09-01T10:00:00.000Z");
		seedConsultation(state, ids[1], "2026-09-01T10:01:00.000Z");
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					await crossToConsultations(setup);
					// A key through the detail and back answers the Consultation
					// list the cursor just entered, not the Ticket list left
					// behind.
					await press(setup, "l", "the Agent view to take focus", (f) =>
						f.includes("┌─❯ Agent view"),
					);
					setup.mockInput.pressKey("h");
					setup.mockInput.pressKey("j");
					const moved = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("consultation-dddddddd"),
						"the second Consultation after the immediate navigation",
					);
					expect(consultMarkerRowOf(moved)).toBe(13);
				},
				state,
				{ sources: [source] },
				WIDTH,
				32,
				liveConsultationAgents(ids),
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("a click on a section header toggles that section", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("d"));
		try {
			await booted(async (setup) => {
				await press(setup, "x", "the Ticket section to collapse", (f) =>
					headerOf(f, "Tickets").startsWith("▸"),
				);
				expect(paneTopRows(setup.captureCharFrame())).toBe(1);
				// The Ticket header holds its own row above its box: the
				// collapsed header is row one, below the mode line.
				await mouseClick(setup, 10, 1);
				const frame = await awaitFrame(
					setup,
					(candidate) => headerOf(candidate, "Tickets").startsWith("▾"),
					"the Ticket section to expand on click",
				);
				// The click lands the cursor back on the expanded section's
				// own list.
				expect(frame).toContain("┌─❯ Tickets");
				// A click on the expanded Consultation header collapses the
				// section, and the cursor stays on the row it held.
				await mouseClick(setup, 10, 22);
				const collapsed = await awaitFrame(
					setup,
					(candidate) => headerOf(candidate, "Consultations").startsWith("▸"),
					"the Consultation section to collapse on click",
				);
				expect(collapsed).toContain("▸ Consultations");
				expect(collapsed).toContain("┌─❯ Tickets");
			}, state);
		} finally {
			state.close();
		}
	});

	test("refresh reports a readable no-op when no Ticket source exists", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("n"));
		try {
			await booted(async (setup) => {
				// Refresh answers for the whole plane from either section: no
				// section switch is needed to reach the Ticket sources.
				const refreshed = await press(setup, "r", "the no-op refresh", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(messageRowOf(refreshed)).not.toContain("refreshing 0 sources");
			}, state);
		} finally {
			state.close();
		}
	});

	test("refresh reports an in-flight Ticket source without fake progress", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("o"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					await awaitFrame(setup, () => source.calls === 1, "the Ticket source refresh");
					const refused = await press(setup, "r", "the in-flight refresh refusal", (f) =>
						messageRowOf(f).includes("every Ticket source is already refreshing"),
					);
					expect(messageRowOf(refused)).not.toContain("refreshing 0 sources");
					source.settle(sampleOutcome());
				},
				state,
				{ sources: [source] },
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("the Consultation header carries the attention facts, and adds no row", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("e"));
		try {
			await booted(async (setup) => {
				// The observation reports the Consultation's own state on the
				// header: here the Agent pane is gone, so it needs recovery.
				// The counts ride on the section's own row and never add one
				// of their own.
				const frame = await awaitFrame(
					setup,
					(f) => headerOf(f, "Consultations").includes("recovery: 1"),
					"the recovery count on the header",
				);
				expect(headerOf(frame, "Consultations")).toBe(
					"▾ Consultations  awaiting response: 0  recovery: 1",
				);
				expect(rowsOf(frame)).toHaveLength(32);
				// The facts ride the header whichever section is collapsed:
				// the row the section gives up is its box, not its header.
				const collapsed = await press(setup, "x", "the Ticket section to collapse", (f) =>
					headerOf(f, "Tickets").startsWith("▸"),
				);
				expect(headerOf(collapsed, "Consultations")).toContain("recovery: 1");
				expect(rowsOf(collapsed)).toHaveLength(32);
			}, state);
		} finally {
			state.close();
		}
	});

	test("the Message line survives a cross, and m reads it in full", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("m"));
		// A Config with no Consultation types: the launcher's refusal is longer
		// than this frame holds, so the Message line truncates and the Message
		// view is the only way to read the whole of it.
		const narrowConfig: FactoryConfig = { ...config, consultationTypes: {} };
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await withApp(
				async (setup) => {
					source.settle(sampleOutcome());
					await crossToConsultations(setup);
					const refused = await press(setup, "c", "the refusal", (f) =>
						messageRowOf(f).includes("no Consultation types configured"),
					);
					// The line holds what fits, and no more.
					expect(widthOf(messageRowOf(refused))).toBeLessThanOrEqual(60);
					// The same Message answers after the walk back: it is the
					// frame's line, not a section's.
					await crossToTickets(setup);
					const tickets = await settle(setup);
					expect(messageRowOf(tickets)).toContain("no Consultation types configured");
					// The bar offers the Message view because the line is cut.
					expect(actionBarRowOf(tickets)).toContain("m Message");
					await press(setup, "m", "the Message view", (f) => f.includes("Message view"));
					const view = await settle(setup);
					// The view shows the whole message, wrapped at the pane width.
					expect(view).toContain("no Consultation types configured; add");
					expect(view).toContain("[consultation-types.<name>] to the config file");
				},
				60,
				20,
				{ state, config: narrowConfig, home, runner: emptyAgentRunner(), sources: [source] },
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("the frame answers its controls at the minimum size", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("1"));
		try {
			await booted(
				async (setup) => {
					// At the minimum size the mode line, both headers, the Message
					// line and the Action bar stay permanent, and both sections
					// still hold a real list box.
					const frame = await settle(setup);
					expect(rowsOf(frame)).toHaveLength(19);
					expect(rowsOf(frame)[0]).toContain("auto: off");
					expect(rowsOf(frame)[1]).toContain("Tickets");
					expect(rowsOf(frame)[9]).toContain("Consultations");
					expect(paneTopRows(frame)).toBe(2);
					expect(actionBarRowOf(frame)).toContain("? Help");
					expect(messageRowOf(frame)).not.toBe(actionBarRowOf(frame));
					// The toggle answers at the minimum size, and the room the
					// collapsed section frees goes to the one that stays.
					const collapsed = await press(setup, "x", "the Ticket section to collapse", (f) =>
						headerOf(f, "Tickets").startsWith("▸"),
					);
					expect(rowsOf(collapsed)).toHaveLength(19);
					expect(paneTopRows(collapsed)).toBe(1);
					// The collapsed Ticket section keeps its header row, so the
					// Consultation header and box rise one row.
					expect(rowsOf(collapsed)[2]).toContain("Consultations");
					expect(rowsOf(collapsed)[3]).toContain("┌─");
					expect(rowsOf(collapsed).at(-3)).toContain("└─");
				},
				state,
				undefined,
				40,
				19,
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation panes answer the mouse as the Ticket panes do", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("5"));
		seedConsultation(state, uid("6"));
		try {
			await booted(async (setup) => {
				await awaitFrame(setup, (f) => f.includes("grill"), "the Consultation list");
				// The Consultation header and box sit below the Ticket
				// section's: at this size the Ticket section holds the cursor,
				// so the Consultation box keeps its minimum of three content
				// rows, and the second seeded row sits on frame row 26.
				// The click moves the cursor, and the Consultation box grows
				// to the remaining rows, so the selected row rests on 13.
				await mouseClick(setup, 10, 26);
				const selected = await awaitFrame(
					setup,
					(f) => rowsOf(f)[13]?.includes("❯ ") === true,
					"the clicked Consultation to become selected",
				);
				expect(selected).toContain("┌─❯ Consultations");
				// A click inside the Agent view moves the pane focus, and the
				// Action bar follows with the detail's own hints.
				await mouseClick(setup, 70, 5);
				const detailed = await awaitFrame(
					setup,
					(f) => f.includes("┌─❯ Agent view"),
					"the Agent view to take focus",
				);
				expect(actionBarRowOf(detailed)).toContain("←/h List");
			}, state);
		} finally {
			state.close();
		}
	});

	test("a refusal names the state that is missing, in the section that owns it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("r"));
		try {
			await booted(
				async (setup) => {
					// The Consultation-only keys answer the Ticket section the way
					// the Ticket-only keys answer the Consultation section: the
					// key states what is missing, and nothing changes. The Ticket
					// list refuses first...
					let refusal = await press(setup, "d", "the delete refusal", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					refusal = await press(setup, "f", "the history refusal", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					// ...and the Ticket detail pane carries the same refusal, the
					// seeded Consultation untouched by either key.
					await focusDetail(setup);
					refusal = await press(setup, "d", "the delete refusal on the detail pane", (f) =>
						messageRowOf(f).includes("only in the Consultation section"),
					);
					expect(messageRowOf(refusal)).toContain("only in the Consultation section");
					expect(refusal).toContain("grill");

					// A Ticket-section control answers the same way in the
					// Consultation section: the key states what is missing.
					await crossToConsultations(setup);
					const ticketRefusal = await press(setup, "e", "the override refusal", (f) =>
						messageRowOf(f).includes("only in the Ticket section"),
					);
					expect(messageRowOf(ticketRefusal)).toContain("only in the Ticket section");
				},
				state,
				undefined,
				WIDTH,
				32,
				liveConsultationAgents([uid("r")]),
			);
		} finally {
			state.close();
		}
	});

	test("the mode line, the panes and the bar keep their rows in both sections", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("2"));
		try {
			await booted(async (setup) => {
				const frame = await awaitFrame(setup, (f) => f.includes("grill"), "the Consultation list");
				const rows = rowsOf(frame);
				// The mode line, then the headers and the boxes, then the
				// Message line and the Action bar: one frame, in that order,
				// in both sections.
				expect(rows[0]).toContain("auto: off");
				expect(rows[1]).toContain("Tickets");
				expect(rows[22]).toContain("Consultations");
				expect(rows[2]).toContain("┌─");
				expect(rows.at(-3)).toContain("└─");
				expect(actionBarRowOf(frame)).toContain("x Section");
				// The bar follows the section under the cursor, and the
				// Consultation section's History keeps its bar hint there.
				await crossToConsultations(setup);
				const across = await settle(setup);
				expect(rowsOf(across)[0]).toContain("auto: off");
				expect(actionBarRowOf(across)).toContain("w Close");
				expect(actionBarRowOf(across)).toContain("f History");
				expect(actionBarRowOf(across)).toContain("x Section");
			}, state);
		} finally {
			state.close();
		}
	});

	test("the Key guide from a Consultation mode names the section controls once", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("3"));
		try {
			await booted(
				async (setup) => {
					await crossToConsultations(setup);
					await press(setup, "?", "the Key guide", (f) =>
						f.includes("Key guide - Consultation list"),
					);
					const rows = overlayRows(await settle(setup));
					// The Consultation controls the merged Main view reached for,
					// each named once with the key the section accepts.
					for (const hint of [
						"c Launch",
						"f History",
						"w Close",
						"d Delete",
						"Enter Respond",
						"x Section",
						"r Refresh",
					])
						expect(rows.filter((row) => row.includes(hint))).toHaveLength(1);
					// The guide states no second Message or Help control: the
					// frame holds one of each, whatever section is expanded. The
					// Consultation section now runs past the first window (Goto,
					// ADR 0025), so one scroll step brings its tail into view.
					setup.mockInput.pressKey("j");
					const scrolled = overlayRows(await settle(setup));
					expect(scrolled.filter((row) => row.includes("m/F2 Message"))).toHaveLength(1);
					expect(scrolled.filter((row) => row.includes("? Help"))).toHaveLength(1);
				},
				state,
				undefined,
				WIDTH,
				32,
				liveConsultationAgents([uid("3")]),
			);
		} finally {
			state.close();
		}
	});

	test("a collapsed section keeps its selection, and re-expanding returns to it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("4"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// Move the Ticket selection, then collapse the section.
					await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 5);
					await press(setup, "x", "the Ticket section to collapse", (f) =>
						headerOf(f, "Tickets").startsWith("▸"),
					);
					// Coming back finds the same Ticket selected: the collapse
					// kept the section's state rather than rebuilding it.
					const back = await press(setup, "x", "the Ticket section to expand", (f) =>
						headerOf(f, "Tickets").startsWith("▾"),
					);
					expect(markerRowOf(back)).toBe(5);
					expect(back).toContain("Fix pan drift");
				},
				state,
				{ sources: [source] },
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});

	test("the Ticket detail keeps its scroll across a round trip through the other section", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("t"));
		// A description taller than the detail pane: the state projection
		// carries no handoff facts, so the body is what overflows.
		const outcome = {
			...sampleOutcome(),
			tickets: sampleOutcome().tickets.map((ticket) =>
				ticket.externalKey === "#4"
					? {
							...ticket,
							description:
								"The legacy auth shim that predated the token service has no remaining callers.\n" +
								"Remove it and its feature flag.\n" +
								Array.from(
									{ length: 12 },
									(_, index) =>
										`A long note ${index + 1} about the callers that were considered and why each one no longer needs the shim.`,
								).join("\n") +
								"\nsentinel-end-marker",
						}
					: ticket,
			),
		};
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await booted(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// The long-description Ticket is the one that overflows the
					// pane, so it can be scrolled off its own title.
					for (let step = 1; step <= 3; step += 1)
						await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 4 + step);
					await focusDetail(setup);
					const scrolled = await pressScrollKey(
						setup,
						"end",
						"the detail past its title",
						(f) => !detailPaneText(f).includes("Drop the legacy auth shim"),
					);
					expect(detailPaneText(scrolled)).toContain("sentinel-end-marker");
					// Walk through the Consultation section and back, and take
					// the Ticket up again: its detail unmounted with the cross,
					// and its offset came back with the remount.
					await press(setup, "h", "the list focus back", (f) => f.includes("┌─❯ Tickets"));
					await crossToConsultations(setup);
					// The cursor crosses to the last Ticket row; home brings it
					// back to the list's first row.
					await crossToTickets(setup);
					await press(
						setup,
						"home",
						"the list back to its first Ticket",
						(f) => markerRowOf(f) === 4,
					);
					for (let step = 1; step <= 3; step += 1)
						await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 4 + step);
					await focusDetail(setup);
					const resumed = await awaitFrame(
						setup,
						(f) => detailPaneText(f) === detailPaneText(scrolled),
						"the detail to resume at its scrolled position",
					);
					// The offset is the Ticket's, not the section's: another
					// Ticket's detail starts at its own top.
					await press(setup, "h", "the list focus back", (f) => f.includes("┌─❯ Tickets"));
					await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 8);
					await focusDetail(setup);
					const next = await settle(setup);
					expect(detailPaneText(next)).toContain("Observe the agent");
					expect(detailPaneText(next)).not.toContain("sentinel-end-marker");
					expect(detailPaneText(next)).not.toBe(detailPaneText(resumed));
				},
				state,
				{ sources: [source] },
				WIDTH,
				24,
				liveConsultationAgents([uid("t")]),
			);
		} finally {
			source.settle(outcome);
			state.close();
		}
	});

	test("the Consultation header carries the attention bell, collapsed and expanded", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const a = seedWorking(state, uid("q"));
		const b = seedWorking(state, uid("r"));
		const runner = new FakeRunner();
		// Both Agents work until the test moves one of them off `working`,
		// which is what settles a Consultation and rings its bell.
		const agents = (aStatus: string, aSeq: number, bStatus: string, bSeq: number) =>
			agentList([
				{ pane: a.paneId, status: aStatus, sess: a.sessionId, seq: aSeq },
				{ pane: b.paneId, status: bStatus, sess: b.sessionId, seq: bSeq },
			]);
		runner.set("herdr", ["agent", "list"], { stdout: agents("working", 1, "working", 1) });
		runner.set("herdr", paneReadArgs(a.paneId), { stdout: paneOutput("alpha") });
		runner.set("herdr", paneReadArgs(b.paneId), { stdout: paneOutput("beta") });
		try {
			await withApp(
				async (setup) => {
					const booted = await settle(setup);
					expect(headerOf(booted, "Consultations")).not.toContain("!!!");
					// A settles while its section is expanded: the header row is
					// the section's fact row, and the bell rides on it.
					runner.set("herdr", ["agent", "list"], { stdout: agents("idle", 2, "working", 1) });
					const expandedBell = await awaitFrame(
						setup,
						(f) => headerOf(f, "Consultations").includes("!!!"),
						"the bell on the expanded header",
					);
					expect(headerOf(expandedBell, "Consultations").startsWith("▾")).toBe(true);
					expect(messageRowOf(expandedBell)).toContain("awaits a response");
					// Let A's bell expire, so the next one belongs to B.
					await awaitFrame(
						setup,
						(f) => !headerOf(f, "Consultations").includes("!!!"),
						"the first bell to expire",
					);
					// The same fact on the collapsed header: B settles after the
					// cursor crosses to its section and collapses it.
					await crossToConsultations(setup);
					await press(setup, "x", "the Consultation section to collapse", (f) =>
						headerOf(f, "Consultations").startsWith("▸"),
					);
					runner.set("herdr", ["agent", "list"], { stdout: agents("idle", 2, "idle", 2) });
					const collapsedBell = await awaitFrame(
						setup,
						(f) => headerOf(f, "Consultations").includes("!!!"),
						"the bell on the collapsed header",
					);
					expect(headerOf(collapsedBell, "Consultations").startsWith("▸")).toBe(true);
				},
				WIDTH,
				32,
				{ state, config, home, runner, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});

	test("the new output fact shows on the Consultation header, collapsed and expanded", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const { paneId, sessionId } = seedWorking(state, uid("u"));
		const runner = observationRunner(paneId, sessionId, paneOutput("gamma"));
		try {
			await withApp(
				async (setup) => {
					await crossToConsultations(setup);
					await press(setup, "l", "the Agent view to take focus", (f) =>
						f.includes("┌─❯ Agent view"),
					);
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("gamma output line 30"),
						"the Agent output at the follow end",
					);
					// Scroll off the follow: the detail keeps its place, so new
					// output can no longer pull it down.
					await pressScrollKey(
						setup,
						"home",
						"the Agent view at its start",
						(f) =>
							detailPaneText(f).includes("State: working") &&
							!detailPaneText(f).includes("gamma output line 30"),
					);
					// The next refresh reads different output while the detail is
					// not following: the header states the fact.
					runner.set("herdr", paneReadArgs(paneId), { stdout: paneOutput("delta") });
					const newOutput = await awaitFrame(
						setup,
						(f) => headerOf(f, "Consultations").includes("new output"),
						"the new output fact on the header",
						5000,
					);
					expect(headerOf(newOutput, "Consultations").startsWith("▾")).toBe(true);
					// The collapsed header keeps the fact: the fact belongs to
					// the selected Consultation, not to the section's room.
					const collapsed = await press(setup, "x", "the Consultation section to collapse", (f) =>
						headerOf(f, "Consultations").startsWith("▸"),
					);
					expect(headerOf(collapsed, "Consultations")).toContain("new output");
				},
				160,
				32,
				{ state, config, home, runner },
			);
		} finally {
			state.close();
		}
	});
});
