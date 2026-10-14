/**
 * The rendered frames driven by real sources and a real temporary state
 * database: loading, a successful empty refresh, a stale source, a removed
 * source, the source detail pane, the attention order, selection by
 * identity, the manual refresh, and the two refused-handoff states.
 *
 * Each test boots the real app with a fake ticket source (its fetches stay
 * in flight until the test settles them) and a real SQLite state, and
 * asserts only what an operator can see. No timer in this suite runs on
 * the system clock: every fetch the app starts is settled by the test.
 *
 * A settle only lands when the coordinator's chain reaches the state and
 * the app re-renders, so every test waits for the settle's visible effect
 * before it tears the app down.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";

import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	detailPaneText,
	frameUntil,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	pressControl,
	rowsOf,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import type { FakeSource } from "./fake-source.ts";
import { issuesSourceConfig, plane, reopenState } from "./plane.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function wrappedState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-frame-state-"));
	paths.push(dir);
	const state = reopenState(join(dir, "state.sqlite"));
	return state;
}

function ticket(
	identity = "github:github.com:I_5",
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Add a webhook retry policy",
		description: "Webhooks dropped during the outage were never redelivered.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

const success = (tickets: FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets,
});

const fetchRateLimited: FetchOutcome = { status: "failed", reason: "GitHub rate limit exceeded" };

const issuesConfig: FactoryConfig = {
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
};

/** The pulls source beside the shared issues source, on the same repository. */
const pullsSourceConfig: TicketSourceConfig = {
	name: "pulls",
	kind: "github-pull-requests",
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

const pullsConfig: FactoryConfig = {
	...issuesConfig,
	sources: [...issuesConfig.sources, pullsSourceConfig],
};

const HANDOFF_CHOICE = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

/**
 * Wait until the source has started its `calls`-th fetch.
 *
 * A key press is dispatched on the next frame, so a test must not settle
 * before the refresh it started has actually called the source: an early
 * settle has no in-flight fetch to resolve and the refresh hangs forever.
 */
async function callsReached(source: FakeSource, calls: number): Promise<void> {
	const deadline = Date.now() + 2000;
	for (;;) {
		if (source.calls >= calls) return;
		if (Date.now() >= deadline)
			throw new Error(`the source was called ${source.calls} times, wanted ${calls}`);
		await sleep(5);
	}
}

/** The row of a title inside the list pane only, so the detail pane cannot hide it. */
const listRowOf = (frame: string, title: string): number => {
	const listCols = Math.floor(WIDTH / 2);
	return rowsOf(frame).findIndex((row) => row.slice(0, listCols).includes(title));
};

describe("source-driven frames", () => {
	test("shows loading tickets while the first refresh runs, then the fetched work", async () => {
		// The plane holds its first fetch: the state stands without the source
		// rows, and the app's own fetch is the one the test settles.
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				const loading = await frameUntil(setup, "the loading state", (f) =>
					f.includes("loading tickets..."),
				);
				expect(loading).not.toContain("Add a webhook retry policy");

				source.settle(success([ticket()]));
				const settled = await frameUntil(setup, "the fetched ticket", (f) =>
					f.includes("Add a webhook retry policy"),
				);
				expect(settled).toContain("[open]");
				expect(settled).not.toContain("loading tickets...");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("shows no tickets match the configured sources after a successful empty refresh", async () => {
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([]));
				const frame = await frameUntil(setup, "the empty state", (f) =>
					f.includes("no tickets match the configured sources"),
				);
				expect(frame).not.toContain("loading tickets...");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("a failed refresh makes the source stale, keeps its tickets, and refuses a new handoff", async () => {
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				await frameUntil(setup, "the ticket", (f) => f.includes("Add a webhook retry policy"));

				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				source.settle(fetchRateLimited);
				const stale = await frameUntil(setup, "the stale health line", (f) =>
					f.includes("issues: stale - GitHub rate limit exceeded"),
				);
				// The prior snapshot stays visible.
				expect(stale).toContain("Add a webhook retry policy");

				await pressControl(setup, "handoff", { quiet: true });
				const refused = await frameUntil(setup, "the refused handoff", (f) =>
					f.includes("Ticket is not actionable because source data is stale"),
				);
				expect(messageRowOf(refused)).toContain(
					"Ticket is not actionable because source data is stale",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("a removed source keeps its handed-off ticket, drops its open ticket, and pins no warning", async () => {
		const state = wrappedState();
		const definition = { name: "issues", kind: "github-issues" };
		state.sourceFact.initializeSources([definition]);
		state.sourceFact.applyFetch(
			definition,
			success([
				ticket(),
				ticket("github:github.com:I_9", { externalKey: "#9", title: "Another open item" }),
			]),
		);
		const [first] = state.ticketWorkCycle.ticketListViews(
			BASE_CONFIG.workflowStates,
			BASE_CONFIG.defaultTaskType,
		).rows;
		const claim = state.handoff.claimHandoff(first.identity, HANDOFF_CHOICE, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		// The config no longer lists the source: a restart marks it removed.
		state.sourceFact.initializeSources([]);

		const planeRecord = await plane({
			existing: state,
			sources: [],
			config: BASE_CONFIG,
			groupingAxis: "none",
		});
		await withApp(
			async (setup) => {
				const frame = await frameUntil(setup, "the handed-off ticket", (f) =>
					f.includes("Add a webhook retry policy"),
				);
				// The handed-off ticket stays visible for observation...
				expect(frame).toContain("Add a webhook retry policy");
				// ...the open ticket from the removed source is gone...
				expect(frame).not.toContain("Another open item");
				// ...the detail pane carries the removed membership...
				expect(detailPaneText(frame)).toContain("Source issues: removed");
				// ...and the operator's config decision pins no warning line.
				expect(frame).not.toContain("source removed from config");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("the detail pane carries the source facts of the selected ticket", async () => {
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				const frame = await frameUntil(setup, "the source detail", (f) =>
					detailPaneText(f).includes("Source issues: healthy"),
				);
				const detail = detailPaneText(frame);
				// The source kind wraps in its Source column, so the fact's
				// two parts stand on the column's own rows.
				expect(detail).toContain("Source kind:");
				expect(detail).toContain("github-issue");
				expect(detail).toContain("External key: #5");
				expect(detail).toContain("Source state: open");
				// No task rule matches an issue, so the open ticket's task
				// type line carries the configured default.
				expect(detail).toContain("Suggested task type: implement");
				// The link to the ticket's GitHub page, in the blue role.
				expect(detail).toContain("GitHub: https://github.com/acme/factory/issues/5");
				expect(detail).toContain("Labels: ready-for-agent");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("the detail follows a label-driven suggested task profile", async () => {
		const config: FactoryConfig = {
			...issuesConfig,
			defaultModel: "factory-model",
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "implement-model",
					thinking: "high",
				},
				review: { ...BASE_CONFIG.taskTypes.review, agent: "claude" },
			},
			workflowStates: [
				{
					name: "ready-for-review",
					taskType: "review",
					match: { labelsAny: ["ready-for-review"] },
				},
			],
		};
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				await frameUntil(setup, "the implement profile", (frame) =>
					detailPaneText(frame).includes("Agent: codex"),
				);
				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				source.settle(success([{ ...ticket(), labels: ["ready-for-review"] }]));
				const changed = await frameUntil(setup, "the review profile", (frame) =>
					detailPaneText(frame).includes("Suggested task type: review"),
				);
				const detail = detailPaneText(changed);
				expect(detail).toContain("Agent: claude");
				expect(detail).toContain("Model: factory-model");
				expect(detail).toContain("Thinking: left to agent");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("a task rule match and the default fallback drive the badge through the real source path", async () => {
		// The pull request's label matches the review rule; the issue
		// matches no rule and falls back to the configured default.
		const planeRecord = await plane({
			sources: [
				{ config: issuesSourceConfig, tickets: [] },
				{ config: pullsSourceConfig, tickets: [] },
			],
			config: pullsConfig,
			settledReads: false,
		});
		const issuesSource = planeRecord.sources[0] as FakeSource;
		const pullsSource = planeRecord.sources[1] as FakeSource;

		await withApp(
			async (setup) => {
				const reviewTicket = ticket("github:github.com:PR_7", {
					externalKey: "#7",
					title: "Review ticket",
					sourceKind: "github-pull-request",
					labels: ["ready-for-review"],
					url: "https://github.com/acme/factory/pull/7",
				});
				const fallbackTicket = ticket("github:github.com:I_8", {
					externalKey: "#8",
					title: "Fallback ticket",
				});
				issuesSource.settle(success([fallbackTicket]));
				pullsSource.settle(success([reviewTicket]));
				const frame = await frameUntil(
					setup,
					"both tickets",
					(f) => listRowOf(f, "Review ticket") >= 0 && listRowOf(f, "Fallback ticket") >= 0,
				);
				// The badges ride the row the real path produced.
				expect(rowsOf(frame)[listRowOf(frame, "Review ticket")]).toContain("[review]");
				expect(rowsOf(frame)[listRowOf(frame, "Fallback ticket")]).toContain("[implement]");

				// The detail pane carries the explicit line for whichever
				// ticket the list selected, and the other on the move.
				const marker = rowsOf(frame)[markerRowOf(frame)];
				const firstLine = marker.includes("Review ticket")
					? "Suggested task type: review"
					: "Suggested task type: implement";
				const secondLine = marker.includes("Review ticket")
					? "Suggested task type: implement"
					: "Suggested task type: review";
				expect(detailPaneText(frame)).toContain(firstLine);
				await pressControl(setup, "move-list", { via: "j", quiet: true });
				await frameUntil(setup, "the selection to move to the other ticket", (f) =>
					detailPaneText(f).includes(secondLine),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("orders the list by attention: awaiting, running, handed-off, actionable open, non-actionable open", async () => {
		const state = wrappedState();
		const issues = { name: "issues", kind: "github-issues" };
		const pulls = { name: "pulls", kind: "github-pull-requests" };
		const runTicket = ticket("github:github.com:I_run", {
			externalKey: "#1",
			title: "Run ticket",
		});
		const offTicket = ticket("github:github.com:I_off", {
			externalKey: "#2",
			title: "Off ticket",
		});
		const awaitTicket = ticket("github:github.com:I_await", {
			externalKey: "#4",
			title: "Awaiting ticket",
		});
		const openTicket = ticket("github:github.com:I_open", {
			externalKey: "#3",
			title: "Open ticket",
			externalUpdatedAt: "2026-08-31T08:00:00Z",
		});
		const pendingTicket = ticket("github:github.com:I_pending", {
			externalKey: "#5",
			title: "Pending ticket",
			sourceKind: "github-pull-request",
			externalUpdatedAt: "2026-08-31T09:00:00Z",
		});
		state.sourceFact.initializeSources([issues, pulls]);
		state.sourceFact.applyFetch(issues, success([runTicket, offTicket, openTicket, awaitTicket]));
		state.sourceFact.applyFetch(pulls, success([pendingTicket]));
		const off = state.ticketWorkCycle
			.ticketListViews(BASE_CONFIG.workflowStates, "implement")
			.rows.find((t) => t.title === "Off ticket");
		if (off === undefined) throw new Error("Off ticket is missing");
		const claim = state.handoff.claimHandoff(off.identity, HANDOFF_CHOICE, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);

		// These transitions are recorded the way the observation loop records
		// them: state row updates.
		const db = new Database(state.path);
		db.prepare(
			"UPDATE tickets SET state = 'running' WHERE identity = 'github:github.com:I_run'",
		).run();
		db.prepare(
			"UPDATE tickets SET state = 'awaiting' WHERE identity = 'github:github.com:I_await'",
		).run();
		db.close();

		const planeRecord = await plane({
			existing: state,
			sources: [
				{ config: issuesSourceConfig, tickets: [] },
				{ config: pullsSourceConfig, tickets: [] },
			],
			config: pullsConfig,
			groupingAxis: "none",
		});
		const issuesSource = planeRecord.sources[0] as FakeSource;
		const _pullsSource = planeRecord.sources[1] as FakeSource;
		await withApp(
			async (setup) => {
				// While both sources still load, both open tickets are not
				// actionable, and the open band reads them by ticket number
				// ascending (ADR 0065), not by the update that moved newest.
				const loading = await frameUntil(setup, "all five tickets", (f) =>
					["Run ticket", "Off ticket", "Open ticket", "Pending ticket", "Awaiting ticket"].every(
						(title) => listRowOf(f, title) >= 0,
					),
				);
				expect(listRowOf(loading, "Open ticket")).toBeLessThan(
					listRowOf(loading, "Pending ticket"),
				);

				// Settle the issues source: the fetch carries its whole ticket
				// set, so every ticket survives the refresh. The open ticket
				// becomes actionable and jumps above the pending one, whose
				// source (pulls) stays in flight and remains not actionable.
				issuesSource.settle(success([runTicket, offTicket, openTicket, awaitTicket]));
				const frame = await frameUntil(
					setup,
					"the settled source to make its ticket actionable",
					(f) => listRowOf(f, "Open ticket") < listRowOf(f, "Pending ticket"),
				);
				const order = [
					"Awaiting ticket",
					"Run ticket",
					"Off ticket",
					"Open ticket",
					"Pending ticket",
				];
				const positions = order.map((title) => listRowOf(frame, title));
				expect(new Set(positions).size).toBe(order.length);
				expect(positions).toEqual([...positions].sort((a, b) => a - b));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("preserves the selection by identity when a state change reorders the list", async () => {
		const first = ticket("github:github.com:I_5", { title: "First ticket" });
		const second = ticket("github:github.com:I_6", {
			externalKey: "#6",
			title: "Second ticket",
		});
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([first, second]));
				await frameUntil(setup, "the first ticket", (f) => listRowOf(f, "First ticket") >= 0);

				// A refresh alone no longer reorders the open band: the tickets
				// read by ticket number (ADR 0065), and a number never changes.
				// A state change still reorders the list, and the selection must
				// ride the ticket, not the row.
				const db = new Database(planeRecord.state.path);
				db.prepare(
					"UPDATE tickets SET state = 'running' WHERE identity = 'github:github.com:I_6'",
				).run();
				db.close();
				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				source.settle(success([first, second]));
				await frameUntil(
					setup,
					"the list to reorder",
					(f) => listRowOf(f, "Second ticket") < listRowOf(f, "First ticket"),
				);
				// The selection stayed on the first ticket, not the first row.
				const frame = await settle(setup);
				const markerRow = rowsOf(frame)[markerRowOf(frame)];
				expect(markerRow).toContain("First ticket");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("r refreshes the sources and skips a source that is already fetching", async () => {
		const planeRecord = await plane({
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			settledReads: false,
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				await frameUntil(setup, "the ticket", (f) => f.includes("Add a webhook retry policy"));
				expect(source.calls).toBe(1);

				// Two rapid manual refreshes start one fetch, not two.
				await pressControl(setup, "refresh", { quiet: true });
				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				const fresh = ticket("github:github.com:I_6", {
					externalKey: "#6",
					title: "Second ticket",
					externalUpdatedAt: "2026-08-31T11:00:00Z",
				});
				source.settle(success([fresh, ticket()]));
				await frameUntil(setup, "the new ticket", (f) => f.includes("Second ticket"));
				expect(source.calls).toBe(2);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("a ticket with an unresolved handoff attempt refuses a new handoff and asks for recovery", async () => {
		const state = wrappedState();
		const definition = { name: "issues", kind: "github-issues" };
		state.sourceFact.initializeSources([definition]);
		state.sourceFact.applyFetch(definition, success([ticket()]));
		const [first] = state.ticketWorkCycle.ticketListViews(
			BASE_CONFIG.workflowStates,
			BASE_CONFIG.defaultTaskType,
		).rows;
		const claim = state.handoff.claimHandoff(first.identity, HANDOFF_CHOICE, "open");
		if (!claim.ok) throw new Error(claim.reason);
		// The attempt stays unresolved: the process died before settling it.

		const planeRecord = await plane({
			existing: state,
			sources: [{ config: issuesSourceConfig, tickets: [] }],
			config: issuesConfig,
			groupingAxis: "none",
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				await frameUntil(setup, "the recovery hint in the detail", (f) =>
					detailPaneText(f).includes("Handoff: recovery required"),
				);

				await pressControl(setup, "handoff", { quiet: true });
				const refused = await frameUntil(setup, "the refused handoff", (f) =>
					f.includes("Handoff recovery is required before another handoff"),
				);
				expect(messageRowOf(refused)).toContain(
					"Handoff recovery is required before another handoff",
				);

				// The override path is refused the same way: no panel opens.
				await pressControl(setup, "override", { quiet: true });
				const panel = await settle(setup);
				expect(panel).not.toContain("❯ Agent");
				expect(messageRowOf(panel)).toContain(
					"Handoff recovery is required before another handoff",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});
});
