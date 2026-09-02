# Control Plane

The terminal application that observes the software factory and issues work.
It monitors tickets, hands them off to agents, and watches for their completion.

## Language

**Factory**:
The whole software development lifecycle, from ticket to shipped work.
_Avoid_: SDLC, pipeline

**Control plane**:
This TUI.
It observes the factory and issues work to agents.
_Avoid_: dashboard, UI

**Action bar**:
The persistent guide to controls that are relevant to the operator's current interaction mode.
_Avoid_: status bar, shortcut bar, footer

**Message line**:
The temporary surface for progress, warnings, errors, and other operational feedback.
_Avoid_: status line, notification bar

**Message view**:
The on-demand, read-only presentation of a full message that does not fit on the Message line.
_Avoid_: message modal, error popup

**Key guide**:
The on-demand catalog of all controls, with the current interaction mode and global controls shown first.
It includes controls that the action bar does not show.
_Avoid_: help popup, keybinding popin, shortcut window

**Decision modal**:
The near-fullscreen Interaction mode above an awaiting ticket: the turn log, and the rows the operator confirms: close, goto, and the workflow handoffs.
`e` on a handoff row edits that route's settings before it starts.
_Avoid_: action panel, decision popup

**Missing modal**:
The Interaction mode above a ticket whose agent is missing: restart or abandon.
_Avoid_: missing panel, restart popup

**Interaction mode**:
The part of the control plane that currently owns keyboard input, such as the ticket list, ticket detail, override panel, Consultation launcher, Consultation view, Agent terminal, Key guide, Decision modal, Missing modal, or Message view.
_Avoid_: context, screen

**Text field**:
A single-line control in which the operator enters or edits a free-text value.
In the override panel, the Model is a Text field when the Agent has no Model list.
The Context window is a Text field that takes digits only, because its value reaches the Agent as one argument.
_Avoid_: input, free-text row

**Ticket**:
An actionable unit of work from an external ticket source, carrying the repository it belongs to.
An issue or pull request is a source fact, not a different factory concept.
_Avoid_: issue, task

**Ticket source**:
A configured feed from an external system from which the control plane gets tickets.
GitHub issues and GitHub pull requests are separate ticket sources.
_Avoid_: task source, ticket provider

**Source kind**:
The external form of a ticket, such as a GitHub issue or a GitHub pull request.
_Avoid_: ticket type

**Source fact**:
Information owned by an external ticket source, such as its title, source state, labels, or URL.
A refresh can change source facts, but it cannot reset factory state.
_Avoid_: ticket state, factory fact

**Ticket identity**:
The stable external identity of a ticket, independent of the configured ticket source name.
It prevents one external item from becoming multiple tickets when sources overlap or are renamed.
_Avoid_: local id, source name

**Source membership**:
The fact that a ticket currently matches a configured ticket source.
One ticket can have more than one source membership without becoming duplicate work.
_Avoid_: source copy, duplicate ticket

**Stale source**:
A ticket source whose latest refresh failed.
Its last tickets stay visible, but they cannot be handed off until the source refreshes successfully.
_Avoid_: offline source

**Work cycle**:
One passage of a ticket from `open` through the factory to cycle close.
A cycle can hold several handoffs. Close or abandon ends the cycle and returns the ticket to `open` with an incremented cycle number.
_Avoid_: ticket generation, run

**Ticket state**:
The position of a ticket in the factory: `open`, `handed-off`, `running`, `awaiting`.
The external source's own state is a separate source fact, not a ticket state.
_Avoid_: status, phase

**Awaiting**:
The ticket state where the agent has settled its turn, the last message is captured, and no completion decision is made yet.
_Avoid_: finished, pending review

**Agent**:
An autonomous program that executes a Ticket or leads a Consultation.
The control plane is agent-agnostic and assumes no specific agent runtime (pi, codex, claude code, or others).
_Avoid_: bot, worker

**Agent type**:
The declarative description of a class of agents: its name, how to start it, how its settings (model, thinking level, context window) map to the agent's own parameters, its Model list, which thinking levels it offers, and how to read the settled turn's log.
An Agent is a running instance of an Agent type.
_Avoid_: agent definition, plugin, driver

**Thinking level**:
A standard level of agent reasoning effort: off, minimal, low, medium, high, xhigh, or max.
An Agent type declares the levels it supports and maps a chosen level to its own parameter.
_Avoid_: reasoning effort, effort

**Model list**:
The models an Agent runtime reports as available.
The agent runtime, not the config file, owns this set, and a model outside it is not a valid choice for that agent.
_Avoid_: model catalog, model registry

**Consultation**:
An operator-started interactive exchange with an Agent in a Repository that is independent of a Ticket and stays open until the operator closes it.
_Avoid_: agent session, quick task

**Consultation type**:
A configured kind of Consultation that selects an Agent type and default Environment, then combines fixed opening instructions with the operator's initial input.
_Avoid_: quick template, session template

**Consultation state**:
The position of a Consultation: `opening`, `working`, `awaiting-response`, `missing`, `failed`, `closing`, or `closed`.
_Avoid_: status, Agent state

**Awaiting response**:
The Consultation state where the Agent waits for operator input and the operator has not responded or closed the Consultation.
The Agent waits when it has settled its turn, or when it shows an approval or question UI (Blocked).
_Avoid_: blocked, idle, done

**Response draft**:
Operator input saved for an `awaiting-response` Consultation but not yet accepted by its Agent.
_Avoid_: queued response, pending prompt

**Consultation launcher**:
The Interaction mode that collects a Consultation type, Repository, and initial operator input before opening a Consultation.
_Avoid_: new consultation modal, quick prompt

**Consultation view**:
The Interaction mode that shows Consultations, their Agent output or Captured history, and takes the operator input that continues them.
_Avoid_: session list, consultation panel

**Replacement Consultation**:
A new Consultation opened with recovery context and an explicit link to a missing or failed Consultation.
It never closes or hides the Consultation it replaces.
_Avoid_: retry, resumed Consultation

**Agent view**:
The scrollable presentation of an Agent's current and recent terminal output inside the control plane.
It does not promise a normalized conversation transcript.
_Avoid_: transcript, chat history

**Captured history**:
The saved operator inputs and settled or partial Agent output shown when live Agent output is no longer available.
_Avoid_: live output, exact transcript

**Agent terminal**:
The Interaction mode that shows an Agent's terminal and forwards operator input to it while reserving a configurable, keyboard-layout-independent control to return keyboard ownership to the control plane.
_Avoid_: terminal handoff, attach mode

**Blocked**:
The observation that an Agent shows an approval or question UI.
A Ticket stays `running`; a Consultation moves to `awaiting-response`.
_Avoid_: stalled, waiting

**Missing agent**:
The observation that the stored pane is gone or holds no Agent.
The operator must explicitly recover or close the affected work.
_Avoid_: dead agent, orphaned

**Stale agent observation**:
The condition where the latest Agent poll failed or was unreadable.
The last known Consultation states stay visible and cannot become `missing` from that poll.
_Avoid_: missing Agent, Herdr offline

**Startup grace**:
The window from a handoff during which the agent's idle report is its boot, not a turn end.
A ticket that has never shown working waits the window out before an idle agent settles it.
_Avoid_: boot delay, settle delay

**Reclaim**:
The observation that an Agent herdr reports working or blocked in the pane of a handoff whose work cycle already closed.
The poll records it as a handoff of the ticket's current cycle and runs the ticket again, so the list never reads `open` over live work.
_Avoid_: orphaned agent, re-handoff, resume

**Restart**:
A recovery Handoff after a Missing agent.
It repeats the interrupted Handoff's choices and counts toward the Handoff limit.
_Avoid_: retry, Workflow Handoff

**Stale Agent output**:
The condition where the latest read of an Agent terminal failed.
The last Agent view stays visible while lifecycle observation continues.
_Avoid_: stale Agent observation, missing output

**Recovery required**:
The condition where a Consultation cannot continue or close without an explicit operator decision, such as after a missing Agent or interrupted resource change.
It stays separate from `awaiting-response`, where the Agent needs ordinary input.
_Avoid_: awaiting response, blocked

**Force-close**:
Closing a Consultation record after resource cleanup cannot be confirmed.
It records the resources that might remain and never removes a worktree or branch.
_Avoid_: abandon, force delete

**Handoff**:
Assigning a ticket to an agent type and an environment with a task type, and starting the agent's execution.
_Avoid_: assign, dispatch, launch

**Handoff attempt**:
The durable record created before a handoff makes its first external change.
An unresolved attempt prevents another handoff of the same ticket after a crash.
_Avoid_: pending ticket, handoff state

**Auto-handoff mode**:
The session-level mode in which the control plane hands off eligible open tickets by itself and decides their settled turns without the operator, within the configured limits.
The config file carries the startup default; the UI toggle is session-only.
_Avoid_: auto dispatch, dispatch mode

**Parallel limit**:
The maximum number of agents in flight, counted as tickets in `handed-off` or `running` state whose agent is alive.
It gates auto-handoff only; a manual handoff is always allowed.
_Avoid_: concurrency cap, max agents

**Handoff limit**:
The per-ticket cap on started handoffs that stops the close-and-rehandoff loop.
It gates auto-handoff only; a manual handoff may pass it.
_Avoid_: turn counter, dispatch budget

**Task type**:
A one-word category of work (for example "implement", "fix", "review", or "rework") that selects the prompt template of a handoff and the Task profile its handoffs start on.
_Avoid_: prompt, template

**Task profile**:
The agent type, model, thinking level, and context window a task type starts its handoffs with.
It is a start value: the override panel prefills it, a workflow edge's agent pin can replace its agent for one handoff, and an operator override beats all of it.
A setting the Agent a Handoff lands on cannot take fails that Handoff with a readable reason, so a reroute that leaves a setting behind is seen, not absorbed.
_Avoid_: run settings, task settings

**Suggested task type**:
The Task type proposed for a Ticket's next Handoff by the first matching Task rule, or by the configured default when no rule matches.
An Override can replace it for one Handoff.
_Avoid_: detected task type, inferred task type

**Task rule**:
A configured condition that selects the suggested task type for a ticket before handoff.
Rules are ordered, and the first matching rule wins; an override can replace the suggestion.
_Avoid_: task mapping, task route

**Workflow**:
A configured routing from one completed task type to the next.
An edge can pin the agent type and environment of the next handoff.
_Avoid_: pipeline, state machine

**Auto-close**:
A property of a task type. For its completions the control plane decides without the operator even in manual mode: exactly one outgoing edge and a free parallel slot hand off with that task, a full parallel slot leaves the ticket awaiting, any other edge count closes the cycle, and a route at the ticket's handoff limit degrades to close.
_Avoid_: auto complete, auto done

**Completion decision**:
The choice made on a settled agent turn: close the cycle, go to the agent, or hand off with a workflow task.
_Avoid_: action, verdict

**Turn log**:
The agent's messages of one settled turn, in order: the agent's text, and one short note per tool call.
The control plane builds it from the agent's session record when herdr reports one, or from the terminal capture when herdr does not.
_Avoid_: agent log, transcript, terminal capture

**Completion trace**:
The durable record of a settled agent turn: task type, agent, model, thinking level, context window, completion time, turn log, last message, and decision.
A cycle holds one trace per settled turn.
_Avoid_: console dump, session file

**Context window**:
A whole count of context tokens an Agent starts a Handoff or a Consultation with.
It is a setting of a Task profile, a Consultation type, and an Override, and each Agent type maps it with its own command-line template.
There is no configured default: a value left out stays with the Agent, because one count cannot fit every model.
A count the resolved Agent maps no template for, or a value that is no count at all, fails the Handoff with a readable reason instead of starting the Agent without it.
_Avoid_: token limit, budget, autocompact

**Environment**:
The place where an Agent executes a Ticket or leads a Consultation.
Kinds: a live worktree (an existing checkout), a worktree (a fresh git worktree), and a container (a future kind, not yet built).
_Avoid_: sandbox, isolation

**Live checkout conflict**:
The condition where an Agent would start in a live checkout already used by another active Agent.
It blocks the start unless the operator gives a one-shot safety confirmation.
_Avoid_: dirty checkout, parallel limit

**Override**:
A one-shot change to the settings of a single Handoff, made in the override panel before the Handoff starts.
The panel edits an open Ticket's next Handoff and a Workflow Handoff alike: `e` on a decision row opens the panel on the choice its edge resolved.
It applies to that Handoff only and never becomes a new default; a later Workflow Handoff resolves its own profile instead of inheriting one.
A Restart repeats the interrupted Handoff's choices as recovery.
The settings are: Agent type, Environment kind, Task type, Model, Thinking level, and Context window.
_Avoid_: custom setting, tweak

**Config file**:
The TOML file at `~/.config/factory/config.toml` that carries the handoff defaults (agent, environment, task type, model), the auto-handoff default, the limits, ticket sources, task rules, agent types, task types, workflows, state file, and repository mappings.
A missing file yields the shipped defaults. An invalid file stops the control plane with a readable error before the UI starts.
_Avoid_: settings file, preferences

**Repository identity**:
The stable, host-qualified identity of a source repository, such as `github.com/owner/name`.
It stays distinct from the repository's display name, clone URL, and local checkout path.
_Avoid_: repository name, clone URL

**Repository mapping**:
The config entry that pins a repository identity to an explicit checkout path.
It is the first place the control plane looks for a repository, and the one section the control plane writes back.
_Avoid_: repo config, alias

**Convention checkout**:
The default home of a repository: `~/src/<repository name>`.
The second place the control plane looks when no repository mapping exists.
_Avoid_: default path, home

**Sibling clone**:
The clone of a repository to a sibling path (for example `~/src/billing_1`) that the control plane makes when the convention checkout holds a different repository.
The handoff runs at the sibling, the control plane warns, and the repository mapping records the path.
_Avoid_: fallback clone, mirror

**Command runner**:
The single egress for external commands: the control plane runs every herdr, git, GitHub CLI, and agent model list command through it.
The automated tests inject a fake runner that records safe command facts, so no test touches a real herdr session, repository, ticket source, or agent runtime.
_Avoid_: executor, spawner
