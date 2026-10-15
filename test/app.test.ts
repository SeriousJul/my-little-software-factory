/**
 * The single seam: the rendered terminal frame.
 *
 * The app renders headless through the first-party OpenTUI test renderer.
 * Mock keys drive it, the character frame is captured, and the tests assert
 * on what an operator would see. The sample-data contract is observed the
 * same way: no test reads the sample data directly and passes.
 *
 * Three harness rules keep the suite honest:
 *
 * - Waits end on the effect being asserted, or on a hard deadline. Keys
 *   dispatch through the stdin parser's 20ms escape-sequence timer, which
 *   the renderer's event-driven waits do not cover, so the press helpers
 *   poll the frame until the effect appears and fail loudly at the
 *   deadline. No correctness wait is a fixed sleep.
 * - Stability waits never trust a pre-dispatch frame. In this harness a
 *   frame change lands 14-16 ms after the press, so `settle` waits out a
 *   30 ms dispatch grace first and then requires two consecutive
 *   identical polls. A no-op key cannot read as stable before it was
 *   dispatched.
 * - console.error is captured, not suppressed. The React act() warning is
 *   the known noise of this setup: the test renderer drives real renders
 *   outside act. Anything else is a defect and fails the test.
 *
 * The renderer is a system resource of the test. `withApp` boots it, runs
 * the test body, and destroys it in a finally, so no test body owns its
 * own cleanup.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import stringWidth from "string-width";
import { SPINNER_FRAMES } from "../src/components/shared/spinner.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type { Setup } from "./app-harness.ts";
import {
	agentRowOf,
	bootApp,
	cellColors,
	detailFocused,
	detailPaneText,
	expectStateBadges,
	frameText,
	frameUntil,
	guideKey,
	listFocused,
	listHalfOf,
	markerRowOf,
	messageRowOf,
	mouseClick,
	mouseDrag,
	mousePress,
	mouseWheel,
	pageKey,
	paneRow,
	pressControl,
	quitApp,
	rgb,
	roleColor,
	rowsOf,
	settle,
	showsTicket,
	sleep,
	spanColors,
	startingFaceOf,
	stillFrame,
	WIDTH,
	waitFor,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	fetchedTicket,
	fetchRateLimited,
	fetchSuccess,
	issueTicket,
	SAMPLE_TICKETS,
	ticketOf,
} from "./fact-fixtures.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { plane, reopenState } from "./plane.ts";

/** Scroll the detail pane down until the line shows, one catalogue key at a time. */
async function detailLineUntil(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
	maxSteps = 24,
): Promise<string> {
	for (let step = 0; step <= maxSteps; step += 1) {
		const frame = setup.captureCharFrame();
		if (predicate(frame)) return frame;
		await guideKey(setup, "scroll-detail", "j", { quiet: true });
	}
	throw new Error(`the detail never showed ${what}
last frame:
${setup.captureCharFrame()}`);
}

/**
 * The braille glyph the spinner face stands on, as a character class.
 *
 * The face steps one glyph every ~100 ms, so an exact row check runs on the
 * word and the glyph class instead of one frame's glyph (ADR 0030). The
 * class is built from the shared frames, so it cannot fall behind them.
 */
const SPINNER_GLYPH = `[${SPINNER_FRAMES.join("")}]`;

describe("the control plane", () => {
	test("production starts with no configured ticket sources instead of sample data", async () => {
		const state = reopenState(":memory:");
		// The empty source set is a stated fact of the standing, not an
		// omitted field: the refresh loop runs over nothing and the list says so.
		const planeRecord = await plane({
			existing: state,
			groupingAxis: "none",
			sources: [],
			config: BASE_CONFIG,
		});
		await withApp(
			async (setup) => {
				const frame = await waitFor(setup, { shows: "no ticket sources configured" });
				expect(frame).not.toContain(SAMPLE_TICKETS[0].title);
			},
			{ width: WIDTH, height: 30, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	test("Goto refuses a running ticket whose pane holds a foreign agent", async () => {
		// The reported symptom: herdr handed the id of the ticket's closed pane
		// out again, and a Consultation's agent works in it now. The ticket's
		// stored handle still names that id, so the pane reads as missing - the
		// row wears the failure badge, and Goto focuses nothing. The clock sits
		// past the startup grace: the Agent is gone, not booting.
		const state = reopenState(":memory:", () => Date.now() - 60_000);
		const runner = new FakeRunner();
		const source = { name: "issues", kind: "github-issues" as const };
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const identity = "github:github.com:I_5";
		try {
			state.sourceFact.initializeSources([source]);
			state.sourceFact.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T10:01:00Z",
				tickets: [fetchedTicket({ identity })],
			});
			const claim = state.handoff.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			// A legacy-style handoff: no herdr name recorded, so the identity the
			// pane is read against is the ticket's stable name.
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.markTicketRunning(identity);
			// The Consultation's agent works in the ticket's reused pane id.
			runner.set("herdr", ["agent", "list"], {
				stdout: agentListJson([
					{
						paneId: "pane-1",
						tabId: "tab-1",
						workspaceId: "ws-1",
						agent: "factory",
						status: "working",
						name: "consultation-27e1542c",
					},
				]),
			});

			const planeRecord = await plane({
				existing: state,
				groupingAxis: "none",
				sources: [{ config: sourceConfig, tickets: [] }],
				config: { ...BASE_CONFIG, sources: [sourceConfig] },
				settledReads: false,
				runner: () => runner,
			});
			await withApp(
				async (setup) => {
					// The row wears the missing badge, not the [running] state badge:
					// the agent the last poll listed in the pane is not the
					// ticket's own.
					const frame = await waitFor(setup, { shows: "missing" });
					// The selected list row wears the failure badge in the state
					// badge's place, so the row holds no [running] badge of its own. The
					// detail pane beside it wears the same word: one fact record answers
					// both surfaces, and a running Ticket whose Agent is gone reads as
					// missing on both (issue #201, story 5).
					const listRow = listHalfOf(rowsOf(frame)[markerRowOf(frame)]);
					expect(listRow).toContain("missing");
					expect(listRow).not.toContain("[running]");
					const detail = detailPaneText(frame);
					expect(detail).toContain("missing");
					expect(detail).not.toContain("[running]");
					// Goto refuses: the catalogue reads the pane as not alive, the
					// refusal stands on the Message line, and the focus never runs.
					await guideKey(setup, "ticket-goto", "g", { quiet: true });
					const after = await settle(setup);
					expect(messageRowOf(after)).toContain("the Agent's pane is not alive in the last poll");
					expect(runner.commands()).not.toContain("herdr agent focus pane-1");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});

	test("Goto refuses an awaiting ticket whose recorded pane holds a foreign agent", async () => {
		// The same fact one state later: the ticket settled into awaiting, and
		// its recorded pane now holds a Consultation's agent. ADR 0033's
		// recorded-pane standing gives way to the identity: the base key
		// refuses, and the decision's Goto row refuses the same focus.
		const state = reopenState(":memory:");
		const runner = new FakeRunner();
		const source = { name: "issues", kind: "github-issues" as const };
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const identity = "github:github.com:I_5";
		try {
			state.sourceFact.initializeSources([source]);
			state.sourceFact.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T10:01:00Z",
				tickets: [fetchedTicket({ identity })],
			});
			const claim = state.handoff.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.markTicketRunning(identity);
			// The turn settles with no decided cause: the ticket rests awaiting
			// on its pending turn, its recorded pane still pane-1.
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "settled the turn",
				turnLog: [{ kind: "text", text: "settled the turn" }],
				completedAt: "2026-08-31T12:00:00Z",
			});
			// The Consultation's agent works in the ticket's recorded pane id.
			runner.set("herdr", ["agent", "list"], {
				stdout: agentListJson([
					{
						paneId: "pane-1",
						tabId: "tab-1",
						workspaceId: "ws-1",
						agent: "factory",
						status: "working",
						name: "consultation-27e1542c",
					},
				]),
			});

			const planeRecord = await plane({
				existing: state,
				groupingAxis: "none",
				sources: [{ config: sourceConfig, tickets: [] }],
				config: { ...BASE_CONFIG, sources: [sourceConfig] },
				settledReads: false,
				runner: () => runner,
			});
			await withApp(
				async (setup) => {
					await waitFor(setup, { shows: "[awaiting]" });
					// The base key refuses: the recorded pane holds a live agent
					// that is not the ticket's own, so the focus never runs.
					await guideKey(setup, "ticket-goto", "g", { quiet: true });
					let frame = await settle(setup);
					expect(messageRowOf(frame)).toContain("the Agent's pane is not alive in the last poll");
					expect(runner.commands()).not.toContain("herdr agent focus pane-1");
					// The decision's own Goto row refuses the same focus: open the
					// decision, walk down to the Goto row, and confirm it. The row
					// is awaiting, whose bar documents the Decide's Enter, not the
					// handoff's hint: the key is the catalogue's escape.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					await waitFor(setup, { shows: "Decision:" });
					await guideKey(setup, "select-action", "↓", { quiet: true });
					await waitFor(setup, { shows: "❯ Goto" });
					// The frame is the decision modal, whose bar documents the
					// modal's own controls: the key is the catalogue's escape,
					// routed by the plane to the row's action.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					frame = await settle(setup);
					expect(messageRowOf(frame)).toContain(
						"the pane the handoff recorded is no longer the agent's pane",
					);
					expect(runner.commands()).not.toContain("herdr agent focus pane-1");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Close of a decided cycle closes the draft the ticket still wears (ADR 0076)", async () => {
		// The cycle-end draft close: the decided cycle's Close reads the
		// ticket's factory branch and closes the draft it carries. A published
		// pull request is never touched: only a draft closes, and a branch
		// that carries no draft closes nothing and says nothing.
		const state = reopenState(":memory:");
		const runner = new FakeRunner();
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const config = {
			...BASE_CONFIG,
			sources: [sourceConfig],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, opensPullRequest: true },
			},
		};
		const identity = "github:github.com:I_5";
		const branch = "factory/5-add-a-webhook-retry-policy";
		// The direct read of the branch's open pull request: a draft stands
		// on it, the way the plane opened it at the handoff's start.
		runner.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/acme/factory/pulls?state=open&head=${encodeURIComponent(`acme:${branch}`)}`,
			],
			{
				stdout: JSON.stringify([
					{
						number: 12,
						state: "open",
						draft: true,
						html_url: "https://github.com/acme/factory/pulls/12",
						head: { ref: branch },
						base: { ref: "main" },
						labels: [],
					},
				]),
			},
		);
		try {
			state.sourceFact.initializeSources([sourceConfig]);
			state.sourceFact.applyFetch(sourceConfig, fetchSuccess([issueTicket()]));
			const claim = state.handoff.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.markTicketRunning(identity);
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "settled the turn",
				turnLog: [{ kind: "text", text: "settled the turn" }],
				completedAt: "2026-08-31T12:00:00Z",
			});

			const planeRecord = await plane({
				existing: state,
				groupingAxis: "none",
				sources: [{ config: sourceConfig, tickets: [ticketOf(issueTicket())] }],
				config,
				settledReads: false,
				runner: () => runner,
			});
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					await waitFor(setup, { shows: "[awaiting]" });
					// The Close row: the decision's first row, selected by default.
					// The row is awaiting, whose bar documents the Decide's Enter,
					// not the handoff's hint: the key is the catalogue's escape.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					await waitFor(setup, { shows: "Decision:" });
					// The frame is the decision modal, whose bar documents the
					// modal's own controls: the key is the catalogue's escape,
					// routed by the plane to the Close row's action.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					await settle(setup);
					// The cycle ends decided: the draft the ticket still wears is
					// read off its factory branch and closed.
					const commands = runner.commands();
					expect(commands).toContain(
						`gh api --hostname github.com repos/acme/factory/pulls?state=open&head=${encodeURIComponent(
							`acme:${branch}`,
						)}`,
					);
					expect(commands).toContain("gh pr close 12 --repo github.com/acme/factory");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Abandon of a missing cycle closes the draft the ticket still wears (ADR 0076)", async () => {
		// The cycle-end draft close on the abandon route: the Missing modal's
		// Abandon ends the cycle of a ticket whose agent herdr no longer
		// lists, and the draft the ticket still wears is read off its factory
		// branch and closed, the way the decided cycle's Close does.
		const state = reopenState(":memory:", () => Date.now() - 60_000);
		const runner = new FakeRunner();
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const config = {
			...BASE_CONFIG,
			sources: [sourceConfig],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, opensPullRequest: true },
			},
		};
		const identity = "github:github.com:I_5";
		const branch = "factory/5-add-a-webhook-retry-policy";
		// The direct read of the branch's open pull request: a draft stands
		// on it, the way the plane opened it at the handoff's start.
		runner.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/acme/factory/pulls?state=open&head=${encodeURIComponent(`acme:${branch}`)}`,
			],
			{
				stdout: JSON.stringify([
					{
						number: 12,
						state: "open",
						draft: true,
						html_url: "https://github.com/acme/factory/pulls/12",
						head: { ref: branch },
						base: { ref: "main" },
						labels: [],
					},
				]),
			},
		);
		// The agent is gone: herdr lists no agent at all.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		try {
			state.sourceFact.initializeSources([sourceConfig]);
			state.sourceFact.applyFetch(sourceConfig, fetchSuccess([issueTicket()]));
			const claim = state.handoff.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			// The ticket stands running, and herdr lists no agent: the missing
			// badge the recovery screen offers on.
			state.ticketWorkCycle.markTicketRunning(identity);

			const planeRecord = await plane({
				existing: state,
				groupingAxis: "none",
				sources: [{ config: sourceConfig, tickets: [ticketOf(issueTicket())] }],
				config,
				settledReads: false,
				runner: () => runner,
			});
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					await waitFor(setup, { shows: "missing" });
					// The missing agent's recovery screen: Enter on the in-flight
					// ticket opens the modal, down selects the Abandon, and the
					// confirm ends the cycle. The row's bar documents the row's own
					// recovery Enter, not the handoff's hint: the key is the
					// catalogue's escape.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					await waitFor(setup, { shows: "Missing:" });
					await guideKey(setup, "select-action", "↓", { quiet: true });
					await waitFor(setup, { shows: "❯ Abandon" });
					// The frame is the Missing modal, whose bar documents the
					// modal's own key: the catalogue's escape, routed by the plane
					// to the Abandon row's action.
					await guideKey(setup, "handoff", "Enter", { quiet: true });
					const frame = await settle(setup);
					// The cycle ends abandoned: the draft the ticket still wears is
					// read off its factory branch and closed.
					const commands = runner.commands();
					expect(commands).toContain(
						`gh api --hostname github.com repos/acme/factory/pulls?state=open&head=${encodeURIComponent(
							`acme:${branch}`,
						)}`,
					);
					expect(commands).toContain("gh pr close 12 --repo github.com/acme/factory");
					expect(messageRowOf(frame)).toContain("abandoned");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});

	test("list pane shows every sample ticket with its state badge and repository", async () => {
		await withApp(async (setup) => {
			const frame = frameText(setup.captureCharFrame());
			for (const ticket of SAMPLE_TICKETS) {
				expect(frame).toContain(ticket.repository);
			}
			expectStateBadges(frame);
		});
	});

	test("detail pane shows the full detail of the selected ticket", async () => {
		await withApp(async (setup) => {
			const detail = detailPaneText(setup.captureCharFrame());
			// The list stands the selection on the first ticket the attention
			// band reads, the awaiting one, and the detail carries its full
			// facts.
			const first = SAMPLE_TICKETS[3];
			// The full title and description live in the detail pane.
			expect(detail).toContain(first.description);
			expect(detail).toContain("Agent: claude");
			expect(detail).toContain("Model: left to agent");
			expect(detail).toContain("Thinking: left to agent");
			// A setting the profile leaves out reads the same way: the agent's own
			// default is the only one the control plane does not know.
			expect(detail).toContain("Context: left to agent");
			expect(detail).toContain("Source state: closed");
			// The non-open ticket's task type line says which fact it is: the
			// handoff's own type, not a suggestion.
			expect(detail).toContain("Handoff task type: review");
			expect(detail).not.toContain("Suggested task type:");
		});
	});

	test("a ticket on a parking state wears the park, not a task type", async () => {
		// The machine's parking state offers no task (ADR 0027): the row and
		// the detail both state the park, so the operator reads why the plane
		// starts nothing.
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		// The State the config parks on offers no taskType, so the list rule
		// the plane reads stands the row as parked.
		const parkingConfig = {
			...BASE_CONFIG,
			sources: [sourceConfig],
			workflowStates: [
				...BASE_CONFIG.workflowStates,
				{ name: "parking", match: { labelsAny: ["parking"] } },
			],
		};
		const parked = ticketOf(issueTicket(undefined, { labels: ["parking"] }));
		const planeRecord = await plane({
			sources: [{ config: sourceConfig, tickets: [parked] }],
			config: parkingConfig,
		});
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				const frame = await waitFor(setup, { shows: "[parked]" });
				// The park is a machine fact, not a missing one: it wears no
				// warning color, unlike `unknown`.
				expect(detailPaneText(frame)).toContain("Suggested task type: parked");
			},
			{ plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the sample-data contract is observable in the rendered frame", async () => {
		await withApp(async (setup) => {
			// Every ticket state is on screen at once.
			let frame = frameText(setup.captureCharFrame());
			expectStateBadges(frame);

			// The sample set spans more than one repository, read off the
			// frame, not the data.
			const repos = new Set([...frame.matchAll(/\b[a-z]+\/[a-z-]+\b/g)].map((m) => m[0]));
			expect(repos.size).toBeGreaterThanOrEqual(2);

			// A ticket can carry the GitHub closed status: the attention band
			// stands the selection on the awaiting ticket at boot, and the
			// source fact reads in the detail pane.
			frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Source state: closed");
			// The awaiting ticket is done with its turn: ticket state and
			// GitHub status stay distinct facts.
			expect(frame).toContain("[awaiting]");
		});
	});

	test("j and k move the selection down and up", async () => {
		await withApp(async (setup) => {
			// The attention band stands the selection on the awaiting ticket,
			// the list's first row.
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(
				setup,
				"the selection to move to the running ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[2]) && !showsTicket(f, SAMPLE_TICKETS[3]),
			);
			await pressControl(setup, "move-list", { via: "↑", quiet: true });
			await frameUntil(
				setup,
				"the selection to move back to the awaiting ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[3]) && !showsTicket(f, SAMPLE_TICKETS[2]),
			);
		});
	});

	test("the up and down arrows move the selection", async () => {
		await withApp(async (setup) => {
			// The attention band stands the selection on the awaiting ticket,
			// the list's first row.
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(setup, "the selection to move to the running ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[2]),
			);
			await pressControl(setup, "move-list", { via: "↑", quiet: true });
			await frameUntil(
				setup,
				"the selection to move back to the awaiting ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[3]) && !showsTicket(f, SAMPLE_TICKETS[2]),
			);
		});
	});

	test("l and h switch pane focus and the vertical keys stay with the focus", async () => {
		await withApp(async (setup) => {
			// Focus starts on the list pane.
			let frame = setup.captureCharFrame();
			expect(frame).toContain("❯ Tickets");
			expect(frame).not.toContain("❯ Detail");

			// l moves the focus to the detail pane.
			frame = await guideKey(setup, "detail", "l", { quiet: true });

			// j with the detail focused cannot scroll at this size. The
			// catalogue reports its unavailable reason on the Message line;
			// it does not move the selected Ticket. The frame's bar documents
			// the detail's scroll keys, not the list's Move hint: the key is
			// the catalogue's escape, routed by the plane to the focused pane.
			await guideKey(setup, "move-list", "↓", { quiet: true });
			const after = await waitFor(setup, { shows: "the Ticket detail has nowhere to scroll" });
			expect(markerRowOf(after)).toBe(3);

			// h moves the focus back to the list pane; the selection is
			// preserved.
			frame = await guideKey(setup, "tickets", "h", { quiet: true });
			await frameUntil(setup, "the list pane to take focus", listFocused);
			expect(markerRowOf(frame)).toBe(3);
			expect(showsTicket(frame, SAMPLE_TICKETS[3])).toBe(true);
		});
	});

	test("the left and right arrows switch pane focus and the selection is preserved", async () => {
		await withApp(async (setup) => {
			// Move the selection to the list's second row while the list is
			// focused.
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(
				setup,
				"the selection to move to the second row",
				(f) => showsTicket(f, SAMPLE_TICKETS[2]) && markerRowOf(f) === 4,
			);

			// The right arrow focuses the detail pane. The selection is
			// preserved: the marker stays on the second row and the detail
			// still shows the second ticket.
			await guideKey(setup, "detail", "→", { quiet: true });
			const right = await frameUntil(setup, "the detail pane to take focus", detailFocused);
			expect(markerRowOf(right)).toBe(4);
			expect(showsTicket(right, SAMPLE_TICKETS[2])).toBe(true);

			// The left arrow focuses the list pane. The selection is
			// preserved.
			await guideKey(setup, "tickets", "←", { quiet: true });
			const left = await frameUntil(setup, "the list pane to take focus", listFocused);
			expect(markerRowOf(left)).toBe(4);
			expect(showsTicket(left, SAMPLE_TICKETS[2])).toBe(true);
		});
	});

	test("a mouse click moves the pane focus and the borders follow", async () => {
		await withApp(async (setup) => {
			// The list box ends at half the terminal width; the detail box's
			// left border sits one cell further right.
			const detailX = Math.floor(WIDTH / 2);

			// Click the detail pane: it takes the app focus and paints its
			// border with the focused color; the list border relaxes.
			await mouseClick(setup, detailX + 10, paneRow(5));
			await frameUntil(setup, "the detail pane to take click focus", detailFocused);
			expect(cellColors(setup, detailX, paneRow(0)).fg).toEqual(rgb(roleColor("accent")));
			expect(cellColors(setup, 0, paneRow(0)).fg).toEqual(rgb(roleColor("surface_dim")));

			// Click the list pane: the focus moves and the detail border
			// follows. The first click also gave the detail's scroll box
			// OpenTUI's own focus; the deactivated border must not keep the
			// focused color.
			await mouseClick(setup, 10, paneRow(5));
			await frameUntil(setup, "the list pane to take click focus", listFocused);
			expect(cellColors(setup, 0, paneRow(0)).fg).toEqual(rgb(roleColor("accent")));
			expect(cellColors(setup, detailX, paneRow(0)).fg).toEqual(rgb(roleColor("surface_dim")));
		});
	});

	test("a right press activates no pane: both panes share one mouse policy", async () => {
		await withApp(async (setup) => {
			// The detail pane once took focus on any mouse event. The shared
			// policy activates only on a left press or a vertical wheel, so a
			// right press over the detail changes nothing.
			const before = setup.captureCharFrame();
			await mousePress(setup, Math.floor(WIDTH / 2) + 10, paneRow(5), MouseButtons.RIGHT);
			expect(stillFrame(await settle(setup))).toBe(stillFrame(before));
		});
	});

	test("j and k scroll the detail pane when it is focused", async () => {
		await withApp(
			async (setup) => {
				// Focus the detail pane; the list keeps its selection.
				await guideKey(setup, "detail", "l", { quiet: true });
				const agentRow = agentRowOf(setup.captureCharFrame());
				expect(agentRow).toBeGreaterThan(0);
				expect(markerRowOf(setup.captureCharFrame())).toBe(3);

				// j translates the native surface one terminal row. The top padding
				// scrolls away first, and every mounted content row moves together.
				// The frame's bar documents the detail's scroll keys, not the
				// list's Move hint: the key is the catalogue's escape, routed by
				// the plane to the focused pane.
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const scrolled = await frameUntil(
					setup,
					"the detail to scroll down one row",
					(f) => agentRowOf(f) === agentRow - 1 && f.includes("Drop the legacy auth shim"),
				);
				// The selection did not move.
				expect(markerRowOf(scrolled)).toBe(3);

				// k scrolls back to the top. The title is back. The key is the
				// catalogue's escape, for the same reason as the down key above.
				await guideKey(setup, "move-list", "↑", { quiet: true });
				const back = await frameUntil(
					setup,
					"the detail to scroll back to the top",
					(f) => agentRowOf(f) === agentRow && f.includes("Drop the legacy auth shim"),
				);
				expect(markerRowOf(back)).toBe(3);
			},
			{ width: 60, height: 27 },
		);
	});

	test("the detail scroll stays within its bounds", async () => {
		await withApp(
			async (setup) => {
				await guideKey(setup, "detail", "l", { quiet: true });

				// At the top edge, k cannot scroll up. The detail-focused bar
				// documents the detail's scroll keys, so the key is the
				// catalogue's escape.
				const before = setup.captureCharFrame();
				await guideKey(setup, "move-list", "↑", { quiet: true });
				const afterTop = await settle(setup);
				expect(stillFrame(afterTop)).toBe(stillFrame(before));

				// Press j past the bottom edge, one key at a time. The detail
				// settles on its last page: the final description line is
				// visible and the title is out of view.
				for (let i = 0; i < 30; i += 1) {
					// The detail-focused bar documents the detail's scroll keys,
					// so each down key is the catalogue's escape.
					await guideKey(setup, "move-list", "↓", { quiet: true });
					await sleep(25);
				}
				const atBottom = await frameUntil(
					setup,
					"the detail to reach its bottom",
					(f) => frameText(f).includes("feature flag.") && !f.includes("Drop the legacy auth shim"),
				);

				// One more j at the bottom edge changes nothing. The key is the
				// catalogue's escape, for the same reason as the loop above.
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const afterBottom = await settle(setup);
				expect(stillFrame(afterBottom)).toBe(stillFrame(atBottom));

				// The selection never moved.
				expect(markerRowOf(atBottom)).toBe(3);
			},
			{ width: 60, height: 27 },
		);
	});

	test("q ends the app", async () => {
		// The app destroys the renderer itself, so this test does not
		// wrap the body in withApp.
		const setup = await bootApp();
		const destroyed = new Promise<boolean>((resolve) => {
			setup.renderer.once(CliRenderEvents.DESTROY, () => resolve(true));
			setTimeout(() => resolve(false), 2000).unref();
		});
		await quitApp(setup, { quiet: true });
		expect(await destroyed).toBe(true);
	});

	test("the list pane window slides when the tickets overflow the pane", async () => {
		await withApp(
			async (setup) => {
				// The pane shows six rows at this height: the first six
				// tickets only, the two trailing ones off the window. The rows
				// carry their state and task type badges as their identity, so
				// a slide is visible in the badges even where a title wraps or
				// truncates. The handed-off ticket wears its Starting window's
				// spinner face in place of the badge it replaced (ADR 0030).
				let frame = frameText(setup.captureCharFrame());
				expect(startingFaceOf(frame)).not.toBeNull();
				expect(frame).toContain("[awaiting]");
				expect(frame).not.toContain("Ticket id");

				// Moving the selection slides the window: enough slides bring
				// the later tickets in and drop the oldest rows out.
				for (let i = 0; i < 6; i += 1) {
					await pressControl(setup, "move-list", { via: "↓", quiet: true });
					frame = frameText(await settle(setup));
				}
				expect(frame).toContain("[open]");
				expect(frame).not.toContain("[awaiting]");
				expect(frame).not.toContain("Drop the lega");

				frame = await pageKey(setup, "end", { quiet: true });
				await frameUntil(setup, "the window to slide to the last tickets", (f) =>
					(rowsOf(f).find((row) => row.startsWith("│ ❯")) ?? "").includes("Ticket id"),
				);
				expect(frame).toContain("Observe the agent");
				expect(frame).not.toContain("Drop the legacy");
			},
			{ width: WIDTH, height: 27 },
		);
	});

	test("resizing the terminal keeps the panes on the grid and the selection", async () => {
		await withApp(async (setup) => {
			// Move the selection so the resize has something to preserve.
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(
				setup,
				"the selection to move to the second row",
				(f) => showsTicket(f, SAMPLE_TICKETS[2]) && markerRowOf(f) === 4,
			);
			// The badge rides on the selected row at this width.
			expect(setup.captureCharFrame()).toContain("[fix]");

			// Shrink the terminal mid-session, across a width where the badge
			// no longer fits. The new size lands in two renders: the outer
			// grid first, the panes' row geometry second. Wait on the row
			// geometry itself: in the 60-wide layout the [implement] badge
			// and the repository have dropped from the list rows, and the
			// short [fix] badge still rides.
			setup.resize(60, 27);
			const small = await frameUntil(setup, "the frame to take the new size", (f) => {
				const rows = rowsOf(f);
				if (
					rows.length !== 27 ||
					!rows.every((row) => row.length === 60) ||
					!f.includes("Tickets") ||
					!f.includes("Detail") ||
					!f.includes("[fix] Migrat")
				)
					return false;
				// The ticket list's own rows only: the box between its top
				// border and its bottom border. The section headers below
				// carry no pane-divider, so a whole-row check would read
				// the detail pane's text into the list.
				const top = rows.findIndex((row) => row.includes("❯ Tickets"));
				const bottom = rows.slice(top).findIndex((row) => row.startsWith("└"));
				const listRows = rows.slice(top, top + bottom);
				return listRows.every((row) => {
					const half = listHalfOf(row);
					return !half.includes("[implement]") && !half.includes("acme/");
				});
			});
			// Both panes and the selection survive the resize.
			expect(small).toContain("Tickets");
			expect(small).toContain("Detail");
			expect(markerRowOf(small)).toBe(4);
			// The badge drops at this width; the repository already did.
			expect(small).not.toContain("[implement]");

			// The detail pane keeps its focus, and its scroll survives.
			await guideKey(setup, "detail", "l", { quiet: true });
			await frameUntil(setup, "the focus to move to the detail pane", detailFocused);
			const selectedAgentRow = (frame: string) =>
				rowsOf(frame).findIndex((row) => row.includes("Agent: pi"));
			const agentBeforeScroll = selectedAgentRow(setup.captureCharFrame());
			// The detail-focused bar documents the detail's scroll keys, not
			// the list's Move hint: the key is the catalogue's escape, routed
			// by the plane to the focused pane.
			await guideKey(setup, "move-list", "↓", { quiet: true });
			await frameUntil(
				setup,
				"the detail surface to translate by one row",
				(f) => selectedAgentRow(f) === agentBeforeScroll - 1,
			);
			const scrolled = await settle(setup);
			expect(detailFocused(scrolled)).toBe(true);
			expect(selectedAgentRow(scrolled)).toBe(agentBeforeScroll - 1);

			// Grow it back, waiting on the settled row geometry: the 120-wide
			// layout rides the badge and the repository in the open ticket's
			// row.
			setup.resize(120, 30);
			const large = await frameUntil(
				setup,
				"the frame to take the original size",
				(f) =>
					rowsOf(f).length === 30 &&
					rowsOf(f).every((row) => row.length === 120) &&
					f.includes("Tickets") &&
					f.includes("Detail") &&
					f.includes("[implement] Retry policy for  acme/billing"),
			);
			expect(large).toContain("Tickets");
			expect(large).toContain("Detail");
			expect(markerRowOf(large)).toBe(4);
			expect(showsTicket(large, SAMPLE_TICKETS[2])).toBe(true);
			// The badge comes back, the focus stays, and the detail scroll
			// clamps to the window that now fits the whole ticket.
			expect(large).toContain("[implement]");
			expect(detailFocused(large)).toBe(true);
			expect(detailPaneText(large)).toContain(SAMPLE_TICKETS[2].title);
		});
	});

	test("the layout adapts to the terminal size", async () => {
		for (const [width, height] of [
			[80, 27],
			[160, 40],
		]) {
			await withApp(
				async (setup) => {
					const rows = rowsOf(setup.captureCharFrame());
					expect(rows).toHaveLength(height);
					for (const row of rows) {
						expect(row.length).toBe(width);
					}
					// Both panes and every sample state survive at this size.
					const frame = frameText(setup.captureCharFrame());
					expect(frame).toContain("Tickets");
					expect(frame).toContain("Detail");
					expectStateBadges(frame);
				},
				{ width: width, height: height },
			);
		}
	});

	test("odd terminal widths keep the row width and the pane padding intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(27);
				for (const row of rows) {
					expect(row.length).toBe(75);
				} // The test runs without factory state, so no mode cell stands:
				// row 0 carries the section header and the detail's top border,
				// and the Ticket box runs from row 1 to row 10. The split puts
				// the list box on columns 0-36 and the detail box on 37-74. At
				// an odd width a "50%" list would take 38 columns, and the shared
				// geometry would then lay text one cell off the rendered box.
				for (const row of rows.slice(2, 10)) {
					expect(row[0]).toBe("│");
					expect(row[36]).toBe("│");
					expect(row[37]).toBe("│");
					expect(row[74]).toBe("│");
					// One cell of padding between every border and the text:
					// no text cell sits adjacent to a border.
					expect(row[1]).toBe(" ");
					expect(row[35]).toBe(" ");
					expect(row[38]).toBe(" ");
					// The detail's right padding cell is the native scrollbar
					// gutter: blank, track, or thumb.
					expect(row[73]).toMatch(/[ ▀▄█]/);
				}
				// The detail pane carries its content at this size.
				expect(frameText(setup.captureCharFrame())).toContain("Source state: closed");
			},
			{ width: 75, height: 27 },
		);
	});

	test("list rows keep the title and drop the repository when the row cannot hold both", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(27);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(60);
				}
				// At this width the row budget after the badge cannot hold
				// both the repository and a readable title. The title keeps
				// its space, and the repository drops from the list row instead
				// of pushing the title out. The Starting window's face holds
				// the badge's own cells (ADR 0030).
				const row = rows.find((r) => startingFaceOf(r) !== null);
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// face, gap, and the title cut to the cells the row still has.
				const listHalf = (row ?? "").slice(2, 28);
				expect(listHalf).toMatch(new RegExp(`^  ${SPINNER_GLYPH} starting   Fix pan dri$`));
				expect(listHalf).not.toContain("acme/");
				// The repository stays reachable in the detail pane of the
				// selected ticket.
				expect(frameText(setup.captureCharFrame())).toContain("acme/portal");
			},
			{ width: 60, height: 27 },
		);
	});

	test("narrow terminals drop fields instead of corrupting rows", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(27);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(40);
				}
				// The list row for the handed-off ticket keeps its fields in
				// order. The repository, which no longer fits, is dropped from
				// the list rows instead of interleaved into them.
				const row = rows.find((r) => startingFaceOf(r) !== null);
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// marker, face, gap, and the title cut to the one cell left.
				const listHalf = (row ?? "").slice(2, 18);
				expect(listHalf).toMatch(new RegExp(`^  ${SPINNER_GLYPH} starting   F$`));
				// The repository is dropped from the row, not interleaved into it.
				expect(listHalf).not.toContain("acme/");
			},
			{ width: 40, height: 27 },
		);
	});

	test("each list row carries the task type badge between the state badge and the title", async () => {
		await withApp(async (setup) => {
			const frame = setup.captureCharFrame();
			const rows = rowsOf(frame);
			const row = (ticket: Ticket) =>
				listHalfOf(rows.find((r) => listHalfOf(r).includes(ticket.title.slice(0, 8))) as string);

			// The selected ticket wears its task type badge, and every field
			// rides in the row's fixed order.
			const first = SAMPLE_TICKETS[3];
			expect(row(first).slice(2, 16)).toBe("❯ [awaiting]  ");
			expect(row(first).slice(16, 24)).toBe("[review]");
			expect(row(first).slice(24, 45)).toBe(" Drop the legacy auth");
			expect(row(first).slice(45, 58)).toBe("  acme/portal");

			// The other tickets wear the badges their rows carry: the open
			// ones their suggestions, the Starting window's row its face
			// beside the badge it does not replace.
			expect(row(SAMPLE_TICKETS[0]).slice(16, 27)).toBe("[implement]");
			expect(row(SAMPLE_TICKETS[1]).slice(16, 27)).toBe("[implement]");
			expect(row(SAMPLE_TICKETS[2]).slice(16, 21)).toBe("[fix]");
		});
	});

	test("an open ticket wears its suggestion, not a stale handoff value", async () => {
		// A ticket that was handed off, returned, and opened again: the row
		// must describe the next handoff, not the closed one.
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/portal"],
			host: "github.com",
		};
		const portalSourceConfig = sourceConfig;
		// The closed review cycle the ticket wore: the seed moves it through
		// the state module, so the row the list rule reads is the open ticket
		// with one closed handoff, and its suggestion stands from the config's
		// fallback, not from the closed cycle's type.
		const stale = ticketOf(
			issueTicket("github:github.com:I_2", {
				title: "Fix pan drift in split panes",
				repository: {
					identity: "github.com/acme/portal",
					displayName: "acme/portal",
					cloneUrl: "https://github.com/acme/portal.git",
				},
			}),
			{
				handoff: {
					agentType: "pi",
					environment: "worktree",
					taskType: "review",
					model: "",
					thinking: "",
					contextWindow: "",
					attemptId: "attempt-1",
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "w-1",
					herdrName: "sample-agent",
					startedAt: "2026-01-01T00:00:00Z",
				},
				handoffCount: 1,
			},
		);
		const planeRecord = await plane({
			sources: [{ config: portalSourceConfig, tickets: [stale] }],
			config: { ...BASE_CONFIG, sources: [portalSourceConfig] },
		});
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[open]")) as string);
				expect(line).toBe("│ ❯ [open]      [implement] Fix pan drift in s acme/portal │");
				const detail = detailPaneText(frame);
				expect(detail).toContain("Suggested task type: implement");
				expect(detail).not.toContain("Handoff task type:");
			},
			{ width: WIDTH, height: 30, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a non-open ticket keeps its handoff value when the suggestion differs", async () => {
		// The awaiting review cycle the sample stands on: the seed moves the
		// ticket through the state module, so the handoff the row reads is the
		// live one the state keeps, not a stored value.
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/portal"],
			host: "github.com",
		};
		const planeRecord = await plane({
			sources: [{ config: sourceConfig, tickets: [SAMPLE_TICKETS[3]] }],
			config: { ...BASE_CONFIG, sources: [sourceConfig] },
		});
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				const line = listHalfOf(rows.find((r) => listHalfOf(r).includes("[awaiting]")) as string);
				expect(line).toBe("│ ❯ [awaiting]  [review] Drop the legacy auth  acme/portal │");
				const detail = detailPaneText(frame);
				expect(detail).toContain("Handoff task type: review");
				expect(detail).not.toContain("Suggested task type:");
			},
			{ width: WIDTH, height: 30, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("non-actionable and recovery-required tickets keep their task type lines", async () => {
		// Two pull requests the source lists: both match the ready-for-review
		// State, so both stand on the review type. The blocked one stands on
		// the source's failure the boot fetch reports; the recovery one on an
		// attempt the start claimed and never settled.
		const state = reopenState(":memory:");
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const definition = { name: "issues", kind: "github-issues" as const };
		const fetchedOver = {
			sourceKind: "github-pull-request" as const,
			labels: ["ready-for-review"],
		};
		const blockedFetched = issueTicket("github:github.com:I_5", fetchedOver);
		const recoveryFetched = issueTicket("github:github.com:I_6", fetchedOver);
		state.sourceFact.initializeSources([definition]);
		state.sourceFact.applyFetch(definition, fetchSuccess([blockedFetched, recoveryFetched]));
		// The recovery ticket's start was claimed and never settled: the
		// attempt stands unresolved, and the plane asks for recovery before
		// it hands the ticket off again.
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_6",
			{
				agentType: "pi",
				environment: "worktree",
				taskType: "review",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		const planeRecord = await plane({
			existing: state,
			sources: [
				{ config: sourceConfig, tickets: [ticketOf(blockedFetched), ticketOf(recoveryFetched)] },
			],
			config: { ...BASE_CONFIG, sources: [sourceConfig] },
			groupingAxis: "none",
			settledReads: false,
		});
		await withApp(
			async (setup) => {
				const source = planeRecord.sources[0] as FakeSource;
				// The source stands on a failure: the rows stop being actionable,
				// and the list rule keeps standing them on their suggestion.
				source.settle(fetchRateLimited);
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				// Both rows wear the review type: the blocked one its
				// suggestion, the recovery one its live handoff's.
				expect(rows.filter((r) => listHalfOf(r).includes("[review]")).length).toBe(2);
				// The detail says so for the selected, blocked ticket.
				expect(detailPaneText(frame)).toContain("Suggested task type: review");

				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to move to the recovery ticket", (f) =>
					detailPaneText(f).includes("Handoff: recovery required"),
				);
				const detail = detailPaneText(setup.captureCharFrame());
				expect(detail).toContain("Handoff: recovery required");
				expect(detail).toContain("Suggested task type: review");
			},
			{ width: WIDTH, height: 30, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("configured task types share one neutral badge style", async () => {
		await withApp(async (setup) => {
			const neutral = rgb(roleColor("text"));
			expect(spanColors(setup, "[implement]")).toEqual([neutral]);
			expect(spanColors(setup, "[fix]")).toEqual([neutral]);
			expect(spanColors(setup, "[review]")).toEqual([neutral]);
		});
	});

	test("the badge is complete or absent as the width changes, never truncated", async () => {
		const selectedRowAt = async (width: number, height: number): Promise<string> => {
			let row = "";
			await withApp(
				async (setup) => {
					const frame = setup.captureCharFrame();
					const rows = rowsOf(frame);
					expect(rows).toHaveLength(height);
					// Every terminal row is exactly as wide as the terminal:
					// nothing wrapped or overflowed.
					for (const r of rows) {
						expect(stringWidth(r)).toBe(width);
					}
					row = listHalfOf(rows[markerRowOf(frame)]);
				},
				{ width: width, height: height },
			);
			return row;
		};

		// 120: marker, state, badge, title, and repository all ride.
		expect(await selectedRowAt(120, 30)).toBe(
			"│ ❯ [awaiting]  [review] Drop the legacy auth  acme/portal │",
		);
		// 80: the badge and the repository keep their places; the title
		// truncates to the cells that remain.
		expect(await selectedRowAt(80, 27)).toBe("│ ❯ [awaiting]  [review] D acme/portal │");
		// 60: the repository no longer fits beside the title minimum, so it
		// drops complete. The badge still rides.
		const narrow = await selectedRowAt(60, 27);
		expect(narrow).toBe("│ ❯ [awaiting]  [review] Dro │");
		// 40: nothing but the marker, the state badge, and one title cell
		// fits.
		expect(await selectedRowAt(40, 27)).toBe("│ ❯ [awaiting]   D │");
	});

	test("the badge drops when its complete text cannot fit, and the detail keeps the value", async () => {
		await withApp(
			async (setup) => {
				// Select the Starting-window ticket: its row is where the
				// [implement] badge and the title minimum do not share the cells
				// the row has left, so the badge drops and the title keeps the
				// cells.
				const faceOnMarkerRow = (f: string) =>
					startingFaceOf(listHalfOf(rowsOf(f).find((r) => r.startsWith("│ ❯")) as string)) !== null;
				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to pass the running ticket", (f) =>
					showsTicket(f, SAMPLE_TICKETS[2]),
				);
				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to reach the Starting window", faceOnMarkerRow);
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				const line = listHalfOf(rows.find((r) => startingFaceOf(listHalfOf(r)) !== null) as string);
				expect(line).toMatch(new RegExp(`^│ ❯ ${SPINNER_GLYPH} starting   Fix pan dri │$`));
				expect(line).not.toContain("[implem");
				// The detail carries the full value the row dropped. Its profile
				// rows take the short viewport first, so scroll down to the Task
				// type row instead of assuming it is initially visible.
				await guideKey(setup, "detail", "l", { quiet: true });
				const detail = await detailLineUntil(setup, "the handoff task type line", (candidate) =>
					detailPaneText(candidate, 60).includes("Handoff task type: implement"),
				);
				expect(detailPaneText(detail, 60)).toContain("Handoff task type: implement");
			},
			{ width: 60, height: 27 },
		);
	});

	test("a long task type and wide Unicode titles keep every row exact", async () => {
		const sourceConfig = {
			name: "issues",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/billing"],
			host: "github.com",
		};
		// The State the ticket's label matches offers the consultation task,
		// so the plane stands the suggestion from the machine, not a stored
		// value.
		const longConfig = {
			...BASE_CONFIG,
			sources: [sourceConfig],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				consultation: { template: "Consult the record.", autoClose: false },
			},
			workflowStates: [
				...BASE_CONFIG.workflowStates,
				{ name: "consultation", taskType: "consultation", match: { labelsAny: ["consultation"] } },
			],
		};
		const wide = ticketOf(
			issueTicket("github:github.com:I_wide", {
				title: "中文 webhook 重试策略",
				labels: ["consultation"],
				repository: {
					identity: "github.com/acme/billing",
					displayName: "acme/billing",
					cloneUrl: "https://github.com/acme/billing.git",
				},
			}),
		);
		const planeRecord = await plane({
			sources: [{ config: sourceConfig, tickets: [wide] }],
			config: longConfig,
		});

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				// At the normal width the long badge rides complete, and the
				// wide title truncates on cell boundaries without splitting a
				// character.
				const rows = rowsOf(setup.captureCharFrame());
				for (const r of rows) {
					expect(stringWidth(r)).toBe(120);
				}
				expect(listHalfOf(rows[markerRowOf(setup.captureCharFrame())])).toBe(
					"│ ❯ [open]      [consultation] 中文 webhook   acme/billing │",
				);
				// The full value still lives in the detail pane. The value wraps
				// to its own line below the label, the right column's source
				// line between them.
				const detailRows = rowsOf(setup.captureCharFrame()).map((row) => row.slice(62, 118));
				const label = detailRows.findIndex((row) => row.includes("Suggested task type:"));
				expect(detailRows[label + 1] ?? "").toContain("consultation");
			},
			{ width: 120, height: 30, plane: planeRecord, loopPolicy: { kind: "held" } },
		);

		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				// At the narrow width the long badge cannot fit complete, so
				// it drops, and the row still keeps its exact width.
				const rows = rowsOf(setup.captureCharFrame());
				for (const r of rows) {
					expect(stringWidth(r)).toBe(60);
				}
				expect(listHalfOf(rows[markerRowOf(setup.captureCharFrame())])).toBe(
					"│ ❯ [open]       中文 webhoo │",
				);
				// The detail keeps the full value the row dropped. Its profile
				// rows take the short viewport first, so scroll down to the Task
				// type row instead of assuming it is initially visible.
				await guideKey(setup, "detail", "l", { quiet: true });
				await detailLineUntil(setup, "the suggested task type line", (candidate) =>
					detailPaneText(candidate, 60).includes("Suggested task type: consultation"),
				);
			},
			{ width: 60, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the detail pane carries one explicit task type line for every ticket", async () => {
		await withApp(async (setup) => {
			// The awaiting ticket the selection stands on: its recorded value,
			// labeled as a handoff.
			let detail = detailPaneText(setup.captureCharFrame());
			expect(detail).toContain("Handoff task type: review");
			expect(detail).not.toContain("Suggested task type:");

			// The open ticket: the suggestion, labeled as a suggestion.
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(setup, "the selection to pass the running ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[2]),
			);
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(setup, "the selection to pass the Starting window", (f) =>
				showsTicket(f, SAMPLE_TICKETS[1]),
			);
			await pressControl(setup, "move-list", { via: "↓", quiet: true });
			await frameUntil(
				setup,
				"the selection to reach the open ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[0]) && !showsTicket(f, SAMPLE_TICKETS[1]),
			);
			detail = detailPaneText(setup.captureCharFrame());
			expect(detail).toContain("Suggested task type: implement");
			expect(detail).not.toContain("Handoff task type:");

			// The running ticket: the live handoff's value, labeled as a handoff.
			await pressControl(setup, "move-list", { via: "↑", quiet: true });
			await frameUntil(setup, "the selection back past the Starting window", (f) =>
				showsTicket(f, SAMPLE_TICKETS[1]),
			);
			await pressControl(setup, "move-list", { via: "↑", quiet: true });
			await frameUntil(setup, "the selection back to the running ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[2]),
			);
			detail = detailPaneText(setup.captureCharFrame());
			expect(detail).toContain("Handoff task type: fix");
			expect(detail).not.toContain("Suggested task type:");
		});
	});

	test("detail keyboard paging and direct edges use the native viewport", async () => {
		await withApp(
			async (setup) => {
				await guideKey(setup, "detail", "l", { quiet: true });
				const top = setup.captureCharFrame();
				await pageKey(setup, "pagedown", { quiet: true });
				const page = await waitFor(setup, { hides: "Drop the legacy auth shim" });
				expect(page).toContain("❯ [awaiting]");
				await pageKey(setup, "end", { quiet: true });
				const end = await waitFor(setup, { shows: "feature flag." });
				expect(end).toContain("❯ [awaiting]");
				await pageKey(setup, "home", { quiet: true });
				const home = await waitFor(setup, { shows: "Drop the legacy auth shim" });
				await pageKey(setup, "home", { quiet: true });
				expect(stillFrame(await settle(setup))).toBe(stillFrame(home));
				expect(stillFrame(top)).not.toBe(stillFrame(page));
			},
			{ width: 60, height: 27 },
		);
	});

	test("list page and edge controls select tickets without a separate list scroll", async () => {
		await withApp(
			async (setup) => {
				const selectedState = (frame: string) =>
					rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "";
				// One page is six visible rows at this height: the page lands
				// on the seventh ticket.
				await pageKey(setup, "pagedown", { quiet: true });
				await frameUntil(setup, "the list to move one visible page", (frame) =>
					selectedState(frame).includes("Run the con"),
				);
				await pageKey(setup, "end", { quiet: true });
				await frameUntil(setup, "the list to select its last ticket", (frame) =>
					selectedState(frame).includes("Ticket id i"),
				);
				await pageKey(setup, "home", { quiet: true });
				await frameUntil(setup, "the list to select its first ticket", (frame) =>
					selectedState(frame).includes("Drop"),
				);
			},
			{ width: 60, height: 27 },
		);
	});

	test("mouse input focuses and moves its Ticket surface through OpenTUI hit testing", async () => {
		await withApp(
			async (setup) => {
				// A visible list row is a direct selection target: the
				// Starting window's row.
				await mouseClick(setup, 4, paneRow(4));
				await frameUntil(
					setup,
					"the clicked Ticket to become selected",
					(frame) =>
						listFocused(frame) &&
						startingFaceOf(rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "") !== null,
				);
				// List wheels select exactly one adjacent Ticket. They have no
				// detail speed profile or acceleration.
				await mouseWheel(setup, { x: 4, y: paneRow(4), direction: "down" });
				await frameUntil(
					setup,
					"one list wheel event to select one Ticket",
					(frame) =>
						listFocused(frame) &&
						(rowsOf(frame).find((row) => row.startsWith("│ ❯")) ?? "").includes("[open]"),
				);

				// Detail content receives a normal wheel event and takes focus.
				const before = setup.captureCharFrame();
				await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down" });
				const scrolled = await frameUntil(
					setup,
					"the detail wheel event to move its surface",
					(frame) => detailFocused(frame) && stillFrame(frame) !== stillFrame(before),
				);
				expect(markerRowOf(scrolled)).toBe(6);

				// Horizontal and Shift-wheel gestures are inert for wrapped detail text.
				const stable = setup.captureCharFrame();
				await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "left" });
				await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down", shift: true });
				expect(stillFrame(await settle(setup))).toBe(stillFrame(stable));
			},
			{ width: 60, height: 27 },
		);
	});

	test("a fitting detail reserves an empty gutter instead of a false scrollbar", async () => {
		await withApp(async (setup) => {
			const frame = setup.captureCharFrame();
			expect(frame).not.toMatch(/[▀▄█]/);
			// The final inner detail column remains blank: text uses the same
			// width before a later overflow makes the control visible.
			expect(rowsOf(frame)[paneRow(2)].at(-2)).toBe(" ");
		});
	});

	test("the overflowing detail has an interactive native scrollbar", async () => {
		await withApp(
			async (setup) => {
				// At this size the rightmost inner column is OpenTUI's thumb and
				// track. It is not present on a fitting detail.
				const initial = setup.captureCharFrame();
				expect(initial).toMatch(/[▀▄█]/);
				// The panes sit above the Message line and Action bar, so the
				// track spans the detail's inner rows below the thumb.
				await mouseClick(setup, 58, paneRow(4));
				const trackJump = await frameUntil(
					setup,
					"a scrollbar track click to jump to a proportional detail position",
					(frame) => detailFocused(frame) && frame !== initial,
				);
				expect(markerRowOf(trackJump)).toBe(3);
				const thumbRow = rowsOf(trackJump).findIndex((row) => /[▀▄█]/.test(row.slice(58, 59)));
				await mouseDrag(setup, [58, thumbRow], [58, paneRow(1)]);
				await waitFor(setup, { shows: "Drop the legacy auth shim" });
			},
			{ width: 60, height: 27 },
		);
	});

	test("a custom Config controls fixed detail key movement", async () => {
		const config = {
			...BASE_CONFIG,
			scroll: { speed: 2, acceleration: 0, maximumSpeed: 2 },
		};
		const planeRecord = await plane({ config });
		await withApp(
			async (setup) => {
				await guideKey(setup, "detail", "l", { quiet: true });
				const before = agentRowOf(setup.captureCharFrame());
				// The detail-focused bar documents the detail's scroll keys, so
				// the down key is the catalogue's escape, routed by the plane to
				// the focused pane.
				await guideKey(setup, "move-list", "↓", { quiet: true });
				await frameUntil(
					setup,
					"the detail to move by the configured two rows",
					(frame) => agentRowOf(frame) === before - 2,
				);
			},
			{ width: 60, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a custom Config controls the first detail wheel step", async () => {
		const config = {
			...BASE_CONFIG,
			scroll: { speed: 2, acceleration: 0, maximumSpeed: 2 },
		};
		const planeRecord = await plane({ config });
		await withApp(
			async (setup) => {
				const before = agentRowOf(setup.captureCharFrame());
				await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down" });
				await frameUntil(
					setup,
					"the configured linear wheel step to move two rows",
					(frame) => detailFocused(frame) && agentRowOf(frame) === before - 2,
				);
			},
			{ width: 60, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("a timed wheel burst accelerates the visible native detail surface", async () => {
		await withApp(
			async (setup) => {
				const wheelAt = async (now: number) => {
					const clock = spyOn(Date, "now").mockReturnValue(now);
					try {
						await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down" });
					} finally {
						clock.mockRestore();
					}
				};
				const start = agentRowOf(setup.captureCharFrame());
				await wheelAt(1_000);
				await frameUntil(
					setup,
					"the precise first wheel step",
					(frame) => detailFocused(frame) && agentRowOf(frame) === start - 1,
				);
				await wheelAt(1_050);
				await frameUntil(
					setup,
					"the accelerated second wheel step",
					(frame) => agentRowOf(frame) === start - 3,
				);
			},
			{ width: 60, height: 27 },
		);
	});

	test("rapid detail input records only complete native terminal frames", async () => {
		const config = {
			...BASE_CONFIG,
			scroll: { speed: 1, acceleration: 0, maximumSpeed: 1 },
		};
		const planeRecord = await plane({ config });
		await withApp(
			async (setup) => {
				const frames: string[] = [];
				const record = () => frames.push(setup.captureCharFrame());
				setup.renderer.on(CliRenderEvents.FRAME, record);
				try {
					for (let event = 0; event < 10; event += 1) {
						await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down" });
					}
					await sleep(80);
				} finally {
					setup.renderer.off(CliRenderEvents.FRAME, record);
				}
				expect(frames.length).toBeGreaterThan(0);
				for (const frame of frames) {
					const rows = rowsOf(frame);
					expect(rows).toHaveLength(27);
					expect(rows.every((row) => row.length === 60)).toBe(true);
					expect(rows[paneRow(0)]).toContain("┌");
					// The panes sit above the Message line and Action bar.
					expect(rows.at(-3)).toContain("└");
					expect(detailPaneText(frame, 60).trim()).not.toBe("");
				}
			},
			{ width: 60, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("mouse input below an open modal leaves both Ticket surfaces inert", async () => {
		const planeRecord = await plane({});
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				// The awaiting ticket the selection stands on offers no
				// override of its own: move to an open ticket before the
				// panel opens. At this height the descriptions sit below the
				// detail's fold, so the walk reads the selected row, not the
				// detail.
				const selectedRow = (f: string) => rowsOf(f).find((row) => row.startsWith("│ ❯")) ?? "";
				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to pass the running ticket", (f) =>
					selectedRow(f).includes("Migrat"),
				);
				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to pass the Starting window", (f) =>
					selectedRow(f).includes("Fix pan dri"),
				);
				await pressControl(setup, "move-list", { via: "↓", quiet: true });
				await frameUntil(setup, "the selection to reach the open ticket", (f) =>
					selectedRow(f).includes("Retry polic"),
				);
				// At 60 columns the bar packs the e hint away, so the press is
				// the catalogue's named escape. The open ticket owns the key and
				// the panel opens; the mouse input below it changes nothing.
				await guideKey(setup, "override", "e", { quiet: true });
				const before = setup.captureCharFrame();
				await mouseWheel(setup, { x: 45, y: paneRow(3), direction: "down" });
				await mouseClick(setup, 4, paneRow(3));
				expect(stillFrame(await settle(setup))).toBe(stillFrame(before));
			},
			{ width: 60, height: 27, plane: planeRecord, loopPolicy: { kind: "held" } },
		);
	});

	test("the Key guide the app opens lists the mode's controls above the global ones", async () => {
		// The operator's own path: the app's key handler opens the guide, and
		// the ordering the app computes is the ordering on screen. A hint
		// priority that moves reorders these rows.
		const state = reopenState(":memory:");
		const planeRecord = await plane({
			existing: state,
			groupingAxis: "none",
			sources: [],
			config: BASE_CONFIG,
		});
		try {
			await withApp(
				async (setup) => {
					const frame = await pressControl(setup, "help", { shows: "Key guide" });
					// The guide opens on this mode's section, and the sections
					// keep the catalogue's order on screen. A hint priority
					// that moves reorders these rows. The current section runs
					// past one window now that the grouping controls are
					// cataloged in it (issue #159), so the sections are read in
					// the order the walk to the bottom shows them.
					let rows = rowsOf(frame);
					let indexOf = (needle: string) => rows.findIndex((row) => row.includes(needle));
					const seen: string[] = [];
					const noteSections = (): void => {
						for (const row of rowsOf(setup.captureCharFrame())) noteRow(row);
					};
					const noteRow = (row: string): void => {
						for (const section of [
							"Current interaction mode",
							"Global controls",
							"Control plane controls",
						]) {
							if (row.includes(section) && !seen.includes(section)) seen.push(section);
						}
					};
					const modeIdx = indexOf("Current interaction mode");
					expect(modeIdx).toBeGreaterThan(0);
					const modeSection = rows.slice(modeIdx).join("\n");
					expect(modeSection).toContain("Move");
					expect(modeSection).toContain("Hand off");
					// The three meanings of Enter each keep their own row.
					expect(modeSection).toContain("Live view");
					expect(modeSection).toContain("Decide");
					// The Grouping axis and the Group fold join the mode's rows,
					// and the Global section sits below them: the walk finds it.
					expect(modeSection).toContain("Tab");
					expect(modeSection).toContain("Fold");
					noteSections();

					// The Control plane header sits below the opening window:
					// step the guide down until it and the Global section share
					// the view, then check their order on screen.
					for (let step = 0; step < 10; step += 1) {
						if (
							rowsOf(setup.captureCharFrame()).some((row) => row.includes("Control plane controls"))
						)
							break;
						// The frame is the Key guide, whose bar documents the
						// guide's own keys, not the list's Move hint: each step is
						// the catalogue's escape, routed by the plane to the guide
						// scroll.
						await guideKey(setup, "move-list", "↓", { quiet: true });
						await settle(setup);
					}
					for (let step = 0; step < 12 && !seen.includes("Control plane controls"); step += 1) {
						await guideKey(setup, "move-list", "↓", { quiet: true });
						await settle(setup);
						noteSections();
					}
					expect(seen).toEqual([
						"Current interaction mode",
						"Global controls",
						"Control plane controls",
					]);
					rows = rowsOf(setup.captureCharFrame());
					indexOf = (needle: string) => rows.findIndex((row) => row.includes(needle));
					const globalSection = rows
						.slice(indexOf("Global controls"), indexOf("Control plane controls"))
						.join("\n");
					expect(globalSection).toContain("Quit");
					// Closing the guide returns to the tickets view.
					await guideKey(setup, "guide-close", "Esc", { quiet: true });
					await waitFor(setup, { hides: "Key guide" });
				},
				{ width: WIDTH, height: 30, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});

	test("tiny terminals stay intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(8);
				for (const row of rows) {
					expect(row.length).toBe(8);
				}
			},
			{ width: 8, height: 8 },
		);
	});
});
