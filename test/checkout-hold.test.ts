/**
 * The shared checkout: one Repository's checkout is worked by one start at a
 * time (issue #297, ADR 0108).
 *
 * A merge Plane action run works the Repository's shared checkout, and a
 * worktree Handoff creates its worktree from that same checkout. The Parallel
 * limit says nothing about the pair, because the Plane action takes no seat
 * (ADR 0068): both starts read the same free seat and both go, and the two
 * collide in the checkout. These tests stand one merge and one worktree
 * Handoff of one Repository against each other and read which one runs.
 *
 * The assertions read the facts outside the seam: the Work queue's rows, the
 * commands the plane reached, and the record's lines. Every test drives
 * `createHandoffDispatch` with the fake runner behind a gate, an in-memory
 * state, and a clock the test moves. No test mounts a terminal, and no test
 * touches a real checkout, herdr, or `gh`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket, RepositoryRef } from "../src/domain/ticket.ts";
import { baseChoice, type HandoffChoice } from "../src/handoff.ts";
import {
	CHECKOUT_WORK_BUDGET_MS,
	createHandoffDispatch,
	type HandoffDispatchReports,
} from "../src/handoff-dispatch.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";
import { gatedRunner } from "./gated-runner.ts";
import { infoLine, type RecordedLine, recordLogger, warnLine } from "./record-logger.ts";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// The two Repositories the fixtures live in. The merge works in the first, and
// the second is there to show the hold belongs to one Repository and not to
// the plane.
const FACTORY: RepositoryRef = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};
const BILLING: RepositoryRef = {
	identity: "github.com/acme/billing",
	displayName: "acme/billing",
	cloneUrl: "https://github.com/acme/billing.git",
};

const issuesSource = { name: "issues", kind: "github-issues" } as const;
const pullsSource = { name: "pulls", kind: "github-pull-requests" } as const;

// The issue whose worktree Handoff works the factory checkout, the issue in
// the other Repository, and the pull request the merge aims at.
const ISSUE = {
	identity: "github:github.com:I_5",
	externalKey: "#5",
	title: "Add a webhook retry policy",
	repository: FACTORY,
};
const OTHER = {
	identity: "github:github.com:I_6",
	externalKey: "#6",
	title: "Close the stale deploy branch",
	repository: BILLING,
};
const PULL = {
	identity: "github:github.com:P_12",
	externalKey: "#12",
	title: "Persist the source facts",
	repository: FACTORY,
};

function fetched(ticket: typeof ISSUE, sourceKind: FetchedTicket["sourceKind"]): FetchedTicket {
	return {
		identity: ticket.identity,
		sourceKind,
		externalKey: ticket.externalKey,
		sourceState: "open",
		url: `https://github.com/${ticket.repository.displayName}/${ticket.externalKey.slice(1)}`,
		title: ticket.title,
		description: "The body the agent reads.",
		labels: [],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: ticket.repository,
		attributes: {},
	};
}

/** The merge task type the config carries, on the registry's own action name. */
const MERGE_TASK_TYPES = {
	...BASE_CONFIG.taskTypes,
	merge: { action: "merge-pull-request" as const, method: "squash" as const },
};

interface Rig {
	state: FactoryState;
	dispatch: ReturnType<typeof createHandoffDispatch>;
	config: FactoryConfig;
	home: string;
	factoryCheckout: string;
	billingCheckout: string;
	/** Every record line the module wrote, with its level. */
	lines: RecordedLine[];
	/** The Message-line facts the module reported, in order. */
	events: string[];
	/** Hold every command that starts with one of these prefixes, until released. */
	hold: (...prefixes: string[]) => void;
	/** Let the oldest held command answer. */
	release: () => void;
	waitForArrivals: (count: number) => Promise<void>;
	commands: () => string[];
	/** Move the state's clock forward; the checkout wait's bound reads it. */
	advance: (ms: number) => void;
	/** Resolve once `test()` holds, pumping the microtasks a run leaves behind. */
	until: (test: () => boolean) => Promise<void>;
	/** The same state and record, with the Parallel limit read at `seats`. */
	withSeats: (seats: number) => ReturnType<typeof createHandoffDispatch>;
}

/**
 * One module, one in-memory state, two Repositories, and a clock the test
 * moves. The runner answers a worktree Handoff out of the box except for the
 * create's own answer, and answers the merge's fresh read with an open pull
 * request.
 */
function rig(): Rig {
	const home = mkdtempSync(join(tmpdir(), "factory-checkout-hold-"));
	homes.push(home);
	const factoryCheckout = join(home, "src", "factory");
	const billingCheckout = join(home, "src", "billing");
	mkdirSync(factoryCheckout, { recursive: true });
	mkdirSync(billingCheckout, { recursive: true });
	let clock = Date.parse("2026-09-01T00:00:00Z");
	const state = openFactoryState(":memory:", () => clock);
	state.grouping.setGroupingAxis("tickets", "none");
	state.sourceFact.initializeSources([issuesSource, pullsSource]);
	state.sourceFact.applyFetch(issuesSource, {
		status: "success",
		fetchedAt: new Date(clock).toISOString(),
		tickets: [fetched(ISSUE, "github-issue"), fetched(OTHER, "github-issue")],
	});
	state.sourceFact.applyFetch(pullsSource, {
		status: "success",
		fetchedAt: new Date(clock).toISOString(),
		tickets: [fetched(PULL, "github-pull-request")],
	});
	const config: FactoryConfig = {
		...BASE_CONFIG,
		taskTypes: MERGE_TASK_TYPES,
		repos: {
			"github.com/acme/factory": factoryCheckout,
			"github.com/acme/billing": billingCheckout,
		},
		sources: [
			{
				name: "issues",
				kind: "github-issues",
				refreshIntervalSeconds: 60,
				repositories: ["acme/factory", "acme/billing"],
				host: "github.com",
			},
			{
				name: "pulls",
				kind: "github-pull-requests",
				refreshIntervalSeconds: 60,
				repositories: ["acme/factory"],
				host: "github.com",
			},
		],
	};
	const runner = new FakeRunner();
	// The merge's fresh read finds the pull request open, and its merge lands.
	runner.set("gh", ["api", "--hostname", "github.com", "repos/acme/factory/pulls/12"], {
		stdout: '{"state":"open"}',
	});
	runner.set("gh", ["pr", "merge", "#12", "--squash", "--repo", FACTORY.identity], {});
	// The worktree base rule finds the remote default branch in both checkouts,
	// and each checkout answers the origin read the explicit mapping checks.
	for (const [checkout, repository] of [
		[factoryCheckout, FACTORY],
		[billingCheckout, BILLING],
	] as const) {
		runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
			stdout: `${repository.cloneUrl}\n`,
		});
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
	}
	const prefixes: string[] = [];
	const gate = gatedRunner(runner, (command) =>
		prefixes.some((prefix) => command.startsWith(prefix)),
	);
	const lines: RecordedLine[] = [];
	const events: string[] = [];
	const reports: HandoffDispatchReports = {
		working: (text) => events.push(`working:${text}`),
		warning: (text) => events.push(`warning:${text}`),
		notice: (text) => events.push(`notice:${text}`),
		error: (text) => events.push(`error:${text}`),
		clearWorking: () => events.push("clear-working"),
		refresh: () => events.push("refresh"),
		starting: (identity, active) => events.push(`starting:${identity}:${active ? "on" : "off"}`),
	};
	const make = (
		runnerOverride: typeof runner | Parameters<typeof createHandoffDispatch>[0]["runner"],
		seatCount: () => number,
		overrides: Partial<HandoffDispatchReports> = {},
	) =>
		createHandoffDispatch({
			state,
			runner: runnerOverride,
			config: () => config,
			// The cap never engages in these rigs: a test that wants it counts
			// its seats on its own facts.
			seatCount,
			home,
			log: recordLogger(lines),
			...reports,
			...overrides,
		});
	return {
		state,
		dispatch: make(gate.runner, () => 0),
		config,
		home,
		factoryCheckout,
		billingCheckout,
		lines,
		events,
		hold: (...newPrefixes: string[]) => prefixes.push(...newPrefixes),
		release: gate.release,
		waitForArrivals: gate.waitForArrivals,
		commands: () => runner.commands(),
		advance: (ms) => {
			clock += ms;
		},
		until: async (holds) => {
			for (let turn = 0; turn < 200 && !holds(); turn += 1)
				await new Promise((resolve) => setTimeout(resolve, 5));
		},
		withSeats: (seats) => make(gate.runner, () => seats),
	};
}

/** The worktree Handoff choice: the Environment that creates its worktree. */
function worktreeChoice(): HandoffChoice {
	return baseChoice("pi", "worktree", "implement");
}

/** Ask the merge of the pull request, and wait until its command stands held. */
async function mergeInFlight(r: Rig): Promise<void> {
	r.hold("gh pr merge");
	expect(
		await r.dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: false,
			ticketIdentity: PULL.identity,
			taskType: "merge",
		}),
	).toEqual({ ok: true });
	await r.waitForArrivals(1);
}

/** Ask the worktree Handoff of one ticket. */
async function handoffAsked(r: Rig, ticket: typeof ISSUE): Promise<void> {
	expect(
		await r.dispatch.dispatch({
			origin: "open",
			ticketIdentity: ticket.identity,
			choice: worktreeChoice(),
			previousMessage: "",
		}),
	).toEqual({ ok: true });
}

describe("the shared checkout of one Repository (issue #297, ADR 0108)", () => {
	test("a merge in flight holds the checkout, and the worktree Handoff of that Repository waits", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		// The row stands: the ask reached the queue and the pickup left it there,
		// because the Repository's checkout is at work.
		expect(
			r.state.workQueue
				.items()
				.flatMap((item) => (item.kind === "consultation" ? [] : [item.ticketIdentity])),
		).toEqual([ISSUE.identity]);
		// No worktree reached the checkout the merge works.
		expect(r.commands().filter((command) => command.startsWith("herdr worktree"))).toEqual([]);
		// The record names the wait, and names the start that holds the checkout.
		expect(r.lines).toContainEqual(
			infoLine(
				`handoff waits: "${ISSUE.title}" (the shared checkout is at work: the merge of "${PULL.title}" runs in it)`,
			),
		);
		r.release();
		// The merge run settles, the checkout is free, and the row that waited
		// took its turn with no second ask.
		await r.until(() => r.state.workQueue.items().length === 0);
		expect(r.state.workQueue.items()).toEqual([]);
		expect(r.commands().some((command) => command.startsWith("herdr worktree create"))).toBe(true);
	});

	test("the wait states itself once while it stands, never once per poll", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		// The observation cycle asks the pickup again and again; the wait is one
		// standing fact, and the file holds one line for it (issue #231).
		await r.dispatch.pickupWorkQueue();
		await r.dispatch.pickupWorkQueue();
		expect(r.lines.filter((line) => line.message.startsWith("handoff waits:"))).toHaveLength(1);
		r.release();
	});

	test("a worktree Handoff in flight holds the checkout, and the merge of that Repository waits", async () => {
		const r = rig();
		r.hold("herdr worktree create");
		await handoffAsked(r, ISSUE);
		await r.waitForArrivals(1);
		expect(
			await r.dispatch.dispatchPlaneAction({
				origin: "open",
				automatic: false,
				ticketIdentity: PULL.identity,
				taskType: "merge",
			}),
		).toEqual({ ok: true });
		// The merge row stands in the queue, and the merge command never ran.
		expect(r.state.workQueue.hasWorkItem(PULL.identity)).toBe(true);
		expect(r.commands().filter((command) => command.startsWith("gh pr merge"))).toEqual([]);
		expect(r.lines).toContainEqual(
			infoLine(
				`merge waits: "${PULL.title}" (the shared checkout is at work: the handoff of "${ISSUE.title}" runs in it)`,
			),
		);
		r.release();
		// The worktree stood, the start settled, and the checkout is free: the
		// merge that waited ran with no second ask.
		await r.until(() => r.commands().some((command) => command.startsWith("gh pr merge")));
		expect(r.state.workQueue.hasWorkItem(PULL.identity)).toBe(false);
	});

	test("two worktree Handoffs in different Repositories start in one pass, and the wait takes no seat", async () => {
		const r = rig();
		await mergeInFlight(r);
		// The factory row waits behind the merge; the billing row's checkout is
		// free, and the walk reaches it past the row that waits, because the
		// waiting row takes no seat.
		await handoffAsked(r, ISSUE);
		await handoffAsked(r, OTHER);
		await r.until(() =>
			r.commands().some((command) => command.startsWith("herdr worktree create")),
		);
		// The billing start reached its create, and the factory row still waits:
		// the hold belongs to one Repository, and the row that waits takes no
		// seat, so the walk reaches the start behind it.
		const creates = r.commands().filter((command) => command.startsWith("herdr worktree create"));
		expect(creates).toEqual([expect.stringContaining(r.billingCheckout)]);
		expect(
			r.state.workQueue
				.items()
				.flatMap((item) => (item.kind === "consultation" ? [] : [item.ticketIdentity])),
		).toEqual([ISSUE.identity]);
		r.release();
	});

	test("a wait past the checkout work's budget is refused with the reason, and the row leaves", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		expect(r.state.workQueue.items()).toHaveLength(1);
		// The checkout work should have ended inside its own budget. A hold that
		// still stands past it is a start that stopped answering, and the plane
		// refuses the waiter rather than hold it forever (ADR 0049).
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		await r.dispatch.pickupWorkQueue();
		expect(r.state.workQueue.items()).toEqual([]);
		expect(r.lines).toContainEqual(
			warnLine(
				`handoff refused: "${ISSUE.title}" (the shared checkout stayed at work past its budget)`,
			),
		);
		expect(r.events).toContain(
			`warning:queued handoff for "${ISSUE.title}" was not run: the shared checkout stayed at work past its budget`,
		);
		r.release();
	});

	test("the checkout hold never counts against the Parallel limit", async () => {
		const r = rig();
		// The cap stands full: the merge still runs, because a Plane action
		// takes no seat (ADR 0068), and the hold it leaves is the checkout's,
		// not a seat the Parallel limit counts. The start line states the full
		// reading the merge stood on, and never a reading the merge raised.
		const capped = r.withSeats(r.config.maxParallelAgents);
		expect(
			await capped.dispatchPlaneAction({
				origin: "open",
				automatic: false,
				ticketIdentity: PULL.identity,
				taskType: "merge",
			}),
		).toEqual({ ok: true });
		await r.until(() => r.commands().some((command) => command.startsWith("gh pr merge")));
		expect(r.commands()).toContain(`gh pr merge #12 --squash --repo ${FACTORY.identity}`);
		await r.until(() => r.lines.some((line) => line.message.startsWith("merge started:")));
		expect(r.lines).toContainEqual(
			infoLine(
				`merge started: "${PULL.title}" (mode direct-ask, origin open, operator-staged, seats 2/2)`,
			),
		);
	});
});
