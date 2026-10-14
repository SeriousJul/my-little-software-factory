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
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { agentNameFor } from "../src/naming.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";
import { workQueueIdentityOf } from "../src/state/work-queue.ts";
import type { FactoryState } from "../src/state.ts";
import type { AppSetup } from "./app-harness.ts";
import {
	actionBarRowOf,
	crossCursor,
	detailPaneText,
	fieldKey,
	frameText,
	frameUntil,
	guideKey,
	launchConsultationDraft,
	messageRowOf,
	mouseClick,
	pressControl,
	rgb,
	rowsOf,
	type Setup,
	sendResponseDraft,
	settle,
	sleep,
	spanColors,
	tabUntilSlot,
	typeText,
	WIDTH,
	waitCommands,
	waitUntil,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { expectNoCommand } from "./command-assertions.ts";
import { fetchSuccess, issueTicket, ticketOf } from "./fact-fixtures.ts";
import {
	type FakeRunner,
	herdrFocusCommands,
	tabCreateJson,
	workspaceCreateJson,
	workspaceGetJson,
	workspaceListJson,
	worktreeCreateJson,
} from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { plane, wrappedState } from "./plane.ts";

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
/** The settled frames walk: the waits line never stands over an empty Work queue. */
async function pickupFrameWalk(setup: AppSetup, state: FactoryState): Promise<void> {
	let sawWorking = false;
	for (let step = 0; step < 25; step += 1) {
		const frame = setup.captureCharFrame();
		if (detailPaneText(frame).includes("State: working")) sawWorking = true;
		if (state.workQueue.items().length === 0) {
			expect(messageRowOf(frame)).not.toContain("waits in the Work queue");
		}
		await settle(setup, 50);
		if (sawWorking && step > 10) break;
	}
}
/** One Consultation's close, from the selected Agent to the settled status line. */
async function closeConsultationStep(
	setup: AppSetup,
	i: number,
	state: FactoryState,
): Promise<string> {
	const selected = await frameUntil(
		setup,
		`a working Consultation ${i + 1} of 3 to be selected`,
		(f) => /Agent: pi \(consultation-[0-9a-f]{8}\)/.test(detailPaneText(f)),
	);
	const id8 = detailPaneText(selected).match(/Agent: pi \(consultation-([0-9a-f]{8})\)/)?.[1];
	if (id8 === undefined) throw new Error("no Consultation agent selected");
	if (i === 0) {
		const current = state.consultationRecord
			.consultations("open")
			.find((item) => item.id.slice(0, 8) === id8);
		if (current === undefined) throw new Error(`no record for ${id8}`);
		// The confirmation names the live Agent and the work the
		// close keeps; a cancel leaves the state unchanged.
		await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
		const dialog = await settle(setup);
		expect(dialog).toContain(
			current.state === "opening" ? "The Agent is still opening" : "The Agent is working",
		);
		expect(dialog).toContain("Close stops the Agent. The worktree and branch stay.");
		await pressControl(setup, "cancel-action", { closes: "Close Consultation" });
		expect(state.consultationRecord.consultation(current.id)?.state).toBe(current.state);
		// Reopen the dialog for the confirm.
		await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
	} else {
		await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
	}
	await pressControl(setup, "confirm-action", { shows: `${id8} closed` });
	return id8;
}
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
	failedStartStreak: 0,
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
	matchedStateName: null,
	actionable: true,
	listActionable: true,
	handoffRecoveryRequired: false,
	ignored: false,
	ignoredAt: null,
	muted: false,
	mutedAt: null,
	leftover: null,
	nameCollision: null,
};
/** The worktree Consultation type the suite stands on, as the config carries it. */
const grillTypes: FactoryConfig["consultationTypes"] = {
	grill: { agent: "pi", environment: "worktree", template: "/grill {input}" },
};
/** Seed a Consultation with a deterministic id, and optionally its Agent. */
function seed(
	state: FactoryState,
	id: string,
	checkout: string,
	fields: {
		agent?: boolean;
		createdAt?: string;
		contextWindow?: string;
		environment?: "worktree" | "live-worktree";
	} = {},
): void {
	const {
		agent = true,
		createdAt = "2026-09-01T10:00:00.000Z",
		contextWindow = "",
		environment = "worktree",
	} = fields;
	state.consultationRecord.createConsultation({
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
		state.consultationRecord.setConsultationAgent(id, {
			paneId: `pane-${id.slice(0, 8)}`,
			tabId: `tab-${id.slice(0, 8)}`,
			workspaceId: `ws-${id.slice(0, 8)}`,
			sessionId: `sess-${id.slice(0, 8)}`,
		});
}
/** The herdr handles a worktree launch records for its Consultation. */
function seedResources(state: FactoryState, id: string): void {
	const short = id.slice(0, 8);
	state.consultationRecord.recordConsultationResource(id, {
		kind: "workspace",
		resourceId: `ws-${short}`,
		owned: true,
		details: "Consultation worktree workspace",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "worktree",
		resourceId: `ws-${short}`,
		owned: true,
		details: `Consultation worktree checkout for factory/consultation-${short}-grill`,
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "tab",
		resourceId: `tab-${short}`,
		owned: true,
		details: "Consultation worktree tab",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "pane",
		resourceId: `pane-${short}`,
		owned: true,
		details: "Consultation Agent pane",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "agent",
		resourceId: `consultation-${short}`,
		owned: true,
		details: `Agent hosted by pane pane-${short}`,
	});
}
/** Stub the git answers for a healthy, verified convention checkout. */
function stubCheckout(runner: FakeRunner, checkout: string): void {
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
}
/** Stub the full worktree launch sequence at the verified checkout. */
function stubWorktreeLaunch(runner: FakeRunner, checkout: string, branch = BRANCH): void {
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
/** The live-worktree Consultation type the live suite stands on. */
const liveGrillTypes: FactoryConfig["consultationTypes"] = {
	"grill-live": { agent: "pi", environment: "live-worktree", template: "/grill {input}" },
};
/** Stub the git answers for a verified live checkout, optionally dirty. */
function stubLiveCheckout(runner: FakeRunner, checkout: string, dirty: boolean): void {
	stubCheckout(runner, checkout);
	runner.set("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], {
		stdout: dirty ? " M src/app.ts\n" : "",
	});
}
/** Stub the live launch into a workspace herdr already holds at the checkout. */
function stubLiveLaunchExisting(runner: FakeRunner, checkout: string): void {
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
function stubLiveLaunchNew(runner: FakeRunner, checkout: string): void {
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-new", "pane-c1"),
	});
	runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-c1"], {
		stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }),
	});
	runner.set("herdr", ["agent", "prompt", AGENT, "/grill review auth"], { code: 0 });
}
/**
 * The recovery tests' standard worktree launch: the factory's checkout, its
 * worktree launch, and the Agent's pane reporting the review.
 */
function stubReviewingCheckout(fake: FakeRunner, home: string): void {
	const checkout = join(home, "src", "factory");
	stubCheckout(fake, checkout);
	stubWorktreeLaunch(fake, checkout);
	stubPaneReadText(fake, "pane-c1", "Agent: reviewing");
}

/** The pickup tests' worktree launch: the checkout, the launch, the open pane. */
function stubOpenedCheckout(fake: FakeRunner, home: string): void {
	const checkout = join(home, "src", "factory");
	stubCheckout(fake, checkout);
	stubWorktreeLaunch(fake, checkout);
	stubPaneReadText(fake, "pane-c1", "Agent: opened");
}

/** The live tests' existing-checkout launch: the clean live checkout and its tab. */
function stubLiveExistingCheckout(fake: FakeRunner, home: string): void {
	const checkout = join(home, "src", "factory");
	stubLiveCheckout(fake, checkout, false);
	stubLiveLaunchExisting(fake, checkout);
	stubPaneReadText(fake, "pane-c1", "Agent: live answer");
}

/**
 * The Consultation plane's boot: a fresh state where the test names none, the
 * grill types, and the factory checkout standing, with the test naming the
 * checkout's command stubs and the agent list runner it captures.
 */
async function consultationBoot(
	options: {
		state?: FactoryState;
		config?: Partial<FactoryConfig>;
		commands?: (fake: FakeRunner, home: string) => void;
		runner?: (fake: FakeRunner) => ConsultationRunner;
	} = {},
): Promise<{ state: FactoryState; planeRecord: Awaited<ReturnType<typeof plane>> }> {
	const { state = wrappedState(), config = {}, commands, runner } = options;
	const planeRecord = await plane({
		existing: state,
		sources: [],
		config: { consultationTypes: grillTypes, ...config },
		repos: { "github.com/acme/factory": "src/factory" },
		commands,
		runner,
	});
	return { state, planeRecord };
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
/** Cross into the Consultation list, then wait for the detail the test names. */
async function toConsultations(
	setup: Setup,
	what: string,
	predicate: (f: string) => boolean,
): Promise<string> {
	await crossCursor(setup, "consultations");
	return frameUntil(setup, what, predicate);
}
describe("Consultation launch and monitoring through the UI", () => {
	test("the launcher resolves an unmapped selected Ticket Repository before the pinned launch sequence", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const planeRecord = await plane({
			existing: state,
			sources: [
				{
					config: {
						name: "tickets",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/factory"],
						host: "github.com",
					},
					tickets: [selectedTicket],
				},
			],
			config: { consultationTypes: grillTypes },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				// The conventional checkout exists without a config entry: the
				// launcher's resolution, not the settings, stands it up.
				mkdirSync(checkout, { recursive: true });
				stubCheckout(fake, checkout);
				stubWorktreeLaunch(fake, checkout);
				stubPaneReadText(fake, "pane-c1", "Agent: auth review");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					// Move to the initial input field and type the request.
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the launch command sequence",
					);
					await frameUntil(setup, "the live Agent output", (f) => f.includes("Agent: auth review"));
					const started = state.consultationRecord.consultations("open");
					expect(started).toHaveLength(1);
					expect(started[0].state).toBe("working");
					expect(started[0].paneId).toBe("pane-c1");
					expect(state.consultationRecord.consultation(started[0].id)?.pendingResponse).toBeNull();
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the observation loop settles a restarted working Consultation", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: auth review looks sound");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(fake, agentListJson([{ pane: paneId, status: "idle" }]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
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
					expect(state.consultationRecord.consultation(WORKING_ID)?.state).toBe(
						"awaiting-response",
					);
					expect(state.consultationRecord.consultationTurns(WORKING_ID)).toHaveLength(1);
					expect(
						state.consultationRecord.consultationTurns(WORKING_ID)[0].settledAt,
					).not.toBeNull();
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});
});
test("the mode cell counts the ticket seat and the Consultation seat against one cap", async () => {
	// Issue #87: the Parallel limit counts a Consultation alike with a
	// ticket. The running ticket and the working Consultation each hold
	// one seat, and the mode cell shows the combined count against the one
	// cap, from the same shared seat count the gates read. When the
	// Consultation settles to awaiting-response it drops its seat, and the
	// line holds the ticket's seat alone.
	let runner: ConsultationRunner;
	const state = wrappedState();
	const ticketSource = { name: "tickets", kind: "github-issues" as const };
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
	state.sourceFact.initializeSources([ticketSource]);
	state.sourceFact.applyFetch(ticketSource, ticketOutcome);
	const claim = state.handoff.claimHandoff(
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
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-ticket",
		tabId: "tab-ticket",
		workspaceId: "ws-ticket",
	});
	const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
	const planeRecord = await plane({
		existing: state,
		sources: [
			{
				config: {
					name: "tickets",
					kind: "github-issues",
					refreshIntervalSeconds: 60,
					repositories: ["acme/factory"],
					host: "github.com",
				},
				tickets: [selectedTicket],
			},
		],
		config: { consultationTypes: grillTypes },
		commands: (fake, home) => {
			const _checkout = join(home, "src", "factory");
			stubPaneReadText(fake, paneId, "Agent: the review is underway");
		},
		runner: (fake) =>
			(runner = new ConsultationRunner(
				fake,
				agentListJson([
					{ pane: "pane-ticket", status: "working" },
					{ pane: paneId, status: "working" },
				]),
			)),
	});
	const checkout = join(planeRecord.home, "src", "factory");
	seed(state, WORKING_ID, checkout);
	try {
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await frameUntil(setup, "the combined seat count", (f) => f.includes("● manual 2/2"));
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
				await frameUntil(setup, "the dropped seat", (f) => f.includes("● manual 1/2"));
			},
			{
				width: WIDTH,
				height: 32,
				// The observation loop must poll herdr for the seat count's
				// agent list, so the boot names the poll: the held policy would
				// hold the poll, and the frame would stand on no agent list.
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
	} finally {
		state.close();
	}
});
describe("Consultation recovery and replacement through the UI", () => {
	test("an interrupted opening recovers with r", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: stubReviewingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, OPENING_ID, checkout, { agent: false });
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					// The action bar offers recovery for an opening Consultation.
					expect(frameText(setup.captureCharFrame())).toContain("r Recover");
					await pressControl(setup, "recover", { shows: "State: working" });
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the recovery launch sequence",
					);
					expect(state.consultationRecord.consultation(OPENING_ID)?.state).toBe("working");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("recovery re-checks the stored settings before it resumes the Agent", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// The interrupted launch recorded its Agent pane and the count its type
		// named, and never reached a settled state. Herdr reports no Agent, so the
		// stored count is the one thing that can refuse this recovery: pi maps no
		// context window setting.
		const short = OPENING_ID.slice(0, 8);
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, OPENING_ID, checkout, {
			agent: false,
			createdAt: "2026-09-01T10:00:00.000Z",
			contextWindow: "131072",
		});
		state.consultationRecord.recordConsultationAgentHandles(OPENING_ID, {
			paneId: `pane-${short}`,
			tabId: `tab-${short}`,
			workspaceId: `ws-${short}`,
			sessionId: `sess-${short}`,
		});
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: opening"),
					);
					await pressControl(setup, "recover", { shows: "State: failed" });
					const failed = state.consultationRecord.consultation(OPENING_ID);
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
				{ width: WIDTH, height: 30, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("a failed Consultation refuses r and opens a Replacement launcher from c", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: stubReviewingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, FAILED_ID, checkout, { agent: false });
		state.consultationRecord.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		const expectedInput = state.consultationRecord.replacementInput(FAILED_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					const failed = await frameUntil(setup, "the failed detail", (f) =>
						f.includes("State: failed"),
					);
					expect(frameText(failed)).toContain("herdr refused the launch");
					// r refreshes but never resumes a failed Consultation.
					await pressControl(setup, "refresh", { shows: "State: failed" });
					await settle(setup);
					const joined = runner.commands().join("\n");
					expect(joined).not.toContain("worktree create");
					expect(joined).not.toContain("agent start");
					expect(joined).not.toContain("agent prompt");
					// c opens the Replacement launcher with the retained context.
					const launcher = await guideKey(setup, "launch", "c", {
						opens: "Replacement Consultation",
					});
					expect(frameText(launcher)).toContain("Original input:");
					await pressControl(setup, "close-form", { closes: "Replacement Consultation" });
					// Relaunch: the replacement carries the failed id forward.
					await guideKey(setup, "launch", "c", { opens: "Replacement Consultation" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					// The Replacement launcher opens on the retained context, so the
					// flow is the same one any launcher takes: Tab to the visible
					// action and run it there.
					await tabUntilSlot(setup, "❯ Launch Consultation");
					await pressControl(setup, "confirm-choice", { shows: "Replaced by:" });
					await waitCommands(
						() => runner.commands(),
						[`herdr agent prompt ${AGENT} /grill ${expectedInput}`],
						"the replacement prompt",
					);
					// The replacement itself points back at the failed record.
					await pressControl(setup, "move-list", {
						via: "j",
						shows: `Replacement of: ${FAILED_ID.slice(0, 8)}`,
					});
					expect(frameText(setup.captureCharFrame())).toContain("State: working");
					const replacements = state.consultationRecord
						.consultations("open")
						.filter((item) => item.id !== FAILED_ID);
					expect(replacements).toHaveLength(1);
					expect(replacements[0].replacementOf).toBe(FAILED_ID);
					expect(replacements[0].state).toBe("working");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
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
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: stubReviewingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, OPENING_ID, checkout, { agent: false });
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the interrupted opening", (f) =>
						f.includes("State: opening"),
					);
					// The bar names the meaning Enter carries on this row.
					expect(actionBarRowOf(setup.captureCharFrame())).toContain("Enter Recovery");
					await pressControl(setup, "consultation-recovery", {
						opens: "Recover Consultation",
					});
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("The Agent never finished opening.");
					expect(frameText(panel)).toContain("Recover");
					expect(frameText(panel)).toContain("Close");
					// The panel's first row is the retry the interrupted opening needs:
					// it runs the same recovery the `r` key runs.
					await pressControl(setup, "confirm-action", { shows: "State: working" });
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the recovery launch sequence",
					);
					expect(state.consultationRecord.consultation(OPENING_ID)?.state).toBe("working");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the recovery panel's Close takes an opening Consultation through its dialog", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, OPENING_ID, checkout, { agent: false });
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the interrupted opening", (f) =>
						f.includes("State: opening"),
					);
					await pressControl(setup, "consultation-recovery", {
						opens: "Recover Consultation",
					});
					// The Close row is the close path, dialog and all: an opening
					// record still holds an Agent the close must stop.
					await pressControl(setup, "select-action", { via: "↓", shows: "❯ Close" });
					const dialog = await pressControl(setup, "confirm-action", {
						opens: "Close Consultation",
					});
					expect(frameText(dialog)).toContain("The Agent is still opening");
					expect(state.consultationRecord.consultation(OPENING_ID)?.state).toBe("opening");
					await pressControl(setup, "cancel-action", { closes: "Close Consultation" });
					expect(state.consultationRecord.consultation(OPENING_ID)?.state).toBe("opening");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("Enter on a missing Consultation opens the recovery panel, and Replace links its replacement", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: stubReviewingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, MISSING_ID, checkout, { agent: false });
		state.consultationRecord.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		const expectedInput = state.consultationRecord.replacementInput(MISSING_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the missing Consultation", (f) =>
						f.includes("State: missing"),
					);
					await pressControl(setup, "consultation-recovery", {
						opens: "Recover Consultation",
					});
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("The Agent is gone from its pane.");
					expect(frameText(panel)).toContain("the Agent pane is gone");
					expect(frameText(panel)).toContain("Replace");
					// Replace opens the launcher on the record's durable recovery
					// context, not on an empty form.
					const launcher = await pressControl(setup, "confirm-action", {
						opens: "Replacement Consultation",
					});
					expect(frameText(launcher)).toContain("Original input:");
					await tabUntilSlot(setup, "❯ Launch Consultation");
					await pressControl(setup, "confirm-choice", { shows: "Replaced by:" });
					await waitCommands(
						() => runner.commands(),
						[`herdr agent prompt ${AGENT} /grill ${expectedInput}`],
						"the replacement prompt",
					);
					const replacement = state.consultationRecord
						.consultations("open")
						.find((item) => item.id !== MISSING_ID);
					expect(replacement?.replacementOf).toBe(MISSING_ID);
					// The replaced record keeps its own state beside the new one.
					expect(state.consultationRecord.consultation(MISSING_ID)?.state).toBe("missing");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the recovery panel's Close retires a failed record without a dialog", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const short = FAILED_ID.slice(0, 8);
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, FAILED_ID, checkout, { agent: false });
		state.consultationRecord.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the failed Consultation", (f) =>
						f.includes("State: failed"),
					);
					await pressControl(setup, "consultation-recovery", {
						opens: "Recover Consultation",
					});
					await pressControl(setup, "select-action", { via: "↓", shows: "❯ Close" });
					// A failed record holds no Agent, so the close runs on the row:
					// no confirmation stands between it and the result.
					const frame = await pressControl(setup, "confirm-action", {
						shows: `${short} closed`,
					});
					expect(frame).not.toContain("Close Consultation");
					expect(state.consultationRecord.consultation(FAILED_ID)?.state).toBe("closed");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("Enter on a closing Consultation opens the close panel's Retry and Force-close", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CLOSE_A_ID, checkout);
		state.consultationRecord.beginConsultationClose(CLOSE_A_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the closing Consultation", (f) =>
						f.includes("State: closing"),
					);
					// The stuck cleanup is the record's recovery, so Enter opens the
					// close panel that already carries its retry rows.
					await pressControl(setup, "consultation-recovery", { opens: "Close Consultation" });
					const panel = await settle(setup);
					expect(frameText(panel)).toContain("Cleanup is already in progress");
					expect(frameText(panel)).toContain("Retry");
					expect(frameText(panel)).toContain("Force-close");
					expect(state.consultationRecord.consultation(CLOSE_A_ID)?.state).toBe("closing");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("Enter on a closed Consultation says the record is already closed", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CLOSED_DIRECT_ID, checkout);
		state.consultationRecord.settleConsultationTurn(CLOSED_DIRECT_ID, null, "done", {
			settledStatus: "idle",
		});
		state.consultationRecord.beginConsultationClose(CLOSED_DIRECT_ID);
		state.consultationRecord.finishConsultationClose(CLOSED_DIRECT_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					await pressControl(setup, "history", { shows: "State: closed" });
					await pressControl(setup, "consultation-recovery", {
						refuses: "the selected Consultation is already closed",
					});
					expect(state.consultationRecord.consultation(CLOSED_DIRECT_ID)?.state).toBe("closed");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation responses through the UI", () => {
	test("a response becomes a turn only after Herdr accepts the prompt", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, `pane-${RESPONSE_ID.slice(0, 8)}`, "Agent: waiting");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, RESPONSE_ID, checkout);
		state.consultationRecord.settleConsultationTurn(RESPONSE_ID, null, "first answer", {
			settledStatus: "idle",
		});
		state.consultationRecord.setConsultationDraft(RESPONSE_ID, "follow up");
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressControl(setup, "consultation-respond", { opens: "Response draft" });
					const editor = await frameUntil(setup, "the saved draft in the editor", (f) =>
						f.includes("follow up"),
					);
					expect(frameText(editor)).toContain("Response draft");
					await sendResponseDraft(setup);
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[`herdr agent prompt ${AGENT} follow up`],
						"the response prompt",
					);
					expect(state.consultationRecord.consultation(RESPONSE_ID)?.pendingResponse).toBeNull();
					const turns = state.consultationRecord.consultationTurns(RESPONSE_ID);
					expect(turns).toHaveLength(2);
					expect(turns[1].input).toBe("follow up");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("a rejected prompt keeps the draft and leaves no pending delivery", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				fake.set("herdr", ["agent", "prompt", AGENT, "follow up"], {
					code: 1,
					stderr: "refused\n",
				});
				stubPaneReadText(fake, `pane-${RESPONSE_ID.slice(0, 8)}`, "Agent: waiting");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, RESPONSE_ID, checkout);
		state.consultationRecord.settleConsultationTurn(RESPONSE_ID, null, "first answer", {
			settledStatus: "idle",
		});
		state.consultationRecord.setConsultationDraft(RESPONSE_ID, "follow up");
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressControl(setup, "consultation-respond", { opens: "Response draft" });
					await sendResponseDraft(setup);
					await frameUntil(setup, "the failure status and the reopened editor", (f) =>
						f.includes("response failed: refused"),
					);
					expect(state.consultationRecord.consultation(RESPONSE_ID)).toMatchObject({
						state: "awaiting-response",
						draft: "follow up",
					});
					expect(state.consultationRecord.consultation(RESPONSE_ID)?.pendingResponse).toBeNull();
					expect(state.consultationRecord.consultationTurns(RESPONSE_ID)).toHaveLength(1);
					expect(frameText(setup.captureCharFrame())).toContain("follow up");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the settled Agent output stays visible until an accepted response opens the next turn", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${RESPONSE_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: the design holds");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(fake, agentListJson([{ pane: paneId, status: "idle" }]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, RESPONSE_ID, checkout);
		state.consultationRecord.settleConsultationTurn(RESPONSE_ID, null, "the design holds", {
			settledStatus: "idle",
		});
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: awaiting-response"),
					);
					// The Agent's last message stays readable until the operator answers.
					const settled = await frameUntil(setup, "the settled Agent output", (f) =>
						detailPaneText(f).includes("Agent: the design holds"),
					);
					expect(detailPaneText(settled)).toContain("Agent view:");
					expect(detailPaneText(settled)).toContain("the design holds");
					expect(actionBarRowOf(settled)).toContain("Enter Respond");
					expect(actionBarRowOf(settled)).not.toContain("Enter/r Respond");
					// `r` remains Refresh even when Enter can open the response editor.
					await pressControl(setup, "refresh", { shows: "no Ticket sources exist" });
					await pressControl(setup, "consultation-respond", { opens: "Response draft" });
					await typeText(setup, "then ship it");
					await sendResponseDraft(setup);
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[`herdr agent prompt ${AGENT} then ship it`],
						"the operator's response",
					);
					expect(state.consultationRecord.consultation(RESPONSE_ID)?.pendingResponse).toBeNull();
					const turns = state.consultationRecord.consultationTurns(RESPONSE_ID);
					expect(turns).toHaveLength(2);
					expect(turns.at(-1)?.input).toBe("then ship it");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});
});
describe("Agent interaction through the UI", () => {
	test("interaction renders pane ANSI safely and serializes Unicode input", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: working");
				stubPaneReadAnsi(fake, paneId, "\u001b[31mERROR: authz\u001b[0m and more");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, INTERACTION_ID, checkout);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await pressControl(setup, "consultation-interact", { shows: "F12 Exit interaction" });
					const frame = await frameUntil(setup, "the rendered pane output", (f) =>
						f.includes("ERROR: authz"),
					);
					// The escape bytes never reach the control plane frame.
					expect(frame).not.toContain("\u001b");
					// The SGR color lands on the pane text in the renderer.
					expect(spanColors(setup, "ERROR: authz").map((color) => color.join(","))).toContain(
						rgb("#cd3131").join(","),
					);
					// Literal text and a semantic key keep terminal order: both characters
					// reach the terminal in one batch, so the plane serializes
					// them into the one send the operator's keys stand for.
					await typeText(setup, "h\u00e9");
					// In the interaction mode the terminal forwards every key to the
					// Agent, so the plane's Enter meaning stands nowhere: the newline
					// goes out through the rig's field keys.
					fieldKey(setup, "enter");
					await frameUntil(setup, "the frame to stay in interaction", (f) =>
						f.includes("F12 Exit interaction"),
					);
					await waitCommands(
						() => runner.commands(),
						[`herdr pane send-text ${paneId} h\u00e9`, `herdr pane send-keys ${paneId} enter`],
						"the serialized interaction input",
					);
					const commands = runner.commands();
					const textAt = commands.indexOf(`herdr pane send-text ${paneId} h\u00e9`);
					const keyAt = commands.indexOf(`herdr pane send-keys ${paneId} enter`);
					expect(textAt).toBeGreaterThan(-1);
					expect(keyAt).toBeGreaterThan(textAt);
					// The configured exit key leaves the mode.
					await pressControl(setup, "interact-exit", {
						shows: "left Agent interaction mode",
					});
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation close and cleanup through the UI", () => {
	test("close takes down only what is exclusively owned, and keeps every worktree", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const a = CLOSE_A_ID.slice(0, 8);
		const b = CLOSE_B_ID.slice(0, 8);
		const c = CLOSE_C_ID.slice(0, 8);
		// The close verifies each Agent's identity before it takes anything
		// down, so the list holds all three at their recorded panes.
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, `pane-${a}`, "Agent: done a");
				stubPaneReadText(fake, `pane-${b}`, "Agent: done b");
				stubPaneReadText(fake, `pane-${c}`, "Agent: done c");
				stubTopology(fake, `ws-${a}`, [`tab-${a}`], [{ pane_id: `pane-${a}`, tab_id: `tab-${a}` }]);
				stubTopology(
					fake,
					`ws-${b}`,
					[`tab-${b}`, "tab-foreign"],
					[{ pane_id: `pane-${b}`, tab_id: `tab-${b}` }],
				);
				stubTopology(
					fake,
					`ws-${c}`,
					[`tab-${c}`],
					[
						{ pane_id: `pane-${c}`, tab_id: `tab-${c}` },
						{ pane_id: "pane-foreign", tab_id: `tab-${c}` },
					],
				);
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([
						{ pane: `pane-${a}`, status: "idle" },
						{ pane: `pane-${b}`, status: "idle" },
						{ pane: `pane-${c}`, status: "idle" },
					]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		// A: an exclusive workspace: the workspace close is safe.
		seed(state, CLOSE_A_ID, checkout);
		seedResources(state, CLOSE_A_ID);
		// B: a foreign tab shares the workspace: only the owned tab closes.
		seed(state, CLOSE_B_ID, checkout);
		seedResources(state, CLOSE_B_ID);
		// C: a foreign pane sits in the owned tab: only the pane closes.
		seed(state, CLOSE_C_ID, checkout);
		seedResources(state, CLOSE_C_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					const closedIds: string[] = [];
					for (let i = 0; i < 3; i += 1)
						closedIds.push(await closeConsultationStep(setup, i, state));
					expect(closedIds.sort()).toEqual([a, b, c].sort());
					const commands = runner.commands();
					expect(commands).toContain(`herdr workspace close ws-${a}`);
					expect(commands).toContain(`herdr tab close tab-${b}`);
					expect(commands).toContain(`herdr pane close pane-${c}`);
					// No close moves herdr's view on the plane's own (ADR 0061):
					// the plane sends no focus command beside any of them.
					expect(herdrFocusCommands(commands)).toEqual([]);
					// The cleanup never deletes a Consultation worktree or branch.
					expect(commands.join("\n")).not.toContain("worktree remove");
					expect(commands.join("\n")).not.toContain("branch -D");
					for (const id of [CLOSE_A_ID, CLOSE_B_ID, CLOSE_C_ID]) {
						expect(state.consultationRecord.consultation(id)?.state).toBe("closed");
						const retained = state.consultationRecord
							.consultationResources(id)
							.filter((resource) => resource.kind === "worktree");
						expect(retained).toHaveLength(1);
						expect(retained[0]).toMatchObject({ owned: false });
						expect(retained[0].details).toContain("retained after close");
					}
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("a failed cleanup recovers through the force-close panel", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const short = FORCE_ID.slice(0, 8);
		// The close verifies the Agent's identity before it takes the workspace
		// down, so the list holds the record's Agent at its recorded pane.
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, `pane-${short}`, "Agent: closing output");
				stubTopology(
					fake,
					`ws-${short}`,
					[`tab-${short}`],
					[{ pane_id: `pane-${short}`, tab_id: `tab-${short}` }],
				);
				fake.set("herdr", ["workspace", "close", `ws-${short}`], {
					code: 1,
					stderr: "refused\n",
				});
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: `pane-${short}`, status: "idle" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, FORCE_ID, checkout);
		seedResources(state, FORCE_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: "),
					);
					await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
					await pressControl(setup, "confirm-action", {
						shows: "close needs recovery: refused",
					});
					expect(state.consultationRecord.consultation(FORCE_ID)?.state).toBe("closing");
					// Retry offers force-close once the cleanup is stuck.
					await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
					await pressControl(setup, "select-action", {
						via: "↓",
						shows: "Force-close",
					});
					await pressControl(setup, "confirm-action", {
						opens: "Force-close Consultation",
					});
					await pressControl(setup, "confirm-action", {
						shows: "force-closed; recovery resources remain recorded",
					});
					// The closed record moves out of the open history.
					const frame = await pressControl(setup, "history", {
						shows: "Close result: force-closed",
					});
					expect(frameText(frame)).toContain("Remaining resources");
					expect(frameText(frame)).toContain(`workspace ws-${short}`);
					const remaining = state.consultationRecord.consultationRemainingResources(FORCE_ID);
					expect(remaining.map((resource) => resource.kind).sort()).toEqual([
						"agent",
						"pane",
						"tab",
						"workspace",
					]);
					// The worktree survives the force close: retained, never deleted.
					const worktrees = state.consultationRecord
						.consultationResources(FORCE_ID)
						.filter((resource) => resource.kind === "worktree");
					expect(worktrees[0]).toMatchObject({ owned: false });
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("a missing or a failed Consultation closes directly, without a dialog", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// Neither record holds an Agent, so the close has nothing to confirm.
		const missing8 = MISSING_DIRECT_ID.slice(0, 8);
		const failed8 = FAILED_DIRECT_ID.slice(0, 8);
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, MISSING_DIRECT_ID, checkout, { agent: false });
		seed(state, FAILED_DIRECT_ID, checkout, { agent: false });
		state.consultationRecord.setConsultationState(
			MISSING_DIRECT_ID,
			"missing",
			"the Agent pane is gone",
		);
		state.consultationRecord.setConsultationState(
			FAILED_DIRECT_ID,
			"failed",
			"herdr refused the launch",
		);
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
					await guideKey(setup, "consultation-close", "Delete", { quiet: true });
					await frameUntil(setup, "the direct close", closed);
					// The closed row leaves the open list, so the cursor holds the
					// other one: it closes directly the same way.
					const otherMissing =
						state.consultationRecord.consultation(MISSING_DIRECT_ID)?.state === "closed";
					await frameUntil(setup, "the other Consultation under the cursor", (f) =>
						detailPaneText(f).includes(`State: ${otherMissing ? "failed" : "missing"}`),
					);
					await guideKey(setup, "consultation-close", "Delete", { quiet: true });
					const frame = await frameUntil(setup, "the second direct close", (f) =>
						messageRowOf(f).includes(`${otherMissing ? failed8 : missing8} closed`),
					);
					expect(state.consultationRecord.consultation(MISSING_DIRECT_ID)?.state).toBe("closed");
					expect(state.consultationRecord.consultation(FAILED_DIRECT_ID)?.state).toBe("closed");
					expect(frame).not.toContain("Close Consultation");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the Delete key on a closed Consultation removes it behind the confirmation", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CLOSED_DIRECT_ID, checkout);
		state.consultationRecord.settleConsultationTurn(CLOSED_DIRECT_ID, null, "done", {
			settledStatus: "idle",
		});
		state.consultationRecord.beginConsultationClose(CLOSED_DIRECT_ID);
		state.consultationRecord.finishConsultationClose(CLOSED_DIRECT_ID);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					await pressControl(setup, "history", { shows: "State: closed" });
					// The closed record answers the Delete key with the section's own
					// removal (ADR 0122): the record's removal outranks the close's
					// refusal, so the panel names what goes before anything leaves.
					await guideKey(setup, "consultation-delete", "Delete", {
						opens: `Delete Consultation ${CLOSED_DIRECT_ID.slice(0, 8)}`,
					});
					const frame = await pressControl(setup, "confirm-action", {
						shows: "deleted; backups may retain data",
					});
					expect(messageRowOf(frame)).toContain(
						`Consultation ${CLOSED_DIRECT_ID.slice(0, 8)} deleted; backups may retain data`,
					);
					expect(state.consultationRecord.consultation(CLOSED_DIRECT_ID)).toBeUndefined();
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("the close confirmation lets go of the keys when the Agent dies first", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const gone8 = CONFIRM_GONE_ID.slice(0, 8);
		// The Agent is alive at first: the observation loop matches its pane,
		// so the Consultation stays working until the list loses it.
		// The workspace of the dead Agent holds the Consultation's own tab and
		// pane alone, so the direct close takes the pane down and finishes.
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				fake.set("herdr", ["tab", "list", "--workspace", `ws-${gone8}`], {
					stdout: JSON.stringify({ result: { tabs: [{ tab_id: `tab-${gone8}` }] } }),
				});
				fake.set("herdr", ["pane", "list", "--workspace", `ws-${gone8}`], {
					stdout: JSON.stringify({
						result: { panes: [{ pane_id: `pane-${gone8}`, tab_id: `tab-${gone8}` }] },
					}),
				});
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: `pane-${gone8}`, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CONFIRM_GONE_ID, checkout);
		state.consultationRecord.setConsultationState(CONFIRM_GONE_ID, "working");
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					// The live Agent asks first: the confirmation stands open.
					await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
					// A refresh finds the Agent gone while the dialog is open, so
					// neither close branch draws any more and the panel must let go
					// of the keys it took.
					runner.agentListJson = agentListJson([]);
					// The release names its reason on the Message line: the record
					// moved out of the states the panel draws, so the panel stood
					// down instead of holding keys with nothing to show.
					const released = await frameUntil(setup, "the release reason on the Message line", (f) =>
						messageRowOf(f).includes("the Consultation moved to missing; the close panel closed"),
					);
					expect(detailPaneText(released)).toContain("State: missing");
					// A missing Consultation closes directly: the key reaches the
					// section, so no invisible panel was holding it.
					await guideKey(setup, "consultation-close", "Delete", { quiet: true });
					await frameUntil(setup, "the direct close after the panel let go", (f) =>
						messageRowOf(f).includes(`${gone8} closed`),
					);
					expect(state.consultationRecord.consultation(CONFIRM_GONE_ID)?.state).toBe("closed");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation geometry, privacy, and history through the UI", () => {
	test("a narrow terminal keeps the Consultation list beside the detail", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, `pane-${WORKING_ID.slice(0, 8)}`, "Agent: working");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
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
					const crossed = await crossCursor(setup, "tickets");
					// The shared detail pane follows the cursor to the Ticket side.
					expect(frameText(crossed)).toContain("no ticket selected");
					expect(crossed).toContain("┌─❯ Tickets");
				},
				{ width: 70, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("consultation history stays out of the ticket view and delete removes it", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CLOSED_ID, checkout);
		state.consultationRecord.settleConsultationTurn(CLOSED_ID, null, "secret output", {
			settledStatus: "idle",
		});
		state.consultationRecord.beginConsultationClose(CLOSED_ID);
		state.consultationRecord.finishConsultationClose(CLOSED_ID);
		try {
			await withApp(
				async (setup) => {
					// The ticket view never shows Consultation content.
					const tickets = await frameUntil(setup, "the ticket view", (f) =>
						f.includes("no ticket sources configured"),
					);
					expect(frameText(tickets)).not.toContain("secret output");
					// The closed Consultation is hidden from the open history by default.
					await toConsultations(setup, "the consultations view without open history", (f) =>
						f.includes("no open Consultations"),
					);
					// The closed history is reachable from the history cycle.
					await pressControl(setup, "history", { shows: "State: closed" });
					const detail = await frameUntil(setup, "the captured history", (f) =>
						detailPaneText(f).includes("secret output"),
					);
					expect(detailPaneText(detail)).toContain("Input 2026-09-01 10:00: review auth");
					// Delete removes the local history.
					await guideKey(setup, "consultation-delete", "Delete", { opens: "Delete Consultation" });
					await pressControl(setup, "confirm-action", { shows: "no closed Consultations" });
					expect(state.consultationRecord.consultation(CLOSED_ID)).toBeUndefined();
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation attention through the UI", () => {
	test("a newly settled turn rings once, and the startup reconciliation never rings", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		// The startup cycle finds the Agent still working: nothing settles.
		const bells = countBells();
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: answer one");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "working", seq: 1 }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: working"),
					);
					// One observation cycle already ran and saw the Agent working.
					await frameUntil(setup, "the observed Agent status", (f) =>
						f.includes("Agent status: working"),
					);
					expect(bells.count()).toBe(0);
					// The first newly settled turn rings exactly once.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 1 }]);
					await frameUntil(setup, "the settled turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
					// The Agent resumes work: the external turn reopens the cycle.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "working", seq: 2 }]);
					await frameUntil(setup, "the reopened turn", (f) => f.includes("State: working"));
					await sleep(150);
					expect(bells.count()).toBe(1);
					// The second newly settled turn rings once more.
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 3 }]);
					await frameUntil(setup, "the second settled turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					await sleep(150);
					expect(bells.count()).toBe(2);
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			bells.restore();
			state.close();
		}
	});
	test("a settle found by the startup reconciliation rings no bell", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		// The startup cycle finds the Agent already settled.
		const bells = countBells();
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: answer one");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "idle", seq: 1 }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
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
					await frameUntil(setup, "the reopened turn", (f) => f.includes("State: working"));
					runner.agentListJson = agentListJson([{ pane: paneId, status: "idle", seq: 3 }]);
					await frameUntil(setup, "the second settled turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			bells.restore();
			state.close();
		}
	});
	test("the cross takes the first Consultation row, and awaiting response wins", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// Creation order is future-dated so the wall-clock stamps of the state
		// transitions (now) stay older than every seeded created_at.
		const t = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
		await sleep(20);
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, FAILED_ID, checkout, { agent: false, createdAt: t(1) });
		state.consultationRecord.failConsultationOpening(FAILED_ID, "herdr refused the launch");
		seed(state, MISSING_ID, checkout, { agent: true, createdAt: t(3) });
		state.consultationRecord.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		seed(state, OPENING_ID, checkout, { agent: false, createdAt: t(2) });
		try {
			await withApp(
				async (setup) => {
					// Attention order puts the missing Agent above the failed
					// launch, and the cursor starts on the Consultation list
					// retained row: one step up is a boundary no-op.
					await crossCursor(setup, "consultations");
					const first = await settle(setup);
					expect(detailPaneText(first)).toContain("State: missing");
					expect(frameText(first)).toContain("Warning: the Agent pane is gone");
					// An awaiting response always wins the top row. The boot props
					// hold the observation off, so the Refresh key re-projects the
					// list; the new row takes the top and the cursor follows its
					// retained row. One more step up takes it.
					seed(state, AWAITING_ID, checkout, { agent: true, createdAt: t(4) });
					state.consultationRecord.settleConsultationTurn(AWAITING_ID, null, "answer", {
						settledStatus: "idle",
					});
					await pressControl(setup, "refresh", { quiet: true });
					await frameUntil(setup, "the awaiting row", (f) => f.includes("awaiting response: 1"));
					// The Refresh re-projection keeps the cursor on its retained
					// row; the list key returns it to the retained row of the
					// re-sorted list, and one step up takes the new first row. The
					// list's own bar names no way back to the list, so the key rides
					// the rig's named guide key.
					await guideKey(setup, "consultation-list", "h", { quiet: true });
					await frameUntil(
						setup,
						"the Consultation list",
						(f) =>
							!f.includes("\u250c\u2500\u276f Tickets") &&
							f.includes("\u250c\u2500\u276f Consultations"),
					);
					const selected = await pressControl(setup, "move-list", {
						via: "k",
						shows: "State: awaiting-response",
					});
					expect(detailPaneText(selected)).toContain("State: awaiting-response");
				},
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
	test("a Consultation that needs the operator adds no row to the compact frame", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${AWAITING_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: waiting");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(fake, agentListJson([{ pane: paneId, status: "idle" }]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, AWAITING_ID, checkout, { agent: true });
		state.consultationRecord.settleConsultationTurn(AWAITING_ID, null, "answer", {
			settledStatus: "idle",
		});
		try {
			await withApp(
				async (setup) => {
					// Normal size, tickets view: the attention line is reserved
					// and rendered.
					const normal = await frameUntil(setup, "the attention line in the tickets view", (f) =>
						f.includes("awaiting response: 1"),
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
				{ width: WIDTH, height: 32, plane: planeRecord },
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation live-worktree launch through the UI", () => {
	test("an existing checkout workspace receives the Consultation in a fresh tab", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { consultationTypes: liveGrillTypes },
			commands: stubLiveExistingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[
							"herdr workspace list",
							`herdr tab create --workspace ws-live --cwd ${checkout} --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the live launch sequence",
					);
					const [consultation] = state.consultationRecord.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.paneId).toBe("pane-c1");
					expect(consultation.workspaceId).toBe("ws-live");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	test("a Consultation type's context window rides on its agent start", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const planeRecord = await plane({
			existing: state,
			sources: [],
			config: {
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
			},
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubLiveCheckout(fake, checkout, false);
				stubLiveLaunchExisting(fake, checkout);
				// The count is part of the argv, so the stub that answers the
				// start names it: a Consultation that loses its context window
				// never reaches this answer and the launch below fails.
				fake.set(
					"herdr",
					[
						"agent",
						"start",
						AGENT,
						"--kind",
						"pi",
						"--pane",
						"pane-c1",
						"--",
						"--context",
						"131072",
					],
					{ stdout: JSON.stringify({ result: { agent: { session_id: "sess-c1" } } }) },
				);
				stubPaneReadText(fake, "pane-c1", "Agent: live answer");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[`herdr agent start ${AGENT} --kind pi --pane pane-c1 -- --context 131072`],
						"the live start with the count",
					);
					// The record keeps the count the Agent started with, so a
					// Restart of this Consultation keeps the room it ran in.
					const [consultation] = state.consultationRecord.consultations("open");
					expect(consultation.contextWindow).toBe("131072");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	test("a missing checkout workspace is created and uses its root pane", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { consultationTypes: liveGrillTypes },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubLiveCheckout(fake, checkout, false);
				stubLiveLaunchNew(fake, checkout);
				stubPaneReadText(fake, "pane-c1", "Agent: live answer");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const _checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					const [consultation] = state.consultationRecord.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.paneId).toBe("pane-c1");
					expect(consultation.workspaceId).toBe("ws-new");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	/**
	 * ADR 0060: the ignore moves a resting row, and it changes no fact - and no
	 * machine read follows the operator's List filter. The safety read that names
	 * who owns the live checkout takes the rows the machine reads, so with the
	 * filter cycled to the pile it still names every live Ticket: the one the
	 * operator judged out, which a read that dropped flagged rows would lose, and
	 * the one the pile does not draw at all, which a read that followed the view
	 * would lose. Neither conflict degrades to a bare Herdr Agent.
	 */
	test("every live checkout conflict is named whatever the List filter draws", async () => {
		let runner!: ConsultationRunner;
		const state = wrappedState();
		// Two Tickets work in this exact checkout: the judged-out one and the one
		// the operator left in the list. Both Agents are live; neither row's place
		// in the filter decides whether the safety read names it.
		const ignoredTicket = "github:github.com:I_9";
		const listedTicket = "github:github.com:I_7";
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch(
			{ name: "issues", kind: "github-issues" },
			fetchSuccess([
				issueTicket(ignoredTicket, { title: "Watch agent turns" }),
				issueTicket(listedTicket, { title: "Rank tickets by priority", externalKey: "#7" }),
			]),
		);
		for (const [identity, pane] of [
			[ignoredTicket, "pane-tick"],
			[listedTicket, "pane-rank"],
		] as const) {
			const claim = state.handoff.claimHandoff(
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
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: pane,
				tabId: `tab-${pane}`,
				workspaceId: `ws-${pane}`,
			});
		}
		expect(state.ticketWorkCycle.setTicketIgnored(ignoredTicket, true, null)).toEqual({ ok: true });
		const planeRecord = await plane({
			existing: state,
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/factory"],
						host: "github.com",
					},
					tickets: [
						ticketOf(issueTicket(ignoredTicket, { title: "Watch agent turns" })),
						ticketOf(
							issueTicket(listedTicket, {
								title: "Rank tickets by priority",
								externalKey: "#7",
							}),
						),
					],
				},
			],
			config: { consultationTypes: liveGrillTypes, maxParallelAgents: 4 },
			repos: { "github.com/acme/factory": "src/factory" },
			commands: stubLiveExistingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		const conflictList = JSON.stringify({
			result: {
				agents: [
					{
						pane_id: "pane-tick",
						tab_id: "tab-tick",
						workspace_id: "ws-tick",
						agent: "pi",
						agent_status: "working",
						name: agentNameFor({ identity: ignoredTicket, title: "Watch agent turns" }),
						checkout_path: checkout,
					},
					{
						pane_id: "pane-rank",
						tab_id: "tab-rank",
						workspace_id: "ws-rank",
						agent: "pi",
						agent_status: "working",
						name: agentNameFor({ identity: listedTicket, title: "Rank tickets by priority" }),
						checkout_path: checkout,
					},
				],
			},
		});
		runner.agentListJson = conflictList;
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					// The pile view: the drawn rows hold only the Ticket the operator
					// judged out, so the list the screen shows is not the list the
					// machine reads.
					const pile = await guideKey(setup, "ticket-filter", "f", { shows: "ignored: 1" });
					// Exactly one in-flight row stands in the drawn list: the judged-out one.
					const drawnRows = rowsOf(frameText(pile)).filter((row) =>
						row.includes("[running] [implement]"),
					);
					expect(drawnRows).toHaveLength(1);
					expect(drawnRows[0]).toContain("Watch age");
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					const panel = await frameUntil(setup, "the live checkout conflict panel", (f) =>
						f.includes("Live checkout conflict"),
					);
					// Both Tickets are named, not a bare Herdr Agent: the identity the
					// confirmation records is the same one the operator would read.
					expect(frameText(panel)).toContain(`Conflict: Ticket ${ignoredTicket}`);
					expect(frameText(panel)).toContain(`Conflict: Ticket ${listedTicket}`);
					expect(frameText(panel)).not.toContain("Conflict: Herdr Agent");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	/**
	 * ADR 0060: the launcher's repository choices come from the rows the machine
	 * reads, so a cycle of the operator's List filter moves nothing and
	 * re-validates nothing. The pile view draws only the Tickets the operator
	 * judged out, and one repository stands on a row the pile never shows while
	 * another stands only on a judged-out row: a catalog that followed the view
	 * would lose the first, and a catalog that dropped the flag would lose the
	 * second. The cycle visits all three choices, and it asks git for nothing new.
	 */
	test("the repository catalog holds every Ticket's repository across a filter cycle", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// Two repositories the config does not name, so the catalog can only learn
		// them from a Ticket's own row: one on a judged-out Ticket with live work,
		// one on a settled Ticket the pile leaves out.
		const judged = "github:github.com:I_9";
		const settled = "github:github.com:I_7";
		state.sourceFact.initializeSources([{ name: "issues", kind: "github-issues" }]);
		state.sourceFact.applyFetch(
			{ name: "issues", kind: "github-issues" },
			fetchSuccess([
				issueTicket(judged, {
					title: "Watch agent turns",
					repository: {
						identity: "github.com/acme/billing",
						displayName: "acme/billing",
						cloneUrl: "https://github.com/acme/billing.git",
					},
				}),
				issueTicket(settled, {
					title: "Rank tickets by priority",
					externalKey: "#7",
					repository: {
						identity: "github.com/acme/tools",
						displayName: "acme/tools",
						cloneUrl: "https://github.com/acme/tools.git",
					},
				}),
			]),
		);
		for (const identity of [judged, settled]) {
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
				paneId: `pane-${identity.slice(-1)}`,
				tabId: `tab-${identity.slice(-1)}`,
				workspaceId: `ws-${identity.slice(-1)}`,
			});
		}
		// One row the operator judged out, one row they left in the list: each
		// carries a repository no other row names.
		expect(state.ticketWorkCycle.setTicketIgnored(judged, true, null)).toEqual({ ok: true });
		const planeRecord = await plane({
			existing: state,
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/factory"],
						host: "github.com",
					},
					tickets: [
						ticketOf(
							issueTicket(judged, {
								title: "Watch agent turns",
								repository: {
									identity: "github.com/acme/billing",
									displayName: "acme/billing",
									cloneUrl: "https://github.com/acme/billing.git",
								},
							}),
						),
						ticketOf(
							issueTicket(settled, {
								title: "Rank tickets by priority",
								externalKey: "#7",
								repository: {
									identity: "github.com/acme/tools",
									displayName: "acme/tools",
									cloneUrl: "https://github.com/acme/tools.git",
								},
							}),
						),
					],
				},
			],
			config: { consultationTypes: liveGrillTypes },
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubLiveCheckout(fake, checkout, false);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					// The pile view: the drawn rows hold only the judged-out Ticket, so
					// acme/tools stands on no drawn row at all.
					await guideKey(setup, "ticket-filter", "f", { shows: "ignored: 1" });
					const validatedBefore = runner
						.commands()
						.filter((command) => command.includes("rev-parse")).length;
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await tabUntilSlot(setup, "\u276f Repository");
					// The selector's own walk: every choice it offers, collected as the
					// cycle moves. A repository the catalog lost is never visited.
					const choices = ["acme/billing", "acme/factory", "acme/tools"];
					const choiceOn = (frame: string): string | undefined =>
						choices.find((name) => frameText(frame).includes(`Repository ${name}`));
					const seen = new Set<string>();
					let current = await settle(setup);
					for (let step = 0; step < 3; step += 1) {
						const shown = choiceOn(current);
						if (shown !== undefined) seen.add(shown);
						await pressControl(setup, "cycle-choice", { quiet: true });
						current = await frameUntil(setup, "the next Repository", (f) => {
							const next = choiceOn(f);
							return next !== undefined && next !== shown;
						});
					}
					expect([...seen].sort()).toEqual(choices);
					// And the cycle asked git for nothing new: the catalog never turned
					// over, so no option was validated a second time.
					const validatedAfter = runner
						.commands()
						.filter((command) => command.includes("rev-parse")).length;
					expect(validatedAfter).toBe(validatedBefore);
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	test("a live checkout conflict blocks the launch until one explicit confirm", async () => {
		let runner!: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { consultationTypes: liveGrillTypes },
			commands: stubLiveExistingCheckout,
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		// A Herdr agent already works in this exact checkout.
		runner.agentListJson = JSON.stringify({
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
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					const panel = await frameUntil(setup, "the live checkout conflict panel", (f) =>
						f.includes("Live checkout conflict"),
					);
					expect(frameText(panel)).toContain("Conflict: Herdr Agent pi (pane-herdr)");
					expect(frameText(panel)).toContain("Confirm once to share this live checkout");
					// The Agent never starts while the panel is up.
					expect(runner.commands().join("\n")).not.toContain("agent start");
					const [consultation] = state.consultationRecord.consultations("open");
					expect(consultation.state).toBe("opening");
					// Confirm once: the launch proceeds and the override is recorded.
					await pressControl(setup, "confirm-action", { shows: "State: working" });
					await waitCommands(
						() => runner.commands(),
						[
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the confirmed launch sequence",
					);
					expect(state.consultationRecord.consultation(consultation.id)).toMatchObject({
						state: "working",
					});
					// The confirmation belongs to the checkout, not to the opening.
					expect(
						state.consultationRecord.confirmedCheckoutConflicts(realpathSync(checkout)),
					).toContain("pane-herdr");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
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
		let runner: ConsultationRunner;
		const state = wrappedState();
		const planeRecord = await plane({
			existing: state,
			sources: [],
			config: {
				consultationTypes: {
					"grill-live": {
						agent: "pi",
						environment: "live-worktree",
						model: "openai/gpt-4o",
						template: "/grill {input}",
					},
				},
			},
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubLiveCheckout(fake, checkout, false);
				stubLiveLaunchExisting(fake, checkout);
				// pi reports a list the Consultation type's Model is not in.
				fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		// The reads that resolve one Repository: the launcher makes them to
		// verify its option.
		const resolveReads = () =>
			runner.commands().filter((command) => command.includes("rev-parse --git-dir")).length;
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					const readsBeforeLaunch = resolveReads();
					await launchConsultationDraft(setup, "review auth");
					const refused = await frameUntil(setup, "the enqueue's refusal", (f) =>
						messageRowOf(f).includes("consultation not queued"),
					);
					expect(messageRowOf(refused)).toContain('has no model "openai/gpt-4o"');
					// No record and no queue item: the ask never entered the channel.
					expect(state.consultationRecord.consultations("all")).toEqual([]);
					expect(state.workQueue.items()).toEqual([]);
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
					expect(planeRecord.fakeRunner.modelListCalls).toEqual(["pi"]);
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	test("a dirty live checkout warns but never blocks the launch", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { consultationTypes: liveGrillTypes },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubLiveCheckout(fake, checkout, true);
				stubLiveLaunchNew(fake, checkout);
				stubPaneReadText(fake, "pane-c1", "Agent: live answer");
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const _checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					expect(frameText(setup.captureCharFrame())).not.toContain("Live checkout conflict");
					const [consultation] = state.consultationRecord.consultations("open");
					expect(consultation.state).toBe("working");
					expect(consultation.warning).toBe("the live checkout has uncommitted changes");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
	test("a live-worktree close confirms and names the checkout that stays", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// The live Consultation works in the operator's own checkout, so the
		// confirmation names the checkout as the resource the close keeps,
		// not the worktree and branch a worktree Consultation keeps.
		// The Agent is alive at the recorded pane: the observation loop keeps
		// the record working while the dialog stands.
		const { planeRecord } = await consultationBoot({
			state,
			config: { consultationTypes: liveGrillTypes },
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: `pane-${LIVE_CLOSE_ID.slice(0, 8)}`, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, LIVE_CLOSE_ID, checkout, {
			agent: true,
			createdAt: "2026-09-01T10:00:00.000Z",
			contextWindow: "",
			environment: "live-worktree",
		});
		state.consultationRecord.setConsultationState(LIVE_CLOSE_ID, "working");
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					// The live Agent asks first: the confirmation names the Agent
					// that is alive and the checkout the close keeps.
					await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
					const dialog = await settle(setup);
					expect(dialog).toContain("The Agent is working");
					expect(dialog).toContain("Close stops the Agent. The checkout stays.");
					expect(dialog).toContain("stop the Agent; the checkout stays");
					// A cancel leaves the state unchanged.
					await pressControl(setup, "cancel-action", { closes: "Close Consultation" });
					expect(state.consultationRecord.consultation(LIVE_CLOSE_ID)?.state).toBe("working");
				},
				{ width: WIDTH, height: 32, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});
});
describe("Consultation response gating by observed Agent status", () => {
	test("a blocked Agent takes Enter into interaction, with the exit key shown first", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: blocked on approval");
				stubPaneReadAnsi(fake, paneId, "agent: waiting for input");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "blocked" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, INTERACTION_ID, checkout);
		state.consultationRecord.settleConsultationTurn(INTERACTION_ID, null, "first answer", {
			settledStatus: "blocked",
		});
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The observed blocked status re-points the hints, and the
					// configured exit key is visible before any input is forwarded.
					const bar = await frameUntil(setup, "the blocked Agent hints", (f) =>
						frameText(f).includes("Enter Interact"),
					);
					expect(frameText(bar)).toContain("Enter Interact");
					await pressControl(setup, "consultation-interact", { shows: "F12 Exit interaction" });
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
					await pressControl(setup, "interact-exit", {
						shows: "left Agent interaction mode",
					});
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			state.close();
		}
	});
	test("an unblocked Agent keeps the response editor after a blocked turn", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// The last settled turn was blocked, but the Agent itself is idle now.
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: now idle");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(fake, agentListJson([{ pane: paneId, status: "idle" }]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, INTERACTION_ID, checkout);
		state.consultationRecord.settleConsultationTurn(INTERACTION_ID, null, "first answer", {
			settledStatus: "blocked",
		});
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: awaiting-response"),
					);
					// The gate is the observed status, not the last settled turn.
					await frameUntil(setup, "the idle Agent hints", (f) =>
						frameText(f).includes("Enter Respond"),
					);
					await pressControl(setup, "consultation-respond", { opens: "Response draft" });
					// The response editor owns mouse input too. A pane click must not
					// move focus behind it, which would change the next base mode when
					// the editor closes.
					await mouseClick(setup, 80, 5);
					await settle(setup);
					const afterEditor = await pressControl(setup, "close-form", { hides: "Response draft" });
					expect(afterEditor).toContain("┌─❯ Consultations");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			state.close();
		}
	});
	test("a forwarded input re-reads the pane before the next refresh tick", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: working");
				stubPaneReadAnsi(fake, paneId, "agent: typing...");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, INTERACTION_ID, checkout);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("State: working"),
					);
					await pressControl(setup, "consultation-interact", { shows: "F12 Exit interaction" });
					const ansiReads = () =>
						runner.commands().filter((c) => c.includes("--format ansi")).length;
					// The mount read plus one 250 ms tick: the timer is in phase.
					await waitUntil(() => ansiReads() >= 2, "the first interval refresh");
					await typeText(setup, "h");
					await waitCommands(
						() => runner.commands(),
						[`herdr pane send-text ${paneId} h`],
						"the forwarded key",
					);
					const sentAt = Date.now();
					// The input must not wait for the next 250 ms tick: a new
					// read arrives well before it could.
					while (ansiReads() < 3 && Date.now() - sentAt < 150) await sleep(5);
					expect(ansiReads()).toBeGreaterThanOrEqual(3);
					await pressControl(setup, "interact-exit", {
						shows: "left Agent interaction mode",
					});
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
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
	},
	{
		name: "f13",
		config: "f13" as const,
		label: "F13",
		// The mock helper exposes F1-F12 only; the rig's key route sends
		// Kitty's F13 code through the same renderer parser used by the
		// production terminal.
	},
] as const;
for (const exitCase of interactionExitCases) {
	test(`the configured ${exitCase.name} exits Agent interaction end to end`, async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${INTERACTION_ID.slice(0, 8)}`;
		const planeRecord = await plane({
			existing: state,
			sources: [],
			config: { consultationTypes: grillTypes, interactionExitKey: exitCase.config },
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				stubPaneReadText(fake, paneId, "Agent: working");
				stubPaneReadAnsi(fake, paneId, "agent: waiting for input");
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, INTERACTION_ID, checkout);
		try {
			await withApp(
				async (setup) => {
					await toConsultations(setup, "the Consultation section", (f) =>
						f.includes("State: working"),
					);
					await pressControl(setup, "consultation-interact", {
						shows: `${exitCase.label} Exit interaction`,
					});
					// The exit key the bar names runs the catalogue's own exit control; the
					// rig's key route sends the configured key.
					await pressControl(setup, "interact-exit", { quiet: true });
					await frameUntil(setup, "the interaction exit", (f) =>
						f.includes("left Agent interaction mode"),
					);
					expect(runner.commands().join("\n")).not.toContain("send-text");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "production" },
					rendererOptions: { kittyKeyboard: true },
				},
			);
		} finally {
			state.close();
		}
	});
}
describe("The full Consultation operator flow", () => {
	test("launch, settle, respond, blocked interaction, settle, close, and inspect the history", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const bells = countBells();
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
				stubWorktreeLaunch(fake, checkout);
				stubPaneReadText(fake, "pane-c1", "Agent: answer one");
				stubPaneReadAnsi(fake, "pane-c1", "agent: typing...");
				stubTopology(
					fake,
					"ws-new",
					["tab-ws-new"],
					[{ pane_id: "pane-c1", tab_id: "tab-ws-new" }],
				);
				fake.set("herdr", ["agent", "prompt", AGENT, "answer one"], { code: 0 });
				fake.set("herdr", ["workspace", "close", "ws-new"], { code: 0 });
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ ...launchedAgent, status: "working", seq: 1 }]),
				)),
		});
		const _checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					// Launch.
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					const id = state.consultationRecord.consultations("open")[0].id;
					// The opening turn settles and rings.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "idle", seq: 1 }]);
					await frameUntil(setup, "the settled opening turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					await sleep(150);
					expect(bells.count()).toBe(1);
					// a is plane-wide (issue #319, ADR 0111): it flips the mode
					// even from the Consultation section.
					await guideKey(setup, "auto-handoff", "a", { quiet: true });
					expect((await settle(setup)).match(/○ auto/g)).not.toBeNull();
					// The Agent is idle: Enter opens the response editor.
					await pressControl(setup, "consultation-respond", { opens: "Response draft" });
					await typeText(setup, "answer one");
					await sendResponseDraft(setup);
					await frameUntil(setup, "the working state", (f) => f.includes("State: working"));
					await waitCommands(
						() => runner.commands(),
						[`herdr agent prompt ${AGENT} answer one`],
						"the response prompt",
					);
					// The Agent goes blocked: the settled turn takes its status.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "blocked", seq: 2 }]);
					await frameUntil(setup, "the blocked settled turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					expect(state.consultationRecord.consultationTurns(id).at(-1)?.settledStatus).toBe(
						"blocked",
					);
					// Enter now opens interaction, not the response editor.
					await pressControl(setup, "consultation-interact", { shows: "F12 Exit interaction" });
					await typeText(setup, "h");
					await waitCommands(
						() => runner.commands(),
						[`herdr pane send-text pane-c1 h`],
						"the forwarded key",
					);
					await pressControl(setup, "interact-exit", {
						shows: "left Agent interaction mode",
					});
					// The Agent finishes on its own: the external turn opens and
					// settles, and rings once more.
					runner.agentListJson = agentListJson([{ ...launchedAgent, status: "idle", seq: 3 }]);
					await waitUntil(
						() =>
							state.consultationRecord.consultationTurns(id).length === 3 &&
							state.consultationRecord.consultationTurns(id).at(-1)?.settledAt !== null,
						"the external turn to settle",
					);
					expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
					expect(bells.count()).toBe(3);
					// Close stops the live Agent, so the confirmation asks first;
					// the confirm takes down the owned workspace.
					await guideKey(setup, "consultation-close", "Delete", { opens: "Close Consultation" });
					// The awaiting-response state names the Agent that answered and
					// now waits, and the body keeps the worktree and branch.
					const dialog = await settle(setup);
					expect(dialog).toContain("The Agent has answered and is waiting for your reply");
					expect(dialog).toContain("Close stops the Agent. The worktree and branch stay.");
					expect(dialog).toContain("stop the Agent; the work stays");
					await pressControl(setup, "confirm-action", { shows: `${id.slice(0, 8)} closed` });
					await waitCommands(
						() => runner.commands(),
						["herdr workspace close ws-new"],
						"the workspace cleanup",
					);
					expect(state.consultationRecord.consultation(id)?.state).toBe("closed");
					// The captured history keeps every turn in order.
					await pressControl(setup, "history", { shows: "State: closed" });
					const detail = await frameUntil(setup, "the captured history", (f) =>
						detailPaneText(f).includes("Captured history:"),
					);
					const history = detailPaneText(detail);
					expect(history).toContain("review auth");
					expect(history).toContain("answer one");
					expect(history).toContain("[external Agent input not captured]");
					expect(history).toContain("Agent: answer one");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			bells.restore();
			state.close();
		}
	});
	test("a launch stays on the launched Consultation, not on older attention", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		// An older Consultation already needs the operator. The launch must
		// not jump the view onto it: the operator is watching the one it
		// just created.
		const t = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
				stubWorktreeLaunch(fake, checkout);
				stubPaneReadText(fake, "pane-c1", "Agent: answer one");
				fake.set("herdr", ["agent", "prompt", AGENT, "answer one"], { code: 0 });
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ ...launchedAgent, status: "working", seq: 1 }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, MISSING_ID, checkout, { agent: true, createdAt: t(1) });
		state.consultationRecord.setConsultationState(MISSING_ID, "missing", "the Agent pane is gone");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await frameUntil(setup, "the launched Consultation working", (f) =>
						f.includes("State: working"),
					);
					expect(detailPaneText(frame)).toContain("State: working");
					expect(detailPaneText(frame)).not.toContain("State: missing");
				},
				{
					width: WIDTH,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 50 },
				},
			);
		} finally {
			state.close();
		}
	});
	test("a settling refresh cannot clear the Consultation's progress line", async () => {
		const state = wrappedState();
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
		state.sourceFact.initializeSources([{ name: sourceConfig.name, kind: sourceConfig.kind }]);
		state.sourceFact.applyFetch({ name: sourceConfig.name, kind: sourceConfig.kind }, outcome);
		const planeRecord = await plane({
			existing: state,
			sources: [{ config: sourceConfig, tickets: [] }],
			config: { consultationTypes: grillTypes },
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
				stubWorktreeLaunch(fake, checkout);
			},
			// The Consultation's own herdr command never answers, so the Consultation
			// stays in flight and its progress line holds the Message line. The
			// source's refresh runs on its own, so the two operations overlap.
			runner: (fake) =>
				new GatedRunner(
					new ConsultationRunner(fake, agentListJson([])),
					(command, args) =>
						command === "herdr" && args.includes("worktree") && args.includes("create"),
				),
		});
		const source = planeRecord.sources[0] as FakeSource;
		try {
			await withApp(
				async (setup) => {
					// The deterministic tickets keep the
					// observation loop off. The mount fetch answers with an
					// empty list, so the manual refresh below has an idle
					// source to start.
					source.settle(outcome);
					await frameUntil(setup, "the answered mount fetch", (f) =>
						f.includes("no tickets match the configured sources"),
					);
					await toConsultations(setup, "the Consultation section", (f) =>
						f.includes("no open Consultations"),
					);
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await launchConsultationDraft(setup, "review auth");
					// The launch proceeds: the Consultation holds the shared
					// detail, which stays up while the refresh runs beside it.
					await frameUntil(setup, "the Consultation detail", (f) =>
						detailPaneText(f).includes("State: opening"),
					);
					// The refresh runs from the Ticket list: on the
					// Consultation list, the opening row would take `r` as
					// its recovery key. The launch command stays in flight
					// on its own progress owner.
					await crossCursor(setup, "tickets");
					await pressControl(setup, "refresh", { quiet: true });
					const refreshing = await frameUntil(setup, "the refresh progress", (f) =>
						messageRowOf(f).includes("refreshing 1 sources"),
					);
					expect(messageRowOf(refreshing)).toContain("refreshing 1 sources");
					source.settle(outcome);
					// Its settle must not leave the line with the refresh
					// progress: the line returns to the launch progress or
					// goes blank.
					const returned = await frameUntil(
						setup,
						"the line without the refresh progress",
						(f) => !messageRowOf(f).includes("refreshing"),
					);
					expect(messageRowOf(returned)).not.toContain("refreshing");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
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
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${WORKING_ID.slice(0, 8)}`;
		const { dir, path } = seedRecord(WORKING_ID);
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "idle", record: path }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
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
					await frameUntil(setup, "the settled turn", (f) =>
						f.includes("State: awaiting-response"),
					);
					// g focuses the pane and reports on the Message line: a
					// navigation, not a Consultation change.
					await pressControl(setup, "consultation-goto", { shows: "focused the Agent pane" });
					expect(runner.commands()).toContain(`herdr agent focus ${paneId}`);
					expect(state.consultationRecord.consultation(WORKING_ID)?.state).toBe(
						"awaiting-response",
					);
					expect(state.consultationRecord.consultation(WORKING_ID)?.pendingResponse).toBeNull();
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			state.close();
		}
	});
	test("g names the workspace in the focus confirmation so the operator can switch herdr's view", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const short = WORKING_ID.slice(0, 8);
		const paneId = `pane-${short}`;
		const workspaceId = `ws-${short}`;
		const label = "factory-consultation-11111111";
		const { dir, path } = seedRecord(WORKING_ID);
		const { planeRecord } = await consultationBoot({
			state,
			commands: (fake, home) => {
				const _checkout = join(home, "src", "factory");
				fake.set("herdr", ["workspace", "get", workspaceId], {
					stdout: workspaceGetJson(workspaceId, label),
				});
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "idle", record: path }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, WORKING_ID, checkout);
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
					const frame = await pressControl(setup, "consultation-goto", { shows: "in workspace" });
					expect(messageRowOf(frame)).toContain(
						`Info: focused the Agent pane for Consultation ${short} in workspace ${label}`,
					);
					expect(runner.commands()).toContain(`herdr agent focus ${paneId}`);
					expect(runner.commands()).toContain(`herdr workspace get ${workspaceId}`);
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			state.close();
		}
	});
	test("a closed Consultation shows its record for the after-the-fact review, and g loses its pane when the poll drops it", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const closedId = uid("9");
		const paneId = `pane-${closedId.slice(0, 8)}`;
		const { dir, path } = seedRecord(closedId);
		// herdr still lists the Agent as done, with the record it wrote:
		// the closed detail can read it for the after-the-fact review.
		const { planeRecord } = await consultationBoot({
			state,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "done", record: path }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, closedId, checkout);
		state.consultationRecord.setConsultationState(closedId, "closed");
		try {
			await withApp(
				async (setup) => {
					// The closed Consultation sits in the closed history.
					await toConsultations(setup, "the consultations view", (f) =>
						f.includes("no open Consultations"),
					);
					await pressControl(setup, "history", { shows: "State: closed" });
					await frameUntil(setup, "the record the closed detail shows", (f) =>
						detailPaneText(f).includes("Session view:"),
					);
					const detail = detailPaneText(setup.captureCharFrame());
					expect(detail).toContain("❯ review auth");
					expect(detail).toContain("The design is sound.");
					// The pane leaves the last poll: the detail keeps the
					// record it read, and g answers its reason on the Message
					// line instead of focusing a pane herdr no longer lists.
					runner.agentListJson = agentListJson([]);
					await frameUntil(setup, "the poll without the pane", (f) =>
						detailPaneText(f).includes("Agent status: unknown"),
					);
					await pressControl(setup, "consultation-goto", {
						refuses: "the Agent's pane is not alive in the last poll",
					});
					expect(runner.commands()).not.toContain(`herdr agent focus ${paneId}`);
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
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
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await frameUntil(setup, "the queued notice", (f) =>
						messageRowOf(f).includes("consultation queued"),
					);
					// The record is durable in `queued` state: the launcher
					// closed it, the Consultation list shows it, and the
					// detail states the wait.
					const queued = state.consultationRecord
						.consultations("all")
						.find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					expect(queued.paneId).toBeNull();
					expect(queued.workspaceId).toBeNull();
					// The Consultation section lists the record under the ask
					// the operator typed, beside its state word: the same row
					// the cursor selected, whole at this width - 56 usable,
					// 23 for the marker and the state cell, 19 for the
					// repository and the start time, 11 for the input's first
					// line.
					expect(
						rowsOf(frame).some(
							(row) => row.startsWith("│") && row.includes("queued") && row.includes("review auth"),
						),
					).toBe(true);
					expect(detailPaneText(frame)).toContain("State: queued");
					// The Work queue section shows the item under the ask the
					// operator typed, beside the record's type word, and the
					// header carries the depth.
					expect(frame).toContain("waiting: 1");
					expect(rowsOf(frame).some((row) => row.includes("review auth"))).toBe(true);
					// The notice names the record and the queue it waits in.
					expect(messageRowOf(frame)).toContain(
						`consultation queued: ${queued.id.slice(0, 8)} waits in the Work queue for a free Parallel limit seat`,
					);
					// The queue holds the item, and the seat count stayed at
					// the cap: the record holds no seat until the pickup.
					const queue = state.workQueue.items();
					expect(queue).toHaveLength(1);
					expect(queue[0]).toEqual(
						expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
					);
					// The enqueue ran no external step: it is not a start.
					expectNoCommand(runner.commands(), "worktree create");
					expectNoCommand(runner.commands(), "agent start");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	/**
	 * The regression the full-cap pair guards against: the submit used to stand
	 * its "waits in the Work queue" line before the pickup pass ran, so a launch
	 * with a free seat claimed a wait the pickup was already taking. The notice
	 * now waits for the pickup's decision, and a record the pickup started
	 * stands the pickup's own line with the queue left empty.
	 */
	test("a launch with a free seat starts the Consultation and stands no waits line", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { maxParallelAgents: 1 },
			commands: stubOpenedCheckout,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: "pane-c1", status: "working", sess: "sess-c1" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					// The pickup pass runs in the submit itself and takes the free
					// seat: the record leaves `queued` on the key and settles
					// `working`, the way a direct start would.
					await frameUntil(setup, "the picked-up Consultation working", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					// The pickup ran the launch, the way a direct start does.
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the pickup's launch sequence",
					);
					// The record is not `queued`, and the pickup took its item on the
					// submit, so the durable queue is empty.
					const settled = state.consultationRecord
						.consultations("all")
						.find((c) => c.state !== "closed");
					expect(settled).toBeDefined();
					if (settled === undefined) throw new Error("the Consultation is not recorded");
					expect(settled.state).not.toBe("queued");
					expect(state.workQueue.items()).toHaveLength(0);
					// The regression the launch guards: the submit used to stand its
					// "waits in the Work queue" line before the pickup ran, so a launch
					// with a free seat could claim a wait the queue no longer held. Walk
					// the settled frames and hold the invariant the user saw broken -
					// the waits line never stands over an empty Work queue.
					await pickupFrameWalk(setup, state);
					// The line that stands once the record works is the pickup's, not
					// a waits line the queue no longer holds.
					const settledFrame = setup.captureCharFrame();
					expect(settledFrame).not.toContain("waits in the Work queue");
					expect(messageRowOf(settledFrame)).not.toContain("consultation queued");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
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
		let runner: ConsultationRunner;
		const state = wrappedState();
		// No seeded Consultation: nothing holds the one seat.
		state.workQueue.setQueuePaused(true);
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const _checkout = join(planeRecord.home, "src", "factory");
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					const frame = await frameUntil(setup, "the queued notice", (f) =>
						messageRowOf(f).includes("consultation queued"),
					);
					const queued = state.consultationRecord
						.consultations("all")
						.find((c) => c.state === "queued");
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
					expect(state.workQueue.items()).toEqual([
						expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
					]);
					expectNoCommand(runner.commands(), "worktree create");
					expectNoCommand(runner.commands(), "agent start");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the Delete key takes a queued Consultation's item out of the queue, and the record stays", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const paneId = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: paneId, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the queued notice", (f) =>
						messageRowOf(f).includes("consultation queued"),
					);
					const queued = state.consultationRecord
						.consultations("all")
						.find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					const gone8 = queued.id.slice(0, 8);
					// The cursor stands on the new record: the submit selected it.
					expect(detailPaneText(setup.captureCharFrame())).toContain("State: queued");
					// A queued record holds no Agent to stop (ADR 0122): the Delete
					// key gives the Consultation section the queue's removal, which
					// takes the Work queue item out without confirmation. The record
					// stays `unscheduled` behind the row it loses, and nothing
					// cleans up: no panel, no pane or workspace command.
					await guideKey(setup, "consultation-delete", "Delete", {
						shows: `${gone8}: removed from the queue`,
					});
					expect(messageRowOf(setup.captureCharFrame())).toContain(
						`consultation ${gone8}: removed from the queue; the record is unscheduled`,
					);
					expect(state.consultationRecord.consultation(queued.id)?.state).toBe("unscheduled");
					expect(state.workQueue.items()).toHaveLength(0);
					expectNoCommand(runner.commands(), "pane close");
					expectNoCommand(runner.commands(), "workspace close");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the pickup at a freed seat starts the queued Consultation", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: stubOpenedCheckout,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: seatPane, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the queued notice", (f) =>
						messageRowOf(f).includes("consultation queued"),
					);
					const queued = state.consultationRecord
						.consultations("all")
						.find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					// The launched Agent's pane joins the poll's list, so the
					// pickup's start verifies on the next cycle.
					runner.agentListJson = agentListJson([
						{ pane: seatPane, status: "working" },
						{ pane: "pane-c1", status: "working", sess: "sess-c1" },
					]);
					// Free the seat: the record leaves the states that hold one.
					state.consultationRecord.setConsultationState(seatId, "awaiting-response");
					// The pickup crosses to the Consultation operations, the
					// start runs the opening pipeline, and the detail settles
					// on the record's new state.
					await frameUntil(setup, "the picked-up Consultation working", (f) =>
						detailPaneText(f).includes("State: working"),
					);
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the pickup's launch sequence",
					);
					// The item left the queue with the record out of `queued`.
					expect(state.workQueue.items()).toHaveLength(0);
					expect(
						queued === undefined
							? undefined
							: state.consultationRecord.consultation(queued.id)?.state,
					).toBe("working");
					// The seat freed once: the seed's record rests in
					// awaiting-response and holds none.
					expect(state.consultationRecord.consultation(seatId)?.state).toBe("awaiting-response");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
					loopPolicy: { kind: "polled", intervalMs: 100 },
				},
			);
		} finally {
			state.close();
		}
	});
	test("Enter on the queue item force-dispatches the Consultation over the cap", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: stubOpenedCheckout,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: seatPane, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					await frameUntil(setup, "the verified Repository option", (f) =>
						f.includes("acme/factory"),
					);
					await launchConsultationDraft(setup, "review auth");
					await frameUntil(setup, "the queued notice", (f) =>
						messageRowOf(f).includes("consultation queued"),
					);
					const queued = state.consultationRecord
						.consultations("all")
						.find((c) => c.state === "queued");
					expect(queued).toBeDefined();
					if (queued === undefined) throw new Error("the queued Consultation is not recorded");
					const id8 = queued.id.slice(0, 8);
					// The cap is full from the boot: the seed's seat stands on the
					// line. The frame holds no room for the Work section's rows,
					// so it rests collapsed, and Enter on the queued row jumps to
					// its item and expands the section with it (ADR 0049).
					expect(setup.captureCharFrame()).toContain("● manual 1/1");
					await pressControl(setup, "queue-jump", { moved: "queue" });
					// Enter force-dispatches the item over the full cap: the line
					// names the cap, the seat count stands over the limit, the item
					// leaves the queue, and the start runs the real external steps.
					await pressControl(setup, "queue-force-dispatch", { shows: "force-dispatched" });
					// The line names the cap, and the seat count stands over the
					// limit: the seed's seat plus the start the force-dispatch took.
					await frameUntil(setup, "the seat over the cap", (f) => f.includes("● manual 2/1"));
					expect(messageRowOf(setup.captureCharFrame())).toContain(
						`force-dispatched Consultation ${id8} over the Parallel limit`,
					);
					await waitCommands(
						() => runner.commands(),
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
					expect(state.workQueue.items()).toHaveLength(0);
					expect(state.consultationRecord.consultation(queued.id)?.state).not.toBe("queued");
					expect(state.consultationRecord.consultation(seatId)?.state).toBe("working");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
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
		await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
		await frameUntil(setup, "the verified Repository option", (f) => f.includes("acme/factory"));
		await launchConsultationDraft(setup, "review auth");
		await frameUntil(setup, "the queued notice", (f) =>
			messageRowOf(f).includes("consultation queued"),
		);
		const queued = state.consultationRecord.consultations("all").find((c) => c.state === "queued");
		if (queued === undefined) throw new Error("the queued Consultation is not recorded");
		// The frame holds no room for the Work section's rows, so it rests
		// collapsed, and Enter on the queued row jumps to its item and
		// expands the section with it (ADR 0049).
		await pressControl(setup, "queue-jump", { moved: "queue" });
		// The item's row stands under the kind word, with the record's identity.
		const frame = setup.captureCharFrame();
		expect(frame).toContain("consultation");
		expect(frame).toContain(queued.id.slice(0, 8));
		// Delete removes the item, not the ask: the record moves to
		// `unscheduled`, and the Message line says both.
		const removed = await guideKey(setup, "queue-remove", "Delete", {
			shows: "removed from the queue",
		});
		expect(messageRowOf(removed)).toContain(
			`consultation ${queued.id.slice(0, 8)}: removed from the queue; the record is unscheduled`,
		);
		expect(state.workQueue.items()).toHaveLength(0);
		expect(state.consultationRecord.consultation(queued.id)?.state).toBe("unscheduled");
		// The record keeps standing in the Consultation section: the row
		// carries its state, its type, and its repository.
		await crossCursor(setup, "consultations");
		const section = setup.captureCharFrame();
		expect(section).toContain("unscheduled");
		expect(section).toContain("grill");
		expect(section).toContain("acme/factory");
		// The seed's working record is listed in the section too, and it sorts
		// ahead of the unscheduled ask: the walk steps the cursor down to the
		// unscheduled row, the one every test works on.
		for (let step = 0; step < 10; step += 1) {
			if (detailPaneText(setup.captureCharFrame()).includes("State: unscheduled")) break;
			await pressControl(setup, "move-list", { via: "j", quiet: true });
			await settle(setup, 200);
		}
		expect(detailPaneText(setup.captureCharFrame())).toContain("State: unscheduled");
		return queued.id;
	}
	test("removing the queue item unschedules the record, and the record keeps standing", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
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
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the Consultation section schedules the unscheduled record back into the queue", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// `s` schedules the record back: it returns to `queued` with
					// its item at the queue's tail, and the line names the place.
					const scheduled = await guideKey(setup, "consultation-schedule", "s", {
						shows: `Consultation ${id.slice(0, 8)} scheduled`,
					});
					expect(messageRowOf(scheduled)).toContain(
						`Consultation ${id.slice(0, 8)} scheduled: it waits at the end of the Work queue`,
					);
					expect(state.consultationRecord.consultation(id)?.state).toBe("queued");
					expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([id]);
					// The queue rows re-read in the same key: the item stands in
					// the Work queue section at the place the line names. The
					// section still stands expanded from the walk, so the
					// cursor's cross down from the section's last row lands on
					// its item.
					const inQueue = await pressControl(setup, "move-list", { via: "j", moved: "queue" });
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
						await pressControl(setup, "move-list", { via: "k", quiet: true });
						await settle(setup, 200);
					}
					const backFrame = setup.captureCharFrame();
					expect(backFrame).toContain("┌─❯ Consultations");
					expect(backFrame).not.toContain("┌─❯ Work queue");
					// A second `s` says the record already waits: the schedule
					// refuses in the section's words, and the record stands where
					// it stands.
					await guideKey(setup, "consultation-schedule", "s", {
						refuses: "already waits in the Work queue",
					});
					expect(state.consultationRecord.consultation(id)?.state).toBe("queued");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the Consultation section starts the unscheduled record now, over the cap", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: stubOpenedCheckout,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: seatPane, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// The cap stands full from the boot: the seed's seat is the
					// line, and Enter starts the record over it.
					expect(setup.captureCharFrame()).toContain("● manual 1/1");
					const started = await pressControl(setup, "consultation-start-now", {
						shows: "starting Consultation",
					});
					expect(messageRowOf(started)).toContain(
						`starting Consultation ${id.slice(0, 8)} over the Parallel limit`,
					);
					// The seat count stands over the limit: the seed's seat plus
					// the seat the start took over the cap.
					await frameUntil(setup, "the seat over the cap", (f) => f.includes("● manual 2/1"));
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the start-now launch sequence",
					);
					expect(state.consultationRecord.consultation(id)?.state).not.toBe("unscheduled");
					expect(state.consultationRecord.consultation(seatId)?.state).toBe("working");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the Consultation section starts the unscheduled record now, under the cap", async () => {
		let runner: ConsultationRunner;
		const state = wrappedState();
		const seatPane = `pane-${seatId.slice(0, 8)}`;
		const { planeRecord } = await consultationBoot({
			state,
			config: { maxParallelAgents: 1 },
			commands: stubOpenedCheckout,
			runner: (fake) =>
				(runner = new ConsultationRunner(
					fake,
					agentListJson([{ pane: seatPane, status: "working" }]),
				)),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// Free the seat the queue walk held: the line then names no
					// cap, because the seat count stood under the limit at the
					// key, the way the queue's force-dispatch line does.
					state.consultationRecord.setConsultationState(seatId, "awaiting-response");
					// The write lands in the state the app reads live but re-renders
					// nothing: step the cursor up to the seed's row and back, so the
					// mode cell re-reads the freed seat count before the key runs.
					await pressControl(setup, "move-list", { via: "k", shows: "● manual 0/1" });
					await pressControl(setup, "move-list", { via: "j", shows: "State: unscheduled" });
					const started = await pressControl(setup, "consultation-start-now", {
						shows: "starting Consultation",
					});
					const line = messageRowOf(started);
					expect(line).toContain(`starting Consultation ${id.slice(0, 8)}`);
					expect(line).not.toContain("over the Parallel limit");
					// The start took the only free seat.
					await frameUntil(setup, "the start's seat", (f) => f.includes("● manual 1/1"));
					await waitCommands(
						() => runner.commands(),
						[
							`herdr worktree create --cwd ${checkout} --branch ${BRANCH} --base origin/main --no-focus`,
							`herdr agent start ${AGENT} --kind pi --pane pane-c1`,
							`herdr agent prompt ${AGENT} /grill review auth`,
						],
						"the start-now launch sequence",
					);
					expect(state.consultationRecord.consultation(id)?.state).not.toBe("unscheduled");
					expect(state.consultationRecord.consultation(seatId)?.state).toBe("awaiting-response");
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
	test("the Consultation section deletes the unscheduled record", async () => {
		let runner: ConsultationRunner;
		const { state, planeRecord } = await consultationBoot({
			config: { maxParallelAgents: 1 },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				stubCheckout(fake, checkout);
			},
			runner: (fake) => (runner = new ConsultationRunner(fake, agentListJson([]))),
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, seatId, checkout);
		try {
			await withApp(
				async (setup) => {
					const id = await unscheduleThroughTheQueue(setup, state);
					// The Delete key asks first: the removal takes the record
					// and its history, and nothing else can run behind it.
					await guideKey(setup, "consultation-delete", "Delete", {
						opens: `Delete Consultation ${id.slice(0, 8)}`,
					});
					const frame = await pressControl(setup, "confirm-action", {
						shows: "deleted; backups may retain data",
					});
					expect(messageRowOf(frame)).toContain(
						`Consultation ${id.slice(0, 8)} deleted; backups may retain data`,
					);
					expect(state.consultationRecord.consultation(id)).toBeUndefined();
				},
				{
					width: WIDTH,
					height: 32,
					plane: planeRecord,
				},
			);
		} finally {
			state.close();
		}
	});
});
