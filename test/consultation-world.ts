/**
 * The Consultation launch world the Consultation frame suites stand on: the
 * selected ticket, the worktree type, the seeded Consultation and its stored
 * herdr handles, the git and herdr answers a launch runs, and the runner
 * that canonicalizes a launch's random Agent and branch ids so a command
 * sequence stands pinnable.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";
import type { FactoryState } from "../src/state.ts";
import { type FakeRunner, worktreeCreateJson } from "./fake-runner.ts";
import { type Plane, plane, wrappedState } from "./plane.ts";

/** The canonical ids ConsultationRunner rewrites random launch ids to. */
export const AGENT = "consultation-00000000";
export const BRANCH = "factory/consultation-00000000-grill";
/** The canonical id of a Consultation seeded by hand, by its lead character. */
export const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;

export const repository = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};

/** The selected Ticket the launcher and the panels open from. */
export const selectedTicket: Ticket = {
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

/** The worktree Consultation type the suites stand on, as the config carries it. */
export const grillTypes: FactoryConfig["consultationTypes"] = {
	grill: { agent: "pi", environment: "worktree", template: "/grill {input}" },
};

/** Seed a Consultation with a deterministic id, and optionally its Agent. */
export function seed(
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
		host: "herdr" as const,
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

/** Stub the git answers for a healthy, verified convention checkout. */
export function stubCheckout(runner: FakeRunner, checkout: string): void {
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
}

/** Stub the full worktree launch sequence at the verified checkout. */
export function stubWorktreeLaunch(runner: FakeRunner, checkout: string, branch = BRANCH): void {
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
export function stubPaneReadText(runner: FakeRunner, paneId: string, output: string): void {
	runner.set(
		"herdr",
		["agent", "read", paneId, "--lines", "200", "--source", "visible", "--format", "text"],
		{ stdout: output },
	);
}

/**
 * The egress double for Consultation launches: it canonicalizes the random
 * Agent name and branch a fresh launch picks, answers `agent list` with a
 * test-controlled list, and pins every other command exactly.
 */
export class ConsultationRunner implements CommandRunner {
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
export const consultationAgentListJson = (
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

/**
 * The launcher world: one ticket source on the selected ticket, the grill
 * type, and the git and herdr answers a launch runs against the
 * conventional checkout. A test brings its own runner to keep the launch's
 * command list, and it takes back the state and the plane's record.
 */
export async function launcherWorld(
	runner?: (fake: FakeRunner) => ConsultationRunner,
): Promise<{ state: FactoryState; plane: Plane }> {
	const state = wrappedState();
	const record = await plane({
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
		runner: runner ?? ((fake) => new ConsultationRunner(fake, consultationAgentListJson([]))),
		agentHostEnv: { herdrEnv: "1" },
	});
	return { state, plane: record };
}
