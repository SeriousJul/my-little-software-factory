# Control Plane

The terminal application that observes the software factory and issues work.
It monitors tickets and hands them off to agents.

## Language

**Factory**:
The whole software development lifecycle, from ticket to shipped work.
_Avoid_: SDLC, pipeline

**Control plane**:
This TUI.
It observes the factory and issues work to agents.
_Avoid_: dashboard, UI

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
One passage of a ticket from `open` through the factory to `done`.
A done ticket that leaves all sources and later returns starts a new work cycle.
_Avoid_: ticket generation, run

**Ticket state**:
The position of a ticket in the factory: `open`, `handed-off`, `running`, `done`.
The external source's own state is a separate source fact, not a ticket state.
_Avoid_: status, phase

**Agent**:
An autonomous program that executes a ticket.
The control plane is agent-agnostic and assumes no specific agent runtime (pi, codex, claude code, or others).
_Avoid_: bot, worker

**Agent type**:
The declarative description of a class of agents: its name, how to start it, and how its settings (model, thinking level) map to the agent's own parameters.
An agent is a running instance of an agent type.
_Avoid_: agent definition, plugin, driver

**Handoff**:
Assigning a ticket to an agent type and an environment with a task type, and starting the agent's execution.
_Avoid_: assign, dispatch, launch

**Handoff attempt**:
The durable record created before a handoff makes its first external change.
An unresolved attempt prevents another handoff of the same ticket after a crash.
_Avoid_: pending ticket, handoff state

**Task type**:
A one-word category of work (for example "implement", "fix", "review", or "rework") that selects the prompt template of a handoff.
_Avoid_: prompt, template

**Task rule**:
A configured condition that selects the suggested task type for a ticket before handoff.
Rules are ordered, and the first matching rule wins; an override can replace the suggestion.
_Avoid_: task mapping, task route

**Environment**:
The place where an agent runs a ticket.
Kinds: a live worktree (the existing checkout of the ticket's repository), a worktree (a fresh git worktree created for the ticket), and a container (a future kind, not yet built).
_Avoid_: sandbox, isolation

**Override**:
A one-shot change to the settings of a single handoff, made in the override panel before the handoff starts.
It applies to that handoff only and never becomes a new default.
The settings are: agent type, environment kind, task type, model, and thinking level.
_Avoid_: custom setting, tweak

**Config file**:
The TOML file at `~/.config/factory/config.toml` that carries the handoff defaults, ticket sources, task rules, agent types, task types, state file, and repository mappings.
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
The single egress for external commands: the control plane runs every herdr, git, and GitHub CLI command through it.
The automated tests inject a fake runner that records safe command facts, so no test touches a real herdr session, repository, or ticket source.
_Avoid_: executor, spawner
