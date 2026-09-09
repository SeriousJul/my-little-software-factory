/**
 * The merged Main view: one surface, two accordion sections.
 *
 * These frame tests hold the product decisions of ADR 0013: the Ticket and
 * Consultation panes are sections of one frame, not two fullscreen views. One
 * Message line, one Action bar, and one control catalog answer for both, the
 * expanded section owns the pane rows, and a section header is as reachable by
 * mouse as its keys are by keyboard.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { widthOf } from "../src/components/text.ts";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { TicketSource } from "../src/ticket-source.ts";
import {
	actionBarRowOf,
	awaitFrame,
	detailPaneText,
	frameText,
	HEADER_ROWS,
	markerRowOf,
	messageRowOf,
	mouseClick,
	overlayRows,
	press,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
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
	...DEFAULT_CONFIG,
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

/** The source outcome that carries the sample Tickets. */
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

/** One section header row, as the frame draws it. */
const headerOf = (frame: string, section: "Tickets" | "Consultations"): string =>
	(rowsOf(frame).find((row) => row.includes(section)) ?? "").trim();

/** The frame's pane-top border rows: one pair per expanded section. */
const paneTopRows = (frame: string): number =>
	rowsOf(frame).filter((row) => row.startsWith("┌─")).length;

/** Boot the merged Main view with one state and, optionally, one Ticket source. */
const booted = (
	body: Parameters<typeof withApp>[0],
	state: FactoryState,
	sources?: readonly TicketSource[],
	width = WIDTH,
	height = 32,
): Promise<void> =>
	withApp(body, width, height, {
		state,
		config,
		home,
		runner: emptyAgentRunner(),
		...(sources === undefined ? {} : { sources }),
	});

describe("the merged Main view", () => {
	test("one frame holds both headers and only the expanded section's panes", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("b"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					const frame = await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// The mode line comes before both section headers, and the Ticket
					// header is the expanded one.
					const rows = rowsOf(frame);
					expect(rows[0]).toContain("auto: off");
					expect(rows[1]).toContain("Tickets");
					expect(rows[2]).toContain("Consultations");
					expect(headerOf(frame, "Tickets").startsWith("▾")).toBe(true);
					expect(headerOf(frame, "Consultations").startsWith("▸")).toBe(true);
					// The collapsed section holds no pane: the frame draws one pair
					// of borders, not two.
					expect(paneTopRows(frame)).toBe(1);
					expect(frame).not.toContain("Agent view");
					// One Message line and one Action bar answer for both sections.
					expect(actionBarRowOf(frame)).toContain("v Consultations");
				},
				state,
				[source],
			);
		} finally {
			state.close();
		}
	});

	test("v expands Consultations and t returns to Tickets, one section at a time", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("c"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					const opened = await press(setup, "v", "the Consultation panes", (f) =>
						f.includes("Agent view"),
					);
					expect(headerOf(opened, "Consultations").startsWith("▾")).toBe(true);
					expect(headerOf(opened, "Tickets").startsWith("▸")).toBe(true);
					expect(paneTopRows(opened)).toBe(1);
					// The section holds no Ticket pane, and its own list carries the
					// focus the switch promised.
					expect(opened).not.toContain("Retry policy for webhooks");
					expect(opened).toContain("┌─❯ Consultations");
					// The Action bar belongs to the expanded section.
					expect(actionBarRowOf(opened)).toContain("t Tickets");
					expect(actionBarRowOf(opened)).not.toContain("Enter Hand off");

					const back = await press(setup, "t", "the Ticket panes", (f) =>
						f.includes("Retry policy for webhooks"),
					);
					expect(headerOf(back, "Tickets").startsWith("▾")).toBe(true);
					expect(back).not.toContain("Agent view");
					expect(actionBarRowOf(back)).toContain("v Consultations");
				},
				state,
				[source],
			);
		} finally {
			state.close();
		}
	});

	test("section switches keep selection and focus, and auto-handoff stays Ticket-only", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("c"));
		seedConsultation(state, uid("d"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					await press(setup, "v", "the Consultation panes", (f) => f.includes("Agent view"));
					await press(setup, "j", "the second Consultation", (f) =>
						f.includes("consultation-dddddddd"),
					);
					const selected = await settle(setup);
					setup.mockInput.pressKey("v");
					const repeated = await settle(setup);
					// Repeating v is a no-op. It must not jump back to the
					// attention row selected when the section first opened.
					expect(detailPaneText(repeated)).toBe(detailPaneText(selected));
					expect(repeated).toContain("consultation-dddddddd");
					// a has no meaning in the Consultation section.
					setup.mockInput.pressKey("a");
					const afterAuto = await settle(setup);
					expect(afterAuto).toContain("auto: off");
					expect(afterAuto).not.toContain("auto: on");
					// t switches from the Consultation detail as well as its list.
					await press(setup, "l", "the Consultation detail", (f) => f.includes("┌─❯ Agent view"));
					const tickets = await press(setup, "t", "the Ticket section", (f) =>
						f.includes("Retry policy for webhooks"),
					);
					// The navigation key after the switch must move the visible Ticket
					// list, not the hidden Consultation detail.
					const moved = await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 6);
					expect(moved).toContain("Fix pan drift");
					expect(tickets).toContain("Retry policy for webhooks");
				},
				state,
				[source],
			);
		} finally {
			state.close();
		}
	});

	test("a click on a collapsed header expands that section", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("d"));
		try {
			await booted(
				async (setup) => {
					const before = await settle(setup);
					expect(paneTopRows(before)).toBe(1);
					expect(before).not.toContain("Agent view");
					// The mode line is first, so the Consultation header is row two.
					await mouseClick(setup, 10, 2);
					const frame = await awaitFrame(
						setup,
						(candidate) => candidate.includes("Agent view"),
						"the Consultation section to expand on click",
					);
					expect(headerOf(frame, "Consultations").startsWith("▾")).toBe(true);
					// The click lands the focus on the expanded section's own list.
					expect(frame).toContain("┌─❯ Consultations");
				},
				state,
				undefined,
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation header carries the attention facts, and adds no row", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("e"));
		try {
			await booted(
				async (setup) => {
					const frame = await settle(setup);
					// At this width the header truncates: the counts ride on the
					// section's own row and never add one of their own.
					// The observation reports the Consultation's own state on the
					// header: here the Agent pane is gone, so it needs recovery.
					expect(headerOf(frame, "Consultations")).toContain("recovery: 1");
					expect(rowsOf(frame)).toHaveLength(32);
					const opened = await press(setup, "v", "the Consultation section", (f) =>
						f.includes("Agent view"),
					);
					expect(headerOf(opened, "Consultations")).toContain("recovery: 1");
					expect(rowsOf(opened)).toHaveLength(32);
				},
				state,
				undefined,
			);
		} finally {
			state.close();
		}
	});

	test("the Message line survives a section switch, and m reads it in full", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// A Config with no Consultation types: the launcher's refusal is longer
		// than this frame holds, so the Message line truncates and the Message
		// view is the only way to read the whole of it.
		const narrowConfig: FactoryConfig = { ...config, consultationTypes: {} };
		try {
			await withApp(
				async (setup) => {
					await press(setup, "v", "the Consultation section", (f) =>
						headerOf(f, "Consultations").startsWith("▾"),
					);
					const refused = await press(setup, "c", "the refusal", (f) =>
						messageRowOf(f).includes("no Consultation types configured"),
					);
					// The line holds what fits, and no more.
					expect(widthOf(messageRowOf(refused))).toBeLessThanOrEqual(60);
					// The same Message answers in the other section: it is the
					// frame's line, not a section's.
					const tickets = await press(setup, "t", "the Ticket section", (f) =>
						headerOf(f, "Tickets").startsWith("▾"),
					);
					expect(messageRowOf(tickets)).toContain("no Consultation types configured");
					// The bar offers the Message view because the line is cut.
					expect(actionBarRowOf(tickets)).toContain("m Message");
					await press(setup, "m", "the Message view", (f) => f.includes("Message view"));
					const view = await settle(setup);
					expect(frameText(view)).toContain("add [consultation-types.<name>] to the config");
				},
				60,
				20,
				{ state, config: narrowConfig, home, runner: emptyAgentRunner() },
			);
		} finally {
			state.close();
		}
	});

	test("the section's controls answer at the minimum size", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("1"));
		try {
			await booted(
				async (setup) => {
					// At the minimum size the mode line, two headers, the Message line
					// and the Action bar stay permanent, and the expanded section still
					// holds one real pane row.
					const frame = await settle(setup);
					expect(rowsOf(frame)).toHaveLength(9);
					expect(headerOf(frame, "Consultations")).toContain("awaiting 0  recovery 1");
					expect(rowsOf(frame)).toHaveLength(9);
					expect(actionBarRowOf(frame)).toContain("? Help");
					expect(messageRowOf(frame)).not.toBe(actionBarRowOf(frame));
					const opened = await press(setup, "v", "the Consultation section", (f) =>
						headerOf(f, "Consultations").startsWith("▾"),
					);
					expect(rowsOf(opened)).toHaveLength(9);
					expect(paneTopRows(opened)).toBe(1);
					// The frame promises its two bottom rows, its mode line, and its
					// two headers at the minimum size, and holds one real pane row
					// between them.
					const rows = rowsOf(opened);
					expect(messageRowOf(opened)).not.toBe(actionBarRowOf(opened));
					expect(rows[0]).toContain("auto: off 0/2");
					expect(rows[1]).toContain("Tickets");
					expect(rows[2]).toContain("Consultations");
					expect(rows[HEADER_ROWS + 1]).toContain("┌─");
					expect(rows.at(-3)).toContain("└─");
					// The Consultation list gives way to the compact heading, and
					// the Agent view holds the pane row that is left.
					expect(rows[HEADER_ROWS + 1]).toContain("grill - acme/factory");
				},
				state,
				undefined,
				40,
				9,
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
			await booted(
				async (setup) => {
					await press(setup, "v", "the Consultation section", (f) =>
						f.includes("grill acme/factory"),
					);
					// The headers, the mode line, and the pane's border and padding
					// put the list's second row at frame row 6. One click selects
					// the Consultation under the pointer and keeps the section's
					// list focused, as the Ticket list does.
					await mouseClick(setup, 10, 6);
					const selected = await awaitFrame(
						setup,
						(f) => rowsOf(f)[6]?.includes("❯ ") === true,
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
				},
				state,
				undefined,
			);
		} finally {
			state.close();
		}
	});

	test("a refusal names the state that is missing, in the section that owns it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		try {
			await booted(
				async (setup) => {
					// With no Consultation at all, the section's own controls say so
					// rather than doing nothing.
					await press(setup, "v", "the Consultation section", (f) =>
						f.includes("no open Consultations"),
					);
					const refused = await press(setup, "x", "the refusal", (f) =>
						messageRowOf(f).includes("no Consultation is selected"),
					);
					expect(refused).toContain("no open Consultations");
					// A Ticket-section control answers the same way in the
					// Consultation section: the key states what is missing.
					const ticketRefusal = await press(setup, "e", "the override refusal", (f) =>
						messageRowOf(f).includes("only in the Ticket section"),
					);
					expect(messageRowOf(ticketRefusal)).toContain("only in the Ticket section");
				},
				state,
				undefined,
			);
		} finally {
			state.close();
		}
	});

	test("the mode line, the panes and the bar keep their rows in both sections", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("2"));
		try {
			await booted(
				async (setup) => {
					const opened = await press(setup, "v", "the Consultation panes", (f) =>
						f.includes("Agent view"),
					);
					const rows = rowsOf(opened);
					// The mode line, then the headers, then the panes, then the
					// Message line and the Action bar: one frame, in that order,
					// in both sections.
					expect(headerOf(opened, "Tickets")).not.toBe("");
					expect(rows[0]).toContain("auto: off");
					expect(rows[1]).toContain("Tickets");
					expect(rows[2]).toContain("Consultations");
					expect(rows[HEADER_ROWS + 1]).toContain("┌─");
					expect(rows.at(-3)).toContain("└─");
					expect(actionBarRowOf(opened)).toContain("Enter Respond");
					const tickets = await press(
						setup,
						"t",
						"the Ticket panes",
						(f) => f.includes("┌─  Detail") || f.includes("┌─❯ Tickets"),
					);
					expect(rowsOf(tickets)[0]).toContain("auto: off");
					expect(paneTopRows(tickets)).toBe(1);
				},
				state,
				undefined,
			);
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
					await press(setup, "v", "the Consultation section", (f) =>
						headerOf(f, "Consultations").startsWith("▾"),
					);
					await press(setup, "?", "the Key guide", (f) =>
						f.includes("Key guide - Consultation list"),
					);
					const rows = overlayRows(await settle(setup));
					// The Consultation controls the merged Main view reached for,
					// each named once with the key the section accepts.
					for (const hint of [
						"c Launch",
						"f History",
						"x Close",
						"d Delete",
						"Enter Respond",
						"t Tickets",
						"r Refresh",
					])
						expect(rows.filter((row) => row.includes(hint))).toHaveLength(1);
					// The guide states no second Message or Help control: the frame
					// holds one of each, whatever section is expanded.
					expect(rows.filter((row) => row.includes("m/F2 Message"))).toHaveLength(1);
					expect(rows.filter((row) => row.includes("? Help"))).toHaveLength(1);
				},
				state,
				undefined,
			);
		} finally {
			state.close();
		}
	});

	test("a collapsed section keeps its selection, and the expanded one starts fresh", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seedConsultation(state, uid("4"));
		const source = new FakeSource("issues", "github-issues", sampleOutcome());
		try {
			await booted(
				async (setup) => {
					source.settle(sampleOutcome());
					await awaitFrame(setup, (f) => f.includes("Retry policy"), "the Tickets");
					// Move the Ticket selection, then leave the section.
					await press(setup, "j", "the next Ticket", (f) => markerRowOf(f) === 6);
					await press(setup, "v", "the Consultation section", (f) =>
						headerOf(f, "Consultations").startsWith("▾"),
					);
					// Coming back finds the same Ticket selected: the collapse kept
					// the section's state rather than rebuilding it.
					const back = await press(setup, "t", "the Ticket section", (f) =>
						headerOf(f, "Tickets").startsWith("▾"),
					);
					expect(markerRowOf(back)).toBe(6);
					expect(back).toContain("Fix pan drift");
				},
				state,
				[source],
			);
		} finally {
			source.settle(sampleOutcome());
			state.close();
		}
	});
});
