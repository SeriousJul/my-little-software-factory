/**
 * The fake command runner: the egress double every test injects instead of
 * the real runner.
 *
 * It records every call and answers with a per-command response or a
 * default. Tests pin the exact command sequence a flow must produce and
 * read the responses the flow must parse. No test in the suite can reach a
 * real herdr session or a real repository through it.
 */
import type { CommandResult, CommandRunner } from "../src/runner.ts";

export interface RecordedCommand {
	command: string;
	args: readonly string[];
}

export class FakeRunner implements CommandRunner {
	readonly calls: RecordedCommand[] = [];
	private responses = new Map<string, CommandResult>();
	private fallback: CommandResult = { code: 0, stdout: "", stderr: "" };

	/** Answer `command args` with a result; exact args match, in order. */
	set(command: string, args: readonly string[], result: Partial<CommandResult>): void {
		this.responses.set(this.key(command, args), { code: 0, stdout: "", stderr: "", ...result });
	}

	/** The answer for any command without a specific response. */
	setDefault(result: Partial<CommandResult>): void {
		this.fallback = { code: 0, stdout: "", stderr: "", ...result };
	}

	/** The commands recorded so far, in order. */
	commands(): string[] {
		return this.calls.map((c) => `${c.command} ${c.args.join(" ")}`.trim());
	}

	async run(command: string, args: readonly string[]): Promise<CommandResult> {
		this.calls.push({ command, args });
		return this.responses.get(this.key(command, args)) ?? this.fallback;
	}

	private key(command: string, args: readonly string[]): string {
		return [command, ...args].join("\u0000");
	}
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
export function tabCreateJson(pane: string): string {
	return JSON.stringify({
		result: {
			tab: { tab_id: "tab-1" },
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
