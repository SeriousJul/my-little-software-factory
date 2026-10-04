/**
 * The handoff: assigning a ticket to an agent type and an environment with
 * a task type, and starting the agent's execution.
 *
 * A handoff runs through herdr (ADR 0002): the control plane never starts an
 * agent process itself. The live worktree environment reuses the herdr
 * workspace of the checkout and adds a fresh tab; the worktree environment
 * works the ticket on its own branch factory/<ticket id>-<title slug>: a
 * missing branch is created from the worktree base (the fetched remote
 * default branch, or the local HEAD with a note on the fallback), an
 * existing branch is reused in the worktree that holds it, and a branch
 * no worktree holds is checked out into a fresh worktree - the ticket's
 * own worktree, when it still stands on disk left on another branch by
 * the agent that last worked the ticket, is reopened by its path instead,
 * on the branch it holds. Every handoff starts a fresh agent in a fresh
 * pane and sends the rendered task type template as its prompt. A running
 * agent is never reused.
 *
 * A workflow handoff or a restart starts in the workspace of the ticket's
 * previous handoff: it reuses the stored workspace when herdr still holds
 * it, reopens a worktree on its branch when the worktree is gone, and
 * closes the previous handoff's tab once the new agent has started. Its
 * prompt carries the last captured message through the {previous-message}
 * placeholder. A template that references the {review-verdict} placeholder
 * carries the pull request's review verdict: the handoff reads the verdict
 * straight from the source, through the command runner, before the render,
 * and fills the placeholder with the verdict or the read's fact (ADR 0074).
 * A verdict score that stands at or above the workflow's score threshold
 * fills the gates fact instead: the review passed, so the failure stands in
 * the pull request's gates and not in the review's feedback (ADR 0078).
 *
 * Every start runs through one start: `runHandoffStart`, this module's own start
 * call (issue #204, ADR 0097). An open ticket's first handoff, a workflow
 * handoff, a restart, and a Consultation launch each state the facts they own -
 * the choice, the workspace, the branch policy, the prompt, and the name plan -
 * and one pre-flight rule, one environment builder, one workspace reader, and
 * one cleanup rule answer them. A caller no longer picks between entry points:
 * it states the workspace its previous handoff recorded, or none.
 *
 * The sequence of external commands is the contract the fake runner tests
 * pin; the herdr CLI contract was verified against herdr 0.8.2, and the
 * worktree list and the worktree open by its path against herdr 0.9.1.
 *
 * A handoff failure leaves no residue: a start that fails before its agent
 * starts removes what that start created (the fresh tab, the workspace it
 * created, the fresh worktree checkout, and the branch when the start created
 * it), so a retry can run instead of failing on residue the first attempt left
 * behind. What the start created is recorded as it is created, and one cleanup
 * rule reads that record, so the coverage is the same in every environment. It
 * never deletes what pre-dates the attempt: a stored workspace, a branch the
 * repository already carried, and a pull request the read found all stand. A
 * command that raises is answered the way a command herdr refused is, so a start
 * that stops in the middle of its own sequence still removes what it made; a
 * raise after the agent started reads as the failed prompt it is, because a
 * started agent is never rolled back.
 *
 * One residue is not a herdr environment at all, and no tool clears it: the
 * directory herdr named for a branch can stay on disk after git stopped
 * recording the checkout it held, and git then refuses every create on the
 * path the naming rule reserves. The handoff moves that directory aside, and
 * never deletes one: see ADR 0062 and `moveLeftoverWorktreeDirectory`.
 *
 * The Close cleanup of a finished work cycle is a different cut: it removes
 * the worktree checkout but never the branch, so pushed work and pull
 * requests survive. See closeHandoffEnvironment. It can fail: herdr refuses
 * a dirty checkout without force. A failed cleanup leaves the workspace, its
 * pane, and the agent in it alive, and that agent still holds the herdr
 * agent name the ticket's next handoff wants. The handoff does not stop
 * there: it starts under its cycle name, and the leftover environment stays
 * a fact on the ticket for the operator to clear in herdr (ADR 0012, ADR 0032).
 */
import type { FactoryConfig, TicketSourceConfig, TransitionPin } from "./config.ts";
import type { EnvironmentKind, RepositoryRef, Ticket } from "./domain/ticket.ts";
import { fileExists, movePath, readDirectoryNames } from "./fs.ts";
import { failureLine } from "./lines.ts";
import {
	branchNameFor,
	consultationAgentName,
	consultationBranchName,
	ticketAgentNames,
} from "./naming.ts";
import {
	closePullRequest,
	listOpenPullRequestsByHeadBranch,
	openDraftPullRequest,
	pullRequestBodyFor,
} from "./pull-request.ts";
import {
	type ResolutionNotes,
	type ResolvedRepository,
	realPathOf,
	resolveRepository,
} from "./repo.ts";
import {
	type CommandResult,
	type CommandRunner,
	commandFailureText,
	errorMessage,
} from "./runner.ts";
import { fitSettings } from "./setting-fit.ts";
import { resolveEnvironment, resolveSettings } from "./setting-resolution.ts";
import type { Consultation } from "./state/consultation-record.ts";
import { newestMembership } from "./task-selection.ts";
import {
	type ReviewVerdictRead,
	readReviewVerdict,
	scoreFromMessage,
	workflowScoreThreshold,
} from "./workflow.ts";
import { remoteDefaultBranch } from "./worktree-base.ts";

/** A fresh pane can need a short time to reach its shell prompt. */
const AGENT_PANE_BUSY_RETRY_DELAY_MS = 100;
const AGENT_PANE_BUSY_RETRY_WINDOW_MS = 2_000;

/** The message the plane's hold commit carries on a fresh factory branch. */
const PULL_REQUEST_HOLD_COMMIT_MESSAGE = "factory: hold the branch for the pull request";

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
 * a transition pin can replace only the Agent and Environment, while the
 * selected Task profile supplies Model, Thinking, and the context window
 * independently. An operator override changes this returned choice later,
 * before the handoff starts.
 *
 * A resolved value never disappears here. When the resolved agent cannot map a
 * Model, Thinking level, or context window, the one pre-flight (`checkStart`)
 * fails the handoff with that reason instead of starting without it (ADR 0009).
 */
export function resolveHandoffChoice(
	config: FactoryConfig,
	taskType: string,
	pin?: TransitionPin,
): HandoffChoice {
	// The setting chains live in one module (ADR 0009); this wrapper only
	// shapes their result as the handoff's complete choice.
	const settings = resolveSettings({ config, taskType, edgeAgent: pin?.agent });
	return baseChoice(
		settings.agentType,
		resolveEnvironment(config, pin?.environment),
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
 * The naming module builds the three candidates, and each one carries the
 * ticket's own identity tag, so no candidate repeats an earlier one (ADR 0098).
 */
function ticketNamePlan(ticket: Ticket, known: OwnNameKnowledge | undefined): NamePlan {
	return {
		// The last candidate carries the handoff's ordinal in the ticket: its
		// handoff count plus one, across every cycle, so it only grows.
		candidates: ticketAgentNames(ticket, ticket.workCycle, ticket.handoffCount + 1),
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

/**
 * The facts a Ticket start's caller supplies: the config and egress the start
 * reads, the claim that stands behind it, and the environment its previous
 * Handoff recorded.
 */
export interface TicketHandoffOptions {
	config: FactoryConfig;
	runner: CommandRunner;
	home: string;
	/** Records durable progress after the claim and before external work. */
	onStage?: (stage: string) => void;
	/** What the caller knows about the names this ticket's own agents hold. */
	names?: OwnNameKnowledge;
	/**
	 * The claim this start runs on. `open` refuses a Ticket that is no longer
	 * open. `continuation` stands behind the Handoff of a turn the plane already
	 * settled - a workflow handoff or a Restart - whose claim ran elsewhere.
	 */
	claim: "open" | "continuation";
	/**
	 * The herdr environment the ticket's previous Handoff recorded. A continuation
	 * carries it; an open start carries nothing and builds the Environment its
	 * choice names (issue #204).
	 */
	previous?: PreviousHandoffEnvironment;
	/** The {previous-message} value: the last captured message. */
	previousMessage?: string;
}

/** The herdr environment a previous Handoff recorded on its Ticket. */
export interface PreviousHandoffEnvironment {
	workspaceId: string | null;
	environment: EnvironmentKind;
	tabId: string | null;
}

/**
 * What the handoff steps share: the command egress, the checkout the start
 * resolved to, and the note that resolution carried. The note travels with every
 * outcome a step returns, so a failure still warns and still hands back the
 * mapping to persist.
 */
interface HandoffContext {
	runner: CommandRunner;
	/** The checkout the start resolved to: every git step and cleanup runs in it. */
	checkout: string;
	onStage?: (stage: string) => void;
	/** The caller's resource table, or null on a start that records nothing. */
	resources: StartResources | null;
	/** Record the Agent handles before sending its first prompt. */
	onAgentStarted?: (agent: StartedAgent) => void;
	/** The note the repository resolution carried, if it bent. */
	notes?: ResolutionNotes;
	/** The agent names the handoff may ask herdr for, in preference order. */
	names: NamePlan;
	/**
	 * The pull request open the handoff runs before its agent starts
	 * (ADR 0076): set for a worktree handoff of a task type that opens a
	 * pull request, and absent on every other handoff.
	 */
	pullRequestOpen?: PullRequestOpenPlan;
}

/**
 * The facts the pull request open of one handoff needs (ADR 0076): the
 * ticket whose branch the pull request stands on, the branch the naming rule
 * gives the ticket, and the source the pull request opens on, with its own
 * auth. The checkout the open pushes from is the one the start resolved.
 */
interface PullRequestOpenPlan {
	ticket: Ticket;
	/** The branch the naming rule gives the ticket, and the branch the pull request stands on. */
	branch: string;
	source: TicketSourceConfig;
}

/**
 * The prompt the handoff sends (ADR 0076): the rendered text - or, for a
 * task type that opens a pull request, the render the pull request open
 * fills with the pull request's url before the prompt is sent, so the
 * prompt the agent gets stands on the pull request that stands.
 */
type HandoffPrompt = string | ((pullRequestUrl: string) => Promise<string>);

/**
 * The facts one start pre-flight reads. A Ticket start names its Task type; a
 * Consultation start names none.
 */
export interface StartFacts {
	agentType: string;
	environment: EnvironmentKind;
	/** The Task type a Ticket start runs. A Consultation start names none. */
	taskType?: string;
	model: string;
	thinking: string;
	contextWindow: string;
}

/**
 * The pre-flight's answer. A pass carries the records the start steps read, so
 * the pre-flight and the start read the config once; a failure carries the one
 * reason the Message line shows and the Desktop notification carries.
 */
export type StartCheck =
	| {
			ok: true;
			agent: FactoryConfig["agents"][string];
			/** The Task type record, on a start that named a Task type. */
			taskType?: FactoryConfig["taskTypes"][string];
	  }
	| { ok: false; reason: string };

/**
 * The one pre-flight rule, in one order (issue #204, ADR 0097).
 *
 * Agent type, then Environment, then the Task type a Ticket start names, then
 * the Environment a Task type that opens a pull request needs (ADR 0076), then
 * the Setting fit. Every start path asks the same facts in the same order, so
 * one bad choice answers with one reason on the Ticket path and the Consultation
 * path alike: an unknown Agent type beside the reserved container Environment
 * answers with the Agent type on both, and the operator fixes the fact the plane
 * really read. The wording lives here alone, the way the Setting fit module owns
 * its sentences, so it cannot drift a second time.
 *
 * The checks run before any external step, so the ticket stays where the claim
 * left it and no start resolves - and can clone - a repository it will never
 * use. The Setting fit check (ADR 0010) is the only half that reaches the
 * command runner: an unfit model or thinking level fails with a readable reason
 * instead of starting an agent that dies inside its own terminal, and a Model
 * list that cannot be fetched skips the model check.
 */
export async function checkStart(
	facts: StartFacts,
	config: FactoryConfig,
	runner: CommandRunner,
): Promise<StartCheck> {
	const agent = config.agents[facts.agentType];
	if (agent === undefined) return { ok: false, reason: `unknown agent type: ${facts.agentType}` };
	if (facts.environment === "container")
		return { ok: false, reason: "the container environment is reserved and not yet built" };
	// The Task type record is read once, and the Setting fit runs once, so the
	// order cannot depend on which branch a start happened to take.
	const taskType = facts.taskType === undefined ? undefined : config.taskTypes[facts.taskType];
	if (facts.taskType !== undefined && taskType === undefined)
		return { ok: false, reason: `unknown task type: ${facts.taskType}` };
	// The pull request open runs only in the worktree Environment: only that
	// Environment holds the factory branch the pull request stands on (ADR 0076).
	// It is a bad-choice reason like any other, so it answers here with the rest.
	if (taskType?.opensPullRequest === true && facts.environment === "live-worktree")
		return {
			ok: false,
			reason: `the task type ${facts.taskType} opens a pull request, which runs only in the worktree environment: the live worktree holds no factory branch`,
		};
	const unfit = await settingFitFailure(facts, agent, runner);
	if (unfit !== null) return { ok: false, reason: unfit };
	return taskType === undefined ? { ok: true, agent } : { ok: true, agent, taskType };
}

/** The Setting fit half of the pre-flight: the reason an unfit setting gives, or null. */
async function settingFitFailure(
	facts: StartFacts,
	agent: FactoryConfig["agents"][string],
	runner: CommandRunner,
): Promise<string | null> {
	const fit = await fitSettings(
		{ agentType: facts.agentType, agent },
		{ model: facts.model, thinking: facts.thinking, contextWindow: facts.contextWindow },
		runner,
	);
	return fit === undefined ? null : fit.reason;
}

/**
 * Hand a Ticket off (issue #204): the caller's thin start.
 *
 * The caller states the facts it owns - the choice, the claim behind it, the
 * workspace the ticket's previous Handoff recorded, and the prompt the Agent
 * receives - and hands one request to the one start. It returns the outcome the
 * app records on the ticket.
 */
export async function handOffTicket(
	ticket: Ticket,
	choice: HandoffChoice,
	{ config, runner, home, onStage, names, claim, previous, previousMessage }: TicketHandoffOptions,
): Promise<HandoffOutcome> {
	if (claim === "open" && ticket.state !== "open") {
		return {
			status: "failed",
			reason: `only open tickets can be handed off (this one is ${ticket.state})`,
		};
	}
	const check = await checkStart(choiceFacts(choice), config, runner);
	if (!check.ok) return { status: "failed", reason: check.reason };
	// A Ticket start always names a Task type, so a choice that names none has no
	// prompt to render. The refusal for a Task type record that holds no template
	// is the render's own (see `ticketPrompt`), so this caller states only the
	// fact it owns.
	const taskType = check.taskType;
	if (taskType === undefined) return { status: "failed", reason: "the handoff names no task type" };
	const answer = await ticketPrompt(
		taskType,
		choice.taskType,
		ticket,
		runner,
		config.sources,
		previousMessage,
		workflowScoreThreshold(config),
	);
	if ("fail" in answer) return { status: "failed", reason: answer.fail };
	return runHandoffStart({
		choice,
		config,
		runner,
		home,
		onStage,
		repository: ticket.repositoryRef,
		workspace: ticketWorkspaceFact(choice, previous),
		previousTabId: previous?.tabId ?? null,
		// The branch policy is a fact, not a merge (issue #204): the ticket keeps
		// its branch and the work a finished cycle left on it.
		branch: { name: branchNameFor(ticket), policy: "reuse" },
		prompt: answer.prompt,
		pullRequestOpen: answer.pullRequestOpen,
		names: ticketNamePlan(ticket, names),
		startCheck: check,
	});
}

/**
 * The handoff's choice as the one pre-flight reads it. Every start builds its
 * facts here, so no path can answer `unknown task type: ` for a name the start
 * never named: a Consultation choice carries an empty Task type, and the empty
 * name reads as "no Task type".
 */
function choiceFacts(choice: HandoffChoice): StartFacts {
	return {
		agentType: choice.agentType,
		environment: choice.environment,
		taskType: choice.taskType === "" ? undefined : choice.taskType,
		model: choice.model,
		thinking: choice.thinking,
		contextWindow: choice.contextWindow,
	};
}

/**
 * The Consultation record as the one pre-flight reads it.
 *
 * The facts are named field by field, not passed as the whole record: a
 * Consultation names no Task type, and a future Consultation field must not
 * enter the pre-flight just because it happens to share the fact's name.
 */
export function consultationStartFacts(consultation: Consultation): StartFacts {
	return {
		agentType: consultation.agentType,
		environment: consultation.environment,
		model: consultation.model,
		thinking: consultation.thinking,
		contextWindow: consultation.contextWindow,
	};
}

/**
 * The workspace fact a Ticket start carries (issue #204).
 *
 * The previous Handoff's workspace is a fact only when it stands in the
 * Environment this start chose. A stored workspace of another kind is not
 * reused: the start builds the chosen Environment fresh, and the previous tab is
 * still the one to close once the new Agent runs.
 */
function ticketWorkspaceFact(
	choice: HandoffChoice,
	previous: PreviousHandoffEnvironment | undefined,
): StartWorkspace {
	if (
		previous !== undefined &&
		previous.workspaceId !== null &&
		previous.environment === choice.environment
	)
		return { kind: "stored", workspaceId: previous.workspaceId };
	return { kind: "none" };
}

/**
 * The prompt of one ticket handoff (ADR 0076): the rendered template for every
 * task type, and - for a task type that opens a pull request - the render the
 * pull request open fills with the pull request's url before the prompt is sent.
 * The open's plan travels with the prompt, so the start runs it between the
 * environment's creation and the agent's start. The answer is tagged, the way
 * the handoff's own answers are: a pass carries the prompt to send and the open
 * to run, a failure its reason.
 */
async function ticketPrompt(
	taskType: FactoryConfig["taskTypes"][string],
	taskTypeName: string,
	ticket: Ticket,
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	previousMessage?: string,
	scoreThreshold?: number,
): Promise<{ prompt: HandoffPrompt; pullRequestOpen?: PullRequestOpenPlan } | { fail: string }> {
	const template = taskType.template;
	if (template === undefined) return { fail: "the task type carries no prompt template" };
	if (taskType.opensPullRequest !== true)
		return {
			prompt: await renderTicketPrompt(
				template,
				ticket,
				runner,
				sources,
				previousMessage,
				"",
				scoreThreshold,
			),
		};
	const membership = newestMembership(ticket.memberships);
	const source =
		membership === undefined
			? undefined
			: sources.find((item) => item.name === membership.sourceName);
	if (source === undefined)
		return {
			fail: `the task type ${taskTypeName} opens a pull request, but the ticket lists on no source that could open it`,
		};
	return {
		prompt: (url) =>
			renderTicketPrompt(template, ticket, runner, sources, previousMessage, url, scoreThreshold),
		pullRequestOpen: { ticket, branch: branchNameFor(ticket), source },
	};
}

/**
 * The facts a Consultation start's caller supplies. The record already exists in
 * SQLite; the start builds its Environment and starts its Agent.
 *
 * The Consultation keeps its own start caller because the Consultation owns its
 * own facts: the record's settings, its branch name, its one Agent name, and the
 * resource table the Close panel reads. The start itself is the handoff's one
 * start (issue #204).
 */
export interface ConsultationHandoffOptions {
	config: FactoryConfig;
	runner: CommandRunner;
	home: string;
	consultation: Consultation;
	/** Records durable progress for the Message line. */
	onStage?: (stage: string) => void;
	/** Record an external resource before the next external step. */
	onResource?: (kind: ResourceKind, resourceId: string, owned: boolean, details?: string) => void;
	/**
	 * Confirm a resource this start's own cleanup removed. The record then holds
	 * no row for a workspace, a worktree, or a tab the plane already took down,
	 * and the Close panel does not offer a handle that is gone. The kind is the
	 * one fact the start recorded the row under, never a second copy of the word.
	 */
	onResourceRemoved?: (kind: ResourceKind, resourceId: string) => void;
	/** Record the Agent handles before sending its first prompt. */
	onAgentStarted?: (agent: StartedAgent) => void;
	/** Record the checkout the start resolved to, before its first herdr step. */
	onRepositoryResolved?: (path: string) => void;
	/** A resolution already made by the serialized live safety operation. */
	resolvedRepository?: ResolvedRepository;
	/**
	 * The pre-flight the launch route ran before its first external change.
	 * A start that carries one is not checked again here; a start that carries
	 * none is, so no path reaches the Agent unchecked.
	 */
	startCheck?: StartCheck;
}

/** Render a Consultation opening prompt without interpreting operator text. */
export function renderConsultationPrompt(template: string, input: string): string {
	return template.replace(/\{input\}/g, () => input);
}

/**
 * Start a newly created Consultation (issue #204): the caller's thin start. The
 * record already exists in SQLite.
 *
 * The Consultation owns the Environment it builds: no previous Handoff stands
 * behind it, a workspace it creates keeps its root pane for its Agent, and its
 * branch is refused rather than reused.
 */
export async function handOffConsultation({
	consultation,
	config,
	runner,
	home,
	onStage,
	onResource,
	onResourceRemoved,
	onAgentStarted,
	onRepositoryResolved,
	resolvedRepository,
	startCheck,
}: ConsultationHandoffOptions): Promise<HandoffOutcome> {
	const check =
		startCheck ?? (await checkStart(consultationStartFacts(consultation), config, runner));
	if (!check.ok) return { status: "failed", reason: check.reason };
	const name = consultation.agentName || consultationAgentName(consultation.id);
	return runHandoffStart({
		choice: baseChoice(
			consultation.agentType,
			consultation.environment,
			"",
			consultation.model,
			consultation.thinking,
			consultation.contextWindow,
		),
		config,
		runner,
		home,
		onStage,
		onAgentStarted,
		onRepositoryResolved,
		repository: {
			identity: consultation.repository.identity,
			displayName: consultation.repository.displayName,
			cloneUrl: consultation.repository.cloneUrl,
		},
		resolvedRepository,
		workspace: { kind: "fresh" },
		previousTabId: null,
		branch: {
			name: consultationBranchName(consultation.id, consultation.typeName),
			policy: "refuse",
		},
		prompt: renderConsultationPrompt(consultation.template, consultation.initialInput),
		names: consultationNamePlan(name),
		// The recorder and its wording travel together (pull request #213 review): a start
		// that records resources states the wording those rows use, and a start that
		// records none carries no resource table at all.
		resources:
			onResource === undefined
				? undefined
				: {
						record: onResource,
						removed: onResourceRemoved,
						labels: CONSULTATION_RESOURCE_LABELS,
					},
		startCheck: check,
	});
}

/**
 * The herdr workspace a start works in, as the caller states it (issue #204).
 *
 * `fresh`: the start builds its own Environment and owns it. A workspace it
 * creates is fresh end to end, so its root pane is where the Agent starts. A
 * Consultation carries this fact, the same fact its Close cleanup reads when it
 * takes the whole workspace down.
 *
 * `stored`: the workspace a previous Handoff recorded. The start reuses it when
 * herdr still holds it, and reopens the worktree on its branch when the worktree
 * is gone.
 *
 * `none`: the caller states no workspace. The start works in the Environment of
 * the checkout, which the operator's own tabs may hold, so its Agent starts in a
 * fresh tab in the workspace it found or the one it created.
 */
type StartWorkspace =
	| { kind: "fresh" }
	| { kind: "stored"; workspaceId: string }
	| { kind: "none" };

/**
 * The branch a worktree Environment works on, and what an existing branch means.
 *
 * The policy stays a fact and the naming rules stay untouched (issue #204): a
 * Ticket branch is reused, so the ticket keeps the work an earlier cycle left on
 * it, and a Consultation branch that already exists is refused.
 */
interface StartBranch {
	name: string;
	policy: "reuse" | "refuse";
}

/**
 * The wording the resource recorder writes for the resources a start creates.
 *
 * The resource table belongs to the Consultation's Close panel, so the caller
 * that records resources names its own rows and hands the labels with them. The
 * shared Environment builders read these instead of spelling out one surface's
 * vocabulary. There is no default set: the labels travel with the recorder (see
 * `StartResources`), so no start can write a row in wording its caller never
 * stated (pull request #213 review).
 */
interface StartResourceLabels {
	/** The live workspace this start created. */
	workspace: string;
	/** The root tab of the live workspace this start created. */
	rootTab: string;
	/** The fresh tab this start created in a workspace it did not create. */
	tab: string;
	/** The worktree workspace this start created. */
	worktreeWorkspace: string;
	/** The worktree checkout this start created, beside the branch it stands on. */
	worktreeCheckout: string;
	/** The tab holding the worktree workspace this start created. */
	worktreeTab: string;
}

/**
 * What one start records into its caller's resource table, and the wording those
 * rows use.
 *
 * `record` lands before the next external step, so a failure in the middle of
 * the sequence still shows what might remain. `removed` confirms a resource this
 * start's own cleanup took down, so the record keeps no row for a handle the
 * plane already closed.
 */
interface StartResources {
	record: (kind: ResourceKind, resourceId: string, owned: boolean, details?: string) => void;
	/** Absent on a caller that tracks no rows of its own. */
	removed?: (kind: ResourceKind, resourceId: string) => void;
	labels: StartResourceLabels;
}

/** The Consultation's own Close panel wording, carried with its recorder. */
const CONSULTATION_RESOURCE_LABELS: StartResourceLabels = {
	workspace: "Consultation workspace",
	rootTab: "Consultation root tab",
	tab: "Consultation tab",
	worktreeWorkspace: "Consultation worktree workspace",
	worktreeCheckout: "Consultation worktree checkout",
	worktreeTab: "Consultation worktree tab",
};

/** What one handoff start is asked to do. */
interface HandoffStartRequest {
	/** The Agent type, Environment, Task type, and the three settings this start runs on. */
	choice: HandoffChoice;
	/** The config the pre-flight and the repository resolution read. */
	config: FactoryConfig;
	/** The repository the start works in, as the Ticket or the Consultation names it. */
	repository: string | RepositoryRef;
	/** A repository resolution the caller already made: the Consultation live safety run. */
	resolvedRepository?: ResolvedRepository;
	/** The herdr workspace this start works in. */
	workspace: StartWorkspace;
	/** The tab the previous Handoff recorded, closed once this start's Agent runs. */
	previousTabId: string | null;
	/** The branch the worktree Environment works on. */
	branch: StartBranch;
	/** The prompt the Agent receives, or the render the Pull request open fills with its url. */
	prompt: HandoffPrompt;
	/** The Agent names the start may ask herdr for, in preference order. */
	names: NamePlan;
	/** The Task type's Pull request open (ADR 0076), and nothing on a start that opens none. */
	pullRequestOpen?: PullRequestOpenPlan;
	/**
	 * The pre-flight the caller ran. It is required, and the start never re-runs
	 * one: the check and this request then always carry the same facts, and the
	 * Agent's Model list is asked once per start.
	 */
	startCheck: StartCheck;
	/** Records durable progress after the claim and before external work. */
	onStage?: (stage: string) => void;
	/**
	 * The caller's resource table with the wording its rows use. A start that
	 * records nothing carries nothing, so no row is ever written in wording the
	 * caller did not state.
	 */
	resources?: StartResources;
	/** Record the Agent handles before sending its first prompt. */
	onAgentStarted?: (agent: StartedAgent) => void;
	/** Record the checkout the start resolved to, before its first herdr step. */
	onRepositoryResolved?: (path: string) => void;
	/** The one seam the start runs through: every external command. */
	runner: CommandRunner;
	/** The home directory the ~/src repository convention resolves under. */
	home: string;
}

/**
 * The kinds a start records in its caller's resource table (issue #204).
 *
 * One fact, stated once. Every handle a start creates enters its residue record
 * carrying the kind it was recorded under, and the cleanup confirms that kind out
 * of the record. A write and a confirmation therefore cannot name two different
 * kinds and leave the recorded row standing in silence (pull request #213
 * review).
 */
export type ResourceKind = "tab" | "workspace" | "worktree";

/**
 * One handle this start created: the kind its caller's resource table records it
 * under, and the handle itself.
 */
interface CreatedHandle {
	readonly kind: ResourceKind;
	readonly resourceId: string;
}

/**
 * What one start created, so its failure removes exactly that and nothing that
 * pre-dates it (issue #204).
 *
 * The start owns the record and every Environment builder writes into it as it
 * creates a handle, so the coverage is the same on every Environment kind: a
 * live start that never started its Agent removes its fresh tab and the workspace
 * it created, the way a worktree start removes its fresh checkout. A handle the
 * start did not create never enters the record, so a stored workspace, a branch
 * the repository already carried, and a pull request the read found all stand
 * (ADR 0062, ADR 0076).
 *
 * The record is written as each handle is created rather than returned at the end
 * of a build, because a command can raise in the middle of one - see
 * `raisedDuringStart`.
 */
interface Residue {
	/** The fresh tab this start created in a workspace it did not create. */
	tab: CreatedHandle | null;
	/**
	 * The root tab of a workspace this start created. The workspace or worktree
	 * removal takes it down, so no separate tab command runs for it; it stands in
	 * the record so the cleanup can confirm the row the start wrote for it.
	 */
	rootTab: CreatedHandle | null;
	/** The herdr workspace this start created. */
	workspace: CreatedHandle | null;
	/** The herdr worktree checkout this start created. */
	worktree: CreatedHandle | null;
	/** The git branch this start created. */
	branch: string | null;
}

const NO_RESIDUE: Residue = {
	tab: null,
	rootTab: null,
	workspace: null,
	worktree: null,
	branch: null,
};

/**
 * The Environment a start built: the handles its Agent's pane stands in, or the
 * outcome its build reports. What the build created is not part of the answer -
 * it stands in the start's own residue record, so a build that ends in the
 * middle still leaves what it made on the record.
 */
type EnvironmentAnswer = { handles: AgentHandles } | { outcome: HandoffOutcome };

/**
 * The one handoff start (issue #204, ADR 0097).
 *
 * Every start runs through this call: an open Ticket's first Handoff, a workflow
 * handoff, a Restart, and a Consultation launch. It is this module's own start,
 * behind the two start calls the plane has (`handOffTicket` and
 * `handOffConsultation`): no caller outside the module builds a request, so a
 * new Environment kind is added inside the module and not as a seventh start
 * path. The caller states the facts it owns - the choice, the resolved settings,
 * the workspace, the prompt, the name plan, and the branch policy - and the start
 * answers with one outcome. The caller that used to pick between two entry points
 * states a workspace instead.
 *
 * The sequence is the contract the fake runner's tests pin:
 *
 * 1. the pre-flight, in one order, once;
 * 2. the repository resolution;
 * 3. the Environment the choice names, through herdr;
 * 4. the Pull request open of a task type that opens one (ADR 0076);
 * 5. the Agent start under one of the name plan's candidates;
 * 6. the prompt.
 *
 * What the start created is recorded as it is created, and one cleanup rule
 * removes it when the Agent never starts. A started Agent is never rolled back:
 * even a failed prompt settles the ticket as handed off.
 */
async function runHandoffStart(request: HandoffStartRequest): Promise<HandoffOutcome> {
	const check = request.startCheck;
	if (!check.ok) return { status: "failed", reason: check.reason };
	if (request.resolvedRepository === undefined) request.onStage?.("resolving-repository");
	const resolved =
		request.resolvedRepository === undefined
			? await resolveRepository(request.repository, request.config, {
					runner: request.runner,
					home: request.home,
				})
			: { ok: true as const, repository: request.resolvedRepository };
	if (!resolved.ok) return { status: "failed", reason: resolved.reason };
	const checkout = resolved.repository.path;
	request.onRepositoryResolved?.(checkout);
	const ctx: HandoffContext = {
		runner: request.runner,
		checkout,
		onStage: request.onStage,
		resources: request.resources ?? null,
		onAgentStarted: request.onAgentStarted,
		notes: resolved.repository.notes,
		names: request.names,
		pullRequestOpen: request.pullRequestOpen,
	};
	// What this start creates, and what it has already put into the world, stand
	// outside its steps. A command that raises in the middle of a start therefore
	// still leaves the start able to name what it made and what it must not roll
	// back (pull request #213 review).
	const residue: Residue = { ...NO_RESIDUE };
	const progress: StartProgress = { agent: null, pullRequestCleanup: null };
	let outcome: HandoffOutcome;
	try {
		outcome = await runStartSteps(request, check, ctx, residue, progress);
	} catch (error) {
		outcome = raisedDuringStart(error, ctx, progress);
	}
	if (outcome.status === "failed") {
		// The Agent never started: the residue of the pull request open goes first,
		// then the Environment standing behind it, so a retry can run instead of
		// failing on what this attempt left behind.
		await runStartCleanup(progress.pullRequestCleanup, ctx, residue);
	}
	return outcome;
}

/**
 * The steps one start runs, in their one order: the Environment the choice
 * names, the Pull request open of a task type that opens one, the Agent start,
 * and the prompt.
 */
async function runStartSteps(
	request: HandoffStartRequest,
	check: StartCheck & { ok: true },
	ctx: HandoffContext,
	residue: Residue,
	progress: StartProgress,
): Promise<HandoffOutcome> {
	const environment = await buildEnvironment(request, ctx, residue);
	if ("outcome" in environment) return environment.outcome;
	// The step between the environment and the Agent is the Pull request open of
	// a task type that opens one (ADR 0076): the environment stands, the branch
	// is pushed, the draft stands or is reused, and only then does the prompt -
	// filled with the pull request's url - go out. Its cleanup goes on the
	// progress every failure answer reads, so a failure after the open runs it
	// whether the open tagged its own failure or a command raised.
	const pre = await promptBeforeAgent(ctx, request.prompt);
	progress.pullRequestCleanup = pre.cleanup;
	if ("fail" in pre) return failed(pre.fail, ctx);
	return await startAgentAndPrompt(
		check.agent,
		settingArgs(check.agent, request.choice),
		pre.text,
		ctx,
		{ ...environment.handles, previousTabId: request.previousTabId },
		progress,
	);
}

/**
 * What a start has already put into the world, held outside its steps so the
 * answer to a raised command can tell a residue to remove from an Agent it must
 * not roll back.
 */
interface StartProgress {
	/** The Agent herdr accepted, once one is running. A started Agent is never rolled back. */
	agent: StartedAgent | null;
	/** The cleanup of the pull request open's residue, once that open has run. */
	pullRequestCleanup: (() => Promise<void>) | null;
}

/**
 * The answer to a command that raised in the middle of a start.
 *
 * The production runner maps a spawn-level failure to a failed command, but a
 * CommandRunner adapter is free to raise - the Stub runner wraps another runner,
 * and a caller's own callback can throw - and the rest of this module already
 * treats a raise as a failure it must answer, because an answer that escaped
 * would skip the cleanup of what the attempt created (see `runPullRequestOpen`).
 * The steps after the Environment stands are held to the same rule.
 *
 * A raise after the Agent started is the failed prompt it is: the Agent stays
 * running, its Environment stays, and the ticket settles as handed off with the
 * reason on its record. A started Agent is never rolled back.
 */
function raisedDuringStart(
	error: unknown,
	ctx: HandoffContext,
	progress: StartProgress,
): HandoffOutcome {
	const agent = progress.agent;
	if (agent !== null) {
		return {
			status: "prompt-failed",
			reason: `agent ${agent.name} started, but the handoff raised: ${errorMessage(error)}`,
			agent,
			notes: ctx.notes,
		};
	}
	return failed(`the handoff could not run a command: ${errorMessage(error)}`, ctx);
}

/**
 * The cleanup of one failed start: the pull request open's residue, then the
 * Environment behind it.
 *
 * Best effort, the way every cleanup in this module is: the start's own failure
 * is the reason the operator sees, so a cleanup that fails, or a cleanup command
 * that raises, adds no second failure on top of it.
 */
async function runStartCleanup(
	pullRequestCleanup: (() => Promise<void>) | null,
	ctx: HandoffContext,
	residue: Residue,
): Promise<void> {
	if (pullRequestCleanup !== null) {
		try {
			await pullRequestCleanup();
		} catch {
			// A cleanup command that raised is answered like one herdr refused.
		}
	}
	await removeResidue(ctx, residue);
}

/**
 * The Environment the choice names, built through herdr. What it creates is
 * written into the start's residue record as it is created.
 */
async function buildEnvironment(
	request: HandoffStartRequest,
	ctx: HandoffContext,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	if (request.choice.environment === "worktree")
		return buildWorktreeEnvironment(request, ctx, residue);
	return buildLiveEnvironment(request, ctx, residue);
}

/**
 * The workspace list one start reads, and whether the stored workspace still
 * stands in it (pull request #213 review).
 *
 * Both Environment kinds ask herdr the same question before they build: does the
 * workspace a previous Handoff recorded still hold? The ask, the list read, the
 * held check, and the two failure answers were written twice, once per builder.
 * They live here now, so the rule has one copy. A pass carries the workspaces
 * herdr listed, which the live builder goes on to search for the checkout (see
 * `workspaceAtCheckout`).
 */
type StartWorkspaceList =
	| { ok: true; held: string | null; workspaces: readonly HerdrWorkspace[] }
	| { ok: false; outcome: HandoffOutcome };

async function readStartWorkspaces(
	request: HandoffStartRequest,
	ctx: HandoffContext,
): Promise<StartWorkspaceList> {
	const listed = await ctx.runner.run("herdr", ["workspace", "list"]);
	if (listed.code !== 0) return { ok: false, outcome: failedCommand(listed, ctx) };
	const list = readWorkspaceList(listed);
	if (list.status === "unreadable") return { ok: false, outcome: failed(list.reason, ctx) };
	const stored = request.workspace.kind === "stored" ? request.workspace.workspaceId : null;
	return {
		ok: true,
		held: stored !== null && workspaceHeld(list.workspaces, stored) ? stored : null,
		workspaces: list.workspaces,
	};
}

/**
 * The live worktree sequence: find the herdr workspace whose repository matches
 * the checkout, or the stored workspace a previous Handoff recorded, and create
 * one when neither holds. The Agent then starts in a fresh tab, except in a
 * workspace this start created for itself (see `StartWorkspace`).
 */
async function buildLiveEnvironment(
	request: HandoffStartRequest,
	ctx: HandoffContext,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	ctx.onStage?.("creating-environment");
	const listed = await readStartWorkspaces(request, ctx);
	if (!listed.ok) return { outcome: listed.outcome };
	if (listed.held !== null) {
		// The stored workspace still holds: a fresh tab in it, at the
		// workspace's own cwd.
		return openFreshTab(listed.held, null, ctx, residue);
	}
	// A stored workspace that is gone, and a start that names none, both end at
	// the checkout lookup below, which finds a workspace or creates one.
	const atCheckout = await workspaceAtCheckout(listed.workspaces, ctx.checkout);
	if (atCheckout !== null) return openFreshTab(atCheckout, ctx.checkout, ctx, residue);
	const created = await ctx.runner.run("herdr", [
		"workspace",
		"create",
		"--cwd",
		ctx.checkout,
		"--no-focus",
	]);
	if (created.code !== 0) return { outcome: failedCommand(created, ctx) };
	const handles = herdrHandles(created);
	if (handles.workspaceId === null)
		return { outcome: failed("herdr workspace create returned no workspace id", ctx) };
	// The workspace this start created enters the record before the next ask, so
	// a failure - or a raise - at that ask still takes it down.
	residue.workspace = recordResource(
		ctx,
		"workspace",
		handles.workspaceId,
		(labels) => labels.workspace,
	);
	if (handles.tabId !== null)
		residue.rootTab = recordResource(ctx, "tab", handles.tabId, (labels) => labels.rootTab);
	if (request.workspace.kind === "fresh") {
		// The start owns the workspace it creates: its root pane is fresh, so the
		// Agent starts there and no second tab is made.
		if (handles.paneId === null || handles.tabId === null)
			return {
				outcome: failed("herdr workspace create returned incomplete pane handles", ctx),
			};
		// The root tab stands in the record too: the workspace close takes it
		// down, and the cleanup confirms the row written for it.
		return {
			handles: {
				paneId: handles.paneId,
				tabId: handles.tabId,
				workspaceId: handles.workspaceId,
			},
		};
	}
	return openFreshTab(handles.workspaceId, ctx.checkout, ctx, residue);
}

/**
 * A fresh tab in a workspace the start found or created: the Agent's pane is that
 * tab's root pane. The tab enters the record as soon as herdr names it, beside
 * the workspace when this start created it.
 */
async function openFreshTab(
	workspaceId: string,
	cwd: string | null,
	ctx: HandoffContext,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	const tabArgs = ["tab", "create", "--workspace", workspaceId];
	if (cwd !== null) tabArgs.push("--cwd", cwd);
	tabArgs.push("--no-focus");
	const tab = await ctx.runner.run("herdr", tabArgs);
	if (tab.code !== 0) return { outcome: failedCommand(tab, ctx) };
	const handles = herdrHandles(tab);
	if (handles.tabId !== null)
		residue.tab = recordResource(ctx, "tab", handles.tabId, (labels) => labels.tab);
	if (handles.paneId === null || handles.tabId === null)
		return { outcome: failed("herdr tab create returned no pane id", ctx) };
	return {
		handles: { paneId: handles.paneId, tabId: handles.tabId, workspaceId },
	};
}

/**
 * Record one resource this start created, in the wording its caller stated, and
 * answer with the handle as it was recorded.
 *
 * A start with no resource table records nothing, yet still gets the handle back:
 * the residue record carries the same kind the table would have held, so the
 * cleanup confirms the kind the start wrote rather than a kind it spells again
 * (pull request #213 review). The recorder and its labels travel together (see
 * `StartResources`), so there is no default wording for a row to fall back to.
 */
function recordResource(
	ctx: HandoffContext,
	kind: ResourceKind,
	resourceId: string,
	label: (labels: StartResourceLabels) => string,
): CreatedHandle {
	if (ctx.resources !== null)
		ctx.resources.record(kind, resourceId, true, label(ctx.resources.labels));
	return { kind, resourceId };
}

/**
 * Remove what one start created, and only that (issue #204).
 *
 * Best effort: the start's own failure is the reason the operator sees, and a
 * cleanup error must not replace it. The tab goes first, then the workspace or
 * worktree checkout behind it, then the branch this start created.
 *
 * What a close really took down is confirmed in the caller's resource table, so
 * the record does not keep a row for a handle the plane already removed. A close
 * herdr refuses leaves its row unconfirmed: that resource may still stand, and
 * the operator's Close has to be able to reach it.
 */
async function removeResidue(ctx: HandoffContext, residue: Residue): Promise<void> {
	if (residue.tab !== null && (await closeTab(residue.tab.resourceId, ctx)))
		confirmRemoved(ctx, residue.tab);
	if (residue.worktree !== null) {
		if (await removeWorktreeCheckout(residue.worktree.resourceId, ctx)) {
			// `worktree remove` takes the workspace herdr created together with its
			// checkout, and the root tab between them, so all three rows go.
			confirmRemoved(ctx, residue.worktree);
			if (residue.workspace !== null) confirmRemoved(ctx, residue.workspace);
			if (residue.rootTab !== null) confirmRemoved(ctx, residue.rootTab);
		}
	} else if (residue.workspace !== null) {
		if (await closeWorkspace(residue.workspace.resourceId, ctx)) {
			confirmRemoved(ctx, residue.workspace);
			if (residue.rootTab !== null) confirmRemoved(ctx, residue.rootTab);
		}
	}
	if (residue.branch !== null) {
		// A branch delete is cleanup like every other half of this rule: a command
		// that raises is answered the way a refusal is, so it cannot escape the
		// start and take the rest of the cleanup with it.
		try {
			await ctx.runner.run("git", ["-C", ctx.checkout, "branch", "-D", residue.branch]);
		} catch {
			// Best effort.
		}
	}
}

/**
 * Tell the caller's resource table that this start removed what it recorded.
 *
 * The kind comes out of the record the start wrote, never out of a second copy of
 * the word, so a recorded row and its confirmation cannot name different kinds
 * (pull request #213 review).
 */
function confirmRemoved(ctx: HandoffContext, created: CreatedHandle): void {
	ctx.resources?.removed?.(created.kind, created.resourceId);
}

/**
 * The base a fresh worktree starts from (the "Worktree base" the glossary
 * records): the remote default branch of the repository's origin after a
 * fresh fetch of that single ref, or the local checkout's HEAD when the
 * origin, the default branch, or the fetch is unavailable. The same rule
 * serves a ticket handoff worktree and a Consultation worktree.
 *
 * A fallback carries a note for the handoff's note channel that names the
 * base actually used (ref name plus short sha) and the reason, so weeks
 * later the operator can answer "was that agent working on stale code?" in
 * one read. The fetch touches only the remote-tracking ref and pulls only
 * the default branch ref, so uncommitted work in the checkout is never
 * disturbed and the handoff stays fast on a large repository.
 */
type FreshWorktreeBase = { reference: string; note?: string } | { fail: string };

async function freshWorktreeBase(
	checkout: string,
	runner: CommandRunner,
): Promise<FreshWorktreeBase> {
	const origin = await runner.run("git", ["-C", checkout, "remote", "get-url", "origin"]);
	if (origin.code !== 0 || origin.stdout.trim() === "")
		return localHeadBase(checkout, "no usable origin remote", runner);
	const branch = await remoteDefaultBranch(checkout, runner);
	if (branch === null)
		return localHeadBase(
			checkout,
			"no default branch found on origin (tried the origin/HEAD symref, then origin/main, then origin/master)",
			runner,
		);
	const fetched = await runner.run("git", ["-C", checkout, "fetch", "origin", branch]);
	if (fetched.code !== 0)
		return localHeadBase(
			checkout,
			`fetching origin/${branch} failed: ${commandFailureText(fetched)}`,
			runner,
		);
	return { reference: `origin/${branch}` };
}

/**
 * The local checkout's HEAD as the worktree base, with the fallback note:
 * the base actually used (ref name plus short sha) and the reason.
 */
async function localHeadBase(
	checkout: string,
	reason: string,
	runner: CommandRunner,
): Promise<FreshWorktreeBase> {
	const head = await runner.run("git", ["-C", checkout, "rev-parse", "HEAD"]);
	const sha = head.stdout.trim();
	if (head.code !== 0 || sha === "")
		return { fail: `cannot read HEAD in ${checkout}: ${commandFailureText(head)}` };
	return {
		reference: sha,
		note: `the worktree base fell back to HEAD ${sha.slice(0, 7)}: ${reason}`,
	};
}

/**
 * The worktree Environment: the branch the naming rule gives the work, then the
 * herdr worktree that holds it.
 *
 * A stored workspace of this kind is reopened on its branch without re-reading
 * the branch or HEAD: the branch is the branch, and herdr's `worktree open` owns
 * it. Otherwise the branch is checked in the checkout first. An existing branch
 * follows the request's branch policy - reused, or refused - and the reuse takes
 * no fetch. A missing branch is created from the worktree base (see
 * freshWorktreeBase).
 */
async function buildWorktreeEnvironment(
	request: HandoffStartRequest,
	ctx: HandoffContext,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	const branch = request.branch.name;
	const checkout = ctx.checkout;
	ctx.onStage?.("creating-environment");
	if (request.workspace.kind === "stored") {
		const listed = await readStartWorkspaces(request, ctx);
		if (!listed.ok) return { outcome: listed.outcome };
		if (listed.held !== null) {
			// The stored workspace still holds: a fresh tab in it, at the
			// workspace's own cwd.
			return openFreshTab(listed.held, null, ctx, residue);
		}
		// The worktree is gone: reopen it on the branch the naming rule gives the ticket.
		return reuseBranch(ctx, branch, residue);
	}
	const known = await ctx.runner.run("git", ["-C", checkout, "branch", "--list", branch]);
	if (known.code !== 0)
		return {
			outcome: failed(`cannot check branch in ${checkout}: ${commandFailureText(known)}`, ctx),
		};
	if (known.stdout.trim() !== "") {
		if (request.branch.policy === "refuse")
			return { outcome: failed(`Consultation branch already exists: ${branch}`, ctx) };
		return reuseBranch(ctx, branch, residue);
	}
	const base = await freshWorktreeBase(checkout, ctx.runner);
	if ("fail" in base) return { outcome: failed(base.fail, ctx) };
	if (base.note !== undefined) ctx.notes = { ...ctx.notes, worktreeBase: base.note };
	const created = await createWorktree(ctx, checkout, branch, [
		"worktree",
		"create",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--base",
		base.reference,
		"--no-focus",
	]);
	return createdWorktreeAnswer(created, ctx, branch, true, residue);
}

/**
 * The branch already stands in the checkout, so the worktree is opened on it.
 *
 * When no herdr workspace holds the branch, the worktree git records is reopened
 * by path. When no worktree stands on the branch either, herdr creates one on the
 * branch it did not make. The branch pre-dates the start either way, so the
 * cleanup removes the checkout and never the branch.
 */
async function reuseBranch(
	ctx: HandoffContext,
	branch: string,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	const checkout = ctx.checkout;
	const opened = await ctx.runner.run("herdr", [
		"worktree",
		"open",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--no-focus",
	]);
	if (opened.code === 0) return startInOpenedWorktree(opened, ctx, residue);
	if (herdrErrorCode(opened) !== "worktree_not_found")
		return { outcome: failedCommand(opened, ctx) };
	// No herdr workspace holds the branch. A linked worktree git records is
	// reopened by path: herdr's own `worktree open` refuses a path it does not
	// know, and a branch alone does not name the directory.
	const worktreePath = await findTicketWorktreePath(checkout, branch, ctx);
	if (worktreePath !== null) {
		const reopened = await ctx.runner.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			checkout,
			"--path",
			worktreePath,
			"--no-focus",
		]);
		if (reopened.code === 0) return startInOpenedWorktree(reopened, ctx, residue);
		if (herdrErrorCode(reopened) !== "worktree_not_found")
			return { outcome: failedCommand(reopened, ctx) };
	}
	const created = await createWorktree(ctx, checkout, branch, [
		"worktree",
		"create",
		"--cwd",
		checkout,
		"--branch",
		branch,
		"--no-focus",
	]);
	return createdWorktreeAnswer(created, ctx, branch, false, residue);
}

/**
 * The answer a `herdr worktree create` gives: the workspace, its root pane, and
 * the tab that holds it. `createdBranch` says whether this start made the branch,
 * which is what the cleanup may delete.
 */
function createdWorktreeAnswer(
	created: CommandResult,
	ctx: HandoffContext,
	branch: string,
	createdBranch: boolean,
	residue: Residue,
): EnvironmentAnswer {
	if (created.code !== 0) return { outcome: failedCommand(created, ctx) };
	const handles = herdrHandles(created);
	if (handles.workspaceId === null) {
		// The cleanup needs the workspace id, so it cannot run here. The message
		// names the residue the operator has to remove by hand: the branch this
		// start created, or the branch the worktree was to be built on.
		return {
			outcome: failed(
				`herdr worktree create returned no workspace id; check for a leftover ${createdBranch ? `branch ${branch}` : `worktree on branch ${branch}`}`,
				ctx,
			),
		};
	}
	residue.workspace = recordResource(
		ctx,
		"workspace",
		handles.workspaceId,
		(labels) => labels.worktreeWorkspace,
	);
	residue.worktree = recordResource(
		ctx,
		"worktree",
		handles.workspaceId,
		(labels) => `${labels.worktreeCheckout} for ${branch}`,
	);
	if (handles.tabId !== null)
		residue.rootTab = recordResource(ctx, "tab", handles.tabId, (labels) => labels.worktreeTab);
	// Only a branch this start made enters the record: a branch the repository
	// already carried pre-dates the attempt and never goes.
	residue.branch = createdBranch ? branch : null;
	if (handles.paneId === null || handles.tabId === null)
		return { outcome: failed("herdr worktree create returned no pane id", ctx) };
	return {
		handles: { paneId: handles.paneId, tabId: handles.tabId, workspaceId: handles.workspaceId },
	};
}

/** How many numbered `.leftover-<n>` names one leftover directory may ask for. */
const LEFTOVER_PATH_TAKES = 20;

/** One `herdr worktree list` entry, as the list writes it. */
interface WorktreeListEntry {
	readonly path: string;
	readonly is_linked_worktree?: unknown;
	readonly is_prunable?: unknown;
}

/**
 * The path the ticket's worktree stands in, when the branch lookup found
 * nothing: herdr names a worktree checkout after the branch it was made
 * for (the branch with its slashes for hyphens), beside the repository's
 * other linked worktrees. The agent that last worked the ticket may have
 * left that worktree on another branch - the work of a pull request lands
 * on the branch the agent chose, not the plane's - so no worktree holds
 * the branch while the worktree still stands, and a fresh create would
 * collide with its directory.
 *
 * The answer comes from a herdr `worktree list`: the candidate path is
 * taken from the parent of the repository's linked worktrees and the
 * branch's name, and it counts only when the list holds a linked
 * worktree at exactly that path that git no longer prunes. A list that
 * does not read, and a worktree the list does not hold, answer null: the
 * reuse sequence then takes the fresh create, the way it always did.
 */
async function findTicketWorktreePath(
	checkout: string,
	branch: string,
	ctx: HandoffContext,
): Promise<string | null> {
	const paths = await readTicketWorktreePaths(checkout, branch, ctx);
	return paths.standingPath;
}

/**
 * One `herdr worktree create`, and the one recovery a blocked path allows.
 *
 * git refuses to check a branch out over a directory that holds anything, and
 * that is how a ticket can stop for good: the checkout herdr made for the
 * branch is gone from git, while the directory it held stays behind with a
 * build cache in it (an Agent's dev server recreates the path after the
 * removal). The branch then exists, no worktree holds it, and every create
 * answers the same way, so the ticket can never run again.
 *
 * The plane answers that refusal once, and answers it without destroying
 * anything: it moves the leftover directory aside under a name that states
 * what it is, then asks herdr for the create again. A refusal that has no
 * such directory beside the branch's own name is left exactly as it came
 * back, and the second create's answer is the one the handoff reports.
 */
async function createWorktree(
	ctx: HandoffContext,
	checkout: string,
	branch: string,
	argv: readonly string[],
): Promise<CommandResult> {
	const created = await ctx.runner.run("herdr", argv);
	if (created.code === 0) {
		return created;
	}
	const moved = await moveLeftoverWorktreeDirectory(checkout, branch, ctx);
	if (moved === null) {
		return created;
	}
	ctx.notes = { ...ctx.notes, leftoverWorktree: moved.note };
	return await ctx.runner.run("herdr", argv);
}

/**
 * Move the leftover directory at one branch's own worktree path aside.
 *
 * Three answers must hold before the plane touches a path in the operator's
 * home, and each one closes a door it must not walk through:
 *
 * - The naming rule must name the path. A worktree list that does not read
 *   keeps every directory where it is, the same way it keeps the reopen
 *   lookup silent (ADR 0046).
 * - git must hold no record of the path. A recorded worktree, prunable or
 *   not, is herdr's to open or remove: the reopen by path already took the
 *   standing one, and `git worktree remove` is the answer for a stale
 *   record, not a rename by the plane.
 * - The directory must hold no `.git` entry, and must hold something. An
 *   empty directory is no block at all, so a refusal beside it is about
 *   something else; a directory with a `.git` entry is a checkout, and the
 *   plane never moves a checkout (ADR 0012).
 *
 * The new name is `<path>.leftover`, then `<path>.leftover-2` and up, at the
 * first free slot: a second leftover from the same ticket stays whole rather
 * than land on top of the first.
 *
 * The list is read again here, after the refusal. The reuse sequence's read
 * came before the create, and what this rule needs is the state the create
 * actually met.
 */
async function moveLeftoverWorktreeDirectory(
	checkout: string,
	branch: string,
	ctx: HandoffContext,
): Promise<{ readonly from: string; readonly to: string; readonly note: string } | null> {
	const paths = await readTicketWorktreePaths(checkout, branch, ctx);
	const from = paths.candidate;
	if (from === null || paths.recorded) {
		return null;
	}
	const entries = await readDirectoryNames(from);
	if (entries === null || entries.length === 0 || entries.includes(".git")) {
		return null;
	}
	const to = await freeLeftoverPath(from);
	if (to === null || !(await movePath(from, to))) {
		return null;
	}
	return {
		from,
		to,
		note: `the plane moved the leftover worktree directory ${from} aside to ${to}`,
	};
}

/** The first free `<path>.leftover[-<n>]` beside one worktree path. */
async function freeLeftoverPath(path: string): Promise<string | null> {
	const first = `${path}.leftover`;
	if (!(await fileExists(first))) {
		return first;
	}
	for (let take = 2; take <= LEFTOVER_PATH_TAKES + 1; take += 1) {
		const candidate = `${path}.leftover-${take}`;
		if (!(await fileExists(candidate))) {
			return candidate;
		}
	}
	// Every numbered name is taken: a leftover from an earlier handoff of the
	// same ticket holds the slot, and the plane does not move a second one
	// over it.
	return null;
}

/**
 * What herdr's worktree list and the checkout answer about one branch's
 * worktree path. The naming rule gives one path, and three facts come back
 * from it: the path itself, whether a worktree git still prunes-free stands
 * there, and whether git holds any record of it at all.
 *
 * A list that does not read answers nothing: `candidate` and `standingPath`
 * stay null and `recorded` stays false, so a caller neither reopens a path it
 * cannot name nor moves a directory it cannot place.
 */
async function readTicketWorktreePaths(
	checkout: string,
	branch: string,
	ctx: HandoffContext,
): Promise<TicketWorktreePaths> {
	const empty: TicketWorktreePaths = { candidate: null, standingPath: null, recorded: false };
	const listed = await ctx.runner.run("herdr", ["worktree", "list", "--cwd", checkout]);
	if (listed.code !== 0) {
		return empty;
	}
	let data: unknown;
	try {
		data = JSON.parse(listed.stdout);
	} catch {
		return empty;
	}
	const worktrees = (data as { result?: { worktrees?: unknown } }).result?.worktrees;
	if (!Array.isArray(worktrees)) {
		return empty;
	}
	const entries = worktrees.filter(
		(entry): entry is WorktreeListEntry =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { path?: unknown }).path === "string",
	);
	// The parent of the linked worktrees is the herdr worktree directory of
	// this repository; the candidate sits in it under the branch's name.
	const linked = entries.find((entry) => entry.is_linked_worktree === true);
	if (linked === undefined) {
		return empty;
	}
	const parent = linked.path.slice(0, linked.path.lastIndexOf("/"));
	if (parent === "") {
		return empty;
	}
	const candidate = `${parent}/${branch.replaceAll("/", "-")}`;
	const standing = entries.some(
		(entry) =>
			entry.path === candidate && entry.is_linked_worktree === true && entry.is_prunable !== true,
	);
	return {
		candidate,
		standingPath: standing ? candidate : null,
		recorded: entries.some((entry) => entry.path === candidate),
	};
}

/** The three answers one branch's worktree path gives. */
interface TicketWorktreePaths {
	/** The path the naming rule gives the branch, or null when no parent reads. */
	candidate: string | null;
	/** That path, when a worktree git does not prune stands in it. */
	standingPath: string | null;
	/** Whether git's own list holds the path, prunable or not. */
	recorded: boolean;
}

/**
 * The answer a `herdr worktree open` gives. The Agent starts in a fresh pane of
 * the workspace it returned: a fresh tab when a workspace was already open on the
 * worktree, the attached workspace's first pane when herdr just opened it.
 */
async function startInOpenedWorktree(
	opened: CommandResult,
	ctx: HandoffContext,
	residue: Residue,
): Promise<EnvironmentAnswer> {
	const handles = herdrHandles(opened);
	if (handles.workspaceId === null)
		return { outcome: failed("herdr worktree open returned no workspace id", ctx) };
	if (worktreeAlreadyOpen(opened)) {
		// A workspace was already open on the worktree: add a fresh tab in it.
		const worktreePath = jsonResultField(opened, "worktree", "path");
		if (worktreePath === null)
			return { outcome: failed("herdr worktree open returned no worktree path", ctx) };
		return openFreshTab(handles.workspaceId, worktreePath, ctx, residue);
	}
	// herdr attached a fresh workspace: its first pane is fresh, and the
	// workspace goes into the residue record so the one cleanup rule takes it down.
	if (handles.paneId === null || handles.tabId === null) {
		residue.workspace = { kind: "workspace", resourceId: handles.workspaceId };
		return { outcome: failed("herdr worktree open returned no pane id", ctx) };
	}
	residue.workspace = { kind: "workspace", resourceId: handles.workspaceId };
	return {
		handles: { paneId: handles.paneId, tabId: handles.tabId, workspaceId: handles.workspaceId },
	};
}

/**
 * The answer the pull request open gives (ADR 0076): the pull request that
 * stands on the branch - reused, or opened as a draft - with the facts the
 * cleanup needs to tell what this attempt created from what pre-dates it.
 */
type PullRequestOpenAnswer =
	| { url: string; number: number; opened: boolean; createdRemoteBranch: boolean }
	| { fail: string; cleanup: () => Promise<void> };

/**
 * The pull request open (ADR 0076): the ticket's factory branch is pushed
 * to its remote, the open pull request the branch already carries is read by
 * its head branch, and a draft is opened when none stands. A pull request
 * the branch already carries is reused, and no second one is opened.
 *
 * A branch the remote did not carry first receives the plane's empty hold
 * commit, because the source opens no pull request on a head that carries no
 * commit ahead of its base. The hold stays on the branch: pushing the branch
 * back to its base after the open closes the pull request, and the agent's
 * commits stack on the hold. The fire's work test - the head's tree against
 * the base's, not the commit count - sees through it.
 *
 * The no-residue contract (ADR 0076): a failure answers with the reason it
 * reports and the cleanup of what the attempt created - the remote branch it
 * pushed when the branch did not stand on the remote before, and the pull
 * request it opened. What pre-dates the attempt is never touched: a branch
 * the remote already carried is not deleted, and a pull request the read
 * found is not closed.
 */
async function runPullRequestOpen(
	ctx: HandoffContext,
	plan: PullRequestOpenPlan,
): Promise<PullRequestOpenAnswer> {
	const noopCleanup = async (): Promise<void> => {};
	// The branch, before the push: the attempt deletes only a remote branch
	// it created, never one the remote already carried. A command that raises
	// is a failure the tagged answer carries, the way the module's reads do: an
	// answer that escaped would skip the cleanup of what the attempt created.
	let listed: CommandResult;
	try {
		listed = await ctx.runner.run(
			"git",
			["-C", ctx.checkout, "ls-remote", "--heads", "origin", plan.branch],
			{ env: { GIT_TERMINAL_PROMPT: "0" } },
		);
	} catch (error) {
		return {
			fail: `the pull request open could not read the factory branch from origin: ${errorMessage(
				error,
			)}`,
			cleanup: noopCleanup,
		};
	}
	if (listed.code !== 0)
		return {
			fail: `the pull request open could not read the factory branch from origin: ${commandFailureText(listed)}`,
			cleanup: noopCleanup,
		};
	const existedBefore = listed.stdout.trim() !== "";
	const pushCleanup = existedBefore
		? noopCleanup
		: () => deleteRemoteBranch(ctx, ctx.checkout, plan.branch);
	// A branch the remote did not carry stands at its base: the create would
	// answer "No commits between", and no retry of the create clears it. The
	// hold commit gives the open a commit to stand on, before the push. The
	// commit moves the factory branch by its name - the refs read, the empty
	// commit built on it, the branch moved to it - and never the checkout's
	// current branch, which the open runs from and owns no part of.
	if (!existedBefore) {
		let refs: CommandResult;
		try {
			refs = await ctx.runner.run("git", [
				"-C",
				ctx.checkout,
				"rev-parse",
				plan.branch,
				`${plan.branch}^{tree}`,
			]);
		} catch (error) {
			return {
				fail: `the pull request open could not read the factory branch: ${errorMessage(error)}`,
				cleanup: noopCleanup,
			};
		}
		const refLines = refs.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "");
		if (refs.code !== 0 || refLines.length !== 2)
			return {
				fail: `the pull request open could not read the factory branch: ${commandFailureText(refs)}`,
				cleanup: noopCleanup,
			};
		const [tip, tree] = refLines as [string, string];
		let held: CommandResult;
		try {
			held = await ctx.runner.run("git", [
				"-C",
				ctx.checkout,
				"commit-tree",
				tree,
				"-p",
				tip,
				"-m",
				PULL_REQUEST_HOLD_COMMIT_MESSAGE,
			]);
		} catch (error) {
			return {
				fail: `the pull request open could not commit the hold: ${errorMessage(error)}`,
				cleanup: noopCleanup,
			};
		}
		const holdSha = held.stdout.trim();
		if (held.code !== 0 || holdSha === "")
			return {
				fail: `the pull request open could not commit the hold: ${commandFailureText(held)}`,
				cleanup: noopCleanup,
			};
		let moved: CommandResult;
		try {
			moved = await ctx.runner.run("git", [
				"-C",
				ctx.checkout,
				"update-ref",
				`refs/heads/${plan.branch}`,
				holdSha,
			]);
		} catch (error) {
			return {
				fail: `the pull request open could not move the factory branch to the hold: ${errorMessage(error)}`,
				cleanup: noopCleanup,
			};
		}
		if (moved.code !== 0)
			return {
				fail: `the pull request open could not move the factory branch to the hold: ${commandFailureText(moved)}`,
				cleanup: noopCleanup,
			};
	}
	let pushed: CommandResult;
	try {
		pushed = await ctx.runner.run("git", ["-C", ctx.checkout, "push", "origin", plan.branch], {
			env: { GIT_TERMINAL_PROMPT: "0" },
		});
	} catch (error) {
		return {
			fail: `pushing the factory branch ${plan.branch} raised: ${errorMessage(error)}`,
			// A push that raises may have created the branch: the delete is
			// best effort, and a branch the remote pre-carried is never touched.
			cleanup: pushCleanup,
		};
	}
	if (pushed.code !== 0)
		return {
			fail: `pushing the factory branch ${plan.branch} failed: ${commandFailureText(pushed)}`,
			// A failed push creates no remote branch: the attempt owns nothing
			// of its own to delete, and a branch the remote pre-carried is never
			// touched.
			cleanup: noopCleanup,
		};
	const createdRemoteBranch = !existedBefore;
	const records = await listOpenPullRequestsByHeadBranch(
		ctx.runner,
		plan.source,
		plan.ticket.repositoryRef,
		plan.branch,
	);
	if ("fail" in records)
		return {
			fail: `the pull request open could not read the branch's pull requests: ${records.fail}`,
			cleanup: pushCleanup,
		};
	const standing = records[0];
	if (standing !== undefined)
		return {
			url: standing.url,
			number: standing.number,
			opened: false,
			createdRemoteBranch,
		};
	const opened = await openDraftPullRequest(
		ctx.runner,
		plan.source,
		plan.ticket.repositoryRef,
		plan.branch,
		plan.ticket.title,
		pullRequestBodyFor(plan.ticket),
	);
	if ("fail" in opened)
		return {
			fail: `the pull request open could not open the draft pull request: ${opened.fail}`,
			cleanup: pushCleanup,
		};
	return { url: opened.url, number: opened.number, opened: true, createdRemoteBranch };
}

/**
 * The best-effort delete of a remote branch the attempt created (ADR 0076):
 * the delete runs only in a cleanup, and a cleanup that cannot delete leaves
 * nothing behind to report: the handoff's reason is the fact the operator
 * sees, and the branch the remote carries stays readable in its own right.
 */
async function deleteRemoteBranch(
	ctx: HandoffContext,
	checkout: string,
	branch: string,
): Promise<void> {
	await ctx.runner.run("git", ["-C", checkout, "push", "origin", "--delete", branch], {
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
}

/**
 * The cleanup of the residue of one pull request open (ADR 0076): the pull
 * request the attempt opened is closed, and the remote branch the attempt
 * created is deleted. Null when the attempt created nothing of its own - a
 * reuse on a branch the remote already carried - and a handoff that fails
 * after the open never touches what pre-dated it.
 */
function pullRequestOpenCleanup(
	ctx: HandoffContext,
	plan: PullRequestOpenPlan,
	opened: { url: string; number: number; opened: boolean; createdRemoteBranch: boolean },
): (() => Promise<void>) | null {
	if (!opened.opened && !opened.createdRemoteBranch) return null;
	return async () => {
		if (opened.opened)
			await closePullRequest(ctx.runner, plan.source, plan.ticket.repositoryRef, opened.number);
		if (opened.createdRemoteBranch) await deleteRemoteBranch(ctx, ctx.checkout, plan.branch);
	};
}

/**
 * The step between the environment's creation and the agent's start
 * (ADR 0076): the pull request open for a task type that opens one, and the
 * prompt the start sends. A failure answers with the reason and the cleanup
 * of what the attempt created; a pass carries the prompt to send - filled
 * with the pull request's url where the open ran - and the cleanup a later
 * failure runs.
 */
async function promptBeforeAgent(
	ctx: HandoffContext,
	prompt: HandoffPrompt,
): Promise<
	| { text: string; cleanup: (() => Promise<void>) | null }
	| { fail: string; cleanup: () => Promise<void> }
> {
	if (typeof prompt === "string") return { text: prompt, cleanup: null };
	const plan = ctx.pullRequestOpen;
	if (plan === undefined)
		return {
			fail: "the handoff prompt asks for the pull request url, but the handoff opens no pull request",
			cleanup: async () => {},
		};
	const opened = await runPullRequestOpen(ctx, plan);
	if ("fail" in opened) return { fail: opened.fail, cleanup: opened.cleanup };
	const text = await prompt(opened.url);
	return { text, cleanup: pullRequestOpenCleanup(ctx, plan, opened) };
}

/**
 * One cleanup command, and whether herdr took the resource down.
 *
 * A cleanup is best effort twice over: a non-zero answer means the resource
 * stands, and so does a command that raised. The start's own failure is the
 * reason the operator sees, so a cleanup adds no second failure beside it.
 */
async function cleanupCommand(ctx: HandoffContext, args: readonly string[]): Promise<boolean> {
	const result = await runQuietly(ctx, args);
	return result !== null && result.code === 0;
}

/**
 * Run one herdr command and answer null when it raised.
 *
 * The cleanup path and the predecessor tab close both read a raise as "herdr did
 * not confirm this is gone", never as a failure that escapes the start.
 */
async function runQuietly(
	ctx: HandoffContext,
	args: readonly string[],
): Promise<CommandResult | null> {
	try {
		return await ctx.runner.run("herdr", args);
	} catch {
		return null;
	}
}

/** Remove a herdr worktree checkout, best effort. The branch stays. */
async function removeWorktreeCheckout(workspaceId: string, ctx: HandoffContext): Promise<boolean> {
	return await cleanupCommand(ctx, ["worktree", "remove", "--workspace", workspaceId]);
}

/** Close a herdr workspace, best effort. Its worktree and branch stay. */
async function closeWorkspace(workspaceId: string, ctx: HandoffContext): Promise<boolean> {
	return await cleanupCommand(ctx, ["workspace", "close", workspaceId]);
}

/** Close a herdr tab, best effort. */
async function closeTab(tabId: string, ctx: HandoffContext): Promise<boolean> {
	return await cleanupCommand(ctx, ["tab", "close", tabId]);
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
	progress: StartProgress,
): Promise<HandoffOutcome> {
	const attempt = await startAgentUnderAvailableName(agent, args, handles.paneId, ctx);
	if (attempt.name === null) {
		return failedNameUnusable(attempt, ctx);
	}
	const name = attempt.name;
	// The agent is running: record its handles before the next external
	// command. From here the ticket is handed-off even if the prompt fails, and
	// the Agent goes on the progress so a command that raises from here on
	// answers as the failed prompt it is instead of rolling the Environment out
	// from under a live Agent.
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
	progress.agent = startedAgent;
	ctx.onAgentStarted?.(startedAgent);
	ctx.onStage?.("sending-prompt");
	const sent = await sendAgentPrompt(name, prompt, ctx);
	const previousTabClosed = await closePreviousTab(handles.previousTabId, startedAgent.tabId, ctx);
	const collisions = collisionsAfterPreviousTabClose(
		attempt,
		handles.previousTabId,
		previousTabClosed,
	);
	if ("result" in sent && sent.result.code === 0)
		return { status: "ok", agent: startedAgent, notes: ctx.notes, ...collisions };
	return {
		status: "prompt-failed",
		reason: `agent ${name} started, but the prompt failed: ${
			"result" in sent ? herdrFailureText(sent.result) : sent.raised
		}`,
		agent: startedAgent,
		notes: ctx.notes,
		...collisions,
	};
}

/**
 * Send the prompt, and answer with herdr's reply or the raise's message.
 *
 * A raise is read as the failed prompt it is: the Agent already runs, and a
 * started Agent is never rolled back. The message reaches the operator the way a
 * refusal's does, so the fact the plane could not run is the fact on the record.
 */
async function sendAgentPrompt(
	name: string,
	prompt: string,
	ctx: HandoffContext,
): Promise<{ result: CommandResult } | { raised: string }> {
	try {
		return { result: await ctx.runner.run("herdr", ["agent", "prompt", name, prompt]) };
	} catch (error) {
		return { raised: errorMessage(error) };
	}
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
 * ending it in herdr. A collision with a stranger names the stranger:
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
		? `this ticket's own leftover agent still holds the herdr name ${collision.stableName} (${holder}); end its leftover environment in herdr, then hand off again: ${collision.reason}`
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
	// The Agent is already running, so this close answers false on a refusal and
	// on a raise alike: it never fails the handoff.
	const closed = await runQuietly(ctx, ["tab", "close", previousTabId]);
	return closed !== null && (closed.code === 0 || herdrErrorCode(closed) === "tab_not_found");
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
	if (reach.scope === "none") {
		return undefined;
	}
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
			// A close of a workspace the operator is not viewing leaves herdr's
			// view alone, so no focus command follows it (ADR 0061).
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
		// The tab close keeps the workspace and the tabs beside it, so herdr
		// leaves the operator's view where it stood: the cleanup sends no
		// focus command here either, and none follows a workspace close (ADR 0061).
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

/**
 * The close the decision screen's route asks for: the previous handoff's
 * environment goes, and the handoff that follows builds its own beside it.
 *
 * It reaches the stored handles, the way the Close cleanup does, but never
 * removes the worktree checkout or touches a branch: the worktree
 * environment loses its herdr workspace, and the checkout and branch stay
 * on disk, so the handoff that follows reopens the worktree on its branch
 * in a fresh workspace. The live-worktree environment loses its tab, and
 * the shared workspace and the tabs beside it stay. The work continues
 * where it stood; only the herdr workspace that holds it is new.
 *
 * Best effort, the way the handoff's own close of the predecessor tab is:
 * an environment herdr no longer holds is already gone, and that answers
 * the close. A refusal herdr makes stands as the reason, and the caller's
 * handoff still runs: the stored workspace the close could not take down
 * is the one the run reuses, the way it always did, and the predecessor
 * tab the run closes after the agent starts is the residue the close left.
 *
 * A workspace close sends no focus command: the control plane never moves
 * herdr's view on its own (ADR 0061), and a close of a workspace the client
 * is not viewing leaves that client's view alone.
 */
export async function closeStoredEnvironment(
	handoff: { environment: EnvironmentKind; tabId: string | null; workspaceId: string | null },
	runner: CommandRunner,
): Promise<string | undefined> {
	if (handoff.environment === "worktree" && handoff.workspaceId !== null) {
		const closed = await runner.run("herdr", ["workspace", "close", handoff.workspaceId]);
		if (closed.code === 0 || herdrErrorCode(closed) === "workspace_not_found") {
			return undefined;
		}
		return herdrFailureText(closed);
	}
	if (handoff.environment === "live-worktree" && handoff.tabId !== null) {
		const closed = await runner.run("herdr", ["tab", "close", handoff.tabId]);
		if (closed.code === 0 || herdrErrorCode(closed) === "tab_not_found") return undefined;
		return herdrFailureText(closed);
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
 *
 * The message carries another tool's whole answer when herdr only ran it: a
 * refused `worktree create` holds Git's progress line and its refusal. The
 * plane states the line that names the failure, the way it reads a raw
 * failure; the Message line is one row, so the rest never reaches the operator.
 */
export function herdrFailureText(result: CommandResult): string {
	const code = herdrErrorCode(result);
	if (code === null) {
		return commandFailureText(result);
	}
	const message = herdrErrorMessage(result);
	if (message === "") {
		return code;
	}
	const line = failureLine(message) ?? message.trim();
	return `${line} (${code})`;
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
 * The setting arguments of a handoff: each chosen setting the Agent type maps
 * is substituted into its argument template into argv. A setting left empty is
 * ignored: no template, no arguments, and the setting is left to the Agent.
 *
 * The Setting fit check runs ahead of every start path and refuses a non-empty
 * setting the resolved Agent maps no template for, so the mapping test here
 * holds no silent drop: a value the operator named either reaches the Agent or
 * fails the start with a readable reason (ADR 0009).
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
 * restarts; an open-ticket handoff leaves it empty. `reviewVerdict` fills
 * {review-verdict} from the verdict read the ticket prompt runs (ADR 0074);
 * a template the read did not fill leaves it empty.
 */
export function renderPrompt(
	template: string,
	ticket: Ticket,
	previousMessage = "",
	reviewVerdict = "",
	pullRequestUrl = "",
): string {
	const values: Record<string, string> = {
		repository: ticket.repository,
		title: ticket.title,
		description: ticket.description,
		"source-kind": ticket.sourceKind,
		"external-key": ticket.externalKey,
		"source-url": ticket.url,
		labels: ticket.labels.join(", "),
		"previous-message": previousMessage,
		"review-verdict": reviewVerdict,
		// The url the pull request open fills (ADR 0076): empty on every
		// handoff that opens no pull request, where the placeholder stands
		// unrendered in no template.
		"pull-request-url": pullRequestUrl,
	};
	return template.replace(
		/\{(repository|title|description|source-kind|external-key|source-url|labels|previous-message|review-verdict|pull-request-url)\}/g,
		(_match, name) => values[name],
	);
}

/**
 * The {review-verdict} fill the rework prompt leads with (ADR 0074): the
 * verdict's body unchanged, under a one-line header naming the posting
 * timeline and the post's time - the agent's staleness cue against the
 * branch head - the fact line when no verdict stands, and the failure fact
 * with the read's reason when every timeline's read failed.
 *
 * A verdict score that stands at or above the workflow's score threshold
 * (ADR 0078) fills the gates fact instead of the verdict's body: the review
 * passed, so the rework works the pull request's gates - the merge conflict
 * or the failing CI check - and not the review's feedback. A read that
 * carries no score, or a handoff whose config names no threshold, keeps the
 * verdict's body.
 */
export function reviewVerdictFill(read: ReviewVerdictRead, scoreThreshold?: number): string {
	switch (read.kind) {
		case "verdict": {
			const score = scoreFromMessage(read.verdict.body);
			if (score !== null && scoreThreshold !== undefined && score >= scoreThreshold) {
				return (
					`The review passed: the score ${score} stands at or above the threshold ${scoreThreshold}. ` +
					"The failure stands in the pull request's gates: a merge conflict or a failing CI check. " +
					"Rebase the branch onto its base and fix what the gates report."
				);
			}
			return `Posted as a ${read.verdict.timeline} at ${read.verdict.at}:\n${read.verdict.body}`;
		}
		case "none":
			return "No review verdict found on the pull request.";
		case "failed":
			return `The review verdict read failed: ${read.reason}.`;
	}
}

/**
 * The ticket prompt with the review verdict read (ADR 0074): when the
 * template references the {review-verdict} placeholder, the verdict stands
 * on the source read, run through the command runner, before the render -
 * the same read the score judgment runs at settle. A template without the
 * reference issues no read and renders the prompt as before.
 */
async function renderTicketPrompt(
	template: string,
	ticket: Ticket,
	runner: CommandRunner,
	sources: readonly TicketSourceConfig[],
	previousMessage = "",
	pullRequestUrl = "",
	scoreThreshold?: number,
): Promise<string> {
	let reviewVerdict = "";
	if (template.includes("{review-verdict}"))
		reviewVerdict = reviewVerdictFill(
			await readReviewVerdict(runner, sources, ticket),
			scoreThreshold,
		);
	return renderPrompt(template, ticket, previousMessage, reviewVerdict, pullRequestUrl);
}

/**
 * One herdr `workspace list` answer, read once (issue #204).
 *
 * A list that does not parse is a failure with a reason, not "no workspace":
 * the list may already hold the wanted workspace, and acting on "none" would
 * build a duplicate environment or break the one-workspace-per-repository rule.
 */
type WorkspaceList =
	| { status: "read"; workspaces: readonly HerdrWorkspace[] }
	| { status: "unreadable"; reason: string };

/** One workspace a herdr `workspace list` answer names. */
interface HerdrWorkspace {
	workspaceId: string;
	/** The checkout path herdr records for the workspace's worktree, when it names one. */
	checkoutPath: string | null;
}

function readWorkspaceList(listed: CommandResult): WorkspaceList {
	let data: unknown;
	try {
		data = JSON.parse(listed.stdout);
	} catch {
		return {
			status: "unreadable",
			reason: "herdr workspace list did not return a readable workspace list",
		};
	}
	const workspaces = (data as { result?: { workspaces?: unknown } }).result?.workspaces;
	const read: HerdrWorkspace[] = [];
	for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
		const item = workspace as { workspace_id?: unknown; worktree?: { checkout_path?: unknown } };
		if (typeof item.workspace_id !== "string" || item.workspace_id === "") continue;
		read.push({
			workspaceId: item.workspace_id,
			checkoutPath:
				typeof item.worktree?.checkout_path === "string" ? item.worktree.checkout_path : null,
		});
	}
	return { status: "read", workspaces: read };
}

/** Whether a read list still holds one workspace id. */
function workspaceHeld(workspaces: readonly HerdrWorkspace[], workspaceId: string): boolean {
	return workspaces.some((workspace) => workspace.workspaceId === workspaceId);
}

/**
 * The workspace whose repository matches the checkout, from one read list.
 *
 * A match is the recorded checkout path, compared raw and then through realpath,
 * so a symlinked checkout still matches the workspace herdr already holds for it.
 */
async function workspaceAtCheckout(
	workspaces: readonly HerdrWorkspace[],
	checkout: string,
): Promise<string | null> {
	const checkoutReal = await realPathOf(checkout);
	for (const workspace of workspaces) {
		const recorded = workspace.checkoutPath;
		if (recorded === null) continue;
		if (recorded === checkout || (await realPathOf(recorded)) === checkoutReal)
			return workspace.workspaceId;
	}
	return null;
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

/**
 * The handles one herdr create answer names (issue #204): the workspace it made
 * or opened, the root pane of that workspace, and the tab that holds it. One
 * reader serves every start site, so a start cannot read one answer three ways.
 */
function herdrHandles(result: CommandResult): {
	workspaceId: string | null;
	paneId: string | null;
	tabId: string | null;
} {
	return {
		workspaceId: jsonResultField(result, "workspace", "workspace_id"),
		paneId: jsonResultField(result, "root_pane", "pane_id"),
		tabId: jsonResultField(result, "tab", "tab_id"),
	};
}
