---
title: Handoffs
description: "How a ticket becomes a running agent: the setting chains, model discovery, and repository resolution."
---

# Handoffs

Enter on an open ticket starts a handoff with the settings its Task profile
resolves. The override panel changes them for that one handoff only; it never
becomes a new default. A workflow handoff resolves the target task type's own
profile and does not inherit any value from the previous handoff; `e` on its
decision row edits the resolved settings first. A Restart repeats the
interrupted handoff's agent, Model, Thinking level, and context window,
because that handoff is the decision being resumed.

Each setting resolves on its own chain, closest to the handoff first (ADR
0009):

- Agent: the operator's override, then a Transition's agent pin, then the Task
  profile's `agent`, then `default-agent`.
- Model: the operator's override, then the Task profile's `model`, then
  `default-model`, then the agent's own default.
- Thinking: the operator's override, then the Task profile's `thinking`, then
  the agent's own default.
- Context window: the operator's override, then the Task profile's
  `context-window`, then the agent's own default. It has no top-level
  default, because one count cannot fit every model.
- Environment: the operator's override, then a Transition's environment pin, then
  `default-environment`.

A resolved value never disappears on its way to the agent. A handoff fails
with a readable reason before anything starts, and the ticket stays where it
was, when the resolved agent maps no template for a Model, a Thinking level,
or a context window the chain resolved; when the agent lists the levels it
offers and the resolved level is not one of them; or when a context window is
not a whole count of tokens. The same rule ahead of the same start is what a
Consultation and a Restart run, so no start path keeps its own copy of it. One
rule and one sentence per unfit cause belong to the Setting fit module
(`src/setting-fit.ts`), and the config file's field checks, the startup Model
check, the override panel's warning rows, the handoff, and the Consultation
start all read it. So a model written for one agent never runs a different one
quietly, and a Transition that reroutes a handoff onto a narrower agent is seen as a
failure instead of being absorbed as a default. One behavior is
stricter than before: a setting the resolved agent maps no template for used
to be dropped quietly, and the agent started on its own default. It now fails
the handoff with a readable reason, so a value the config or the panel names
is never lost.

Before an agent start, the control plane also checks that the settings fit
the resolved agent (ADR 0010): the model must be one the agent's own CLI
reports. An unfit model fails the handoff with a readable reason before it
changes anything outside the control plane, and the ticket stays open. A
model list that cannot be fetched skips the model check, and the agent's own
rejection stands.

- The agent runs through herdr (ADR 0002): a live worktree handoff creates a
	herdr workspace at the checkout with a fresh tab, and a worktree handoff
	lets herdr create a git worktree first. Every create states `--no-focus`,
	so building the environment never takes the operator's view (ADR 0061).
- A worktree handoff branches `factory/<ticket id>-<title slug>` from the
	checkout's current `HEAD`. An existing branch is reused: the worktree
	that holds it is reopened, and a branch no worktree holds is checked out
	into a fresh worktree - the ticket's own worktree, when it still stands
	on disk left on another branch by the agent that last worked the ticket,
	is reopened by its path, on the branch it holds, instead (ADR 0046).
	A worktree handoff that fails before the agent starts removes the
	worktree and the branch, so a retry can run.
	When herdr's own path for the branch stands on disk with no worktree in
	it - what a build cache leaves behind after a checkout is removed - the
	plane moves that directory aside to `<path>.leftover`, creates the
	worktree again, and names both paths on the Message line. It never
	deletes one: untracked work and a build cache look the same from outside
	(ADR 0062). A path git still records, or one that holds a `.git` entry,
	is left exactly where it is.
- The agent starts under the title slug as its herdr name, with the settings
	the agent type maps (model, thinking level, context window), and receives
	the prompt rendered from the task type's template with the ticket's
	repository, title, and description. When the ticket's own leftover agent
	still holds that name, the handoff starts under the same slug with its
	work cycle, as `persist-source-facts-c2`, and says so on the Message line
	(ADR 0012). A name held by any other agent fails the handoff, with the
	pane and workspace that hold it in the reason.

	A route's handoff - the one a Transition decision starts on another
	ticket, the pull request behind the issue - owns the settled ticket's
	name too (ADR 0012, amendment): an issue and its fixing pull request
	share a title, so herdr cuts both to one stable name, and the issue's
	agent holds it while the route asks. The handoff asks the same cycle
	name and starts beside the settled ticket's agent instead of failing
	the route on a name its own predecessor still holds.
- The ticket moves to `handed-off` when the agent starts, even if the prompt
	later fails. The agent is running and can be prompted by hand. A failure
	before the start (a missing herdr, a missing checkout, a clone target the
	filesystem refuses, a model the agent does not offer) leaves the ticket
	open and shows the reason on the Message line. The app never crashes on a
	handoff failure.

## Model discovery

The agent runtime, not the config file, owns the set of models it can run.
For an agent kind whose CLI reports one, the control plane runs that command
(`pi --list-models` for the `pi` kind) and reads the models the runtime
reports as available, in the `provider/model` form its `--model` option takes
(ADR 0010). The list serves three places:

- Startup: a config that names a model its agent does not offer stops the
	boot with a readable error, one line per value. A list that cannot be
	fetched only warns, so one agent kind that cannot answer does not block the
	control plane.
- The override panel: the Model row offers the selected agent's list.
- The handoff: the setting fit check above, run before the first external
	change.

Every use queries the agent again. There is no cache: the operator can change
a provider's auth while the control plane runs, and a stale list would hide a
model the agent has just gained or offer one it has just lost. A kind whose
CLI reports no list keeps the free-text Model row, and its model values are
not checked at startup.

The query carries its own short budget, not the handoff's ten minutes. It runs
before the first frame at boot, on every override panel open and agent switch,
and inside the observation cycle ahead of a handoff, so an agent CLI that starts
and never answers has to fail into the no-list path in seconds. A refused list
is the designed degrade; a hang is not.

One Model list value is one argument cell. The start command passes the chosen
model to the agent as a single argument, so the parser refuses a row whose
value carries whitespace, and the argument builder substitutes a value inside
its template token instead of splitting the result: a model name can never
become an argument plus a stray positional the agent reads as its model.

## Repository resolution

The control plane finds the ticket's repository in this order:

1. An explicit mapping in the config: `[repos] "github.com/owner/name" = "/path"`.
   A mapped path must hold a git checkout of exactly that repository.
   The remote is matched by repository, not by URL shape: https and ssh,
   the scp-style git@github.com:owner/name, a port, a trailing slash, a
   .git suffix, and other casing all count.
   A mismatch is a hard failure; the control plane never uses the wrong tree.
2. The convention `~/src/<repository name>`.

When the convention path holds a different repository, the control plane
clones the ticket's repository to a sibling path (for example
`~/src/billing_1`), hands off there, warns on the Message line, and hands the
mapping back to be written to the config file, so the next handoff resolves
it explicitly. The mapping is handed back even when a later step of the
handoff fails, so the clone is not lost. The mappings live in the
[configuration](../configuration/index.md) under `[repos]`.
