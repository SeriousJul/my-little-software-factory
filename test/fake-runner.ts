/**
 * The fake command runner: the egress double every test injects instead of
 * the real runner.
 *
 * It records every call and answers with a per-command response or a
 * default. Tests pin the exact command sequence a flow must produce and
 * read the responses the flow must parse. No test in the suite can reach a
 * real herdr session or a real repository through it.
 *
 * The Model list query (ADR 0010) is recorded apart from the commands: a
 * query starts nothing, so a test reads `modelListCalls` to see that the
 * query ran and keeps `commands()` for the external work. A kind with no
 * canned answer fails, like a real kind whose CLI cannot report a list.
 */
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";

export interface RecordedCommand {
	command: string;
	args: readonly string[];
}

export class FakeRunner implements CommandRunner {
	readonly calls: RecordedCommand[] = [];
	/** The agent kinds this runner was asked for a Model list, in call order. */
	readonly modelListCalls: string[] = [];
	private responses = new Map<string, CommandResult>();
	private sequences = new Map<string, CommandResult[]>();
	private modelLists = new Map<string, ModelListResult>();
	// A held Model list query never answers until `releaseModelLists` runs, so a
	// test can watch the panel's loading state.
	private modelListGate: Promise<void> = Promise.resolve();
	private modelListRelease: (() => void) | null = null;
	private fallback: CommandResult = { code: 0, stdout: "", stderr: "" };

	/** Answer `command args` with a result; exact args match, in order. */
	set(command: string, args: readonly string[], result: Partial<CommandResult>): void {
		this.responses.set(this.key(command, args), { code: 0, stdout: "", stderr: "", ...result });
	}

	/** Answers one command with a sequence of results, in call order. */
	setSequence(
		command: string,
		args: readonly string[],
		results: readonly Partial<CommandResult>[],
	): void {
		this.sequences.set(
			this.key(command, args),
			results.map((result) => ({ code: 0, stdout: "", stderr: "", ...result })),
		);
	}

	/** The answer for any command without a specific response. */
	setDefault(result: Partial<CommandResult>): void {
		this.fallback = { code: 0, stdout: "", stderr: "", ...result };
	}

	/** Answer one agent kind's Model list query with these models. */
	setModelList(kind: string, models: readonly string[]): void {
		this.modelLists.set(kind, { ok: true, models: [...models] });
	}

	/** Fail one agent kind's Model list query with a readable reason. */
	setModelListFailure(kind: string, reason: string): void {
		this.modelLists.set(kind, { ok: false, reason });
	}

	/** The commands recorded so far, in order. */
	commands(): string[] {
		return this.calls.map((c) => `${c.command} ${c.args.join(" ")}`.trim());
	}

	async run(
		command: string,
		args: readonly string[],
		options?: CommandOptions,
	): Promise<CommandResult> {
		// The fake ignores the run options: the tests pin argv, not process
		// options.
		void options;
		this.calls.push({ command, args });
		const key = this.key(command, args);
		const sequence = this.sequences.get(key);
		if (sequence !== undefined && sequence.length > 0) return sequence.shift() as CommandResult;
		return this.responses.get(key) ?? this.fallback;
	}

	async listModels(kind: string): Promise<ModelListResult> {
		this.modelListCalls.push(kind);
		await this.modelListGate;
		return (
			this.modelLists.get(kind) ?? {
				ok: false,
				reason: `the fake runner holds no model list for kind "${kind}"`,
			}
		);
	}

	/**
	 * Make every Model list query wait, like an agent CLI that has not answered
	 * yet, so a test can see the panel's loading state.
	 */
	holdModelLists(): void {
		if (this.modelListRelease !== null) return;
		let release: (() => void) | null = null;
		this.modelListGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.modelListRelease = release ?? (() => undefined);
	}

	/** Let the held Model list queries answer with what the fake holds. */
	releaseModelLists(): void {
		const release = this.modelListRelease;
		this.modelListRelease = null;
		this.modelListGate = Promise.resolve();
		release?.();
	}

	private key(command: string, args: readonly string[]): string {
		return [command, ...args].join("\u0000");
	}
}

/** One agent of a herdr `agent list` result. */
export interface ListedAgent {
	paneId: string;
	tabId: string;
	workspaceId: string;
	agent: string;
	status: string;
	/** The agent's session record path, as herdr reports it. */
	sessionId?: string;
}

/** A herdr `agent list` JSON response. */
export function agentListJson(agents: ListedAgent[]): string {
	return JSON.stringify({
		result: {
			agents: agents.map((a) => ({
				pane_id: a.paneId,
				tab_id: a.tabId,
				workspace_id: a.workspaceId,
				agent: a.agent,
				agent_status: a.status,
				...(a.sessionId !== undefined && {
					agent_session: { kind: "path", source: "herdr:test", value: a.sessionId },
				}),
			})),
		},
	});
}

/** A fake runner that answers an empty `agent list` for the observation loop. */
export function emptyAgentRunner(): FakeRunner {
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
	return runner;
}

/** The workspaces of a herdr `workspace list` result. */
export interface ListedWorkspace {
	id: string;
	checkoutPath?: string;
}

/** A herdr `workspace list` JSON response. */
export function workspaceListJson(workspaces: ListedWorkspace[]): string {
	return JSON.stringify({
		result: {
			workspaces: workspaces.map((w) => ({
				workspace_id: w.id,
				worktree: w.checkoutPath !== undefined ? { checkout_path: w.checkoutPath } : undefined,
			})),
		},
	});
}

/** A herdr `workspace create` JSON response. */
export function workspaceCreateJson(id: string, pane = "pane-w"): string {
	return JSON.stringify({
		result: {
			workspace: { workspace_id: id },
			tab: { tab_id: `tab-${id}` },
			root_pane: { pane_id: pane },
		},
	});
}

/** A herdr `tab create` JSON response. */
/** The created tab's id defaults to the stored handle's id in most fakes. */
export function tabCreateJson(pane: string, tabId = "tab-1"): string {
	return JSON.stringify({
		result: {
			tab: { tab_id: tabId },
			root_pane: { pane_id: pane },
		},
	});
}

/** A herdr `worktree open` JSON response. */
export function worktreeOpenJson(
	workspaceId: string,
	pane: string,
	{ alreadyOpen, worktreePath }: { alreadyOpen: boolean; worktreePath: string },
): string {
	return JSON.stringify({
		result: {
			already_open: alreadyOpen,
			workspace: { workspace_id: workspaceId },
			tab: { tab_id: `tab-${workspaceId}` },
			root_pane: { pane_id: pane },
			worktree: { path: worktreePath },
		},
	});
}

/** The herdr error a `worktree open` returns when no worktree holds the branch. */
export const WORKTREE_NOT_FOUND_ERROR =
	'{"error":{"code":"worktree_not_found","message":"worktree branch not found"},"id":"cli:worktree:open"}\n';

/** A herdr `worktree create` JSON response. */
export function worktreeCreateJson(workspaceId: string, pane: string): string {
	return JSON.stringify({
		result: {
			workspace: { workspace_id: workspaceId },
			tab: { tab_id: `tab-${workspaceId}` },
			root_pane: { pane_id: pane },
		},
	});
}
