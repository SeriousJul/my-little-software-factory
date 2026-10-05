/**
 * The shared checkout: one Repository's checkout is worked by one start at a
 * time (issue #297, ADR 0108).
 *
 * A worktree Handoff creates its worktree out of the Repository's shared
 * checkout. The merge Plane action is the other start of the pair the record
 * measured: its run works the Repository through the source - `gh` commands,
 * no `git` command and no `-C <checkout>` - and the Parallel limit says nothing
 * about the pair, because the Plane action takes no seat (ADR 0068): both
 * starts read the same free seat and both go. The Shared checkout hold is the
 * serialization of that pair, and ADR 0108 states what each start works. These
 * tests stand one merge and one worktree Handoff of one Repository against each
 * other and read which one runs.
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
import { queueWait } from "../src/domain/ticket-facts.ts";
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
// A second issues source listing the same Ticket in the other Repository: the
// shape the Shared checkout hold has to see through, because one Ticket can
// stand in two Repositories and its start works one checkout (issue #297).
const issuesBSource = { name: "issues-b", kind: "github-issues" } as const;

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

// The same Repository spelled the short way: the plane holds one checkout per
// Repository and not one per spelling (issue #297, ADR 0108).
const BARE: RepositoryRef = {
	identity: "acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};
const PULL_BARE = {
	identity: "github:github.com:P_13",
	externalKey: "#13",
	title: "Read the deploy log",
	repository: BARE,
};

// The Ticket the issues source lists in the factory Repository and the second
// issues source lists in the billing one. The billing listing is the newer of
// the two, so the Ticket's start works the billing checkout.
const DUAL = {
	identity: "github:github.com:I_7",
	externalKey: "#7",
	title: "Fix the invoice total",
	repository: FACTORY,
};

// The second factory Handoff the change-of-holder test queues: the row that
// keeps waiting while the checkout moves from the merge to the first Handoff.
const NEXT = {
	identity: "github:github.com:I_8",
	externalKey: "#8",
	title: "Retire the legacy importer",
	repository: FACTORY,
};

// The 16 factory Tickets the hand-off probe queues behind one merge row: the
// shape the review measured, where the checkout changes hands sixteen times
// while one row waits (issue #297 review).
const SIXTEEN = Array.from({ length: 16 }, (_unused, index) => ({
	identity: `github:github.com:I_${100 + index}`,
	externalKey: `#${100 + index}`,
	title: `Retire the legacy importer ${100 + index}`,
	repository: FACTORY,
}));

function fetched(
	ticket: typeof ISSUE,
	sourceKind: FetchedTicket["sourceKind"],
	repository: RepositoryRef = ticket.repository,
	externalUpdatedAt = "2026-08-31T10:00:00Z",
): FetchedTicket {
	return {
		identity: ticket.identity,
		sourceKind,
		externalKey: ticket.externalKey,
		sourceState: "open",
		url: `https://github.com/${repository.displayName}/${ticket.externalKey.slice(1)}`,
		title: ticket.title,
		description: "The body the agent reads.",
		labels: [],
		externalUpdatedAt,
		repository,
		attributes: {},
	};
}

/** The merge task type the config carries, on the registry's own action name. */
const MERGE_TASK_TYPES = {
	...BASE_CONFIG.taskTypes,
	merge: { action: "merge-pull-request" as const, method: "squash" as const },
};

interface RigOptions {
	/** Extra issue rows the issues source lists beside the two fixtures. */
	tickets?: FetchedTicket[];
	/** Extra pull requests the pulls source lists beside the fixture. */
	pullRequests?: (typeof PULL)[];
	/** The rows the second issues source lists: the same Tickets in the billing Repository. */
	dualListings?: (typeof ISSUE)[];
}

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
	/** True while at least one command waits inside the gate. */
	busy: () => boolean;
	waitForArrivals: (count: number) => Promise<void>;
	/** How many commands the gate has held so far. */
	arrivals: () => number;
	/** Let the commands a release unblocks run to their next held command. */
	settle: () => Promise<void>;
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
function rig(options: RigOptions = {}): Rig {
	const home = mkdtempSync(join(tmpdir(), "factory-checkout-hold-"));
	homes.push(home);
	const factoryCheckout = join(home, "src", "factory");
	const billingCheckout = join(home, "src", "billing");
	mkdirSync(factoryCheckout, { recursive: true });
	mkdirSync(billingCheckout, { recursive: true });
	let clock = Date.parse("2026-09-01T00:00:00Z");
	const state = openFactoryState(":memory:", () => clock);
	state.grouping.setGroupingAxis("tickets", "none");
	state.sourceFact.initializeSources([issuesSource, pullsSource, issuesBSource]);
	state.sourceFact.applyFetch(issuesSource, {
		status: "success",
		fetchedAt: new Date(clock).toISOString(),
		tickets: [
			fetched(ISSUE, "github-issue"),
			fetched(OTHER, "github-issue"),
			fetched(DUAL, "github-issue"),
			...(options.tickets ?? []),
		],
	});
	// The second listing of the same Tickets: the billing Repository, and the
	// newer of the two listings, so the Ticket's start works the billing
	// checkout while its factory membership stands beside it.
	state.sourceFact.applyFetch(issuesBSource, {
		status: "success",
		fetchedAt: new Date(clock).toISOString(),
		tickets: (options.dualListings ?? []).map((ticket) =>
			fetched(ticket, "github-issue", BILLING, "2026-09-02T10:00:00Z"),
		),
	});
	const pulls = [PULL, ...(options.pullRequests ?? [])];
	state.sourceFact.applyFetch(pullsSource, {
		status: "success",
		fetchedAt: new Date(clock).toISOString(),
		tickets: pulls.map((pull) => fetched(pull, "github-pull-request")),
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
				name: "issues-b",
				kind: "github-issues",
				refreshIntervalSeconds: 60,
				repositories: ["acme/billing"],
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
	// Every pull request the rig lists answers the merge's fresh read with an
	// open pull request, and its own merge lands.
	for (const pull of pulls) {
		runner.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/${pull.repository.displayName}/pulls/${pull.externalKey.slice(1)}`,
			],
			{
				stdout: '{"state":"open"}',
			},
		);
		runner.set(
			"gh",
			["pr", "merge", pull.externalKey, "--squash", "--repo", pull.repository.identity],
			{},
		);
	}
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
		busy: gate.busy,
		arrivals: gate.arrivals,
		settle: async () => {
			for (let turn = 0; turn < 12; turn += 1)
				await new Promise((resolve) => setTimeout(resolve, 1));
		},
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

/** Ask the merge of one pull request, and wait until its command stands held. */
async function mergeInFlight(r: Rig, pull: typeof PULL = PULL): Promise<void> {
	r.hold("gh pr merge");
	expect(
		await r.dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: false,
			ticketIdentity: pull.identity,
			taskType: "merge",
		}),
	).toEqual({ ok: true });
	await r.waitForArrivals(r.arrivals() + 1);
}

/** Ask the worktree Handoff of one ticket. */
async function handoffAsked(
	r: Rig,
	ticket: typeof ISSUE,
	choice = worktreeChoice(),
): Promise<void> {
	expect(
		await r.dispatch.dispatch({
			origin: "open",
			ticketIdentity: ticket.identity,
			choice,
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

	test("a checkout that keeps changing hands cannot hold a row past its budget", async () => {
		const r = rig({ tickets: SIXTEEN.map((ticket) => fetched(ticket, "github-issue")) });
		r.hold("gh pr merge", "herdr worktree create");
		// One worktree Handoff takes the factory checkout first.
		await handoffAsked(r, ISSUE);
		await r.dispatch.pickupWorkQueue();
		await r.waitForArrivals(1);
		// The merge row and sixteen worktree Handoffs of the same Repository queue
		// behind it: the shape the review measured, where the checkout changes
		// hands once per start while one row waits.
		expect(
			await r.dispatch.dispatchPlaneAction({
				origin: "open",
				automatic: false,
				ticketIdentity: PULL.identity,
				taskType: "merge",
			}),
		).toEqual({ ok: true });
		for (const ticket of SIXTEEN) await handoffAsked(r, ticket);
		await r.dispatch.pickupWorkQueue();
		expect(r.state.workQueue.items()).toHaveLength(18);
		const overBudget = (line: RecordedLine) => line.message.includes("past its budget");
		// The clock moves in steps of a third of the budget and one command
		// answers per step, so the checkout changes hands at every step and every
		// new holder takes it with a fresh reading. The old bound reset at every
		// hand-off and fired nowhere in this walk.
		for (let step = 1; step <= 4; step += 1) {
			r.advance(CHECKOUT_WORK_BUDGET_MS / 3);
			r.release();
			await r.settle();
			await r.dispatch.pickupWorkQueue();
			await r.settle();
			// The bound is the budget and not a multiple of it: nothing is refused
			// before the budget ends.
			if (step < 3) expect(r.lines.filter(overBudget)).toHaveLength(0);
		}
		// The bound fired on the step where the budget ended: every row that waited
		// the whole budget left the queue with the reason - the fourteen Handoff
		// rows that never reached a start. The merge row ran the moment the
		// checkout came free, the three Handoffs that reached a start left the way
		// a start leaves it, and the queue is empty when the walk ends: no row is
		// held past the budget, whatever the checkout did in that window.
		expect(r.lines.filter(overBudget).length).toBeGreaterThanOrEqual(14);
		expect(
			r.lines.some(
				(line) =>
					line.level === "warn" &&
					line.message.startsWith("handoff refused:") &&
					line.message.includes("past its budget"),
			),
		).toBe(true);
		expect(r.state.workQueue.items()).toHaveLength(0);
		r.release();
	});

	test("the force-dispatch key on a row the checkout holds leaves the row standing", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		r.dispatch.forceDispatchWorkQueueItem(ISSUE.identity);
		// The key passes the Parallel limit's cap and nothing else: the row keeps
		// its place, no worktree reaches the checkout, and the fact that holds the
		// row answers the key.
		expect(r.state.workQueue.hasWorkItem(ISSUE.identity)).toBe(true);
		expect(r.commands().filter((command) => command.startsWith("herdr worktree"))).toEqual([]);
		expect(r.events).toContain(
			`notice:"${ISSUE.title}" waits in the Work queue: the shared checkout is at work: the merge of "${PULL.title}" runs in it`,
		);
		r.release();
	});

	test("the force-dispatch key past the budget answers the refusal, never a wait", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		r.dispatch.forceDispatchWorkQueueItem(ISSUE.identity);
		await r.settle();
		// The gate dropped the row, so the key answers with the refusal that
		// dropped it. A `waits:` line for a row that left the queue would tell the
		// operator a working queue and a dropped row in the same act (issue #297).
		expect(r.state.workQueue.hasWorkItem(ISSUE.identity)).toBe(false);
		expect(r.events).toContain(
			`warning:queued handoff for "${ISSUE.title}" was not run: the shared checkout stayed at work past its budget`,
		);
		expect(r.events.filter((event) => event.includes("waits in the Work queue"))).toEqual([]);
		r.release();
	});

	test("one Repository spelled two ways is one checkout", async () => {
		const r = rig({ pullRequests: [PULL_BARE] });
		// The worktree Handoff works `github.com/acme/factory`; the merge aims at
		// the pull request whose membership spells the same Repository
		// `acme/factory`. The hold keys on the one spelling the plane holds a
		// Repository by, so the merge waits behind the create.
		r.hold("herdr worktree create");
		await handoffAsked(r, ISSUE);
		await r.waitForArrivals(r.arrivals() + 1);
		expect(
			await r.dispatch.dispatchPlaneAction({
				origin: "open",
				automatic: false,
				ticketIdentity: PULL_BARE.identity,
				taskType: "merge",
			}),
		).toEqual({ ok: true });
		await r.dispatch.pickupWorkQueue();
		expect(r.state.workQueue.hasWorkItem(PULL_BARE.identity)).toBe(true);
		expect(r.commands().filter((command) => command.startsWith("gh pr merge"))).toEqual([]);
		expect(r.lines).toContainEqual(
			infoLine(
				`merge waits: "${PULL_BARE.title}" (the shared checkout is at work: the handoff of "${ISSUE.title}" runs in it)`,
			),
		);
		r.release();
	});

	test("a Ticket listed in two Repositories holds the checkout its start works", async () => {
		const r = rig({ dualListings: [DUAL] });
		// The Ticket stands in the factory Repository and the billing one, and its
		// start works the billing checkout. The merge works the factory checkout,
		// so the two starts work two checkouts and neither waits (issue #297).
		await mergeInFlight(r);
		await handoffAsked(r, DUAL);
		await r.dispatch.pickupWorkQueue();
		await r.settle();
		const creates = r.commands().filter((command) => command.startsWith("herdr worktree create"));
		expect(creates).toEqual([expect.stringContaining(r.billingCheckout)]);
		expect(r.lines.filter((line) => line.message.startsWith("handoff waits:"))).toEqual([]);
		expect(r.lines.filter((line) => line.message.startsWith("merge waits:"))).toEqual([]);
		r.release();
	});

	test("the merge side of the budget refusal answers the ask with the reason", async () => {
		const r = rig();
		r.hold("herdr worktree create");
		await handoffAsked(r, ISSUE);
		await r.waitForArrivals(r.arrivals() + 1);
		const answers: string[] = [];
		expect(
			await r.dispatch.dispatchPlaneAction({
				origin: "open",
				automatic: false,
				ticketIdentity: PULL.identity,
				taskType: "merge",
				onStarted: (started) => answers.push(started.ok ? "started" : started.reason),
			}),
		).toEqual({ ok: true });
		await r.dispatch.pickupWorkQueue();
		expect(r.state.workQueue.hasWorkItem(PULL.identity)).toBe(true);
		r.advance(CHECKOUT_WORK_BUDGET_MS);
		await r.dispatch.pickupWorkQueue();
		// The merge row ends on the same shape the handoff's row does: the row
		// leaves, the record names the refusal, the Message line warns, and the
		// ask answers with the reason (ADR 0049).
		expect(r.state.workQueue.hasWorkItem(PULL.identity)).toBe(false);
		expect(r.lines).toContainEqual(
			warnLine(
				`merge refused: "${PULL.title}" (the shared checkout stayed at work past its budget)`,
			),
		);
		expect(r.events).toContain(
			`warning:the merge of "${PULL.title}" was not run: the shared checkout stayed at work past its budget`,
		);
		expect(answers).toEqual(["the shared checkout stayed at work past its budget"]);
		r.release();
	});

	test("the row the checkout holds keeps its queued badge fact", async () => {
		const r = rig();
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		const ticket = r.state.ticketWorkCycle
			.projectedTickets(r.config.workflowStates, r.config.defaultTaskType)
			.find((candidate) => candidate.identity === ISSUE.identity);
		if (ticket === undefined) throw new Error("the fixture ticket left the projection");
		// The badge the row wears is the Queue wait fact the list reads, and the
		// gate holds the row without touching it: the waiting row is a queue row
		// like every other (ADR 0108).
		expect(queueWait(ticket, r.state.workQueue.items())).toBe(true);
		expect(ticket.state).toBe("open");
		r.release();
	});

	test("the wait states itself again when the checkout changes hands", async () => {
		const r = rig({ tickets: [fetched(NEXT, "github-issue")] });
		r.hold("herdr worktree create");
		// The merge works the factory checkout first, and two worktree Handoffs of
		// that Repository queue behind it. The first takes the checkout when the
		// merge lets go; the second keeps waiting and sees the holder change.
		await mergeInFlight(r);
		await handoffAsked(r, ISSUE);
		await handoffAsked(r, NEXT);
		const linesFor = (title: string) =>
			r.lines.filter((line) => line.message.startsWith(`handoff waits: "${title}"`));
		expect(linesFor(NEXT.title).map((line) => line.message)).toEqual([
			`handoff waits: "${NEXT.title}" (the shared checkout is at work: the merge of "${PULL.title}" runs in it)`,
		]);
		// The merge settles and the checkout moves to the first Handoff. The row
		// that keeps waiting waits behind a different start now: the fact changed,
		// so it states itself again, beside the first line and not over it
		// (issue #231, ADR 0108).
		r.release();
		await r.until(() => linesFor(NEXT.title).length === 2);
		expect(linesFor(NEXT.title).map((line) => line.message)).toEqual([
			`handoff waits: "${NEXT.title}" (the shared checkout is at work: the merge of "${PULL.title}" runs in it)`,
			`handoff waits: "${NEXT.title}" (the shared checkout is at work: the handoff of "${ISSUE.title}" runs in it)`,
		]);
		// The row that took the checkout states its own wait once, and the row
		// that keeps waiting keeps its place (issue #297).
		expect(linesFor(ISSUE.title)).toHaveLength(1);
		expect(r.state.workQueue.hasWorkItem(NEXT.identity)).toBe(true);
		r.release();
	});

	test("a live-worktree Handoff takes no hold", async () => {
		const r = rig();
		await mergeInFlight(r);
		// A live-worktree Handoff works a checkout the operator chose and already
		// owns, so the merge's hold does not reach it: the row crosses the gate and
		// its start runs (issue #297, ADR 0108).
		await handoffAsked(r, ISSUE, baseChoice("pi", "live-worktree", "implement"));
		await r.dispatch.pickupWorkQueue();
		await r.settle();
		expect(r.state.workQueue.hasWorkItem(ISSUE.identity)).toBe(false);
		expect(r.lines.filter((line) => line.message.startsWith("handoff waits:"))).toEqual([]);
		expect(r.lines.some((line) => line.message.startsWith("handoff started:"))).toBe(true);
		r.release();
	});
});
