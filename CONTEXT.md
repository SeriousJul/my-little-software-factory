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

**Main view**:
The always-present base surface of the control plane. It holds two list sections (Ticket and Consultation) on the left, and one context-dependent detail pane on the right that shows the detail of the currently selected item.
_Avoid_: dashboard, home, screen, primary view

**Section**:
An independently collapsable list in the Main view. The Ticket section holds the ticket list; the Consultation section holds the Consultation list. Both can be expanded at the same time. A collapsed section shrinks to its header row and its rows are skipped by navigation.
_Avoid_: tab, pane, view, accordion

**Section header**:
The row that names one section of the Main view. A collapsed section is nothing but its header row. The Ticket section's header carries the pipeline counts (open, running, awaiting) and the conditional held count. The Consultation section's header carries that section's attention facts (awaiting response, recovery). A click on the header toggles that section.
_Avoid_: title bar, tab label, accordion toggle

**Response editor**:
The Interaction mode that composes the operator's answer to an awaiting Consultation. Its draft is a Consultation fact, not an Agent turn, until the control plane sends it.
_Avoid_: reply box, chat input

**Action bar**:
The persistent guide to controls that are relevant to the operator's current interaction mode.
The anchor hint holds the row's end cells: the surface's own Close on a utility overlay, and Help wherever a bar can open the Key guide. A frame too narrow for the anchor states one of its whole keys, and never part of one.
The bar states one meaning per key: where two controls claim one key, only the meaning the current facts run appears.
_Avoid_: status bar, shortcut bar, footer

**Message line**:
The temporary surface for progress, warnings, errors, and other operational feedback.
_Avoid_: status line, notification bar

**Message view**:
The on-demand, read-only presentation of a full message that does not fit on the Message line.
_Avoid_: message modal, error popup

**Theme**:
The set of resolved color roles the control plane inherits from the active herdr theme. A theme carries an appearance: light or dark. It is distinct from the no-color presentation, which is an axis that works on top of any theme.
_Avoid_: palette, color scheme, skin

**Control catalogue**:
The complete set of controls owned by the control plane, with each control's keys, Interaction modes, availability, and reason when unavailable.
It is the common reference for the controls the operator can use and the controls described by the Action bar and Key guide.
_Avoid_: key map, binding table

**Key guide**:
The on-demand description of the Control catalogue, with the current Interaction mode and global controls shown first.
It includes controls omitted from the Action bar and the editing controls of Text fields and Draft fields.
_Avoid_: help popup, keybinding popin, shortcut window

**Auto copy**:
The control plane copies a mouse selection to the clipboard when the operator releases the drag, and the ended selection clears its own highlight. A click that does not drag copies nothing.
_Avoid_: copy-on-select, select-to-copy, clipboard selection

**Decision modal**:
The near-fullscreen Interaction mode above an awaiting ticket: the turn log, and the rows the operator confirms: close, goto, and the workflow handoffs.
`e` on a handoff row edits that route's settings before it starts.
_Avoid_: action panel, decision popup

**Live view**:
The near-fullscreen Interaction mode above a `handed-off` or `running` ticket: the live Agent view of the ticket's agent, streamed, and the one row it proposes: Goto.
When the turn settles it becomes the Decision modal; when the agent goes missing it becomes the Missing modal.
_Avoid_: watch, live log, agent stream

**Missing modal**:
The Interaction mode above a ticket whose agent is missing: restart or abandon.
_Avoid_: missing panel, restart popup

**Interaction mode**:
The part of the control plane that currently owns keyboard input, such as the list pane or the detail pane of a section, the override panel, the Consultation launcher, the Agent terminal, the Key guide, the Decision modal, the Live view, the Missing modal, or the Message view.
_Avoid_: context, screen

**Text field**:
A single-line control in which the operator enters or edits a free-text value.
In the override panel, the Model is a Text field when the Agent has no Model list.
The Context window is a Text field that takes digits only, because its value reaches the Agent as one argument.
_Avoid_: input, free-text row

**Draft field**:
A multi-line control in which the operator enters or edits text addressed to an Agent.
The Consultation launcher's initial input and the response editor are Draft fields.
_Avoid_: input, textarea, free-text row

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
One Model list value is one start argument: a value that cannot travel as a single cell is never offered.
_Avoid_: model catalog, model registry

**Type-ahead**:
The Model row's visible, editable substring search for a Model in the Model list.
The search retains unmatched text and states when no Model matches.
_Avoid_: autocomplete, fuzzy filter

**Setting fit check**:
The check one Agent start runs against the resolved Agent type before its first external change: Model, Thinking level, and Context window must each fit the Agent's mapping, and Model must be on its Model list when that list is available.
The Setting fit module owns the rule and one sentence for each unfit cause. An unfit setting fails the start with a readable reason and leaves the Ticket open. A Model list that cannot be fetched skips the Model list part of the check, and the Agent's own rejection stands.
_Avoid_: preflight, validation gate

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
The observation that the stored pane is gone or holds no Agent, past the Startup grace of a started one.
The operator must explicitly recover or close the affected work.
_Avoid_: dead agent, orphaned

**Stale agent observation**:
The condition where the latest Agent poll failed or was unreadable.
The last known Consultation states stay visible and cannot become `missing` from that poll.
_Avoid_: missing Agent, Herdr offline

**Startup grace**:
The window from a handoff during which the agent's idle report is its boot, not a turn end, and a pane herdr has not listed yet is its boot, not a Missing agent (ADR 0021).
The window holds until the agent's session record shows the turn ended: a working report marks the ticket running, but it does not end the window, because herdr's status is not evidence the turn ran (ADR 0017). Past the window, a turn the record does not show settles `no-turn` and holds.
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
It asks Herdr for the ticket's stable Agent name, and takes the name of its work cycle when the ticket's own Leftover environment still holds the stable one.
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
The maximum number of agents in flight. A seat is held by an in-flight ticket whose agent the latest poll listed, by every in-progress handoff, and by a started agent still inside its Startup grace: all of them run or are about to run (ADR 0021).
It gates auto-handoff only; a manual handoff is always allowed.
_Avoid_: concurrency cap, max agents

**Handoff limit**:
The per-ticket cap on started handoffs that stops the close-and-rehandoff loop.
It gates auto-handoff only; a manual handoff may pass it.
_Avoid_: turn counter, dispatch budget

**Dispatch pause**:
The condition in which Auto-handoff mode starts no agent by itself, because the newest Held turn settled `failed` and no turn has settled `completed` since it.
It is derived from the completion traces on every cycle, never stored, so it survives a restart and cannot drift from the fact it describes. It ends at the next `completed` settle, or when the operator decides the Held turn that started it. It never blocks a manual Handoff, and it holds only the automatic origins: the open handoff, the workflow route, and the restart. The route block applies in manual mode too, because auto-close types route there, exactly like the Parallel limit.
_Avoid_: circuit breaker, cooldown, backoff

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

**Turn end cause**:
Why an agent's settled turn ended: `completed`, `failed`, `aborted`, `truncated`, `quota`, `no-turn`, or `unknown`, with the agent's own text as its detail.
`quota` is the cause of a turn the provider refused because the model's usage limit or quota was reached, read from the agent's own error text.
_Avoid_: rate limit, usage limit, throttle

**Model tier**:
A named, ordered group of models of one agent kind.
A work configured on a tier runs on one of its models and, on a `quota` turn end in Auto-handoff mode, falls back to the next model of the same tier.
It never falls to a different tier: a work configured on one tier stays on that tier.
_Avoid_: model chain, model pool, fallback list, Model list
`no-turn` is the cause of a settle whose session record is readable and holds no turn: the turn never started. `unknown` is the fail-open cause of a record that cannot be read. It is the agent's fact, not herdr's status, and it says nothing about whether the work itself succeeded.
_Avoid_: done, exit reason, stop reason, agent status

**Held turn**:
A settled turn whose Turn end cause is `failed`, `aborted`, `truncated`, or `no-turn`, and that no decision has landed on.
No automatic decision runs on it: the ticket rests in `awaiting` until the operator decides. A turn that settled `completed` or `unknown` is never held; `unknown` fails open, so it auto-decides as it normally would.
_Avoid_: stalled turn, blocked turn, failed turn

**Completion trace**:
The durable record of a settled agent turn: task type, agent, model, thinking level, context window, completion time, turn log, last message, turn end cause, and decision.
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
It blocks the start unless the checkout holds a safety confirmation for the current set of conflicting identities: an Agent that no Consultation or ticket owns takes the herdr Agent pane id, and an Agent owned by an open Consultation or a running ticket takes that Consultation's or ticket's identity.
The operator confirms once per conflict set: the confirmation belongs to the checkout, is durable, and stores the confirmed set with its time. A later launch into the checkout asks again only when a conflicting identity appears that is not in the confirmed set. A shrinking set never re-asks, and each checkout keeps its own set, so one checkout's confirmation never silences another checkout's question.
_Avoid_: dirty checkout, parallel limit

**Leftover environment**:
The workspace, tab, or Agent of a ticket's closed Handoff that Herdr still holds after its Close cleanup.
It is a durable fact on the ticket, visible in its row and in its detail.
It never blocks a Handoff of that ticket.
_Avoid_: orphaned agent, zombie workspace, stale checkout

**Clear**:
The one operator action that retries the Close cleanup of a ticket's Leftover environment.
A forced removal is its own explicit choice within the action, because it discards a dirty checkout and stops the Agents in the workspace.
_Avoid_: force delete, cleanup retry

**Auto copy**:
The control plane copies a mouse selection to the clipboard when the operator releases the drag, and the ended selection clears its own highlight. A click that does not drag copies nothing.
_Avoid_: copy-on-select, clipboard mode

**Override**:
A one-shot change to the settings of a single Handoff, made in the override panel before the Handoff starts.
The panel edits an open Ticket's next Handoff and a Workflow Handoff alike: `e` on a decision row opens the panel on the choice its edge resolved.
It applies to that Handoff only and never becomes a new default; a later Workflow Handoff resolves its own profile instead of inheriting one.
A Restart repeats the interrupted Handoff's choices as recovery.
The settings are: Agent type, Environment kind, Task type, Model, Thinking level, and Context window.
_Avoid_: custom setting, tweak

**Config file**:
The TOML file at `~/.config/my-little-software-factory/config.toml` that carries the handoff defaults (agent, environment, task type, model), the auto-handoff default, the limits, ticket sources, task rules, agent types, task types, workflows, state file, and repository mappings.
A missing file is seeded from the Default configuration on first run. An invalid file stops the control plane with a readable error before the UI starts.
_Avoid_: settings file, preferences

**Default configuration**:
The TOML the package ships, used to seed the Config file on first run.
It carries the workflow template (the task types and task rules) and one Consultation type, and it is meant to be extended by the operator.
_Avoid_: built-in defaults, factory settings

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

**Documentation site**:
The static site that GitHub Pages publishes from the `docs/` folder.
It shows the published subset (the ADRs, the standards, and the guides) and keeps the agent instruction, verification, and research folders out of the build.
_Avoid_: website, docs site, blog
