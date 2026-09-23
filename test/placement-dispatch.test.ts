/**
 * The placement the manual start crosses (ADR 0045), through the Handoff
 * dispatch's real seam.
 *
 * The module runs the Placement module's answer before the agent starts: the
 * write lands through the fire's own label writer, the refusal settles the
 * attempt failed with the reason on the line, and a start that answers a
 * no-placement face touches the source no more than it did before. Every test
 * drives `createHandoffDispatch` with the fake runner and an in-memory state,
 * and reads the facts that stand outside the seam: the commands the runner
 * heard, what the module reported, and what the durable state holds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, GitHubSourceKind, WorkflowState } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { baseChoice, type HandoffChoice } from "../src/handoff.ts";
import {
	createHandoffDispatch,
	type DispatchResult,
	type HandoffDispatch,
	type HandoffDispatchReports,
} from "../src/handoff-dispatch.ts";
import { FactoryState } from "../src/state.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";

const pullsSource = { name: "pulls", kind: "github-pull-requests" } as const;
const issuesSource = { name: "issues", kind: "github-issues" } as const;
const mirrorSource = { name: "mirror", kind: "github-issues" } as const;

/** One ticket, the title and the stable herdr agent name a handoff of it asks for. */
interface Seed {
	identity: string;
	title: string;
	name: string;
}

const PULL: Seed = {
	identity: "github:github.com:P_5",
	title: "Add a webhook retry policy",
	name: "add-a-webhook-retry-policy",
};
const ISSUE: Seed = {
	identity: "github:github.com:I_5",
	title: "Add a webhook retry policy",
	name: "add-a-webhook-retry-policy",
};

/** A pull request listing of the ticket, on the repository the config maps. */
function pullTicket(
	seed: Seed,
	labels: string[],
	over: Partial<Pick<FetchedTicket, "externalKey" | "externalUpdatedAt">> = {},
): FetchedTicket {
	const key = seed.identity.slice(-1);
	return {
		identity: seed.identity,
		sourceKind: "github-pull-request",
		externalKey: `#${key}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/pulls/${key}`,
		title: seed.title,
		description: "The body the agent reads.",
		labels,
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

/** An issue listing of the ticket, on the repository the config maps. */
function issueTicket(
	seed: Seed,
	labels: string[],
	over: Partial<Pick<FetchedTicket, "externalKey" | "externalUpdatedAt">> = {},
): FetchedTicket {
	const key = seed.identity.slice(-1);
	return {
		identity: seed.identity,
		sourceKind: "github-issue",
		externalKey: `#${key}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${key}`,
		title: seed.title,
		description: "The body the agent reads.",
		labels,
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

/** One listing of a ticket on one of the rig's sources. */
interface Listing {
	source: { name: string; kind: GitHubSourceKind };
	ticket: FetchedTicket;
}

interface Rig {
	state: FactoryState;
	runner: FakeRunner;
	dispatch: HandoffDispatch;
	config: FactoryConfig;
	home: string;
	checkout: string;
	events: string[];
	commands: () => string[];
	/** Re-list the tickets the test names, on the sources the listings stand. */
	relist: (listings: Listing[]) => void;
}

const openStates: FactoryState[] = [];
const homes: string[] = [];
afterEach(() => {
	for (const state of openStates.splice(0)) state.close();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function recorder(events: string[]): HandoffDispatchReports {
	return {
		working: (text) => events.push(`working:${text}`),
		warning: (text) => events.push(`warning:${text}`),
		notice: (text) => events.push(`notice:${text}`),
		error: (text) => events.push(`error:${text}`),
		clearWorking: () => events.push("clear-working"),
		refresh: () => events.push("refresh"),
		starting: (identity, active) => events.push(`starting:${identity}:${active ? "on" : "off"}`),
	};
}

/**
 * One module over one in-memory state: the listings name the sources and the
 * tickets the module's starts meet, and the machine defaults to the shipped
 * one, the two pull request states.
 */
function rig(listings: Listing[], machine: WorkflowState[] = BASE_CONFIG.workflowStates): Rig {
	const home = mkdtempSync(join(tmpdir(), "factory-placement-dispatch-"));
	homes.push(home);
	const checkout = join(home, "src", "factory");
	mkdirSync(checkout, { recursive: true });
	const sources = [
		...new Map(listings.map((listing) => [listing.source.name, listing.source])).values(),
	];
	const runner = new FakeRunner();
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	const config: FactoryConfig = {
		...BASE_CONFIG,
		workflowStates: machine,
		sources: sources.map((source) => ({
			...source,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		})),
		repos: { "github.com/acme/factory": checkout },
	};
	const state = new FactoryState(":memory:");
	openStates.push(state);
	state.initializeSources(sources);
	for (const listing of listings) {
		state.applyFetch(listing.source, {
			status: "success",
			fetchedAt: "2026-09-01T00:00:00Z",
			tickets: [listing.ticket],
		});
	}
	const events: string[] = [];
	const dispatch = createHandoffDispatch({
		state,
		runner,
		config: () => config,
		// The cap never engages in these rigs: a test that wants the Work
		// queue counts its seats on its own facts.
		seatCount: () => 0,
		home,
		...recorder(events),
	});
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1", "pane-agent"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", checkout, "--no-focus"], {
		stdout: tabCreateJson("pane-agent", "tab-agent"),
	});
	return {
		state,
		runner,
		dispatch,
		config,
		home,
		checkout,
		events,
		commands: () => runner.commands(),
		relist: (fresh) => {
			for (const listing of fresh) {
				state.applyFetch(listing.source, {
					status: "success",
					fetchedAt: "2026-09-01T00:01:00Z",
					tickets: [listing.ticket],
				});
			}
		},
	};
}

/** A module over the same state and the same Message recorder, with the seat count a test counts. */
function withSeats(rig: Rig, seatCount: () => number): HandoffDispatch {
	return createHandoffDispatch({
		state: rig.state,
		runner: rig.runner,
		config: () => rig.config,
		seatCount,
		home: rig.home,
		...recorder(rig.events),
	});
}

/** The open start the test asks for, with both answers: the dispatch's and the start's. */
function start(
	rig: Rig,
	seed: Seed,
	choice: HandoffChoice,
	over: { automatic?: boolean } = {},
): { enqueued: Promise<DispatchResult>; started: Promise<DispatchResult> } {
	let resolveStarted: (result: DispatchResult) => void;
	const started = new Promise<DispatchResult>((resolve) => {
		resolveStarted = resolve;
	});
	const enqueued = rig.dispatch.dispatch({
		origin: "open",
		ticketIdentity: seed.identity,
		choice,
		previousMessage: "",
		...over,
		onStarted: (result) => resolveStarted(result),
	});
	return { enqueued, started };
}

/** Wait for an event the test names, the way the drain waits for its own. */
async function awaitEvent(
	rig: Rig,
	holds: (event: string) => boolean,
	label: string,
): Promise<void> {
	for (let turn = 0; turn < 400; turn += 1) {
		if (rig.events.some(holds)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`no event stands for ${label}`);
}

const reviewChoice: HandoffChoice = baseChoice("pi", "live-worktree", "review");
const implementChoice: HandoffChoice = baseChoice("pi", "live-worktree", "implement");

const PULL_WRITE =
	"gh pr edit #5 --repo github.com/acme/factory --add-label ready-for-review --remove-label needs-work";

describe("the write the start runs", () => {
	test("a start whose task the ticket does not offer yet writes the labels before the agent starts", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		const { enqueued, started } = start(rigRef, PULL, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		// One write, the source's own edit, the labels the placement adds and
		// removes, and it lands before the agent the start asks for.
		const commands = rigRef.commands();
		expect(commands.indexOf(PULL_WRITE)).toBeGreaterThanOrEqual(0);
		expect(
			commands.indexOf(`herdr agent start ${PULL.name} --kind pi --pane pane-agent`),
		).toBeGreaterThan(commands.indexOf(PULL_WRITE));
		expect(rigRef.events).toContain(
			`notice:placement of "${PULL.title}": added labels ready-for-review; removed labels needs-work`,
		);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("handed-off");
	});

	test("a parked ticket placed by a task a state offers writes before the agent starts", async () => {
		// The ticket stands on the parking state: it matches, and the state
		// offers no task, so the suggestion is null. The operator's choice of
		// a task the machine offers places the ticket into the machine.
		const machine: WorkflowState[] = [
			{ name: "held", match: { sourceKind: "github-issue", labelsAny: ["held"] } },
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-review"] },
			},
		];
		const rigRef = rig([{ source: issuesSource, ticket: issueTicket(ISSUE, ["held"]) }], machine);
		const { enqueued, started } = start(rigRef, ISSUE, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		// The write strips the parking label and adds the state's, and it
		// lands before the agent the start asks for.
		const write =
			"gh issue edit #5 --repo github.com/acme/factory --add-label ready-for-review --remove-label held";
		const commands = rigRef.commands();
		expect(commands.indexOf(write)).toBeGreaterThanOrEqual(0);
		expect(
			commands.indexOf(`herdr agent start ${ISSUE.name} --kind pi --pane pane-agent`),
		).toBeGreaterThan(commands.indexOf(write));
		expect(rigRef.events).toContain(
			`notice:placement of "${ISSUE.title}": added labels ready-for-review; removed labels held`,
		);
		expect(rigRef.state.ticketState(ISSUE.identity)).toBe("handed-off");
	});

	test("the write runs on the newest membership the target state matches, and the other listing stands", async () => {
		// The ticket lists on two issue sources, the same ticket under two
		// keys: the placement names the target state's kind, and the write
		// takes the newest listing of it, the one the ticket's suggestion
		// stands on. The older listing stands untouched.
		const machine: WorkflowState[] = [
			{
				name: "ready-for-agent",
				taskType: "implement",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-review"] },
			},
		];
		const rigRef = rig(
			[
				{ source: issuesSource, ticket: issueTicket(ISSUE, []) },
				{
					source: mirrorSource,
					ticket: issueTicket(ISSUE, ["ready-for-agent"], {
						externalKey: "#7",
						externalUpdatedAt: "2026-08-31T12:00:00Z",
					}),
				},
			],
			machine,
		);
		const { enqueued, started } = start(rigRef, ISSUE, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		const commands = rigRef.commands();
		expect(
			commands.indexOf(
				"gh issue edit #7 --repo github.com/acme/factory --add-label ready-for-review --remove-label ready-for-agent",
			),
		).toBeGreaterThanOrEqual(0);
		expect(commands.some((command) => command.includes("gh issue edit #5"))).toBe(false);
	});
});

describe("the no-placement faces", () => {
	test("a start whose task is the ticket's suggestion takes no egress", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["ready-for-review"]) }]);
		const { enqueued, started } = start(rigRef, PULL, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("handed-off");
	});

	test("the default handoff of a parked ticket takes no egress", async () => {
		// The machine offers nothing the issue ticket matches: the position
		// rests on the default, and the default handoff never differs from it.
		const rigRef = rig([{ source: issuesSource, ticket: issueTicket(ISSUE, ["ready-for-agent"]) }]);
		const { enqueued, started } = start(rigRef, ISSUE, implementChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
	});

	test("an automatic start never places", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		const { enqueued, started } = start(rigRef, PULL, reviewChoice, { automatic: true });
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: true, queued: false });
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
	});
});

describe("the refusal", () => {
	test("an infeasible choice refuses the start, and the ticket keeps its position", async () => {
		const rigRef = rig([{ source: issuesSource, ticket: issueTicket(ISSUE, ["ready-for-agent"]) }]);
		const { enqueued, started } = start(rigRef, ISSUE, reviewChoice);
		// The claim is in and the start is refused where the agent would
		// stand: the dispatch says the claim, the start says the refusal.
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({
			ok: false,
			reason: "task type review is not offered by any state that matches a github-issue ticket",
		});
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
		expect(rigRef.commands().some((command) => command.startsWith("herdr "))).toBe(false);
		expect(rigRef.state.ticketState(ISSUE.identity)).toBe("open");
		expect(rigRef.events).toContain(
			"error:task type review is not offered by any state that matches a github-issue ticket",
		);
	});

	test("a failed write refuses with the source's own words, and closes nothing", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		rigRef.runner.set(
			"gh",
			[
				"pr",
				"edit",
				"#5",
				"--repo",
				"github.com/acme/factory",
				"--add-label",
				"ready-for-review",
				"--remove-label",
				"needs-work",
			],
			{
				code: 1,
				stderr: "gh is unavailable\n",
			},
		);
		const { enqueued, started } = start(rigRef, PULL, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({
			ok: false,
			reason: "gh pr edit #5 failed: gh is unavailable",
		});
		// The refused placement stands before the environment the start would
		// have built: herdr hears nothing at all.
		expect(rigRef.commands().some((command) => command.startsWith("herdr "))).toBe(false);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("open");
		expect(rigRef.events).toContain("error:gh pr edit #5 failed: gh is unavailable");
	});

	test("a start failure after the successful write keeps the write", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		rigRef.runner.set(
			"herdr",
			["agent", "start", PULL.name, "--kind", "pi", "--pane", "pane-agent"],
			{ code: 1, stderr: "the pane is gone\n" },
		);
		const { enqueued, started } = start(rigRef, PULL, reviewChoice);
		await expect(enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(started).resolves.toEqual({ ok: false, reason: "the pane is gone" });
		// The write landed before the start failed: the external effect
		// stands, the ticket keeps its state, and the position now offers
		// the chosen task.
		expect(rigRef.commands().indexOf(PULL_WRITE)).toBeGreaterThanOrEqual(0);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("open");
	});
});

describe("the idempotent rule", () => {
	test("a restart of a refused start re-runs the rule and takes egress only when the labels still differ", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		rigRef.runner.set(
			"herdr",
			["agent", "start", PULL.name, "--kind", "pi", "--pane", "pane-agent"],
			{ code: 1, stderr: "the pane is gone\n" },
		);
		const first = start(rigRef, PULL, reviewChoice);
		await expect(first.enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(first.started).resolves.toEqual({ ok: false, reason: "the pane is gone" });
		// The source re-lists the ticket with the labels the write put on
		// it, and the start the operator re-asks crosses the rule again.
		rigRef.relist([{ source: pullsSource, ticket: pullTicket(PULL, ["ready-for-review"]) }]);
		rigRef.runner.set(
			"herdr",
			["agent", "start", PULL.name, "--kind", "pi", "--pane", "pane-agent"],
			{ code: 0 },
		);
		const second = start(rigRef, PULL, reviewChoice);
		await expect(second.enqueued).resolves.toEqual({ ok: true, queued: true });
		await expect(second.started).resolves.toEqual({ ok: true, queued: false });
		// The labels already match the spec: the re-run takes no egress.
		const edits = rigRef.commands().filter((command) => command.startsWith("gh "));
		expect(edits).toHaveLength(1);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("handed-off");
	});
});

describe("the queue", () => {
	test("a queued start places at its pickup, and a cancelled item never touches the source", async () => {
		const rigRef = rig([{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }]);
		// Every seat is held: the cap is full, and the start waits.
		const capped = withSeats(rigRef, () => rigRef.config.maxParallelAgents);
		await expect(
			capped.dispatch({
				origin: "open",
				ticketIdentity: PULL.identity,
				choice: reviewChoice,
				previousMessage: "",
			}),
		).resolves.toEqual({ ok: true, queued: true });
		// The queued start has not run: the source stands untouched.
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
		// The operator removes the waiting start: the item leaves, and the
		// write it would have run never runs.
		expect(capped.removeQueueItem(PULL.identity)).toBe(true);
		expect(rigRef.state.workQueue()).toHaveLength(0);
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
		// A seat frees and the start the operator re-asks places at its
		// pickup: the write is the pickup's first command.
		await expect(
			capped.dispatch({
				origin: "open",
				ticketIdentity: PULL.identity,
				choice: reviewChoice,
				previousMessage: "",
			}),
		).resolves.toEqual({ ok: true, queued: true });
		const freeing = withSeats(rigRef, () => rigRef.config.maxParallelAgents - 1);
		expect(await freeing.pickupWorkQueue()).toBe(1);
		await awaitEvent(
			rigRef,
			(event) => event === `starting:${PULL.identity}:off`,
			"the start's settle",
		);
		expect(rigRef.commands().some((command) => command === PULL_WRITE)).toBe(true);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("handed-off");
	});

	test("a queued override whose labels move while it waits is dropped at its pickup, and the force-dispatch refuses the same way", async () => {
		const machine: WorkflowState[] = [
			{
				name: "needs-work",
				taskType: "rework",
				match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: {
					sourceKind: "github-pull-request",
					labelsAny: ["ready-for-review"],
					labelsNone: ["wip"],
				},
			},
		];
		const rigRef = rig(
			[{ source: pullsSource, ticket: pullTicket(PULL, ["needs-work"]) }],
			machine,
		);
		const capped = withSeats(rigRef, () => rigRef.config.maxParallelAgents);
		await expect(
			capped.dispatch({
				origin: "open",
				ticketIdentity: PULL.identity,
				choice: reviewChoice,
				previousMessage: "",
			}),
		).resolves.toEqual({ ok: true, queued: true });
		// The source moves the ticket while it waits: the label the target
		// state excludes stands on it now.
		rigRef.relist([{ source: pullsSource, ticket: pullTicket(PULL, ["wip"]) }]);
		const freeing = withSeats(rigRef, () => rigRef.config.maxParallelAgents - 1);
		expect(await freeing.pickupWorkQueue()).toBe(1);
		await awaitEvent(
			rigRef,
			(event) =>
				event ===
				`warning:queued handoff for "${PULL.title}" was not run: state ready-for-review excludes label wip, and the ticket carries it`,
			"the pickup's refusal",
		);
		// The pickup's drop (ADR 0049): a pickup that fails a check leaves the
		// item out of the queue with the warning, the ticket keeps its state,
		// and the source stands untouched.
		expect(rigRef.state.workQueue()).toHaveLength(0);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("open");
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
		// The force-dispatch re-runs the same check and refuses the same way:
		// the item leaves with the warning, and the write never runs. The item
		// enters the queue directly, because a dispatch's own pickup would
		// drop it before the force-dispatch could meet it.
		const enqueued = rigRef.state.enqueueWork({
			ticketIdentity: PULL.identity,
			origin: "open",
			choice: reviewChoice,
			previousMessage: "",
		});
		if (enqueued.ok !== true) throw new Error(enqueued.reason);
		freeing.forceDispatchWorkQueueItem(PULL.identity);
		await awaitEvent(
			rigRef,
			(event) =>
				event ===
				`warning:force-dispatch of "${PULL.title}" failed: state ready-for-review excludes label wip, and the ticket carries it`,
			"the force-dispatch's refusal",
		);
		expect(rigRef.state.workQueue()).toHaveLength(0);
		expect(rigRef.state.ticketState(PULL.identity)).toBe("open");
		expect(rigRef.commands().some((command) => command.startsWith("gh "))).toBe(false);
	});
});
