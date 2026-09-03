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
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import {
	awaitFrame,
	detailPaneText,
	frameText,
	press,
	pressArrow,
	rgb,
	type Setup,
	settle,
	sleep,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
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
		...DEFAULT_CONFIG,
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
	runner.set("git", ["-C", checkout, "rev-parse", "HEAD"], { stdout: "deadbeef\n" });
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
			"deadbeef",
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
			})),
		},
	});

/** The full-flow launch's agent list entry, matched to its recorded handles. */
const launchedAgent = { pane: "pane-c1", tab: "tab-ws-new", ws: "ws-new", sess: "sess-c1" };

/** A configuration with a live-worktree Consultation type. */
function liveConfigFor(): FactoryConfig {
	return {
		...DEFAULT_CONFIG,
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
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: Uint8Array | string,
	) => {
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
async function pressEscape(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEscape();
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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					// Move to the initial input field and type the request.
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base deadbeef --no-focus`,
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
				30,
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
					// The first observation cycle settles the opening turn.
					await press(setup, "v", "the consultations view with the settled state", (f) =>
						f.includes("State: awaiting-response"),
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
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					// The action bar offers recovery for an opening Consultation.
					expect(frameText(setup.captureCharFrame())).toContain("r recover");
					await press(setup, "r", "the recovered launch to reach working", (f) =>
						f.includes("State: working"),
					);
					await waitForCommands(
						runner,
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base deadbeef --no-focus`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the recovery launch sequence",
					);
					expect(state.consultation(OPENING_ID)?.state).toBe("working");
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
					await press(setup, "v", "the consultations view", (f) =>
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
					const launcher = await press(setup, "c", "the replacement launcher", (f) =>
						f.includes("Replacement Consultation"),
					);
					expect(frameText(launcher)).toContain("Original input:");
					await pressEscape(setup, "the launcher to close", (f) => f.includes("State: failed"));
					// Relaunch: the replacement carries the failed id forward.
					await press(setup, "c", "the replacement launcher to open again", (f) =>
						f.includes("Replacement Consultation"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					await pressEnter(setup, "the failed detail to record the replacement", (f) =>
						f.includes("Replaced by:"),
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
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("enter submit"));
					const editor = await awaitFrame(
						setup,
						(f) => f.includes("follow up"),
						"the saved draft in the editor",
					);
					expect(frameText(editor)).toContain("Response draft");
					await pressEnter(setup, "the accepted response to reach working", (f) =>
						f.includes("State: working"),
					);
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
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("enter submit"));
					await pressEnter(setup, "the failure status and the reopened editor", (f) =>
						f.includes("response failed: refused"),
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
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
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
					expect(frameText(settled)).toContain("Enter respond");

					await pressEnter(setup, "the response editor", (f) => f.includes("enter submit"));
					setup.mockInput.typeText("then ship it");
					await pressEnter(setup, "the accepted response to start a new turn", (f) =>
						f.includes("State: working"),
					);
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
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressEnter(setup, "interaction mode with its exit key", (f) =>
						f.includes("F12 exit"),
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
						f.includes("F12 exit"),
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
				30,
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
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await press(setup, "v", "the consultations view", (f) =>
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
						await press(setup, "x", "the close panel", (f) => f.includes("Close Consultation"));
						await pressEnter(setup, `the close status for ${id8}`, (f) =>
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
				30,
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
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await press(setup, "v", "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await press(setup, "x", "the close panel", (f) => f.includes("Close Consultation"));
					await pressEnter(setup, "the failed cleanup status", (f) =>
						f.includes("close needs recovery: refused"),
					);
					expect(state.consultation(FORCE_ID)?.state).toBe("closing");
					// Retry offers force-close once the cleanup is stuck.
					await press(setup, "x", "the recovery close panel", (f) =>
						f.includes("Close Consultation"),
					);
					await pressArrow(setup, "down", "the force-close action to be selected", (f) =>
						f.includes("Force-close"),
					);
					await pressEnter(setup, "the force-close confirmation", (f) =>
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
				30,
				bootProps(state, runner),
			);
		} finally {
			state.close();
		}
	});
});

describe("Consultation geometry, privacy, and history through the UI", () => {
	test("a narrow terminal shows the compact consultation heading without the list pane", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		seed(state, WORKING_ID);
		const inner = new FakeRunner();
		stubPaneReadText(inner, `pane-${WORKING_ID.slice(0, 8)}`, "Agent: working");
		const runner = new ConsultationRunner(inner, agentListJson([]));
		try {
			await withApp(
				async (setup) => {
					await press(setup, "v", "the narrow consultations view", (f) =>
						f.includes("grill - acme/factory"),
					);
					const frame = setup.captureCharFrame();
					expect(frame).not.toContain("\u276f Consultations");
					expect(frameText(frame)).toContain("State: working");
				},
				70,
				30,
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
					await press(setup, "v", "the consultations view without open history", (f) =>
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
					await press(setup, "d", "the delete panel", (f) => f.includes("Delete Consultation"));
					await pressEnter(setup, "the empty closed history", (f) =>
						f.includes("no closed Consultations"),
					);
					expect(state.consultation(CLOSED_ID)).toBeUndefined();
				},
				WIDTH,
				30,
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
					await press(setup, "v", "the consultations view", (f) => f.includes("State: working"));
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
				30,
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
					await press(setup, "v", "the consultations view with the settled state", (f) =>
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
				30,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			bells.restore();
			state.close();
		}
	});

	test("a opens the oldest recovery item, and awaiting response wins", async () => {
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
					await press(setup, "v", "the consultations view", (f) => f.includes("State: "));
					// a goes to the item that has waited longest: the failed one.
					const oldest = await press(setup, "a", "the oldest recovery detail", (f) =>
						f.includes("State: failed"),
					);
					expect(frameText(oldest)).toContain("herdr refused the launch");
					// An awaiting response always wins over the recovery items.
					seed(state, AWAITING_ID, true, t(4));
					state.settleConsultationTurn(AWAITING_ID, null, "answer", "idle");
					const selected = await press(setup, "a", "the awaiting detail", (f) =>
						f.includes("State: awaiting-response"),
					);
					expect(detailPaneText(selected)).toContain("State: awaiting-response");
				},
				WIDTH,
				30,
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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
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
				30,
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
				...DEFAULT_CONFIG.agents,
				pi: { ...DEFAULT_CONFIG.agents.pi, contextWindow: "--context {value}" },
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
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
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
				30,
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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
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
				30,
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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					const panel = await pressEnter(setup, "the live checkout conflict panel", (f) =>
						f.includes("Live checkout conflict"),
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
					expect(state.consultation(consultation.id)).toMatchObject({
						state: "working",
						liveConflictOverride: true,
					});
				},
				WIDTH,
				30,
				{ state, runner, config: liveConfigFor(), home },
			);
		} finally {
			state.close();
		}
	});

	test("an unfit Model fails the launch before it resolves the Repository", async () => {
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
		// The reads that resolve one Repository: the launcher makes them to verify
		// its option, and a launch route resolves the Repository the same way, which
		// clones a checkout that is missing.
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
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					const failed = await pressEnter(setup, "the fit check to refuse the launch", (f) =>
						f.includes("State: failed"),
					);
					expect(frameText(failed)).toContain('has no model "openai/gpt-4o"');
					// The check runs ahead of the route's first external change: a
					// live launch resolves its Repository, and a resolve clones a
					// missing checkout, records the path, and then drives Herdr.
					// None of that happened behind an unfit setting.
					const joined = runner.commands().join("\n");
					expect(resolveReads()).toBe(readsBeforeLaunch);
					expect(joined).not.toContain("git clone");
					expect(joined).not.toContain("herdr workspace");
					expect(joined).not.toContain("herdr tab create");
					expect(joined).not.toContain("agent start");
					expect(joined).not.toContain("agent prompt");
					// One Consultation start asks the Agent's CLI once, not once per step.
					expect(inner.modelListCalls).toEqual(["pi"]);
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("failed");
					expect(consultation.paneId).toBeNull();
				},
				WIDTH,
				30,
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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
					expect(frameText(setup.captureCharFrame())).not.toContain("Live checkout conflict");
					const [consultation] = state.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.warning).toBe("the live checkout has uncommitted changes");
				},
				WIDTH,
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The observed blocked status re-points the hints, and the
					// configured exit key is visible before any input is forwarded.
					const bar = await awaitFrame(
						setup,
						(f) => frameText(f).includes("F12 interact exit"),
						"the blocked Agent hints",
					);
					expect(frameText(bar)).toContain("Enter interact");
					await pressEnter(
						setup,
						"interaction mode, not the response editor",
						(f) => f.includes("F12 exit") && !f.includes("interact exit"),
					);
					// No input is forwarded until the operator sends keys.
					expect(runner.commands().join("\n")).not.toContain("send-text");
					expect(runner.commands().join("\n")).not.toContain("send-keys");
					await pressF12(setup, "the exit from interaction mode", (f) =>
						f.includes("left Agent interaction mode"),
					);
				},
				WIDTH,
				30,
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
					await press(setup, "v", "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The gate is the observed status, not the last settled turn.
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("Enter respond"),
						"the idle Agent hints",
					);
					await pressEnter(setup, "the response editor", (f) => f.includes("enter submit"));
				},
				WIDTH,
				30,
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
					await press(setup, "v", "the consultations view", (f) => f.includes("State: working"));
					await pressEnter(
						setup,
						"interaction mode with its exit key",
						(f) => f.includes("F12 exit") && !f.includes("interact exit"),
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
				30,
				{ state, runner, config: configFor(), home, pollIntervalMs: 50 },
			);
		} finally {
			state.close();
		}
	});
});

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
					await press(setup, "c", "the launcher to open", (f) =>
						f.includes("Consultation launcher"),
					);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory"),
						"the verified Repository option",
					);
					setup.mockInput.pressTab();
					setup.mockInput.pressTab();
					setup.mockInput.typeText("review auth");
					await pressEnter(setup, "the Consultation to reach working", (f) =>
						f.includes("State: working"),
					);
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
					// a selects it for attention.
					await press(setup, "a", "the attention selection", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The Agent is idle: Enter opens the response editor.
					await pressEnter(setup, "the response editor", (f) => f.includes("enter submit"));
					setup.mockInput.typeText("answer one");
					await pressEnter(setup, "the accepted response to reach working", (f) =>
						f.includes("State: working"),
					);
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
					await pressEnter(
						setup,
						"the blocked interaction mode",
						(f) => f.includes("F12 exit") && !f.includes("interact exit"),
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
					// Close takes down the owned workspace.
					await press(setup, "x", "the closing status", (f) =>
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
});
