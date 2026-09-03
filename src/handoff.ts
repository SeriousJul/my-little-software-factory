/**
 * The handoff: assigning a ticket to an agent type and an environment with
 * a task type, and starting the agent's execution.
 *
 * A handoff runs through herdr (ADR 0002): the control plane never starts an
 * agent process itself. The live worktree environment reuses the herdr
 * workspace of the checkout and adds a fresh tab; the worktree environment
 * works the ticket on its own branch factory/<ticket id>-<title slug>: a
 * missing branch is created from the current HEAD of the main checkout, an
 * existing branch is reused in the worktree that holds it (or a fresh
 * worktree when no worktree holds it). Every handoff starts a fresh agent
 * in a fresh pane and sends the rendered task type template as its prompt.
 * A running agent is never reused.
 *
 * A workflow handoff or a restart starts in the workspace of the ticket's
 * previous handoff: it reuses the stored workspace when herdr still holds
 * it, reopens a worktree on its branch when the worktree is gone, and
 * closes the previous handoff's tab once the new agent has started. Its
 * prompt carries the last captured message through the {previous-message}
 * placeholder.
 *
 * The sequence of external commands is the contract the fake runner tests
 * pin; the herdr CLI contract was verified against herdr 0.8.2.
 *
 * A handoff failure leaves no residue: a worktree handoff that fails before
 * the agent starts removes what the handoff created (the fresh worktree,
 * the attached workspace, the fresh tab, and the branch when the handoff
 * created it), so a retry can run instead of failing on residue the first
 * attempt left behind. It never deletes a branch that pre-dates the
 * handoff: that branch may hold the ticket's earlier work.
 *
 * The Close cleanup of a finished work cycle is a different cut: it removes
 * the worktree checkout but never the branch, so pushed work and pull
 * requests survive. See closeHandoffEnvironment. It can fail: herdr refuses
 * a dirty checkout without force. A failed cleanup leaves the workspace, its
 * pane, and the agent in it alive, and that agent still holds the herdr
 * agent name the ticket's next handoff wants. The handoff does not stop
 * there: it starts under its cycle name, and the leftover environment stays
 * a fact on the ticket for the operator to clear (ADR 0012).
 */
import type { AgentTypeConfig, FactoryConfig, WorkflowEdge } from "./config.ts";
import { isTokenCount, TOKEN_COUNT_RULE } from "./domain/settings.ts";
import type { EnvironmentKind, Ticket } from "./domain/ticket.ts";
import { checkSettingFit } from "./model-settings.ts";
import {
	branchNameFor,
	consultationAgentName,
	consultationBranchName,
	ticketAgentNames,
} from "./naming.ts";
import {
	type ResolutionNotes,
	type ResolvedRepository,
	realPathOf,
	resolveRepository,
} from "./repo.ts";
import { type CommandResult, type CommandRunner, commandFailureText } from "./runner.ts";
import { resolveEnvironment, resolveSettings } from "./setting-resolution.ts";
import type { Consultation } from "./state.ts";

/** A fresh pane can need a short time to reach its shell prompt. */
const AGENT_PANE_BUSY_RETRY_DELAY_MS = 100;
const AGENT_PANE_BUSY_RETRY_WINDOW_MS = 2_000;

/** One handoff's choices: the resolved task profile plus whatever an override changed. */
export interface HandoffChoice {
	agentType: string;
	environment: EnvironmentKind;
	taskType: string;
	/** The model, in the `provider/model` form the agent takes; empty leaves the setting to the agent. */
	model: string;
	/** The Thinking level of the standard set; empty leaves the level to the agent.
	 *  The app prefills it from the resolved task profile, so the panel shows
	 *  the level the handoff will run on, and clearing the row in the panel
	 *  hands the level back to the agent. Durable state keeps it a plain
	 *  string: a restart must repeat a stored value without casting it. */
	thinking: string;
	/**
	 * The maximum context window in tokens, as plain digits; empty leaves the
	 * room to the agent. Like Model, the app prefills the resolved Task
	 * profile's value, and there is no config-wide default for it: one number
	 * cannot fit every model (ADR 0009).
	 */
	contextWindow: string;
}

/**
 * The base shape of a handoff's choices: a task type on an agent type in an
 * environment, with the settings the resolved task profile names. A restart
 * passes the previous handoff's model, thinking, and context window through,
 * unchanged.
 */
export function baseChoice(
	agentType: string,
	environment: EnvironmentKind,
	taskType: string,
	model = "",
	thinking = "",
	contextWindow = "",
): HandoffChoice {
	return { agentType, environment, taskType, model, thinking, contextWindow };
}

/**
 * Resolve the start values for one handoff. Each setting has its own chain:
 * an edge can replace only the Agent and Environment, while the selected
 * Task profile supplies Model, Thinking, and the context window
 * independently. An operator override changes this returned choice later,
 * before the handoff starts.
 *
 * A resolved value never disappears here. When the resolved agent cannot map
 * a Model, Thinking level, or context window, validateChoice fails the
 * handoff with that reason instead of starting without it (ADR 0009).
 */
export function resolveHandoffChoice(
	config: FactoryConfig,
	taskType: string,
	edge?: WorkflowEdge,
): HandoffChoice {
	// The setting chains live in one module (ADR 0009); this wrapper only
	// shapes their result as the handoff's complete choice.
	const settings = resolveSettings({ config, taskType, edgeAgent: edge?.agent });
	return baseChoice(
		settings.agentType,
		resolveEnvironment(config, edge?.environment),
		taskType,
		settings.model,
		settings.thinking,
		settings.contextWindow,
	);
}

/**
 * The herdr handles a handoff started: the name, pane, tab, and workspace of
 * the new agent. The control plane stores them with the handoff, and the
 * observation loop keys its agent lookups on the pane id.
 */
export interface StartedAgent {
	/** The herdr agent name the agent started under. */
	name: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	/** Stable Agent session identity when Herdr exposes one. */
	sessionId?: string;
}

/**
 * The herdr pane, tab, and workspace a handoff is about to start its agent
 * in, and the tab of the handoff it replaces. The name comes later: herdr
 * gives the agent one of the handoff's candidate names, and the started
 * agent reports it back.
 */
interface AgentHandles {
	paneId: string;
	tabId: string;
	workspaceId: string;
	previousTabId?: string | null;
}

/**
 * One herdr agent that holds a name: the handles herdr names in its
 * `agent_name_taken` reason.
 */
export interface AgentHolder {
	terminalId: string | null;
	paneId: string | null;
	workspaceId: string | null;
	tabId: string | null;
}

/**
 * What the handoff knows about the herdr agent name it asked for.
 *
 * The stable name comes from the ticket's title, so the agent a closed
 * cycle left behind in herdr still holds it. The handoff then starts under
 * its cycle name, and `own` says this is the ticket's own leftover rather
 * than another ticket's agent: the control plane met the collision in a
 * pane or workspace it recorded for this ticket itself, or it already holds
 * the durable fact of a leftover of this ticket.
 */
export interface NameCollision {
	/** The stable name the handoff asked herdr for first. */
	stableName: string;
	/** The name the agent started under, or null when nothing started. */
	startedAs: string | null;
	/**
	 * The agent that held the stable name, when herdr named one. For an own
	 * collision this is the holder the ticket's handoffs recorded, so the
	 * fact the collision refreshes lands on the handoff that owns it.
	 */
	holder: AgentHolder | null;
	/** True when the holder is one of this ticket's own handoffs. */
	own: boolean;
	/** herdr's own readable reason. */
	reason: string;
}

/**
 * What the caller knows about the names a ticket's own agents hold.
 *
 * The control plane reads it from its state: the handles of every handoff
 * of the ticket, and whether it already recorded that one of them is left
 * over in herdr. A caller with no state to read leaves it out, and a taken
 * name is then reported with herdr's reason.
 */
export interface OwnNameKnowledge {
	ownPaneIds: readonly string[];
	ownWorkspaceIds: readonly string[];
	leftoverKnown: boolean;
}

/** The names a handoff may ask herdr for, and what it knows about them. */
interface NamePlan {
	/** The candidate names, in preference order. */
	candidates: string[];
	known: OwnNameKnowledge;
	/** What owns the names, in the words the failure shows. */
	owner: string;
}

const NO_NAME_KNOWLEDGE: OwnNameKnowledge = {
	ownPaneIds: [],
	ownWorkspaceIds: [],
	leftoverKnown: false,
};

/**
 * The name plan of a ticket's handoff: the stable name first, then the names
 * that carry the ticket's work cycle and its handoff ordinal, so a leftover
 * agent of an earlier cycle can never be the reason a handoff does not start.
 * The names come from the naming module, which drops a candidate that would
 * repeat an earlier one.
 */
function ticketNamePlan(ticket: Ticket, known: OwnNameKnowledge | undefined): NamePlan {
	return {
		// The last candidate carries the handoff's ordinal in the ticket: its
		// handoff count plus one, across every cycle, so it only grows.
		candidates: ticketAgentNames(ticket.title, ticket.workCycle, ticket.handoffCount + 1),
		known: known ?? NO_NAME_KNOWLEDGE,
		owner: "this ticket",
	};
}

/** The name plan of a Consultation, which owns one name and shares no cycle. */
function consultationNamePlan(name: string): NamePlan {
	// A Consultation owns one name and shares no cycle: herdr refuses a
	// duplicate, and the refusal is reported, not worked around.
	return { candidates: [name], known: NO_NAME_KNOWLEDGE, owner: "this consultation" };
}

/**
 * The outcome of one handoff attempt, as one of three facts.
 *
 * - `failed`: the agent never started. The ticket stays where the claim
 *   left it, and the reason goes to the Message line.
 * - `prompt-failed`: the agent started but the prompt did not get through.
 *   The agent is running and can be prompted manually in herdr, so the
 *   ticket moves to handed-off, and the reason goes to the Message line.
 * - `ok`: the agent started and received the prompt.
 *
 * An agent-started outcome carries the handles it started, so the state
 * stores them with the handoff.
 *
 * `notes` carries the warning and the mapping the repository resolution
 * bent with, through every outcome: a failure of a later step still warns
 * and still hands back the mapping to persist.
 *
 * `collision` is set on an outcome that met herdr's `agent_name_taken`: it
 * says whose agent held the name, and the name the handoff started under
 * when it took a cycle name instead of failing. `ownCollision` keeps an
 * earlier collision with this ticket's own agent when a later candidate is
 * held by a stranger. The caller makes every own collision durable (ADR 0012).
 */
export type HandoffOutcome =
	| {
			status: "failed";
			reason: string;
			notes?: ResolutionNotes;
			collision?: NameCollision;
			ownCollision?: NameCollision;
	  }
	| {
			status: "prompt-failed";
			reason: string;
			agent: StartedAgent;
			notes?: ResolutionNotes;
			collision?: NameCollision;
			ownCollision?: NameCollision;
	  }
	| {
			status: "ok";
			agent: StartedAgent;
			notes?: ResolutionNotes;
			collision?: NameCollision;
			ownCollision?: NameCollision;
	  };

interface HandoffOptions {
	config: FactoryConfig;
	runner: CommandRunner;
	home: string;
	/** Records durable progress after the claim and before external work. */
	onStage?: (stage: string) => void;
	/** What the caller knows about the names this ticket's own agents hold. */
	names?: OwnNameKnowledge;
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
	/** Record an external resource before the next external step. */
	onResource?: (kind: string, resourceId: string, owned: boolean, details?: string) => void;
	/** Record the Agent handles before sending its first prompt. */
	onAgentStarted?: (agent: StartedAgent) => void;
	/** The note the repository resolution carried, if it bent. */
	notes?: ResolutionNotes;
	/** The agent names the handoff may ask herdr for, in preference order. */
	names: NamePlan;
}

/**
 * The rule every resolved setting passes: it must be able to reach the Agent
 * the handoff resolved onto.
 *
 * A non-empty setting the Agent maps no template for, a thinking level the
 * Agent does not offer, and a context window that is not a token count all
 * come back as the reason a handoff fails. The rule never drops a value:
 * starting without the setting the operator asked for would absorb a config
 * error silently, and ADR 0009 prefers a loud, readable one. Each reason
 * names the way out, and every way out is in the override panel, because the
 * panel is the last writer on a handoff's settings.
 */
function settingFailure(agent: AgentTypeConfig, choice: HandoffChoice): string | undefined {
	if (choice.model !== "" && agent.model === undefined) {
		return (
			`agent type "${choice.agentType}" defines no model setting, so model ` +
			`"${choice.model}" cannot reach it: clear the model in the override panel, ` +
			`or start an agent type that maps one`
		);
	}
	if (choice.thinking !== "" && agent.thinking === undefined) {
		return (
			`agent type "${choice.agentType}" defines no thinking setting, so thinking ` +
			`level "${choice.thinking}" cannot reach it: clear the thinking level in the ` +
			`override panel, or start an agent type that maps one`
		);
	}
	// A level the Agent does list is the other way a thinking value cannot
	// reach it: the config checks a profile's level against the profile's own
	// agent, and a later reroute onto another agent is checked here.
	if (
		choice.thinking !== "" &&
		agent.thinkingValues !== undefined &&
		!agent.thinkingValues.some((level) => level === choice.thinking)
	) {
		return (
			`agent type "${choice.agentType}" offers no thinking level "${choice.thinking}" ` +
			`(it offers: ${agent.thinkingValues.join(", ")}): clear the thinking level in the ` +
			`override panel, or start an agent type that offers it`
		);
	}
	if (choice.contextWindow !== "") {
		// A count the control plane cannot spell is refused whatever the Agent
		// maps, so the typed path and the config path hold one rule.
		if (!isTokenCount(choice.contextWindow)) {
			return (
				`context window "${choice.contextWindow}" is not ${TOKEN_COUNT_RULE}: clear ` +
				`the context row in the override panel, or type a count such as 272000`
			);
		}
		if (agent.contextWindow === undefined) {
			return (
				`agent type "${choice.agentType}" defines no context window setting, so the ` +
				`count of ${choice.contextWindow} tokens cannot reach it: clear it in the ` +
				`override panel, or start an agent type that maps one`
			);
		}
	}
	return undefined;
}

/**
 * Validate a handoff's choices. A failure comes back as its own outcome;
 * a pass carries the agent and task type records the steps need.
 *
 * The checks run before any external step, so the ticket stays where the
 * claim left it.
 */
function validateChoice(
	choice: HandoffChoice,
	config: FactoryConfig,
):
	| HandoffOutcome
	| { agent: FactoryConfig["agents"][string]; taskType: FactoryConfig["taskTypes"][string] } {
	if (choice.environment === "container") {
		return { status: "failed", reason: "the container environment is reserved and not yet built" };
	}
	const agent = config.agents[choice.agentType];
	if (agent === undefined) {
		return { status: "failed", reason: `unknown agent type: ${choice.agentType}` };
	}
	const failure = settingFailure(agent, choice);
	if (failure !== undefined) return { status: "failed", reason: failure };
	const taskType = config.taskTypes[choice.taskType];
	if (taskType === undefined) {
		return { status: "failed", reason: `unknown task type: ${choice.taskType}` };
	}
	return { agent, taskType };
}

/**
 * The setting fit check of a handoff (ADR 0010).
 *
 * It runs before the handoff's first external change, so an unfit model or
 * thinking level fails with a readable reason and leaves the ticket open
 * instead of starting an agent that dies inside its own terminal. A model list
 * that cannot be fetched skips the model check: the handoff proceeds, and the
 * agent's own rejection stands.
 */
async function settingFitFailure(
	choice: HandoffChoice,
	agent: FactoryConfig["agents"][string],
	runner: CommandRunner,
): Promise<HandoffOutcome | null> {
	const fit = await checkSettingFit({
		agentType: choice.agentType,
		agent,
		model: choice.model,
		thinking: choice.thinking,
		runner,
	});
	return fit.ok ? null : { status: "failed", reason: fit.reason };
}

/** Hand an open ticket off, returning the facts the app records on it. */
export async function handOffTicket(
	ticket: Ticket,
	choice: HandoffChoice,
	{ config, runner, home, onStage, names }: HandoffOptions,
): Promise<HandoffOutcome> {
	if (ticket.state !== "open") {
		return {
			status: "failed",
			reason: `only open tickets can be handed off (this one is ${ticket.state})`,
		};
	}
	const checked = validateChoice(choice, config);
	if ("status" in checked) return checked;
	const unfit = await settingFitFailure(choice, checked.agent, runner);
	if (unfit !== null) return unfit;

	onStage?.("resolving-repository");
	const resolved = await resolveRepository(ticket.repositoryRef, config, { runner, home });
	if (!resolved.ok) {
		return { status: "failed", reason: resolved.reason };
	}

	const ctx: HandoffContext = {
		runner,
		onStage,
		notes: resolved.repository.notes,
		names: ticketNamePlan(ticket, names),
	};
	const checkout = resolved.repository.path;
	const args = settingArgs(checked.agent, choice);
	const prompt = renderPrompt(checked.taskType.template, ticket);

	if (choice.environment === "live-worktree") {
		return startLiveHandoff(checkout, checked.agent, args, prompt, ctx);
	}
	return startWorktreeHandoff(ticket, checkout, checked.agent, args, prompt, ctx);
}

/**
 * What the pre-flight of a Consultation start answers (ADR 0010). A pass
 * carries the Agent record the start steps need, so the check and the start
 * read the config once.
 */
export type ConsultationStartCheck =
	| { ok: true; agent: FactoryConfig["agents"][string] }
	| { ok: false; reason: string };

/**
 * The pre-flight of a Consultation start: the record checks and the setting fit
 * check.
 *
 * A launch route resolves its repository, and a resolve can clone a repository,
 * before it reaches `handOffConsultation`, so the route runs this first: an
 * unfit model or thinking level must leave no checkout behind. The verdict
 * rides into the start, so the Agent's Model list answers one query per
 * Consultation rather than one per step.
 */
export async function checkConsultationStart({
	consultation,
	config,
	runner,
}: {
	consultation: Consultation;
	config: FactoryConfig;
	runner: CommandRunner;
}): Promise<ConsultationStartCheck> {
	const agent = config.agents[consultation.agentType];
	if (agent === undefined)
		return { ok: false, reason: `unknown agent type: ${consultation.agentType}` };
	if (consultation.environment === "container")
		return { ok: false, reason: "the container environment is reserved and not yet built" };
	const fit = await checkSettingFit({
		agentType: consultation.agentType,
		agent,
		model: consultation.model,
		thinking: consultation.thinking,
		runner,
	});
	return fit.ok ? { ok: true, agent } : { ok: false, reason: fit.reason };
}

/** A durable Consultation uses the same Herdr and repository boundary as a Handoff. */
export interface ConsultationHandoffOptions extends HandoffOptions {
	consultation: Consultation;
	onResource?: (kind: string, resourceId: string, owned: boolean, details?: string) => void;
	onAgentStarted?: (agent: StartedAgent) => void;
	onRepositoryResolved?: (path: string) => void;
	/** A resolution already made by the serialized live safety operation. */
	resolvedRepository?: ResolvedRepository;
	/**
	 * The pre-flight the launch route ran before its first external change.
	 * A start that carries one is not checked again here; a start that carries
	 * none is, so no path reaches the Agent unchecked.
	 */
	startCheck?: ConsultationStartCheck;
}

export type ConsultationHandoffOutcome =
	| { status: "failed"; reason: string; notes?: ResolutionNotes }
	| { status: "prompt-failed"; reason: string; agent: StartedAgent; notes?: ResolutionNotes }
	| { status: "ok"; agent: StartedAgent; notes?: ResolutionNotes };

/** Render a Consultation opening prompt without interpreting operator text. */
export function renderConsultationPrompt(template: string, input: string): string {
	return template.replace(/\{input\}/g, () => input);
}

/** Start a newly created Consultation. The record already exists in SQLite. */
export async function handOffConsultation({
	consultation,
	config,
	runner,
	home,
	onStage,
	onResource,
	onAgentStarted,
	onRepositoryResolved,
	resolvedRepository,
	startCheck,
}: ConsultationHandoffOptions): Promise<ConsultationHandoffOutcome> {
	const check = startCheck ?? (await checkConsultationStart({ consultation, config, runner }));
	if (!check.ok) return { status: "failed", reason: check.reason };
	const agent = check.agent;
	if (resolvedRepository === undefined) onStage?.("resolving-repository");
	const resolved =
		resolvedRepository === undefined
			? await resolveRepository(
					{
						identity: consultation.repository.identity,
						displayName: consultation.repository.displayName,
						cloneUrl: consultation.repository.cloneUrl,
					},
					config,
					{ runner, home },
				)
			: { ok: true as const, repository: resolvedRepository };
	if (!resolved.ok) return { status: "failed", reason: resolved.reason };
	onRepositoryResolved?.(resolved.repository.path);
	const name = consultation.agentName || consultationAgentName(consultation.id);
	const ctx: HandoffContext = {
		runner,
		onStage,
		onResource,
		onAgentStarted,
		notes: resolved.repository.notes,
		names: consultationNamePlan(name),
	};
	const prompt = renderConsultationPrompt(consultation.template, consultation.initialInput);
	const args = settingArgs(
		agent,
		baseChoice(
			consultation.agentType,
			consultation.environment,
			"",
			consultation.model,
			consultation.thinking,
			consultation.contextWindow,
		),
	);
	if (consultation.environment === "live-worktree") {
		return startConsultationLive(resolved.repository.path, agent, args, prompt, ctx);
	}
	return startConsultationWorktree(
		consultation.id,
		consultation.typeName,
		resolved.repository.path,
		agent,
		args,
		prompt,
		ctx,
	);
}

/** Consultation live launch: a new checkout workspace uses its root pane. */
async function startConsultationLive(
	checkout: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<ConsultationHandoffOutcome> {
	ctx.onStage?.("creating-environment");
	const listed = await ctx.runner.run("herdr", ["workspace", "list"]);
	if (listed.code !== 0) return failedCommand(listed, ctx) as ConsultationHandoffOutcome;
	let data: unknown;
	try {
		data = JSON.parse(listed.stdout);
	} catch {
		return failed(
			"herdr workspace list did not return a readable workspace list",
			ctx,
		) as ConsultationHandoffOutcome;
	}
	const workspaces =
		(
			data as {
				result?: {
					workspaces?: Array<{ workspace_id?: unknown; worktree?: { checkout_path?: unknown } }>;
				};
			}
		).result?.workspaces ?? [];
	const checkoutReal = await realPathOf(checkout);
	for (const workspace of workspaces) {
		if (
			typeof workspace.workspace_id !== "string" ||
			typeof workspace.worktree?.checkout_path !== "string"
		)
			continue;
		const recorded = workspace.worktree.checkout_path;
		if (recorded === checkout || (await realPathOf(recorded)) === checkoutReal)
			return startAgentInNewTab(workspace.workspace_id, checkout, agent, args, prompt, ctx);
	}
	const created = await ctx.runner.run("herdr", [
		"workspace",
		"create",
		"--cwd",
		checkout,
		"--no-focus",
	]);
	if (created.code !== 0) return failedCommand(created, ctx) as ConsultationHandoffOutcome;
	const workspaceId = jsonResultField(created, "workspace", "workspace_id");
	const paneId = jsonResultField(created, "root_pane", "pane_id");
	const tabId = jsonResultField(created, "tab", "tab_id");
	if (workspaceId !== null)
		ctx.onResource?.("workspace", workspaceId, true, "Consultation workspace");
	if (tabId !== null) ctx.onResource?.("tab", tabId, true, "Consultation root tab");
	if (workspaceId === null || paneId === null || tabId === null)
		return failed(
			"herdr workspace create returned incomplete pane handles",
			ctx,
		) as ConsultationHandoffOutcome;
	return startAgentAndPrompt(agent, args, prompt, ctx, { paneId, tabId, workspaceId });
}

async function startConsultationWorktree(
	id: string,
	typeName: string,
	checkout: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
): Promise<ConsultationHandoffOutcome> {
	const branch = consultationBranchName(id, typeName);
	ctx.onStage?.("creating-environment");
	const listed = await ctx.runner.run("git", ["-C", checkout, "branch", "--list", branch]);
	if (listed.code !== 0)
		return failed(
			`cannot check branch in ${checkout}: ${commandFailureText(listed)}`,
			ctx,
		) as ConsultationHandoffOutcome;
	if (listed.stdout.trim() !== "")
		return failed(
			`Consultation branch already exists: ${branch}`,
			ctx,
		) as ConsultationHandoffOutcome;
	const head = await ctx.runner.run("git", ["-C", checkout, "rev-parse", "HEAD"]);
	if (head.code !== 0)
		return failed(
			`cannot read HEAD in ${checkout}: ${commandFailureText(head)}`,
			ctx,
		) as ConsultationHandoffOutcome;
	const created = await ctx.runner.run("herdr", [
		"worktree",
		"create",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--base",
		head.stdout.trim(),
		"--no-focus",
	]);
	if (created.code !== 0) return failedCommand(created, ctx) as ConsultationHandoffOutcome;
	const workspaceId = jsonResultField(created, "workspace", "workspace_id");
	const paneId = jsonResultField(created, "root_pane", "pane_id");
	const tabId = jsonResultField(created, "tab", "tab_id");
	if (workspaceId !== null) {
		ctx.onResource?.("workspace", workspaceId, true, "Consultation worktree workspace");
		ctx.onResource?.("worktree", workspaceId, true, `Consultation worktree checkout for ${branch}`);
	}
	if (tabId !== null) ctx.onResource?.("tab", tabId, true, "Consultation worktree tab");
	if (workspaceId === null || paneId === null || tabId === null)
		return failed(
			`herdr worktree create returned incomplete handles for branch ${branch}`,
			ctx,
		) as ConsultationHandoffOutcome;
	return startAgentOrCleanUp(agent, args, prompt, ctx, { paneId, tabId, workspaceId }, async () => {
		await removeWorktree(checkout, branch, workspaceId, ctx);
	}) as Promise<ConsultationHandoffOutcome>;
}

/**
 * The options of a workflow handoff or a restart: the stored workspace of
 * the ticket's previous handoff, the tab to close once the new agent has
 * started, and the last captured message the prompt carries.
 */
export interface StoredWorkspaceHandoffOptions extends HandoffOptions {
	/** The ticket the previous handoff ran on, with its stored handles. */
	ticket: Ticket;
	choice: HandoffChoice;
	/** The workspace the previous handoff recorded, or null when it has none. */
	workspaceId: string | null;
	/** The environment the previous handoff ran in. */
	environment: EnvironmentKind;
	/** The tab the previous handoff recorded, or null when it has none. */
	previousTabId: string | null;
	/** The {previous-message} value: the last captured message. */
	previousMessage: string;
}

/**
 * Hand a ticket off in the workspace of its previous handoff.
 *
 * The stored workspace is reused when herdr still holds it and it matches
 * the chosen environment. A worktree that is gone is reopened on its
 * branch; a live workspace that is gone falls back to the live sequence at
 * the checkout. A stored workspace of a different environment kind is not
 * reused: the handoff builds the chosen environment fresh. Once the agent
 * has started, the previous handoff's tab is closed.
 */
export async function handOffStoredWorkspace({
	ticket,
	choice,
	config,
	runner,
	home,
	workspaceId,
	environment,
	previousTabId,
	previousMessage,
	onStage,
	names,
}: StoredWorkspaceHandoffOptions): Promise<HandoffOutcome> {
	const checked = validateChoice(choice, config);
	if ("status" in checked) return checked;
	const unfit = await settingFitFailure(choice, checked.agent, runner);
	if (unfit !== null) return unfit;
	const agent = checked.agent;
	const taskType = checked.taskType;

	onStage?.("resolving-repository");
	const resolved = await resolveRepository(ticket.repositoryRef, config, { runner, home });
	if (!resolved.ok) {
		return { status: "failed", reason: resolved.reason };
	}

	const ctx: HandoffContext = {
		runner,
		onStage,
		notes: resolved.repository.notes,
		names: ticketNamePlan(ticket, names),
	};
	const checkout = resolved.repository.path;
	const args = settingArgs(agent, choice);
	const prompt = renderPrompt(taskType.template, ticket, previousMessage);

	const storedMatches = workspaceId !== null && environment === choice.environment;
	if (storedMatches) {
		ctx.onStage?.("creating-environment");
		const listed = await ctx.runner.run("herdr", ["workspace", "list"]);
		if (listed.code !== 0) {
			return failedCommand(listed, ctx);
		}
		const found = await findWorkspaceIn(listed, workspaceId);
		if (found.status === "unreadable") {
			return failed(found.reason, ctx);
		}
		if (found.status === "found") {
			// The stored workspace still holds: a fresh tab in it, at the
			// workspace's own cwd.
			return startAgentInNewTab(workspaceId, null, agent, args, prompt, ctx, {
				previousTabId,
				closeTabOnFailure: true,
			});
		}
		if (choice.environment === "worktree") {
			// The worktree is gone: reopen it on the branch the naming rule
			// gives the ticket. The branch is the branch, not herdr's: the
			// reuse sequence checks it out when no worktree holds it.
			return startReusedBranchHandoff(checkout, branchNameFor(ticket), agent, args, prompt, ctx, {
				previousTabId,
			});
		}
		// A live workspace is gone: the live sequence finds or creates one.
		return startLiveHandoff(checkout, agent, args, prompt, ctx, { previousTabId });
	}

	if (choice.environment === "worktree") {
		return startWorktreeHandoff(ticket, checkout, agent, args, prompt, ctx, {
			previousTabId,
		});
	}
	return startLiveHandoff(checkout, agent, args, prompt, ctx, { previousTabId });
}

/**
 * The live worktree sequence: find the herdr workspace whose repository
 * matches the checkout (create it when missing), create a fresh tab in that
 * workspace at the checkout, start a fresh agent in the tab's pane, send
 * the prompt.
 */
async function startLiveHandoff(
	checkout: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	extra: { previousTabId?: string | null } = {},
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
		return startAgentInNewTab(found.id, checkout, agent, args, prompt, ctx, extra);
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
	return startAgentInNewTab(id, checkout, agent, args, prompt, ctx, extra);
}

interface NewTabOptions {
	previousTabId?: string | null;
	/** Close the new tab when the agent never starts, leaving no residue. */
	closeTabOnFailure?: boolean;
}

async function startAgentInNewTab(
	workspaceId: string,
	checkout: string | null,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	options: NewTabOptions = {},
): Promise<HandoffOutcome> {
	const tabArgs = ["tab", "create", "--workspace", workspaceId];
	if (checkout !== null) {
		tabArgs.push("--cwd", checkout);
	}
	tabArgs.push("--no-focus");
	const tab = await ctx.runner.run("herdr", tabArgs);
	if (tab.code !== 0) {
		return failedCommand(tab, ctx);
	}
	const paneId = jsonResultField(tab, "root_pane", "pane_id");
	const tabId = jsonResultField(tab, "tab", "tab_id");
	if (tabId !== null) ctx.onResource?.("tab", tabId, true, "Consultation tab");
	if (paneId === null || tabId === null) {
		return failed("herdr tab create returned no pane id", ctx);
	}
	const outcome = await startAgentAndPrompt(agent, args, prompt, ctx, {
		paneId,
		tabId,
		workspaceId,
		previousTabId: options.previousTabId,
	});
	if (outcome.status === "failed" && options.closeTabOnFailure) {
		// The agent never started: the tab the handoff just created would
		// sit empty in the stored workspace. Close it, best effort.
		await ctx.runner.run("herdr", ["tab", "close", tabId]);
	}
	return outcome;
}

/**
 * The worktree sequence: check the branch in the checkout, then get the
 * ticket a herdr worktree on it. A missing branch is created from the
 * current HEAD of the main checkout; an existing branch is reused (see
 * startReusedBranchHandoff). The agent starts in a fresh pane, receives
 * the prompt.
 */
async function startWorktreeHandoff(
	ticket: Ticket,
	checkout: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	extra: { previousTabId?: string | null } = {},
): Promise<HandoffOutcome> {
	const branch = branchNameFor(ticket);
	ctx.onStage?.("creating-environment");
	const listed = await ctx.runner.run("git", ["-C", checkout, "branch", "--list", branch]);
	if (listed.code !== 0) {
		return failed(`cannot check branch in ${checkout}: ${commandFailureText(listed)}`, ctx);
	}
	if (listed.stdout.trim() !== "") {
		return startReusedBranchHandoff(checkout, branch, agent, args, prompt, ctx, extra);
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
		// The cleanup needs the workspace id, so it cannot run here. A retry
		// reuses the branch herdr created, so it can still run; the reason
		// points at the branch in case the leftover worktree blocks it.
		return failed(
			`herdr worktree create returned no workspace id; check for a leftover branch ${branch}`,
			ctx,
		);
	}
	const paneId = jsonResultField(created, "root_pane", "pane_id");
	const tabId = jsonResultField(created, "tab", "tab_id");
	if (paneId === null || tabId === null) {
		await removeWorktree(checkout, branch, workspaceId, ctx);
		return failed("herdr worktree create returned no pane id", ctx);
	}
	return startAgentOrCleanUp(
		agent,
		args,
		prompt,
		ctx,
		{
			paneId,
			tabId,
			workspaceId,
			previousTabId: extra.previousTabId,
		},
		() => removeWorktree(checkout, branch, workspaceId, ctx),
	);
}

/**
 * The reuse sequence for a branch that already exists in the checkout: the
 * ticket keeps its branch and its earlier work. `worktree open` finds the
 * worktree that holds the branch and gives it a workspace (reusing one
 * that is already open); a branch no worktree holds is checked out into a
 * fresh worktree. The agent starts in a fresh pane: a fresh tab when a
 * workspace was already open, the attached workspace's first pane when
 * herdr just opened it.
 *
 * Cleanup removes only what this handoff created (the fresh tab, the
 * attached workspace, the fresh worktree). It never deletes the branch:
 * the branch pre-dates the handoff and may hold the ticket's earlier work.
 */
async function startReusedBranchHandoff(
	checkout: string,
	branch: string,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	extra: { previousTabId?: string | null } = {},
): Promise<HandoffOutcome> {
	const opened = await ctx.runner.run("herdr", [
		"worktree",
		"open",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--no-focus",
	]);
	if (opened.code === 0) {
		return startInOpenedWorktree(opened, agent, args, prompt, ctx, extra);
	}
	if (herdrErrorCode(opened) !== "worktree_not_found") {
		return failedCommand(opened, ctx);
	}
	// No worktree holds the branch: check it out into a fresh worktree.
	const created = await ctx.runner.run("herdr", [
		"worktree",
		"create",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--no-focus",
	]);
	if (created.code !== 0) {
		return failedCommand(created, ctx);
	}
	const workspaceId = jsonResultField(created, "workspace", "workspace_id");
	if (workspaceId === null) {
		// The cleanup needs the workspace id, so it cannot run here. The
		// worktree herdr created survives and would block every retry, so
		// the reason points at it.
		return failed(
			`herdr worktree create returned no workspace id; check for a leftover worktree on branch ${branch}`,
			ctx,
		);
	}
	const paneId = jsonResultField(created, "root_pane", "pane_id");
	const tabId = jsonResultField(created, "tab", "tab_id");
	if (paneId === null || tabId === null) {
		await removeWorktreeCheckout(workspaceId, ctx);
		return failed("herdr worktree create returned no pane id", ctx);
	}
	return startAgentOrCleanUp(
		agent,
		args,
		prompt,
		ctx,
		{
			paneId,
			tabId,
			workspaceId,
			previousTabId: extra.previousTabId,
		},
		() => removeWorktreeCheckout(workspaceId, ctx),
	);
}

/**
 * The agent starts in a fresh pane of the workspace `worktree open`
 * returned: a fresh tab when a workspace was already open on the
 * worktree, the attached workspace's first pane when herdr just opened it.
 */
async function startInOpenedWorktree(
	opened: CommandResult,
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	extra: { previousTabId?: string | null } = {},
): Promise<HandoffOutcome> {
	const workspaceId = jsonResultField(opened, "workspace", "workspace_id");
	if (workspaceId === null) {
		return failed("herdr worktree open returned no workspace id", ctx);
	}
	if (worktreeAlreadyOpen(opened)) {
		// A workspace was already open on the worktree: add a fresh tab in it.
		const worktreePath = jsonResultField(opened, "worktree", "path");
		if (worktreePath === null) {
			return failed("herdr worktree open returned no worktree path", ctx);
		}
		const tab = await ctx.runner.run("herdr", [
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			worktreePath,
			"--no-focus",
		]);
		if (tab.code !== 0) {
			// The workspace pre-dates the handoff: leave it, report the step.
			return failedCommand(tab, ctx);
		}
		const paneId = jsonResultField(tab, "root_pane", "pane_id");
		const tabId = jsonResultField(tab, "tab", "tab_id");
		if (paneId === null || tabId === null) {
			if (tabId !== null) {
				await closeTab(tabId, ctx);
			}
			return failed("herdr tab create returned no pane id", ctx);
		}
		return startAgentOrCleanUp(
			agent,
			args,
			prompt,
			ctx,
			{
				paneId,
				tabId,
				workspaceId,
				previousTabId: extra.previousTabId,
			},
			() => closeTab(tabId, ctx),
		);
	}
	// herdr attached a fresh workspace: its first pane is fresh.
	const paneId = jsonResultField(opened, "root_pane", "pane_id");
	const tabId = jsonResultField(opened, "tab", "tab_id");
	if (paneId === null || tabId === null) {
		await closeWorkspace(workspaceId, ctx);
		return failed("herdr worktree open returned no pane id", ctx);
	}
	return startAgentOrCleanUp(
		agent,
		args,
		prompt,
		ctx,
		{
			paneId,
			tabId,
			workspaceId,
			previousTabId: extra.previousTabId,
		},
		() => closeWorkspace(workspaceId, ctx),
	);
}

/**
 * Start the agent in the pane. When it never starts, run the cleanup for
 * the residue the handoff just created. A started agent is never rolled
 * back: even a failed prompt settles the ticket as handed off.
 */
async function startAgentOrCleanUp(
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	handles: AgentHandles,
	cleanup: () => Promise<void>,
): Promise<HandoffOutcome> {
	const outcome = await startAgentAndPrompt(agent, args, prompt, ctx, handles);
	if (outcome.status === "failed") {
		// The agent never started: remove what the handoff created, so a
		// retry can run instead of failing on the first attempt's residue.
		await cleanup();
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
	await removeWorktreeCheckout(workspaceId, ctx);
	await ctx.runner.run("git", ["-C", checkout, "branch", "-D", branch]);
}

/** Remove a herdr worktree checkout, best effort. The branch stays. */
async function removeWorktreeCheckout(workspaceId: string, ctx: HandoffContext): Promise<void> {
	await ctx.runner.run("herdr", ["worktree", "remove", "--workspace", workspaceId]);
}

/** Close a herdr workspace, best effort. Its worktree and branch stay. */
async function closeWorkspace(workspaceId: string, ctx: HandoffContext): Promise<void> {
	await ctx.runner.run("herdr", ["workspace", "close", workspaceId]);
}

/** Close a herdr tab, best effort. */
async function closeTab(tabId: string, ctx: HandoffContext): Promise<void> {
	await ctx.runner.run("herdr", ["tab", "close", tabId]);
}

/**
 * Start a fresh agent in the pane and send the prompt as its task.
 *
 * The agent asks for the handoff's candidate names in order, so a name an
 * earlier cycle left behind never ends the attempt (see
 * startAgentUnderAvailableName).
 *
 * Once the agent has started, the previous handoff's tab is closed when a
 * workflow handoff or a restart carried one: the settled agent's tab is
 * residue, and the new tab is where the work continues. A close failure
 * does not fail the handoff: the agent is running either way.
 */
async function startAgentAndPrompt(
	agent: FactoryConfig["agents"][string],
	args: string[],
	prompt: string,
	ctx: HandoffContext,
	handles: AgentHandles,
): Promise<HandoffOutcome> {
	const attempt = await startAgentUnderAvailableName(agent, args, handles.paneId, ctx);
	if (attempt.name === null) {
		return failedNameUnusable(attempt, ctx);
	}
	const name = attempt.name;
	// The agent is running: record its handles before the next external
	// command. From here the ticket is handed-off even if the prompt fails.
	const sessionId =
		jsonResultField(attempt.result, "agent", "session_id") ??
		jsonResultField(attempt.result, "session", "session_id");
	const startedAgent: StartedAgent = {
		name,
		paneId: handles.paneId,
		tabId: handles.tabId,
		workspaceId: handles.workspaceId,
		...(sessionId === null ? {} : { sessionId }),
	};
	ctx.onAgentStarted?.(startedAgent);
	ctx.onStage?.("sending-prompt");
	const sent = await ctx.runner.run("herdr", ["agent", "prompt", name, prompt]);
	const previousTabClosed = await closePreviousTab(handles.previousTabId, startedAgent.tabId, ctx);
	const collisions = collisionsAfterPreviousTabClose(
		attempt,
		handles.previousTabId,
		previousTabClosed,
	);
	if (sent.code !== 0) {
		return {
			status: "prompt-failed",
			reason: `agent ${name} started, but the prompt failed: ${herdrFailureText(sent)}`,
			agent: startedAgent,
			notes: ctx.notes,
			...collisions,
		};
	}
	return { status: "ok", agent: startedAgent, notes: ctx.notes, ...collisions };
}

/**
 * Ask herdr to start the agent, one candidate name at a time.
 *
 * The stable name is the ticket's own, and the agent a closed cycle left in
 * herdr still holds it. When herdr says so, and the pane or workspace that
 * holds the name is one this ticket's own handoffs recorded, the handoff
 * takes its next candidate name rather than failing: the leftover workspace
 * is the ticket's, so starting beside it is what the operator asked for
 * (ADR 0012). A name another ticket's agent holds is not this handoff's to
 * take, and the collision comes back as the failure it is.
 */
async function startAgentUnderAvailableName(
	agent: FactoryConfig["agents"][string],
	args: string[],
	paneId: string,
	ctx: HandoffContext,
): Promise<AgentStart> {
	const candidates = ctx.names.candidates;
	ctx.onStage?.("starting-agent");
	let collision: NameCollision | undefined;
	// Keep the first own collision when a later candidate has another owner:
	// the failure reports the later owner, but the earlier leftover is still
	// this ticket's durable fact.
	let ownCollision: NameCollision | undefined;
	let result: CommandResult = { code: 0, stdout: "", stderr: "" };
	/** True while the attempt that ended the search was herdr refusing a name. */
	let nameHeld = false;
	for (let index = 0; index < candidates.length; index += 1) {
		const name = candidates[index];
		const startArgs = ["agent", "start", name, "--kind", agent.kind, "--pane", paneId];
		if (args.length > 0) {
			startArgs.push("--", ...args);
		}
		result = await startAgentWhenPaneIsReady(startArgs, ctx.runner);
		if (result.code === 0) {
			return {
				name,
				result,
				// The last answer herdr gave was an acceptance, not a refusal.
				nameHeld: false,
				...collisionFields(collision, ownCollision, name),
			};
		}
		nameHeld = herdrErrorCode(result) === "agent_name_taken";
		if (!nameHeld) break;
		const holders = herdrNameHolders(result);
		const own = nameIsOwnLeftover(ctx.names, holders);
		collision = {
			stableName: candidates[0],
			startedAs: null,
			// The operator is sent to find the holder that matters: for an own
			// collision, the one this ticket's handoffs recorded.
			holder: own ? (ownHolder(ctx.names, holders) ?? holders[0] ?? null) : (holders[0] ?? null),
			own,
			reason: herdrFailureText(result),
		};
		if (collision.own && ownCollision === undefined) ownCollision = collision;
		// Another ticket's agent, or the last candidate spent: the collision
		// stands, and no further name is asked for.
		if (!collision.own || index + 1 === candidates.length) break;
	}
	return { name: null, result, nameHeld, ...collisionFields(collision, ownCollision) };
}

/**
 * The reason a handoff cannot start: the name that blocked it when a name
 * did, and otherwise herdr's own answer to the last attempt.
 *
 * A collision with the ticket's own leftover names the ticket's own action:
 * clearing the leftover. A collision with a stranger names the stranger:
 * herdr's handles, so the operator can find the pane.
 *
 * When a later candidate failed for another reason (a pane that stayed busy
 * past the retry window, for example), that failure is the fact the operator
 * needs, and the collision an earlier candidate met must not replace it. The
 * collision still rides along with the outcome, so the leftover it names
 * stays a durable fact on the ticket.
 */
function failedNameUnusable(attempt: AgentStart, ctx: HandoffContext): HandoffOutcome {
	const collision = attempt.collision;
	if (collision === undefined || !attempt.nameHeld) {
		return {
			status: "failed",
			reason: herdrFailureText(attempt.result),
			notes: ctx.notes,
			...collisionFields(collision, attempt.ownCollision),
		};
	}
	const holder = holderText(collision.holder);
	const reason = collision.own
		? `this ticket's own leftover agent still holds the herdr name ${collision.stableName} (${holder}); clear its leftover environment, then hand off again: ${collision.reason}`
		: `the herdr name ${collision.stableName} is held by ${holder}, which is no agent of ${ctx.names.owner}: ${collision.reason}`;
	return {
		status: "failed",
		reason,
		notes: ctx.notes,
		...collisionFields(collision, attempt.ownCollision),
	};
}

/** Where a name is held, as herdr named it. */
function holderText(holder: AgentHolder | null): string {
	if (holder === null) return "a pane herdr did not name";
	const parts = [
		...(holder.paneId === null ? [] : [`pane ${holder.paneId}`]),
		...(holder.workspaceId === null ? [] : [`workspace ${holder.workspaceId}`]),
	];
	return parts.length === 0 ? "a pane herdr did not name" : parts.join(" in ");
}

/**
 * Whether the agents that hold the name are this ticket's own leftovers.
 *
 * A handle the control plane recorded for the ticket settles it: a named
 * holder this ticket's own handoffs recorded is its own leftover agent. When
 * herdr names no holder the control plane can read - no candidates at all,
 * or only candidates it never recorded - the durable fact of a leftover of
 * this ticket decides: the ticket still knows what it left alive, and its
 * handoff starts under its cycle name rather than repeating a message the
 * operator cannot act on.
 */
function nameIsOwnLeftover(names: NamePlan, holders: readonly AgentHolder[]): boolean {
	if (holders.some((holder) => holderIsOwn(names, holder))) return true;
	return names.known.leftoverKnown;
}

/** Whether a named holder is one the control plane recorded for the ticket. */
function holderIsOwn(names: NamePlan, holder: AgentHolder): boolean {
	return (
		(holder.paneId !== null && names.known.ownPaneIds.includes(holder.paneId)) ||
		(holder.workspaceId !== null && names.known.ownWorkspaceIds.includes(holder.workspaceId))
	);
}

/** The named holder that is the ticket's own, when herdr named one. */
function ownHolder(names: NamePlan, holders: readonly AgentHolder[]): AgentHolder | null {
	return holders.find((holder) => holderIsOwn(names, holder)) ?? null;
}

/**
 * The agents herdr names as the holders of a taken agent name.
 *
 * herdr 0.8.2 writes each candidate into the error message as
 * `terminal_id=.. pane_id=.. workspace_id=.. tab_id=.. cwd=.. status=..`.
 * The identifiers carry no spaces, so the read stops there: a working
 * directory that does is not this reader's problem. A message that names no
 * candidate comes back empty, and the collision is reported without one.
 */
function herdrNameHolders(result: CommandResult): AgentHolder[] {
	const text = `${result.stderr}\n${result.stdout}`;
	const holders: AgentHolder[] = [];
	for (const match of text.matchAll(
		/terminal_id=(\S+)\s+pane_id=(\S+)\s+workspace_id=(\S+)\s+tab_id=(\S+)/g,
	)) {
		holders.push({
			terminalId: match[1],
			paneId: match[2],
			workspaceId: match[3],
			tabId: match[4],
		});
	}
	return holders;
}

/** The outcome of asking herdr for one of a handoff's candidate names. */
interface AgentStart {
	/** The name herdr accepted, or null when none of the candidates did. */
	name: string | null;
	/** The command result of the last attempt. */
	result: CommandResult;
	/**
	 * Whether the last answer herdr gave was its `agent_name_taken` refusal.
	 * A search that ends on another failure reports that failure, not the
	 * collision an earlier candidate met.
	 */
	nameHeld: boolean;
	/** The last name collision the attempt met, when it met one. */
	collision?: NameCollision;
	/** An earlier own collision the final collision must not hide. */
	ownCollision?: NameCollision;
}

/** The collision fields an outcome keeps, with the accepted name when one ran. */
function collisionFields(
	collision: NameCollision | undefined,
	ownCollision: NameCollision | undefined,
	startedAs?: string,
): { collision?: NameCollision; ownCollision?: NameCollision } {
	const finalCollision =
		collision === undefined || startedAs === undefined ? collision : { ...collision, startedAs };
	return {
		...(finalCollision === undefined ? {} : { collision: finalCollision }),
		// When the final collision is the ticket's own, it already preserves the
		// fact. A later stranger collision needs the earlier own one alongside it.
		...(ownCollision === undefined || finalCollision?.own === true ? {} : { ownCollision }),
	};
}

/**
 * Start an agent after a freshly created pane reaches its shell prompt.
 *
 * Herdr creates the terminal asynchronously but rejects `agent start` while
 * that terminal is not an available shell. That rejection is transient for
 * the fresh panes this module targets, so retry only that exact error for a
 * bounded window. Other failures remain immediate and keep their original
 * cleanup path.
 */
async function startAgentWhenPaneIsReady(
	args: readonly string[],
	runner: CommandRunner,
): Promise<CommandResult> {
	const deadline = Date.now() + AGENT_PANE_BUSY_RETRY_WINDOW_MS;
	while (true) {
		const result = await runner.run("herdr", args);
		if (result.code === 0 || herdrErrorCode(result) !== "agent_pane_busy") return result;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return result;
		await new Promise<void>((resolve) =>
			setTimeout(resolve, Math.min(AGENT_PANE_BUSY_RETRY_DELAY_MS, remaining)),
		);
	}
}

/** Close the previous handoff's tab, and say when herdr confirms it is gone. */
async function closePreviousTab(
	previousTabId: string | null | undefined,
	newTabId: string,
	ctx: HandoffContext,
): Promise<boolean> {
	if (previousTabId === null || previousTabId === undefined || previousTabId === newTabId)
		return false;
	const closed = await ctx.runner.run("herdr", ["tab", "close", previousTabId]);
	return closed.code === 0 || herdrErrorCode(closed) === "tab_not_found";
}

/** The predecessor close resolves only a collision whose holder was in that tab. */
function collisionsAfterPreviousTabClose(
	attempt: AgentStart,
	previousTabId: string | null | undefined,
	previousTabClosed: boolean,
): { collision?: NameCollision; ownCollision?: NameCollision } {
	const holderWasClosed = (collision: NameCollision | undefined) =>
		previousTabClosed &&
		previousTabId !== null &&
		previousTabId !== undefined &&
		collision?.own === true &&
		collision.holder?.tabId === previousTabId;
	return collisionFields(
		holderWasClosed(attempt.collision) ? undefined : attempt.collision,
		holderWasClosed(attempt.ownCollision) ? undefined : attempt.ownCollision,
	);
}

/**
 * The Close cleanup, distinct from the failure cleanup: it clears the
 * herdr environment of a finished work cycle without touching the git
 * branch, so pushed work and pull requests survive.
 *
 * - The worktree environment loses its worktree checkout and the herdr
 *   workspace behind it: herdr `worktree remove` closes the workspace with
 *   the checkout and never deletes the branch. When the checkout is already
 *   gone (deleted outside herdr), the workspace is what remains, and herdr
 *   `workspace close` clears it. The git branch stays.
 * - The live worktree environment loses the handoff's tab; the workspace
 *   stays. When the tab is already gone (closed outside herdr), herdr
 *   answers `tab_not_found`, and the cleanup succeeds.
 *
 * Returns a readable reason when a cleanup command fails; the caller keeps
 * the state transition, warns on the Message line, and records the surviving
 * environment as a leftover of the ticket (ADR 0012).
 *
 * `force` asks herdr to remove a dirty checkout. It kills every agent in the
 * workspace with it, so only the operator's explicit choice reaches for it:
 * the Clear action offers it as its own row, and no automatic path passes it.
 */
export interface CloseCleanupOptions {
	/** Remove the checkout even when herdr says it is dirty. */
	force?: boolean;
}

/**
 * How far the Close cleanup of one handoff reaches into herdr.
 *
 * The worktree environment loses its checkout and the workspace behind it, so
 * the cleanup reaches the whole workspace and every agent running in it. The
 * live worktree environment loses one tab, and keeps the workspace and the
 * tabs beside it. A handoff that named no handle has nothing to close, so the
 * cleanup reaches no environment at all.
 *
 * One definition serves both halves of the cleanup: the commands herdr
 * receives, and which of the ticket's leftover facts a successful cleanup
 * settles. A fact outside the reach stands: one row's close says nothing
 * about another row's environment (ADR 0012).
 */
export type CleanupReach =
	| { scope: "workspace"; workspaceId: string }
	| { scope: "tab"; tabId: string }
	| { scope: "none" };

export function closeCleanupReach(handoff: {
	environment: EnvironmentKind;
	tabId: string | null;
	workspaceId: string | null;
}): CleanupReach {
	if (handoff.environment === "worktree" && handoff.workspaceId !== null) {
		return { scope: "workspace", workspaceId: handoff.workspaceId };
	}
	if (handoff.environment === "live-worktree" && handoff.tabId !== null) {
		return { scope: "tab", tabId: handoff.tabId };
	}
	return { scope: "none" };
}

export async function closeHandoffEnvironment(
	handoff: { environment: EnvironmentKind; tabId: string | null; workspaceId: string | null },
	runner: CommandRunner,
	options: CloseCleanupOptions = {},
): Promise<string | undefined> {
	const force = options.force === true;
	const reach = closeCleanupReach(handoff);
	if (reach.scope === "workspace") {
		// The checkout on disk and the herdr workspace behind it: herdr
		// worktree remove closes the workspace with the checkout and never
		// deletes the branch, so pushed work and pull requests survive.
		const removeArgs = ["worktree", "remove", "--workspace", reach.workspaceId];
		if (force) {
			removeArgs.push("--force");
		}
		const removed = await runner.run("herdr", removeArgs);
		if (removed.code === 0) {
			// The workspace closed with the checkout: the environment is gone.
			return undefined;
		}
		const code = herdrErrorCode(removed);
		if (code === "workspace_not_found") {
			// The workspace is already gone: there is nothing to clean up.
			return undefined;
		}
		if (code === "worktree_remove_failed") {
			// The checkout is gone (deleted outside herdr): the workspace is
			// what remains, so close it.
			const closed = await runner.run("herdr", ["workspace", "close", reach.workspaceId]);
			if (closed.code === 0 || herdrErrorCode(closed) === "workspace_not_found") {
				return undefined;
			}
			return herdrFailureText(closed);
		}
		// The checkout is still there (for example dirty): leave the
		// workspace open for the operator and report why the removal failed.
		return herdrFailureText(removed);
	}
	if (reach.scope === "tab") {
		const result = await runner.run("herdr", ["tab", "close", reach.tabId]);
		if (result.code === 0) {
			// The tab closed: the environment is gone.
			return undefined;
		}
		if (herdrErrorCode(result) === "tab_not_found") {
			// The tab is already gone (closed outside herdr): there is
			// nothing left to clean up.
			return undefined;
		}
		return herdrFailureText(result);
	}
	return undefined;
}

/** A failed herdr call: the ticket stays where the claim left it. */
function failedCommand(result: CommandResult, ctx: HandoffContext): HandoffOutcome {
	return failed(herdrFailureText(result), ctx);
}

/**
 * A failed herdr command as one readable line.
 *
 * herdr writes its CLI errors as one JSON object, and its own message says
 * what the operator can act on. Herdr's error code rides along: it is the
 * stable part of the answer, and a message can change with the herdr
 * version. A failure herdr did not write as JSON keeps its raw line.
 */
export function herdrFailureText(result: CommandResult): string {
	const code = herdrErrorCode(result);
	if (code === null) {
		return commandFailureText(result);
	}
	const message = herdrErrorMessage(result);
	return message === "" ? code : `${message} (${code})`;
}

/** The `error.message` of a herdr JSON error, or "" when it carries none. */
function herdrErrorMessage(result: CommandResult): string {
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return "";
	}
	const message = (data as { error?: { message?: unknown } }).error?.message;
	return typeof message === "string" ? message : "";
}

/** A failed step: the ticket stays where the claim left it. */
function failed(reason: string, ctx: HandoffContext): HandoffOutcome {
	return { status: "failed", reason, notes: ctx.notes };
}

/**
 * The setting arguments of a handoff: each chosen setting the agent type
 * maps is substituted into its argument template into argv. A setting left
 * empty is ignored: no template, no arguments, and the setting is left to
 * the agent. validateChoice already refused a non-empty setting whose
 * template the agent has no mapping for.
 *
 * One setting value is one argv cell, whatever the value holds. That is the
 * invariant the Model list is read against: a value the panel offers, a value
 * the config names, or a value the operator types must reach the agent as the
 * single argument it was chosen to be.
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
	if (agent.contextWindow !== undefined && choice.contextWindow !== "") {
		args.push(...renderSettingArgs(agent.contextWindow, choice.contextWindow));
	}
	return args;
}

/**
 * Substitute {value} in a setting template, one argv cell per template token.
 *
 * The template is split first, and the value is placed inside each token
 * afterwards, never before the split: a value that carries whitespace (a
 * pasted model name, or a config value with a space in it) stays one argument
 * cell instead of becoming an argument plus a stray positional the agent reads
 * as its model. `execFile` carries argv without a shell, so the cell keeps its
 * text all the way to the agent. The codex thinking template,
 * `-c model_reasoning_effort={value}`, splits into two tokens and gains the
 * level inside the second one, exactly as it did before.
 */
export function renderSettingArgs(template: string, value: string): string[] {
	return (
		template
			.split(/\s+/)
			.filter((token) => token !== "")
			// The function replacer keeps dollar patterns in the value ($&, $1)
			// literal: a string replacement would interpret them.
			.map((token) => token.replace(/\{value\}/g, () => value))
			// A bare {value} token with an empty value leaves no argument behind.
			.filter((token) => token !== "")
	);
}

/**
 * Fill prompt placeholders with source facts, never the internal identity.
 *
 * `previousMessage` fills {previous-message} for workflow handoffs and
 * restarts; an open-ticket handoff leaves it empty.
 */
export function renderPrompt(template: string, ticket: Ticket, previousMessage = ""): string {
	const values: Record<string, string> = {
		repository: ticket.repository,
		title: ticket.title,
		description: ticket.description,
		"source-kind": ticket.sourceKind,
		"external-key": ticket.externalKey,
		"source-url": ticket.url,
		labels: ticket.labels.join(", "),
		"previous-message": previousMessage,
	};
	return template.replace(
		/\{(repository|title|description|source-kind|external-key|source-url|labels|previous-message)\}/g,
		(_match, name) => values[name],
	);
}

/**
 * A workspace id from a herdr `workspace list` result.
 *
 * A list that does not parse is a failure with a reason, not "no workspace":
 * the list may already hold the wanted workspace, and acting on "none"
 * would build a duplicate environment.
 */
type WorkspaceLookup =
	| { status: "found"; id: string }
	| { status: "none" }
	| { status: "unreadable"; reason: string };

async function findWorkspaceIn(
	listed: CommandResult,
	workspaceId: string,
): Promise<WorkspaceLookup> {
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
	if (workspaces.some((workspace) => workspace.workspace_id === workspaceId)) {
		return { status: "found", id: workspaceId };
	}
	return { status: "none" };
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

/**
 * The stable error code a failed herdr call carries, if any. herdr emits
 * its CLI errors as one JSON object on stderr.
 */
function herdrErrorCode(result: CommandResult): string | null {
	if (result.code === 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return null;
	}
	const code = (data as { error?: { code?: unknown } }).error?.code;
	return typeof code === "string" && code !== "" ? code : null;
}

/** True when a `worktree open` result says a workspace was already open. */
function worktreeAlreadyOpen(result: CommandResult): boolean {
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return false;
	}
	return (data as { result?: { already_open?: unknown } }).result?.already_open === true;
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
