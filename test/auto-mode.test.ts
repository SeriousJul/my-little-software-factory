/**
 * The unattended mode through the real UI: the mode cell, the `a` toggle that
 * writes the mode to the state file, the blocked and missing markers, the missing
 * panel (restart / abandon), the decision modal on an awaiting ticket, and
 * the auto dispatch of open tickets.
 *
 * Every test boots the real app with a real SQLite state seeded through the
 * state API, a fake ticket source, a fake command runner, and a pinned
 * poll interval, so the observation loop and the handoff pipeline run
 * without a herdr session or a source clock.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// readFileSync checks the config file: the toggle writes the state file, never it.
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FactoryConfig, TicketSourceConfig, TransitionOutcome } from "../src/config.ts";
import { type FetchedTicket, withIssueReferences } from "../src/domain/ticket.ts";
import { agentNameFor, cycleAgentName } from "../src/naming.ts";
import type { CommandRunner } from "../src/runner.ts";
import type { FactoryState } from "../src/state.ts";

import type { FetchOutcome } from "../src/ticket-source.ts";
import type { TurnEndCause, TurnLogEntry } from "../src/turn-log.ts";
import {
	type AppSetup,
	actionBarRowOf,
	awaitFrame,
	confirmPanel,
	detailPaneText,
	focusDetail,
	frameText,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	openSurface,
	press,
	pressArrow,
	pressEnterQuiet,
	pressQuiet,
	pressScrollKey,
	rgb,
	roleColor,
	rowsOf,
	settle,
	sleep,
	spanColors,
	startingFaceOf,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { DEFAULT_TICKET_TITLE, fetchedTicket } from "./fact-fixtures.ts";
import { FakeRunner, herdrFocusCommands } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { type GatedRunner, gatedRunner as gateOnRunner } from "./gated-runner.ts";
import type {
	WorldBranchDescription,
	WorldCheckoutDescription,
	WorldPaneDescription,
	WorldTabDescription,
	WorldWorkspaceDescription,
	WorldWorktreeDescription,
} from "./herdr-world.ts";

/** A checkout the standing names with its branches and worktrees held. */
type StandingCheckout = WorldCheckoutDescription & {
	branches: WorldBranchDescription[];
	worktrees: WorldWorktreeDescription[];
};

import {
	type HerdrWorldDescription,
	type StubHerdrWorld,
	stubHerdrWorld,
	type WorldAgentDescription,
	type WorldEgress,
	worldEgress,
} from "./herdr-world.ts";
import { type Plane, plane, reopenState } from "./plane.ts";
import { infoLine, type RecordedLine, recordLogger } from "./record-logger.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const secondIdentity = "github:github.com:I_6";
const repoIdentity = "github.com/acme/factory";

/**
 * The source config the plane's config carries for the fixture's issues
 * source: the same name and kind the state file's source fact stands on.
 */
const issuesSource: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: [repoIdentity],
	host: "github.com",
};
/** The pull request source config, where a test names a pull outcome. */
const pullsSource: TicketSourceConfig = {
	name: "pulls",
	kind: "github-pull-requests",
	refreshIntervalSeconds: 60,
	repositories: [repoIdentity],
	host: "github.com",
};
/**
 * The herdr names the naming rule gives the fixture Ticket (ADR 0098): its
 * stable name, and the name of its second work cycle.
 */
const AGENT = agentNameFor({ identity, title: DEFAULT_TICKET_TITLE });
const CYCLE2 = cycleAgentName({ identity, title: DEFAULT_TICKET_TITLE }, 2);
/** The herdr name the naming rule gives the second fixture Ticket. */
const SECOND_AGENT = agentNameFor({ identity: secondIdentity, title: "Watch agent turns" });
/**
 * The outcome the implement transition produced for these tests: it fired,
 * wrote ready-for-review to the ticket (removing ready-for-agent), and the
 * machine re-derived the review position on the ticket itself.
 */
function reviewRoute(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: "",
		ticketFacts: ["ready-for-review"],
		pullRequestFacts: [],
		ticketWrite: { added: ["ready-for-review"], removed: ["ready-for-agent"] },
		pullRequestWrite: null,
		pullRequestIdentity: null,
		pullRequestKey: null,
		writeFailure: "",
		positionTaskType: "review",
		positionTicketIdentity: identity,
		...over,
	};
}
/**
 * A terminal wide enough to hold a whole Message line at once.
 *
 * The status row is one line, truncated to the terminal width, so a test
 * that reads two facts off it (a failure and the warning that came with it)
 * needs the room for both.
 */
const WIDE_STATUS = 240;
/** A fetched ticket of the issues source; the index is the issue number. */
function fetched(
	index = 5,
	title = DEFAULT_TICKET_TITLE,
	labels: readonly string[] = ["ready-for-agent"],
): FetchedTicket {
	return fetchedTicket({
		identity: `github:github.com:I_${index}`,
		title,
		labels: [...labels],
	});
}

/** The commands that change herdr's or git's state: every read is dropped. */
function changed(commands: string[]): string[] {
	return commands.filter(
		(command) =>
			!command.startsWith("herdr agent list") &&
			!command.startsWith("herdr workspace list") &&
			!command.startsWith("herdr pane"),
	);
}

const success: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched()],
};

/** Two open tickets of the same repository: a queue the dispatch can form. */
const pairSuccess: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched(5, DEFAULT_TICKET_TITLE), fetched(6, "Watch agent turns")],
};

/** A checkout directory the config maps the ticket's repository to. */
function checkout(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-checkout-"));
	paths.push(dir);
	return dir;
}

/** The clone URL the suite's repository holds. */
const CLONE_URL = `https://${repoIdentity}.git`;

/** The worktree branch a seeded ticket works on, by the ticket's identity. */
const WORKTREE_BRANCH: Record<string, string> = {
	[identity]: "factory/5-persist-source-facts",
	[secondIdentity]: "factory/6-watch-agent-turns",
};

/**
 * The factory branches the stored tickets work on hold no open pull request:
 * the cycle-end draft close and the launch's own-pull read both answer the
 * honest empty list instead of the fake's blank answer.
 */
function pinEmptyPullLists(github: FakeRunner): void {
	for (const branch of Object.values(WORKTREE_BRANCH))
		github.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/acme/factory/pulls?state=open&head=${encodeURIComponent(`acme:${branch}`)}`,
			],
			{ stdout: "[]\n" },
		);
}

/** The standing's lists, filled by the standing's parts. */
interface StandingLists {
	workspaces: WorldWorkspaceDescription[];
	tabs: WorldTabDescription[];
	panes: WorldPaneDescription[];
}

/** The second ticket's environment, beside the first's: its branch and worktree when it works a worktree, and its stored workspace, tab, and pane on the path its environment stands on. */
function secondStanding(
	environment: "live-worktree" | "worktree",
	options: {
		checkout: StandingCheckout;
		lists: StandingLists;
		worktreesRoot: string;
		tabStands: boolean;
	},
): void {
	const { checkout, lists, worktreesRoot, tabStands } = options;
	const branch = WORKTREE_BRANCH[secondIdentity];
	const path =
		environment === "worktree"
			? join(worktreesRoot, branch.slice("factory/".length))
			: checkout.path;
	if (environment === "worktree") {
		checkout.branches.push({ name: branch, remote: true });
		checkout.worktrees.push({ path, branch, linked: true });
	}
	if (tabStands) {
		// The standing carries the second ticket's tab in its own workspace.
		lists.workspaces.push({
			id: "ws-2",
			checkoutPath: path,
			...(environment === "worktree" ? { isWorktree: true } : {}),
		});
		lists.tabs.push({ id: "tab-2", workspaceId: "ws-2", cwd: path });
		lists.panes.push({ id: "pane-2", tabId: "tab-2", workspaceId: "ws-2" });
	}
}

/** The ticket's branch on origin and the worktree git links under the root. Returns the path the standing stands on. */
function worktreeStanding(
	checkout: StandingCheckout,
	options: {
		fields: SeededFields;
		worktreesRoot: string;
	},
): string {
	const { fields, worktreesRoot } = options;
	const branch = WORKTREE_BRANCH[identity];
	const path = join(worktreesRoot, branch.slice("factory/".length));
	checkout.branches = [
		{ name: "main", remote: true },
		{ name: branch, remote: true },
	];
	checkout.worktrees = [
		{
			path,
			branch,
			linked: true,
			...(fields.dirtyWorktree ? { dirty: true } : {}),
		},
	];
	return path;
}

/** The stored handoff's workspace, tab, and pane. */
function storedStanding(
	environment: "live-worktree" | "worktree",
	standingPath: string,
	fields: SeededFields,
	lists: StandingLists,
): void {
	lists.workspaces.push({
		id: "ws-1",
		checkoutPath: standingPath,
		...(environment === "worktree" ? { isWorktree: true } : {}),
	});
	lists.tabs.push({ id: "tab-1", workspaceId: "ws-1", cwd: standingPath });
	lists.panes.push({
		id: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
		...(fields.paneContent?.["pane-1"] !== undefined
			? { content: fields.paneContent["pane-1"] }
			: {}),
	});
}

/** An agent in a pane beyond the stored tab brings its own tab in the standing's workspace, or its own workspace beside the checkout. */
function agentStands(
	environment: "live-worktree" | "worktree",
	standingPath: string,
	fields: SeededFields,
	lists: StandingLists,
): void {
	for (const agent of fields.agents ?? []) {
		if (lists.panes.some((pane) => pane.id === agent.paneId)) continue;
		let workspaceId = lists.workspaces[0]?.id;
		if (workspaceId === undefined) {
			workspaceId = "ws-1";
			lists.workspaces.push({
				id: workspaceId,
				checkoutPath: standingPath,
				...(environment === "worktree" ? { isWorktree: true } : {}),
			});
		}
		const tabId = `tab-${agent.paneId.slice("pane-".length)}`;
		if (!lists.tabs.some((tab) => tab.id === tabId)) lists.tabs.push({ id: tabId, workspaceId });
		lists.panes.push({
			id: agent.paneId,
			tabId,
			workspaceId,
			...(fields.paneContent?.[agent.paneId] !== undefined
				? { content: fields.paneContent[agent.paneId] }
				: {}),
		});
	}
}

/**
 * The world the seeded app runs on: the repository's checkout, the stored
 * handles the shape carries, and the agents and pane contents the test names.
 *
 * The stored tab stands in herdr for a stored handoff unless the test says it
 * is gone: a launch then reuses the workspace the standing holds, and a launch
 * the standing leaves without one makes a fresh workspace, the way herdr hands
 * out its handles from the highest id it holds.
 */
function worldStanding(
	shape: "open" | "in-flight" | "awaiting",
	environment: "live-worktree" | "worktree",
	fields: SeededFields,
	checkoutPath: string,
): HerdrWorldDescription {
	const worktreesRoot = join(dirname(checkoutPath), "worktrees");
	const checkout: StandingCheckout = {
		path: checkoutPath,
		cloneUrl: CLONE_URL,
		defaultBranch: "main",
		worktreesRoot,
		branches: [],
		worktrees: [],
	};
	const world: HerdrWorldDescription = {
		checkouts: [checkout],
		workspaces: [],
		tabs: [],
		panes: [],
		agents: fields.agents ?? [],
	};
	const lists: StandingLists = { workspaces: [], tabs: [], panes: [] };
	world.workspaces = lists.workspaces;
	world.tabs = lists.tabs;
	world.panes = lists.panes;
	const tabStands = fields.tabStands ?? shape !== "open";
	const standingPath =
		environment === "worktree"
			? worktreeStanding(checkout, { fields, worktreesRoot })
			: checkoutPath;
	if (fields.secondEnvironment !== undefined)
		secondStanding(fields.secondEnvironment, { checkout, lists, worktreesRoot, tabStands });
	if (tabStands) storedStanding(environment, standingPath, fields, lists);
	agentStands(environment, standingPath, fields, lists);
	return world;
}

/** The settled handoff's turn facts, and the clock the state writes with. */
interface SeedDetail {
	/** The transition outcome to store on the settled turn; no transition when absent. */
	transition?: TransitionOutcome | null;
	/** The task type the seeded turn ran under; the automatic rule's Operator-decides check reads it (ADR 0085, renamed by ADR 0092). */
	taskType?: string;
	message?: string;
	model?: string;
	thinking?: string;
	contextWindow?: string;
	turnLog?: TurnLogEntry[];
	/**
	 * The cause the seeded turn settles with. The default is the fail-open
	 * `unknown`; a test that seeds a finished turn names `completed`.
	 */
	cause?: TurnEndCause;
	/**
	 * The state's clock. Pin it in the past to age the stored handoff, so a
	 * missing agent is past the startup grace: it died, it did not fail to
	 * boot.
	 */
	stateNow?: () => number;
	/**
	 * The Auto-handoff mode the state file holds before the app mounts.
	 *
	 * The mode is factory state (ADR 0036), so a test that needs auto mode
	 * writes it to the state file the way the `a` key does. The key is not
	 * in the config schema (ADR 0036); a file that still carries it fails
	 * startup naming the key.
	 */
	autoMode?: boolean;
}

/**
 * A state with the ticket in the given shape: open, in flight with the
 * stored herdr handles, or awaiting with a settled completion. The stored
 * handoff takes the given environment kind.
 */
function seed(
	shape: "open" | "in-flight" | "awaiting",
	outcome: FetchOutcome = success,
	environment: "live-worktree" | "worktree" = "live-worktree",
	detail: SeedDetail = {},
): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
	paths.push(dir);
	const state = reopenState(join(dir, "state.sqlite"), detail.stateNow);
	state.sourceFact.initializeSources([source]);
	state.sourceFact.applyFetch(source, outcome);
	if (shape !== "open") seedStoredHandoff(state, shape, environment, detail);
	return state;
}

/** The stored handoff one non-open shape claims, settles, and settles the turn for. */
function seedStoredHandoff(
	state: FactoryState,
	shape: "in-flight" | "awaiting",
	environment: "live-worktree" | "worktree",
	detail: SeedDetail,
): void {
	const message = detail.message ?? "The turn is done.";
	const claim = state.handoff.claimHandoff(
		identity,
		{
			agentType: "pi",
			environment,
			taskType: detail.taskType ?? "implement",
			model: detail.model ?? "",
			thinking: detail.thinking ?? "",
			contextWindow: detail.contextWindow ?? "",
		},
		"open",
	);
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	if (shape === "awaiting") {
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: detail.taskType ?? "implement",
			agentType: "pi",
			message,
			turnLog: detail.turnLog ?? [{ kind: "text", text: message }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: detail.cause,
			...(detail.transition === undefined || detail.transition === null
				? {}
				: { transition: detail.transition }),
		});
	}
}

interface SeededApp {
	state: FactoryState;
	config: FactoryConfig;
	/** The Stub herdr world: the herdr side and the git side of the egress. */
	world: StubHerdrWorld;
	/** The GitHub side of the egress, which the world does not hold. */
	github: FakeRunner;
	/** The plane's egress: herdr and git to the world, the GitHub side to the fake. */
	runner: WorldEgress;
	configPath: string;
	src: FakeSource;
	/** The pull request source, when the test names an outcome for it. */
	pullSrc?: FakeSource;
}

/**
 * The standing the seeded app runs on, beside the state shape: the world the
 * herdr side and the git side of the egress answer from.
 */
interface SeededFields {
	extra?: Partial<FactoryConfig>;
	outcome?: FetchOutcome;
	environment?: "live-worktree" | "worktree";
	detail?: SeedDetail;
	pullOutcome?: FetchOutcome;
	/**
	 * The agents the world holds, beside their panes. A test that needs the
	 * stored pane's tab and workspace beside an agent names the agent's pane
	 * as the stored handle; an agent in another pane stands in its own tab.
	 */
	agents?: WorldAgentDescription[];
	/**
	 * A tab stands in herdr on the standing's path: a launch reuses its
	 * workspace. On by default for the stored-handoff shapes, off for the open
	 * checkout; a test names it to stand the workspace beside an open ticket,
	 * or to model a stored handoff herdr holds no tab of, when the launch makes
	 * a fresh workspace.
	 */
	tabStands?: boolean;
	/**
	 * The second ticket's environment stands open in its own workspace beside
	 * the first's: the standing carries its branch and worktree when it works
	 * a worktree, and its stored tab either way.
	 */
	secondEnvironment?: "live-worktree" | "worktree";
	/** The stored worktree's checkout is dirty: herdr will not remove it. */
	dirtyWorktree?: boolean;
	/** The content an `agent read` of one pane returns, by the pane's id. */
	paneContent?: Record<string, string>;
}

/** A seeded state plus the app props that match it: config, world, source. */
function seededApp(shape: "open" | "in-flight" | "awaiting", fields: SeededFields = {}): SeededApp {
	const {
		extra = {},
		outcome = success,
		environment = "live-worktree",
		detail = {},
		pullOutcome,
	} = fields;
	const state = seed(shape, outcome, environment, detail);
	// The operator's last choice of the mode is a fact of the state file, not
	// of the config (ADR 0036), so the seed writes it before the app mounts.
	if (detail.autoMode === true) state.handoff.setAutoHandoffMode(true);
	const path = checkout();
	const home = mkdtempSync(join(tmpdir(), "factory-auto-home-"));
	paths.push(home);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config: FactoryConfig = {
		...BASE_CONFIG,
		repos: { [repoIdentity]: path },
		workflowStates: [
			{ name: "ready-for-review", taskType: "review", match: { labelsAny: ["ready-for-review"] } },
		],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			implement: {
				...BASE_CONFIG.taskTypes.implement,
				transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
			},
		},
		...extra,
	};
	// The world holds the checkout the config maps, the standing's handles, and
	// the test's agents: the plane's boot reads it the way a handoff would, and
	// a test that needs a failing read names its own answer over it.
	const world = stubHerdrWorld(worldStanding(shape, environment, fields, path));
	// The GitHub side the world does not hold: the `gh` writes and the desktop
	// notifications fall through to the fake the suite keeps beside the world.
	const github = new FakeRunner();
	pinEmptyPullLists(github);
	const runner = worldEgress(world, github);
	const src = new FakeSource("issues", "github-issues", outcome);
	const pullSrc =
		pullOutcome === undefined
			? undefined
			: new FakeSource("pulls", "github-pull-requests", pullOutcome);
	return {
		state,
		config,
		world,
		github,
		runner,
		configPath,
		src,
		...(pullSrc === undefined ? {} : { pullSrc }),
	};
}

/**
 * The Seeded plane the seeded app's state boots from.
 *
 * The fixture's own state, config, egress, and source doubles stand in their
 * old places: the boot read answers the fixture's snapshot, a test's settle
 * stands beside it, and the config the plane writes carries the fixture's
 * source configs in place of the fixture's empty default.
 */
async function planeOf(app: SeededApp, runner?: CommandRunner): Promise<Plane> {
	return plane({
		config: {
			...app.config,
			sources: app.pullSrc === undefined ? [issuesSource] : [issuesSource, pullsSource],
		},
		existing: app.state,
		groupingAxis: "none",
		runner: () => runner ?? app.runner,
		prepare: async () => ({
			boundSources: app.pullSrc === undefined ? [app.src] : [app.src, app.pullSrc],
		}),
	});
}

/**
 * A seeded app and the plane it boots from.
 *
 * The world answers the boot's agent list with the standing it holds, so the
 * boot's observation tick reads the test's own agents, and none.
 */
async function bootedApp(
	shape: "open" | "in-flight" | "awaiting",
	fields: SeededFields = {},
): Promise<{ app: SeededApp; planeRecord: Plane }> {
	const app = seededApp(shape, fields);
	return { app, planeRecord: await planeOf(app) };
}

/**
 * The loop policy the old fixture's boot carried: the observation loop on
 * its pinned interval, which a test's own settles drive instead of a clock.
 */
const LOOP_60S = { kind: "polled", intervalMs: 60_000 } as const;

/**
 * A seeded app whose state file already holds the Auto-handoff mode.
 *
 * The mode is factory state (ADR 0036): the plane reads it off the state file
 * at startup, so a test that needs auto mode writes it there the way the `a`
 * key does, instead of carrying a config default.
 */
function seededAppInAutoMode(
	shape: "open" | "in-flight" | "awaiting",
	fields: SeededFields = {},
): SeededApp {
	return seededApp(shape, {
		...fields,
		detail: { ...fields.detail, autoMode: true },
	});
}

/**
 * The app re-reads the ticket's source when a cycle ends, so a seeded close
 * that the next claim follows takes that re-read with it: the open ticket is
 * re-verified at the given time.
 */
function reverify(app: SeededApp, outcome: FetchOutcome, at: string): void {
	const refetch: FetchOutcome =
		outcome.status === "success"
			? { status: "success", fetchedAt: at, tickets: outcome.tickets }
			: outcome;
	app.state.sourceFact.applyFetch(source, refetch);
}

/**
 * The app re-reads the ticket's source when a cycle ends inside the app.
 * Settle that re-read at a time after the decision: the open ticket is
 * re-verified for the next handoff.
 */
async function settleReverify(src: FakeSource, outcome: FetchOutcome): Promise<void> {
	const refetch: FetchOutcome =
		outcome.status === "success"
			? {
					status: "success",
					fetchedAt: new Date(Date.now() + 60_000).toISOString(),
					tickets: outcome.tickets,
				}
			: outcome;
	src.settle(refetch);
	// Let the coordinator's applyFetch land before the next key goes out.
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** Enter through the real key path, then wait for its effect. */
async function pressReturn(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	return await awaitFrame(setup, predicate, what);
}

/** Escape through the real key path, then wait for its effect. */
async function pressEscape(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEscape();
	return await awaitFrame(setup, predicate, what);
}

/**
 * The ticket's list row, by its title.
 *
 * The dual-list frame (ADR 0019) truncates the list row's title - at the
 * handoff limit, to its leading cells - so the row is found by the selection
 * marker and the title's leading cells, with the full-title row (the detail
 * pane, the modal's title) as the fallback a modal frame offers.
 */
function ticketRow(frame: string, title = DEFAULT_TICKET_TITLE): string {
	const rows = rowsOf(frame);
	const row =
		rows.find((line) => line.includes("❯") && line.includes(title.slice(0, 3))) ??
		rows.find((line) => line.includes(title));
	if (row === undefined) throw new Error(`no ticket row for ${title} in frame:\n${frame}`);
	return row;
}

describe("the mode cell and the a key", () => {
	test("the mode cell reports the mode, and a writes the mode to the state file", async () => {
		const app = seededApp("open");
		const before = readFileSync(app.configPath, "utf8");

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				await press(setup, "a", "auto on", (f) => f.includes("○ auto 0/2"));
				// The flip is factory state (ADR 0036): it is on the state file the
				// moment the key lands, and the toggle never writes the config file.
				expect(app.state.handoff.autoHandoffMode()).toBe(true);
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
				await press(setup, "a", "auto off", (f) => f.includes("● manual 0/2"));
				expect(app.state.handoff.autoHandoffMode()).toBe(false);
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a restart on the same state file finds the mode where the operator left it", async () => {
		const app = seededApp("open");
		const statePath = app.state.path;
		const planeRecord = await planeOf(app);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				await press(setup, "a", "auto on", (f) => f.includes("○ auto 0/2"));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		// The end of the run: the plane closes its state file, as a restart or a
		// dev reload does.
		planeRecord.close();

		// The next run reads the mode back off the same file, not off the config.
		const reopened = reopenState(statePath);
		expect(reopened.handoff.autoHandoffMode()).toBe(true);
		const src = new FakeSource("issues", "github-issues", success);
		const restarted = await plane({
			config: { ...app.config, sources: [issuesSource] },
			existing: reopened,
			runner: () => app.runner,
			prepare: async () => ({ boundSources: [src] }),
		});
		await withApp(
			async (setup) => {
				src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("○ auto 0/2"),
					"the restarted mode cell",
				);
				expect(frame).not.toContain("● manual");
			},
			{ width: WIDTH, height: HEIGHT, plane: restarted, loopPolicy: LOOP_60S },
		);
		restarted.close();
	});

	test("a fresh state file starts with auto off", async () => {
		// The mode has no config default (ADR 0036): the state file answers for
		// it, and a file the plane has just created holds the mode off.
		const { app, planeRecord } = await bootedApp("open");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				expect(frame).not.toContain("○ auto");
				expect(app.state.handoff.autoHandoffMode()).toBe(false);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	/**
	 * The mode in the plane's record (issue #223). The mode decides every automatic
	 * walk in the run, and until now its flips left no line anywhere: a reviewer
	 * reading the log could not tell a manual run from an automatic one.
	 */
	test("the a key leaves the mode flip in the record", async () => {
		const app = seededApp("open");
		const lines: RecordedLine[] = [];
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				await press(setup, "a", "auto on", (f) => f.includes("○ auto 0/2"));
				await press(setup, "a", "auto off", (f) => f.includes("● manual 0/2"));
				// One line per key, in the order the keys landed, each at the `info` level
				// the configuration reference states for it. The `mode:` prefix is the
				// record's family for the facts the operator sets by key. The cycle's own hold
				// lines share the logger and are not this fact's lines.
				expect(lines.filter((line) => line.message.startsWith("mode: auto-handoff is"))).toEqual([
					infoLine("mode: auto-handoff is on"),
					infoLine("mode: auto-handoff is off"),
				]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: LOOP_60S,
				logger: recordLogger(lines),
			},
		);
		planeRecord.close();
	});

	test("a mode write the state file refuses reports, and the flip stands", async () => {
		const app = seededApp("open");
		const lines: RecordedLine[] = [];

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				// The real write path, made to fail: the mode table is gone from the
				// state file, so the plane's next write to it is refused by SQLite.
				// The busy timeout covers the refresh write still in flight.
				const damage = new Database(app.state.path);
				damage.exec("PRAGMA busy_timeout = 5000;");
				damage.exec("DROP TABLE auto_handoff_mode;");
				damage.close();
				await press(setup, "a", "auto on", (f) => f.includes("○ auto 0/2"));
				// The in-session flip stands, and the failure names the state file
				// the plane could not write and says how long the flip lives.
				const frame = await settle(setup);
				expect(frame).toContain("○ auto 0/2");
				expect(messageRowOf(frame)).toContain("auto-handoff is on for this session only:");
				expect(messageRowOf(frame)).toContain(app.state.path);
				expect(messageRowOf(frame).trim()).toContain("Error:");
				// The mode cell keeps the flipped mode, not the stored one.
				expect(frameText(setup.captureCharFrame())).toContain("○ auto 0/2");
				// The record states the refused flip the way the Message line does
				// (issue #223). A file that said `auto-handoff is on` while the next run
				// reads the old value is a record a reviewer cannot trust. The refused flip
				// is news the operator must not miss, so it leaves at `warn` where the flip
				// that landed leaves `info`.
				const recorded = lines.filter((line) => line.message.startsWith("mode: auto-handoff is"));
				expect(recorded).toHaveLength(1);
				expect(recorded[0]?.level).toBe("warn");
				expect(recorded[0]?.message).toContain("mode: auto-handoff is on for this session only:");
				expect(recorded[0]?.message).toContain(app.state.path);
			},
			{
				width: WIDE_STATUS,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: LOOP_60S,
				logger: recordLogger(lines),
			},
		);
		planeRecord.close();
	});

	test("an unlimited parallel limit shows the bare count on the mode cell", async () => {
		const app = seededApp("in-flight", {
			extra: { maxParallelAgents: 0 },
			agents: [{ name: AGENT, kind: "pi", status: "blocked", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("● manual 1"),
					"the unlimited mode cell",
				);
				// The count stands without a limit after it: no `/0` anywhere.
				expect(frame).toContain("● manual 1");
				expect(frame).not.toContain("/0");
				// The blocked agent still holds its seat, with no limit to hold it to.
				expect(ticketRow(frame)).toContain("blocked");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a working Consultation holds its seat beside the ticket seat on the mode cell", async () => {
		const app = seededApp("in-flight", {
			agents: [
				{ name: AGENT, kind: "pi", status: "working", paneId: "pane-1" },
				{ name: "consultation-11111111", kind: "pi", status: "working", paneId: "pane-2" },
			],
		});
		// The Consultation starts in opening and takes its confirmed Agent with
		// it into working, so the poll keeps it where it is.
		app.state.consultationRecord.createConsultation({
			id: "consultation-1",
			typeName: "grill-with-docs",
			agentType: "pi",
			environment: "worktree",
			model: "",
			thinking: "",
			contextWindow: "",
			template: "/skill:grill-with-docs {input}",
			initialInput: "Review this repository",
			renderedOpeningPrompt: "/skill:grill-with-docs Review this repository",
			repository: {
				identity: repoIdentity,
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
				path: "/tmp/factory",
			},
			agentName: "consultation-11111111",
			createdAt: "2026-08-31T09:50:00.000Z",
		});
		app.state.consultationRecord.setConsultationAgent("consultation-1", {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The ticket seat and the Consultation seat fill the limit of
				// two in one number on the mode cell.
				await awaitFrame(setup, (f) => f.includes("● manual 2/2"), "the mode cell");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the failure markers", () => {
	test("a blocked agent marks its running ticket", async () => {
		const app = seededApp("in-flight", {
			agents: [{ name: AGENT, kind: "pi", status: "blocked", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("blocked"),
					"the blocked badge",
				);
				// The agent is alive but not working: the state badge is replaced by the
				// blocked badge, and the live agent count still holds its slot.
				expect(ticketRow(frame)).toContain("blocked");
				expect(frame).toContain("● manual 1/2");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a missing agent gets the missing marker and the missing modal", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: // The agent ran a while before it died: the handoff is past the
				// startup grace, so the missing agent is not a booted one and
				// holds no seat.
				{ stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("missing"),
					"the missing badge",
				);
				// The missing badge replaces the state badge although no state changed:
				// manual mode never acts on a missing agent. The missing agent holds no
				// slot, so the shared seat count is zero.
				expect(frame).toContain("● manual 0/2");
				expect(ticketRow(frame)).toContain("missing");

				// Enter on the in-flight missing ticket opens the missing modal.
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Restart");
				expect(panel).toContain("Abandon");

				// Abandon is the last action: one down, confirm.
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				// The open ticket keeps no failure badge.
				expect(ticketRow(await settle(setup))).not.toContain("missing");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("restart in the Missing modal repeats the interrupted handoff choices", async () => {
		const app = seededApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: "",
				model: "gpt-5.6",
				thinking: "high",
				// The agent ran a while before it died: past the startup grace.
				stateNow: () => Date.now() - 600_000,
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the Missing modal", (f) => f.includes("Missing:"));
				const modal = frameText(await settle(setup));
				expect(modal).toContain("Restart");
				expect(modal).toContain("same task type, same workspace");
				expect(modal).toContain("Abandon");
				await pressReturn(setup, "the restart handoff", (_frame) =>
					app.runner.commands().some((command) => command.startsWith("herdr agent prompt")),
				);
				expect(app.runner.commands()).toContain(
					`herdr agent start ${AGENT} --kind pi --pane pane-2 -- --model gpt-5.6 --thinking high`,
				);
				expect(app.state.ticketWorkCycle.ticketListViews([], "implement").rows[0].handoff).toEqual(
					expect.objectContaining({
						model: "gpt-5.6",
						thinking: "high",
						paneId: "pane-2",
					}),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("abandon in the Missing modal closes the cycle and increments its durable number", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the Missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		reverify(app, success, new Date(Date.now() + 60_000).toISOString());
		const next = app.state.handoff.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!next.ok) throw new Error(next.reason);
		app.state.handoff.settleHandoff(next.claim.attemptId, true);
		expect(app.state.ticketWorkCycle.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity, workCycle: 2 }),
		]);
		planeRecord.close();
	});

	test("enter on a blocked ticket opens the Live view without acting", async () => {
		const app = seededApp("in-flight", {
			agents: [{ name: AGENT, kind: "pi", status: "blocked", paneId: "pane-1" }],
			paneContent: { "pane-1": "the agent is waiting on a build\n" },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("blocked"), "the blocked badge");
				// Enter on the blocked ticket opens the Live view: the Goto is
				// one confirm away, and nothing focuses before it.
				await pressReturn(setup, "the Live view", (f) =>
					f.includes(`Live: ${DEFAULT_TICKET_TITLE}`),
				);
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent focus");
				// The stream shows the pane output under the ticket's context,
				// and the blocked status stands on the context line.
				await awaitFrame(setup, (f) => f.includes("the agent is waiting on a build"), "the stream");
				expect(frameText(setup.captureCharFrame())).toContain("acme/factory · implement · pi");
				// The pop-in fades in for a little while, so wait it out before
				// reading the painted colors: mid-fade they are blended.
				await sleep(250);
				expect(spanColors(setup, "blocked")).toContainEqual(rgb(roleColor("yellow")));
				// Enter confirms the Goto: the focus runs, the view closes, and
				// the ticket stays in flight with the blocked badge standing.
				await pressReturn(setup, "the focus", (f) => f.includes("focused the agent"));
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
				expect(ticketRow(await settle(setup))).toContain("blocked");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("esc on the missing modal closes it and leaves the ticket in flight", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				// The panel key handler subscribes in an effect that flushes after
				// the commit; a settled frame proves the panel is open and ready.
				await settle(setup);
				// Esc cancels: nothing runs, no decision lands.
				await pressEscape(setup, "the panel to close", (f) => !f.includes("Missing:"));
				// The ticket is still in flight with its missing agent.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
				expect(ticketRow(await settle(setup))).toContain("missing");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a ticket at the handoff limit wears the trailing marker on its row", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: { maxHandoffsPerTicket: 1 },
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("handoff limit"),
					"the handoff limit marker",
				);
				// The marker rides at the end of the list row. The terminal row
				// also carries the detail pane, so check only the list half.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row.endsWith("handoff limit")).toBe(true);
				// The limit does not unhand the ticket: it stays in flight, and its
				// missing agent still stands out in the badge's place.
				expect(row).toContain("missing");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

// The Delete key closes the work cycle of the selected Ticket from either
// Ticket pane (ADR 0031, ADR 0122). An open Ticket is refused with its
// reason; every state that has work behind it asks first, and the dialog
// states who is alive and what survives. An in-flight cycle ends with no
// completion trace, because its turn never settled; an `awaiting` one records
// the closed decision, the same action the Decision modal's Close row offers.
describe("the Ticket Close key", () => {
	test("the Action bar names Close on the Delete key beside the Ticket section's Goto", async () => {
		const app = seededApp("in-flight", {
			agents: [{ name: AGENT, kind: "pi", status: "working", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => actionBarRowOf(f).includes("Delete Close"),
					"the Close hint on the bar",
				);
				const bar = actionBarRowOf(frame);
				// Close and Goto stand beside each other on an in-flight Ticket's
				// bar (ADR 0031, ADR 0033): the key that stops the work, and the
				// key that looks at it.
				expect(bar).toContain("Delete Close");
				expect(bar).toContain("g Goto");
				expect(bar).toContain("Enter Live view");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Delete key on an in-flight Ticket asks first, and Cancel changes nothing", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The pane herdr does not list wears the `missing` marker, which
				// ADR 0030 puts before the Starting face: the Ticket is in flight
				// with no Agent to stop, and the close is the way out of it.
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				const before = app.runner.commands();
				const opened = await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				const body = frameText(opened);
				// The first line names who is alive - here, the fact the last
				// observation saw: herdr no longer lists the pane the handoff
				// started. The rest states what the Close cleanup ends and leaves.
				expect(body).toContain("Herdr no longer lists the Agent's pane.");
				expect(body).toContain(
					"Close removes the worktree checkout; a dirty checkout stays as a leftover.",
				);
				expect(body).toContain(
					"The git branch stays, and the Ticket returns to open in its next cycle.",
				);
				expect(body).toContain("No completion record is written: the turn never settled.");
				expect(body).toContain("❯ Close");
				// The Cancel row states the same fact about the pane the first line
				// states: a lost pane is nothing to keep running.
				expect(body).toContain("Cancel keep the cycle, and its missing pane");

				const cancelled = await pressEscape(
					setup,
					"the base view",
					(f) => !f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				await settle(setup);
				// Cancel is the way out with nothing changed: the ticket, its
				// cycle, and its record stand, and Cancel ran no herdr command.
				// (The read-only observation poll continues on its own clock, so
				// the check names the commands that change state.)
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
				expect(app.state.ticketWorkCycle.ticketListViews([], "implement").rows[0].workCycle).toBe(
					1,
				);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)).toBe(null);
				expect(changed(app.runner.commands())).toEqual(changed(before));
				expect(frameText(cancelled)).not.toContain("❯ Close");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	// The control is a base-mode control of the section, so the Detail pane
	// answers it exactly as the list does (ADR 0031).
	test("w closes from the detail pane too, with the same confirmation", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The pane herdr does not list wears the `missing` marker, which
				// ADR 0030 puts before the Starting face: the Ticket is in flight
				// with no Agent to stop, and the close is the way out of it.
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await focusDetail(setup);
				const opened = await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				expect(frameText(opened)).toContain(
					"Close removes the worktree checkout; a dirty checkout stays as a leftover.",
				);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the confirmation names the live-worktree tab, not the worktree checkout", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The pane herdr does not list wears the `missing` marker, which
				// ADR 0030 puts before the Starting face: the Ticket is in flight
				// with no Agent to stop, and the close is the way out of it.
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				const opened = await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				const body = frameText(opened);
				expect(body).toContain(
					"Close closes the Agent's herdr tab, and keeps the checkout and the workspace.",
				);
				// The checkout removal and its dirty-checkout note belong to the
				// other Environment, so the dialog does not state them here.
				expect(body).not.toContain("removes the worktree checkout");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a Ticket whose Handoff starts keep failing names the park on its row and in its detail (issue #298)", async () => {
		// The Failed-start park stands at half the Handoff limit: two failed starts at
		// a limit of 4. The row and the detail have to say it, because the loop that
		// stopped is a fact the operator has to be able to read off the screen.
		const app = seededApp("open", { extra: { maxHandoffsPerTicket: 4 } });
		for (let i = 0; i < 2; i += 1) {
			const claim = app.state.handoff.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "live-worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			app.state.handoff.settleHandoff(
				claim.claim.attemptId,
				false,
				"Preparing worktree: the worktree path already exists",
			);
		}

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("failed starts"),
					"the Failed-start park marker",
				);
				// The marker rides at the end of the list row, in the lane the Handoff
				// limit's marker rides.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row.endsWith("failed starts")).toBe(true);
				// The detail states the run the marker cannot carry, and what the run
				// holds, beside the count the Handoff limit reads.
				const detail = detailPaneText(frame);
				expect(detail).toContain("Handoff attempts: 2/4");
				expect(detail).toContain(
					"Handoff starts failing: 2 in a row; the Top-up adds no automatic start",
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a Ticket whose Agent name a pane the plane does not own holds wears `name held`, and its detail names the pane (issue #299)", async () => {
		// The refusal herdr gave does not clear itself on a source read: the Top-up has
		// stopped asking, and only a person can close the pane that holds the name. So
		// the row and the detail have to say it, in the words the operator acts on.
		const app = seededApp("in-flight");
		// The cycle closes and herdr keeps its environment, so the Ticket carries a
		// Leftover environment beside the collision: two words, two facts, one lane,
		// and the row states both (ADR 0032, ADR 0107).
		const handoff = app.state.handoff.latestHandoff(identity);
		if (handoff === null) throw new Error("the seed left no Handoff to leave behind");
		app.state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: handoff.handoffId,
			reason: "the worktree checkout would not close",
		});
		app.state.ticketWorkCycle.closeWorkCycle(identity);
		// The fact the refused start wrote: the name, the handles herdr named, and the
		// refusal that attempt's own row stores.
		app.state.handoff.recordNameCollision({
			ticketIdentity: identity,
			heldName: AGENT,
			holderPaneId: "w13K:p1",
			holderWorkspaceId: "w13K",
			reason:
				`the herdr name ${AGENT} is held by pane w13K:p1 in workspace w13K, ` +
				"which is no agent of this ticket: agent_name_taken",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("name held"),
					"the held Agent name marker",
				);
				// The marker rides at the end of the list row, in the lane the Handoff
				// limit's and the park's markers ride, and the Leftover marker stands
				// beside it: the row never folds one fact into the other.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row).toContain("name held");
				expect(row.endsWith("leftover")).toBe(true);
				// The detail states what the marker cannot: where the name is held, since
				// when, herdr's own refusal, and the one act that clears the fact.
				const detail = detailPaneText(frame);
				expect(detail).toContain(`Agent name held: pane w13K:p1 in workspace w13K holds ${AGENT}`);
				expect(detail).toContain("which is no agent of this ticket: agent_name_taken");
				expect(detail).toContain(
					"the Top-up adds no automatic start; your own Handoff clears this once the pane gives the name up",
				);
				// And the Leftover block states its own fact beside it, never this one.
				expect(detail).toContain("its cleanup runs in herdr");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("confirming an in-flight close ends the cycle with no trace and stops the Agent", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The pane herdr does not list wears the `missing` marker, which
				// ADR 0030 puts before the Starting face: the Ticket is in flight
				// with no Agent to stop, and the close is the way out of it.
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				const frame = await confirmPanel(setup, "the close", (f) =>
					ticketRow(f).includes("[open]"),
				);
				// The cycle ended and the ticket is open with its next number, and
				// no completion trace exists: the turn never settled.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				const [ticket] = app.state.ticketWorkCycle.ticketListViews([], "implement").rows;
				expect(ticket.workCycle).toBe(2);
				expect(ticket.handoffCount).toBe(1);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)).toBe(null);
				// The Agent's environment went through the Close cleanup: the
				// worktree checkout and the workspace behind it, never the branch.
				const commands = app.runner.commands().join("\n");
				expect(commands).toContain("herdr worktree remove --workspace ws-1");
				expect(commands).not.toContain("branch -D");
				// The closed cycle counts toward the Handoff limit like any other:
				// the limit counts the attempts the factory made, and this one ran.
				expect(detailPaneText(frame)).toContain("Handoff attempts: 1/10");
				expect(messageRowOf(frame)).toContain(`ticket ${identity} closed`);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("an in-flight close herdr refuses records the leftover fact", async () => {
		const app = seededApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The pane herdr does not list wears the `missing` marker, which
				// ADR 0030 puts before the Starting face: the Ticket is in flight
				// with no Agent to stop, and the close is the way out of it.
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				// The dialog warned about this outcome before the answer was given.
				expect(frameText(setup.captureCharFrame())).toContain(
					"a dirty checkout stays as a leftover",
				);
				const frame = await confirmPanel(setup, "the close", (f) =>
					ticketRow(f).includes("leftover"),
				);
				// The cycle still ended; what herdr could not remove is the ticket's
				// fact from there on, and the Message line says so.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						workspaceId: "ws-1",
						reason: expect.stringContaining("dirty_worktree_requires_force"),
					}),
				);
				expect(messageRowOf(frame)).toContain("the close cleanup failed");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a cycle that ends from under the open dialog lets the panel go", async () => {
		// The guard that drops an open panel reads the ticket's live state, and the
		// Ticket Close confirmation joins it (ADR 0031): a cycle that ends while the
		// dialog stands leaves the panel with nothing to show, and a panel that is
		// not drawn must keep holding the keys the base panes answer.
		const app = seededAppInAutoMode("in-flight", {
			extra: { maxHandoffsPerTicket: 1 },
			outcome: success,
			environment: "worktree",
			detail: // Past the startup grace: a pane herdr stops listing is a missing Agent,
				// not one that is still booting.
				{ stateNow: () => Date.now() - 600_000 },
			agents: [{ name: AGENT, kind: "pi", status: "working", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The poll sees the live pane and marks the Ticket running.
				await awaitFrame(
					setup,
					(f) => detailPaneText(f).includes("[running]"),
					"the in-flight ticket",
				);
				await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				// The Agent dies while the dialog stands: the world stops holding it,
				// and the next poll's list no longer reports it. Auto mode ends the
				// missing cycle at the handoff limit, so the ticket returns to open
				// under the dialog.
				app.world.removeAgent(AGENT);
				const released = await awaitFrame(
					setup,
					(f) =>
						!frameText(f).includes(`Close: ${DEFAULT_TICKET_TITLE}`) &&
						ticketRow(f).includes("[open]"),
					"the panel to let go when its cycle ends",
				);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				// The base pane answers its keys again: no invisible panel swallows them.
				const refused = await press(setup, "delete", "the refusal on the open ticket", (f) =>
					messageRowOf(f).includes("no work is in flight to close"),
				);
				expect(frameText(refused)).not.toContain(`Close: ${DEFAULT_TICKET_TITLE}`);
				expect(frameText(released)).toContain("[open]");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		planeRecord.close();
	});

	test("confirming an awaiting close records the closed decision, the modal's own row", async () => {
		const { app, planeRecord } = await bootedApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				const opened = await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				expect(frameText(opened)).toContain("The turn has settled, and no Agent works.");
				expect(frameText(opened)).toContain("The closed decision lands on the settled turn.");
				await confirmPanel(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				// The settled turn carries the decision, exactly as the Decision
				// modal's Close row leaves it, and the tab went through the cleanup.
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("closed");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the detail pane", () => {
	test("shows the handoff count and the last completion of the ticket", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[awaiting]"),
					"the awaiting ticket",
				);
				// The detail pane shows the selected ticket, which is the awaiting
				// one: first in the attention order.
				const detail = detailPaneText(frame);
				// The handoff count is the ticket's attempts against its limit.
				expect(detail).toContain("Handoff attempts: 1/10");
				// The last completion: date, task type, agent, decision, message.
				expect(detail).toContain(
					`Last completion: 2026-08-31 11:00 implement by ${AGENT} (pi) pending`,
				);
				expect(detail).toContain("The turn is done.");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the decision modal", () => {
	test("enter on an awaiting ticket shows the completion and routes on confirm", async () => {
		const review = { ...BASE_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededApp("awaiting", {
			extra: { taskTypes: { ...BASE_CONFIG.taskTypes, review } },
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("The turn is done.");
				expect(panel).toContain("Handoff: review");
				expect(panel).toContain("Goto");
				expect(panel).toContain("Close");
				// The outcome completed the machine's work: no Re-fire row.
				expect(panel).not.toContain("Re-fire");
				// The transition's fact lines stand above the rows that decide
				// on them (ADR 0027): what the plane wrote, on which surface.
				expect(panel).toContain("ticket · added ready-for-review · removed ready-for-agent");

				// Close is the default; the workflow handoff is the last row: down twice.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The prompt carried the last captured message, and the
				// settled agent's tab was closed once the new agent started.
				const commands = app.runner.commands();
				const prompt = commands.find((c) => c.startsWith("herdr agent prompt"));
				expect(prompt?.includes("The turn is done.")).toBe(true);
				expect(commands.at(-1)).toBe("herdr tab close tab-1");
				// The route's decision landed on the settled turn's trace when
				// the routed handoff started, not at the claim.
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the modal states a fire that found no linked pull request", async () => {
		// No pending record and no retry: the skip is a fact the operator reads
		// beside the write the ticket did get (ADR 0027).
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: {
				transition: reviewRoute({
					pullRequestWrite: null,
					pullRequestIdentity: null,
					pullRequestKey: null,
					positionTaskType: null,
					positionTicketIdentity: null,
					reason: "no linked pull request was found for the ticket",
				}),
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("no linked pull request was found for the ticket");
				// No position: no handoff row stands.
				expect(panel).not.toContain("Handoff: review");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Decision screen states the gate that holds the Next step (ADR 0092)", async () => {
		// The fired Transition derived its review position, and the source has
		// not re-read the ticket yet: it still offers implement, so the derived
		// review stands held and the automatic route would not take it. The row
		// stands for the operator's own key, and the fact line names the hold the
		// machine reads beside it.
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Handoff: review");
				expect(panel).toContain("the Next step is held: the position no longer offers the task");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Decision screen states the Handoff limit that holds the Next step (ADR 0092)", async () => {
		// The same settled turn on a position that already used its one start: the
		// limit holds the machine's step, and the screen names the limit beside the
		// row the operator's own key still confirms.
		const landed: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-review"])],
		};
		const app = seededApp("awaiting", {
			extra: { maxHandoffsPerTicket: 1 },
			outcome: landed,
			environment: "live-worktree",
			detail: {
				transition: reviewRoute(),
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(landed);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Handoff: review");
				expect(panel).toContain("the Next step is held: the position is at the handoff limit");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Decision screen states no hold when the Next step runs free (ADR 0092)", async () => {
		// The same settled turn with the label the write landed on the ticket:
		// the position offers the review the step names, no gate holds it, and
		// the screen says nothing about a hold.
		const landed: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-review"])],
		};
		const app = seededApp("awaiting", {
			extra: {},
			outcome: landed,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(landed);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Handoff: review");
				expect(panel).not.toContain("the Next step is held");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Re-fire row fires the turn's transition again and swaps the record (ADR 0054)", async () => {
		// The recorded outcome did not complete: no branch held, the way the
		// score read found no verdict before the review comment landed. The
		// Re-fire row stands on it; the confirm re-fires the turn's transition
		// on the source as it stands now and swaps the new outcome onto the
		// trace. The turn stays awaiting with no decision change.
		const noFire = reviewRoute({
			fired: false,
			when: null,
			reason: "the pull request carries no review score",
			ticketWrite: null,
			positionTaskType: null,
			positionTicketIdentity: null,
		});
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: noFire },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain(
					"no transition branch held: the pull request carries no review score",
				);
				expect(panel).toContain("Re-fire");
				expect(panel).not.toContain("Handoff: review");

				// Close is the default, Goto the second row, Re-fire the third.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the re-fire row", (f) =>
					frameText(f).includes("❯ Re-fire"),
				);
				await pressReturn(setup, "the re-fire lands", (f) =>
					frameText(f).includes("Handoff: review"),
				);
				const after = frameText(await settle(setup));
				// The fact lines stand on the re-fired outcome, the Re-fire row
				// stands down, and the Message line reports the landing. The fact
				// line truncates at this width; the added label is the fact that
				// must stand.
				expect(after).toContain("ticket · added ready-for-review");
				expect(after).not.toContain("Re-fire");
				expect(after).toContain("the re-fire lands; the labels stand as written");

				// The write ran on the ticket's source membership, and the
				// trace stands on the re-fired outcome, not the recorded one.
				const commands = app.runner.commands();
				expect(commands).toContain(
					"gh issue edit #5 --repo github.com/acme/factory --add-label ready-for-review",
				);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.transition).toEqual({
					fired: true,
					when: null,
					reason: "",
					ticketFacts: ["ready-for-review"],
					pullRequestFacts: [],
					ticketWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestWrite: null,
					pullRequestIdentity: null,
					pullRequestKey: null,
					writeFailure: "",
					positionTaskType: "review",
					positionTicketIdentity: identity,
				});
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the modal states a label write that failed", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: {
				transition: reviewRoute({
					writeFailure: "gh pr edit #12 failed: HTTP 403: Must have admin rights to Repository.",
					positionTaskType: null,
					positionTicketIdentity: null,
				}),
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("label write failed: gh pr edit #12 failed");
				// The write did not complete: the Re-fire row stands on it too.
				expect(panel).toContain("Re-fire");
			},
			{ width: WIDE_STATUS, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	describe("the handoff row of a position that left its source", () => {
		const pullIdentity = "github:github.com:P_12";
		const pullSource = { name: "pulls", kind: "github-pull-requests" };

		/** The fixing pull request, by the labels the source reports for it. */
		function pullFetched(labels: string[] = ["ready-for-review"]): FetchedTicket {
			return {
				identity: pullIdentity,
				sourceKind: "github-pull-request",
				externalKey: "#12",
				sourceState: "open",
				url: "https://github.com/acme/factory/pulls/12",
				title: "Persist source facts in state",
				description: "The implementation of #5.",
				labels,
				externalUpdatedAt: "2026-08-31T10:30:00Z",
				repository: {
					identity: repoIdentity,
					displayName: "acme/factory",
					cloneUrl: "https://github.com/acme/factory.git",
				},
				attributes: withIssueReferences({ draft: "false" }, [
					{ identity, number: 5, repository: "acme/factory" },
				]),
			};
		}

		/** The refresh that lists the pull request. */
		const pullOpen: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:30:00Z",
			tickets: [pullFetched()],
		};

		/** The refresh that finds the pull request gone: merged or closed. */
		const pullGone: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:40:00Z",
			tickets: [],
		};

		/**
		 * The outcome a re-fire of the skip stored (ADR 0042): the review fact
		 * landed on the pull request, and the position sits on it.
		 */
		function pullPositionRoute(): TransitionOutcome {
			return reviewRoute({
				pullRequestFacts: ["ready-for-review"],
				pullRequestWrite: { added: ["ready-for-review"], removed: [] },
				pullRequestIdentity: pullIdentity,
				pullRequestKey: "#12",
				positionTicketIdentity: pullIdentity,
			});
		}

		test("a position that left its source withdraws the handoff and states the fact", async () => {
			const app = seededApp("awaiting", {
				extra: {},
				outcome: success,
				environment: "live-worktree",
				detail: { transition: pullPositionRoute() },
				pullOutcome: pullOpen,
			});
			// The last refresh listed the pull request: it stands in the state
			// active, where the outcome's position points.
			app.state.sourceFact.applyFetch(pullSource, pullOpen);
			const pull = app.pullSrc;
			if (pull === undefined) throw new Error("the pull source is missing");

			const planeRecord = await planeOf(app);
			await withApp(
				async (setup) => {
					app.src.settle(success);
					await awaitFrame(
						setup,
						(f) => ticketRow(f).includes("[awaiting]"),
						"the awaiting ticket",
					);
					// The startup refresh runs while the decision is still
					// closed: it finds the pull request gone.
					pull.settle(pullGone);
					await awaitFrame(
						setup,
						() => app.state.sourceFact.stillListed(pullIdentity) === false,
						"the pull request to leave its source",
					);
					await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
					const panel = frameText(await settle(setup));
					// The position's ticket is in no list: the handoff row
					// stands withdrawn, and the fact line takes its place.
					expect(panel).not.toContain("Handoff: review");
					expect(panel).toContain("the position's ticket left its source; no handoff stands");
					expect(panel).toContain("Close");
					expect(panel).toContain("Goto");
				},
				{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
			);
			planeRecord.close();
		});

		test("a position that still lists its ticket keeps the handoff", async () => {
			const app = seededApp("awaiting", {
				extra: {},
				outcome: success,
				environment: "live-worktree",
				detail: { transition: pullPositionRoute() },
				pullOutcome: pullOpen,
			});
			app.state.sourceFact.applyFetch(pullSource, pullOpen);
			const pull = app.pullSrc;
			if (pull === undefined) throw new Error("the pull source is missing");

			const planeRecord = await planeOf(app);
			await withApp(
				async (setup) => {
					app.src.settle(success);
					await awaitFrame(
						setup,
						(f) => ticketRow(f).includes("[awaiting]"),
						"the awaiting ticket",
					);
					// The refresh confirms the pull request still lists.
					pull.settle(pullOpen);
					await awaitFrame(
						setup,
						() => app.state.sourceFact.stillListed(pullIdentity),
						"the pull request to list",
					);
					await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
					const panel = frameText(await settle(setup));
					expect(panel).toContain("Handoff: review");
					expect(panel).not.toContain("no handoff stands");
				},
				{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
			);
			planeRecord.close();
		});

		test("an open decision withdraws the handoff when its refresh finds the position gone", async () => {
			const app = seededApp("awaiting", {
				extra: {},
				outcome: success,
				environment: "live-worktree",
				detail: { transition: pullPositionRoute() },
				pullOutcome: pullOpen,
			});
			app.state.sourceFact.applyFetch(pullSource, pullOpen);
			const pull = app.pullSrc;
			if (pull === undefined) throw new Error("the pull source is missing");

			const planeRecord = await planeOf(app);
			await withApp(
				async (setup) => {
					app.src.settle(success);
					await awaitFrame(
						setup,
						(f) => ticketRow(f).includes("[awaiting]"),
						"the awaiting ticket",
					);
					await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
					// The row stands while the pull request still lists: the
					// refresh is in flight, and the state lists it.
					const before = frameText(await settle(setup));
					expect(before).toContain("Handoff: review");
					// The in-flight refresh settles without the pull request:
					// it left the source while the decision stood open.
					pull.settle(pullGone);
					await awaitFrame(
						setup,
						() => app.state.sourceFact.stillListed(pullIdentity) === false,
						"the pull request to leave its source",
					);
					const after = frameText(await settle(setup));
					expect(after).not.toContain("Handoff: review");
					expect(after).toContain("the position's ticket left its source; no handoff stands");
				},
				{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
			);
			planeRecord.close();
		});
	});

	test("a routed handoff does not record the predecessor it closed as leftover", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
			// The previous agent holds the stable name in the stored pane. The
			// routed handoff starts under its cycle name, then closes the
			// predecessor tab that held it.
			agents: [{ name: AGENT, kind: "pi", status: "idle", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
				// The name holder is gone with its predecessor tab. It is not a
				// leftover fact, and the row must not carry a false marker.
				expect(app.state.handoff.leftoverEnvironment(identity)).toBe(null);
				expect(ticketRow(setup.captureCharFrame())).not.toContain("leftover");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a manual workflow route starts with fresh model and target thinking", async () => {
		const app = seededApp("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: { ...BASE_CONFIG.taskTypes.review, thinking: "low" },
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: "The turn is done.",
				model: "opus-4",
				thinking: "high",
				transition: reviewRoute(),
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision panel", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--kind pi --pane pane-2 -- --thinking low");
				expect(start).not.toContain("--model");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a manual workflow route starts with its target task profile", async () => {
		const app = seededApp("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: {
						...BASE_CONFIG.taskTypes.review,
						agent: "codex",
						model: "review-model",
						thinking: "high",
					},
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: "The turn is done.",
				model: "opus-4",
				thinking: "high",
				transition: reviewRoute(),
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision panel", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain(
					"--kind codex --pane pane-2 -- --model review-model -c model_reasoning_effort=high",
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("e on the route row edits the route's settings before it starts", async () => {
		const app = seededApp("awaiting", {
			extra: {
				agents: {
					...BASE_CONFIG.agents,
					pi: {
						...BASE_CONFIG.agents.pi,
						contextWindow: "--context {value}",
					},
				},
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: {
						...BASE_CONFIG.taskTypes.implement,
						transition: {
							ticketFacts: ["ready-for-review"],
							pullRequestFacts: [],
							agent: "pi",
						},
					},
					review: {
						...BASE_CONFIG.taskTypes.review,
						model: "review-model",
						contextWindow: "131072",
					},
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute({ agent: "pi" }) },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// The first row ends the cycle: it has no Handoff settings to
				// edit, so e there opens nothing.
				await press(setup, "e", "the decision modal to hold", (f) => f.includes("Decision:"));
				expect(frameText(await settle(setup))).not.toContain("Override");
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);

				// e opens the panel on the choice the edge resolved: the pinned
				// pi agent, and the target profile's model and context window.
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Agent pi");
				expect(panel).toContain("Model review-model");
				expect(panel).toContain("Context 131072");
				// Opening the edit starts nothing: the claim waits for the confirm.
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");

				// The operator replaces the resolved model for this one handoff.
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				// The row's input takes focus on its own render pass: let that
				// land, and the frame settle, before the edit keys go in.
				await settle(setup);
				setup.mockInput.pressKey("HOME");
				for (const _ of "review-model") setup.mockInput.pressKey("DELETE");
				await setup.mockInput.typeText("one-shot-model");
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model one-shot-model"),
					"the typed model",
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The override is the last writer: the agent started on the
				// operator's model, not the profile's. The context window the
				// operator never touched still rides on the route's profile value.
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain(
					"--kind pi --pane pane-2 -- --model one-shot-model --context 131072",
				);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a route edit that moves to another Task type follows that profile, not the pin", async () => {
		// The one place the panel can undo a transition pin without a keystroke
		// on the Agent row: the transition pins the Agent of the route it
		// writes, and a Task type the operator moves to owns its own profile.
		const app = seededApp("awaiting", {
			extra: {
				// The machine places both task types the test moves between: the
				// confirm of the route writes the labels of the state it moves to.
				workflowStates: [
					{
						name: "ready-for-review",
						taskType: "review",
						match: { labelsAny: ["ready-for-review"] },
					},
					{ name: "ready-for-fix", taskType: "fix", match: { labelsAny: ["ready-for-fix"] } },
				],
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: {
						...BASE_CONFIG.taskTypes.implement,
						transition: {
							ticketFacts: ["ready-for-review"],
							pullRequestFacts: [],
							agent: "claude",
						},
					},
					review: { ...BASE_CONFIG.taskTypes.review, model: "review-model" },
					fix: { ...BASE_CONFIG.taskTypes.fix, agent: "pi", model: "fix-model" },
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute({ agent: "claude" }) },
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				const opened = frameText(await settle(setup));
				// The panel starts on the route the edge resolved: its pinned Agent,
				// and the target profile's Model.
				expect(opened).toContain("Agent claude");
				expect(opened).toContain("Model review-model");

				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				// Left from `review` lands on `fix`, whose profile names its own
				// Agent and Model. Both rows are untouched, so both follow it, and
				// the edge's pin is gone with the edge's target.
				await press(setup, "h", "the fix task type", (f) => frameText(f).includes("Task type fix"));
				const moved = frameText(await settle(setup));
				expect(moved).toContain("Agent pi");
				expect(moved).toContain("Model fix-model");

				await pressReturn(setup, "the routed handoff", (f) => f.includes("Handoff task type: fix"));
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--kind pi --pane pane-2 -- --model fix-model");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("escape in a route edit returns to the decision with no claim", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				await settle(setup);
				// Esc drops the edit and returns to the decision still being made.
				const back = await pressEscape(
					setup,
					"the decision modal",
					(f) => !f.includes("Override") && f.includes("Decision:"),
				);
				expect(frameText(back)).toContain("❯ Close");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("e alone on an awaiting ticket points at the decision instead of a panel", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				const frame = await press(setup, "e", "the hint on the status line", (f) =>
					frameText(f).includes("press Enter, then e on a Handoff row"),
				);
				// The bar carries the e Override hint with its reason; the panel's
				// box title is the open signal.
				expect(frame).not.toContain("┌─Override");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the route row shows the arriving task profile's effective agent", async () => {
		const { app, planeRecord } = await bootedApp("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: { ...BASE_CONFIG.taskTypes.review, agent: "codex" },
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(frame) => ticketRow(frame).includes("[awaiting]"),
					"the awaiting ticket",
				);
				await pressReturn(setup, "the decision modal", (frame) => frame.includes("Decision:"));
				expect(frameText(await settle(setup))).toContain("Handoff: review agent codex");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a workflow route resolves the target profile's model", async () => {
		// Story 26, through the pinned herdr sequence: the route's model comes from
		// the target task profile's chain, not from the handoff that just settled.
		// A route that started on an empty model would be the bug ADR 0009 exists
		// to remove.
		const app = seededApp("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: {
						...BASE_CONFIG.taskTypes.review,
						model: "anthropic/claude-review-4",
					},
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: "The turn is done.",
				model: "opus-4",
				thinking: "high",
				transition: reviewRoute(),
			},
		});
		app.world.setModelList("pi", ["anthropic/claude-review-4"]);

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision panel", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--model anthropic/claude-review-4");
				expect(start).not.toContain("opus-4");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the route row offers the position once, and the pinning shows on the row", async () => {
		// The transition names no destination: it writes the facts, and the
		// machine re-derives the one position on them. The row's detail shows
		// the transition's pinning beside the position's agent.
		const app = seededApp("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: {
						...BASE_CONFIG.taskTypes.implement,
						transition: {
							ticketFacts: ["ready-for-review"],
							pullRequestFacts: [],
							agent: "codex",
							environment: "worktree",
						},
					},
				},
			},
			outcome: success,
			environment: "worktree",
			detail: { transition: reviewRoute({ agent: "codex", environment: "worktree" }) },
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				// One position, one row: the facts offer review, so the modal
				// shows the route once, with the pinning in its detail.
				expect(panel.split("Handoff: review").length - 1).toBe(1);
				expect(panel).toContain("agent codex, environment worktree");

				// The route row is the last one: down twice, confirm.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the route row", (f) =>
					frameText(f).includes("❯ Handoff: review agent codex"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The handoff ran with the transition's pinned agent, and the
				// route's decision landed on the settled turn's trace when the
				// routed handoff started.
				expect(app.runner.commands()).toContain(
					`herdr agent start ${AGENT} --kind codex --pane pane-2`,
				);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a failed route keeps the decision the ask recorded, and Close still ends the cycle (ADR 0064)", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		// The stored workspace still lists, but the fresh tab cannot be made:
		// the handoff fails before the agent starts.
		app.world.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			code: 1,
			stderr: "the workspace is gone",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the failed route", (f) => f.includes("the workspace is gone"));

				// The handoff never started: the ask ended the cycle in the
				// same write that landed the decision (ADR 0064, ADR 0072), so
				// the ticket rests open behind the fact, and the Decision
				// screen - an awaiting screen again - fell back to the list.
				// The fallback is the transition, not the ask's line: the frame the
				// wait above returned can still be the Decision screen. The wait takes
				// the positive the next line asserts - the list drawn with this ticket's
				// row wearing `[open]`, which the Decision screen draws nowhere - and
				// the assertion narrows it to the screen that left. A swap that has not
				// started fails the positive, and so does a frame with nothing drawn
				// (issue #304).
				const list = await awaitFrame(
					setup,
					(f) => f.includes("Tickets") && ticketRow(f).includes("[open]"),
					"the decision screen to fall back to the list",
				);
				expect(list).not.toContain("Decision:");
				expect(ticketRow(list)).toContain("[open]");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				// The decision the ask recorded stands: a fact is not
				// rewritten.
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("goto focuses the stored pane and leaves the handoff open", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// Goto is the second row: one down, confirm.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				setup.mockInput.pressEnter();
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr agent focus pane-1"),
					"the focus",
				);
				// The focus went to the stored pane, and the handoff stayed
				// open: Goto is navigation (ADR 0033), so the ticket rests in
				// awaiting until the poll or a decision moves it, and its row
				// reads the state it wears.
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				const visible = app.state.ticketWorkCycle.ticketListViews(
					app.config.workflowStates,
					app.config.defaultTaskType,
				).rows;
				expect(visible[0]?.state).toBe("awaiting");
				expect(ticketRow(await settle(setup))).toContain("[awaiting]");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision ?? null).toBeNull();
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("g in the base mode focuses the stored pane of an awaiting ticket and moves nothing", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				// `g` is the base-mode Goto (ADR 0033): on an awaiting ticket the
				// recorded pane stands, the focus runs without opening a surface,
				// and the ticket rests awaiting until the poll or a decision
				// moves it.
				setup.mockInput.pressKey("g");
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr agent focus pane-1"),
					"the focus",
				);
				expect(
					app.state.ticketWorkCycle.ticketListViews(
						app.config.workflowStates,
						app.config.defaultTaskType,
					).rows[0]?.state,
				).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision ?? null).toBeNull();
				const frame = await settle(setup);
				expect(ticketRow(frame)).toContain("[awaiting]");
				expect(frame).not.toContain("Live:");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("shows the log at its bottom, with a proportional scrollbar", async () => {
		// Zero-padded labels: a bare "log 1" is a substring of "log 10".
		const lines = Array.from(
			{ length: 40 },
			(_, i) => `log ${String(i + 1).padStart(3, "0")}`,
		).join("\n");
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { message: lines },
		});
		const thumbRowOf = (frame: string) => rowsOf(frame).findIndex((row) => row.includes("█"));

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = await settle(setup);
				const text = frameText(panel);
				// The near-fullscreen modal gives the terminal's last two rows to
				// its own Message line and Action bar, and the log window is what
				// the box has left. It opens at the bottom, where the agent's
				// conclusion is, and the scrollbar thumb rests there.
				const shown = rowsOf(panel).filter((row) => /log \d\d\d/.test(row)).length;
				expect(shown).toBeGreaterThan(2);
				expect(text).toContain(`log ${String(41 - shown).padStart(3, "0")}`);
				expect(text).toContain("log 040");
				expect(text).toContain("█");
				const bottomThumbRow = thumbRowOf(panel);
				expect(bottomThumbRow).toBeGreaterThan(-1);

				// k scrolls up through the log, one row per press. Each press
				// drops the newest row; two presses move the thumb with the log.
				// `first(n)` is the oldest line still on screen after n steps up.
				const first = (steps: number) => `log ${String(41 - shown - steps).padStart(3, "0")}`;
				const last = (steps: number) => `log ${String(40 - steps).padStart(3, "0")}`;
				await press(setup, "k", "one row up", (f) => f.includes(first(1)) && !f.includes(last(0)));
				const higher = await press(
					setup,
					"k",
					"one more row up",
					(f) => f.includes(first(2)) && !f.includes(last(1)),
				);
				expect(thumbRowOf(higher)).toBeLessThan(bottomThumbRow);
				// j scrolls back down and brings the thumb with it.
				const backDown = await press(
					setup,
					"j",
					"one row down",
					(f) => f.includes(last(1)) && !f.includes(first(2)),
				);
				expect(thumbRowOf(backDown)).toBe(bottomThumbRow);

				// up and down move the action row.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "up", "back to close", (f) => frameText(f).includes("❯ Close"));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("esc closes the panel and leaves the ticket awaiting", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// The panel key handler subscribes in an effect that flushes after
				// the commit; a settled frame proves the panel is open and ready.
				await settle(setup);
				// Esc cancels: nothing runs, no decision lands.
				await pressEscape(setup, "the panel to close", (f) => !f.includes("Decision:"));
				// The ticket is still awaiting, and the turn is still pending.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(ticketRow(await settle(setup))).toContain("[awaiting]");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the modal shows the border title, the context line, and the log's notes", async () => {
		const conclusion = "## Result\n\n**All 142 tests pass.**";
		const { app, planeRecord } = await bootedApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: conclusion,
				turnLog: [
					{ kind: "text", text: "I will run the tests." },
					{ kind: "tool", name: "bash", target: "npm test", failed: false },
					{ kind: "tool", name: "bash", target: "npm run lint", failed: true },
					{ kind: "text", text: conclusion },
				],
			},
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressEnterQuiet(setup, "the decision modal", (f) => f.includes("Decision:"));
				const modal = frameText(await settle(setup));
				// The border names the ticket, and the context line names the
				// repository, the task type, the agent, and the completion time.
				expect(modal).toContain(`Decision: ${DEFAULT_TICKET_TITLE}`);
				expect(modal).toContain("acme/factory · implement · pi · 2026-08-31 11:00");
				// The log renders in order: the opening text, the tool notes,
				// and the markdown-dressed conclusion. The heading's hash and
				// the bold's asterisks do not show.
				expect(modal).toContain("I will run the tests.");
				expect(modal).toContain("▸ bash: npm test");
				expect(modal).toContain("▸ bash: npm run lint");
				expect(modal).toContain("All 142 tests pass.");
				expect(modal).not.toContain("**");
				expect(modal).not.toContain("##");
				// The shared Action bar offers the log's scroll key.
				expect(modal).toContain("j/k Scroll body");

				// The failed tool call wears the warning color, the passing one
				// the dim one. Both are painted, so the notes are on screen. The
				// pop-in fades in for a little while, so wait it out before
				// reading the painted colors: mid-fade they are blended.
				await sleep(250);
				expect(spanColors(setup, "npm run lint")).toContainEqual(rgb(roleColor("yellow")));
				expect(spanColors(setup, "npm test")).toContainEqual(rgb(roleColor("subtext0")));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("home and end jump the log's ends, and pageup and pagedown page it", async () => {
		// Zero-padded labels: a bare "line 1" is a substring of "line 10".
		const lines = Array.from(
			{ length: 40 },
			(_, i) => `log ${String(i + 1).padStart(3, "0")}`,
		).join("\n");
		const { app, planeRecord } = await bootedApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "live-worktree",
			detail: { message: lines },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await settle(setup);

				// The modal opens at the bottom, where the agent's conclusion is.
				// home takes the opening, without the conclusion.
				await pressScrollKey(
					setup,
					"home",
					"the log at its top",
					(f) => f.includes("log 001") && !f.includes("log 040"),
				);
				// end returns to the conclusion, without the opening.
				await pressScrollKey(
					setup,
					"end",
					"the log at its bottom",
					(f) => f.includes("log 040") && !f.includes("log 001"),
				);
				// pageup pages back up, out of the conclusion.
				await pressScrollKey(setup, "pageup", "a page up", (f) => !f.includes("log 040"));
				// pagedown pages back down to the bottom.
				await pressScrollKey(
					setup,
					"pagedown",
					"a page down",
					(f) => f.includes("log 040") && !f.includes("log 001"),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the herdr-unreachable line", () => {
	test("a failed agent list warns and the observation holds", async () => {
		const app = seededApp("in-flight");
		// herdr cannot be reached: the agent list fails.
		app.world.set("herdr", ["agent", "list"], { code: 1, stderr: "no herdr session" });

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(f) => f.includes("herdr is unreachable"),
					"the herdr-unreachable warning",
				);
				// The loop holds: the failed list marks nothing, so the
				// in-flight ticket runs on without a marker.
				expect(ticketRow(setup.captureCharFrame())).not.toContain("missing");
				expect(ticketRow(setup.captureCharFrame())).not.toContain("blocked");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the Close cleanup", () => {
	test("close on a worktree handoff removes the checkout and the herdr workspace", async () => {
		const { app, planeRecord } = await bootedApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "worktree",
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// Close is the default row: confirm.
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				// herdr worktree remove closes the workspace with the checkout
				// and never deletes the branch, so pushed work and pull requests
				// survive. There is no workspace close after it.
				expect(commands).toContain("herdr worktree remove --workspace ws-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("branch -D");
				expect(joined).not.toContain("branch --delete");
				expect(joined).not.toContain("workspace close");
				expect(joined).not.toContain("tab close");
				// The close ends the environment and never moves herdr's view
				// along with it (ADR 0061): the operator stays on the pane they
				// were reading.
				expect(herdrFocusCommands(commands)).toEqual([]);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("close on a live worktree handoff closes only the tab it made", async () => {
		const { app, planeRecord } = await bootedApp("awaiting");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("worktree remove");
				expect(joined).not.toContain("workspace close");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("abandon on a worktree handoff removes the checkout and the herdr workspace", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				// herdr worktree remove closes the workspace with the checkout
				// and never deletes the branch: there is no workspace close after it.
				expect(commands).toContain("herdr worktree remove --workspace ws-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("branch -D");
				expect(joined).not.toContain("branch --delete");
				expect(joined).not.toContain("workspace close");
				expect(joined).not.toContain("tab close");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("abandon on a live worktree handoff closes only the tab it made", async () => {
		const { app, planeRecord } = await bootedApp("in-flight", {
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("worktree remove");
				expect(joined).not.toContain("workspace close");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the leftover environment", () => {
	/** The herdr answer that refuses to remove a dirty checkout. */
	test("a Close cleanup that fails leaves the ticket carrying the leftover", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				// The state transition stands: the cycle closed. What failed is
				// now a fact on the ticket, not only a message line that fades.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						workspaceId: "ws-1",
						paneId: "pane-1",
						reason: expect.stringContaining("dirty_worktree_requires_force"),
					}),
				);
				// The row wears the marker, and the detail pane says what is
				// still alive for this ticket and where its cleanup lives.
				const shown = setup.captureCharFrame();
				expect(ticketRow(shown)).toContain("leftover");
				const detail = detailPaneText(shown);
				expect(detail).toContain("Leftover: herdr workspace ws-1");
				expect(detail).toContain("its cleanup runs in herdr");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the Delete key on an open ticket states its reason and runs no command; the fact stands", async () => {
		// An open ticket holds no work in flight, so the Delete key refuses it
		// with that reason (ADR 0031, ADR 0122) and the leftover the closed
		// cycle left keeps standing as the fact it is: no panel, no herdr
		// command, nothing cleared.
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				const commandsBefore = app.runner.commands();
				const frame = await press(setup, "delete", "the close refusal", (f) =>
					messageRowOf(f).includes("no work is in flight to close"),
				);
				// The refusal is readable on the Message line, in the catalogue's
				// own words, and no panel opened under it.
				expect(messageRowOf(frame)).toContain("no work is in flight to close");
				expect(frame).not.toContain(`Close: ${DEFAULT_TICKET_TITLE}`);
				// No panel and no reopened decision, and no herdr command ran:
				// the refusal's fact sends its own desktop notification (ADR 0080),
				// and the command list before and after holds everything else.
				expect(frame).not.toContain("Leftover environment");
				expect(frame).not.toContain("Decision:");
				const withoutNotification = (commands: string[]) =>
					commands.filter((command) => !/^(notify-send|osascript|powershell) /u.test(command));
				expect(withoutNotification(app.runner.commands())).toEqual(
					withoutNotification(commandsBefore),
				);
				// The leftover fact still stands: the marker on the row, the
				// block in the detail, and its herdr pointer.
				expect(ticketRow(frame)).toContain("leftover");
				const detail = detailPaneText(frame);
				expect(detail).toContain("Leftover: herdr workspace ws-1");
				expect(detail).toContain("its cleanup runs in herdr");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a cleanup that cannot run at all is still the ticket's fact", async () => {
		const app = seededApp("awaiting", { extra: {}, outcome: success, environment: "worktree" });
		// herdr is unreachable: the command throws instead of answering, and
		// the environment the ticket cannot close is a fact either way.
		const brokenRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "worktree"
					? Promise.reject(new Error("herdr is not reachable"))
					: app.runner.run(command, args, options),
			listModels: (kind) => app.runner.listModels(kind),
		};
		const planeRecord = await planeOf(app, brokenRunner);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						workspaceId: "ws-1",
						reason: "the close cleanup did not run: herdr is not reachable",
					}),
				);
				expect(frameText(setup.captureCharFrame())).toContain(
					"the close cleanup failed: the close cleanup did not run",
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the observation abandons a missing cycle at the limit, and records the failed cleanup", async () => {
		const app = seededAppInAutoMode("in-flight", {
			extra: { maxHandoffsPerTicket: 1 },
			outcome: success,
			environment: "worktree",
			detail: // The agent ran a while before it died: the handoff is past the
				// startup grace, so the missing agent is not a booted one.
				{ stateNow: () => Date.now() - 600_000 },
		});
		app.world.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr: "the checkout is dirty",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("leftover"),
					"the leftover marker",
				);
				// Auto mode ends the missing cycle at the limit, and the failed
				// Close cleanup of the abandoned handoff lands as a fact on the
				// ticket.
				expect(frameText(frame)).toContain(
					"abandoned; the close cleanup failed: the checkout is dirty",
				);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({ workspaceId: "ws-1", reason: "the checkout is dirty" }),
				);
				// The row wears both trailing markers at once: the limit that
				// ended the cycle, and the leftover its cleanup left behind.
				// The terminal row also carries the detail pane, so check only
				// the list half.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row.endsWith("handoff limit leftover")).toBe(true);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("an operator abandon records a cleanup that failed", async () => {
		// The Abandon row of the missing panel ends the cycle, and its Close
		// cleanup is the same cleanup the automatic end runs: a checkout herdr
		// will not remove lands as the ticket's fact.
		const app = seededApp("in-flight", {
			extra: {},
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
			// The agent ran a while before it died: past the startup grace.
			detail: { stateNow: () => Date.now() - 600_000 },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("leftover"));
				expect(app.runner.commands()).toContain("herdr worktree remove --workspace ws-1");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				// The fact names the handoff the abandon ended, so the clear that
				// follows reaches the environment this cycle left.
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						handoffId: app.state.handoff.latestHandoff(identity)?.handoffId,
						workspaceId: "ws-1",
						reason: expect.stringContaining("dirty_worktree_requires_force"),
					}),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the automatic close records a cleanup that failed", async () => {
		// No operator key ends this cycle: the observation loop closes the
		// settled turn itself, and its cleanup is the same call. A tab herdr
		// will not close is the ticket's fact to carry.
		const app = seededAppInAutoMode("awaiting", {
			extra: {
				maxHandoffsPerTicket: 1,
			},
		});
		app.world.set("herdr", ["tab", "close", "tab-1"], {
			code: 1,
			stderr: '{"error":{"code":"agent_running","message":"running agent pi"}}\n',
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("leftover"), "the leftover marker");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("auto-closed");
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						environment: "live-worktree",
						tabId: "tab-1",
						reason: expect.stringContaining("agent_running"),
					}),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.close();
	});

	test("queued Close cleanups finish before their queued handoff starts", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: pairSuccess,
			environment: "worktree",
			secondEnvironment: "worktree",
		});
		const second = app.state.handoff.claimHandoff(
			secondIdentity,
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
		if (!second.ok) throw new Error(second.reason);
		app.state.handoff.settleHandoff(second.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		app.state.ticketWorkCycle.settleTurn({
			ticketIdentity: secondIdentity,
			handoffId: second.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The second turn is done.",
			turnLog: [{ kind: "text", text: "The second turn is done." }],
			completedAt: "2026-09-02T11:00:00.000Z",
		});
		const gate = gatedRunner(app, (command) => command.startsWith("herdr worktree remove"));
		const planeRecord = await planeOf(app, gate.runner);

		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[awaiting]"),
					"the first awaiting ticket",
				);
				await pressReturn(setup, "the first decision", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the first Close cleanup", () => gate.busy());
				await awaitFrame(setup, (f) => !f.includes("Decision:"), "the first panel closing");

				await pressArrow(setup, "up", "the second ticket", (f) =>
					detailPaneText(f).includes("External key: #6"),
				);
				await pressReturn(setup, "the second decision", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the queued second Close cleanup", (f) =>
					ticketRow(f, "Watch agent turns").includes("[open]"),
				);
				// The second ticket is open again. Its handoff claims now, but the
				// cleanup seat keeps its external work out of herdr.
				await settleReverify(app.src, pairSuccess);
				setup.mockInput.pressEnter();
				await settle(setup);

				gate.release();
				await awaitFrame(setup, () => gate.arrivals() === 2, "the second cleanup reaching herdr");
				expect(app.runner.commands()).not.toContain("herdr workspace list");

				gate.release();
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr workspace list"),
					"the queued handoff after both cleanups",
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a cleanup that ran no command ends only the fact of its own row", async () => {
		const app = seededApp("awaiting", { extra: {}, outcome: success, environment: "worktree" });
		const first = app.state.handoff.latestHandoff(identity);
		if (first === null) throw new Error("the seeded handoff is missing");
		// One cycle closed over a workspace herdr would not remove: its fact
		// stands, and it names that workspace.
		app.state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			decision: "closed",
			decidedAt: "2026-09-02T09:30:00.000Z",
		});
		reverify(app, success, "2026-09-02T09:31:00.000Z");
		app.state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T09:30:00.000Z",
		});
		// A second cycle whose handoff stored no environment handle at all: its
		// Close cleanup has nothing to close.
		const claim = app.state.handoff.claimHandoff(
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
		app.state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-2" });
		app.state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The second turn is done.",
			turnLog: [{ kind: "text", text: "The second turn is done." }],
			completedAt: "2026-09-02T10:30:00.000Z",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => f.includes(" closed"));
				// Nothing to close means nothing reached: the fact of the row the
				// cleanup did not reach stands, and no command resolved it.
				expect(app.runner.commands().join("\n")).not.toContain("herdr worktree remove");
				expect(app.runner.commands().join("\n")).not.toContain("herdr tab close");
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({ handoffId: first.handoffId, workspaceId: "ws-1" }),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the leftover block keeps its warning colour", async () => {
		const app = seededApp("awaiting", {
			extra: {},
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				// The detail block is one warning the operator can act on: the
				// fact, its reason, and its herdr pointer all carry it.
				expect(spanColors(setup, "Leftover: herdr workspace ws-1")).toEqual([
					rgb(roleColor("yellow")),
				]);
				expect(spanColors(setup, "its cleanup runs in herdr")).toEqual([rgb(roleColor("yellow"))]);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	/**
	 * A runner that holds every command `matches` until the test lets it go.
	 *
	 * A seat test cannot race a timer: the command must stay in flight while
	 * the operator works the keys behind it, and answer as soon as the test
	 * says so. The shared gate is the one the Handoff dispatch module tests use,
	 * so the seat rule is driven by one runner double everywhere.
	 */
	function gatedRunner(app: SeededApp, matches: (command: string) => boolean): GatedRunner {
		return gateOnRunner(app.runner, matches);
	}

	/**
	 * A ticket whose closed cycle left a dirty workspace in herdr, whose
	 * leftover agent still holds the name the ticket's next handoff wants.
	 *
	 * The Close cleanup fails on the dirty checkout, the cycle closes anyway,
	 * and the handoff the operator starts then meets its own leftover name.
	 * The leftover agent stands in the stored pane of the ticket's own last
	 * handoff, which is what makes the collision the ticket's own.
	 */
	function leftoverNameApp(): SeededApp {
		// The leftover agent reports idle: herdr sees no live work in it, so
		// nothing reclaims it, and it is exactly the agent that holds the name.
		return seededApp("awaiting", {
			extra: { defaultEnvironment: "worktree" },
			outcome: success,
			environment: "worktree",
			dirtyWorktree: true,
			agents: [{ name: AGENT, kind: "pi", status: "idle", paneId: "pane-1" }],
		});
	}

	/**
	 * Close the cycle the seeded agent settled, then hand the open ticket off
	 * again: the key path that meets the leftover name.
	 */
	async function closeAndHandOffAgain(setup: AppSetup, src: FakeSource): Promise<void> {
		await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
		await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
		await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
		await settleReverify(src, success);
		// Enter on the open ticket: the leftover does not stop it. The row
		// wears the Starting window's face on the keypress (ADR 0030), and the
		// face keeps standing on the settle, so the face with the Working line
		// cleared is the settle itself.
		await pressReturn(
			setup,
			"the handoff to settle",
			(f) => startingFaceOf(ticketRow(f)) !== null && !frameText(f).includes("Working:"),
		);
	}

	test("a handoff beside its own leftover agent starts anyway and says so", async () => {
		const app = leftoverNameApp();

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup, app.src);
				const commands = app.runner.commands();
				// The world opens its own tab for the already-open worktree, so the
				// launch's tab is the next one: the agent stands on pane-3.
				expect(commands).toContain(`herdr agent start ${CYCLE2} --kind pi --pane pane-3`);
				expect(commands.filter((command) => command.startsWith("herdr agent prompt "))).toEqual([
					expect.stringContaining(`herdr agent prompt ${CYCLE2} `),
				]);
				// The operator learns why the name is not the one they know.
				expect(frameText(setup.captureCharFrame())).toContain(`this agent started as ${CYCLE2}`);
				expect(app.state.handoff.leftoverEnvironment(identity)).not.toBe(null);
				// The durable handoff knows the name herdr accepted, so its
				// completion trace will name the agent that actually ran.
				expect(app.state.ticketWorkCycle.agentNameForTicket(identity)).toBe(CYCLE2);
			},
			{
				width: // The warning names both herdr names on the one status row, and the
					// suite reads it at the ordinary terminal width: a cut line would hide
					// the name the agent actually started as.
					WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: // A poll the re-handoff settles before: it confirms the restarted
					// agent on the new stored pane, the face the settle waits for.
					{ kind: "polled", intervalMs: 100 },
			},
		);
		planeRecord.close();
	});

	test("an earlier own collision stays durable when a later name belongs to a stranger", async () => {
		const app = leftoverNameApp();
		// The earlier close succeeded, so the ticket has its old handoff handles
		// but no durable fact. The name collision itself must create that fact.
		app.world.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], { code: 0 });
		const collisionRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "agent" && args[1] === "start" && args[2] !== AGENT
					? Promise.resolve({
							code: 1,
							stdout: "",
							stderr: `{"error":{"code":"agent_name_taken","message":"agent name ${CYCLE2} is already used; candidates: terminal_id=term_2 pane_id=pane-stranger workspace_id=ws-stranger tab_id=tab-stranger cwd=unknown status=Idle"}}\n`,
						})
					: app.runner.run(command, args, options),
			listModels: (kind) => app.runner.listModels(kind),
		};
		const planeRecord = await planeOf(app, collisionRunner);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				await settleReverify(app.src, success);
				// The drop warning prefixes the reason, and the line truncates at
				// the terminal width, so the test renders wide enough to hold
				// the whole of it.
				await pressReturn(setup, "the handoff stopped by the stranger", (f) =>
					f.includes("pane pane-stranger"),
				);
				// The stranger blocks the new name, but the stable name was still
				// this ticket's own leftover. That first collision remains a fact.
				expect(app.state.handoff.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({ paneId: "pane-1", workspaceId: "ws-1" }),
				);
				expect(ticketRow(setup.captureCharFrame())).toContain("leftover");
			},
			{ width: WIDE_STATUS, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("a prompt that fails beside the leftover keeps its own reason", async () => {
		const app = leftoverNameApp();
		// The handoff's own failure: the agent started under its cycle name,
		// and the prompt never reached it. The name warning explains that name,
		// but it must not swallow the reason the operator has to act on.
		const promptRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "agent" && args[1] === "prompt"
					? Promise.resolve({
							code: 1,
							stdout: "",
							stderr:
								'{"error":{"code":"agent_gone","message":"agent has no pane"},"id":"cli:agent:prompt"}\n',
						})
					: app.runner.run(command, args, options),
			listModels: (kind) => app.runner.listModels(kind),
		};
		const planeRecord = await planeOf(app, promptRunner);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup, app.src);
				// One Message line carries both facts: the failure first, the name
				// warning after it. The line is truncated to the terminal width,
				// so the test renders wide enough to hold the whole of it.
				const shown = frameText(setup.captureCharFrame());
				expect(shown).toContain(
					`agent ${CYCLE2} started, but the prompt failed: agent has no pane (agent_gone)`,
				);
				expect(shown).toContain(`a leftover agent holds ${AGENT}; this agent started as ${CYCLE2}`);
				// The agent runs, so the cycle stands: the ticket is handed off.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");
			},
			{
				width: WIDE_STATUS,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: // A poll the re-handoff settles before: it confirms the restarted
					// agent on the new stored pane, the face the settle waits for.
					{ kind: "polled", intervalMs: 100 },
			},
		);
		planeRecord.close();
	});
});

describe("the auto dispatch", () => {
	test("auto mode hands off the open ticket on the first cycle", async () => {
		const app = seededAppInAutoMode("open");
		const path = Object.values(app.config.repos)[0];

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("○ auto 1/2") && startingFaceOf(ticketRow(f)) !== null,
					"the dispatch",
				);
				// The started agent stands listed in the world, so the poll confirms it
				// inside its startup grace and the row wears the booting face.
				// The mode cell holds the booting seat: a started agent inside
				// its startup grace counts against the parallel limit, from the
				// same shared seat count the gates read.
				expect(startingFaceOf(ticketRow(frame))).not.toBeNull();
				const commands = app.runner.commands();
				expect(commands).toContain(`herdr workspace create --cwd ${path} --no-focus`);
				expect(commands.some((c) => c.startsWith("herdr agent prompt"))).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: // A poll the dispatch settles before: the observation it rides on
					// confirms the started agent inside its grace, the way the row's
					// booting face reads. The default minute poll would outlive the test.
					{ kind: "polled", intervalMs: 100 },
			},
		);
		planeRecord.close();
	});

	test("an auto-handoff starts on the settings its task profile resolves", async () => {
		// ADR 0009: an unattended handoff resolves through the same chain the
		// panel shows, so the profile's own agent, model, and level start it.
		const app = seededAppInAutoMode("open", {
			extra: {
				defaultModel: "anthropic/claude-sonnet-4-5",
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: {
						...BASE_CONFIG.taskTypes.implement,
						agent: "codex",
						thinking: "high",
					},
				},
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// An open ticket already shows its profile's agent in the detail
				// pane, so the wait resolves on the handoff itself: the pane's
				// task type row says `Handoff` only once the ticket is no longer
				// open, and the start command lands before that claim.
				await awaitFrame(setup, (f) => f.includes("Handoff task type: implement"), "the dispatch");
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				// The profile's agent, then that agent's settings: codex names its
				// level as a -c pair, and the default model resolves onto it. The
				// fresh workspace's root pane stands beside the launch's own tab,
				// so the start lands on that tab's pane.
				expect(start).toContain(
					"--kind codex --pane pane-2 -- --model anthropic/claude-sonnet-4-5 -c model_reasoning_effort=high",
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("an unfit model fails an auto-handoff before it touches herdr", async () => {
		// ADR 0010: the fit check guards the unattended route too. The fake
		// reports a pi list without the profile's model, so the dispatch dies
		// on the check, not inside an agent terminal.
		const app = seededAppInAutoMode("open", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: { ...BASE_CONFIG.taskTypes.implement, model: "gpt-4o" },
				},
			},
		});
		app.world.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("has no model"), "the refused dispatch");
				// The handoff never reached herdr: no workspace, no agent start.
				expect(app.runner.commands().some((c) => c.startsWith("herdr workspace"))).toBe(false);
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				// The ticket stays open and dispatchable once the config is fixed.
				expect(ticketRow(setup.captureCharFrame())).toContain("[open]");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("two open tickets dispatch one per top-up cycle, in list order", async () => {
		const app = seededAppInAutoMode("open", { extra: {}, outcome: pairSuccess });

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The top-up adds one item per cycle into an empty queue (ADR
				// 0051): the first cycle starts the first ticket in list order,
				// and the second cycle, the queue drained, starts the second.
				// Both started agents stand listed in herdr inside their
				// startup grace, so the mode cell holds both booting seats
				// against the cap.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("○ auto 2/2") &&
						startingFaceOf(ticketRow(f)) !== null &&
						startingFaceOf(ticketRow(f, "Watch agent turns")) !== null,
					"both dispatches",
				);
				// One herdr agent start per ticket, under the ticket's own
				// name: the queue drained, and no handoff ran twice. The fresh
				// workspace's root pane stands beside the launch's own tab, so the
				// starts land on the tabs' panes.
				const starts = app.runner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(starts).toEqual([
					`herdr agent start ${AGENT} --kind pi --pane pane-2`,
					`herdr agent start ${SECOND_AGENT} --kind pi --pane pane-3`,
				]);
				// No ticket is left with an unresolved handoff: every claim
				// the queue held settled, so nothing needs recovery.
				const visible = app.state.ticketWorkCycle.ticketListViews(
					app.config.workflowStates,
					app.config.defaultTaskType,
				).rows;
				expect(visible).toHaveLength(2);
				for (const ticket of visible) {
					expect(ticket.handoffRecoveryRequired).toBe(false);
					expect(ticket.state).toBe("handed-off");
				}
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: // A short interval lets the second top-up cycle run while the test
					// waits: the poll the default config asks for is a minute long.
					{ kind: "polled", intervalMs: 25 },
			},
		);
		planeRecord.close();
	});

	test("a config write-back leaves the automatic walks running", async () => {
		// The dev session's stall: a Handoff discovers a repository mapping and
		// writes it back, the App's config state moves, and the observation
		// effect re-runs. Its cleanup stops the dispatch module, and the effect
		// run that follows keeps using that same module, so every later ask -
		// automatic or the operator's own - answers `the dispatch has been
		// stopped` while the plane still reads as auto.
		// The fixture holds no mapping, so the convention checkout is the one
		// that resolves the repository, and it holds a different repository.
		const app = seededAppInAutoMode("open", { extra: { repos: {} }, outcome: pairSuccess });
		const planeRecord = await planeOf(app);
		const home = planeRecord.home;
		const convention = join(home, "src", "factory");
		mkdirSync(convention, { recursive: true });
		writeFileSync(join(convention, "marker"), "repo");
		// The convention checkout the plane's home holds answers its git reads
		// with another repository, so the discovery clones the ticket's
		// repository beside it and maps the ticket's repository there.
		app.world.set("git", ["-C", convention, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		app.world.set("git", ["-C", convention, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/other.git\n",
		});
		// The sibling clone the discovery makes, and the handoff that runs in it:
		// the world answers the clone, and the launch grows the workspace it
		// names.
		const sibling = join(home, "src", "factory_1");

		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The config write-back re-runs the refresh too, and a fetch the
				// test never settles would make every Ticket non-actionable. The
				// pump keeps the source as fresh as a real source is between polls.
				const pump = setInterval(() => app.src.settle(pairSuccess), 40);
				// The first top-up cycle starts the first ticket, and that Handoff
				// discovers the mapping and writes it back to the config file. The
				// write-back moves the App's config state, which re-runs the
				// observation effect. The second cycle, the queue drained, must still
				// start the second ticket: a dispatch the re-run stopped starts
				// nothing, and the plane reads auto while it does nothing.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("\u25cb auto 2/2") &&
						startingFaceOf(ticketRow(f, "Watch agent turns")) !== null,
					"both dispatches after the mapping write-back",
				);
				clearInterval(pump);
				const starts = app.runner.commands().filter((c) => c.startsWith("herdr agent start"));
				// The fresh workspace's root pane stands beside each launch's own
				// tab, so the starts land on the tabs' panes.
				expect(starts).toEqual([
					`herdr agent start ${AGENT} --kind pi --pane pane-2`,
					`herdr agent start ${SECOND_AGENT} --kind pi --pane pane-3`,
				]);
				// The write-back landed, so the config state really did move.
				expect(readFileSync(planeRecord.configPath, "utf8")).toContain(
					`"github.com/acme/factory" = "${sibling}"`,
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 25 },
			},
		);
		planeRecord.close();
	});

	test("the same-type hold withholds a finished ticket its item still lists", async () => {
		// ADR 0026: the shape of the loop the hold stops. The implement turn
		// completes while its item stays open - the follow-up work rides a
		// pull request, and the work signal the source query filters on is
		// still up. The auto-close ends the cycle, the source re-read
		// re-verifies the still-open item, and the open auto-handoff must
		// hold the ticket instead of re-running the completed type. A pair
		// ticket with no closed cycle dispatches in the same cycle: the loop
		// runs, and the finished work does not repeat.
		const app = seededAppInAutoMode("awaiting", {
			extra: {},
			outcome: pairSuccess,
			environment: "live-worktree",
			detail: {
				cause: "completed",
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The first cycles: the turn settles, the auto-close ends the
				// cycle, and the pair takes the dispatch. The finished ticket
				// rests open, waiting on the re-read its close provoked.
				// The finished ticket holds no seat; the pair's started agent
				// is inside its startup grace, so the mode cell holds one seat,
				// and the pair's row keeps the Starting face instead of reading
				// missing (issue #379).
				await awaitFrame(
					setup,
					(f) =>
						f.includes("○ auto 1/2") &&
						ticketRow(f).includes("[open]") &&
						startingFaceOf(ticketRow(f, "Watch agent turns")) !== null,
					"the auto close and the pair dispatch",
				);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("auto-closed");
				// The re-read lands after the decision: the re-verify gate opens
				// for the finished ticket, and the next cycle re-runs the
				// dispatch. The same-type hold withholds it.
				await settleReverify(app.src, pairSuccess);
				const held = await settle(setup);
				expect(ticketRow(held)).toContain("[open]");
				expect(app.runner.commands().filter((c) => c.startsWith("herdr agent start"))).toEqual([
					`herdr agent start ${SECOND_AGENT} --kind pi --pane pane-2`,
				]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		planeRecord.close();
	});

	test("an open handoff its agent cannot take reports the ticket it failed", async () => {
		// The same loud rule on the other automatic path: an open Ticket's own
		// handoff resolves a Model its Agent maps no argument for, so nothing
		// starts, and the report names the ticket rather than only the reason.
		const app = seededAppInAutoMode("open", {
			extra: {
				defaultModel: "factory-model",
				agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: { ...BASE_CONFIG.taskTypes.implement, agent: "cursor" },
				},
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const failed = await awaitFrame(
					setup,
					(f) => frameText(f).includes("queued handoff for"),
					"the failed automatic handoff",
				);
				expect(frameText(failed)).toContain("no model setting");
				// Nothing ran, and the ticket stayed the open ticket it was.
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(ticketRow(failed)).toContain("[open]");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("manual mode leaves the open ticket alone", async () => {
		const { app, planeRecord } = await bootedApp("open");
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(setup, (f) => f.includes("● manual 0/2"), "the mode cell");
				expect(ticketRow(frame)).toContain("[open]");
				// No herdr handoff commands: only the agent list polls.
				// No herdr handoff commands: only agent list polls plus the
				// one-time repository validation for the launcher.
				const commands = app.runner.commands();
				expect(commands.length).toBeGreaterThan(0);
				expect(
					commands.every(
						(c) =>
							c === "herdr agent list" ||
							c.endsWith(" rev-parse --git-dir") ||
							c.endsWith(" remote get-url origin"),
					),
				).toBe(true);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the auto decision", () => {
	test("auto mode routes a settled turn to the workflow target without the operator", async () => {
		const review = { ...BASE_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededAppInAutoMode("awaiting", {
			extra: { taskTypes: { ...BASE_CONFIG.taskTypes, review } },
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				// The refresh after the fire carries the labels the fire wrote:
				// the position offers the review task, and the top-up's
				// continuation takes it (ADR 0051).
				app.src.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-review"])],
				});
				// No operator key: the loop routed the settled turn, and the
				// trace carries the automatic decision. The predicate waits for
				// the facts the reads below take: the frame, the ticket's place
				// in the work queue, and the close of the settled agent's tab.
				// Under the parallel CI load the frame can land first.
				const frame = await awaitFrame(
					setup,
					(f) =>
						f.includes("auto-handed-off") &&
						["handed-off", "running"].includes(
							app.state.ticketWorkCycle.ticketState(identity) ?? "",
						) &&
						app.runner.commands().includes("herdr tab close tab-1"),
					"the automatic route",
				);
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"auto-handed-off",
				);
				expect(["handed-off", "running"]).toContain(
					app.state.ticketWorkCycle.ticketState(identity) ?? "",
				);
				// The row wears the workflow task's badge.
				expect(ticketRow(frame)).toContain("[review]");
				// The prompt carried the settled turn's last message, and the
				// settled agent's tab was closed once the new agent started.
				const commands = app.runner.commands();
				const prompt = commands.find((c) => c.startsWith("herdr agent prompt"));
				expect(prompt?.includes("The turn is done.")).toBe(true);
				expect(commands).toContain("herdr tab close tab-1");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("an automatic route resolves the target profile's model, not the settled one", async () => {
		// Story 25 and story 26 on the unattended path: the loop's route resolves
		// agent, model, and thinking through the target task profile's chain, and
		// its fit check reads the same resolved value the start carries.
		const app = seededAppInAutoMode("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: { ...BASE_CONFIG.taskTypes.review, model: "anthropic/claude-review-4" },
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: {
				message: "The turn is done.",
				// The model the settled handoff ran on: a route must not inherit it.
				model: "opus-4",
				thinking: "high",
				transition: reviewRoute(),
			},
		});
		app.world.setModelList("pi", ["anthropic/claude-review-4"]);

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				// The refresh after the fire carries the labels the fire wrote:
				// the position offers the review task, and the top-up's
				// continuation takes it (ADR 0051).
				app.src.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-review"])],
				});
				// Wait for the start command as well as the frame: under load the
				// route's frame can be captured before the runner records the start,
				// and asserting on a not-yet-recorded command reads undefined.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("auto-handed-off") &&
						app.runner.commands().some((command) => command.startsWith("herdr agent start")),
					"the automatic route",
				);
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--model anthropic/claude-review-4");
				// The settled handoff's own model never rides on the route.
				expect(start).not.toContain("opus-4");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("an auto route its agent cannot take starts nothing, and the decision stands at the ask (ADR 0064)", async () => {
		// The review's own setup: the transition's position names a task type
		// whose profile names an agent that maps no Model setting, beside a
		// configured default model. The route can only fail, and it fails before
		// any external step: the ask still recorded its decision, and the drop
		// keeps it (ADR 0064).
		const app = seededAppInAutoMode("awaiting", {
			extra: {
				defaultAgent: "claude",
				defaultModel: "factory-model",
				agents: { ...BASE_CONFIG.agents, claude: { kind: "claude" } },
			},
			outcome: success,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				// The refresh after the fire carries the labels the fire wrote:
				// the position offers the review task, and the top-up's
				// continuation takes it (ADR 0051).
				app.src.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-review"])],
				});
				// The loud reason reaches the status line as the drop warning, and
				// it names the ticket the route was for.
				const failed = await awaitFrame(
					setup,
					(f) => frameText(f).includes("queued handoff for"),
					"the failed automatic route",
				);
				expect(frameText(failed)).toContain("no model setting");
				// Nothing the record claims started did start: no agent ran, and
				// the drop keeps the decision the ask recorded, with the ticket
				// resting open beside its dropped route (ADR 0064, ADR 0072).
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"auto-handed-off",
				);

				// The settled turn's trace holds its decision, so neither the
				// dropped route nor any later observation reopens the turn: the
				// ticket rests open on its dead route until the operator acts on it
				// (ADR 0072).
				await sleep(300);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe(
					"auto-handed-off",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: // A short interval keeps the route coming back each cycle: the failed
					// start must not consume the turn it came from, cycle after cycle.
					{ kind: "polled", intervalMs: 25 },
			},
		);
		planeRecord.close();
	});

	test("auto mode closes a settled turn whose transition did not fire", async () => {
		// The handoff limit equals the ticket's one handoff: the close is the
		// limit degrade, and it keeps the open ticket from being re-handed.
		const app = seededAppInAutoMode("awaiting", {
			extra: {
				maxHandoffsPerTicket: 1,
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[open]") && ticketRow(f).includes("handoff limit"),
					"the auto close",
				);
				// The settled turn is auto-closed: the cycle ended, the trace
				// carries the automatic decision, and the live tab was closed.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("auto-closed");
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				// At the handoff limit, auto-handoff leaves the open ticket
				// alone: no agent start ran.
				expect(commands.filter((c) => c.startsWith("herdr agent start"))).toHaveLength(0);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("enter on an awaiting ticket in auto mode reports the factory's decision", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: { maxParallelAgents: 1 },
			outcome: pairSuccess,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
			// The second ticket's stored environment stands open in the world,
			// its live Agent in its own pane: the seat it holds is the one the
			// route waits for.
			secondEnvironment: "live-worktree",
			agents: [{ name: SECOND_AGENT, kind: "pi", status: "working", paneId: "pane-2" }],
		});
		// The second ticket holds the single parallel seat with a live agent,
		// so the route waits and the ticket stays awaiting.
		const claim = app.state.handoff.claimHandoff(
			secondIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		app.state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The route waits for the free seat: the ticket stays awaiting.
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				// Enter does not open the decision modal: the factory decides.
				await pressReturn(setup, "the factory's notice", (f) =>
					f.includes("the factory decides this ticket"),
				);
				const frame = await settle(setup);
				expect(frame).not.toContain("Decision:");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	/**
	 * The hold's reader (ADR 0092). In auto mode the Decision screen never opens on
	 * a settled turn, so the Message line is where a held Next step stands: the
	 * test reads the line the running loop reports, in the app's own frames.
	 */
	test("auto mode states a held Next step on the Message line", async () => {
		// The seeded turn's fire derived its review on the ticket, and the source's
		// own labels still offer the implement task: the step stands held, and the
		// turn rests awaiting.
		const app = seededAppInAutoMode("awaiting", {
			extra: { maxParallelAgents: 1 },
			outcome: pairSuccess,
			environment: "live-worktree",
			detail: { transition: reviewRoute() },
		});
		// No Agent works: the cycle's only fact is the settled turn it resolves.
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				await awaitFrame(
					setup,
					(f) =>
						messageRowOf(f).includes(
							`ticket ${identity} holds its Next step review: the position no longer offers the task`,
						),
					"the held Next step on the Message line",
				);
				const frame = await settle(setup);
				expect(frame).not.toContain("Decision:");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the Operator-decides type parks its completions for the operator (ADR 0085, ADR 0092)", () => {
	// The config the park cases run on: the seeded app's own types, with the
	// analyze type the shipped configuration carries - no transition, the
	// operator-decides flag on - beside the implement control.
	const withAnalyze: Partial<FactoryConfig> = {
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			implement: {
				...BASE_CONFIG.taskTypes.implement,
				transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
			},
			analyze: {
				template:
					"Analyze the following {source-kind}.\n\nRepository: {repository}\n\n" +
					"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
				operatorDecides: true,
			},
		},
	};

	test("a parked turn rests in awaiting across cycles while the session stays alive", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: withAnalyze,
			outcome: success,
			environment: "live-worktree",
			detail: {
				taskType: "analyze",
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the parked ticket");
				// The park stands ahead of the outcome checks: a completion
				// without a transition - the case that would close - rests in
				// awaiting, undecided, and the environment stays untouched.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				// Cycles keep coming, and the parked turn keeps resting: no tab
				// close kills the live session, no handoff takes the ticket, and
				// the queue holds nothing for it - a continuation needs a
				// transition that fired, and a parked ticket is not open.
				await sleep(150);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(app.state.workQueue.items()).toHaveLength(0);
				const commands = app.runner.commands();
				expect(commands.filter((c) => c.startsWith("herdr tab close"))).toHaveLength(0);
				expect(commands.filter((c) => c.startsWith("herdr agent start"))).toHaveLength(0);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
		planeRecord.close();
	});

	test("a control type with no transition still closes its turn: the flag is the only difference", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: withAnalyze,
			outcome: success,
			environment: "live-worktree",
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[open]"), "the auto-closed ticket");
				// implement carries the flag off, and no transition fired: the
				// automatic rule closes the turn, the way it did before the flag
				// existed, in a config that also carries the analyze type.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("auto-closed");
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the operator's explicit close ends the parked turn, and the ticket re-derives to open", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: withAnalyze,
			outcome: success,
			environment: "live-worktree",
			detail: {
				taskType: "analyze",
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the parked ticket");
				// The operator's close is the gate from the parked turn to
				// whatever the ticket's new position offers next (ADR 0085): the
				// refresh after the settle carries the ready-for-agent label the
				// settling agent applied (ADR 0086), and the ticket's position
				// re-derives where the machine offers it next - open, and ready
				// to be offered for implementation.
				const opened = await openSurface(setup, "delete", "the Close confirmation", (f) =>
					f.includes(`Close: ${DEFAULT_TICKET_TITLE}`),
				);
				expect(frameText(opened)).toContain("The closed decision lands on the settled turn.");
				await confirmPanel(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("closed");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	test("the awaiting ticket reopens when its agent reports working again, and parks again on the next settle", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: withAnalyze,
			outcome: success,
			environment: "live-worktree",
			detail: {
				taskType: "analyze",
				stateNow: () => Date.now() - 600_000,
			},
			// The parked agent stands idle on the stored pane: its next work
			// reopens the ticket, and its next settle parks it again.
			agents: [{ name: AGENT, kind: "pi", status: "idle", paneId: "pane-1" }],
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the parked ticket");
				// The operator answers the agent's questions in the live
				// session: the agent works again, and the plane reopens the
				// ticket - the parked turn's session survived the round.
				app.world.setAgentStatus(AGENT, "working");
				await awaitFrame(setup, (f) => ticketRow(f).includes("[running]"), "the reopened ticket");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("running");
				// The session's next settle refreshes the trace in place: still
				// parked, still undecided, still holding its session.
				app.world.setAgentStatus(AGENT, "idle");
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[awaiting]"),
					"the settled ticket, parked again",
				);
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(app.runner.commands().filter((c) => c.startsWith("herdr tab close"))).toHaveLength(
					0,
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
		planeRecord.close();
	});

	// The config the diagnose case runs on (issue #330, ADR 0116): the bug
	// position third among the issue states, and the diagnose type beside the
	// shipped shape - the park, the opened pull request, and the transition
	// on one type.
	const withDiagnose: Partial<FactoryConfig> = {
		workflowStates: [
			{
				name: "bug",
				taskType: "diagnose",
				match: { sourceKind: "github-issue", labelsAny: ["bug"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
		],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			diagnose: {
				template:
					"/skill:diagnosing-bugs\n\nRepository: {repository}\n\n{external-key}: {title}\n\n" +
					"URL: {source-url}\n\nPull request: {pull-request-url}\n\nLabels: {labels}\n\n" +
					"Description:\n{description}\n\n" +
					"Previous session message (empty on a first session): {previous-message}",
				thinking: "xhigh",
				operatorDecides: true,
				opensPullRequest: true,
				transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
			},
		},
	};

	test("a completed diagnose turn parks, offers the review route, and the operator's close releases it (issue #330)", async () => {
		// The park, the opened pull request, and a fired Transition on one type:
		// the fire wrote ready-for-review on the fixing pull request, the ticket
		// it rests behind holds no decision, and the Decision region offers the
		// review the labels put the pull request on (ADR 0116).
		const pullIdentity = "github:github.com:P_12";
		const bugOutcome: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["bug"])],
		};
		const pullFetched = (labels: string[] = []): FetchedTicket => ({
			identity: pullIdentity,
			sourceKind: "github-pull-request",
			externalKey: "#12",
			sourceState: "open",
			url: "https://github.com/acme/factory/pulls/12",
			title: `Diagnose ${DEFAULT_TICKET_TITLE}`,
			description: "The diagnosis of #5.",
			labels,
			externalUpdatedAt: "2026-08-31T10:30:00Z",
			repository: {
				identity: repoIdentity,
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: withIssueReferences({ draft: "false" }, [
				{ identity, number: 5, repository: "acme/factory" },
			]),
		});
		const pullOutcome: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:02:00Z",
			tickets: [pullFetched(["ready-for-review"])],
		};
		const app = seededApp("awaiting", {
			extra: withDiagnose,
			outcome: bugOutcome,
			environment: "live-worktree",
			detail: {
				taskType: "diagnose",
				cause: "completed",
				transition: {
					fired: true,
					when: null,
					reason: "",
					ticketFacts: [],
					pullRequestFacts: ["ready-for-review"],
					ticketWrite: null,
					pullRequestWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestIdentity: pullIdentity,
					pullRequestKey: "#12",
					writeFailure: "",
					positionTaskType: "review",
					positionTicketIdentity: pullIdentity,
				},
			},
			pullOutcome: pullOutcome,
		});
		const pull = app.pullSrc;
		if (pull === undefined) throw new Error("the pull source is missing");

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(bugOutcome);
				pull.settle(pullOutcome);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the parked ticket");
				// The park stands ahead of the outcome checks: the fired
				// transition did not route, the turn rests in awaiting with no
				// decision on it, and the environment stayed untouched.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(app.runner.commands().filter((c) => c.startsWith("herdr tab close"))).toHaveLength(
					0,
				);
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				// The Decision region offers the review the fire's labels put the
				// fixing pull request on, beside the write it states, and no gate
				// holds the step.
				expect(panel).toContain("Handoff: review");
				expect(panel).toContain("pull request #12 · added ready-for-review");
				expect(panel).not.toContain("the Next step is held");
				// The Close row is the default; confirming it releases the park
				// and ends the cycle.
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("closed");
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("auto handoff should not pickup operator tasks (ADR 0117)", () => {
	/**
	 * The config the ADR 0117 tests boot on: the spec position offers the
	 * analyze type, and the analyze type carries the flag the operator sets in
	 * their own config.
	 */
	const flaggedConfig: Partial<FactoryConfig> = {
		workflowStates: [
			{ name: "spec", taskType: "analyze", match: { labelsAny: ["ready-for-spec"] } },
		],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			analyze: {
				template:
					"Analyze the following {source-kind}.\n\nRepository: {repository}\n\n" +
					"{external-key}: {title}\n\nURL: {source-url}\n\nDescription:\n{description}",
				operatorDecides: true,
			},
		},
	};

	/** The open ticket on the spec position, fetched the way the live source answers. */
	const specSuccess: FetchOutcome = {
		status: "success",
		fetchedAt: "2026-08-31T10:00:00Z",
		tickets: [fetched(5, DEFAULT_TICKET_TITLE, ["ready-for-spec"])],
	};

	test("the machine never hands off a flagged type, and the operator's handoff starts it", async () => {
		const app = seededAppInAutoMode("open", { extra: flaggedConfig, outcome: specSuccess });

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(specSuccess);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[open]"), "the open ticket");
				await settle(setup);
				// The machine's walk has had its cycles, and it never asked a start
				// of the flagged type: the ticket stays listed, open, and unhanded,
				// with no queue item and no start command. The walk holds that row
				// only, and it states nothing for the hold.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
				expect(app.state.workQueue.items()).toHaveLength(0);
				expect(
					app.runner.commands().filter((command) => command.startsWith("herdr agent start")),
				).toHaveLength(0);

				// The operator's handoff is the operator's: Enter on the row hands the
				// ticket off with the position's suggestion, and the start runs the
				// flagged type.
				await pressReturn(setup, "the settled handoff", (f) =>
					frameText(f).includes("Handoff task type: analyze"),
				);
				expect(
					app.runner.commands().some((command) => command.startsWith("herdr agent start")),
				).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
		planeRecord.close();
	});

	test("the Decision screen stands the held Next step on the flag's gate, and the row's key starts it", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: flaggedConfig,
			outcome: specSuccess,
			environment: "live-worktree",
			detail: {
				taskType: "implement",
				cause: "completed",
				transition: {
					fired: true,
					when: null,
					reason: "",
					ticketFacts: ["ready-for-spec"],
					pullRequestFacts: [],
					ticketWrite: { added: ["ready-for-spec"], removed: ["ready-for-agent"] },
					pullRequestWrite: null,
					pullRequestIdentity: null,
					pullRequestKey: null,
					writeFailure: "",
					positionTaskType: "analyze",
					positionTicketIdentity: identity,
				},
			},
		});
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(specSuccess);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the parked ticket");
				// The hold stands: no decision, and the environment is untouched.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				expect(app.state.ticketWorkCycle.lastCompletion(identity)?.decision).toBeNull();
				expect(
					app.runner.commands().filter((command) => command.startsWith("herdr agent start")),
				).toHaveLength(0);
				// The operator's surface is the Decision screen, and the factory's
				// mode never opens it: the flip to manual is the operator's act,
				// and the Enter on the parked ticket opens the modal.
				await press(setup, "a", "manual mode", (f) => f.includes("manual"));
				await pressReturn(
					setup,
					"the decision modal",
					(f) => f.includes("Decision:") && f.includes("Handoff: analyze"),
				);
				const modal = frameText(await settle(setup));
				expect(modal).toContain("the Next step is held: the task type carries Operator-decides");
				// The row's key is still the operator's: the confirm runs the start.
				await pressArrow(setup, "down", "the goto row", () => true);
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: analyze"),
				);
				await pressReturn(setup, "the settled handoff", (f) =>
					frameText(f).includes("Handoff task type: analyze"),
				);
				expect(
					app.runner.commands().some((command) => command.startsWith("herdr agent start")),
				).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
		planeRecord.close();
	});

	test("the machine never restarts a flagged type's ticket, and the Missing modal's Restart starts it", async () => {
		const app = seededAppInAutoMode("in-flight", {
			extra: flaggedConfig,
			outcome: success,
			environment: "live-worktree",
			detail: {
				taskType: "analyze",
				// The agent ran a while before it died: past the startup grace.
				stateNow: () => Date.now() - 600_000,
			},
		});

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await settle(setup);
				// The restart walk's candidate facts all stand, and the flag's brake
				// holds the ticket out: the machine asks no start and abandons
				// nothing, and the Ticket keeps its Missing fact for the operator.
				expect(
					app.runner.commands().filter((command) => command.startsWith("herdr agent start")),
				).toHaveLength(0);
				expect(
					app.runner.commands().filter((command) => command.startsWith("herdr tab close")),
				).toHaveLength(0);
				// The Missing modal is the operator's surface, and its Restart is the
				// operator's act.
				await pressReturn(setup, "the Missing modal", (f) => f.includes("Missing:"));
				await pressReturn(setup, "the restart handoff", (_f) =>
					app.runner.commands().some((command) => command.startsWith("herdr agent prompt")),
				);
				expect(
					app.runner
						.commands()
						.some(
							(command) =>
								command.startsWith(`herdr agent start ${AGENT}`) &&
								command.includes("--pane pane-2"),
						),
				).toBe(true);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
		planeRecord.close();
	});
});

describe("the handoff queue", () => {
	test("a queued handoff whose ticket moved on settles its claim as failed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
		paths.push(dir);
		// The seeded in-flight ticket carries the newer external update: once
		// the open ticket's handoff puts both tickets in the in-flight group,
		// the tie-break sorts the in-flight one first, and the list move
		// lands on it.
		const pairMoved: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [
				fetched(5, DEFAULT_TICKET_TITLE),
				{ ...fetched(6, "Watch agent turns"), externalUpdatedAt: "2026-08-31T10:05:00Z" },
			],
		};
		// Pinned past the startup grace: the seeded handoff is a dead Agent,
		// not a booting one, so its missing badge stands on the first poll.
		const state = reopenState(join(dir, "state.sqlite"), () => Date.now() - 600_000);
		state.sourceFact.initializeSources([source]);
		state.sourceFact.applyFetch(source, pairMoved);
		// The second ticket starts in flight, with the stored herdr handles.
		const claim = state.handoff.claimHandoff(
			secondIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
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

		const path = checkout();
		const config: FactoryConfig = {
			...BASE_CONFIG,
			repos: { [repoIdentity]: path },
			workflowStates: [
				{
					name: "ready-for-review",
					taskType: "review",
					match: { labelsAny: ["ready-for-review"] },
				},
			],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
				},
			},
		};
		// The second ticket's stored tab stands in the world without its
		// Agent: that is the whole missing fact, and it is the tab the
		// abandonment's Close cleanup will close.
		const world = stubHerdrWorld({
			checkouts: [{ path, cloneUrl: CLONE_URL, defaultBranch: "main" }],
			workspaces: [{ id: "ws-1", checkoutPath: path }],
			tabs: [{ id: "tab-1", workspaceId: "ws-1", cwd: path }],
			panes: [{ id: "pane-1", tabId: "tab-1", workspaceId: "ws-1" }],
			agents: [],
		});
		const github = new FakeRunner();
		pinEmptyPullLists(github);
		const runner = worldEgress(world, github);
		// Gate the first handoff's agent start: the seat stays busy through
		// the whole key sequence, and the test releases it after the last key,
		// so the drain runs after the ticket the queued restart waits on has
		// already moved on. The gate names the exact start, so the
		// re-handoff's own start passes through it.
		const gate = gateOnRunner(
			runner,
			(command) => command === `herdr agent start ${AGENT} --kind pi --pane pane-2`,
		);
		const src = new FakeSource("issues", "github-issues", pairMoved);
		const planeRecord = await plane({
			config: { ...config, sources: [issuesSource] },
			existing: state,
			groupingAxis: "none",
			runner: () => gate.runner,
			prepare: async () => ({ boundSources: [src] }),
		});
		// The queue's marked row, by the title it stands under: the box
		// title's line holds the border, so the queue's rows sit below it,
		// and the Ticket list's rows never do.
		const queueRowLeads = (frame: string, lead: string): boolean => {
			const lines = rowsOf(frame);
			const box = lines.findIndex((line) => line.includes("Work queue"));
			if (box < 0) return false;
			return lines.slice(box + 1).some((line) => line.includes("❯") && line.includes(lead));
		};

		await withApp(
			async (setup) => {
				src.settle(pairMoved);
				// Let the settle's state updates commit before any key goes
				// out: the test renderer stalls a key that lands while the
				// refresh chain's updates are still in flight.
				await sleep(250);
				// The in-flight ticket is missing: its badge shows.
				await awaitFrame(
					setup,
					(f) => ticketRow(f, "Watch agent turns").includes("missing"),
					"the missing badge",
				);
				// Every key here waits for its effect and then for the chained
				// updates (the observation tick, the Message line) to go quiet:
				// a key that lands while they are in flight stalls the test
				// renderer.
				const pressQuietFor = (
					key: Parameters<typeof press>[1],
					what: string,
					predicate: (f: string) => boolean,
				) => pressQuiet(setup, key, what, predicate);
				const pressReturnQuietFor = (what: string, predicate: (f: string) => boolean) =>
					pressEnterQuiet(setup, what, predicate);
				// Hand off the open ticket: it runs, and it holds the seat.
				// The Ticket header, the list box border, and the box's padding
				// row sit above the list rows, so the two tickets sit on frame
				// lines three and four. The in-flight
				// ticket is first, and it is the initial selection, so the
				// move down lands the marker on line four - a line it was not
				// on, so the key is applied before the next key is pressed.
				await pressQuietFor("j", "select the open ticket", (f) => markerRowOf(f) === 4);
				await pressReturnQuietFor("the handoff to start", (f) => f.includes("handing off"));
				// Back to the missing ticket: its restart queues behind the
				// handoff in flight.
				await pressQuietFor("k", "select the missing ticket", (f) => markerRowOf(f) === 3);
				await pressReturnQuietFor("the missing modal", (f) => f.includes("Missing:"));
				await pressReturnQuietFor("the restart to queue", (f) => !f.includes("Missing:"));
				// And while the restart is queued, the ticket moves on:
				// abandon it. Enter on the row jumps to the queued item
				// (ADR 0049), and the operator removes it there; the queue
				// emptying sends the selection home to the Ticket list.
				await pressReturnQuietFor("the jump to the queued restart", (f) =>
					queueRowLeads(f, "Watch agent turns"),
				);
				// The Working line outranks the removal notice, so the effect is
				// read on the queue's own row: the handoff's item keeps the queue
				// holding one row, and the selection clamps onto it.
				await pressQuietFor("delete", "the item removed", (f) =>
					queueRowLeads(f, DEFAULT_TICKET_TITLE),
				);
				// Back to the Ticket list: up crosses the empty Consultation
				// section to the last Ticket, and one more step lands the
				// missing row, where the modal opens again and Abandon ends the
				// work cycle.
				await pressQuietFor(
					"k",
					"the Consultation section",
					// The empty Consultation list shows no marker on its message
					// row, so the cross is read on the detail pane's empty line.
					(f) => f.includes("no Consultation selected"),
				);
				await pressQuietFor("k", "the last Ticket", (f) => markerRowOf(f) === 4);
				await pressQuietFor("k", "the missing row", (f) => markerRowOf(f) === 3);
				await pressReturnQuietFor("the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				// The abandonment closes the modal, and the row reads open at
				// once: the waiting restart never claimed a seat - the cap held
				// it in the Work queue - so no Starting window covers the badge
				// (ADR 0034).
				await pressReturnQuietFor("the abandonment", (f) =>
					ticketRow(f, "Watch agent turns").includes("[open]"),
				);
				// Release the gate: the handoff in flight settles and its row
				// stands in the in-flight group's front. The abandonment
				// re-reads the ticket's sources: let that fetch land, so the
				// row is actionable for the re-handoff.
				gate.release();
				src.settle({
					status: "success",
					fetchedAt: new Date(Date.now() + 60_000).toISOString(),
					tickets: pairMoved.tickets,
				});
				// The settled handoff's row stands in the in-flight group's
				// front: the world lists its started agent, so the Starting
				// window's face keeps standing on the settle, and the face with
				// the Working line cleared is the settle itself. The row is found
				// on its face, not its title: the list row's title truncates, and
				// a message line may still carry the whole name.
				await awaitFrame(
					setup,
					(f) =>
						rowsOf(f).some((l) => l.includes("Persist") && startingFaceOf(l) !== null) &&
						!frameText(f).includes("Working:"),
					"the settled handoff's row",
					5000,
				);

				// The open ticket's handoff started once; no agent started for
				// the ticket that moved on, and the operator's removal left
				// the Work queue empty.
				const starts = runner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(starts).toEqual([`herdr agent start ${AGENT} --kind pi --pane pane-2`]);
				expect(state.workQueue.hasWorkItem(secondIdentity)).toBe(false);
				// The abandonment ran the Close cleanup on the stored
				// environment.
				expect(runner.commands()).toContain("herdr tab close tab-1");
				const visible = state.ticketWorkCycle.ticketListViews(
					config.workflowStates,
					config.defaultTaskType,
				).rows;
				const movedOn = visible.find((t) => t.identity === secondIdentity);
				const inFlight = visible.find((t) => t.identity === identity);
				expect(movedOn?.state).toBe("open");
				expect(movedOn?.handoffRecoveryRequired).toBe(false);
				expect(movedOn?.actionable).toBe(true);
				expect(inFlight?.state).toBe("handed-off");
				expect(inFlight?.handoffRecoveryRequired).toBe(false);

				// The claim settled, so the ticket is not dead: it hands off
				// again on demand. The settled handoff stands in the in-flight
				// group's front (row four), and the abandonment left the
				// selection on its own row below it (row four: the Ticket header,
				// the border, and the padding row sit above
				// the list), so the re-handoff takes no step at all.
				const held = await settle(setup);
				expect(markerRowOf(held)).toBe(4);
				await settleReverify(src, pairMoved);
				// The re-handoff settles on its new pane, which the world lists
				// with its started agent: the Starting window's face keeps
				// standing on the settle, the way it did on the first handoff.
				await pressReturnQuietFor(
					"the re-handoff to settle",
					(f) =>
						rowsOf(f).some((l) => l.includes("Watch") && startingFaceOf(l) !== null) &&
						!frameText(f).includes("Working:"),
				);
				await awaitFrame(
					setup,
					() =>
						runner.commands().includes(`herdr agent start ${SECOND_AGENT} --kind pi --pane pane-3`),
					"the re-handoff start",
				);
				await settle(setup);
				const startsAfter = runner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(startsAfter).toEqual([
					`herdr agent start ${AGENT} --kind pi --pane pane-2`,
					`herdr agent start ${SECOND_AGENT} --kind pi --pane pane-3`,
				]);
				const finalVisible = state.ticketWorkCycle.ticketListViews(
					config.workflowStates,
					config.defaultTaskType,
				).rows;
				const reHandled = finalVisible.find((t) => t.identity === secondIdentity);
				expect(reHandled?.state).toBe("handed-off");
				expect(reHandled?.handoffRecoveryRequired).toBe(false);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});

	/**
	 * The restart's first cycle counts the seat the live Agent holds (ADR 0021).
	 *
	 * The plane restarts while one task is already running under a 1/1 Parallel
	 * limit, and its Work queue holds a start that waited out the restart. The
	 * running task is two hours past its Startup grace, so the only fact that can
	 * hold its seat is the herdr poll that lists its Agent. The poll lands in the
	 * observation loop; the UI's copy of the same list lands at the cycle's end.
	 * A gate that measured the cycle against that copy read no Agent at all, read
	 * a free seat, and started the queued task on top of the live one - 2/1.
	 */
	test("a restart counts the live agent's seat before the queue's pickup", async () => {
		const app = seededApp("in-flight", {
			extra: { maxParallelAgents: 1 },
			outcome: pairSuccess,
			environment: "live-worktree",
			detail: {
				stateNow: () => Date.now() - 2 * 60 * 60 * 1000,
			},
			// The running task's Agent stands listed in its pane: the only
			// fact that holds its seat across the restart.
			agents: [{ name: AGENT, kind: "pi", status: "working", paneId: "pane-1" }],
		});
		// The start the previous run queued, still waiting when the plane opens.
		const enqueued = app.state.workQueue.enqueueWork({
			ticketIdentity: secondIdentity,
			origin: "workflow",
			choice: {
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			previousMessage: "",
			automatic: true,
		});
		if (!enqueued.ok) throw new Error(enqueued.reason);
		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				await sleep(400);
				const frame = await settle(setup, 1000);
				// The one seat the cap allows, held by the live Agent.
				expect(frameText(frame)).toContain("● manual 1/1");
				// The queued start never took a seat: its row stands, and no Agent
				// started beside the live one.
				expect(app.state.workQueue.hasWorkItem(secondIdentity)).toBe(true);
				expect(app.state.handoff.openAttemptTickets()).toEqual([]);
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});

describe("the re-fire of a recorded skip (ADR 0042)", () => {
	const pullIdentity = "github:github.com:P_12";

	/**
	 * The skip outcome the implement fire stored when no fixing pull request
	 * stood: the ticket's own facts - none - were applied, the pull request's
	 * went unwritten, and the fire derived no position.
	 */
	function skipTransition(): TransitionOutcome {
		return {
			fired: true,
			when: null,
			reason: "no linked pull request was found for the ticket",
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: null,
			positionTicketIdentity: null,
		};
	}

	/** The fixing pull request, by the labels the source reports for it. */
	function pullFetched(labels: string[] = []): FetchedTicket {
		return {
			identity: pullIdentity,
			sourceKind: "github-pull-request",
			externalKey: "#12",
			sourceState: "open",
			url: "https://github.com/acme/factory/pulls/12",
			title: "Persist source facts in state",
			description: "The implementation of #5.",
			labels,
			externalUpdatedAt: "2026-08-31T10:30:00Z",
			repository: {
				identity: repoIdentity,
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: withIssueReferences({ draft: "false" }, [
				{ identity, number: 5, repository: "acme/factory" },
			]),
		};
	}

	test("a refresh that finds the fixing pull request re-fires the skip, writes the labels, and the route follows", async () => {
		const app = seededAppInAutoMode("awaiting", {
			extra: {
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					implement: {
						...BASE_CONFIG.taskTypes.implement,
						// The transition the skip recorded: it wanted the
						// pull request's facts and found no pull request.
						transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
					},
				},
			},
			outcome: success,
			environment: "live-worktree",
			detail: {
				// The skip's turn: the agent completed the work. The completed
				// cause puts the closed cycle behind the Same-type hold, so
				// the open dispatch does not re-run the issue in the same
				// cycle that auto-closes it.
				transition: skipTransition(),
				cause: "completed",
			},
			pullOutcome: { status: "success", fetchedAt: "2026-08-31T10:01:00Z", tickets: [] },
		});
		const pull = app.pullSrc;
		if (pull === undefined) throw new Error("the pull source is missing");

		const planeRecord = await planeOf(app);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The awaiting rule reads the skip: it derives no position,
				// so the cycle auto-closes the ticket. It rests open behind
				// the closed cycle, and the trace records the skip.
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[open]"),
					"the auto-close of the skip",
				);
				// The refresh lands the fixing pull request. The cycle
				// re-fires the skip: the pull request's facts were left
				// unwritten by it, and the fire writes them now.
				pull.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [pullFetched()],
				});
				await awaitFrame(
					setup,
					(f) => f.includes("Persist source facts in state"),
					"the pull request row",
				);
				// The re-fire's fire re-reads the pull request source before it
				// writes (ADR 0076): the read is its own fetch, and the fetch
				// the test settles is that one. The label has not landed in the
				// projection, so the write is the plane's own.
				await awaitFrame(setup, () => pull.calls === 2, "the re-fire's source read");
				pull.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:03:00Z",
					tickets: [pullFetched()],
				});
				// The rule routes the position's task on the pull request. The
				// route only runs off the re-fired trace, so a frame that shows
				// the route proves the re-fire ran and recorded first.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("○ auto 1/2") &&
						ticketRow(f, "Persist source facts in state").includes("starting"),
					"the review route on the pull request",
				);
				const commands = app.runner.commands();
				// The re-fire wrote the facts the skip left unwritten.
				expect(
					commands.some(
						(command) =>
							command.startsWith("gh pr edit #12") &&
							command.includes("--add-label ready-for-review"),
					),
				).toBe(true);
				// The re-fire ran exactly once: the trace holds the re-fired
				// outcome, not the skip, so the sweep never fires it again.
				expect(
					commands.filter(
						(command) =>
							command.startsWith("gh pr edit #12") &&
							command.includes("--add-label ready-for-review"),
					),
				).toHaveLength(1);
				// The re-fire recorded over the skip: the trace is the re-fired
				// outcome with its position on the pull request.
				const transition = app.state.ticketWorkCycle.lastCompletion(identity)?.transition;
				expect(transition).toEqual(
					expect.objectContaining({
						refired: true,
						positionTaskType: "review",
						positionTicketIdentity: pullIdentity,
						reason: "",
						writeFailure: "",
						pullRequestWrite: {
							added: ["ready-for-review"],
							removed: [],
						},
					}),
				);
				// The route started the review handoff on the pull request's
				// own environment.
				expect(commands.some((command) => command.startsWith("herdr agent prompt"))).toBe(true);
				expect(app.state.ticketWorkCycle.ticketState(pullIdentity)).toBe("handed-off");
				// The issue stands open and covered behind the pull request.
				expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("open");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: LOOP_60S },
		);
		planeRecord.close();
	});
});
