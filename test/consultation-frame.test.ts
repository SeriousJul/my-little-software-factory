/**
 * The Consultation flows through the real UI: the launcher opens from `c`,
 * a worktree launch runs its pinned command sequence, the observation loop
 * settles a restarted working Consultation, an interrupted opening is
 * recovered with `r`, a failed Consultation stays immutable and opens a
 * Replacement instead, a response becomes a turn only after Herdr accepts
 * it, Agent interaction serializes Unicode input through the bounded ANSI
 * renderer, and Close cleans up the owned herdr environment while every
 * Consultation worktree survives.
 *
 * Like the handoff frame tests, these boot the app with a fake command
 * runner and a temporary home: no test reaches a real herdr session or a
 * real repository. Random launch identities are canonicalized by
 * ConsultationRunner so the command sequence stays pinnable.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";
import { type FactoryState, openFactoryState, workQueueIdentityOf } from "../src/state.ts";
import {
	actionBarRowOf,
	awaitFrame,
	closeOverlay,
	confirmPanel,
	crossToConsultations,
	crossToTickets,
	detailPaneText,
	frameText,
	launchConsultationDraft,
	messageRowOf,
	mouseClick,
	openConsultationPanel,
	openLauncher,
	press,
	pressArrow,
	rgb,
	rowsOf,
	type Setup,
	sendResponseDraft,
	settle,
	sleep,
	spanColors,
	tabUntilSlot,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceGetJson,
	workspaceListJson,
	worktreeCreateJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";

/** The canonical ids ConsultationRunner rewrites random launch ids to. */
const AGENT = "consultation-00000000";
const BRANCH = "factory/consultation-00000000-grill";

/** The canonical ids of the Consultations the tests seed by hand. */
const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;
const WORKING_ID = uid("1");
const OPENING_ID = uid("2");
const FAILED_ID = uid("3");
const RESPONSE_ID = uid("4");
const INTERACTION_ID = uid("5");
const CLOSE_A_ID = uid("6");
const CLOSE_B_ID = uid("7");
const CLOSE_C_ID = uid("8");
const FORCE_ID = uid("9");
const CLOSED_ID = uid("0");
const MISSING_ID = uid("a");
const AWAITING_ID = uid("b");
const MISSING_DIRECT_ID = uid("c");
const FAILED_DIRECT_ID = uid("d");
const CLOSED_DIRECT_ID = uid("e");
const CONFIRM_GONE_ID = uid("f");
const LIVE_CLOSE_ID = uid("g");

let home = "";
let checkout = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-consultation-frame-${Math.random().toString(36).slice(2)}`);
	checkout = join(home, "src", "factory");
	mkdirSync(checkout, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const repository = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};

const selectedTicket: Ticket = {
	identity: "github:github.com:I_1",
	title: "Review factory authentication",
	repository: "acme/factory",
	repositoryRef: repository,
	state: "open",
	handoff: null,
	workCycle: 1,
	handoffCount: 0,
	lastCompletion: null,
	description: "Review the authentication design.",
	sourceKind: "github-issue",
	externalKey: "#1",
	sourceState: "open",
	url: "https://github.com/acme/factory/issues/1",
	labels: [],
	externalUpdatedAt: "2026-09-01T10:00:00.000Z",
	memberships: [],
	suggestedTaskType: "implement",
	actionable: true,
	handoffRecoveryRequired: false,
	leftover: null,
};

function configFor(): FactoryConfig {
	return {
		...BASE_CONFIG,
		repos: { "github.com/acme/factory": checkout },
		consultationTypes: {
			grill: { agent: "pi", environment: "worktree", template: "/grill {input}" },
		},
	};
}

/** Seed a Consultation with a deterministic id, and optionally its Agent. */
function seed(
	state: FactoryState,
	id: string,
	agent = true,
	createdAt = "2026-09-01T10:00:00.000Z",
	contextWindow = "",
	environment: "worktree" | "live-worktree" = "worktree",
): void {
	state.createConsultation({
		id,
		typeName: "grill",
		agentType: "pi",
		environment,
		model: "",
		thinking: "",
		contextWindow,
		template: "/grill {input}",
		initialInput: "review auth",
		renderedOpeningPrompt: "/grill review auth",
		repository: { ...repository, path: checkout },
		agentName: `consultation-${id.slice(0, 8)}`,
		createdAt,
	});
	if (agent)
		state.setConsultationAgent(id, {
			paneId: `pane-${id.slice(0, 8)}`,
			tabId: `tab-${id.slice(0, 8)}`,
			workspaceId: `ws-${id.slice(0, 8)}`,
			sessionId: `sess-${id.slice(0, 8)}`,
		});
}

/** The herdr handles a worktree launch records for its Consultation. */
function seedResources(state: FactoryState, id: string): void {
	const short = id.slice(0, 8);
	state.recordConsultationResource(id, {
		kind: "workspace",
		resourceId: `ws-${short}`,
		owned: true,
		details: "Consultation worktree workspace",
	});
	state.recordConsultationResource(id, {
		kind: "worktree",
		resourceId: `ws-${short}`,
		owned: true,
		details: `Consultation worktree checkout for factory/consultation-${short}-grill`,
	});
	state.recordConsultationResource(id, {
		kind: "tab",
		resourceId: `tab-${short}`,
		owned: true,
		details: "Consultation worktree tab",
	});
	state.recordConsultationResource(id, {
		kind: "pane",
		resourceId: `pane-${short}`,
		owned: true,
		details: "Consultation Agent pane",
	});
	state.recordConsultationResource(id, {
		kind: "agent",
		resourceId: `consultation-${short}`,
		owned: true,
		details: `Agent hosted by pane pane-${short}`,
	});
}

/** Stub the git answers for a healthy, verified convention checkout. */
function stubCheckout(runner: FakeRunner): void {
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
}

/** Stub the full worktree launch sequence at the verified checkout. */
function stubWorktreeLaunch(runner: FakeRunner, branch = BRANCH): void {
	runner.set("git", ["-C", checkout, "branch", "--list", branch], { stdout: "" });
	// The worktree base rule: the origin/HEAD symref names the default
	// branch and the fetch of its single ref succeeds, so the base is the
	// fetched remote ref.
	runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		stdout: "refs/remotes/origin/main\n",
	});
	runner.set(
		"herdr",
		[
			"worktree",
			"create",
			"--cwd",
			checkout,
			"--branch",
			branch,
			"--base",
			"origin/main",
			"--no-focus",
		],
		{ stdout: worktreeCreateJson("ws-new", "pane-c1") },
	);
	runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-c1"], {
		stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }),
	});
	runner.set("herdr", ["agent", "prompt", AGENT, "/grill review auth"], { code: 0 });
}

/** Stub the plain-text pane read the output refresh timer issues. */
function stubPaneReadText(runner: FakeRunner, paneId: string, output: string): void {
	runner.set(
		"herdr",
		["agent", "read", paneId, "--lines", "200", "--source", "recent-unwrapped", "--format", "text"],
		{ stdout: output },
	);
}

/** Stub the visible ANSI pane read Agent interaction mode issues. */
function stubPaneReadAnsi(runner: FakeRunner, paneId: string, output: string): void {
	runner.set(
		"herdr",
		["agent", "read", paneId, "--lines", "200", "--source", "visible", "--format", "ansi"],
		{ stdout: JSON.stringify({ result: { output } }) },
	);
}

/** Stub the workspace topology: which tabs and panes herdr reports. */
function stubTopology(
	runner: FakeRunner,
	workspaceId: string,
	tabs: string[],
	panes: Array<{ pane_id: string; tab_id: string }>,
): void {
	runner.set("herdr", ["tab", "list", "--workspace", workspaceId], {
		stdout: JSON.stringify({ result: { tabs: tabs.map((tab_id) => ({ tab_id })) } }),
	});
	runner.set("herdr", ["pane", "list", "--workspace", workspaceId], {
		stdout: JSON.stringify({ result: { panes } }),
	});
}

/**
 * The egress double for Consultation launches: it canonicalizes the random
 * Agent name and branch a fresh launch picks, answers `agent list` with a
 * test-controlled list, and pins every other command exactly.
 */
/**
 * A runner that holds every command one predicate names, so a test can keep an
 * operation in flight for as long as it needs.
 */
class GatedRunner implements CommandRunner {
	private readonly inner: CommandRunner;
	private readonly gate: (command: string, args: readonly string[]) => boolean;

	constructor(inner: CommandRunner, gate: (command: string, args: readonly string[]) => boolean) {
		this.inner = inner;
		this.gate = gate;
	}

	listModels(kind: string): Promise<ModelListResult> {
		return this.inner.listModels(kind);
	}

	run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
		if (!this.gate(command, args)) return this.inner.run(command, args, options);
		return new Promise<CommandResult>(() => {});
	}
}

class ConsultationRunner implements CommandRunner {
	private readonly inner: FakeRunner;
	agentListJson: string;

	constructor(inner: FakeRunner, agentListJson: string) {
		this.inner = inner;
		this.agentListJson = agentListJson;
	}

	commands(): string[] {
		return this.inner.commands();
	}

	listModels(kind: string): Promise<ModelListResult> {
		return this.inner.listModels(kind);
	}

	async run(
		command: string,
		args: readonly string[],
		options?: CommandOptions,
	): Promise<CommandResult> {
		if (command === "herdr" && args[0] === "agent" && args[1] === "list")
			return { code: 0, stdout: this.agentListJson, stderr: "" };
		if (command === "herdr" && args[0] === "agent" && args[1] === "start")
			return this.inner.run(
				command,
				[
					"agent",
					"start",
					AGENT,
					"--kind",
					args[4],
					"--pane",
					args[6],
					...(args.length > 7 ? [...args.slice(7)] : []),
				],
				options,
			);
		if (command === "herdr" && args[0] === "agent" && args[1] === "prompt")
			return this.inner.run(command, ["agent", "prompt", AGENT, args[3]], options);
		return this.inner.run(
			command,
			args.map((arg) => (arg.startsWith("factory/consultation-") ? BRANCH : arg)),
			options,
		);
	}
}

/**
 * A herdr `agent list` answer keyed by pane id, status, and sequence. The
 * tab, workspace, and session handles derive from the pane unless given, so
 * a launched Consultation's list entry matches its recorded handles.
 */
const agentListJson = (
	agents: Array<{
		pane: string;
		status: string;
		seq?: number;
		tab?: string;
		ws?: string;
		sess?: string;
		/** The pi session record path herdr reports for the agent. */
		record?: string;
	}>,
) =>
	JSON.stringify({
		result: {
			agents: agents.map((agent) => ({
				pane_id: agent.pane,
				tab_id: agent.tab ?? `tab-${agent.pane.slice(5)}`,
				workspace_id: agent.ws ?? `ws-${agent.pane.slice(5)}`,
				agent: AGENT,
				agent_status: agent.status,
				session_id: agent.sess ?? `sess-${agent.pane.slice(5)}`,
				...(agent.seq === undefined ? {} : { sequence: agent.seq }),
				...(agent.record === undefined
					? {}
					: { agent_session: { kind: "path", value: agent.record } }),
			})),
		},
	});

/** The full-flow launch's agent list entry, matched to its recorded handles. */
const launchedAgent = { pane: "pane-c1", tab: "tab-ws-new", ws: "ws-new", sess: "sess-c1" };

/** A configuration with a live-worktree Consultation type. */
function liveConfigFor(): FactoryConfig {
	return {
		...BASE_CONFIG,
		repos: { "github.com/acme/factory": checkout },
		consultationTypes: {
			"grill-live": { agent: "pi", environment: "live-worktree", template: "/grill {input}" },
		},
	};
}

/** Stub the git answers for a verified live checkout, optionally dirty. */
function stubLiveCheckout(runner: FakeRunner, dirty: boolean): void {
	stubCheckout(runner);
	runner.set("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], {
		stdout: dirty ? " M src/app.ts\n" : "",
	});
}

/** Stub the live launch into a workspace herdr already holds at the checkout. */
function stubLiveLaunchExisting(runner: FakeRunner): void {
	runner.set("herdr", ["workspace", "list"], {
		stdout: workspaceListJson([{ id: "ws-live", checkoutPath: checkout }]),
	});
	runner.set(
		"herdr",
		["tab", "create", "--workspace", "ws-live", "--cwd", checkout, "--no-focus"],
		{ stdout: tabCreateJson("pane-c1", "tab-c1") },
	);
	runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-c1"], {
		stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }),
	});
	runner.set("herdr", ["agent", "prompt", AGENT, "/grill review auth"], { code: 0 });
}

/** Stub the live launch that creates a workspace at the checkout. */
function stubLiveLaunchNew(runner: FakeRunner): void {
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-new", "pane-c1"),
	});
	runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-c1"], {
		stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }),
	});
	runner.set("herdr", ["agent", "prompt", AGENT, "/grill review auth"], { code: 0 });
}

/** Count the attention-bell bytes the app writes to the terminal. */
function countBells(): { count: () => number; restore: () => void } {
	let bells = 0;
	const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
		if (String(chunk).includes("\u0007")) bells += 1;
		return true;
	}) as typeof process.stdout.write);
	return { count: () => bells, restore: () => spy.mockRestore() };
}

/** Poll a condition until it holds or the deadline passes. */
async function waitFor(condition: () => boolean, what: string, deadlineMs = 4000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (condition()) return;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
}

/** The deterministic boot props: state, the fake runner, no observation. */
const bootProps = (state: FactoryState, runner: CommandRunner) => ({
	state,
	runner,
	config: configFor(),
	home,
	initialTickets: [],
});

/** Cross into the Consultation list, then wait for the detail the test names. */
async function toConsultations(
	setup: Setup,
	what: string,
	predicate: (f: string) => boolean,
): Promise<string> {
	await crossToConsultations(setup);
	return awaitFrame(setup, predicate, what);
}
/** Wait until every needle shows up in the recorded commands. */
async function waitForCommands(runner: ConsultationRunner, needles: string[], what: string) {
	const deadline = Date.now() + 4000;
	for (;;) {
		const recorded = runner.commands().join("\n");
		if (needles.every((needle) => recorded.includes(needle))) return;
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${what}:\n${runner.commands().join("\n")}`);
		await sleep(25);
	}
}

/** The harness press() only types AppKeys; these cover the rest. */
async function pressEnter(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	return awaitFrame(setup, predicate, what);
}
async function pressF12(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressKey("F12");
	return awaitFrame(setup, predicate, what);
}

describe("Consultation launch and monitoring through the UI", () => {
	test("the launcher resolves an unmapped selected Ticket Repository before the pinned launch sequence", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const ticketSource = { name: "tickets", kind: "test" };
		const ticketOutcome = {
			status: "success" as const,
			fetchedAt: "2026-09-01T10:00:00.000Z",
			tickets: [
				{
					identity: selectedTicket.identity,
					sourceKind: selectedTicket.sourceKind,
					externalKey: selectedTicket.externalKey,
					sourceState: selectedTicket.sourceState,
					url: selectedTicket.url,
					title: selectedTicket.title,
					description: selectedTicket.description,
					labels: selectedTicket.labels,
					externalUpdatedAt: selectedTicket.externalUpdatedAt,
					repository: selectedTicket.repositoryRef,
					attributes: {},
				},
			],
		};
		state.initializeSources([ticketSource]);
		state.applyFetch(ticketSource, ticketOutcome);
		const source = new FakeSource(ticketSource.name, ticketSource.kind, ticketOutcome);
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: auth review");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					// Move to the initial input field and type the request.
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the launch command sequence",
					);
					const commands = runner.commands();
					const worktreeAt = commands.findIndex((c) => c.includes("worktree create"));
					const startAt = commands.findIndex((c) => c.includes("agent start"));
					const promptAt = commands.findIndex((c) => c.includes("agent prompt"));
					expect(worktreeAt).toBeGreaterThan(-1);
					expect(startAt).toBeGreaterThan(worktreeAt);
					expect(promptAt).toBeGreaterThan(startAt);
					await awaitFrame(setup, (f) => f.includes("Agent: auth review"), "the live Agent output");
					const started = state.consultations("open");
					expect(started).toHaveLength(1);
					expect(started[0].state).toBe("working");
					expect(started[0].paneId).toBe("pane-c1");
					expect(state.pendingConsultationResponse(started[0].id)).toBeNull();
				},
				WIDTH,
				32,
				{
					...bootProps(state, runner),
					config: { ...configFor(), repos: {} },
					sources: [source],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the observation loop settles a restarted working Consultation", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(inner, agentListJson([{ pane: paneId, status: "idle" }]));
		stubPaneReadText(inner, paneId, "Agent: auth review looks sound");
		try {
			await withApp(
				async (setup) => {
					// The first observation cycle settles the opening turn. The
					// Agent view label is the stable signal that the settle has
					// fully landed: the status badge can flip before the detail
					// pane repaints, so wait for both.
					await toConsultations(
						setup,
						"the consultations view with the settled state",
						(f) => f.includes("State: awaiting-response") && f.includes("Agent view:"),
					);
					const detail = detailPaneText(setup.captureCharFrame());
					expect(detail).toContain("Agent view:");
					expect(detail).toContain("Agent: auth review looks sound");
					expect(frameText(setup.captureCharFrame())).toContain("awaiting response: 1");
					expect(state.consultation(WORKING_ID)?.state).toBe("awaiting-response");
					expect(state.consultationTurns(WORKING_ID)).toHaveLength(1);
					expect(state.consultationTurns(WORKING_ID)[0].settledAt).not.toBeNull();
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: configFor(),
					home,
					pollIntervalMs: 100,
				},
			);
		} finally {
			state.close();
		}
	});
});

test("the mode line counts the ticket seat and the Consultation seat against one cap", async () => {
	// Issue #87: the Parallel limit counts a Consultation alike with a
	// ticket. The running ticket and the working Consultation each hold
	// one seat, and the mode line shows the combined count against the one
	// cap, from the same shared seat count the gates read. When the
	// Consultation settles to awaiting-response it drops its seat, and the
	// line holds the ticket's seat alone.
	const state = openFactoryState(join(home, "state.sqlite"));
	const ticketSource = { name: "tickets", kind: "test" };
	const ticketOutcome = {
		status: "success" as const,
		fetchedAt: "2026-09-01T10:00:00.000Z",
		tickets: [
			{
				identity: selectedTicket.identity,
				sourceKind: selectedTicket.sourceKind,
				externalKey: selectedTicket.externalKey,
				sourceState: selectedTicket.sourceState,
				url: selectedTicket.url,
				title: selectedTicket.title,
				description: selectedTicket.description,
				labels: selectedTicket.labels,
				externalUpdatedAt: selectedTicket.externalUpdatedAt,
				repository: selectedTicket.repositoryRef,
				attributes: {},
			},
		],
	};
	state.initializeSources([ticketSource]);
	state.applyFetch(ticketSource, ticketOutcome);
	const claim = state.claimHandoff(
		selectedTicket.identity,
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
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-ticket",
		tabId: "tab-ticket",
		workspaceId: "ws-ticket",
	});
	seed(state, WORKING_ID);
	const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
	const inner = new FakeRunner();
	stubPaneReadText(inner, paneId, "Agent: the review is underway");
	const runner = new ConsultationRunner(
		inner,
		agentListJson([
			{ pane: "pane-ticket", status: "working" },
			{ pane: paneId, status: "working" },
		]),
	);
	try {
		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("auto: off 2/2"), "the combined seat count");
				// The Consultation settles to awaiting-response on the idle
				// poll: that state holds no seat, and the line drops to the
				// ticket's seat alone.
				runner.agentListJson = agentListJson([
					{ pane: "pane-ticket", status: "working" },
					{ pane: paneId, status: "idle" },
				]);
				await toConsultations(setup, "the settled Consultation", (f) =>
					f.includes("State: awaiting-response"),
				);
				await awaitFrame(setup, (f) => f.includes("auto: off 1/2"), "the dropped seat");
			},
			WIDTH,
			32,
			// No initialTickets: the observation loop must poll herdr for the
			// seat count's agent list, and it stands down on a test
			// projection.
			{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
		);
	} finally {
		state.close();
	}
});
describe("Consultation recovery and replacement through the UI", () => {
	test("an interrupted opening recovers with r", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, OPENING_ID, false);
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: reviewing");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					// The action bar offers recovery for an opening Consultation.
					expect(frameText(setup.captureCharFrame())).toContain("r Recover");
					await press(setup, "r", "the recovered launch to reach working", (f) =>
						f.includes("State: working"),
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the recovery launch sequence",
					);
					expect(state.consultation(OPENING_ID)?.state).toBe("working");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("recovery re-checks the stored settings before it resumes the Agent", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// The interrupted launch recorded its Agent pane and the count its type
		// named, and never reached a settled state. Herdr reports no Agent, so the
		// stored count is the one thing that can refuse this recovery: pi maps no
		// context window setting.
		seed(state, OPENING_ID, false, "2026-09-01T10:00:00.000Z", "131072");
		const short = OPENING_ID.slice(0, 8);
		state.recordConsultationAgentHandles(OPENING_ID, {
			paneId: `pane-${short}`,
			tabId: `tab-${short}`,
			workspaceId: `ws-${short}`,
			sessionId: `sess-${short}`,
		});
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: opening"),
					);
					await press(setup, "r", "the refused recovery", (f) => f.includes("State: failed"));
					const failed = state.consultation(OPENING_ID);
					expect(failed?.failure).toContain(
						'agent type "pi" defines no context window setting, so the count of 131072 tokens cannot reach it',
					);
					// A refused recovery starts nothing: the environment waits for the
					// operator to fix the setting or open a Replacement.
					const commands = runner.commands().join("\n");
					expect(commands).not.toContain("worktree create");
					expect(commands).not.toContain("agent start");
					expect(commands).not.toContain("agent prompt");
				},
				WIDTH,
				30,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("a failed Consultation refuses r and opens a Replacement launcher from c", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, FAILED_ID, false);
		state.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: reviewing");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		const expectedInput = state.replacementInput(FAILED_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					const failed = await awaitFrame(
						setup,
						(f) => f.includes("State: failed"),
						"the failed detail",
					);
					expect(frameText(failed)).toContain("herdr refused the launch");
					// r refreshes but never resumes a failed Consultation.
					await press(setup, "r", "the frame to stay failed", (f) => f.includes("State: failed"));
					await settle(setup);
					const joined = runner.commands().join("\n");
					expect(joined).not.toContain("worktree create");
					expect(joined).not.toContain("agent start");
					expect(joined).not.toContain("agent prompt");
					// c opens the Replacement launcher with the retained context.
					const launcher = await openLauncher(setup, "Replacement Consultation");
					expect(frameText(launcher)).toContain("Original input:");
					await closeOverlay(setup, "┌─Replacement Consultation", "the launcher to close");
					// Relaunch: the replacement carries the failed id forward.
					await openLauncher(setup, "Replacement Consultation");
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					// The Replacement launcher opens on the retained context, so the
					// flow is the same one any launcher takes: Tab to the visible
					// action and run it there.
					await tabUntilSlot(setup, "❯ Launch Consultation");
					setup.mockInput.pressEnter();
					await awaitFrame(
						setup,
						(f) => f.includes("Replaced by:"),
						"the failed detail to record the replacement",
					);
					await waitForCommands(
						runner,
						[`herdr agent prompt ${AGENT} /grill ${expectedInput}`],
						"the replacement prompt",
					);
					// The replacement itself points back at the failed record.
					await press(setup, "j", "the replacement detail with its origin", (f) =>
						f.includes(`Replacement of: ${FAILED_ID.slice(0, 8)}`),
					);
					expect(frameText(setup.captureCharFrame())).toContain("State: working");
					const replacements = state.consultations("open").filter((item) => item.id !== FAILED_ID);
					expect(replacements).toHaveLength(1);
					expect(replacements[0].replacementOf).toBe(FAILED_ID);
					expect(replacements[0].state).toBe("working");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

/**
 * Enter answers the Consultation under the cursor with the surface its state
 * needs: the Agent or the response on a live record, the recovery panel on a
 * broken or stuck one, the close panel's retry rows on a record stuck in
 * cleanup, and a readable refusal on a closed one.
 */
describe("Consultation Enter reaches the recovery surface its state needs", () => {
	test("Enter on an opening Consultation opens the recovery panel, and Recover retries it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, OPENING_ID, false);
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: reviewing");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the interrupted opening", (f) =>
						f.includes("State: opening"),
					);
					// The bar names the meaning Enter carries on this row.
					expect(actionBarRowOf(setup.captureCharFrame())).toContain("Enter Recovery");
					await openConsultationPanel(setup, "return", "the recovery panel", (f) =>
						f.includes("Recover Consultation"),
					);
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("The Agent never finished opening.");
					expect(frameText(panel)).toContain("Recover");
					expect(frameText(panel)).toContain("Close");
					// The panel's first row is the retry the interrupted opening needs:
					// it runs the same recovery the `r` key runs.
					await confirmPanel(setup, "the recovered opening to reach working", (f) =>
						f.includes("State: working"),
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the recovery launch sequence",
					);
					expect(state.consultation(OPENING_ID)?.state).toBe("working");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("the recovery panel's Close takes an opening Consultation through its dialog", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, OPENING_ID, false);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the interrupted opening", (f) =>
						f.includes("State: opening"),
					);
					await openConsultationPanel(setup, "return", "the recovery panel", (f) =>
						f.includes("Recover Consultation"),
					);
					// The Close row is the close path, dialog and all: an opening
					// record still holds an Agent the close must stop.
					await pressArrow(setup, "down", "the Close row to be selected", (f) =>
						f.includes("❯ Close"),
					);
					const dialog = await confirmPanel(setup, "the close dialog", (f) =>
						f.includes("Close Consultation"),
					);
					expect(frameText(dialog)).toContain("The Agent is still opening");
					expect(state.consultation(OPENING_ID)?.state).toBe("opening");
					await press(
						setup,
						"escape",
						"the dialog to close",
						(f) => !f.includes("Close Consultation"),
					);
					expect(state.consultation(OPENING_ID)?.state).toBe("opening");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("Enter on a missing Consultation opens the recovery panel, and Replace links its replacement", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, MISSING_ID, false);
		state.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: reviewing");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		const expectedInput = state.replacementInput(MISSING_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the missing Consultation", (f) =>
						f.includes("State: missing"),
					);
					await openConsultationPanel(setup, "return", "the recovery panel", (f) =>
						f.includes("Recover Consultation"),
					);
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("The Agent is gone from its pane.");
					expect(frameText(panel)).toContain("the Agent pane is gone");
					expect(frameText(panel)).toContain("Replace");
					// Replace opens the launcher on the record's durable recovery
					// context, not on an empty form.
					const launcher = await confirmPanel(setup, "the Replacement launcher", (f) =>
						f.includes("Replacement Consultation"),
					);
					expect(frameText(launcher)).toContain("Original input:");
					await tabUntilSlot(setup, "❯ Launch Consultation");
					setup.mockInput.pressEnter();
					await awaitFrame(
						setup,
						(f) => f.includes("Replaced by:"),
						"the missing detail to record the replacement",
					);
					await waitForCommands(
						runner,
						[`herdr agent prompt ${AGENT} /grill ${expectedInput}`],
						"the replacement prompt",
					);
					const replacement = state.consultations("open").find((item) => item.id !== MISSING_ID);
					expect(replacement?.replacementOf).toBe(MISSING_ID);
					// The replaced record keeps its own state beside the new one.
					expect(state.consultation(MISSING_ID)?.state).toBe("missing");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("the recovery panel's Close retires a failed record without a dialog", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, FAILED_ID, false);
		state.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		const short = FAILED_ID.slice(0, 8);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the failed Consultation", (f) =>
						f.includes("State: failed"),
					);
					await openConsultationPanel(setup, "return", "the recovery panel", (f) =>
						f.includes("Recover Consultation"),
					);
					await pressArrow(setup, "down", "the Close row to be selected", (f) =>
						f.includes("❯ Close"),
					);
					// A failed record holds no Agent, so the close runs on the row:
					// no confirmation stands between it and the result.
					const frame = await confirmPanel(setup, "the direct close", (f) =>
						messageRowOf(f).includes(`${short} closed`),
					);
					expect(frame).not.toContain("Close Consultation");
					expect(state.consultation(FAILED_ID)?.state).toBe("closed");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("Enter on a closing Consultation opens the close panel's Retry and Force-close", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, CLOSE_A_ID);
		state.beginConsultationClose(CLOSE_A_ID);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the closing Consultation", (f) =>
						f.includes("State: closing"),
					);
					// The stuck cleanup is the record's recovery, so Enter opens the
					// close panel that already carries its retry rows.
					await openConsultationPanel(setup, "return", "the close recovery panel", (f) =>
						f.includes("Close Consultation"),
					);
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("Cleanup is already in progress");
					expect(frameText(panel)).toContain("Retry");
					expect(frameText(panel)).toContain("Force-close");
					expect(state.consultation(CLOSE_A_ID)?.state).toBe("closing");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("Enter on a closed Consultation says the record is already closed", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, CLOSED_DIRECT_ID);
		state.settleConsultationTurn(CLOSED_DIRECT_ID, null, "done", "idle");
		state.beginConsultationClose(CLOSED_DIRECT_ID);
		state.finishConsultationClose(CLOSED_DIRECT_ID);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					await press(setup, "f", "the closed history filter", (f) => f.includes("State: closed"));
					await press(setup, "return", "the Enter refusal", (f) =>
						f.includes("the selected Consultation is already closed"),
					);
					expect(state.consultation(CLOSED_DIRECT_ID)?.state).toBe("closed");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation responses through the UI", () => {
	test("a response becomes a turn only after Herdr accepts the prompt", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, RESPONSE_ID);
		state.settleConsultationTurn(RESPONSE_ID, null, "first answer", "idle");
		state.setConsultationDraft(RESPONSE_ID, "follow up");
		const inner = new FakeRunner();
		stubPaneReadText(inner, `pane-${RESPONSE_ID.slice(0, 8)}`, "Agent: waiting");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("Response draft"));
					const editor = await awaitFrame(
						setup,
						(f) => f.includes("follow up"),
						"the saved draft in the editor",
					);
					expect(frameText(editor)).toContain("Response draft");
					await sendResponseDraft(setup);
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[`herdr agent prompt ${AGENT} follow up`],
						"the response prompt",
					);
					expect(state.pendingConsultationResponse(RESPONSE_ID)).toBeNull();
					const turns = state.consultationTurns(RESPONSE_ID);
					expect(turns).toHaveLength(2);
					expect(turns[1].input).toBe("follow up");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("a rejected prompt keeps the draft and leaves no pending delivery", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, RESPONSE_ID);
		state.settleConsultationTurn(RESPONSE_ID, null, "first answer", "idle");
		state.setConsultationDraft(RESPONSE_ID, "follow up");
		const inner = new FakeRunner();
		inner.set("herdr", ["agent", "prompt", AGENT, "follow up"], {
			code: 1,
			stderr: "refused\n",
		});
		stubPaneReadText(inner, `pane-${RESPONSE_ID.slice(0, 8)}`, "Agent: waiting");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("Response draft"));
					await sendResponseDraft(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("response failed: refused"),
						"the failure status and the reopened editor",
					);
					expect(state.consultation(RESPONSE_ID)).toMatchObject({
						state: "awaiting-response",
						draft: "follow up",
					});
					expect(state.pendingConsultationResponse(RESPONSE_ID)).toBeNull();
					expect(state.consultationTurns(RESPONSE_ID)).toHaveLength(1);
					expect(frameText(setup.captureCharFrame())).toContain("follow up");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("the settled Agent output stays visible until an accepted response opens the next turn", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, RESPONSE_ID);
		state.settleConsultationTurn(RESPONSE_ID, null, "the design holds", "idle");
		const paneId = `pane-${RESPONSE_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: the design holds");
		const runner = new ConsultationRunner(inner, agentListJson([{ pane: paneId, status: "idle" }]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: awaiting-response"),
					);
					// The Agent's last message stays readable until the operator answers.
					const settled = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Agent: the design holds"),
						"the settled Agent output",
					);
					expect(detailPaneText(settled)).toContain("Agent view:");
					expect(detailPaneText(settled)).toContain("the design holds");
					expect(actionBarRowOf(settled)).toContain("Enter Respond");
					expect(actionBarRowOf(settled)).not.toContain("Enter/r Respond");
					// `r` remains Refresh even when Enter can open the response editor.
					await press(setup, "r", "refresh instead of response", (f) =>
						messageRowOf(f).includes("no Ticket sources exist"),
					);

					await pressEnter(setup, "the response editor", (f) => f.includes("Response draft"));
					setup.mockInput.typeText("then ship it");
					await sendResponseDraft(setup);
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[`herdr agent prompt ${AGENT} then ship it`],
						"the operator's response",
					);
					expect(state.pendingConsultationResponse(RESPONSE_ID)).toBeNull();
					const turns = state.consultationTurns(RESPONSE_ID);
					expect(turns).toHaveLength(2);
					expect(turns.at(-1)?.input).toBe("then ship it");
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
			);
		} finally {
			state.close();
		}
	});
});

describe("Agent interaction through the UI", () => {
	test("interaction renders pane ANSI safely and serializes Unicode input", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, INTERACTION_ID);
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: working");
		stubPaneReadAnsi(inner, paneId, "\u001b[31mERROR: authz\u001b[0m and more");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "interaction mode with its exit key", (f) =>
						f.includes("F12 Exit interaction"),
					);
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("ERROR: authz"),
						"the rendered pane output",
					);
					// The escape bytes never reach the control plane frame.
					expect(frame).not.toContain("\u001b");
					// The SGR color lands on the pane text in the renderer.
					expect(spanColors(setup, "ERROR: authz").map((color) => color.join(","))).toContain(
						rgb("#cd3131").join(","),
					);
					// Literal text and a semantic key keep terminal order.
					setup.mockInput.pressKey("h");
					setup.mockInput.pressKey("\u00e9");
					await pressEnter(setup, "the frame to stay in interaction", (f) =>
						f.includes("F12 Exit interaction"),
					);
					await waitForCommands(
						runner,
						[`herdr pane send-text ${paneId} h\u00e9`, `herdr pane send-keys ${paneId} enter`],
						"the serialized interaction input",
					);
					const commands = runner.commands();
					const textAt = commands.indexOf(`herdr pane send-text ${paneId} h\u00e9`);
					const keyAt = commands.indexOf(`herdr pane send-keys ${paneId} enter`);
					expect(textAt).toBeGreaterThan(-1);
					expect(keyAt).toBeGreaterThan(textAt);
					// The configured exit key leaves the mode.
					await pressF12(setup, "the exit from interaction mode", (f) =>
						f.includes("left Agent interaction mode"),
					);
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation close and cleanup through the UI", () => {
	test("close takes down only what is exclusively owned, and keeps every worktree", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// A: an exclusive workspace: the workspace close is safe.
		seed(state, CLOSE_A_ID);
		seedResources(state, CLOSE_A_ID);
		// B: a foreign tab shares the workspace: only the owned tab closes.
		seed(state, CLOSE_B_ID);
		seedResources(state, CLOSE_B_ID);
		// C: a foreign pane sits in the owned tab: only the pane closes.
		seed(state, CLOSE_C_ID);
		seedResources(state, CLOSE_C_ID);
		const a = CLOSE_A_ID.slice(0, 8);
		const b = CLOSE_B_ID.slice(0, 8);
		const c = CLOSE_C_ID.slice(0, 8);
		const inner = new FakeRunner();
		stubPaneReadText(inner, `pane-${a}`, "Agent: done a");
		stubPaneReadText(inner, `pane-${b}`, "Agent: done b");
		stubPaneReadText(inner, `pane-${c}`, "Agent: done c");
		stubTopology(inner, `ws-${a}`, [`tab-${a}`], [{ pane_id: `pane-${a}`, tab_id: `tab-${a}` }]);
		stubTopology(
			inner,
			`ws-${b}`,
			[`tab-${b}`, "tab-foreign"],
			[{ pane_id: `pane-${b}`, tab_id: `tab-${b}` }],
		);
		stubTopology(
			inner,
			`ws-${c}`,
			[`tab-${c}`],
			[
				{ pane_id: `pane-${c}`, tab_id: `tab-${c}` },
				{ pane_id: "pane-foreign", tab_id: `tab-${c}` },
			],
		);
		// The close verifies each Agent's identity before it takes anything
		// down, so the list holds all three at their recorded panes.
		const runner = new ConsultationRunner(
			inner,
			agentListJson([
				{ pane: `pane-${a}`, status: "idle" },
				{ pane: `pane-${b}`, status: "idle" },
				{ pane: `pane-${c}`, status: "idle" },
			]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					const closedIds: string[] = [];
					for (let i = 0; i < 3; i += 1) {
						const selected = await awaitFrame(
							setup,
							(f) => /Agent: pi \(consultation-[0-9a-f]{8}\)/.test(detailPaneText(f)),
							`a working Consultation ${i + 1} of 3 to be selected`,
						);
						const id8 = detailPaneText(selected).match(
							/Agent: pi \(consultation-([0-9a-f]{8})\)/,
						)?.[1];
						if (id8 === undefined) throw new Error("no Consultation agent selected");
						if (i === 0) {
							const current = state
								.consultations("open")
								.find((item) => item.id.slice(0, 8) === id8);
							if (current === undefined) throw new Error(`no record for ${id8}`);
							// The confirmation names the live Agent and the work the
							// close keeps; a cancel leaves the state unchanged.
							await openConsultationPanel(setup, "w", "the close confirmation", (f) =>
								f.includes("Close Consultation"),
							);
							const dialog = await settle(setup);
							expect(dialog).toContain(
								current.state === "opening" ? "The Agent is still opening" : "The Agent is working",
							);
							expect(dialog).toContain("Close stops the Agent. The worktree and branch stay.");
							await press(
								setup,
								"escape",
								"the panel to close",
								(f) => !f.includes("Close Consultation"),
							);
							expect(state.consultation(current.id)?.state).toBe(current.state);
							// Reopen the dialog for the confirm.
							await openConsultationPanel(setup, "w", "the close confirmation", (f) =>
								f.includes("Close Consultation"),
							);
						} else {
							await openConsultationPanel(setup, "w", "the close panel", (f) =>
								f.includes("Close Consultation"),
							);
						}
						await confirmPanel(setup, `the close status for ${id8}`, (f) =>
							f.includes(`${id8} closed`),
						);
						closedIds.push(id8);
					}
					expect(closedIds.sort()).toEqual([a, b, c].sort());
					const commands = runner.commands();
					expect(commands).toContain(`herdr workspace close ws-${a}`);
					expect(commands).toContain(`herdr tab close tab-${b}`);
					expect(commands).toContain(`herdr pane close pane-${c}`);
					// The cleanup never deletes a Consultation worktree or branch.
					expect(commands.join("\n")).not.toContain("worktree remove");
					expect(commands.join("\n")).not.toContain("branch -D");
					for (const id of [CLOSE_A_ID, CLOSE_B_ID, CLOSE_C_ID]) {
						expect(state.consultation(id)?.state).toBe("closed");
						const retained = state
							.consultationResources(id)
							.filter((resource) => resource.kind === "worktree");
						expect(retained).toHaveLength(1);
						expect(retained[0]).toMatchObject({ owned: false });
						expect(retained[0].details).toContain("retained after close");
					}
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("a failed cleanup recovers through the force-close panel", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, FORCE_ID);
		seedResources(state, FORCE_ID);
		const short = FORCE_ID.slice(0, 8);
		const inner = new FakeRunner();
		stubPaneReadText(inner, `pane-${short}`, "Agent: closing output");
		stubTopology(
			inner,
			`ws-${short}`,
			[`tab-${short}`],
			[{ pane_id: `pane-${short}`, tab_id: `tab-${short}` }],
		);
		inner.set("herdr", ["workspace", "close", `ws-${short}`], {
			code: 1,
			stderr: "refused\n",
		});
		// The close verifies the Agent's identity before it takes the workspace
		// down, so the list holds the record's Agent at its recorded pane.
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: `pane-${short}`, status: "idle" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await openConsultationPanel(setup, "w", "the close panel", (f) =>
						f.includes("Close Consultation"),
					);
					await confirmPanel(setup, "the failed cleanup status", (f) =>
						f.includes("close needs recovery: refused"),
					);
					expect(state.consultation(FORCE_ID)?.state).toBe("closing");
					// Retry offers force-close once the cleanup is stuck.
					await openConsultationPanel(setup, "w", "the recovery close panel", (f) =>
						f.includes("Close Consultation"),
					);
					await pressArrow(setup, "down", "the force-close action to be selected", (f) =>
						f.includes("Force-close"),
					);
					await confirmPanel(setup, "the force-close confirmation", (f) =>
						f.includes("Force-close Consultation"),
					);
					await pressEnter(setup, "the force-close status", (f) =>
						f.includes("force-closed; recovery resources remain recorded"),
					);
					// The closed record moves out of the open history.
					const frame = await press(setup, "f", "the closed detail", (f) =>
						f.includes("Close result: force-closed"),
					);
					expect(frameText(frame)).toContain("Remaining resources");
					expect(frameText(frame)).toContain(`workspace ws-${short}`);
					const remaining = state.consultationRemainingResources(FORCE_ID);
					expect(remaining.map((resource) => resource.kind).sort()).toEqual([
						"agent",
						"pane",
						"tab",
						"workspace",
					]);
					// The worktree survives the force close: retained, never deleted.
					const worktrees = state
						.consultationResources(FORCE_ID)
						.filter((resource) => resource.kind === "worktree");
					expect(worktrees[0]).toMatchObject({ owned: false });
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("a missing or a failed Consultation closes directly, without a dialog", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Neither record holds an Agent, so the close has nothing to confirm.
		seed(state, MISSING_DIRECT_ID, false);
		seed(state, FAILED_DIRECT_ID, false);
		state.setConsultationState(MISSING_DIRECT_ID, "missing", "the Agent pane is gone");
		state.setConsultationState(FAILED_DIRECT_ID, "failed", "herdr refused the launch");
		const missing8 = MISSING_DIRECT_ID.slice(0, 8);
		const failed8 = FAILED_DIRECT_ID.slice(0, 8);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					const closed = (frame: string) =>
						messageRowOf(frame).includes(`${missing8} closed`) ||
						messageRowOf(frame).includes(`${failed8} closed`);
					// The first row closes the moment the key lands: no dialog
					// stands between the key and the result.
					await press(setup, "w", "the direct close", closed);
					// The closed row leaves the open list, so the cursor holds the
					// other one: it closes directly the same way.
					const otherMissing = state.consultation(MISSING_DIRECT_ID)?.state === "closed";
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes(`State: ${otherMissing ? "failed" : "missing"}`),
						"the other Consultation under the cursor",
					);
					const frame = await press(setup, "w", "the second direct close", (f) =>
						messageRowOf(f).includes(`${otherMissing ? failed8 : missing8} closed`),
					);
					expect(state.consultation(MISSING_DIRECT_ID)?.state).toBe("closed");
					expect(state.consultation(FAILED_DIRECT_ID)?.state).toBe("closed");
					expect(frame).not.toContain("Close Consultation");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("w on a closed Consultation refuses readably", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, CLOSED_DIRECT_ID);
		state.settleConsultationTurn(CLOSED_DIRECT_ID, null, "done", "idle");
		state.beginConsultationClose(CLOSED_DIRECT_ID);
		state.finishConsultationClose(CLOSED_DIRECT_ID);
		const runner = new ConsultationRunner(new FakeRunner(), agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					await press(setup, "f", "the closed history filter", (f) => f.includes("State: closed"));
					await press(setup, "w", "the close refusal", (f) =>
						f.includes("the selected Consultation is already closed"),
					);
					expect(state.consultation(CLOSED_DIRECT_ID)?.state).toBe("closed");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("the close confirmation lets go of the keys when the Agent dies first", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, CONFIRM_GONE_ID);
		state.setConsultationState(CONFIRM_GONE_ID, "working");
		const gone8 = CONFIRM_GONE_ID.slice(0, 8);
		// The Agent is alive at first: the observation loop matches its pane,
		// so the Consultation stays working until the list loses it.
		const inner = new FakeRunner();
		// The workspace of the dead Agent holds the Consultation's own tab and
		// pane alone, so the direct close takes the pane down and finishes.
		inner.set("herdr", ["tab", "list", "--workspace", `ws-${gone8}`], {
			stdout: JSON.stringify({ result: { tabs: [{ tab_id: `tab-${gone8}` }] } }),
		});
		inner.set("herdr", ["pane", "list", "--workspace", `ws-${gone8}`], {
			stdout: JSON.stringify({
				result: { panes: [{ pane_id: `pane-${gone8}`, tab_id: `tab-${gone8}` }] },
			}),
		});
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: `pane-${gone8}`, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					// The live Agent asks first: the confirmation stands open.
					await openConsultationPanel(setup, "w", "the close confirmation", (f) =>
						f.includes("Close Consultation"),
					);
					// A refresh finds the Agent gone while the dialog is open, so
					// neither close branch draws any more and the panel must let go
					// of the keys it took.
					runner.agentListJson = agentListJson([]);
					// The release names its reason on the Message line: the record
					// moved out of the states the panel draws, so the panel stood
					// down instead of holding keys with nothing to show.
					const released = await awaitFrame(
						setup,
						(f) =>
							messageRowOf(f).includes("the Consultation moved to missing; the close panel closed"),
						"the release reason on the Message line",
					);
					expect(detailPaneText(released)).toContain("State: missing");
					// A missing Consultation closes directly: the key reaches the
					// section, so no invisible panel was holding it.
					await press(setup, "w", "the direct close after the panel let go", (f) =>
						messageRowOf(f).includes(`${gone8} closed`),
					);
					expect(state.consultation(CONFIRM_GONE_ID)?.state).toBe("closed");
				},
				WIDTH,
				32,
				// The observation loop runs only on the real projection, so this
				// boot carries no initialTickets, like the settle test above.
				{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation geometry, privacy, and history through the UI", () => {
	test("a narrow terminal keeps the Consultation list beside the detail", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const inner = new FakeRunner();
		stubPaneReadText(inner, `pane-${WORKING_ID.slice(0, 8)}`, "Agent: working");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the narrow consultations view", (f) =>
						f.includes("grill - acme/factory"),
					);
					const frame = setup.captureCharFrame();
					// The dual layout holds at narrow width: the Consultation
					// list stays visible beside the detail.
					expect(frame).toContain("┌─❯ Consultations");
					expect(frameText(frame)).toContain("State: working");
					const crossed = await crossToTickets(setup);
					// The shared detail pane follows the cursor to the Ticket side.
					expect(frameText(crossed)).toContain("no ticket selected");
					expect(crossed).toContain("┌─❯ Tickets");
				},
				70,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("consultation history stays out of the ticket view and delete removes it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, CLOSED_ID);
		state.settleConsultationTurn(CLOSED_ID, null, "secret output", "idle");
		state.beginConsultationClose(CLOSED_ID);
		state.finishConsultationClose(CLOSED_ID);
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					// The ticket view never shows Consultation content.
					const tickets = await awaitFrame(
						setup,
						(f) => f.includes("no ticket sources configured"),
						"the ticket view",
					);
					expect(frameText(tickets)).not.toContain("secret output");
					// The closed Consultation is hidden from the open history by default.
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					// The closed history is reachable from the history cycle.
					await press(setup, "f", "the closed history filter", (f) => f.includes("State: closed"));
					const detail = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("secret output"),
						"the captured history",
					);
					expect(detailPaneText(detail)).toContain("Input 2026-09-01 10:00: review auth");
					// Delete removes the local history.
					await openConsultationPanel(setup, "d", "the delete panel", (f) =>
						f.includes("Delete Consultation"),
					);
					await pressEnter(setup, "the empty closed history", (f) =>
						f.includes("no closed Consultations"),
					);
					expect(state.consultation(CLOSED_ID)).toBeUndefined();
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation attention through the UI", () => {
	test("a newly settled turn rings once, and the startup reconciliation never rings", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: answer one");
		// The startup cycle finds the Agent still working: nothing settles.
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "working", seq: 1 }]),
		);
		const bells = countBells();
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: working"),
					);
					// One observation cycle already ran and saw the Agent working.
					await awaitFrame(
						setup,
						(f) => f.includes("Agent status: working"),
						"the observed Agent status",
					);
					expect(bells.count()).toBe(0);
					// The first newly settled turn rings exactly once.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 1 }]);
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the settled turn",
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
					// The Agent resumes work: the external turn reopens the cycle.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "working", seq: 2 }]);
					await awaitFrame(setup, (f) => f.includes("State: working"), "the reopened turn");
					await sleep(150);
					expect(bells.count()).toBe(1);
					// The second newly settled turn rings once more.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 3 }]);
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the second settled turn",
					);
					await sleep(150);
					expect(bells.count()).toBe(2);
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			bells.restore();
			state.close();
		}
	});

	test("a settle found by the startup reconciliation rings no bell", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: answer one");
		// The startup cycle finds the Agent already settled.
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "idle", seq: 1 }]),
		);
		const bells = countBells();
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view with the settled state", (f) =>
						f.includes("State: awaiting-response"),
					);
					await sleep(200);
					expect(bells.count()).toBe(0);
					// A later newly settled turn still rings.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "working", seq: 2 }]);
					await awaitFrame(setup, (f) => f.includes("State: working"), "the reopened turn");
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 3 }]);
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the second settled turn",
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			bells.restore();
			state.close();
		}
	});

	test("the cross takes the first Consultation row, and awaiting response wins", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// Creation order is future-dated so the wall-clock stamps of the state
		// transitions (now) stay older than every seeded created_at.
		const t = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
		seed(state, FAILED_ID, false, t(1));
		state.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		await sleep(20);
		seed(state, MISSING_ID, true, t(3));
		state.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		seed(state, OPENING_ID, false, t(2));
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					// Attention order puts the missing Agent above the failed
					// launch, and the cursor starts on the Consultation list
					// retained row: one step up is a boundary no-op.
					await crossToConsultations(setup);
					const first = await settle(setup);
					expect(detailPaneText(first)).toContain("State: missing");
					expect(frameText(first)).toContain("Warning: the Agent pane is gone");
					// An awaiting response always wins the top row. The boot props
					// hold the observation off, so the Refresh key re-projects the
					// list; the new row takes the top and the cursor follows its
					// retained row. One more step up takes it.
					seed(state, AWAITING_ID, true, t(4));
					state.settleConsultationTurn(AWAITING_ID, null, "answer", "idle");
					setup.mockInput.pressKey("r");
					await awaitFrame(setup, (f) => f.includes("awaiting response: 1"), "the awaiting row");
					// The Refresh re-projection keeps the cursor on its retained
					// row; the list key returns it to the retained row of the
					// re-sorted list, and one step up takes the new first row.
					await press(
						setup,
						"h",
						"the Consultation list",
						(f) =>
							!f.includes("\u250c\u2500\u276f Tickets") &&
							f.includes("\u250c\u2500\u276f Consultations"),
					);
					const selected = await press(setup, "k", "the awaiting detail", (f) =>
						detailPaneText(f).includes("State: awaiting-response"),
					);
					expect(detailPaneText(selected)).toContain("State: awaiting-response");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});

	test("a Consultation that needs the operator adds no row to the compact frame", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, AWAITING_ID, true);
		state.settleConsultationTurn(AWAITING_ID, null, "answer", "idle");
		const paneId = `pane-${AWAITING_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: waiting");
		const runner = new ConsultationRunner(inner, agentListJson([{ pane: paneId, status: "idle" }]));
		try {
			await withApp(
				async (setup) => {
					// Normal size, tickets view: the attention line is reserved
					// and rendered.
					const normal = await awaitFrame(
						setup,
						(f) => f.includes("awaiting response: 1"),
						"the attention line in the tickets view",
					);
					expect(normal).toContain("recovery: 0");

					// Below the minimum size the compact frame keeps exactly its
					// reserved rows: the attention line adds none of them.
					setup.resize(25, 10);
					const rows = rowsOf(await settle(setup));
					expect(rows.length).toBe(10);
					for (const row of rows) expect(widthOf(row)).toBe(25);
					expect(rows[1]).toContain("Terminal too small");
					expect(rows.join("\n")).not.toContain("awaiting response");
				},
				WIDTH,
				32,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation live-worktree launch through the UI", () => {
	test("an existing checkout workspace receives the Consultation in a fresh tab", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, false);
		stubLiveLaunchExisting(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: live answer");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[
							"herdr workspace list",
							`herdr tab create --workspace ws-live --cwd ${checkout} --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the live launch sequence",
					);
					const commands = runner.commands();
					const listAt = commands.indexOf("herdr workspace list");
					const tabAt = commands.findIndex((c) => c.startsWith("herdr tab create"));
					const startAt = commands.findIndex((c) => c.startsWith("herdr agent start"));
					const promptAt = commands.findIndex((c) => c.startsWith("herdr agent prompt"));
					expect(listAt).toBeGreaterThan(-1);
					expect(tabAt).toBeGreaterThan(listAt);
					expect(startAt).toBeGreaterThan(tabAt);
					expect(promptAt).toBeGreaterThan(startAt);
					// The existing workspace is reused, never recreated.
					expect(commands.join("\n")).not.toContain("workspace create");
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.paneId).toBe("pane-c1");
					expect(consultation.workspaceId).toBe("ws-live");
				},
				WIDTH,
				32,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});

	test("a Consultation type's context window rides on its agent start", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, false);
		stubLiveLaunchExisting(inner);
		// The count is part of the argv, so the stub that answers the start
		// names it: a Consultation that loses its context window never reaches
		// this answer and the launch below fails.
		inner.set(
			"herdr",
			["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-c1", "--", "--context", "131072"],
			{ stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }) },
		);
		stubPaneReadText(inner, "pane-c1", "Agent: live answer");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		const config: FactoryConfig = {
			...liveConfigFor(),
			agents: {
				...BASE_CONFIG.agents,
				pi: { ...BASE_CONFIG.agents.pi, contextWindow: "--context {value}" },
			},
			consultationTypes: {
				"grill-live": {
					agent: "pi",
					environment: "live-worktree",
					template: "/grill {input}",
					contextWindow: "131072",
				},
			},
		};
		try {
			await withApp(
				async (setup) => {
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[`herdr agent start ${AGENT} --kind pi --pane pane-c1 -- --context 131072`],
						"the live start with the count",
					);
					// The record keeps the count the Agent started with, so a
					// Restart of this Consultation keeps the room it ran in.
					const [consultation] = state.consultations("open");
					expect(consultation.contextWindow).toBe("131072");
				},
				WIDTH,
				32,
				{ state, runner, config, home },
			);
		} finally {
			state.close();
		}
	});

	test("a missing checkout workspace is created and uses its root pane", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, false);
		stubLiveLaunchNew(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: live answer");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					const commands = runner.commands();
					const listAt = commands.indexOf("herdr workspace list");
					const createAt = commands.findIndex((c) => c.startsWith("herdr workspace create"));
					const startAt = commands.findIndex((c) => c.startsWith("herdr agent start"));
					const promptAt = commands.findIndex((c) => c.startsWith("herdr agent prompt"));
					expect(listAt).toBeGreaterThan(-1);
					expect(createAt).toBeGreaterThan(listAt);
					expect(startAt).toBeGreaterThan(createAt);
					expect(promptAt).toBeGreaterThan(startAt);
					expect(commands).toContain(`herdr workspace create --cwd ${checkout} --no-focus`);
					// No empty tab: the Agent takes the workspace root pane.
					expect(commands.join("\n")).not.toContain("tab create");
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.paneId).toBe("pane-c1");
					expect(consultation.workspaceId).toBe("ws-new");
				},
				WIDTH,
				32,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});

	test("a live checkout conflict blocks the launch until one explicit confirm", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, false);
		stubLiveLaunchExisting(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: live answer");
		// A Herdr agent already works in this exact checkout.
		const conflictList = JSON.stringify({
			result: {
				agents: [
					{
						pane_id: "pane-herdr",
						tab_id: "tab-herdr",
						workspace_id: "ws-herdr",
						agent: "pi",
						agent_status: "working",
						checkout_path: checkout,
					},
				],
			},
		});
		const runner = new ConsultationRunner(inner, conflictList);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					const panel = await awaitFrame(
						setup,
						(f) => f.includes("Live checkout conflict"),
						"the live checkout conflict panel",
					);
					expect(frameText(panel)).toContain("Conflict: Herdr Agent pi (pane-herdr)");
					expect(frameText(panel)).toContain("Confirm once to share this live checkout");
					// The Agent never starts while the panel is up.
					expect(runner.commands().join("\n")).not.toContain("agent start");
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("opening");
					// Confirm once: the launch proceeds and the override is recorded.
					await pressEnter(setup, "the confirmed launch to reach working", (f) =>
						f.includes("State: working"),
					);
					await waitForCommands(
						runner,
						[
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the confirmed launch sequence",
					);
					expect(state.consultation(consultation.id)).toMatchObject({ state: "working" });
					// The confirmation belongs to the checkout, not to the opening.
					expect(state.confirmedCheckoutConflicts(realpathSync(checkout))).toContain("pane-herdr");
				},
				WIDTH,
				32,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0049 puts the Consultation's hard checks at the Work queue's enqueue:
	 * the type still exists and its settings fit, so a start the config cannot
	 * run never takes a queue row. The unfit Model therefore leaves no record at
	 * all - the ask refuses, its reason stands on the Message line, and the
	 * launcher keeps the operator's form for the fix. The check also runs ahead
	 * of the route's first external change: a live launch resolves its
	 * Repository, and a resolve clones a missing checkout. None of that runs
	 * behind an unfit setting. Story 6's `failed` record stays the pickup's own
	 * answer: the start re-reads the same fit on the record it took, and
	 * "a pickup whose start fails leaves the record failed with its reason"
	 * walks it at the operations seam.
	 */
	test("an unfit Model refuses the submit before the record or any external step", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, false);
		stubLiveLaunchExisting(inner);
		// pi reports a list the Consultation type's Model is not in.
		inner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const runner = new ConsultationRunner(inner, agentListJson([]));
		const config: FactoryConfig = {
			...liveConfigFor(),
			consultationTypes: {
				"grill-live": {
					agent: "pi",
					environment: "live-worktree",
					model: "openai/gpt-4o",
					template: "/grill {input}",
				},
			},
		};
		// The reads that resolve one Repository: the launcher makes them to
		// verify its option.
		const resolveReads = () =>
			runner.commands().filter((command) => command.includes("rev-parse --git-dir")).length;
		try {
			await withApp(
				async (setup) => {
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					const readsBeforeLaunch = resolveReads();
					await launchConsultationDraft(setup, "review auth");
					const refused = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation not queued"),
						"the enqueue's refusal",
					);
					expect(messageRowOf(refused)).toContain('has no model "openai/gpt-4o"');
					// No record and no queue item: the ask never entered the channel.
					expect(state.consultations("all")).toEqual([]);
					expect(state.workQueue()).toEqual([]);
					// The launcher stayed open with the operator's form for the fix.
					expect(frameText(refused)).toContain("Consultation launcher");
					const joined = runner.commands().join("\n");
					expect(resolveReads()).toBe(readsBeforeLaunch);
					expect(joined).not.toContain("git clone");
					expect(joined).not.toContain("herdr workspace");
					expect(joined).not.toContain("herdr tab create");
					expect(joined).not.toContain("agent start");
					expect(joined).not.toContain("agent prompt");
					// The ask asks the Agent's CLI once.
					expect(inner.modelListCalls).toEqual(["pi"]);
				},
				WIDTH,
				32,
				{ state, runner, config, home },
			);
		} finally {
			state.close();
		}
	});

	test("a dirty live checkout warns but never blocks the launch", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubLiveCheckout(inner, true);
		stubLiveLaunchNew(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: live answer");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					expect(frameText(setup.captureCharFrame())).not.toContain("Live checkout conflict");
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.warning).toBe("the live checkout has uncommitted changes");
				},
				WIDTH,
				32,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});

	test("a live-worktree close confirms and names the checkout that stays", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// The live Consultation works in the operator's own checkout, so the
		// confirmation names the checkout as the resource the close keeps,
		// not the worktree and branch a worktree Consultation keeps.
		seed(state, LIVE_CLOSE_ID, true, "2026-09-01T10:00:00.000Z", "", "live-worktree");
		state.setConsultationState(LIVE_CLOSE_ID, "working");
		// The Agent is alive at the recorded pane: the observation loop keeps
		// the record working while the dialog stands.
		const runner = new ConsultationRunner(
			new FakeRunner(),
			agentListJson([{ pane: `pane-${LIVE_CLOSE_ID.slice(0, 8)}`, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					// The live Agent asks first: the confirmation names the Agent
					// that is alive and the checkout the close keeps.
					await openConsultationPanel(setup, "w", "the close confirmation", (f) =>
						f.includes("Close Consultation"),
					);
					const dialog = await settle(setup);
					expect(dialog).toContain("The Agent is working");
					expect(dialog).toContain("Close stops the Agent. The checkout stays.");
					expect(dialog).toContain("stop the Agent; the checkout stays");
					// A cancel leaves the state unchanged.
					await press(
						setup,
						"escape",
						"the panel to close",
						(f) => !f.includes("Close Consultation"),
					);
					expect(state.consultation(LIVE_CLOSE_ID)?.state).toBe("working");
				},
				WIDTH,
				32,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation response gating by observed Agent status", () => {
	test("a blocked Agent takes Enter into interaction, with the exit key shown first", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, INTERACTION_ID);
		state.settleConsultationTurn(INTERACTION_ID, null, "first answer", "blocked");
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: blocked on approval");
		stubPaneReadAnsi(inner, paneId, "agent: waiting for input");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "blocked" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The observed blocked status re-points the hints, and the
					// configured exit key is visible before any input is forwarded.
					const bar = await awaitFrame(
						setup,
						(f) => frameText(f).includes("Enter Interact"),
						"the blocked Agent hints",
					);
					expect(frameText(bar)).toContain("Enter Interact");
					await pressEnter(setup, "interaction mode, not the response editor", (f) =>
						f.includes("F12 Exit interaction"),
					);
					// Agent interaction owns keyboard and mouse input. A header
					// click must not move the cursor to the other section.
					await mouseClick(setup, 10, 1);
					const stillConsultations = await settle(setup);
					expect(stillConsultations).toContain("▾ Consultations");
					expect(stillConsultations).toContain("▾ Tickets");
					expect(stillConsultations).not.toContain("\u250c\u2500\u276f Tickets");
					// No input is forwarded until the operator sends keys.
					expect(runner.commands().join("\n")).not.toContain("send-text");
					expect(runner.commands().join("\n")).not.toContain("send-keys");
					await pressF12(setup, "the exit from interaction mode", (f) =>
						f.includes("left Agent interaction mode"),
					);
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});

	test("an unblocked Agent keeps the response editor after a blocked turn", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, INTERACTION_ID);
		// The last settled turn was blocked, but the Agent itself is idle now.
		state.settleConsultationTurn(INTERACTION_ID, null, "first answer", "blocked");
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: now idle");
		const runner = new ConsultationRunner(inner, agentListJson([{ pane: paneId, status: "idle" }]));
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The gate is the observed status, not the last settled turn.
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("Enter Respond"),
						"the idle Agent hints",
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("Response draft"));
					// The response editor owns mouse input too. A pane click must not
					// move focus behind it, which would change the next base mode when
					// the editor closes.
					await mouseClick(setup, 80, 5);
					await settle(setup);
					const afterEditor = await press(
						setup,
						"escape",
						"the response editor to close",
						(f) => !f.includes("Response draft"),
					);
					expect(afterEditor).toContain("┌─❯ Consultations");
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});

	test("a forwarded input re-reads the pane before the next refresh tick", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, INTERACTION_ID);
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: working");
		stubPaneReadAnsi(inner, paneId, "agent: typing...");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: working"),
					);
					await pressEnter(setup, "interaction mode with its exit key", (f) =>
						f.includes("F12 Exit interaction"),
					);
					const ansiReads = () =>
						runner.commands().filter((c) => c.includes("--format ansi")).length;
					// The mount read plus one 250 ms tick: the timer is in phase.
					await waitFor(() => ansiReads() >= 2, "the first interval refresh");
					setup.mockInput.pressKey("h");
					await waitForCommands(runner, [`herdr pane send-text ${paneId} h`], "the forwarded key");
					const sentAt = Date.now();
					// The input must not wait for the next 250 ms tick: a new
					// read arrives well before it could.
					while (ansiReads() < 3 && Date.now() - sentAt < 150) await sleep(5);
					expect(ansiReads()).toBeGreaterThanOrEqual(3);
					await pressF12(setup, "the exit from interaction mode", (f) =>
						f.includes("left Agent interaction mode"),
					);
				},
				WIDTH,
				32,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});
});

const interactionExitCases = [
	{
		name: "ctrl+e",
		config: "ctrl+e" as const,
		label: "Ctrl+E",
		send: (setup: Setup) => setup.mockInput.pressKey("e", { ctrl: true }),
	},
	{
		name: "f13",
		config: "f13" as const,
		label: "F13",
		// The mock helper exposes F1-F12 only; send Kitty's F13 code through
		// the same renderer parser used by the production terminal.
		send: (setup: Setup) => setup.mockInput.pressKey("\u001b[57376u"),
	},
] as const;

for (const exitCase of interactionExitCases) {
	test(`the configured ${exitCase.name} exits Agent interaction end to end`, async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, INTERACTION_ID);
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubPaneReadText(inner, paneId, "Agent: working");
		stubPaneReadAnsi(inner, paneId, "agent: waiting for input");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the Consultation section", (f) =>
						f.includes("State: working"),
					);
					await pressEnter(setup, "Agent interaction mode", (f) =>
						f.includes(`${exitCase.label} Exit interaction`),
					);
					exitCase.send(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("left Agent interaction mode"),
						"the interaction exit",
					);
					expect(runner.commands().join("\n")).not.toContain("send-text");
				},
				WIDTH,
				32,
				{ state, runner, config: { ...configFor(), interactionExitKey: exitCase.config }, home },
				{ kittyKeyboard: true },
			);
		} finally {
			state.close();
		}
	});
}

describe("The full Consultation operator flow", () => {
	test("launch, settle, respond, blocked interaction, settle, close, and inspect the history", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: answer one");
		stubPaneReadAnsi(inner, "pane-c1", "agent: typing...");
		stubTopology(inner, "ws-new", ["tab-ws-new"], [{ pane_id: "pane-c1", tab_id: "tab-ws-new" }]);
		inner.set("herdr", ["agent", "prompt", AGENT, "answer one"], { code: 0 });
		inner.set("herdr", ["workspace", "close", "ws-new"], { code: 0 });
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ ...launchedAgent, status: "working", seq: 1 }]),
		);
		const bells = countBells();
		try {
			await withApp(
				async (setup) => {
					// Launch.
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					const id = state.consultations("open")[0].id;
					// The opening turn settles and rings.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "idle", seq: 1 }]);
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the settled opening turn",
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
					// a is a Ticket-section control, so it is inert in Consultations.
					setup.mockInput.pressKey("a");
					expect((await settle(setup)).match(/auto: on/g)).toBeNull();
					// The Agent is idle: Enter opens the response editor.
					await pressEnter(setup, "the response editor", (f) => f.includes("Response draft"));
					setup.mockInput.typeText("answer one");
					await sendResponseDraft(setup);
					await awaitFrame(setup, (f) => f.includes("State: working"), "the working state");
					await waitForCommands(
						runner,
						[`herdr agent prompt ${AGENT} answer one`],
						"the response prompt",
					);
					// The Agent goes blocked: the settled turn takes its status.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "blocked", seq: 2 }]);
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the blocked settled turn",
					);
					expect(state.consultationTurns(id).at(-1)?.settledStatus).toBe("blocked");
					// Enter now opens interaction, not the response editor.
					await pressEnter(setup, "the blocked interaction mode", (f) =>
						f.includes("F12 Exit interaction"),
					);
					setup.mockInput.pressKey("h");
					await waitForCommands(runner, [`herdr pane send-text pane-c1 h`], "the forwarded key");
					await pressF12(setup, "the exit from interaction mode", (f) =>
						f.includes("left Agent interaction mode"),
					);
					// The Agent finishes on its own: the external turn opens and
					// settles, and rings once more.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "idle", seq: 3 }]);
					await waitFor(
						() =>
							state.consultationTurns(id).length === 3 &&
							state.consultationTurns(id).at(-1)?.settledAt !== null,
						"the external turn to settle",
					);
					expect(state.consultation(id)?.state).toBe("awaiting-response");
					expect(bells.count()).toBe(3);
					// Close stops the live Agent, so the confirmation asks first;
					// the confirm takes down the owned workspace.
					await openConsultationPanel(setup, "w", "the close confirmation", (f) =>
						f.includes("Close Consultation"),
					);
					// The awaiting-response state names the Agent that answered and
					// now waits, and the body keeps the worktree and branch.
					const dialog = await settle(setup);
					expect(dialog).toContain("The Agent has answered and is waiting for your reply");
					expect(dialog).toContain("Close stops the Agent. The worktree and branch stay.");
					expect(dialog).toContain("stop the Agent; the work stays");
					await confirmPanel(setup, "the closing status", (f) =>
						f.includes(`${id.slice(0, 8)} closed`),
					);
					await waitForCommands(runner, ["herdr workspace close ws-new"], "the workspace cleanup");
					expect(state.consultation(id)?.state).toBe("closed");
					// The captured history keeps every turn in order.
					await press(setup, "f", "the closed history", (f) => f.includes("State: closed"));
					const detail = await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Captured history:"),
						"the captured history",
					);
					const history = detailPaneText(detail);
					expect(history).toContain("review auth");
					expect(history).toContain("answer one");
					expect(history).toContain("[external Agent input not captured]");
					expect(history).toContain("Agent: answer one");
				},
				WIDTH,
				30,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			bells.restore();
			state.close();
		}
	});

	test("a launch stays on the launched Consultation, not on older attention", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// An older Consultation already needs the operator. The launch must
		// not jump the view onto it: the operator is watching the one it
		// just created.
		const t = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
		seed(state, MISSING_ID, true, t(1));
		state.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: answer one");
		inner.set("herdr", ["agent", "prompt", AGENT, "answer one"], { code: 0 });
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ ...launchedAgent, status: "working", seq: 1 }]),
		);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("State: working"),
						"the launched Consultation working",
					);
					expect(detailPaneText(frame)).toContain("State: working");
					expect(detailPaneText(frame)).not.toContain("State: missing");
				},
				WIDTH,
				30,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});

	test("a settling refresh cannot clear the Consultation's progress line", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const ticketSource = { name: "tickets", kind: "github-issues" };
		const sourceConfig = {
			name: "tickets",
			kind: "github-issues" as const,
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		};
		const outcome = {
			status: "success" as const,
			fetchedAt: "2026-09-01T10:00:00.000Z",
			tickets: [],
		};
		state.initializeSources([ticketSource]);
		state.applyFetch(ticketSource, outcome);
		const source = new FakeSource(ticketSource.name, ticketSource.kind, outcome);
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		// The Consultation's own herdr command never answers, so the Consultation
		// stays in flight and its progress line holds the Message line. The
		// source's refresh runs on its own, so the two operations overlap.
		const runner = new GatedRunner(
			new ConsultationRunner(inner, agentListJson([])),
			(command, args) =>
				command === "herdr" && args.includes("worktree") && args.includes("create"),
		);
		try {
			await withApp(
				async (setup) => {
					// The deterministic tickets keep the
					// observation loop off. The mount fetch answers with an
					// empty list, so the manual refresh below has an idle
					// source to start.
					source.settle(outcome);
					await awaitFrame(
						setup,
						(f) => f.includes("no tickets match the configured sources"),
						"the answered mount fetch",
					);
					await toConsultations(setup, "the Consultation section", (f) =>
						f.includes("no open Consultations"),
					);
					await openLauncher(setup);
					await launchConsultationDraft(setup, "review auth");
					// The launch proceeds: the Consultation holds the shared
					// detail, which stays up while the refresh runs beside it.
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("State: opening"),
						"the Consultation detail",
					);
					// The refresh runs from the Ticket list: on the
					// Consultation list, the opening row would take `r` as
					// its recovery key. The launch command stays in flight
					// on its own progress owner.
					await crossToTickets(setup);
					setup.mockInput.pressKey("r");
					const refreshing = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("refreshing 1 sources"),
						"the refresh progress",
					);
					expect(messageRowOf(refreshing)).toContain("refreshing 1 sources");
					source.settle(outcome);
					// Its settle must not leave the line with the refresh
					// progress: the line returns to the launch progress or
					// goes blank.
					const returned = await awaitFrame(
						setup,
						(f) => !messageRowOf(f).includes("refreshing"),
						"the line without the refresh progress",
					);
					expect(messageRowOf(returned)).not.toContain("refreshing");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), sources: [sourceConfig] },
					home,
					sources: [source],
					pollIntervalMs: 60_000,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});
});

describe("the Consultation detail reads the Agent's session record (ADR 0025)", () => {
	/** Seed the record file the agent list points at. */
	function seedRecord(id: string): { dir: string; path: string } {
		const dir = mkdtempSync(join(tmpdir(), "factory-record-"));
		const path = join(dir, `${id}.jsonl`);
		writeFileSync(
			path,
			[
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "review auth" }] },
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "The design is sound." }] },
				}),
			].join("\n"),
		);
		return { dir, path };
	}

	test("the working detail shows the record's rows, and g focuses the pane without touching the Consultation", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const { dir, path } = seedRecord(WORKING_ID);
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "idle", record: path }]),
		);
		try {
			await withApp(
				async (setup) => {
					// The Session view stands in for the terminal body as soon
					// as the poll names the record and a read renders it.
					await toConsultations(setup, "the Consultation detail with the Session view", (f) =>
						detailPaneText(f).includes("Session view:"),
					);
					const detail = detailPaneText(setup.captureCharFrame());
					expect(detail).toContain("❯ review auth");
					expect(detail).toContain("The design is sound.");
					expect(frameText(setup.captureCharFrame())).toContain("Session view");
					// The Goto hint sits in the Consultation mode's action bar.
					expect(actionBarRowOf(setup.captureCharFrame())).toContain("g Goto");
					// The observation settles the turn on its own; the Session
					// view stays the body while the Consultation rests.
					await awaitFrame(
						setup,
						(f) => f.includes("State: awaiting-response"),
						"the settled turn",
					);
					// g focuses the pane and reports on the Message line: a
					// navigation, not a Consultation change.
					await press(setup, "g", "the focus notice", (f) =>
						messageRowOf(f).includes("focused the Agent pane"),
					);
					expect(runner.commands()).toContain(`herdr agent focus ${paneId}`);
					expect(state.consultation(WORKING_ID)?.state).toBe("awaiting-response");
					expect(state.pendingConsultationResponse(WORKING_ID)).toBeNull();
				},
				WIDTH,
				32,
				// No initialTickets: the observation loop must poll herdr for
				// the record path, and it stands down on a test projection.
				{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			state.close();
		}
	});

	test("g names the workspace in the focus confirmation so the operator can switch herdr's view", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const short = WORKING_ID.slice(0, 8);
		const paneId = `pane-${short}`;
		const workspaceId = `ws-${short}`;
		const label = "factory-consultation-11111111";
		const { dir, path } = seedRecord(WORKING_ID);
		const inner = new FakeRunner();
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "idle", record: path }]),
		);
		inner.set("herdr", ["workspace", "get", workspaceId], {
			stdout: workspaceGetJson(workspaceId, label),
		});
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the Consultation detail with the Session view", (f) =>
						detailPaneText(f).includes("Session view:"),
					);
					// g focuses the pane and answers on the Message line as a
					// result, never as a warning. Herdr 0.9 keeps each client's
					// own view, so the line names the workspace the operator
					// switches to.
					const frame = await press(setup, "g", "the focus confirmation", (f) =>
						messageRowOf(f).includes("in workspace"),
					);
					expect(messageRowOf(frame)).toContain(
						`Info: focused the Agent pane for Consultation ${short} in workspace ${label}`,
					);
					expect(runner.commands()).toContain(`herdr agent focus ${paneId}`);
					expect(runner.commands()).toContain(`herdr workspace get ${workspaceId}`);
				},
				WIDTH,
				32,
				// No initialTickets: the observation loop must poll herdr for
				// the record path, and it stands down on a test projection.
				{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			state.close();
		}
	});

	test("a closed Consultation shows its record for the after-the-fact review, and g loses its pane when the poll drops it", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const closedId = uid("9");
		seed(state, closedId);
		state.setConsultationState(closedId, "closed");
		const paneId = `pane-${closedId.slice(0, 8)}`;
		const { dir, path } = seedRecord(closedId);
		const inner = new FakeRunner();
		// herdr still lists the Agent as done, with the record it wrote:
		// the closed detail can read it for the after-the-fact review.
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "done", record: path }]),
		);
		try {
			await withApp(
				async (setup) => {
					// The closed Consultation sits in the closed history.
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("no open Consultations"),
					);
					await press(setup, "f", "the closed history filter", (f) => f.includes("State: closed"));
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Session view:"),
						"the record the closed detail shows",
					);
					const detail = detailPaneText(setup.captureCharFrame());
					expect(detail).toContain("❯ review auth");
					expect(detail).toContain("The design is sound.");
					// The pane leaves the last poll: the detail keeps the
					// record it read, and g answers its reason on the Message
					// line instead of focusing a pane herdr no longer lists.
					runner.agentListJson = agentListJson([]);
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("Agent status: unknown"),
						"the poll without the pane",
					);
					await press(setup, "g", "the Goto reason", (f) =>
						messageRowOf(f).includes("the Agent's pane is not alive in the last poll"),
					);
					expect(runner.commands()).not.toContain(`herdr agent focus ${paneId}`);
				},
				WIDTH,
				32,
				// No initialTickets: the observation loop must poll herdr for
				// the record path, and it stands down on a test projection.
				{ state, runner, config: configFor(), home, pollIntervalMs: 100 },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			state.close();
		}
	});
});

describe("the launcher's Consultation queue at a full cap (ADR 0034, issue #90)", () => {
	/**
	 * The seat the cap tests hold: a working Consultation whose Agent the
	 * poll lists. The Consultation seat is the record's state alone, so it
	 * holds from the boot, and it frees the moment the test moves the
	 * record.
	 */
	const seatId = uid("1");

	test("a launch at the full cap queues the Consultation in the Work queue", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const paneId = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation queued"),
						"the queued notice",
					);
					// The record is durable in `queued` state: the launcher
					// closed it, the Consultation list shows it, and the
					// detail states the wait.
					const queued = state.consultations("all").find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					expect(queued.paneId).toBeNull();
					expect(queued.workspaceId).toBeNull();
					// The Consultation section lists the record under its
					// state word, the same row the cursor selected.
					expect(
						rowsOf(frame).some(
							(row) => row.startsWith("│") && row.includes("queued") && row.includes("grill"),
						),
					).toBe(true);
					expect(detailPaneText(frame)).toContain("State: queued");
					// The Work queue section shows the item under its kind
					// word, and the header carries the depth.
					expect(frame).toContain("waiting: 1");
					expect(
						rowsOf(frame).some(
							(row) => row.includes("consultation") && row.includes(queued.id.slice(0, 8)),
						),
					).toBe(true);
					// The notice names the record and the queue it waits in.
					expect(messageRowOf(frame)).toContain(
						`consultation queued: ${queued.id.slice(0, 8)} waits in the Work queue for a free Parallel limit seat`,
					);
					// The queue holds the item, and the seat count stayed at
					// the cap: the record holds no seat until the pickup.
					const queue = state.workQueue();
					expect(queue).toHaveLength(1);
					expect(queue[0]).toEqual(
						expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
					);
					// The enqueue ran no external step: it is not a start.
					expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
					expect(runner.commands()).not.toContain(expect.stringContaining("agent start"));
				},
				WIDTH,
				32,
				// The test projection holds the seat: no poll can free it or
				// pick the item up out from under the test.
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	/**
	 * ADR 0052: the queue pause holds the drain, a Consultation's item and a
	 * Handoff's alike. The seat stands free here on purpose - the pause, not
	 * the cap, is what holds the pickup - and the submit's own line says so
	 * instead of promising a seat that will not come.
	 */
	test("the queue pause holds a Consultation's item with a free seat, and the submit says why", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		// No seeded Consultation: nothing holds the one seat.
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(inner, agentListJson([]));
		state.setQueuePaused(true);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation queued"),
						"the queued notice",
					);
					const queued = state.consultations("all").find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					// The line names the pause as the reason the item waits, not the
					// cap: the seat is free, and the pickup is what stands down.
					expect(messageRowOf(frame)).toContain(
						`consultation queued: ${queued.id.slice(0, 8)} waits in the Work queue; the queue is paused`,
					);
					expect(messageRowOf(frame)).not.toContain("Parallel limit seat");
					// The Work section carries the item and the pause on its header.
					expect(frame).toContain("waiting: 1");
					expect(frameText(frame)).toContain("paused");
					// And the pause held it: the record is still `queued`, its item
					// still stands, and the enqueue ran no external step.
					expect(state.workQueue()).toEqual([
						expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
					]);
					expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
					expect(runner.commands()).not.toContain(expect.stringContaining("agent start"));
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("key w abandons a queued Consultation and takes its item out of the queue", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const paneId = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: paneId, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation queued"),
						"the queued notice",
					);
					const queued = state.consultations("all").find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					const gone8 = queued.id.slice(0, 8);
					// The cursor stands on the new record: the submit selected it.
					expect(detailPaneText(setup.captureCharFrame())).toContain("State: queued");
					// A queued record holds no Agent to stop, so `w` closes it on the
					// keypress: no confirmation panel, no cleanup command, and its
					// Work queue item goes with the record out of `queued`.
					await press(setup, "w", "the queued Consultation closed", (f) =>
						messageRowOf(f).includes(`${gone8} closed`),
					);
					expect(state.consultation(queued.id)?.state).toBe("closed");
					expect(state.workQueue()).toHaveLength(0);
					expect(runner.commands()).not.toContain(expect.stringContaining("pane close"));
					expect(runner.commands()).not.toContain(expect.stringContaining("workspace close"));
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the pickup at a freed seat starts the queued Consultation", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: opened");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: seatPane, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation queued"),
						"the queued notice",
					);
					const queued = state.consultations("all").find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					// The launched Agent's pane joins the poll's list, so the
					// pickup's start verifies on the next cycle.
					runner.agentListJson = agentListJson([
						{ pane: seatPane, status: "working" },
						{ pane: "pane-c1", status: "working", sess: "sess-c1" },
					]);
					// Free the seat: the record leaves the states that hold one.
					state.setConsultationState(seatId, "awaiting-response");
					// The pickup crosses to the Consultation operations, the
					// start runs the opening pipeline, and the detail settles
					// on the record's new state.
					await awaitFrame(
						setup,
						(f) => detailPaneText(f).includes("State: working"),
						"the picked-up Consultation working",
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the pickup's launch sequence",
					);
					// The item left the queue with the record out of `queued`.
					expect(state.workQueue()).toHaveLength(0);
					expect(queued === undefined ? undefined : state.consultation(queued.id)?.state).toBe(
						"working",
					);
					// The seat freed once: the seed's record rests in
					// awaiting-response and holds none.
					expect(state.consultation(seatId)?.state).toBe("awaiting-response");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					pollIntervalMs: 100,
				},
			);
		} finally {
			state.close();
		}
	});

	test("Enter on the queue item force-dispatches the Consultation over the cap", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: opened");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: seatPane, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					await openLauncher(setup);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await launchConsultationDraft(setup, "review auth");
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("consultation queued"),
						"the queued notice",
					);
					const queued = state.consultations("all").find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					const id8 = queued.id.slice(0, 8);
					// The cap is full from the boot: the seed's seat stands on the
					// line. The frame holds no room for the Work section's rows,
					// so it rests collapsed, and Enter on the queued row jumps to
					// its item and expands the section with it (ADR 0049).
					expect(setup.captureCharFrame()).toContain("auto: off 1/1");
					await press(setup, "return", "the cursor in the Work queue", (f) =>
						f.includes("┌─❯ Work queue"),
					);
					// Enter force-dispatches the item over the full cap: the line
					// names the cap, the seat count stands over the limit, the item
					// leaves the queue, and the start runs the real external steps.
					await press(setup, "return", "the force-dispatch message", (f) =>
						f.includes("force-dispatched"),
					);
					// The line names the cap, and the seat count stands over the
					// limit: the seed's seat plus the start the force-dispatch took.
					await awaitFrame(setup, (f) => f.includes("auto: off 2/1"), "the seat over the cap");
					expect(messageRowOf(setup.captureCharFrame())).toContain(
						`force-dispatched Consultation ${id8} over the Parallel limit`,
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the force-dispatch's launch sequence",
					);
					// The item left the queue with the claim, and the start ran
					// over the cap, not behind the seed's release: the seed's
					// seat stood through the whole of it.
					expect(state.workQueue()).toHaveLength(0);
					expect(state.consultation(queued.id)?.state).not.toBe("queued");
					expect(state.consultation(seatId)?.state).toBe("working");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					// The test projection holds the seat: no poll can free it or
					// pick the item up out from under the test. The projection also
					// keeps the observation loop off the start's Message line: a tick
					// that lands while the record stands in `opening` cannot verify
					// its Agent yet and would clear the start's notice with its
					// recovery warning, so the line the test asserts on stays where
					// the start left it.
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	/**
	 * The shared walk of the unscheduling tests (issue #91): the cap is held
	 * by the seed's seat, the launcher queues the Consultation, the Work
	 * section's cursor lands on the item, and Delete removes it. The item
	 * goes, the record is `unscheduled`, and the cursor crosses to the
	 * Consultation section, where the record keeps standing.
	 */
	async function unscheduleThroughTheQueue(setup: Setup, state: FactoryState): Promise<string> {
		await openLauncher(setup);
		await awaitFrame(setup, (f) => f.includes("acme/factory"), "the verified Repository option");
		await launchConsultationDraft(setup, "review auth");
		await awaitFrame(
			setup,
			(f) => messageRowOf(f).includes("consultation queued"),
			"the queued notice",
		);
		const queued = state.consultations("all").find((c) => c.state === "queued");
		if (queued === undefined) throw new Error("the queued Consultation is not recorded");
		// The frame holds no room for the Work section's rows, so it rests
		// collapsed, and Enter on the queued row jumps to its item and
		// expands the section with it (ADR 0049).
		await press(setup, "return", "the cursor in the Work queue", (f) =>
			f.includes("┌─❯ Work queue"),
		);
		// The item's row stands under the kind word, with the record's identity.
		const frame = setup.captureCharFrame();
		expect(frame).toContain("consultation");
		expect(frame).toContain(queued.id.slice(0, 8));
		// Delete removes the item, not the ask: the record moves to
		// `unscheduled`, and the Message line says both.
		const removed = await press(setup, "delete", "the removal notice", (f) =>
			f.includes("removed from the queue"),
		);
		expect(messageRowOf(removed)).toContain(
			`consultation ${queued.id.slice(0, 8)}: removed from the queue; the record is unscheduled`,
		);
		expect(state.workQueue()).toHaveLength(0);
		expect(state.consultation(queued.id)?.state).toBe("unscheduled");
		// The record keeps standing in the Consultation section: the row
		// carries its state, its type, and its repository.
		await crossToConsultations(setup);
		const section = setup.captureCharFrame();
		expect(section).toContain("unscheduled");
		expect(section).toContain("grill");
		expect(section).toContain("acme/factory");
		// The seed's working record is listed in the section too, and it sorts
		// ahead of the unscheduled ask: the walk steps the cursor down to the
		// unscheduled row, the one every test works on.
		for (let step = 0; step < 10; step += 1) {
			if (detailPaneText(setup.captureCharFrame()).includes("State: unscheduled")) break;
			setup.mockInput.pressKey("j");
			await settle(setup, 200);
		}
		expect(detailPaneText(setup.captureCharFrame())).toContain("State: unscheduled");
		return queued.id;
	}

	test("removing the queue item unschedules the record, and the record keeps standing", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await unscheduleThroughTheQueue(setup, state);
					// The detail reads the ask: the state word, the type beside the
					// repository, and the initial input the launcher gave it.
					const detail = detailPaneText(setup.captureCharFrame());
					expect(detail).toContain("State: unscheduled");
					expect(detail).toContain(`grill - acme/factory`);
					expect(detail).toContain("review auth");
				},
				WIDTH,
				32,
				// The test projection holds the seat: no poll can free it or
				// pick the item up out from under the test.
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation section schedules the unscheduled record back into the queue", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// `s` schedules the record back: it returns to `queued` with
					// its item at the queue's tail, and the line names the place.
					const scheduled = await press(setup, "s", "the schedule notice", (f) =>
						f.includes(`Consultation ${id.slice(0, 8)} scheduled`),
					);
					expect(messageRowOf(scheduled)).toContain(
						`Consultation ${id.slice(0, 8)} scheduled: it waits at the end of the Work queue`,
					);
					expect(state.consultation(id)?.state).toBe("queued");
					expect(state.workQueue().map(workQueueIdentityOf)).toEqual([id]);
					// The queue rows re-read in the same key: the item stands in
					// the Work queue section at the place the line names. The
					// section still stands expanded from the walk, so the
					// cursor's cross down from the section's last row lands on
					// its item.
					const inQueue = await press(setup, "j", "the cursor in the Work queue", (f) =>
						f.includes("┌─❯ Work queue"),
					);
					expect(inQueue).toContain("consultation");
					expect(inQueue).toContain(id.slice(0, 8));
					// The walk back crosses up out of the queue, into the
					// Consultation section's retained row: the record that the
					// walk left under the cursor, now `queued`. The cursor is on
					// the Consultation list only while the Work box title carries
					// no focus marker.
					for (let step = 0; step < 10; step += 1) {
						const frame = setup.captureCharFrame();
						if (frame.includes("┌─❯ Consultations") && !frame.includes("┌─❯ Work queue")) break;
						setup.mockInput.pressKey("k");
						await settle(setup, 200);
					}
					const backFrame = setup.captureCharFrame();
					expect(backFrame).toContain("┌─❯ Consultations");
					expect(backFrame).not.toContain("┌─❯ Work queue");
					// A second `s` says the record already waits: the schedule
					// refuses in the section's words, and the record stands where
					// it stands.
					await press(setup, "s", "the already-waiting refusal", (f) =>
						f.includes("already waits in the Work queue"),
					);
					expect(state.consultation(id)?.state).toBe("queued");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation section starts the unscheduled record now, over the cap", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: opened");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: seatPane, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// The cap stands full from the boot: the seed's seat is the
					// line, and Enter starts the record over it.
					expect(setup.captureCharFrame()).toContain("auto: off 1/1");
					const started = await press(setup, "return", "the start-now notice", (f) =>
						f.includes("starting Consultation"),
					);
					expect(messageRowOf(started)).toContain(
						`starting Consultation ${id.slice(0, 8)} over the Parallel limit`,
					);
					// The seat count stands over the limit: the seed's seat plus
					// the seat the start took over the cap.
					await awaitFrame(setup, (f) => f.includes("auto: off 2/1"), "the seat over the cap");
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the start-now launch sequence",
					);
					expect(state.consultation(id)?.state).not.toBe("unscheduled");
					expect(state.consultation(seatId)?.state).toBe("working");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					// The test projection holds the seat: no poll can free it or
					// pick the item up out from under the test. The projection also
					// keeps the observation loop off the start's Message line: a tick
					// that lands while the record stands in `opening` cannot verify
					// its Agent yet and would clear the start's notice with its
					// recovery warning, so the line the test asserts on stays where
					// the start left it.
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation section starts the unscheduled record now, under the cap", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const inner = new FakeRunner();
		stubCheckout(inner);
		stubWorktreeLaunch(inner);
		stubPaneReadText(inner, "pane-c1", "Agent: opened");
		const runner = new ConsultationRunner(
			inner,
			agentListJson([{ pane: seatPane, status: "working" }]),
		);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// Free the seat the queue walk held: the line then names no
					// cap, because the seat count stood under the limit at the
					// key, the way the queue's force-dispatch line does.
					state.setConsultationState(seatId, "awaiting-response");
					// The write lands in the state the app reads live but re-renders
					// nothing: step the cursor up to the seed's row and back, so the
					// mode line re-reads the freed seat count before the key runs.
					await press(setup, "k", "the mode line on the freed seat", (f) =>
						f.includes("auto: off 0/1"),
					);
					await press(setup, "j", "the cursor back on the record", (f) =>
						detailPaneText(f).includes("State: unscheduled"),
					);
					const started = await press(setup, "return", "the start-now notice", (f) =>
						f.includes("starting Consultation"),
					);
					const line = messageRowOf(started);
					expect(line).toContain(`starting Consultation ${id.slice(0, 8)}`);
					expect(line).not.toContain("over the Parallel limit");
					// The start took the only free seat.
					await awaitFrame(setup, (f) => f.includes("auto: off 1/1"), "the start's seat");
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the start-now launch sequence",
					);
					expect(state.consultation(id)?.state).not.toBe("unscheduled");
					expect(state.consultation(seatId)?.state).toBe("awaiting-response");
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					// The test projection holds the seat: no poll can free it or
					// pick the item up out from under the test. The projection also
					// keeps the observation loop off the start's Message line: a tick
					// that lands while the record stands in `opening` cannot verify
					// its Agent yet and would clear the start's notice with its
					// recovery warning, so the line the test asserts on stays where
					// the start left it.
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Consultation section deletes the unscheduled record", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, seatId);
		const inner = new FakeRunner();
		stubCheckout(inner);
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// `d` asks first: the delete removes the record and its
					// history, and nothing else can run behind it.
					await openConsultationPanel(setup, "d", "the delete confirmation", (f) =>
						f.includes(`Delete Consultation ${id.slice(0, 8)}`),
					);
					const frame = await confirmPanel(setup, "the delete", (f) =>
						f.includes("deleted; backups may retain data"),
					);
					expect(messageRowOf(frame)).toContain(
						`Consultation ${id.slice(0, 8)} deleted; backups may retain data`,
					);
					expect(state.consultation(id)).toBeUndefined();
				},
				WIDTH,
				32,
				{
					state,
					runner,
					config: { ...configFor(), maxParallelAgents: 1 },
					home,
					initialTickets: [],
				},
			);
		} finally {
			state.close();
		}
	});
});
