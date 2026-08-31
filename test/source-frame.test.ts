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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";
import {
	awaitFrame,
	detailPaneText,
	HEIGHT,
	markerRowOf,
	rowsOf,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-frame-state-"));
	paths.push(dir);
	return openFactoryState(join(dir, "state.sqlite"));
}

/** A source whose fetches stay in flight until the test settles them. */
class FakeSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs = 60_000;
	calls = 0;
	private resolvers: Array<() => void> = [];
	private next: FetchOutcome;

	constructor(name: string, kind: string, next: FetchOutcome) {
		this.name = name;
		this.kind = kind;
		this.next = next;
	}

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise<FetchOutcome>((resolve) => {
			this.resolvers.push(() => resolve(this.next));
		});
	}

	/** Settle every in-flight fetch with the next outcome. */
	settle(outcome: FetchOutcome): void {
		this.next = outcome;
		for (const resolve of this.resolvers.splice(0)) resolve();
	}
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

const RATE_LIMITED: FetchOutcome = { status: "failed", reason: "GitHub rate limit exceeded" };

const issuesConfig: FactoryConfig = {
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
};

const pullsConfig: FactoryConfig = {
	...issuesConfig,
	sources: [
		...issuesConfig.sources,
		{
			name: "pulls",
			kind: "github-pull-requests",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
};

const HANDOFF_CHOICE = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
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
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					const loading = await awaitFrame(
						setup,
						(f) => f.includes("loading tickets..."),
						"the loading state",
					);
					expect(loading).not.toContain("Add a webhook retry policy");

					source.settle(success([ticket()]));
					const settled = await awaitFrame(
						setup,
						(f) => f.includes("Add a webhook retry policy"),
						"the fetched ticket",
					);
					expect(settled).toContain("[open]");
					expect(settled).not.toContain("loading tickets...");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("shows no tickets match the configured sources after a successful empty refresh", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([]));
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("no tickets match the configured sources"),
						"the empty state",
					);
					expect(frame).not.toContain("loading tickets...");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a failed refresh makes the source stale, keeps its tickets, and refuses a new handoff", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([ticket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");

					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					source.settle(RATE_LIMITED);
					const stale = await awaitFrame(
						setup,
						(f) => f.includes("issues: stale - GitHub rate limit exceeded"),
						"the stale health line",
					);
					// The prior snapshot stays visible.
					expect(stale).toContain("Add a webhook retry policy");

					setup.mockInput.pressEnter();
					const refused = await awaitFrame(
						setup,
						(f) => f.includes("its sources are stale, removed, or absent"),
						"the refused handoff",
					);
					expect(rowsOf(refused)[HEIGHT - 1]).toContain(
						"its sources are stale, removed, or absent",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a removed source keeps its handed-off ticket, drops its open ticket, and flags itself removed", async () => {
		const state = freshState();
		const definition = { name: "issues", kind: "github-issues" };
		state.initializeSources([definition]);
		state.applyFetch(
			definition,
			success([
				ticket(),
				ticket("github:github.com:I_9", { externalKey: "#9", title: "Another open item" }),
			]),
		);
		const [first] = state.visibleTickets(DEFAULT_CONFIG.taskRules, DEFAULT_CONFIG.defaultTaskType);
		const claim = state.claimHandoff(first.identity, HANDOFF_CHOICE);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		// The config no longer lists the source: a restart marks it removed.
		state.initializeSources([]);

		await withApp(
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("issues: removed - source removed from config"),
					"the removed health line",
				);
				// The handed-off ticket stays visible for observation...
				expect(frame).toContain("Add a webhook retry policy");
				// ...the open ticket from the removed source is gone...
				expect(frame).not.toContain("Another open item");
				// ...and the detail pane carries the removed membership.
				expect(detailPaneText(frame)).toContain("Source issues: removed");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, state, sources: [] },
		);
		state.close();
	});

	test("the detail pane carries the source facts of the selected ticket", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([ticket()]));
					const frame = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Source issues: healthy"),
						"the source detail",
					);
					const detail = detailPaneText(frame);
					expect(detail).toContain("Source kind: github-issue");
					expect(detail).toContain("External key: #5");
					expect(detail).toContain("Source state: open");
					expect(detail).toContain("Source URL: https://github.com/acme/factory/issues/5");
					expect(detail).toContain("Labels: ready-for-agent");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("orders the list by attention: running, handed-off, actionable open, non-actionable open, done", async () => {
		const state = freshState();
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
		const doneTicket = ticket("github:github.com:I_done", {
			externalKey: "#4",
			title: "Done ticket",
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
		state.initializeSources([issues, pulls]);
		state.applyFetch(issues, success([runTicket, offTicket, openTicket, doneTicket]));
		state.applyFetch(pulls, success([pendingTicket]));
		const off = state
			.visibleTickets(DEFAULT_CONFIG.taskRules, "implement")
			.find((t) => t.title === "Off ticket");
		if (off === undefined) throw new Error("Off ticket is missing");
		const claim = state.claimHandoff(off.identity, HANDOFF_CHOICE);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);

		// No agent API exists to finish a ticket yet, so these transitions are
		// recorded the way the agent will record them: state row updates.
		const db = new DatabaseSync(state.path);
		db.prepare(
			"UPDATE tickets SET state = 'running' WHERE identity = 'github:github.com:I_run'",
		).run();
		db.prepare(
			"UPDATE tickets SET state = 'done' WHERE identity = 'github:github.com:I_done'",
		).run();
		db.close();

		const issuesSource = new FakeSource("issues", "github-issues", success([]));
		const pullsSource = new FakeSource("pulls", "github-pull-requests", success([]));
		await withApp(
			async (setup) => {
				// While both sources still load, both open tickets are not
				// actionable, and the newer pending ticket sorts first.
				const loading = await awaitFrame(
					setup,
					(f) =>
						["Run ticket", "Off ticket", "Open ticket", "Pending ticket", "Done ticket"].every(
							(title) => listRowOf(f, title) >= 0,
						),
					"all five tickets",
				);
				expect(listRowOf(loading, "Pending ticket")).toBeLessThan(
					listRowOf(loading, "Open ticket"),
				);

				// Settle the issues source: the fetch carries its whole ticket
				// set, so every ticket survives the refresh. The open ticket
				// becomes actionable and jumps above the pending one, whose
				// source (pulls) stays in flight and remains not actionable.
				issuesSource.settle(success([runTicket, offTicket, openTicket, doneTicket]));
				const frame = await awaitFrame(
					setup,
					(f) => listRowOf(f, "Open ticket") < listRowOf(f, "Pending ticket"),
					"the settled source to make its ticket actionable",
				);
				const order = ["Run ticket", "Off ticket", "Open ticket", "Pending ticket", "Done ticket"];
				const positions = order.map((title) => listRowOf(frame, title));
				expect(new Set(positions).size).toBe(order.length);
				expect(positions).toEqual([...positions].sort((a, b) => a - b));
			},
			WIDTH,
			HEIGHT,
			{ config: pullsConfig, state, sources: [issuesSource, pullsSource] },
		);
		state.close();
	});

	test("preserves the selection by identity when a refresh reorders the list", async () => {
		const state = freshState();
		const first = ticket("github:github.com:I_5", { title: "First ticket" });
		const second = ticket("github:github.com:I_6", {
			externalKey: "#6",
			title: "Second ticket",
			externalUpdatedAt: "2026-08-31T09:00:00Z",
		});
		const source = new FakeSource("issues", "github-issues", success([first, second]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([first, second]));
					await awaitFrame(setup, (f) => listRowOf(f, "First ticket") >= 0, "the first ticket");

					// The manual refresh makes the other ticket newer: the list reorders.
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					source.settle(success([first, { ...second, externalUpdatedAt: "2026-08-31T11:00:00Z" }]));
					await awaitFrame(
						setup,
						(f) => listRowOf(f, "Second ticket") < listRowOf(f, "First ticket"),
						"the list to reorder",
					);
					// The selection stayed on the first ticket, not the first row.
					const frame = await settle(setup);
					const markerRow = rowsOf(frame)[markerRowOf(frame)];
					expect(markerRow).toContain("First ticket");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("r refreshes the sources and skips a source that is already fetching", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([ticket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					expect(source.calls).toBe(1);

					// Two rapid manual refreshes start one fetch, not two.
					setup.mockInput.pressKey("r");
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					const fresh = ticket("github:github.com:I_6", {
						externalKey: "#6",
						title: "Second ticket",
						externalUpdatedAt: "2026-08-31T11:00:00Z",
					});
					source.settle(success([fresh, ticket()]));
					await awaitFrame(setup, (f) => f.includes("Second ticket"), "the new ticket");
					expect(source.calls).toBe(2);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a ticket with an unresolved handoff attempt refuses a new handoff and asks for recovery", async () => {
		const state = freshState();
		const definition = { name: "issues", kind: "github-issues" };
		state.initializeSources([definition]);
		state.applyFetch(definition, success([ticket()]));
		const [first] = state.visibleTickets(DEFAULT_CONFIG.taskRules, DEFAULT_CONFIG.defaultTaskType);
		const claim = state.claimHandoff(first.identity, HANDOFF_CHOICE);
		if (!claim.ok) throw new Error(claim.reason);
		// The attempt stays unresolved: the process died before settling it.

		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		await withApp(
			async (setup) => {
				source.settle(success([ticket()]));
				await awaitFrame(
					setup,
					(f) => detailPaneText(f).includes("Handoff: recovery required"),
					"the recovery hint in the detail",
				);

				setup.mockInput.pressEnter();
				const refused = await awaitFrame(
					setup,
					(f) => f.includes("handoff recovery is required before another handoff"),
					"the refused handoff",
				);
				expect(rowsOf(refused)[HEIGHT - 1]).toContain(
					"handoff recovery is required before another handoff",
				);

				// The override path is refused the same way: no panel opens.
				setup.mockInput.pressKey("e");
				const panel = await settle(setup);
				expect(panel).not.toContain("Override");
				expect(rowsOf(panel)[HEIGHT - 1]).toContain(
					"handoff recovery is required before another handoff",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: issuesConfig, state, sources: [source] },
		);
		state.close();
	});
});
