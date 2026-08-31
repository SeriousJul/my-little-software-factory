/**
 * The handoff: assigning a ticket to an agent type and an environment with
 * a task type, and starting the agent's execution.
 *
 * A handoff runs through herdr (ADR 0002): the control plane never starts an
 * agent process itself. The live worktree environment reuses the herdr
 * workspace of the checkout and adds a fresh tab; the worktree environment
 * creates a fresh git worktree branched factory/<ticket id>-<title slug>
 * from the current HEAD of the main checkout. Every handoff starts a fresh
 * agent in a fresh pane and sends the rendered task type template as its
 * prompt. A running agent is never reused.
 *
 * The sequence of external commands is the contract the fake runner tests
 * pin; the herdr CLI contract was verified against herdr 0.8.2.
 *
 * A handoff failure leaves no residue: a worktree handoff that fails before
 * the agent starts removes the worktree and its branch, so a retry can run
 * instead of failing on the branch the first attempt left behind.
 */
import type { FactoryConfig } from "./config.ts";
import type { EnvironmentKind, Ticket } from "./domain/ticket.ts";
import { agentNameFor, branchNameFor } from "./naming.ts";
import { commandFailureText, type ResolutionNotes, realPathOf, resolveRepository } from "./repo.ts";
import type { CommandResult, CommandRunner } from "./runner.ts";

/** One handoff's choices: the defaults plus whatever an override changed. */
export interface HandoffChoice {
	agentType: string;
	environment: EnvironmentKind;
	taskType: string;
	/** Free-text model; empty means the setting is left to the agent. */
	model: string;
	/** Free-text thinking level; empty means the setting is left to the agent. */
	thinking: string;
}

/**
 * The outcome of one handoff attempt, as one of three facts.
 *
 * - `failed`: the agent never started. The ticket stays open, and the
 *   reason goes to the status line.
 * - `prompt-failed`: the agent started but the prompt did not get through.
 *   The agent is running and can be prompted manually in herdr, so the
 *   ticket moves to handed-off, and the reason goes to the status line.
 * - `ok`: the agent started and received the prompt.
 *
 * The shape carries no boolean pair, so a state the handoff cannot be in
 * (a success that never started, a failure without a reason) is not
 * writable.
 *
 * `notes` carries the warning and the mapping the repository resolution
 * bent with, through every outcome: a failure of a later step still warns
 * and still hands back the mapping to persist.
 */
export type HandoffOutcome =
	| { status: "failed"; reason: string; notes?: ResolutionNotes }
	| { status: "prompt-failed"; reason: string; notes?: ResolutionNotes }
	| { status: "ok"; notes?: ResolutionNotes };

interface HandoffOptions {
	config: FactoryConfig;
	runner: CommandRunner;
	home: string;
	/** Records durable progress after the claim and before external work. */
	onStage?: (stage: string) => void;
}

/**
 * What the handoff steps share: the command egress plus the note the
 * repository resolution carried. The note travels with every outcome a step
 * returns, so a failure still warns and still hands back the mapping to
 * persist.
 */
interface HandoffContext {
	runner: CommandRunner;
	onStage?: (stage: string) => void;
	/** The note the repository resolution carried, if it bent. */
	notes?: ResolutionNotes;
}

/** Hand a ticket off, returning the facts the app records on it. */
export async function handOffTicket(
	ticket: Ticket,
	choice: HandoffChoice,
	{ config, runner, home, onStage }: HandoffOptions,
): Promise<HandoffOutcome> {
	if (ticket.state !== "open") {
		return {
			status: "failed",
			reason: `only open tickets can be handed off (this one is ${ticket.state})`,
		};
	}
	if (choice.environment === "container") {
		return {
			status: "failed",
			reason: "the container environment is reserved and not yet built",
		};
	}
	const agent = config.agents[choice.agentType];
	if (agent === undefined) {
		return { status: "failed", reason: `unknown agent type: ${choice.agentType}` };
	}
	const taskType = config.taskTypes[choice.taskType];
	if (taskType === undefined) {
		return { status: "failed", reason: `unknown task type: ${choice.taskType}` };
	}

	onStage?.("resolving-repository");
	const resolved = await resolveRepository(ticket.repositoryRef, config, {
		runner,
		home,
	});
	if (!resolved.ok) {
		return { status: "failed", reason: resolved.reason };
	}

	const ctx: HandoffContext = { runner, onStage, notes: resolved.repository.notes };
	const checkout = resolved.repository.path;
	const args = settingArgs(agent, choice);
	const prompt = renderPrompt(taskType.template, ticket);
	const name = agentNameFor(ticket);

	if (choice.environment === "live-worktree") {
		return startLiveHandoff(checkout, name, agent, args, prompt, ctx);
	}
	return startWorktreeHandoff(ticket, checkout, name, agent, args, prompt, ctx);
}

/**
 * The live worktree sequence: find the herdr workspace whose repository
 * matches the checkout (create it when missing), create a fresh tab in that
 * workspace at the checkout, start a fresh agent in the tab's pane, send
 * the prompt.
 */
async function startLiveHandoff(
	checkout: string,
	name: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<HandoffOutcome> {
	ctx.onStage?.("creating-environment");
	const listed = await ctx.runner.run("herdr", ["workspace", "list"]);
	if (listed.code !== 0) {
		return failedCommand(listed, ctx);
	}
	const found = await findWorkspaceAt(listed, checkout);
	if (found.status === "unreadable") {
		// Unreadable is not "no workspace": the list may already hold the
		// checkout's workspace, and a second create would break the
		// one-workspace-per-repository rule. The handoff fails with a reason.
		return failed(found.reason, ctx);
	}
	if (found.status === "found") {
		return startAgentInNewTab(found.id, checkout, name, agent, args, prompt, ctx);
	}
	// No workspace holds the checkout: create one.
	const created = await ctx.runner.run("herdr", [
		"workspace",
		"create",
		"--cwd",
		checkout,
		"--no-focus",
	]);
	if (created.code !== 0) {
		return failedCommand(created, ctx);
	}
	const id = jsonResultField(created, "workspace", "workspace_id");
	if (id === null) {
		return failed("herdr workspace create returned no workspace id", ctx);
	}
	return startAgentInNewTab(id, checkout, name, agent, args, prompt, ctx);
}

async function startAgentInNewTab(
	workspaceId: string,
	checkout: string,
	name: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<HandoffOutcome> {
	const tab = await ctx.runner.run("herdr", [
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--cwd",
		checkout,
		"--no-focus",
	]);
	if (tab.code !== 0) {
		return failedCommand(tab, ctx);
	}
	const paneId = jsonResultField(tab, "root_pane", "pane_id");
	if (paneId === null) {
		return failed("herdr tab create returned no pane id", ctx);
	}
	return startAgentAndPrompt(name, paneId, agent, args, prompt, ctx);
}

/**
 * The worktree sequence: verify the branch does not exist in the checkout,
 * create the herdr worktree (branch from the current HEAD of the main
 * checkout, herdr's generated label), start a fresh agent in the new
 * workspace, send the prompt.
 */
async function startWorktreeHandoff(
	ticket: Ticket,
	checkout: string,
	name: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<HandoffOutcome> {
	const branch = branchNameFor(ticket);
	ctx.onStage?.("creating-environment");
	const listed = await ctx.runner.run("git", ["-C", checkout, "branch", "--list", branch]);
	if (listed.code !== 0) {
		return failed(`cannot check branch in ${checkout}: ${commandFailureText(listed)}`, ctx);
	}
	if (listed.stdout.trim() !== "") {
		return failed(`branch already exists: ${branch}`, ctx);
	}
	const head = await ctx.runner.run("git", ["-C", checkout, "rev-parse", "HEAD"]);
	if (head.code !== 0) {
		return failed(`cannot read HEAD in ${checkout}: ${commandFailureText(head)}`, ctx);
	}
	const base = head.stdout.trim();
	const created = await ctx.runner.run("herdr", [
		"worktree",
		"create",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--base",
		base,
		"--no-focus",
	]);
	if (created.code !== 0) {
		return failedCommand(created, ctx);
	}
	const workspaceId = jsonResultField(created, "workspace", "workspace_id");
	if (workspaceId === null) {
		// The cleanup needs the workspace id, so it cannot run here. The
		// branch herdr created survives and would hard-fail every retry, so
		// the reason points at it.
		return failed(
			`herdr worktree create returned no workspace id; check for a leftover branch ${branch}`,
			ctx,
		);
	}
	const paneId = jsonResultField(created, "root_pane", "pane_id");
	if (paneId === null) {
		await removeWorktree(checkout, branch, workspaceId, ctx);
		return failed("herdr worktree create returned no pane id", ctx);
	}
	const outcome = await startAgentAndPrompt(name, paneId, agent, args, prompt, ctx);
	if (outcome.status === "failed") {
		// The agent never started: the worktree would sit unused, and its
		// branch would hard-fail every retry with "branch already exists".
		// Remove both; a retry recreates them.
		await removeWorktree(checkout, branch, workspaceId, ctx);
	}
	return outcome;
}

/**
 * Remove a worktree handoff's residue: the herdr worktree workspace, and the
 * branch herdr leaves behind. Best effort: the handoff failure is the reason
 * the operator sees, and a cleanup error must not replace it.
 */
async function removeWorktree(
	checkout: string,
	branch: string,
	workspaceId: string,
	ctx: HandoffContext,
): Promise<void> {
	await ctx.runner.run("herdr", ["worktree", "remove", "--workspace", workspaceId]);
	await ctx.runner.run("git", ["-C", checkout, "branch", "-D", branch]);
}

/** Start a fresh agent in the pane and send the prompt as its task. */
async function startAgentAndPrompt(
	name: string,
	paneId: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<HandoffOutcome> {
	ctx.onStage?.("starting-agent");
	const startArgs = ["agent", "start", name, "--kind", agent.kind, "--pane", paneId];
	if (args.length > 0) {
		startArgs.push("--", ...args);
	}
	const started = await ctx.runner.run("herdr", startArgs);
	if (started.code !== 0) {
		return failedCommand(started, ctx);
	}
	// The agent is running: from here the ticket is handed-off even if the
	// prompt fails. The operator can prompt the agent manually in herdr.
	ctx.onStage?.("sending-prompt");
	const sent = await ctx.runner.run("herdr", ["agent", "prompt", name, prompt]);
	if (sent.code !== 0) {
		return {
			status: "prompt-failed",
			reason: `agent ${name} started, but the prompt failed: ${commandFailureText(sent)}`,
			notes: ctx.notes,
		};
	}
	return { status: "ok", notes: ctx.notes };
}

/** A failed herdr call: the ticket stays open, the reason goes to the TUI. */
function failedCommand(result: CommandResult, ctx: HandoffContext): HandoffOutcome {
	return failed(commandFailureText(result), ctx);
}

/** A failed step: the ticket stays open, the reason goes to the TUI. */
function failed(reason: string, ctx: HandoffContext): HandoffOutcome {
	return { status: "failed", reason, notes: ctx.notes };
}

/**
 * The setting arguments of a handoff: each chosen setting the agent type
 * maps is substituted into its argument template and split on whitespace
 * into argv. An omitted setting is ignored: no template, no arguments.
 */
export function settingArgs(
	agent: FactoryConfig["agents"][string],
	choice: HandoffChoice,
): string[] {
	const args: string[] = [];
	if (agent.model !== undefined && choice.model !== "") {
		args.push(...renderSettingArgs(agent.model, choice.model));
	}
	if (agent.thinking !== undefined && choice.thinking !== "") {
		args.push(...renderSettingArgs(agent.thinking, choice.thinking));
	}
	return args;
}

/** Substitute {value} in a setting template and split the result on whitespace. */
export function renderSettingArgs(template: string, value: string): string[] {
	return (
		template
			// The function replacer keeps dollar patterns in the value ($&, $1)
			// literal: a string replacement would interpret them.
			.replace(/\{value\}/g, () => value)
			.split(/\s+/)
			.filter((part) => part !== "")
	);
}

/** Fill prompt placeholders with source facts, never the internal identity. */
export function renderPrompt(template: string, ticket: Ticket): string {
	const values: Record<string, string> = {
		repository: ticket.repository,
		title: ticket.title,
		description: ticket.description,
		"source-kind": ticket.sourceKind,
		"external-key": ticket.externalKey,
		"source-url": ticket.url,
		labels: ticket.labels.join(", "),
	};
	return template.replace(
		/\{(repository|title|description|source-kind|external-key|source-url|labels)\}/g,
		(_match, name) => values[name],
	);
}

/**
 * The workspace whose repository matches the checkout, from a herdr
 * `workspace list` result.
 *
 * A match is the recorded checkout path, compared raw and then through
 * realpath, so a symlinked checkout still matches the workspace herdr
 * already holds for it.
 *
 * A list that does not parse is a failure with a reason, not "no
 * workspace": the list may already hold the checkout's workspace, and a
 * second `workspace create` would break the one-workspace-per-repository
 * rule.
 */
type WorkspaceLookup =
	| { status: "found"; id: string }
	| { status: "none" }
	| { status: "unreadable"; reason: string };

async function findWorkspaceAt(listed: CommandResult, checkout: string): Promise<WorkspaceLookup> {
	let data: unknown;
	try {
		data = JSON.parse(listed.stdout);
	} catch {
		return {
			status: "unreadable",
			reason: "herdr workspace list did not return a readable workspace list",
		};
	}
	const result = data as {
		result?: {
			workspaces?: Array<{ worktree?: { checkout_path?: string }; workspace_id: string }>;
		};
	};
	const workspaces = result.result?.workspaces ?? [];
	const checkoutReal = await realPathOf(checkout);
	for (const workspace of workspaces) {
		const recorded = workspace.worktree?.checkout_path;
		if (recorded === undefined) {
			continue;
		}
		if (recorded === checkout || (await realPathOf(recorded)) === checkoutReal) {
			return { status: "found", id: workspace.workspace_id };
		}
	}
	return { status: "none" };
}

/** Read result.<field>.<key> out of a herdr JSON response. */
function jsonResultField(result: CommandResult, field: string, key: string): string | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const value = (data as { result?: Record<string, Record<string, unknown>> }).result?.[field]?.[
		key
	];
	return typeof value === "string" && value !== "" ? value : null;
}
