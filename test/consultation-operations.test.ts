/**
 * The whole Consultation lifecycle through one interface, with no terminal.
 *
 * Every test drives the Consultation operations module the way the control
 * plane does: a fake command runner that records the exact herdr and git calls,
 * a real SQLite state file that holds the durable record, and stub callbacks
 * that collect the facts the view gets back. Together they pin what issue #33
 * asked for: launch and its stages, the live checkout conflict and its
 * per-checkout confirmed set, recovery of an interrupted opening, response
 * delivery and its failure, close topology and retry, Force-close and the guard
 * it shares with close, Replacement bounds and linking, deletion, the Stale
 * Agent output warning, and the ordered interaction input queue.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CHECKOUT_ROW_OVER_BUDGET_FACT,
	type CheckoutGate,
	type ConsultationCheckoutHold,
} from "../src/checkout-hold.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { ConfigWriteReport } from "../src/config-write.ts";
import type { ConsultationRepositoryOption } from "../src/consultation/checkout-safety.ts";
import { CONSULTATION_INPUT_LIMIT } from "../src/consultation/response-draft.ts";
import { STALE_AGENT_OUTPUT_WARNING } from "../src/consultation/warning-facts.ts";
import {
	type ConsultationOperations,
	type ConsultationSafetyConflict,
	type ConsultationStatus,
	createConsultationOperations,
} from "../src/consultation-operations.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { createHandoffDispatch } from "../src/handoff-dispatch.ts";
import type { Logger } from "../src/logging.ts";
import { consultationBranchName } from "../src/naming.ts";
import type { RepositoryMapping } from "../src/repo.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/runner.ts";
import type { Consultation } from "../src/state/consultation-record.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import { utf8ByteLength } from "../src/text-bounds.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { expectNoCommand } from "./command-assertions.ts";
import {
	agentListJson,
	FakeRunner,
	herdrFocusCommands,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
	worktreeListJson,
} from "./fake-runner.ts";
import { type HerdrWorldDescription, stubHerdrWorld } from "./herdr-world.ts";
import { infoLine, type RecordedLine, recordLogger } from "./record-logger.ts";

const directories: string[] = [];
const states: FactoryState[] = [];

afterEach(() => {
	for (const state of states.splice(0)) state.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** A deterministic Consultation id, so its branch and Agent name are pinnable. */
const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;
/** The herdr name the seed gives a Consultation with that id. */
const agentOf = (id: string) => `consultation-${id.slice(0, 8)}`;
/** The pane, tab, and workspace handles a launched worktree Consultation takes. */
/**
 * The world's worktree-launch handles: a `worktree create` makes the workspace,
 * its one tab, and the Agent's pane together, so the Agent sits in the first pane.
 */
const WORKTREE_LAUNCH = { workspaceId: "ws-1", tabId: "tab-1", paneId: "pane-1" };
/** The standing the pinned launch leaves behind, named by the pin table. */
const LAUNCH = { workspaceId: "ws-new", tabId: "tab-ws-new", paneId: "pane-c1" };
const WORKTREE_HEAD = "deadbeef";

interface Fixture {
	state: FactoryState;
	config: FactoryConfig;
	home: string;
	checkout: string;
	otherCheckout: string;
	repository: ConsultationRepositoryOption;
	otherRepository: ConsultationRepositoryOption;
}

/** A real state file, a config with two mapped Repositories, and two checkouts. */
function makeFixture(model = ""): Fixture {
	const home = mkdtempSync(join(tmpdir(), "factory-consultation-operations-"));
	directories.push(home);
	const checkout = join(home, "src", "factory");
	const otherCheckout = join(home, "src", "other");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(otherCheckout, { recursive: true });
	const state = openFactoryState(join(home, "state.sqlite"));
	states.push(state);
	const repository = {
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
		path: checkout,
	};
	return {
		state,
		config: {
			...BASE_CONFIG,
			repos: {
				"github.com/acme/factory": checkout,
				"github.com/acme/other": otherCheckout,
			},
			consultationTypes: {
				grill: { agent: "pi", environment: "worktree", model, template: "/grill {input}" },
				"grill-live": {
					agent: "pi",
					environment: "live-worktree",
					model,
					template: "/grill {input}",
				},
			},
		},
		home,
		checkout,
		otherCheckout,
		repository,
		otherRepository: {
			identity: "github.com/acme/other",
			displayName: "acme/other",
			cloneUrl: "https://github.com/acme/other.git",
			path: otherCheckout,
		},
	};
}

interface Seed {
	environment?: "worktree" | "live-worktree";
	typeName?: string;
	repository?: ConsultationRepositoryOption;
	input?: string;
}

/** Create the durable opening record the module takes over from the view. */
function seed(state: FactoryState, fixture: Fixture, id: string, over: Seed = {}): Consultation {
	const environment = over.environment ?? "worktree";
	const repository = over.repository ?? fixture.repository;
	const typeName = over.typeName ?? (environment === "live-worktree" ? "grill-live" : "grill");
	const type = fixture.config.consultationTypes[typeName];
	return state.consultationRecord.createConsultation({
		id,
		typeName,
		agentType: type.agent,
		environment,
		model: type.model ?? "",
		template: "/grill {input}",
		initialInput: over.input ?? "review auth",
		renderedOpeningPrompt: `/grill ${over.input ?? "review auth"}`,
		repository,
		agentName: agentOf(id),
		createdAt: "2026-09-01T00:00:00.000Z",
	});
}

/** Move a fresh opening record to `working` with its herdr handles. */
function startAgent(state: FactoryState, id: string, handles = LAUNCH): void {
	state.consultationRecord.setConsultationAgent(id, {
		paneId: handles.paneId,
		tabId: handles.tabId,
		workspaceId: handles.workspaceId,
		sessionId: `sess-${id.slice(0, 8)}`,
	});
}

/** Record the resources a worktree launch owns, as the module's launch does. */
function seedResources(state: FactoryState, id: string, handles = LAUNCH): void {
	const agentName = agentOf(id);
	state.consultationRecord.recordConsultationResource(id, {
		kind: "workspace",
		resourceId: handles.workspaceId,
		owned: true,
		details: "Consultation worktree workspace",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "worktree",
		resourceId: handles.workspaceId,
		owned: true,
		details: `Consultation worktree checkout for ${consultationBranchName(id, "grill")}`,
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "tab",
		resourceId: handles.tabId,
		owned: true,
		details: "Consultation worktree tab",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "pane",
		resourceId: handles.paneId,
		owned: true,
		details: "Consultation Agent pane",
	});
	state.consultationRecord.recordConsultationResource(id, {
		kind: "agent",
		resourceId: agentName,
		owned: true,
		details: `Agent hosted by pane ${handles.paneId}`,
	});
}

/**
 * The egress double the operations suites inject: the fake command runner
 * and the Stub herdr world both stand it.
 */
interface EgressDouble extends CommandRunner {
	commands(): string[];
	set(command: string, args: readonly string[], result: Partial<CommandResult>): void;
	setSequence(
		command: string,
		args: readonly string[],
		results: readonly Partial<CommandResult>[],
	): void;
	setModelList(kind: string, models: readonly string[]): void;
	readonly modelListCalls: string[];
}

/** The Module runner: a fake that records, answers, and can hold one call. */
class LifecycleRunner implements CommandRunner {
	/** Every command attempted, in order, including a command still held. */
	readonly attempts: string[] = [];
	/** The answers the double holds, and the source of every recorded command. */
	readonly inner: EgressDouble;
	private waiting: (() => void)[] = [];
	private hold: ((command: string) => boolean) | null = null;

	constructor(inner: EgressDouble = new FakeRunner()) {
		this.inner = inner;
	}

	/** Hold every matching command until `release` runs. */
	holdWhile(match: (command: string) => boolean): void {
		this.hold = match;
	}

	release(): void {
		this.hold = null;
		const waiting = this.waiting.splice(0);
		for (const resolve of waiting) resolve();
	}

	commands(): string[] {
		return this.inner.commands();
	}

	async run(
		command: string,
		args: readonly string[],
		options?: CommandOptions,
	): Promise<CommandResult> {
		const text = `${command} ${args.join(" ")}`;
		this.attempts.push(text);
		if (this.hold?.(text) === true) {
			await new Promise<void>((resolve) => {
				this.waiting.push(resolve);
			});
		}
		return this.inner.run(command, args, options);
	}

	listModels(kind: string) {
		return this.inner.listModels(kind);
	}
}

/** A progress line with the Consultation id the module named as its owner. */
interface ProgressReport {
	text: string;
	owner: string;
}

/** What the module reported to the view, collected for the assertions. */
interface Harness {
	operations: ConsultationOperations;
	/** Every status the module reported, including the clear that ends one. */
	reported: (ConsultationStatus | null)[];
	/** The statuses with text, in the order the operator would have read them. */
	statuses: ConsultationStatus[];
	/** Each time the safety-conflict fact opened the confirmation panel. */
	conflicts: ConsultationSafetyConflict[];
	/** Each time the durable Consultation projection changed. */
	changes: number;
	/** Each progress line the module reported, with its owning Consultation id. */
	progress: ProgressReport[];
}

/** Wire the module to a fixture, collecting the facts its callbacks report. */
function makeHarness(
	fixture: Fixture,
	runner: CommandRunner,
	options: {
		home?: string;
		tickets?: () => readonly Ticket[];
		persistRepositoryMapping?: (
			mapping: RepositoryMapping,
		) => Promise<ConfigWriteReport | undefined>;
		textBatchBytes?: number;
		/** The seat count the module's start line states (issue #220). */
		seatCount?: () => number;
		/** The logger the module's record lines are read back from. */
		log?: Logger;
		/** The Shared checkout hold the module's worktree start crosses (issue #315). */
		checkoutHold?: ConsultationCheckoutHold;
	} = {},
): Harness {
	const reported: (ConsultationStatus | null)[] = [];
	const statuses: ConsultationStatus[] = [];
	const progress: ProgressReport[] = [];
	const conflicts: ConsultationSafetyConflict[] = [];
	const harness: Harness = {
		operations: createConsultationOperations({
			state: fixture.state,
			runner,
			config: () => fixture.config,
			home: options.home ?? fixture.home,
			tickets: options.tickets ?? (() => []),
			seatCount: options.seatCount ?? (() => 0),
			log: options.log,
			persistRepositoryMapping: options.persistRepositoryMapping,
			textBatchBytes: options.textBatchBytes,
			checkoutHold: options.checkoutHold,
			callbacks: {
				onStatus: (status) => {
					reported.push(status);
					if (status !== null) statuses.push(status);
				},
				onProgress: (text, owner) => {
					if (text !== null) progress.push({ text, owner });
				},
				onConsultationsChanged: () => {
					harness.changes += 1;
				},
				onSafetyConflict: (conflict) => {
					conflicts.push(conflict);
				},
			},
		}),
		reported,
		statuses,
		conflicts,
		changes: 0,
		progress,
	};
	return harness;
}

/** The checkout the fixture maps, stated as a world. */
function worldCheckout(
	repository: ConsultationRepositoryOption,
	dirty = false,
): HerdrWorldDescription {
	return {
		checkouts: [
			{
				path: repository.path,
				cloneUrl: repository.cloneUrl,
				defaultBranch: "main",
				dirty,
			},
		],
	};
}

/** Both checkouts the fixture maps, stated as a world. */
function bothCheckoutsWorld(fixture: Fixture, dirty = false): HerdrWorldDescription {
	const world = worldCheckout(fixture.repository, dirty);
	world.checkouts.push({
		path: fixture.otherRepository.path,
		cloneUrl: fixture.otherRepository.cloneUrl,
		defaultBranch: "main",
	});
	return world;
}

/** The standing a pinned worktree launch leaves behind, stated as a world. */
function worktreeLaunchWorld(
	repository: ConsultationRepositoryOption,
	handles: Array<typeof LAUNCH> = [LAUNCH],
): HerdrWorldDescription {
	const world = worldCheckout(repository);
	const worktreesRoot = join(
		repository.path.slice(0, repository.path.lastIndexOf("/")),
		"worktrees",
	);
	world.workspaces = handles.map((item) => ({
		id: item.workspaceId,
		checkoutPath: join(worktreesRoot, item.workspaceId),
		isWorktree: true,
	}));
	world.tabs = handles.map((item) => ({ id: item.tabId, workspaceId: item.workspaceId }));
	world.panes = handles.map((item) => ({
		id: item.paneId,
		tabId: item.tabId,
		workspaceId: item.workspaceId,
	}));
	return world;
}

/**
 * The standing a world-run worktree launch starts from: the checkout and its
 * worktrees root, no workspace. The world's own `worktree create` builds the
 * workspace, the tab, and the Agent's pane.
 */
function worktreeLaunchStanding(repository: ConsultationRepositoryOption): HerdrWorldDescription {
	const world = worldCheckout(repository);
	world.checkouts[0].worktreesRoot = join(
		repository.path.slice(0, repository.path.lastIndexOf("/")),
		"worktrees",
	);
	return world;
}

/** The standing a pinned live launch leaves behind, stated as a world. */
function liveLaunchWorld(
	repository: ConsultationRepositoryOption,
	workspaceId: string,
	dirty = false,
): HerdrWorldDescription {
	const world = worldCheckout(repository, dirty);
	world.workspaces = [{ id: workspaceId, checkoutPath: repository.path }];
	world.tabs = [{ id: LAUNCH.tabId, workspaceId, cwd: repository.path }];
	world.panes = [{ id: LAUNCH.paneId, tabId: LAUNCH.tabId, workspaceId }];
	return world;
}

/** Stub the whole worktree launch at a checkout, down to the prompt. */
function stubWorktreeLaunch(
	runner: EgressDouble,
	checkout: string,
	id: string,
	fields: { handles?: typeof LAUNCH; displayName?: string } = {},
): void {
	const { handles = LAUNCH } = fields;
	const branch = consultationBranchName(id, "grill");
	runner.set("git", ["-C", checkout, "branch", "--list", branch], { stdout: "" });
	// The worktree base rule: the origin/HEAD symref names the default
	// branch, the fetch of its single ref succeeds, and the base is the
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
		{ stdout: worktreeCreateJson(handles.workspaceId, handles.paneId) },
	);
	// herdr answers the start with its session handle.
	runner.set("herdr", ["agent", "start", agentOf(id), "--kind", "pi", "--pane", handles.paneId], {
		stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }),
	});
	runner.set("herdr", ["agent", "prompt", agentOf(id), `/grill review auth`], { code: 0 });
}

/** Stub the live launch into a workspace herdr already holds at the checkout. */
function stubLiveLaunch(
	runner: EgressDouble,
	checkout: string,
	id: string,
	workspaceId = "ws-live",
): void {
	const agent = agentOf(id);
	runner.set("herdr", ["workspace", "list"], {
		stdout: JSON.stringify({
			result: {
				workspaces: [{ workspace_id: workspaceId, worktree: { checkout_path: checkout } }],
			},
		}),
	});
	runner.set(
		"herdr",
		["tab", "create", "--workspace", workspaceId, "--cwd", checkout, "--no-focus"],
		{ stdout: tabCreateJson(LAUNCH.paneId, LAUNCH.tabId) },
	);
	// herdr answers the start with its session handle.
	runner.set("herdr", ["agent", "start", agent, "--kind", "pi", "--pane", LAUNCH.paneId], {
		stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }),
	});
	runner.set("herdr", ["agent", "prompt", agent, `/grill review auth`], { code: 0 });
}

/** Stub the herdr topology of one workspace. */
function stubTopology(
	runner: EgressDouble,
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

/** Stub the plain-text pane read a close issues before it cleans up. */
function stubPaneRead(runner: EgressDouble, paneId: string, output: string): void {
	runner.set(
		"herdr",
		["agent", "read", paneId, "--lines", "200", "--source", "recent-unwrapped", "--format", "text"],
		{ stdout: output },
	);
}

/** Stub herdr's agent list so the close verifies the Consultation's own Agent. */
function stubOwnAgent(
	runner: EgressDouble,
	id: string,
	handles: { paneId: string; tabId: string; workspaceId: string } = LAUNCH,
): void {
	runner.set("herdr", ["agent", "list"], {
		stdout: agentListJson([
			{
				paneId: handles.paneId,
				tabId: handles.tabId,
				workspaceId: handles.workspaceId,
				agent: "pi",
				status: "idle",
				name: agentOf(id),
				sessionId: `sess-${id.slice(0, 8)}`,
			},
		]),
	});
}

/** Poll a condition the module settles asynchronously. */
async function until(condition: () => boolean, what: string, deadlineMs = 4000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/** The texts of the statuses a flow reported, in order. */
function statusTexts(harness: Harness): string[] {
	return harness.statuses.map((status) => status.text);
}

/** The stage names a launch reported, in order. */
function stages(progress: readonly ProgressReport[]): string[] {
	return progress
		.map((entry) => entry.text.match(/: ([a-z-]+)$/)?.[1])
		.filter((stage): stage is string => stage !== undefined);
}

/** Read back one Consultation, failing loudly when the record is gone. */
function current(state: FactoryState, id: string): Consultation {
	const consultation = state.consultationRecord.consultation(id);
	if (consultation === undefined) throw new Error(`consultation ${id} is gone`);
	return consultation;
}

describe("Consultation operations: launch", () => {
	test("refuses an unknown Consultation type through the module interface", () => {
		const fixture = makeFixture();
		const harness = makeHarness(fixture, new LifecycleRunner());

		expect(
			harness.operations.create({
				typeName: "unknown",
				repository: fixture.repository,
				initialInput: "review auth",
			}),
		).toBeUndefined();
		expect(fixture.state.consultationRecord.consultations("all")).toHaveLength(0);
		expect(statusTexts(harness).at(-1)).toBe("unknown Consultation type unknown");
	});

	/**
	 * ADR 0049 puts the Consultation's hard checks at the Work queue's enqueue:
	 * the type still exists and its settings fit, so a start the config cannot
	 * run never takes a row and its reason stands on the Message line at the
	 * ask. The submit reads the type's own settings - the record's settings are
	 * the type's - and asks the same check the start asks.
	 */
	describe("the enqueue's hard check (ADR 0049)", () => {
		test("a type the config no longer names refuses the enqueue", async () => {
			const fixture = makeFixture();
			const runner = new LifecycleRunner();
			const harness = makeHarness(fixture, runner);

			expect(await harness.operations.checkEnqueue("unknown")).toBe(
				"unknown Consultation type unknown",
			);
			// No row and no record: the ask never entered the channel.
			expect(fixture.state.workQueue.items()).toEqual([]);
			expect(fixture.state.consultationRecord.consultations("all")).toEqual([]);
			expect(runner.commands()).toEqual([]);
		});

		test("an unfit Model refuses the enqueue before any external step", async () => {
			const fixture = makeFixture("gpt-4o");
			const runner = new LifecycleRunner();
			runner.inner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const harness = makeHarness(fixture, runner);

			const refusal = await harness.operations.checkEnqueue("grill");

			expect(refusal).toContain('has no model "gpt-4o"');
			// The check is the runtime read itself: one Model list, nothing else.
			expect(runner.inner.modelListCalls).toEqual(["pi"]);
			expect(runner.commands()).toEqual([]);
		});

		test("a fitting type passes the enqueue check and asks nothing else", async () => {
			const fixture = makeFixture();
			const runner = new LifecycleRunner();
			runner.inner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const harness = makeHarness(fixture, runner);

			expect(await harness.operations.checkEnqueue("grill")).toBeUndefined();
			expect(runner.commands()).toEqual([]);
		});
	});

	test("refuses empty and oversized opening input before creating a record", () => {
		const fixture = makeFixture();
		const harness = makeHarness(fixture, new LifecycleRunner());

		for (const initialInput of ["   ", "x".repeat(CONSULTATION_INPUT_LIMIT + 1)])
			expect(
				harness.operations.create({
					typeName: "grill",
					repository: fixture.repository,
					initialInput,
				}),
			).toBeUndefined();

		expect(fixture.state.consultationRecord.consultations("all")).toHaveLength(0);
		expect(statusTexts(harness)).toEqual([
			"initial input cannot be empty",
			"initial input is 65537 UTF-8 bytes; the limit is 65536",
		]);
	});

	test("runs the setting fit check before its first external change", async () => {
		const fixture = makeFixture("gpt-4o");
		const runner = new LifecycleRunner();
		runner.inner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const id = uid("1");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(current(fixture.state, id).state).toBe("failed");
		expect(current(fixture.state, id).failure).toContain('has no model "gpt-4o"');
		// Nothing external ran: no checkout resolve, no herdr environment.
		expect(runner.commands()).toEqual([]);
		expect(runner.inner.modelListCalls).toEqual(["pi"]);
		expect(statusTexts(harness).join("\n")).toContain('has no model "gpt-4o"');
	});

	test("launches a worktree Consultation, reports every stage, and owns its resources", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const id = uid("2");
		const consultation = seed(fixture.state, fixture, id);
		stubPaneRead(runner.inner, WORKTREE_LAUNCH.paneId, "Agent: opened");
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		const started = current(fixture.state, id);
		expect(started).toMatchObject({
			state: "working",
			paneId: WORKTREE_LAUNCH.paneId,
			tabId: WORKTREE_LAUNCH.tabId,
			workspaceId: WORKTREE_LAUNCH.workspaceId,
		});
		expect(stages(harness.progress)).toEqual([
			"resolving-repository",
			"creating-environment",
			"starting-agent",
			"sending-prompt",
		]);
		expect(runner.commands()).toEqual([
			`git -C ${fixture.checkout} rev-parse --git-dir`,
			`git -C ${fixture.checkout} remote get-url origin`,
			`git -C ${fixture.checkout} branch --list ${consultationBranchName(id, "grill")}`,
			`git -C ${fixture.checkout} remote get-url origin`,
			`git -C ${fixture.checkout} symbolic-ref refs/remotes/origin/HEAD`,
			`git -C ${fixture.checkout} fetch origin main`,
			`herdr worktree create --cwd ${fixture.checkout} --branch ${consultationBranchName(id, "grill")} --base origin/main --no-focus`,
			`herdr agent start ${agentOf(id)} --kind pi --pane ${WORKTREE_LAUNCH.paneId}`,
			`herdr agent prompt ${agentOf(id)} /grill review auth`,
		]);
		expect(current(fixture.state, id).resources.map((resource) => resource.resourceId)).toEqual(
			expect.arrayContaining([
				WORKTREE_LAUNCH.workspaceId,
				WORKTREE_LAUNCH.tabId,
				WORKTREE_LAUNCH.paneId,
				agentOf(id),
			]),
		);
		expect(harness.changes).toBeGreaterThan(0);
	});

	test("no default branch ref on the remote starts the worktree from the checkout HEAD with a note", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const id = uid("2f");
		const consultation = seed(fixture.state, fixture, id);
		const branch = consultationBranchName(id, "grill");
		runner.inner.set("git", ["-C", fixture.checkout, "branch", "--list", branch], {
			stdout: "",
		});
		// No default branch ref: the symref is not one, and neither tracking
		// ref verifies, so the launch falls back to the checkout's HEAD.
		runner.inner.set("git", ["-C", fixture.checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			code: 1,
			stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
		});
		runner.inner.set(
			"git",
			["-C", fixture.checkout, "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
			{ code: 1 },
		);
		runner.inner.set(
			"git",
			["-C", fixture.checkout, "rev-parse", "--verify", "--quiet", "origin/master^{commit}"],
			{ code: 1 },
		);
		runner.inner.set("git", ["-C", fixture.checkout, "rev-parse", "HEAD"], {
			stdout: `${WORKTREE_HEAD}\n`,
		});
		runner.inner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				fixture.checkout,
				"--branch",
				branch,
				"--base",
				WORKTREE_HEAD,
				"--no-focus",
			],
			{ stdout: worktreeCreateJson(LAUNCH.workspaceId, LAUNCH.paneId) },
		);
		runner.inner.set(
			"herdr",
			["agent", "start", agentOf(id), "--kind", "pi", "--pane", LAUNCH.paneId],
			{ stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }) },
		);
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "/grill review auth"], {
			code: 0,
		});
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: opened");
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "working",
			paneId: LAUNCH.paneId,
			workspaceId: LAUNCH.workspaceId,
		});
		expect(runner.commands()).toContain(`git -C ${fixture.checkout} rev-parse HEAD`);
		expectNoCommand(runner.commands(), "fetch origin");
		expect(runner.commands()).toContain(
			`herdr worktree create --cwd ${fixture.checkout} --branch ${branch} --base ${WORKTREE_HEAD} --no-focus`,
		);
		// The fallback note names the base actually used and the reason, and
		// reaches the operator where Consultation warnings already appear.
		expect(statusTexts(harness).join("\n")).toContain(
			`the worktree base fell back to HEAD ${WORKTREE_HEAD.slice(0, 7)}: no default branch found on origin (tried the origin/HEAD symref, then origin/main, then origin/master)`,
		);
	});

	test("a Consultation create a leftover directory blocks moves the leftover aside and starts", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const id = uid("2c");
		const consultation = seed(fixture.state, fixture, id);
		const branch = consultationBranchName(id, "grill");
		stubWorktreeLaunch(runner.inner, fixture.checkout, id);
		// The naming rule's path for this Consultation stands on disk with a
		// build cache in it, and git holds no record of it: the same residue a
		// ticket handoff meets, at the shared create step (ADR 0062).
		const root = join(fixture.home, "worktrees", "acme-factory");
		const candidate = join(root, branch.replaceAll("/", "-"));
		runner.inner.set("herdr", ["worktree", "list", "--cwd", fixture.checkout], {
			stdout: worktreeListJson([
				{ path: fixture.checkout, linked: false },
				{ path: join(root, "factory-6-another-consultation") },
			]),
		});
		mkdirSync(join(candidate, ".docusaurus"), { recursive: true });
		writeFileSync(join(candidate, ".docusaurus", "routes.js"), "cache");
		runner.inner.setSequence(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				fixture.checkout,
				"--branch",
				branch,
				"--base",
				"origin/main",
				"--no-focus",
			],
			[
				{
					code: 1,
					stderr:
						`{"error":{"code":"worktree_create_failed","message":"Preparing worktree (checking out '${branch}')` +
						`\\nfatal: '${candidate}' already exists"},"id":"cli:worktree:create"}\n`,
				},
				{ stdout: worktreeCreateJson(LAUNCH.workspaceId, LAUNCH.paneId) },
			],
		);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: opened");
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(current(fixture.state, id).state).toBe("working");
		expect(existsSync(join(candidate, ".docusaurus", "routes.js"))).toBe(false);
		expect(existsSync(join(`${candidate}.leftover`, ".docusaurus", "routes.js"))).toBe(true);
		expect(statusTexts(harness).join("\n")).toContain(
			`the plane moved the leftover worktree directory ${candidate} aside to ${candidate}.leftover`,
		);
	});

	test("leaves a refused launch failed with the readable reason", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const id = uid("3");
		const consultation = seed(fixture.state, fixture, id);
		const branch = consultationBranchName(id, "grill");
		runner.inner.set("git", ["-C", fixture.checkout, "branch", "--list", branch], {
			stdout: "",
		});
		runner.inner.set("git", ["-C", fixture.checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.inner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				fixture.checkout,
				"--branch",
				branch,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ code: 1, stderr: "herdr refused the worktree\n" },
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "failed",
			paneId: null,
			failure: expect.stringContaining("herdr refused the worktree"),
		});
		expect(runner.commands().join("\n")).not.toContain("agent start");
		expect(harness.statuses.at(-1)).toMatchObject({ kind: "error" });
	});

	test("reports an already in-progress opening instead of racing it", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const id = uid("4");
		const consultation = seed(fixture.state, fixture, id);
		runner.holdWhile((command) => command.startsWith("herdr worktree create"));
		const harness = makeHarness(fixture, runner);

		const first = harness.operations.launch(consultation);
		await until(() => runner.attempts.some((c) => c.startsWith("herdr worktree create")), "held");
		await harness.operations.launch(consultation);
		runner.release();
		await first;

		expect(statusTexts(harness).join("\n")).toContain(
			"Consultation opening is already in progress",
		);
		expect(
			runner.commands().filter((command) => command.startsWith("herdr worktree create")),
		).toHaveLength(1);
		expect(current(fixture.state, id).state).toBe("working");
	});

	test("launches on a free live checkout in a fresh tab of its workspace", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("5");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		const joined = runner.commands().join("\n");
		// The live path shares the operator's checkout: it never creates one.
		expect(joined).not.toContain("worktree create");
		expect(joined).toContain(`herdr tab create --workspace ws-live --cwd ${fixture.checkout}`);
		expect(joined).toContain(`herdr agent prompt ${agentOf(id)} /grill review auth`);
		expect(current(fixture.state, id)).toMatchObject({ state: "working", paneId: LAUNCH.paneId });
	});

	test("holds a conflicted live launch for one explicit confirmation", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("6");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		// A Herdr Agent already works in this exact checkout.
		const busy = agentListJson([
			{
				paneId: "pane-herdr",
				tabId: "tab-herdr",
				workspaceId: "ws-herdr",
				agent: "pi",
				status: "working",
			},
		]);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busy.replace(
				'"pane_id":"pane-herdr"',
				`"pane_id":"pane-herdr","checkout_path":"${realpathSync(fixture.checkout)}"`,
			),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(harness.conflicts).toHaveLength(1);
		expect(harness.conflicts[0]).toMatchObject({ consultationId: id });
		expect(harness.conflicts[0].safety.conflicts[0]).toMatchObject({
			kind: "herdr-agent",
			identity: "pane-herdr",
		});
		expect(statusTexts(harness).at(-1)).toContain("explicit confirmation is required");
		expect(current(fixture.state, id)).toMatchObject({ state: "opening", paneId: null });
		expect(runner.commands().join("\n")).not.toContain("agent prompt");
		expect(harness.conflicts[0].safety.conflicts[0].label).toContain("pane-herdr");

		// Confirm once: the same launch continues and the checkout's confirmed
		// set is durable.
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");
		expect(current(fixture.state, id).state).toBe("working");
		expect(
			fixture.state.consultationRecord.confirmedCheckoutConflicts(realpathSync(fixture.checkout)),
		).toEqual(["pane-herdr"]);
		expect(runner.commands()).toContain(`herdr agent prompt ${agentOf(id)} /grill review auth`);
	});

	test("keeps a cancelled conflict recoverable, and checks it again", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("7");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-herdr",
					tabId: "tab-herdr",
					workspaceId: "ws-herdr",
					agent: "pi",
					status: "working",
				},
			]).replace(
				'"pane_id":"pane-herdr"',
				`"pane_id":"pane-herdr","checkout_path":"${realpathSync(fixture.checkout)}"`,
			),
		});
		const harness = makeHarness(fixture, runner);

		// The operator cancels the panel: nothing was confirmed and nothing ran.
		await harness.operations.launch(consultation);
		expect(current(fixture.state, id).state).toBe("opening");
		// Recovering it later re-checks the checkout, and blocks again.
		await harness.operations.recover(consultation);

		expect(harness.conflicts).toHaveLength(2);
		expect(current(fixture.state, id).state).toBe("opening");
		expect(
			fixture.state.consultationRecord.confirmedCheckoutConflicts(realpathSync(fixture.checkout)),
		).toEqual([]);
		expect(runner.commands().join("\n")).not.toContain("tab create");
	});

	test("warns about a dirty live checkout without blocking its launch", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live", true)),
		);
		const id = uid("8");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "working",
			warning: "the live checkout has uncommitted changes",
		});
		expect(harness.conflicts).toHaveLength(0);
		expect(harness.statuses.some((status) => status.kind === "warning")).toBe(true);
	});
});

describe("Consultation operations: live checkout confirmation lifetime", () => {
	/** Herdr's agent list of one Agent working in the named checkout. */
	function busyAgentJson(checkout: string, paneId: string): string {
		return agentListJson([
			{
				paneId,
				tabId: `tab-${paneId}`,
				workspaceId: `ws-${paneId}`,
				agent: "pi",
				status: "working",
			},
		]).replace(
			`"pane_id":"${paneId}"`,
			`"pane_id":"${paneId}","checkout_path":"${realpathSync(checkout)}"`,
		);
	}

	/** Herdr's agent list of every named pane working in the named checkout. */
	function busyAgentsJson(checkout: string, paneIds: readonly string[]): string {
		return JSON.stringify({
			result: {
				agents: paneIds.map((paneId) => ({
					pane_id: paneId,
					tab_id: `tab-${paneId}`,
					workspace_id: `ws-${paneId}`,
					agent: "pi",
					agent_status: "working",
					checkout_path: realpathSync(checkout),
				})),
			},
		});
	}

	/** A running ticket whose live-worktree handoff occupies the named pane. */
	function runningTicket(identity: string, paneId: string): Ticket {
		return {
			identity,
			title: "conflict ticket",
			repository: "acme/factory",
			repositoryRef: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			state: "running",
			handoff: {
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
				attemptId: `attempt-${identity}`,
				paneId,
				tabId: null,
				workspaceId: null,
				herdrName: "conflict-ticket",
			},
			workCycle: 1,
			handoffCount: 1,
			failedStartStreak: 0,
			lastCompletion: null,
			description: "",
			sourceKind: "github",
			externalKey: identity,
			sourceState: "open",
			url: "",
			labels: [],
			externalUpdatedAt: "2026-09-01T00:00:00.000Z",
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
	}

	test("does not re-ask a second launch for a confirmed conflict set", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("a");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-herdr"),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);
		expect(harness.conflicts).toHaveLength(1);
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");

		// A second Consultation into the same checkout: the same Agents still
		// occupy it, and none of them is unconfirmed.
		const id2 = uid("b");
		const second = seed(fixture.state, fixture, id2, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id2, "ws-live-2");

		await harness.operations.launch(second);

		expect(harness.conflicts).toHaveLength(1);
		expect(current(fixture.state, id2)).toMatchObject({ state: "working", paneId: LAUNCH.paneId });
	});

	test("asks again when an unconfirmed identity enters the checkout", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("c");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-herdr"),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");

		// A second Agent enters the checkout while the first is still there.
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentsJson(fixture.checkout, ["pane-herdr", "pane-new"]),
		});
		const id2 = uid("d");
		const second = seed(fixture.state, fixture, id2, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id2, "ws-live-2");

		await harness.operations.launch(second);

		expect(harness.conflicts).toHaveLength(2);
		expect(harness.conflicts[1].safety.conflicts.map((c) => c.identity).sort()).toEqual([
			"pane-herdr",
			"pane-new",
		]);
		expect(current(fixture.state, id2).state).toBe("opening");

		// Confirming stores the union of the confirmed set and the new one.
		await harness.operations.confirmSafetyConflict(second, harness.conflicts[1].safety.conflicts);
		await until(() => current(fixture.state, id2).state === "working", "the confirmed launch");
		expect(
			fixture.state.consultationRecord
				.confirmedCheckoutConflicts(realpathSync(fixture.checkout))
				.sort(),
		).toEqual(["pane-herdr", "pane-new"]);
	});

	test("does not re-ask when a confirmed identity leaves, and shrinks the stored set", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("e");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-herdr"),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");

		// The occupying Agent is gone. A safer checkout never surprises the
		// operator with a fresh panel.
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const id2 = uid("f");
		const second = seed(fixture.state, fixture, id2, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id2, "ws-live-2");

		await harness.operations.launch(second);

		expect(harness.conflicts).toHaveLength(1);
		expect(current(fixture.state, id2).state).toBe("working");
		// The stored set is updated to what the checkout holds now.
		expect(
			fixture.state.consultationRecord.confirmedCheckoutConflicts(realpathSync(fixture.checkout)),
		).toEqual([]);
	});

	test("does not re-ask a fresh operations instance for a confirmed set", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("g");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-herdr"),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");

		// A control plane restart reads the same state file: the confirmation
		// belongs to the checkout, so the new instance asks nothing.
		const fresh = makeHarness(fixture, runner);
		const id2 = uid("h");
		const second = seed(fixture.state, fixture, id2, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id2, "ws-live-2");

		await fresh.operations.launch(second);

		expect(fresh.conflicts).toHaveLength(0);
		expect(current(fixture.state, id2).state).toBe("working");
	});

	test("asks separately for a different checkout", async () => {
		const fixture = makeFixture();
		const live = liveLaunchWorld(fixture.repository, "ws-live");
		live.checkouts = bothCheckoutsWorld(fixture).checkouts;
		const runner = new LifecycleRunner(stubHerdrWorld(live));
		const id = uid("i");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: JSON.stringify({
				result: {
					agents: [
						{
							pane_id: "pane-herdr",
							tab_id: "tab-herdr",
							workspace_id: "ws-herdr",
							agent: "pi",
							agent_status: "working",
							checkout_path: realpathSync(fixture.checkout),
						},
						{
							pane_id: "pane-herdr-other",
							tab_id: "tab-herdr-other",
							workspace_id: "ws-herdr-other",
							agent: "pi",
							agent_status: "working",
							checkout_path: realpathSync(fixture.otherCheckout),
						},
					],
				},
			}),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);
		expect(harness.conflicts).toHaveLength(1);
		expect(harness.conflicts[0].safety.conflicts.map((c) => c.identity)).toEqual(["pane-herdr"]);
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");

		// Another repository's checkout keeps its own safety question.
		const id2 = uid("j");
		const second = seed(fixture.state, fixture, id2, {
			environment: "live-worktree",
			repository: fixture.otherRepository,
		});
		stubLiveLaunch(runner.inner, fixture.otherCheckout, id2, "ws-other");

		await harness.operations.launch(second);

		expect(harness.conflicts).toHaveLength(2);
		expect(harness.conflicts[1].safety.conflicts.map((c) => c.identity)).toEqual([
			"pane-herdr-other",
		]);
		expect(current(fixture.state, id2).state).toBe("opening");
	});

	test("proceeds without a panel when no identity is unconfirmed", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("o");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-herdr"),
		});
		// The checkout already holds the confirmation, as a previous run left it.
		fixture.state.consultationRecord.recordCheckoutConflictConfirmation(
			realpathSync(fixture.checkout),
			["pane-herdr"],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(harness.conflicts).toHaveLength(0);
		expect(current(fixture.state, id)).toMatchObject({ state: "working", paneId: LAUNCH.paneId });
		expect(runner.commands()).toContain(`herdr agent prompt ${agentOf(id)} /grill review auth`);
	});

	test("names an Agent owned by an open Consultation on one panel line", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		// A Consultation that already occupies the checkout with its live Agent.
		const occupier = seed(fixture.state, fixture, uid("k"), { environment: "live-worktree" });
		startAgent(fixture.state, occupier.id, {
			paneId: "pane-occ",
			tabId: "tab-occ",
			workspaceId: "ws-occ",
		});
		const id = uid("l");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-occ"),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		expect(harness.conflicts).toHaveLength(1);
		// One line per underlying Agent: the pane is the Consultation's, so the
		// panel names the Consultation and not a second bare Herdr Agent.
		expect(harness.conflicts[0].safety.conflicts).toEqual([
			{
				kind: "consultation",
				identity: occupier.id,
				label: `Consultation ${occupier.id.slice(0, 8)}`,
			},
		]);
	});

	test("names an Agent owned by a running ticket, and does not re-ask it", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const id = uid("m");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id);
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: busyAgentJson(fixture.checkout, "pane-tick"),
		});
		const harness = makeHarness(fixture, runner, {
			tickets: () => [runningTicket("ACME-42", "pane-tick")],
		});

		await harness.operations.launch(consultation);

		expect(harness.conflicts).toHaveLength(1);
		expect(harness.conflicts[0].safety.conflicts).toEqual([
			{ kind: "ticket", identity: "ACME-42", label: "Ticket ACME-42" },
		]);

		// The ticket's Agent takes the same lifetime rule as a Consultation's.
		await harness.operations.confirmSafetyConflict(
			consultation,
			harness.conflicts[0].safety.conflicts,
		);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");
		const id2 = uid("n");
		const second = seed(fixture.state, fixture, id2, { environment: "live-worktree" });
		stubLiveLaunch(runner.inner, fixture.checkout, id2, "ws-live-2");

		await harness.operations.launch(second);

		expect(harness.conflicts).toHaveLength(1);
		expect(current(fixture.state, id2).state).toBe("working");
		expect(
			fixture.state.consultationRecord.confirmedCheckoutConflicts(realpathSync(fixture.checkout)),
		).toEqual(["ACME-42"]);
	});
});

describe("Consultation operations: recovery", () => {
	test("reconnects an interrupted opening to the Agent that survived", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("9");
		const consultation = seed(fixture.state, fixture, id);
		fixture.state.consultationRecord.recordConsultationAgentHandles(id, {
			paneId: "pane-old",
			tabId: "tab-old",
			workspaceId: "ws-old",
		});
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-old",
					tabId: "tab-new",
					workspaceId: "ws-new",
					agent: agentOf(id),
					status: "working",
				},
			]),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.recover(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "working",
			paneId: "pane-old",
			tabId: "tab-new",
			workspaceId: "ws-new",
		});
		expect(statusTexts(harness).at(-1)).toContain("reconnected");
		expect(runner.commands()).toEqual(["herdr agent list"]);
	});

	test("fails an interrupted opening whose Agent is gone", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("a");
		const consultation = seed(fixture.state, fixture, id);
		fixture.state.consultationRecord.recordConsultationAgentHandles(id, { paneId: "pane-gone" });
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const harness = makeHarness(fixture, runner);

		await harness.operations.recover(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "failed",
			failure: "Agent is missing",
		});
		expect(statusTexts(harness).at(-1)).toContain("failed: Agent is missing");
	});

	test("re-runs an opening that left no Agent handles behind", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const id = uid("b");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, runner);

		await harness.operations.recover(consultation);

		expect(current(fixture.state, id).state).toBe("working");
		expect(runner.commands()).toContain(`herdr agent prompt ${agentOf(id)} /grill review auth`);
	});

	test("reports a herdr that cannot answer without failing the opening", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("c");
		const consultation = seed(fixture.state, fixture, id);
		fixture.state.consultationRecord.recordConsultationAgentHandles(id, { paneId: "pane-old" });
		runner.inner.set("herdr", ["agent", "list"], { code: 1, stderr: "herdr is down\n" });
		const harness = makeHarness(fixture, runner);

		await harness.operations.recover(consultation);

		expect(statusTexts(harness).at(-1)).toContain(
			"cannot verify Consultation Agent: herdr is down",
		);
		expect(current(fixture.state, id).state).toBe("opening");
	});

	test("refuses to recover a Consultation that is not opening", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("d");
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		const harness = makeHarness(fixture, runner);

		await harness.operations.recover(consultation);

		expect(runner.commands()).toEqual([]);
		expect(current(fixture.state, id).state).toBe("working");
	});
});

describe("Consultation operations: response", () => {
	/** An awaiting-response Consultation with one settled turn of history. */
	function seedAwaiting(fixture: Fixture, id: string): Consultation {
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		fixture.state.consultationRecord.settleConsultationTurn(id, null, "first answer");
		return consultation;
	}

	test("reports a state write failure without rejecting the response operation", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("0");
		const consultation = seedAwaiting(fixture, id);
		const harness = makeHarness(fixture, runner);
		const write = spyOn(
			fixture.state.consultationRecord,
			"setConsultationDraft",
		).mockImplementation(() => {
			throw new Error("SQLITE_BUSY");
		});

		await expect(harness.operations.respond(consultation, "follow up")).resolves.toBeUndefined();

		expect(runner.commands()).toEqual([]);
		expect(statusTexts(harness).at(-1)).toBe("response failed: SQLITE_BUSY");
		write.mockRestore();
	});

	test("opens a turn only after herdr accepts the response", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("1");
		const consultation = seedAwaiting(fixture, id);
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "follow up"], { code: 0 });
		const harness = makeHarness(fixture, runner);

		await harness.operations.respond(consultation, "follow up");

		expect(runner.commands()).toEqual([`herdr agent prompt ${agentOf(id)} follow up`]);
		expect(current(fixture.state, id)).toMatchObject({
			state: "working",
			draft: "",
			pendingResponse: null,
		});
		expect(
			fixture.state.consultationRecord.consultationTurns(id).map((turn) => turn.input),
		).toEqual(["review auth", "follow up"]);
		// A clean delivery clears the Message line.
		expect(harness.reported.at(-1)).toBeNull();
	});

	test("keeps a response draft when Herdr rejects delivery", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("2");
		const consultation = seedAwaiting(fixture, id);
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "follow up"], {
			code: 1,
			stderr: "agent rejected the prompt\n",
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.respond(consultation, "follow up");

		expect(current(fixture.state, id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
			pendingResponse: null,
		});
		expect(statusTexts(harness).at(-1)).toContain("response failed: agent rejected the prompt");
	});

	test("refuses an unusable draft before it reaches herdr", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("3");
		const consultation = seedAwaiting(fixture, id);
		const harness = makeHarness(fixture, runner);

		await harness.operations.respond(consultation, "   ");
		await harness.operations.respond(consultation, "x".repeat(CONSULTATION_INPUT_LIMIT + 1));

		expect(runner.commands()).toEqual([]);
		expect(statusTexts(harness)[0]).toBe("response cannot be empty");
		expect(statusTexts(harness)[1]).toContain("response is 65537 UTF-8 bytes");
		expect(current(fixture.state, id).state).toBe("awaiting-response");
	});

	test("refuses a response while a delivery is still pending", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("4");
		const consultation = seedAwaiting(fixture, id);
		// A delivery the last control plane run began, and never settled.
		fixture.state.consultationRecord.beginConsultationResponse(id, "follow up", null);
		const harness = makeHarness(fixture, runner);

		await harness.operations.respond(consultation, "second one");

		expect(statusTexts(harness).at(-1)).toContain("a response delivery is already pending");
		expect(runner.commands()).toEqual([]);
		// The refused draft is still the operator's to edit.
		expect(current(fixture.state, id).draft).toBe("second one");
	});
});

describe("Consultation operations: close", () => {
	/** A working Consultation with its environment recorded, ready to close. */
	function seedWorking(fixture: Fixture, id: string, handles = LAUNCH): Consultation {
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id, handles);
		seedResources(fixture.state, id, handles);
		return consultation;
	}

	test("closes an exclusively owned workspace whole and keeps its worktree", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("5");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(runner.commands()).toEqual([
			"herdr agent list",
			`herdr agent read ${LAUNCH.paneId} --lines 200 --source recent-unwrapped --format text`,
			`herdr tab list --workspace ${LAUNCH.workspaceId}`,
			`herdr pane list --workspace ${LAUNCH.workspaceId}`,
			`herdr workspace close ${LAUNCH.workspaceId}`,
		]);
		// The plane never follows a close with a focus command: herdr keeps
		// each client on the workspace it views (ADR 0061).
		expect(herdrFocusCommands(runner.commands())).toEqual([]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		// The worktree and its branch survive: retained, never removed.
		const worktree = closed.resources.find((resource) => resource.kind === "worktree");
		expect(worktree).toMatchObject({ owned: false, confirmedClosed: false });
		expect(worktree?.details).toContain("retained after close");
		for (const resource of closed.resources.filter((item) => item.kind !== "worktree"))
			expect(resource).toMatchObject({ confirmedClosed: true });
		expect(
			fixture.state.consultationRecord.consultationSnapshots(id).some((snap) => snap.partial),
		).toBe(true);
		expect(statusTexts(harness).at(-1)).toContain("closed");
	});

	test("closes only the owned tab when a foreign tab shares the workspace", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("6");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId, "tab-foreign"],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(runner.commands()).toContain(`herdr tab close ${LAUNCH.tabId}`);
		expect(runner.commands().join("\n")).not.toContain("workspace close");
		expect(herdrFocusCommands(runner.commands())).toEqual([]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.resources.find((r) => r.kind === "workspace")).toMatchObject({ owned: false });
	});

	test("closes only the pane when a foreign pane shares the owned tab", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("7");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[
				{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId },
				{ pane_id: "pane-foreign", tab_id: LAUNCH.tabId },
			],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(runner.commands()).toContain(`herdr pane close ${LAUNCH.paneId}`);
		const closed = current(fixture.state, id);
		expect(closed.resources.find((r) => r.kind === "tab")).toMatchObject({ owned: false });
		expect(closed.resources.find((r) => r.kind === "workspace")).toMatchObject({ owned: false });
	});

	test("finishes a Consultation that never started an Agent with no command at all", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("8");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(runner.commands()).toEqual([]);
		expect(current(fixture.state, id).state).toBe("closed");
	});

	test("keeps a failed close recoverable and retries it to the end", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("9");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		runner.inner.setSequence(
			"herdr",
			["workspace", "close", LAUNCH.workspaceId],
			[{ code: 1, stderr: "refused\n" }, { code: 0 }],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		const stuck = current(fixture.state, id);
		expect(stuck.state).toBe("closing");
		expect(stuck.warning).toContain("cleanup failed: refused");
		expect(
			stuck.resources.filter((resource) => resource.kind !== "worktree"),
			// Nothing was confirmed closed behind the refusal.
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "workspace", confirmedClosed: false }),
			]),
		);
		expect(statusTexts(harness).at(-1)).toContain("close needs recovery: refused");

		// The retry runs the same cleanup through to the end.
		await harness.operations.close(consultation);

		expect(current(fixture.state, id).state).toBe("closed");
		expect(
			runner.commands().filter((command) => command.startsWith("herdr workspace close")),
		).toHaveLength(2);
	});

	test("leaves the topology unverifiable as a recovery, never a blind close", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("a");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		runner.inner.set("herdr", ["tab", "list", "--workspace", LAUNCH.workspaceId], {
			stdout: "not json\n",
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "closing",
			warning: expect.stringContaining("could not verify the Consultation workspace topology"),
		});
		expect(runner.commands().join("\n")).not.toContain("workspace close");
	});

	test("refuses a second close while a cleanup is in progress", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("b");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		runner.holdWhile((command) => command.startsWith(`herdr agent read ${LAUNCH.paneId}`));
		const harness = makeHarness(fixture, runner);

		const first = harness.operations.close(consultation);
		await until(() => runner.attempts.some((c) => c.startsWith("herdr agent read")), "held");
		await harness.operations.close(consultation);
		runner.release();
		await first;

		expect(statusTexts(harness)).toContain("Consultation close is already in progress");
		expect(
			runner.commands().filter((command) => command.startsWith("herdr workspace close")),
		).toHaveLength(1);
	});

	test("force-close records resources without issuing cleanup commands", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("c");
		const consultation = seedWorking(fixture, id);
		fixture.state.consultationRecord.beginConsultationClose(id);
		const harness = makeHarness(fixture, runner);

		harness.operations.forceClose(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "closed",
			closeResult: "force-closed by operator; owned resources may remain",
		});
		expect(
			fixture.state.consultationRecord
				.consultationRemainingResources(id)
				.map((resource) => resource.kind),
		).toEqual(expect.arrayContaining(["workspace", "tab", "pane", "agent", "worktree"]));
		expect(runner.commands()).toEqual([]);
		expect(statusTexts(harness).at(-1)).toContain(
			"force-closed; recovery resources remain recorded",
		);
	});

	test("stops a queued cleanup when a force-close closes the record first", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const first = uid("d");
		const second = uid("e");
		const firstConsultation = seedWorking(fixture, first);
		const secondConsultation = seedWorking(fixture, second);
		stubOwnAgent(runner.inner, first);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: first");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		// The first close holds the Repository queue; the second queues behind it.
		runner.holdWhile((command) => command.startsWith("herdr workspace close"));
		const harness = makeHarness(fixture, runner);

		const closing = harness.operations.close(firstConsultation);
		await until(
			() => runner.attempts.some((c) => c.startsWith("herdr workspace close")),
			"the first cleanup to be held",
		);
		const queued = harness.operations.close(secondConsultation);
		harness.operations.forceClose(secondConsultation);
		runner.release();
		await queued;
		await closing;

		// The force-closed record's cleanup never ran: no second read, no close.
		const readCommands = runner.commands().filter((c) => c.startsWith("herdr agent read"));
		expect(readCommands).toHaveLength(1);
		expect(runner.commands().filter((c) => c.startsWith("herdr workspace close"))).toHaveLength(1);
		expect(current(fixture.state, second)).toMatchObject({
			state: "closed",
			closeResult: "force-closed by operator; owned resources may remain",
		});
		expect(
			fixture.state.consultationRecord.consultationRemainingResources(second).length,
		).toBeGreaterThan(0);
		expect(current(fixture.state, first).state).toBe("closed");
	});

	test("stops an in-flight cleanup before its command reaches herdr", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("0");
		const consultation = seedWorking(fixture, id);
		stubOwnAgent(runner.inner, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		// The cleanup is already past its first read and inside the topology probe.
		runner.holdWhile((command) => command.startsWith(`herdr tab list --workspace`));
		const harness = makeHarness(fixture, runner);

		const closing = harness.operations.close(consultation);
		await until(() => runner.attempts.some((c) => c.startsWith("herdr tab list")), "held probe");
		harness.operations.forceClose(consultation);
		runner.release();
		await closing;

		// The Force-close stopped it: no cleanup command, and nothing confirmed.
		expect(
			runner
				.commands()
				.filter((command) =>
					["pane close", "tab close", "workspace close"].some((take) => command.includes(take)),
				),
		).toEqual([]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.resources.every((resource) => !resource.confirmedClosed)).toBe(true);
		expect(
			fixture.state.consultationRecord.consultationRemainingResources(id).length,
		).toBeGreaterThan(0);
	});

	test("refuses a force-close whose cleanup already finished", () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("f");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, runner);
		fixture.state.consultationRecord.beginConsultationClose(id);
		fixture.state.consultationRecord.finishConsultationClose(id);

		harness.operations.forceClose(consultation);

		expect(statusTexts(harness).at(-1)).toBe("Consultation cleanup has already finished");
		expect(current(fixture.state, id).closeResult).toBeNull();
		expect(runner.commands()).toEqual([]);
	});

	test("closes a missing record without touching a reused tab of the same ids", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("m");
		const stale = { workspaceId: "wAR", tabId: "wAR:t29", paneId: "wAR:p29" };
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		startAgent(fixture.state, id, stale);
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "tab",
			resourceId: stale.tabId,
			owned: true,
			details: "Consultation tab",
		});
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "pane",
			resourceId: stale.paneId,
			owned: true,
			details: "Consultation Agent pane",
		});
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "agent",
			resourceId: agentOf(id),
			owned: true,
			details: `Agent hosted by pane ${stale.paneId}`,
		});
		fixture.state.consultationRecord.setConsultationState(id, "missing", "Agent is missing");
		// herdr restarted and restored the tab under the same ids: the pane now
		// holds a bare terminal, so the agent list names no one for the record
		// and the reused pane is a foreign one to the close.
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "wAR:p2A",
					tabId: "wAR:t2A",
					workspaceId: "wAR",
					agent: "bun",
					status: "idle",
					name: "control-plane",
				},
			]),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		// The record retires on the identity check: the only command the close
		// issued was the probe, so the topology that would have taken the
		// reused tab down was never even asked.
		expect(runner.commands()).toEqual(["herdr agent list"]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.closeResult).toContain("Agent is missing");
		expect(closed.resources.filter((item) => item.owned && !item.confirmedClosed).length).toBe(3);
		expect(
			fixture.state.consultationRecord
				.consultationRemainingResources(id)
				.map((item) => item.resourceId),
		).toEqual(expect.arrayContaining([stale.tabId, stale.paneId]));
		expect(statusTexts(harness).at(-1)).toContain("herdr was left untouched");
	});

	test("retires the record when the stored pane holds a foreign Agent", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("n");
		const stale = { workspaceId: "wAR", tabId: "wAR:t29", paneId: "wAR:p29" };
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		startAgent(fixture.state, id, stale);
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "pane",
			resourceId: stale.paneId,
			owned: true,
			details: "Consultation Agent pane",
		});
		fixture.state.consultationRecord.setConsultationState(id, "missing", "Agent is missing");
		// The reused pane now hosts another Consultation's Agent: its name is
		// the record's own, or nothing like it - never the Consultation's.
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: stale.paneId,
					tabId: stale.tabId,
					workspaceId: stale.workspaceId,
					agent: "pi",
					status: "idle",
					name: "consultation-00000000",
				},
			]),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		expect(runner.commands()).toEqual(["herdr agent list"]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.resources.find((item) => item.kind === "pane")).toMatchObject({
			owned: true,
			confirmedClosed: false,
		});
	});

	test("refuses to take down an unverified opening, and leaves it for recovery", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("u");
		const consultation = seed(fixture.state, fixture, id);
		// The launch recorded its environment before its Agent started: the
		// tab and pane stand, and no Agent runs under the record's name.
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "tab",
			resourceId: LAUNCH.tabId,
			owned: true,
			details: "Consultation tab",
		});
		fixture.state.consultationRecord.recordConsultationResource(id, {
			kind: "pane",
			resourceId: LAUNCH.paneId,
			owned: true,
			details: "Consultation Agent pane",
		});
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(consultation);

		// An opening cannot tell a missing Agent from a starting one: the close
		// takes nothing down and leaves the record where a retry can find it.
		const stuck = current(fixture.state, id);
		expect(stuck.state).toBe("closing");
		expect(stuck.warning).toContain("the Agent is not visible");
		expect(runner.commands()).toEqual(["herdr agent list"]);
	});

	test("keeps an ambiguous Agent identity as a recovery, never a blind close", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("v");
		seedWorking(fixture, id);
		// The name is held twice: neither match is safe to take down.
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: LAUNCH.paneId,
					tabId: LAUNCH.tabId,
					workspaceId: LAUNCH.workspaceId,
					agent: "pi",
					status: "idle",
					name: agentOf(id),
				},
				{
					paneId: "pane-other",
					tabId: "tab-other",
					workspaceId: LAUNCH.workspaceId,
					agent: "pi",
					status: "idle",
					name: agentOf(id),
				},
			]),
		});
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(current(fixture.state, id));

		expect(current(fixture.state, id)).toMatchObject({
			state: "closing",
			warning: expect.stringContaining("held by more than one Agent"),
		});
		expect(runner.commands().join("\n")).not.toContain("close");
	});

	test("leaves the close as a recovery when the Agent list cannot be read", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("g");
		seedWorking(fixture, id);
		runner.inner.set("herdr", ["agent", "list"], { code: 1, stderr: "no herdr server\n" });
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(current(fixture.state, id));

		expect(current(fixture.state, id)).toMatchObject({
			state: "closing",
			warning: expect.stringContaining("cannot verify the Consultation Agent's identity"),
		});
		expect(runner.commands()).toEqual(["herdr agent list"]);
	});

	test("follows a moved Agent to the tab it holds and closes that tab", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("w");
		seedWorking(fixture, id);
		const moved = { paneId: "pane-c2", tabId: "tab-c2", workspaceId: LAUNCH.workspaceId };
		stubOwnAgent(runner.inner, id, moved);
		stubPaneRead(runner.inner, moved.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[moved.tabId, "tab-foreign"],
			[{ pane_id: moved.paneId, tab_id: moved.tabId }],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(current(fixture.state, id));

		// The close addresses the Agent's live handles, not the ones it left.
		expect(runner.commands()).toContain(`herdr tab close ${moved.tabId}`);
		expect(runner.commands().join("\n")).not.toContain(`tab close ${LAUNCH.tabId}`);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.resources.find((item) => item.kind === "tab")).toMatchObject({
			resourceId: moved.tabId,
			confirmedClosed: true,
		});
		expect(closed.paneId).toBe(moved.paneId);
	});

	test("closes on the stored pane when this herdr names no Agent", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("x");
		seedWorking(fixture, id);
		// An older herdr lists the Agent without a name: the stored pane's
		// Agent is the weak match, and the stored session cannot contradict it.
		runner.inner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: LAUNCH.paneId,
					tabId: LAUNCH.tabId,
					workspaceId: LAUNCH.workspaceId,
					agent: "pi",
					status: "idle",
				},
			]),
		});
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		const harness = makeHarness(fixture, runner);

		await harness.operations.close(current(fixture.state, id));

		expect(runner.commands()).toContain(`herdr workspace close ${LAUNCH.workspaceId}`);
		expect(current(fixture.state, id).state).toBe("closed");
	});

	test("closes a failed live opening whose own start already took its workspace down", async () => {
		// Pull request #213 review: a start that cleans up its own Environment confirms the
		// rows it recorded for it. The record then holds no "Unclosed owned
		// resources" line for a handle the plane already removed, and the operator's
		// Close has nothing left to retry against a workspace herdr no longer holds.
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-new")),
		);
		const id = uid("y");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		// No workspace holds the checkout: the start creates its own, records the
		// workspace and its root tab, and then herdr refuses its Agent start.
		runner.inner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.inner.set("herdr", ["workspace", "create", "--cwd", fixture.checkout, "--no-focus"], {
			stdout: workspaceCreateJson(LAUNCH.workspaceId, LAUNCH.paneId),
		});
		runner.inner.set(
			"herdr",
			["agent", "start", agentOf(id), "--kind", "pi", "--pane", LAUNCH.paneId],
			{
				code: 1,
				stderr: '{"error":{"code":"agent_start_failed","message":"the pane is gone"}}\n',
			},
		);
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		const failed = current(fixture.state, id);
		expect(failed.state).toBe("failed");
		// The start's own cleanup took the workspace it created down.
		expect(runner.commands()).toContain(`herdr workspace close ${LAUNCH.workspaceId}`);
		// And it confirmed both rows it had written for that Environment.
		expect(
			failed.resources.map((resource) => `${resource.kind} ${resource.confirmedClosed}`).sort(),
		).toEqual(["tab true", "workspace true"]);

		await harness.operations.close(current(fixture.state, id));

		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		// One close command in the whole run: the start's own. The Close issues no
		// second one for a workspace that is gone, and reports no recovery.
		expect(
			runner.commands().filter((command) => command.startsWith("herdr workspace close")),
		).toHaveLength(1);
		expect(statusTexts(harness).join("\n")).not.toContain("needs recovery");
		expect(statusTexts(harness).at(-1)).toBe(`Consultation ${id.slice(0, 8)} closed`);
	});
});

describe("Consultation operations: replacement and deletion", () => {
	/** A failed Consultation whose exchange is too long to carry whole. */
	function seedFailedWithHistory(fixture: Fixture, id: string): Consultation {
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		// The opening turn settles, then two exchanges follow. Each Agent answer
		// is 40 KiB, so the whole exchange cannot fit the 64 KiB limit.
		fixture.state.consultationRecord.settleConsultationTurn(
			id,
			null,
			"opening answer".padEnd(40 * 1024, "x"),
		);
		for (const response of ["note: first pass", "note: keep going"]) {
			const pending = fixture.state.consultationRecord.beginConsultationResponse(
				id,
				response,
				null,
			);
			if (pending === undefined) throw new Error(`no pending response for ${response}`);
			fixture.state.consultationRecord.acceptConsultationResponse(id, pending.id);
			fixture.state.consultationRecord.settleConsultationTurn(
				id,
				null,
				`answer to ${response}`.padEnd(40 * 1024, "y"),
			);
		}
		fixture.state.consultationRecord.setConsultationState(id, "failed", "herdr refused the launch");
		return consultation;
	}

	test("opens a Replacement from a failed Consultation, linked and bounded", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("1");
		const replaced = seedFailedWithHistory(fixture, id);

		const replacement = makeHarness(fixture, runner).operations.replace(replaced, {
			typeName: "grill",
			repository: fixture.repository,
		});

		expect(replacement).toBeDefined();
		expect(replacement?.replacementOf).toBe(id);
		expect(replacement?.state).toBe("opening");
		// US17: the recovery context is carried forward, never past the limit.
		expect(utf8ByteLength(replacement?.initialInput ?? "")).toBeLessThanOrEqual(
			CONSULTATION_INPUT_LIMIT,
		);
		expect(replacement?.initialInput).toContain("Original input:\nreview auth");
		expect(replacement?.initialInput).toContain("[recovery context omitted]");
		// US18: the failed record stays visible and keeps its own state.
		expect(current(fixture.state, id)).toMatchObject({ state: "failed" });
		expect(fixture.state.consultationRecord.consultations("open").map((item) => item.id)).toEqual(
			expect.arrayContaining([id, replacement?.id ?? ""]),
		);
		// Building a Replacement starts no external work.
		expect(runner.commands()).toEqual([]);
	});

	test("launches a Replacement the same way it launches a new Consultation", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const id = uid("2");
		const replaced = seedFailedWithHistory(fixture, id);
		const harness = makeHarness(fixture, runner);
		const replacement = harness.operations.replace(replaced, {
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "continue the review",
		});
		if (replacement === undefined) throw new Error("the Replacement was refused");

		await harness.operations.launch(replacement);

		expect(current(fixture.state, replacement.id)).toMatchObject({
			state: "working",
			replacementOf: id,
		});
		expect(runner.commands()).toContain(
			`herdr agent prompt ${agentOf(replacement.id)} /grill continue the review`,
		);
	});

	test("refuses a Replacement of a Consultation the operator can still use", () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("3");
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		const harness = makeHarness(fixture, runner);

		const replacement = harness.operations.replace(consultation, {
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "continue",
		});

		expect(replacement).toBeUndefined();
		expect(statusTexts(harness).at(-1)).toContain("not one that is working");
		expect(fixture.state.consultationRecord.consultations("all")).toHaveLength(1);
	});

	test("builds the bounded recovery context the launcher shows", () => {
		const fixture = makeFixture();
		const id = uid("4");
		seedFailedWithHistory(fixture, id);
		const harness = makeHarness(fixture, new LifecycleRunner());

		const context = harness.operations.replacementInput(id);

		expect(utf8ByteLength(context)).toBeLessThanOrEqual(CONSULTATION_INPUT_LIMIT);
		expect(context).toContain("Original input:\nreview auth");
		expect(context).toContain("note: keep going");
	});

	test("deletes a closed Consultation's local history", () => {
		const fixture = makeFixture();
		const id = uid("5");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, new LifecycleRunner());
		fixture.state.consultationRecord.beginConsultationClose(id);
		fixture.state.consultationRecord.finishConsultationClose(id);

		expect(harness.operations.delete(consultation)).toBe(true);
		expect(fixture.state.consultationRecord.consultation(id)).toBeUndefined();
		expect(statusTexts(harness).at(-1)).toContain("deleted; backups may retain data");
	});

	test("refuses to delete a Consultation that is still open", () => {
		const fixture = makeFixture();
		const id = uid("6");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, new LifecycleRunner());

		expect(harness.operations.delete(consultation)).toBe(false);
		expect(fixture.state.consultationRecord.consultation(id)).toBeDefined();
		expect(harness.statuses).toHaveLength(0);
	});
});

describe("Consultation operations: stale Agent output", () => {
	test("records a failed read and clears it when a read succeeds", () => {
		const fixture = makeFixture();
		const id = uid("7");
		seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, new LifecycleRunner());

		harness.operations.recordOutputRead(id, null);
		expect(current(fixture.state, id).warning).toBe(STALE_AGENT_OUTPUT_WARNING);
		const changesAfterSet = harness.changes;
		// A repeated failed read reports the same fact, so it changes nothing.
		harness.operations.recordOutputRead(id, null);
		expect(harness.changes).toBe(changesAfterSet);

		harness.operations.recordOutputRead(id, "fresh lines");
		expect(current(fixture.state, id).warning).toBeNull();
		expect(harness.changes).toBe(changesAfterSet + 1);
	});

	test("clears the stale warning an observation left behind", () => {
		const fixture = makeFixture();
		const id = uid("8");
		seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		const harness = makeHarness(fixture, new LifecycleRunner());

		// The settled turn could not read its output: the warning is recorded.
		fixture.state.consultationRecord.settleConsultationTurn(id, null, null);
		expect(current(fixture.state, id).warning).toBe(STALE_AGENT_OUTPUT_WARNING);

		harness.operations.recordOutputRead(id, "the Agent answered");
		expect(current(fixture.state, id).warning).toBeNull();
	});

	test("clears the legacy stale-output spelling", () => {
		const fixture = makeFixture();
		const id = uid("9");
		seed(fixture.state, fixture, id);
		fixture.state.consultationRecord.setConsultationWarning(id, "Agent output is stale");
		const harness = makeHarness(fixture, new LifecycleRunner());

		harness.operations.recordOutputRead(id, "the Agent answered");

		expect(current(fixture.state, id).warning).toBeNull();
	});

	test("keeps a warning that is not about stale output", () => {
		const fixture = makeFixture();
		const id = uid("9");
		seed(fixture.state, fixture, id);
		fixture.state.consultationRecord.setConsultationWarning(
			id,
			"the live checkout has uncommitted changes",
		);
		const harness = makeHarness(fixture, new LifecycleRunner());

		harness.operations.recordOutputRead(id, "fresh lines");
		expect(current(fixture.state, id).warning).toBe("the live checkout has uncommitted changes");
		harness.operations.recordOutputRead(id, null);
		expect(current(fixture.state, id).warning).toBe(STALE_AGENT_OUTPUT_WARNING);
	});

	test("ignores a read of a Consultation that no longer exists", () => {
		const fixture = makeFixture();
		const harness = makeHarness(fixture, new LifecycleRunner());

		expect(() => harness.operations.recordOutputRead(uid("a"), null)).not.toThrow();
		expect(harness.changes).toBe(0);
	});
});

describe("Consultation operations: Agent interaction input", () => {
	test("owns ordered terminal input and flushes it", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);

		harness.operations.enqueue("pane-1", { kind: "text", text: "hello" });
		await harness.operations.enqueue("pane-1", { kind: "key", key: "enter" });
		await harness.operations.flush();

		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 hello",
			"herdr pane send-keys pane-1 enter",
		]);
	});

	test("batches pasted text, keeps keys in order, and respects the byte bound", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner, { textBatchBytes: 8 });

		// Two keystrokes of one paste settle as one command, at the bound.
		harness.operations.enqueue("pane-1", { kind: "text", text: "aaaa" });
		await harness.operations.enqueue("pane-1", { kind: "text", text: "bbbb" });
		// A key waits for the whole batch that came before it.
		await harness.operations.enqueue("pane-1", { kind: "key", key: "tab" });
		harness.operations.enqueue("pane-1", { kind: "text", text: "cc" });
		await harness.operations.enqueue("pane-1", { kind: "text", text: "dd" });
		// Five 2-byte characters in one batch: the bound cuts between them, never
		// through one.
		harness.operations.enqueue("pane-1", { kind: "text", text: "\u00e9\u00e9\u00e9\u00e9" });
		await harness.operations.enqueue("pane-1", { kind: "text", text: "\u00e9" });
		await harness.operations.flush();

		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 aaaabbbb",
			"herdr pane send-keys pane-1 tab",
			"herdr pane send-text pane-1 ccdd",
			"herdr pane send-text pane-1 \u00e9\u00e9\u00e9\u00e9",
			"herdr pane send-text pane-1 \u00e9",
		]);
	});

	test("settles the queued input for the pane the operator left", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);

		harness.operations.enqueue("pane-1", { kind: "text", text: "partial" });
		// Switching panes flushes what the first Agent was owed first.
		harness.operations.enqueue("pane-2", { kind: "key", key: "escape" });
		await harness.operations.flush();

		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 partial",
			"herdr pane send-keys pane-2 escape",
		]);
	});

	test("reports a failed key so the view can name the Agent interaction error", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		runner.inner.set("herdr", ["pane", "send-keys", "pane-1", "enter"], {
			code: 1,
			stderr: "pane is gone\n",
		});
		const harness = makeHarness(fixture, runner);

		const result = await harness.operations.enqueue("pane-1", { kind: "key", key: "enter" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("pane is gone");
	});
});

describe("Consultation operations: Repository serialization", () => {
	test("serializes a launch and a close on one Repository, and no others", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const launchId = uid("b");
		const closeId = uid("c");
		const launching = seed(fixture.state, fixture, launchId);
		const closing = seed(fixture.state, fixture, closeId);
		startAgent(fixture.state, closeId);
		seedResources(fixture.state, closeId);
		stubOwnAgent(runner.inner, closeId);
		stubWorktreeLaunch(runner.inner, fixture.checkout, launchId);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		runner.holdWhile((command) => command.startsWith("herdr worktree create"));
		const harness = makeHarness(fixture, runner);

		const launch = harness.operations.launch(launching);
		await until(
			() => runner.attempts.some((c) => c.startsWith("herdr worktree create")),
			"the held worktree create",
		);
		const close = harness.operations.close(closing);
		// The close waits for the launch's Repository queue: it has not started.
		expect(runner.attempts.some((c) => c.startsWith("herdr agent read"))).toBe(false);
		runner.release();
		await Promise.all([launch, close]);

		const attempts = runner.attempts;
		expect(
			attempts.indexOf(
				`herdr worktree create --cwd ${fixture.checkout} --branch ${consultationBranchName(launchId, "grill")} --base origin/main --no-focus`,
			),
		).toBeLessThan(
			attempts.indexOf(
				`herdr agent read ${LAUNCH.paneId} --lines 200 --source recent-unwrapped --format text`,
			),
		);
		expect(current(fixture.state, launchId).state).toBe("working");
		expect(current(fixture.state, closeId).state).toBe("closed");
	});

	test("reports concurrent progress under each Consultation's own owner", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(bothCheckoutsWorld(fixture)));
		const firstId = uid("g");
		const secondId = uid("h");
		const first = seed(fixture.state, fixture, firstId);
		const second = seed(fixture.state, fixture, secondId, {
			repository: fixture.otherRepository,
		});
		stubWorktreeLaunch(runner.inner, fixture.checkout, firstId);
		stubWorktreeLaunch(runner.inner, fixture.otherCheckout, secondId, {
			handles: LAUNCH,
			displayName: "other",
		});
		runner.holdWhile(
			(command) =>
				command.startsWith("herdr worktree create") && command.includes(fixture.checkout),
		);
		const harness = makeHarness(fixture, runner);

		const firstLaunch = harness.operations.launch(first);
		const secondLaunch = harness.operations.launch(second);
		// The first launch is held on its Repository; the second runs on its
		// own. While both are in flight, each line must carry its own id.
		await until(
			() =>
				harness.progress.some(
					(entry) => entry.owner === secondId && entry.text.endsWith(": starting-agent"),
				),
			"the second Consultation to reach its Agent",
		);
		// The held launch has reported only its own open stages so far.
		expect(stages(harness.progress.filter((entry) => entry.owner === firstId))).toEqual([
			"resolving-repository",
			"creating-environment",
		]);
		// The second has run ahead under its own id, never under the first's.
		expect(
			stages(harness.progress.filter((entry) => entry.owner === secondId)).slice(0, 3),
		).toEqual(["resolving-repository", "creating-environment", "starting-agent"]);
		runner.release();
		await Promise.all([firstLaunch, secondLaunch]);

		// Every line names the Consultation that produced it, and each
		// Consultation reports its own full stage sequence under its own id.
		for (const id of [firstId, secondId])
			expect(stages(harness.progress.filter((entry) => entry.owner === id))).toEqual([
				"resolving-repository",
				"creating-environment",
				"starting-agent",
				"sending-prompt",
			]);
	});

	test("lets a second Repository work while the first is held", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(bothCheckoutsWorld(fixture)));
		const held = uid("d");
		const other = uid("e");
		const heldConsultation = seed(fixture.state, fixture, held);
		const otherConsultation = seed(fixture.state, fixture, other, {
			repository: fixture.otherRepository,
		});
		stubWorktreeLaunch(runner.inner, fixture.checkout, held);
		stubWorktreeLaunch(runner.inner, fixture.otherCheckout, other, {
			handles: LAUNCH,
			displayName: "other",
		});
		runner.holdWhile(
			(command) =>
				command.startsWith("herdr worktree create") && command.includes(fixture.checkout),
		);
		const harness = makeHarness(fixture, runner);

		const first = harness.operations.launch(heldConsultation);
		const second = harness.operations.launch(otherConsultation);
		// The held Repository is still blocked while the other one works.
		await until(
			() => runner.commands().some((c) => c.startsWith(`herdr agent prompt ${agentOf(other)}`)),
			"the second Repository to reach its Agent",
		);
		// The held Repository is still blocked: it never reached its Agent.
		expect(
			runner.commands().some((c) => c.includes(agentOf(held)) && c.startsWith("herdr agent")),
		).toBe(false);
		runner.release();
		await Promise.all([first, second]);

		expect(current(fixture.state, held).state).toBe("working");
		expect(current(fixture.state, other).state).toBe("working");
	});
});
describe("Consultation operations: the Work queue pickup (ADR 0034, issue #90)", () => {
	test("a queued submit creates the record and its queue item, and starts nothing", () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);

		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		expect(consultation).toEqual(
			expect.objectContaining({ state: "queued", paneId: null, workspaceId: null }),
		);
		const queue = fixture.state.workQueue.items();
		expect(queue).toHaveLength(1);
		if (consultation === undefined) throw new Error("the queued submit created no record");
		expect(queue[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: consultation.id }),
		);
		// The enqueue is not a start: no repository resolve, no environment,
		// no agent.
		expect(runner.commands()).toEqual([]);
	});

	test("the pickup re-reads the type's settings from the config before it starts", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const harness = makeHarness(fixture, runner);
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		// The type changes while the record waits: a new model, a new
		// template. The pickup starts the record on the type the config holds
		// now, not on the settings the enqueue captured.
		fixture.config.consultationTypes.grill = {
			agent: "pi",
			environment: "worktree",
			model: "review-model",
			template: "/re-grill {input}",
		};
		const branch = consultationBranchName(id, "grill");
		runner.inner.set("git", ["-C", fixture.checkout, "branch", "--list", branch], {
			stdout: "",
		});
		runner.inner.set("git", ["-C", fixture.checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.inner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				fixture.checkout,
				"--branch",
				branch,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson(LAUNCH.workspaceId, LAUNCH.paneId) },
		);
		runner.inner.set(
			"herdr",
			["agent", "start", agentOf(id), "--kind", "pi", "--pane", LAUNCH.paneId],
			{ stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }) },
		);
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "/re-grill review auth"], {
			code: 0,
		});
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: opened");

		const outcome = await harness.operations.pickup(id, "pickup");

		// The answer comes at the seat: the record left `queued` and holds its
		// seat in `opening`, and the environment and the Agent are built behind
		// it. Wait for that opening to settle before reading the record.
		expect(outcome).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "working",
			"the picked-up Consultation to work",
		);
		const started = current(fixture.state, id);
		expect(started).toMatchObject({
			state: "working",
			model: "review-model",
			template: "/re-grill {input}",
			renderedOpeningPrompt: "/re-grill review auth",
			initialInput: "review auth",
			paneId: LAUNCH.paneId,
		});
		// The prompt went out with the re-read template. The claim took the
		// record's pointer with it: the store keeps an item only while its
		// record waits, and the loop's own removal covers the answers that
		// claimed nothing.
		expect(runner.commands()).toContain(`herdr agent prompt ${agentOf(id)} /re-grill review auth`);
		expect(fixture.state.workQueue.items()).toHaveLength(0);
	});

	test("the pickup answers at the seat and lets the opening run behind it", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const harness = makeHarness(fixture, runner);
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		const branch = consultationBranchName(id, "grill");
		runner.inner.set("git", ["-C", fixture.checkout, "branch", "--list", branch], { stdout: "" });
		runner.inner.set("git", ["-C", fixture.checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.inner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				fixture.checkout,
				"--branch",
				branch,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson(LAUNCH.workspaceId, LAUNCH.paneId) },
		);
		runner.inner.set(
			"herdr",
			["agent", "start", agentOf(id), "--kind", "pi", "--pane", LAUNCH.paneId],
			{ stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }) },
		);
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "/grill review auth"], { code: 0 });
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: opened");
		// The environment build is held: this is the wait a cold clone or a slow
		// worktree create makes an observation cycle pay, and the pickup must not
		// make the loop - and every ticket poll in it - wait through it.
		runner.holdWhile((command) => command.startsWith("herdr worktree create"));

		const outcome = await harness.operations.pickup(id, "pickup");

		// The answer came at the seat: the record holds it, no Agent is up yet,
		// and the opening is running on behind the answer.
		expect(outcome).toEqual({ kind: "started" });
		await until(
			() => runner.attempts.some((c) => c.startsWith("herdr worktree create")),
			"the held environment build",
		);
		expect(current(fixture.state, id)).toMatchObject({ state: "opening", paneId: null });
		runner.release();
		// The start the pickup handed over settles on its own, to the same end a
		// direct launch reaches.
		await until(
			() => current(fixture.state, id).state === "working",
			"the released opening to reach its Agent",
		);
		expect(current(fixture.state, id).paneId).toBe(LAUNCH.paneId);
	});

	test("a pickup whose start fails leaves the record failed with its reason", async () => {
		const fixture = makeFixture("gpt-4o");
		const runner = new LifecycleRunner();
		runner.inner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const harness = makeHarness(fixture, runner);
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;

		const outcome = await harness.operations.pickup(id, "pickup");

		// The claim takes the seat, and the Setting fit check runs in the
		// opening behind it: the record fails the way a launch fails it, with
		// the readable reason, and nothing external runs.
		expect(outcome).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "failed",
			"the picked-up Consultation to fail",
		);
		expect(current(fixture.state, id)).toMatchObject({
			state: "failed",
			paneId: null,
			failure: expect.stringContaining('has no model "gpt-4o"'),
		});
		expect(runner.commands()).toEqual([]);
		expect(statusTexts(harness).join("\n")).toContain('has no model "gpt-4o"');
	});

	test("a pickup of a record that left the queue's wait starts nothing", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);

		// An opening record is not one the queue holds: the pickup refuses
		// it and the module's launch route stays the only starter.
		const opening = seed(fixture.state, fixture, uid("p"));
		expect(await harness.operations.pickup(opening.id, "pickup")).toEqual({ kind: "moved" });
		expect(runner.commands()).toEqual([]);
		// A record that is gone answers the same way.
		expect(await harness.operations.pickup(uid("x"), "pickup")).toEqual({ kind: "moved" });
		expect(fixture.state.consultationRecord.consultations("all")).toHaveLength(1);
	});

	test("a pickup whose type left the config fails the record", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		// The type the record asks for is no longer in the config.
		delete fixture.config.consultationTypes.grill;

		const outcome = await harness.operations.pickup(id, "pickup");

		expect(outcome).toEqual({ kind: "failed" });
		expect(current(fixture.state, id)).toMatchObject({
			state: "failed",
			failure: "unknown Consultation type grill",
		});
		expect(runner.commands()).toEqual([]);
		expect(statusTexts(harness).at(-1)).toContain("unknown Consultation type grill");
	});

	test("a queued Replacement links to its record and waits in the queue", () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const harness = makeHarness(fixture, runner);
		const failed = seed(fixture.state, fixture, uid("f"));
		fixture.state.consultationRecord.setConsultationState(
			failed.id,
			"failed",
			"the Agent went missing",
		);

		const replacement = harness.operations.replace(failed, {
			typeName: "grill",
			repository: fixture.repository,
			queued: true,
		});
		expect(replacement).toEqual(
			expect.objectContaining({
				state: "queued",
				replacementOf: failed.id,
			}),
		);
		if (replacement === undefined) throw new Error("the queued replacement created no record");
		const queue = fixture.state.workQueue.items();
		expect(queue).toHaveLength(1);
		expect(queue[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: replacement.id }),
		);
		expect(runner.commands()).toEqual([]);
	});
});

describe("Consultation operations: the start line (issue #220)", () => {
	/** The seats the Parallel limit counts for Consultations alone. */
	function consultationSeats(state: FactoryState): number {
		return state.consultationRecord.consultationsByState(["opening", "working"]).length;
	}

	/** Stub the whole opening one picked-up record runs behind its answer. */
	function stubOpening(
		fixture: Fixture,
		runner: LifecycleRunner,
		id: string,
		handles = LAUNCH,
	): void {
		stubWorktreeLaunch(runner.inner, fixture.checkout, id, { handles: handles });
		runner.inner.set("herdr", ["agent", "prompt", agentOf(id), "/grill review auth"], { code: 0 });
		stubPaneRead(runner.inner, handles.paneId, "Agent: opened");
	}

	test("the Work queue pickup writes its start line with its mode and its seat reading", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			seatCount: () => consultationSeats(fixture.state),
		});
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		stubOpening(fixture, runner, id);

		expect(await harness.operations.pickup(id, "pickup")).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "working",
			"the picked-up Consultation to work",
		);

		// The line is the shape the `handoff started:` and `merge started:` lines
		// use. The name is the record's Consultation type beside the identity
		// prefix every other Consultation line names it by. The seat reading is
		// measured before the seat is taken: the record is a seat only after the
		// move, so the line states the count the cap gate stood on, never a count
		// this start raised.
		expect(lines).toEqual([
			infoLine(
				`consultation started: "grill" ${id.slice(0, 8)} (mode pickup, origin consultation, seats 0/2)`,
			),
		]);
	});

	test("a force-dispatch start line names the cap it ran over", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			// The cap is full at the key: the reading the operator's start now ran over.
			seatCount: () => fixture.config.maxParallelAgents,
		});
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		stubOpening(fixture, runner, id);

		expect(await harness.operations.pickup(id, "force-dispatch")).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "working",
			"the force-dispatched Consultation to work",
		);

		expect(lines).toEqual([
			infoLine(
				`consultation started: "grill" ${id.slice(0, 8)} (mode force-dispatch, origin consultation, seats 2/2)`,
			),
		]);
	});

	test("the operator's key names its mode whatever the seat reading says", async () => {
		// A Consultation's mode names the key, not a cap crossing (ADR 0102): the
		// App names the start now key `force-dispatch` even when the cap has free
		// seats, so `mode force-dispatch` beside `seats 0/2` is a legal line and a
		// normal start, not a contradiction of ADR 0092's reading rule.
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			// Nothing holds a seat at the key.
			seatCount: () => consultationSeats(fixture.state),
		});
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		stubOpening(fixture, runner, id);

		expect(await harness.operations.pickup(id, "force-dispatch")).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "working",
			"the Consultation the operator started to work",
		);

		expect(lines).toEqual([
			infoLine(
				`consultation started: "grill" ${id.slice(0, 8)} (mode force-dispatch, origin consultation, seats 0/2)`,
			),
		]);
	});

	test("an unlimited cap states its held seats with no limit", async () => {
		const fixture = makeFixture();
		fixture.config.maxParallelAgents = 0;
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchWorld(fixture.repository)));
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			// Work is held on two seats, and the lifted cap states none of them.
			seatCount: () => 2,
		});
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const id = consultation.id;
		stubOpening(fixture, runner, id);

		expect(await harness.operations.pickup(id, "pickup")).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, id).state === "working",
			"the picked-up Consultation to work",
		);

		expect(lines).toEqual([
			infoLine(
				`consultation started: "grill" ${id.slice(0, 8)} (mode pickup, origin consultation, seats 2)`,
			),
		]);
	});

	test("a start that claims nothing writes no start line", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			seatCount: () => consultationSeats(fixture.state),
		});
		// A record that left the queue's wait, and a record whose type left the
		// config: neither takes a seat, so neither leaves a start line.
		expect(await harness.operations.pickup(uid("x"), "pickup")).toEqual({ kind: "moved" });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		delete fixture.config.consultationTypes.grill;
		expect(await harness.operations.pickup(consultation.id, "force-dispatch")).toEqual({
			kind: "failed",
		});
		expect(lines).toEqual([]);
	});

	test("the Work queue's pickup and the operator's force-dispatch read differently in the record", async () => {
		// The issue #220 case, wired the way the app wires it: the real Consultation
		// operations behind the real Handoff dispatch's Consultation seam, on one
		// logger. `max-parallel-agents = 1`, two queued records, and the log file
		// has to say which path took the one seat.
		const fixture = makeFixture();
		fixture.config.maxParallelAgents = 1;
		const runner = new LifecycleRunner(
			stubHerdrWorld(
				worktreeLaunchWorld(fixture.repository, [
					{ workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" },
					{ workspaceId: "ws-b", tabId: "tab-b", paneId: "pane-b" },
				]),
			),
		);
		const lines: RecordedLine[] = [];
		const harness = makeHarness(fixture, runner, {
			log: recordLogger(lines),
			seatCount: () => consultationSeats(fixture.state),
		});
		const dispatch = createHandoffDispatch({
			state: fixture.state,
			runner,
			config: () => fixture.config,
			seatCount: () => consultationSeats(fixture.state),
			home: fixture.home,
			pickupConsultation: (consultationId, mode) => harness.operations.pickup(consultationId, mode),
			working: () => {},
			warning: () => {},
			faultWarning: () => {},
			error: () => {},
			faultError: () => {},
			notice: () => {},
			clearWorking: () => {},
			refresh: () => {},
			starting: () => {},
			log: recordLogger(lines),
		});
		const first = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		const second = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review the fix",
			queued: true,
		});
		if (first === undefined || second === undefined)
			throw new Error("the queued submits created no records");
		stubOpening(fixture, runner, first.id, {
			workspaceId: "ws-a",
			tabId: "tab-a",
			paneId: "pane-a",
		});
		stubOpening(fixture, runner, second.id, {
			workspaceId: "ws-b",
			tabId: "tab-b",
			paneId: "pane-b",
		});

		// The pickup takes the one free seat for the leading row and holds the
		// other row behind the cap it cannot cross.
		expect(await dispatch.pickupWorkQueue()).toBe(1);
		expect(fixture.state.workQueue.items()).toHaveLength(1);
		// The operator's key starts the waiting row over the full cap.
		dispatch.forceDispatchWorkQueueItem(second.id);

		await until(
			() =>
				current(fixture.state, first.id).state === "working" &&
				current(fixture.state, second.id).state === "working",
			"both Consultations to reach their Agents",
		);
		dispatch.stop();

		expect(lines).toEqual([
			infoLine(
				`consultation started: "grill" ${first.id.slice(0, 8)} (mode pickup, origin consultation, seats 0/1)`,
			),
			infoLine(
				`consultation started: "grill" ${second.id.slice(0, 8)} (mode force-dispatch, origin consultation, seats 1/1)`,
			),
		]);
	});
});

describe("Consultation operations: the Shared checkout gate (issue #315, ADR 0109)", () => {
	/** One act the caller performed on the hold seam. */
	interface HoldCall {
		kind: "cross" | "take" | "release";
		consultationId: string;
		key?: string | null;
	}

	/**
	 * A stubbed Shared checkout hold: the answers the gate gives, and the acts
	 * the caller performs on the seam, so the operations' half of the gate is
	 * measurable without the dispatch's ledger, which the ledger and the
	 * dispatch suites own.
	 */
	function holdStub(answer: (consultationId: string) => CheckoutGate): {
		stub: ConsultationCheckoutHold;
		calls: HoldCall[];
	} {
		const calls: HoldCall[] = [];
		return {
			calls,
			stub: {
				cross: (consultationId) => {
					calls.push({ kind: "cross", consultationId });
					return answer(consultationId);
				},
				take: (consultationId, key) => {
					calls.push({ kind: "take", consultationId, key });
				},
				release: (consultationId) => {
					calls.push({ kind: "release", consultationId });
				},
			},
		};
	}

	test("a queued worktree pickup waits at the gate, and the record keeps its seat in the queue", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const hold = holdStub(() => ({
			ok: false,
			outcome: "waiting",
			fact: "the shared checkout is at work",
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const outcome = await harness.operations.pickup(consultation.id, "pickup");
		expect(outcome).toEqual({ kind: "waiting", fact: "the shared checkout is at work" });
		// The wait keeps its row: the record keeps its `queued` state, the row
		// stands in the queue for the pass that finds the checkout free, and no
		// environment work ran.
		expect(current(fixture.state, consultation.id).state).toBe("queued");
		expect(fixture.state.workQueue.hasConsultationItem(consultation.id)).toBe(true);
		expect(hold.calls.filter((call) => call.kind === "take")).toEqual([]);
		expect(runner.commands()).toEqual([]);
	});

	test("the refusal the bound gives is a failed record, on the refusal's own seam", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const hold = holdStub(() => ({
			ok: false,
			outcome: "refused",
			fact: CHECKOUT_ROW_OVER_BUDGET_FACT,
			start: { side: "consultation", channel: "consultation" },
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		const outcome = await harness.operations.pickup(consultation.id, "pickup");
		expect(outcome).toEqual({ kind: "refused", fact: CHECKOUT_ROW_OVER_BUDGET_FACT });
		// The pickup refuses nothing itself: the record still waits and the row
		// still stands, until the dispatch's refusal runs on the record's own seam.
		expect(current(fixture.state, consultation.id).state).toBe("queued");
		harness.operations.refusePickup(consultation.id, CHECKOUT_ROW_OVER_BUDGET_FACT);
		expect(current(fixture.state, consultation.id)).toMatchObject({
			state: "failed",
			failure: CHECKOUT_ROW_OVER_BUDGET_FACT,
		});
		expect(
			harness.statuses.some(
				(status) =>
					status.kind === "error" &&
					status.text ===
						`Consultation ${consultation.id.slice(0, 8)} failed: ${CHECKOUT_ROW_OVER_BUDGET_FACT}`,
			),
		).toBe(true);
		// A refusal that finds a record that left `queued` changes nothing: the
		// state the close owns is not the refusal's to write.
		harness.operations.refusePickup(consultation.id, "a second refusal");
		expect(current(fixture.state, consultation.id).failure).toBe(CHECKOUT_ROW_OVER_BUDGET_FACT);
	});

	test("the direct start now of a record that holds no row answers the key, and starts nothing", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const hold = holdStub(() => ({
			ok: false,
			outcome: "waiting",
			fact: "the shared checkout is at work",
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		// The operator's Delete of the row: the record moves to `unscheduled` and
		// the queue holds no row for it.
		fixture.state.consultationRecord.removeConsultationWorkItem(consultation.id);
		expect(current(fixture.state, consultation.id).state).toBe("unscheduled");
		// The operator's start now: the checkout is at work, and there is no row
		// to stand the wait, so the key answers with the fact and the start runs
		// nothing.
		const outcome = await harness.operations.pickup(consultation.id, "force-dispatch");
		expect(outcome).toEqual({ kind: "held", fact: "the shared checkout is at work" });
		expect(current(fixture.state, consultation.id).state).toBe("unscheduled");
		expect(runner.commands()).toEqual([]);
		expect(
			harness.statuses.some(
				(status) =>
					status.kind === "warning" &&
					status.text ===
						`Consultation ${consultation.id.slice(0, 8)} did not start: the shared checkout is at work`,
			),
		).toBe(true);
	});

	test("a pickup that crosses a free gate takes the hold, and the settle lets it go", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const hold = holdStub(() => ({ ok: true, checkoutKey: "github.com/acme/factory" }));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		stubPaneRead(runner.inner, WORKTREE_LAUNCH.paneId, "Agent: opened");
		const outcome = await harness.operations.pickup(consultation.id, "pickup");
		expect(outcome).toEqual({ kind: "started" });
		// The take ran in the claim's own step, with the gate's key.
		expect(hold.calls).toContainEqual({
			kind: "take",
			consultationId: consultation.id,
			key: "github.com/acme/factory",
		});
		await until(
			() => current(fixture.state, consultation.id).state === "working",
			"the picked-up Consultation to work",
		);
		// The let-go runs where the opening settles, behind the state move.
		await until(() => hold.calls.some((call) => call.kind === "release"), "the hold release");
		expect(hold.calls.filter((call) => call.kind === "release")).toEqual([
			{ kind: "release", consultationId: consultation.id },
		]);
	});

	test("a live-worktree pickup crosses no gate", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const hold = holdStub(() => ({
			ok: false,
			outcome: "waiting",
			fact: "the shared checkout is at work",
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill-live",
			repository: fixture.repository,
			initialInput: "review auth",
			queued: true,
		});
		if (consultation === undefined) throw new Error("the queued submit created no record");
		stubLiveLaunch(runner.inner, fixture.checkout, consultation.id);
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const outcome = await harness.operations.pickup(consultation.id, "pickup");
		expect(outcome).toEqual({ kind: "started" });
		await until(
			() => current(fixture.state, consultation.id).state === "working",
			"the picked-up Consultation to work",
		);
		// The live-worktree start works a checkout the operator chose and already
		// owns: the seam is never crossed, and the let-go the settle issues is the
		// idempotent release the hold gives to a start that took none.
		await until(() => hold.calls.length > 0, "the idempotent let-go");
		expect(hold.calls).toEqual([{ kind: "release", consultationId: consultation.id }]);
	});

	test("a recovery that meets a held checkout answers the key, and the record keeps its opening", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const hold = holdStub(() => ({
			ok: false,
			outcome: "waiting",
			fact: "the shared checkout is at work",
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
		});
		if (consultation === undefined) throw new Error("the create made no record");
		// The record stands `opening` with no pane and no session: the start that
		// crashed before its Agent stood, the record the operator's recovery
		// re-runs from the Consultation surface.
		expect(current(fixture.state, consultation.id)).toMatchObject({
			state: "opening",
			paneId: null,
			sessionId: null,
		});
		// The re-run is another start, and it crosses the same gate: the checkout
		// is at work, the record holds no queue row to stand the wait, so the key
		// answers with the fact, the record keeps `opening`, and no environment
		// work ran.
		await harness.operations.recover(consultation);
		expect(current(fixture.state, consultation.id).state).toBe("opening");
		expect(hold.calls).toEqual([{ kind: "cross", consultationId: consultation.id }]);
		expect(runner.commands()).toEqual([]);
		expect(
			harness.statuses.some(
				(status) =>
					status.kind === "warning" &&
					status.text ===
						`Consultation ${consultation.id.slice(0, 8)} did not start: the shared checkout is at work`,
			),
		).toBe(true);
	});

	test("a recovery that crosses a free gate takes the hold, and the settle lets it go", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(stubHerdrWorld(worktreeLaunchStanding(fixture.repository)));
		const hold = holdStub(() => ({ ok: true, checkoutKey: "github.com/acme/factory" }));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "review auth",
		});
		if (consultation === undefined) throw new Error("the create made no record");
		expect(current(fixture.state, consultation.id)).toMatchObject({
			state: "opening",
			paneId: null,
			sessionId: null,
		});
		stubPaneRead(runner.inner, WORKTREE_LAUNCH.paneId, "Agent: opened");
		await harness.operations.recover(consultation);
		// The take ran in the recovery's own step, with the gate's key, before the
		// re-run reached its first command.
		expect(hold.calls).toContainEqual({
			kind: "take",
			consultationId: consultation.id,
			key: "github.com/acme/factory",
		});
		await until(
			() => current(fixture.state, consultation.id).state === "working",
			"the recovered Consultation to work",
		);
		// The let-go runs where the opening settles, behind the state move.
		await until(() => hold.calls.some((call) => call.kind === "release"), "the hold release");
		expect(hold.calls.filter((call) => call.kind === "release")).toEqual([
			{ kind: "release", consultationId: consultation.id },
		]);
	});

	test("a live-worktree recovery crosses no gate", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner(
			stubHerdrWorld(liveLaunchWorld(fixture.repository, "ws-live")),
		);
		const hold = holdStub(() => ({
			ok: false,
			outcome: "waiting",
			fact: "the shared checkout is at work",
		}));
		const harness = makeHarness(fixture, runner, { checkoutHold: hold.stub });
		const consultation = harness.operations.create({
			typeName: "grill-live",
			repository: fixture.repository,
			initialInput: "review auth",
		});
		if (consultation === undefined) throw new Error("the create made no record");
		expect(current(fixture.state, consultation.id)).toMatchObject({
			state: "opening",
			paneId: null,
			sessionId: null,
		});
		stubLiveLaunch(runner.inner, fixture.checkout, consultation.id);
		runner.inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		await harness.operations.recover(consultation);
		await until(
			() => current(fixture.state, consultation.id).state === "working",
			"the recovered Consultation to work",
		);
		// The live-worktree start works a checkout the operator chose and already
		// owns: the seam is never crossed, and the let-go the settle issues is the
		// idempotent release the hold gives to a start that took none.
		expect(hold.calls).toEqual([{ kind: "release", consultationId: consultation.id }]);
	});
});
