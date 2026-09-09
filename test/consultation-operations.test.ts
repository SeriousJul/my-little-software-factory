/**
 * The whole Consultation lifecycle through one interface, with no terminal.
 *
 * Every test drives the Consultation operations module the way the control
 * plane does: a fake command runner that records the exact herdr and git calls,
 * a real SQLite state file that holds the durable record, and stub callbacks
 * that collect the facts the view gets back. Together they pin what issue #33
 * asked for: launch and its stages, the live checkout conflict and its one-shot
 * confirmation, recovery of an interrupted opening, response delivery and its
 * failure, close topology and retry, Force-close and the guard it shares with
 * close, Replacement bounds and linking, deletion, the Stale Agent output
 * warning, and the ordered interaction input queue.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import {
	CONSULTATION_INPUT_LIMIT,
	type ConsultationRepositoryOption,
	STALE_AGENT_OUTPUT_WARNING,
	utf8ByteLength,
} from "../src/consultation.ts";
import {
	type ConsultationOperations,
	type ConsultationSafetyConflict,
	type ConsultationStatus,
	createConsultationOperations,
} from "../src/consultation-operations.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { consultationBranchName } from "../src/naming.ts";
import type { RepositoryMapping } from "../src/repo.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/runner.ts";
import { type Consultation, type FactoryState, openFactoryState } from "../src/state.ts";
import { agentListJson, FakeRunner, tabCreateJson, worktreeCreateJson } from "./fake-runner.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

/** A deterministic Consultation id, so its branch and Agent name are pinnable. */
const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;
/** The herdr name the seed gives a Consultation with that id. */
const agentOf = (id: string) => `consultation-${id.slice(0, 8)}`;
/** The pane, tab, and workspace handles a launched worktree Consultation takes. */
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
	const repository = {
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
		path: checkout,
	};
	return {
		state: openFactoryState(join(home, "state.sqlite")),
		config: {
			...DEFAULT_CONFIG,
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
	return state.createConsultation({
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
	state.setConsultationAgent(id, {
		paneId: handles.paneId,
		tabId: handles.tabId,
		workspaceId: handles.workspaceId,
		sessionId: `sess-${id.slice(0, 8)}`,
	});
}

/** Record the resources a worktree launch owns, as the module's launch does. */
function seedResources(state: FactoryState, id: string, handles = LAUNCH): void {
	const agentName = agentOf(id);
	state.recordConsultationResource(id, {
		kind: "workspace",
		resourceId: handles.workspaceId,
		owned: true,
		details: "Consultation worktree workspace",
	});
	state.recordConsultationResource(id, {
		kind: "worktree",
		resourceId: handles.workspaceId,
		owned: true,
		details: `Consultation worktree checkout for ${consultationBranchName(id, "grill")}`,
	});
	state.recordConsultationResource(id, {
		kind: "tab",
		resourceId: handles.tabId,
		owned: true,
		details: "Consultation worktree tab",
	});
	state.recordConsultationResource(id, {
		kind: "pane",
		resourceId: handles.paneId,
		owned: true,
		details: "Consultation Agent pane",
	});
	state.recordConsultationResource(id, {
		kind: "agent",
		resourceId: agentName,
		owned: true,
		details: `Agent hosted by pane ${handles.paneId}`,
	});
}

/** The Module runner: a fake that records, answers, and can hold one call. */
class LifecycleRunner implements CommandRunner {
	/** Every command attempted, in order, including a command still held. */
	readonly attempts: string[] = [];
	/** The answers the fake holds, and the source of every recorded command. */
	readonly inner: FakeRunner;
	private waiting: (() => void)[] = [];
	private hold: ((command: string) => boolean) | null = null;

	constructor(inner: FakeRunner = new FakeRunner()) {
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
}

/** Wire the module to a fixture, collecting the facts its callbacks report. */
function makeHarness(
	fixture: Fixture,
	runner: CommandRunner,
	options: {
		controlPlaneWorkspaceId?: string | null;
		home?: string;
		tickets?: () => readonly Ticket[];
		persistRepositoryMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
		textBatchBytes?: number;
	} = {},
): Harness {
	const reported: (ConsultationStatus | null)[] = [];
	const statuses: ConsultationStatus[] = [];
	const conflicts: ConsultationSafetyConflict[] = [];
	const harness: Harness = {
		operations: createConsultationOperations({
			state: fixture.state,
			runner,
			config: () => fixture.config,
			home: options.home ?? fixture.home,
			tickets: options.tickets ?? (() => []),
			controlPlaneWorkspaceId: options.controlPlaneWorkspaceId ?? null,
			persistRepositoryMapping: options.persistRepositoryMapping,
			textBatchBytes: options.textBatchBytes,
			callbacks: {
				onStatus: (status) => {
					reported.push(status);
					if (status !== null) statuses.push(status);
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
	};
	return harness;
}

/** Stub the git answers that verify a mapped checkout holds one Repository. */
function stubCheckout(runner: FakeRunner, checkout: string, displayName = "factory"): void {
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: `https://github.com/acme/${displayName}.git\n`,
	});
}

/** Stub the whole worktree launch at a checkout, down to the prompt. */
function stubWorktreeLaunch(
	runner: FakeRunner,
	checkout: string,
	id: string,
	handles = LAUNCH,
	displayName = "factory",
): void {
	const branch = consultationBranchName(id, "grill");
	stubCheckout(runner, checkout, displayName);
	runner.set("git", ["-C", checkout, "branch", "--list", branch], { stdout: "" });
	runner.set("git", ["-C", checkout, "rev-parse", "HEAD"], { stdout: `${WORKTREE_HEAD}\n` });
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
			WORKTREE_HEAD,
			"--no-focus",
		],
		{ stdout: worktreeCreateJson(handles.workspaceId, handles.paneId) },
	);
	// herdr answers the start with its session handle.
	runner.set("herdr", ["agent", "start", agentOf(id), "--kind", "pi", "--pane", handles.paneId], {
		stdout: JSON.stringify({ result: { agent: { session_id: `sess-${id.slice(0, 8)}` } } }),
	});
}

/** Stub the live checkout's git safety reads: clean or dirty, never a change. */
function stubLiveCheckout(runner: FakeRunner, checkout: string, dirty = false): void {
	stubCheckout(runner, checkout);
	runner.set("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], {
		stdout: dirty ? " M src/app.ts\n" : "",
	});
}

/** Stub the live launch into a workspace herdr already holds at the checkout. */
function stubLiveLaunch(
	runner: FakeRunner,
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
	runner.set("herdr", ["agent", "prompt", agent, `/grill review auth`], { code: 0 });
}

/** Stub the herdr topology of one workspace. */
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

/** Stub the plain-text pane read a close issues before it cleans up. */
function stubPaneRead(runner: FakeRunner, paneId: string, output: string): void {
	runner.set(
		"herdr",
		["agent", "read", paneId, "--lines", "200", "--source", "recent-unwrapped", "--format", "text"],
		{ stdout: output },
	);
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
function stages(harness: Harness): string[] {
	return statusTexts(harness)
		.map((text) => text.match(/: ([a-z-]+)$/)?.[1])
		.filter((stage): stage is string => stage !== undefined);
}

/** Read back one Consultation, failing loudly when the record is gone. */
function current(state: FactoryState, id: string): Consultation {
	const consultation = state.consultation(id);
	if (consultation === undefined) throw new Error(`consultation ${id} is gone`);
	return consultation;
}

describe("Consultation operations: launch", () => {
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
		const runner = new LifecycleRunner();
		const id = uid("2");
		const consultation = seed(fixture.state, fixture, id);
		stubWorktreeLaunch(runner.inner, fixture.checkout, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: opened");
		const harness = makeHarness(fixture, runner);

		await harness.operations.launch(consultation);

		const started = current(fixture.state, id);
		expect(started).toMatchObject({
			state: "working",
			paneId: LAUNCH.paneId,
			tabId: LAUNCH.tabId,
			workspaceId: LAUNCH.workspaceId,
		});
		expect(stages(harness)).toEqual([
			"resolving-repository",
			"creating-environment",
			"starting-agent",
			"sending-prompt",
		]);
		expect(runner.commands()).toEqual([
			`git -C ${fixture.checkout} rev-parse --git-dir`,
			`git -C ${fixture.checkout} remote get-url origin`,
			`git -C ${fixture.checkout} branch --list ${consultationBranchName(id, "grill")}`,
			`git -C ${fixture.checkout} rev-parse HEAD`,
			`herdr worktree create --cwd ${fixture.checkout} --branch ${consultationBranchName(id, "grill")} --base ${WORKTREE_HEAD} --no-focus`,
			`herdr agent start ${agentOf(id)} --kind pi --pane ${LAUNCH.paneId}`,
			`herdr agent prompt ${agentOf(id)} /grill review auth`,
		]);
		expect(current(fixture.state, id).resources.map((resource) => resource.resourceId)).toEqual(
			expect.arrayContaining([LAUNCH.workspaceId, LAUNCH.tabId, LAUNCH.paneId, agentOf(id)]),
		);
		expect(harness.changes).toBeGreaterThan(0);
	});

	test("leaves a refused launch failed with the readable reason", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("3");
		const consultation = seed(fixture.state, fixture, id);
		const branch = consultationBranchName(id, "grill");
		stubCheckout(runner.inner, fixture.checkout);
		runner.inner.set("git", ["-C", fixture.checkout, "branch", "--list", branch], {
			stdout: "",
		});
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
		const runner = new LifecycleRunner();
		const id = uid("4");
		const consultation = seed(fixture.state, fixture, id);
		stubWorktreeLaunch(runner.inner, fixture.checkout, id);
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
		const runner = new LifecycleRunner();
		const id = uid("5");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveCheckout(runner.inner, fixture.checkout);
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
		const runner = new LifecycleRunner();
		const id = uid("6");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveCheckout(runner.inner, fixture.checkout);
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

		// Confirm once: the same launch continues and the override is durable.
		harness.operations.confirmSafetyConflict(consultation);
		await until(() => current(fixture.state, id).state === "working", "the confirmed launch");
		expect(current(fixture.state, id)).toMatchObject({
			state: "working",
			liveConflictOverride: true,
		});
		expect(runner.commands()).toContain(`herdr agent prompt ${agentOf(id)} /grill review auth`);
	});

	test("keeps a cancelled conflict recoverable, and checks it again", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("7");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveCheckout(runner.inner, fixture.checkout);
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
		expect(current(fixture.state, id).liveConflictOverride).toBe(false);
		expect(runner.commands().join("\n")).not.toContain("tab create");
	});

	test("warns about a dirty live checkout without blocking its launch", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("8");
		const consultation = seed(fixture.state, fixture, id, { environment: "live-worktree" });
		stubLiveCheckout(runner.inner, fixture.checkout, true);
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

describe("Consultation operations: recovery", () => {
	test("reconnects an interrupted opening to the Agent that survived", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("9");
		const consultation = seed(fixture.state, fixture, id);
		fixture.state.recordConsultationAgentHandles(id, {
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
		fixture.state.recordConsultationAgentHandles(id, { paneId: "pane-gone" });
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
		const runner = new LifecycleRunner();
		const id = uid("b");
		const consultation = seed(fixture.state, fixture, id);
		stubWorktreeLaunch(runner.inner, fixture.checkout, id);
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
		fixture.state.recordConsultationAgentHandles(id, { paneId: "pane-old" });
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
		fixture.state.settleConsultationTurn(id, null, "first answer");
		return consultation;
	}

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
		expect(fixture.state.consultationTurns(id).map((turn) => turn.input)).toEqual([
			"review auth",
			"follow up",
		]);
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
		fixture.state.beginConsultationResponse(id, "follow up", null);
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
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		const harness = makeHarness(fixture, runner, { controlPlaneWorkspaceId: "ws-control" });

		await harness.operations.close(consultation);

		expect(runner.commands()).toEqual([
			`herdr agent read ${LAUNCH.paneId} --lines 200 --source recent-unwrapped --format text`,
			`herdr tab list --workspace ${LAUNCH.workspaceId}`,
			`herdr pane list --workspace ${LAUNCH.workspaceId}`,
			`herdr workspace close ${LAUNCH.workspaceId}`,
			"herdr workspace focus ws-control",
		]);
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		// The worktree and its branch survive: retained, never removed.
		const worktree = closed.resources.find((resource) => resource.kind === "worktree");
		expect(worktree).toMatchObject({ owned: false, confirmedClosed: false });
		expect(worktree?.details).toContain("retained after close");
		for (const resource of closed.resources.filter((item) => item.kind !== "worktree"))
			expect(resource).toMatchObject({ confirmedClosed: true });
		expect(fixture.state.consultationSnapshots(id).some((snap) => snap.partial)).toBe(true);
		expect(statusTexts(harness).at(-1)).toContain("closed");
	});

	test("closes only the owned tab when a foreign tab shares the workspace", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("6");
		const consultation = seedWorking(fixture, id);
		stubPaneRead(runner.inner, LAUNCH.paneId, "Agent: done");
		stubTopology(
			runner.inner,
			LAUNCH.workspaceId,
			[LAUNCH.tabId, "tab-foreign"],
			[{ pane_id: LAUNCH.paneId, tab_id: LAUNCH.tabId }],
		);
		const harness = makeHarness(fixture, runner, { controlPlaneWorkspaceId: "ws-control" });

		await harness.operations.close(consultation);

		expect(runner.commands()).toContain(`herdr tab close ${LAUNCH.tabId}`);
		expect(runner.commands().join("\n")).not.toContain("workspace close");
		expect(runner.commands().join("\n")).not.toContain("workspace focus");
		const closed = current(fixture.state, id);
		expect(closed.state).toBe("closed");
		expect(closed.resources.find((r) => r.kind === "workspace")).toMatchObject({ owned: false });
	});

	test("closes only the pane when a foreign pane shares the owned tab", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("7");
		const consultation = seedWorking(fixture, id);
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
		fixture.state.beginConsultationClose(id);
		const harness = makeHarness(fixture, runner);

		harness.operations.forceClose(consultation);

		expect(current(fixture.state, id)).toMatchObject({
			state: "closed",
			closeResult: "force-closed by operator; owned resources may remain",
		});
		expect(
			fixture.state.consultationRemainingResources(id).map((resource) => resource.kind),
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
		expect(fixture.state.consultationRemainingResources(second).length).toBeGreaterThan(0);
		expect(current(fixture.state, first).state).toBe("closed");
	});

	test("stops an in-flight cleanup before its command reaches herdr", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("0");
		const consultation = seedWorking(fixture, id);
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
		expect(fixture.state.consultationRemainingResources(id).length).toBeGreaterThan(0);
	});

	test("refuses a force-close whose cleanup already finished", () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("f");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, runner);
		fixture.state.beginConsultationClose(id);
		fixture.state.finishConsultationClose(id);

		harness.operations.forceClose(consultation);

		expect(statusTexts(harness).at(-1)).toBe("Consultation cleanup has already finished");
		expect(current(fixture.state, id).closeResult).toBeNull();
		expect(runner.commands()).toEqual([]);
	});
});

describe("Consultation operations: replacement and deletion", () => {
	/** A failed Consultation whose exchange is too long to carry whole. */
	function seedFailedWithHistory(fixture: Fixture, id: string): Consultation {
		const consultation = seed(fixture.state, fixture, id);
		startAgent(fixture.state, id);
		// The opening turn settles, then two exchanges follow. Each Agent answer
		// is 40 KiB, so the whole exchange cannot fit the 64 KiB limit.
		fixture.state.settleConsultationTurn(id, null, "opening answer".padEnd(40 * 1024, "x"));
		for (const response of ["note: first pass", "note: keep going"]) {
			const pending = fixture.state.beginConsultationResponse(id, response, null);
			if (pending === undefined) throw new Error(`no pending response for ${response}`);
			fixture.state.acceptConsultationResponse(id, pending.id);
			fixture.state.settleConsultationTurn(
				id,
				null,
				`answer to ${response}`.padEnd(40 * 1024, "y"),
			);
		}
		fixture.state.setConsultationState(id, "failed", "herdr refused the launch");
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
		expect(fixture.state.consultations("open").map((item) => item.id)).toEqual(
			expect.arrayContaining([id, replacement?.id ?? ""]),
		);
		// Building a Replacement starts no external work.
		expect(runner.commands()).toEqual([]);
	});

	test("launches a Replacement the same way it launches a new Consultation", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const id = uid("2");
		const replaced = seedFailedWithHistory(fixture, id);
		const harness = makeHarness(fixture, runner);
		const replacement = harness.operations.replace(replaced, {
			typeName: "grill",
			repository: fixture.repository,
			initialInput: "continue the review",
		});
		if (replacement === undefined) throw new Error("the Replacement was refused");
		stubWorktreeLaunch(runner.inner, fixture.checkout, replacement.id);

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
		expect(fixture.state.consultations("all")).toHaveLength(1);
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
		fixture.state.beginConsultationClose(id);
		fixture.state.finishConsultationClose(id);

		expect(harness.operations.delete(consultation)).toBe(true);
		expect(fixture.state.consultation(id)).toBeUndefined();
		expect(statusTexts(harness).at(-1)).toContain("deleted; backups may retain data");
	});

	test("refuses to delete a Consultation that is still open", () => {
		const fixture = makeFixture();
		const id = uid("6");
		const consultation = seed(fixture.state, fixture, id);
		const harness = makeHarness(fixture, new LifecycleRunner());

		expect(harness.operations.delete(consultation)).toBe(false);
		expect(fixture.state.consultation(id)).toBeDefined();
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
		fixture.state.settleConsultationTurn(id, null, null);
		expect(current(fixture.state, id).warning).toBe(STALE_AGENT_OUTPUT_WARNING);

		harness.operations.recordOutputRead(id, "the Agent answered");
		expect(current(fixture.state, id).warning).toBeNull();
	});

	test("keeps a warning that is not about stale output", () => {
		const fixture = makeFixture();
		const id = uid("9");
		seed(fixture.state, fixture, id);
		fixture.state.setConsultationWarning(id, "the live checkout has uncommitted changes");
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
		const runner = new LifecycleRunner();
		const launchId = uid("b");
		const closeId = uid("c");
		const launching = seed(fixture.state, fixture, launchId);
		const closing = seed(fixture.state, fixture, closeId);
		startAgent(fixture.state, closeId);
		seedResources(fixture.state, closeId);
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
				`herdr worktree create --cwd ${fixture.checkout} --branch ${consultationBranchName(launchId, "grill")} --base ${WORKTREE_HEAD} --no-focus`,
			),
		).toBeLessThan(
			attempts.indexOf(
				`herdr agent read ${LAUNCH.paneId} --lines 200 --source recent-unwrapped --format text`,
			),
		);
		expect(current(fixture.state, launchId).state).toBe("working");
		expect(current(fixture.state, closeId).state).toBe("closed");
	});

	test("lets a second Repository work while the first is held", async () => {
		const fixture = makeFixture();
		const runner = new LifecycleRunner();
		const held = uid("d");
		const other = uid("e");
		const heldConsultation = seed(fixture.state, fixture, held);
		const otherConsultation = seed(fixture.state, fixture, other, {
			repository: fixture.otherRepository,
		});
		stubWorktreeLaunch(runner.inner, fixture.checkout, held);
		stubWorktreeLaunch(runner.inner, fixture.otherCheckout, other, LAUNCH, "other");
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
