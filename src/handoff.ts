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
import { commandFailureText, realPathOf, resolveRepository } from "./repo.ts";
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
 * The outcome of one handoff attempt.
 *
 * `started` is true when the agent started, even if a later step (the
 * prompt) failed: the agent is running and can be prompted manually in
 * herdr, so the ticket moves to handed-off. Any earlier failure leaves the
 * ticket open and carries a `reason` for the TUI.
 */
export interface HandoffOutcome {
	started: boolean;
	ok: boolean;
	reason?: string;
	/** A warning worth showing after a success, e.g. a sibling clone. */
	warning?: string;
	/** A repository mapping the caller must persist into the config. */
	mappingToWrite?: { repository: string; path: string };
}

interface HandoffOptions {
	config: FactoryConfig;
	runner: CommandRunner;
	home: string;
}

/**
 * What the handoff steps share: the command egress plus the warning and the
 * mapping the repository resolution carried. Both travel with every outcome
 * a step returns, so a failure still warns and still hands back the mapping
 * to persist.
 */
interface HandoffContext {
	runner: CommandRunner;
	/** A warning worth showing after a success, e.g. a sibling clone. */
	warning?: string;
	/** A repository mapping the caller must persist into the config. */
	mappingToWrite?: { repository: string; path: string };
}

/** Hand a ticket off, returning the facts the app records on it. */
export async function handOffTicket(
	ticket: Ticket,
	choice: HandoffChoice,
	{ config, runner, home }: HandoffOptions,
): Promise<HandoffOutcome> {
	if (ticket.state !== "open") {
		return {
			started: false,
			ok: false,
			reason: `only open tickets can be handed off (this one is ${ticket.state})`,
		};
	}
	if (choice.environment === "container") {
		return {
			started: false,
			ok: false,
			reason: "the container environment is reserved and not yet built",
		};
	}
	const agent = config.agents[choice.agentType];
	if (agent === undefined) {
		return { started: false, ok: false, reason: `unknown agent type: ${choice.agentType}` };
	}
	const taskType = config.taskTypes[choice.taskType];
	if (taskType === undefined) {
		return { started: false, ok: false, reason: `unknown task type: ${choice.taskType}` };
	}

	const resolved = await resolveRepository(ticket.repository, config, { runner, home });
	if (!resolved.ok) {
		return { started: false, ok: false, reason: resolved.reason };
	}

	const ctx: HandoffContext = {
		runner,
		warning: resolved.repository.warning,
		mappingToWrite: resolved.repository.mappingToWrite,
	};
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
	const listed = await ctx.runner.run("herdr", ["workspace", "list"]);
	if (listed.code !== 0) {
		return failedCommand(listed, ctx);
	}
	const workspaceId = findWorkspaceIdAt(listed, checkout);
	if (workspaceId === null) {
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
	return startAgentInNewTab(workspaceId, checkout, name, agent, args, prompt, ctx);
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
	if (!outcome.started) {
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
	const sent = await ctx.runner.run("herdr", ["agent", "prompt", name, prompt]);
	if (sent.code !== 0) {
		return {
			started: true,
			ok: false,
			reason: `agent ${name} started, but the prompt failed: ${commandFailureText(sent)}`,
			warning: ctx.warning,
			mappingToWrite: ctx.mappingToWrite,
		};
	}
	return { started: true, ok: true, warning: ctx.warning, mappingToWrite: ctx.mappingToWrite };
}

/** A failed herdr call: the ticket stays open, the reason goes to the TUI. */
function failedCommand(result: CommandResult, ctx: HandoffContext): HandoffOutcome {
	return failed(commandFailureText(result), ctx);
}

/** A failed step: the ticket stays open, the reason goes to the TUI. */
function failed(reason: string, ctx: HandoffContext): HandoffOutcome {
	return {
		started: false,
		ok: false,
		reason,
		warning: ctx.warning,
		mappingToWrite: ctx.mappingToWrite,
	};
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
	return template
		.replace(/\{value\}/g, value)
		.split(/\s+/)
		.filter((part) => part !== "");
}

/** Fill the {repository}, {title}, and {description} placeholders of a prompt template. */
export function renderPrompt(template: string, ticket: Ticket): string {
	return template
		.replace(/\{repository\}/g, ticket.repository)
		.replace(/\{title\}/g, ticket.title)
		.replace(/\{description\}/g, ticket.description);
}

/**
 * The workspace whose repository matches the checkout, from a herdr
 * `workspace list` result.
 *
 * A match is the recorded checkout path, compared raw and then through
 * realpath, so a symlinked checkout still matches the workspace herdr
 * already holds for it.
 */
function findWorkspaceIdAt(listed: CommandResult, checkout: string): string | null {
	let data: unknown;
	try {
		data = JSON.parse(listed.stdout);
	} catch {
		return null;
	}
	const result = data as {
		result?: {
			workspaces?: Array<{ worktree?: { checkout_path?: string }; workspace_id: string }>;
		};
	};
	const workspaces = result.result?.workspaces ?? [];
	const checkoutReal = realPathOf(checkout);
	for (const workspace of workspaces) {
		const recorded = workspace.worktree?.checkout_path;
		if (recorded === undefined) {
			continue;
		}
		if (recorded === checkout || realPathOf(recorded) === checkoutReal) {
			return workspace.workspace_id;
		}
	}
	return null;
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
