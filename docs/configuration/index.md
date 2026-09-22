---
title: Configuration
description: The complete config example, the key reference, the notes, and the shipped defaults.
---

# Configuration

The config lives at `~/.config/my-little-software-factory/config.toml`, or
at the path the `--config` flag names: `factory [--config <path>]`. A
missing file is seeded from the Default configuration the package ships,
with a note on the start, so a first run leaves a working file at the path.
A file that does not parse or does not validate stops the control plane
with a readable error before the UI starts: a present file must carry every
required key, and a key the control plane does not read is an error, so a
typo surfaces at startup, not at handoff time.

A present file is what the control plane runs on; there is no in-code config
behind it. An optional key the file omits takes the per-key default the key
reference names, and that default is empty for lists and tables. The key
reference marks each key required or optional.

## Complete example

The example below is one valid config. It sets every key the control plane
reads, optional keys included, so the example and the key reference agree
line for line. The values are illustrative.

```toml
# --- Handoff defaults ----------------------------------------------

# The agent type a handoff starts with when neither its Task profile names
# one nor a transition pins one. It must name an [agents.*] table.
default-agent = "pi"

# The model a handoff starts with when its Task profile names none. Free
# text: it is passed through the resolved agent's model template, so a
# handoff whose resolved agent maps no model fails with a readable reason.
# It is checked at startup through every task profile that resolves it.
default-model = "anthropic/claude-opus-4-6"

# The environment a handoff starts with when a transition does not
# pin one. One of "live-worktree" or "worktree".
default-environment = "worktree"

# The task type of a handoff when no state matches.
# It must name a [task-types.*] table.
default-task-type = "implement"

# The SQLite state file. A relative path resolves against the directory
# of this config file. Omitted:
# $XDG_STATE_HOME/my-little-software-factory/state.sqlite, else
# ~/.local/state/my-little-software-factory/state.sqlite.
state-file = "factory.sqlite"

# --- Limits ----------------------------------------------------------

# The in-flight works the control plane keeps: a ticket Handoff and a
# Consultation alike. 0 means unlimited.
max-parallel-agents = 2

# Seconds between herdr polls.
agent-poll-interval-seconds = 5

# Lines of the agent last message captured when a turn settles.
completion-message-lines = 200

# Handoffs per ticket after which auto-handoff stops dispatching it.
max-handoffs-per-ticket = 10

# --- UI ----------------------------------------------------------------

# Ring the terminal bell when a Consultation settles.
attention-bell = true

# Exit Agent interaction mode. A function key f1 to f24, or ctrl plus
# one letter, for example "f12" or "ctrl+e".
interaction-exit-key = "f12"

# The detail-pane scroll.
[scroll]
# Rows moved by one key step or one slow wheel event.
speed = 1
# Wheel-burst acceleration strength. 0 keeps wheel movement linear.
acceleration = 0.8
# Rows moved by one accelerated wheel event. At least speed.
maximum-speed = 6

# --- Priority -------------------------------------------------------------

# An ordered list of labels that ranks tickets: the first entry is the
# highest rank. A ticket that carries one of these labels ranks by it. The
# operator bumps a rank from the ticket detail, and a bump beats the label.
# An "off" bump sets the ticket unranked. Omitted: tickets are not ranked
# and the list keeps its previous order.
[priority]
labels = ["critical", "high", "low"]

# --- Logging --------------------------------------------------------------

# The plane's own file log. The TUI owns the terminal, so the run's record
# lives in a file the operator reads later. Omitted: the run writes no log.
[logging]
# The level that passes the filter: off, error, warn, info, or debug.
level = "info"
# The log file. A relative path resolves against the directory of this
# config file. Omitted: the log lands next to the state file.
file = "factory.log"
# Rotate the current file at this size, in mebibytes.
max-size-mib = 10
# Rotated files kept, from factory.log.1 up to factory.log.5.
keep = 5

# --- Agent types ---------------------------------------------------------

# kind is the herdr agent kind. model, thinking, and context-window are
# command-line templates for the agent start and must contain {value}.
# thinking-values lists the levels this agent supports, in the order the
# override panel offers them. An agent that maps thinking must declare a
# non-empty subset of the standard set: off, minimal, low, medium, high,
# xhigh, max. Thinking is never free text (ADR 0010).
# A handoff or a Consultation can pass one of those settings only when the
# agent defines its template; a setting the agent cannot take fails the
# handoff with a readable reason (ADR 0009).
# The control plane reads the model list of a kind that can report one from
# the agent's own CLI; the config declares no models.
[agents.pi]
kind = "pi"
model = "--model {value}"
thinking = "--thinking {value}"
thinking-values = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

[agents.codex]
kind = "codex"
model = "--model {value}"
thinking = "-c model_reasoning_effort={value}"
thinking-values = ["minimal", "low", "medium", "high"]
context-window = "-c model_context_window={value}"

[agents.claude]
kind = "claude"
model = "--model {value}"
thinking = "--effort {value}"
thinking-values = ["low", "medium", "high", "xhigh", "max"]
context-window = "--autocompact {value}"

# --- Task types -----------------------------------------------------------

# template is required. Placeholders: {repository}, {title},
# {description}, {source-kind}, {external-key}, {source-url}, {labels},
# {previous-message}. Any other brace pair is a startup error.
# agent, model, thinking, and context-window are the Task profile: the
# settings this task type's handoffs start on. agent must name an
# [agents.*] table, model is free text the profile agent's model template
# renders, thinking must be one of that agent's thinking-values, and
# context-window must be a whole count of tokens in digits. An omitted agent
# leaves the agent to default-agent, an omitted model leaves the model to
# default-model, and an omitted level or window leaves it to the agent. The
# override panel prefills all four, and each one applies to its own setting
# only.
# A [task-types.X.transition] table fires when a turn of this type
# completes: it writes the label facts on the ticket and its linked pull
# request, and the machine re-derives every position from the written labels
# (ADR 0027). The agents never write workflow labels.
[task-types.implement]
agent = "pi"
model = "anthropic/claude-sonnet-4-5"
template = '''
Implement the following {source-kind}.

Repository: {repository}

{external-key}: {title}

URL: {source-url}

Labels: {labels}

Description:
{description}'''
thinking = "medium"
[task-types.implement.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.review]
template = '''
Review pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
agent = "codex"
context-window = 272000
[task-types.review.transition]
ticket-facts = []
pull-request-facts = []
score-threshold = 90
[[task-types.review.transition.branches]]
when = "score-above-threshold"
pull-request-facts = ["ready-to-ship"]
auto-advance = true
agent = "codex"
environment = "worktree"
[[task-types.review.transition.branches]]
when = "score-below-threshold"
pull-request-facts = ["needs-work"]
ticket-facts = ["blocked"]

[task-types.rework]
template = '''
Rework pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
[task-types.rework.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]
agent = "pi"
environment = "worktree"

[task-types.merge]
template = '''
Merge pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
thinking = "low"
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []
auto-advance = true

# --- Consultation types ----------------------------------------------------

# agent names an [agents.*] table. environment is one of "live-worktree"
# or "worktree". template contains {input} exactly once and no other
# placeholder. model, thinking, and context-window map through the agent's
# templates, so the agent must define each one this table sets.
[consultation-types.grill-with-docs]
agent = "codex"
environment = "live-worktree"
template = "/skill:grill-with-docs {input}"
model = "gpt-5.6-codex"
thinking = "medium"
context-window = 272000

# --- The workflow machine -----------------------------------------------------

# The states a ticket can sit in. name is one word. task-type names a
# [task-types.*] table: the task the plane suggests for a ticket on the
# state. The match sets the conditions that put a ticket on the state; the
# set conditions must all hold. Order decides: the first matching state
# wins. A state with no task-type is a parking state: the plane suggests
# nothing for it.
[[states]]
name = "needs-work"
task-type = "rework"
[states.match]
source-name = "my-app-pull-requests"
source-kind = "github-pull-request"
repository = "github.com/seriousjul/my-app"
labels-all = ["factory"]
labels-any = ["needs-work"]
labels-none = ["do-not-process"]

[[states]]
name = "ready-for-review"
task-type = "review"
[states.match]
source-kind = "github-pull-request"
labels-any = ["ready-for-review"]

[[states]]
name = "ready-to-ship"
task-type = "merge"
[states.match]
source-kind = "github-pull-request"
labels-any = ["ready-to-ship"]

# The park: a pull request no state above placed. No task-type, so the plane
# suggests nothing for it, and a label write is the only engine that moves it.
[[states]]
name = "pull-request-unlabeled"
[states.match]
source-kind = "github-pull-request"
labels-none = ["needs-work", "ready-for-review", "ready-to-ship"]

# --- Repository mappings --------------------------------------------------------

# Repository identity to checkout path. The identity is
# <host>/<owner>/<name> in lowercase. A mapped path must hold a git
# checkout of exactly that repository. A sibling clone writes its
# mapping back here.
[repos]
"github.com/seriousjul/my-app" = "/home/seriousjul/src/my-app"

# --- Ticket sources ----------------------------------------------------------------

# name must be unique. kind is "github-issues" or
# "github-pull-requests", or one of the security feed kinds
# "github-security-advisories", "github-dependabot-alerts", and
# "github-secret-scanning-alerts". filter is a GitHub search applied to the
# list; the security feed kinds take no filter. auth takes exactly one of
# token, token-env, or account. Omitted auth uses gh's current
# authentication.
[[sources]]
name = "my-app-issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = ["SeriousJul/my-app"]
host = "github.com"
filter = "label:factory"
[sources.auth]
# token = "ghp_a-literal-token"
# account = "my-account"
token-env = "GITHUB_TOKEN"

[[sources]]
name = "my-app-pull-requests"
kind = "github-pull-requests"
refresh-interval-seconds = 30
repositories = ["SeriousJul/my-app"]
host = "github.com"
filter = "is:open label:factory"
[sources.auth]
account = "my-account"


[[sources]]
name = "my-app-dependabot-alerts"
kind = "github-dependabot-alerts"
refresh-interval-seconds = 300
repositories = ["SeriousJul/my-app"]
host = "github.com"
```

## Key reference

**Top level.**

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `default-agent` | yes | - | The agent type a handoff starts with when neither its Task profile names one nor a transition pins one. It must name an `[agents.*]` table. |
| `default-model` | no | empty | The model a handoff starts with when its Task profile names none, and the starting value of the Model row. Free text, and it is left to the agent when empty. The resolved agent must map a model for a handoff to carry one. A list the agent reports is checked at startup through every task profile that resolves it (ADR 0010). |
| `default-environment` | yes | - | The environment a handoff starts with when a transition does not pin one. One of `live-worktree` or `worktree`. |
| `default-task-type` | yes | - | The task type of a handoff when no state matches. It must name a `[task-types.*]` table. |
| `state-file` | no | `$XDG_STATE_HOME/my-little-software-factory/state.sqlite`, else `~/.local/state/my-little-software-factory/state.sqlite` | The SQLite state file. A relative path resolves against the directory of this config file. |
| `max-parallel-agents` | no | `2` | The one cap over all running work: the in-flight ticket seats and every Consultation in `opening` or `working`. `0` means unlimited. |
| `agent-poll-interval-seconds` | no | `5` | Seconds between herdr polls. A positive number. |
| `completion-message-lines` | no | `200` | Lines of the agent last message captured when a turn settles. A whole number of 1 or more. |
| `max-handoffs-per-ticket` | no | `10` | Handoffs per ticket after which auto-handoff stops dispatching it. A manual handoff may pass the limit. |
| `attention-bell` | no | `true` | Ring the terminal bell when a Consultation settles. |
| `interaction-exit-key` | no | `f12` | Exit Agent interaction mode. A function key `f1` to `f24`, or `ctrl` plus one letter. Not `ctrl+c`: the emergency exit owns that key. |
| `scroll` | no | the `[scroll]` defaults | The detail-pane scroll. |
| `priority` | no | none | The ordered priority labels that rank tickets. Omitted: tickets are not ranked and the list keeps its previous order. |
| `logging` | no | none | The plane's own file log. Omitted: the run writes no log, the state of a config the plane seeded before logging. |
| `agents` | yes | - | The agent types. At least one table. |
| `task-types` | yes | - | The task types. At least one table. |
| `consultation-types` | no | none | The Consultation patterns. |
| `states` | no | none | The states of the workflow machine, in match order. |
| `repos` | no | none | The repository identity to checkout path mappings. |
| `sources` | no | none | The ticket sources. `ticket-sources` is an alias for the same key; use one name, not both. |

**`[scroll]`** (optional table).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `speed` | no | `1` | Rows moved by one detail key step or one slow wheel event. A whole number of 1 or more. |
| `acceleration` | no | `0.8` | Wheel-burst acceleration strength. A finite number of 0 or more. `0` keeps wheel movement linear. |
| `maximum-speed` | no | `6` | Rows moved by one accelerated wheel event. A whole number of 1 or more, at least `speed`. Equal to `speed` also keeps wheel movement linear. |

**`[logging]`** (optional table).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `level` | no | `info` | The level that passes the filter. One of `off`, `error`, `warn`, `info`, `debug`; `off` keeps no file and no line. |
| `file` | no | `factory.log` next to the state file | The log file. A relative path resolves against the directory of this config file. |
| `max-size-mib` | no | `10` | The size, in mebibytes, at which the current file rotates. A whole number of 1 or more. |
| `keep` | no | `5` | The rotated files kept, from `file.1` up to the `keep`-th file. A whole number of 1 or more. |

**`[priority]`** (optional table).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `labels` | yes, when the table is set | - | The ordered priority labels. The first entry is the highest rank. A ticket carrying one ranks by it; an operator bump beats the label, and an `off` bump sets the ticket unranked. |

**`[agents.<name>]`** (one table per agent type).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `kind` | yes | - | The herdr agent kind, passed to the herdr agent start. |
| `model` | no | - | The model command-line template. It must contain `{value}`. A handoff or a Consultation may set a model only when the agent defines one. |
| `thinking` | no | - | The thinking-level command-line template. It must contain `{value}`. A handoff or a Consultation may set a thinking level only when the agent defines one. |
| `thinking-values` | yes, when the agent maps `thinking` | - | The non-empty subset of the standard levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) this agent supports, in the order the override panel offers them. A Consultation `thinking` and a task type `thinking` must be one of them, and a handoff an edge reroutes onto this agent with another level fails with a readable reason. An agent that maps no `thinking` setting declares no levels. |
| `context-window` | no | - | The context-window command-line template. It must contain `{value}`. A handoff or a Consultation may set a context window only when the agent defines one. |

**`[task-types.<name>]`** (one table per task type; names are one word).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `template` | yes | - | The prompt. Placeholders: `{repository}`, `{title}`, `{description}`, `{source-kind}`, `{external-key}`, `{source-url}`, `{labels}`, `{previous-message}`. Any other brace pair is a startup error, so an unknown name cannot stay literal in the prompt an agent receives. `{previous-message}` is empty on a first handoff and carries the previous agent's last message on a workflow handoff. |
| `agent` | no | `default-agent` | The Task profile's agent type: the agent a handoff of this type starts on. It must name an `[agents.*]` table. A transition's pin beats it. |
| `model` | no | `default-model` | The Task profile's model: free text the resolved agent's model template renders, so that agent must define one. The override panel prefills it, and clearing that row leaves the model to the agent. |
| `thinking` | no | - | The Task profile's thinking level: the level this task type's handoffs start on, and the starting value of the override panel's thinking row. It must be one of the profile agent's `thinking-values`. |
| `context-window` | no | - | The Task profile's context window: a whole count of tokens, written as digits with no separators, that this task type's handoffs start their agent with. The profile agent must define a `context-window` template. There is no top-level default: a profile that names none leaves the room to the agent. |
| `transition` | no | none | The transition that fires when a turn of this type completes. |

**`[consultation-types.<name>]`** (one table per Consultation type).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `agent` | yes | - | The agent type to start. It must name an `[agents.*]` table. |
| `environment` | no | `worktree` | The environment the agent runs in. One of `live-worktree` or `worktree`. A worktree starts from the repository's `main` branch, or its `HEAD` when the repository has no `main`. |
| `template` | yes | - | The opening prompt. It contains `{input}` exactly once and no other placeholder. |
| `model` | no | - | The model, passed through the agent's model template. The agent must define one. |
| `thinking` | no | - | The thinking level, passed through the agent's thinking template. The agent must define one, and the level must be one of its `thinking-values`. |
| `context-window` | no | - | The context window, a whole count of tokens in digits, passed through the agent's context-window template. The agent must define one. |

**`[[states]]`** (one table per state, in match order).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `name` | yes | - | The state name. One word. |
| `task-type` | no | none | The task type the plane suggests for a ticket on the state. It must name a `[task-types.*]` table. Omitted: a parking state the plane suggests nothing for. |
| `match` | yes | - | The condition table. The set conditions must all hold. An empty table matches every ticket. |

**`[repos]`** (a table, repository identity to checkout path).

The identity is `<host>/<owner>/<name>` in lowercase, for example
`"github.com/seriousjul/my-app"`. A mapped path must hold a git checkout of
exactly that repository. See [the Handoffs guide](../work-flow/handoffs.md#repository-resolution)
for the match rules and the sibling clone.

**`[[sources]]`** (one table per ticket source).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `name` | yes | - | The source name. It must be unique, and it is what a state match's `source-name` matches. |
| `kind` | yes | - | `github-issues`, `github-pull-requests`, or one of the security feed kinds `github-security-advisories`, `github-dependabot-alerts`, `github-secret-scanning-alerts`. See the security source note below. |
| `refresh-interval-seconds` | yes | - | The refresh interval. A positive number. |
| `repositories` | yes | - | A non-empty list of `owner/name` strings. |
| `host` | no | `github.com` | The GitHub host. |
| `filter` | no | - | A GitHub search applied to the list. Omitted on the issue and pull request sources: the default policy lists every open item of the source's kind that is not `blocked`, and a pull request that is not a draft unless it carries `needs-work`. The security feed kinds reject the key at startup. See the filter note below. |
| `auth` | no | gh's current authentication | The authentication. Exactly one of `token` (a literal token; the file then carries mode 0600), `token-env` (an environment variable name), or `account` (a gh-authenticated account name). The security feeds reuse this table. The plane's transition writes reuse it too: a fire runs `gh issue edit` and `gh pr edit` under the source's configured authentication, so the labels the plane writes and the items it reads come from the same account.

**`[states.match]`** conditions (all optional; omitted conditions are ignored).

| Key | Required | What it does |
| --- | --- | --- |
| `source-name` | no | The source `name`. |
| `source-kind` | no | `github-issue`, `github-pull-request`, `github-security-advisory`, `github-dependabot-alert`, or `github-secret-scanning-alert`. |
| `repository` | no | The repository identity, for example `github.com/seriousjul/my-app`. |
| `labels-all` | no | Every listed label must be present. Case-insensitive. |
| `labels-any` | no | At least one listed label must be present. Case-insensitive. |
| `labels-none` | no | No listed label may be present. Case-insensitive. |

A label named in `labels-all` or `labels-any` but written by no transition
is a scoping label the operator owns: a fire never removes it, so a state
can gate on a label the machine never writes, such as `labels-all =
["factory"]` keeping the machine to one project's items. A label a
transition writes must already exist in the repository: a write that names a
missing label fails, and [the ticket labels page](../development/labels.md)
carries the command that creates them.

**`[task-types.<name>.transition]`** (one table per task type that fires a transition).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `ticket-facts` | no | none | The labels the transition writes on the ticket. The plane converges the ticket to its own workflow labels: it removes the workflow labels the ticket no longer holds and adds these. |
| `pull-request-facts` | no | none | The labels the transition writes on the ticket's linked pull request, the same convergence. No linked pull request: the fact is skipped, the ticket's facts still stand, and the skip is a fact on the fire. A pull request ticket is its own linked pull request: one surface takes both fact lists in one write. |
| `score-threshold` | no | - | The score a `score-above-threshold` or `score-below-threshold` branch compares the review's score against. The review posts its score as a comment on the pull request in the template's fixed line, and the branch reads the newest comment that carries one. A whole number from 0 to 100. A score branch requires it. |
| `auto-advance` | no | `false` | The factory decides the completed turn without the operator: the position it derives hands off at any time, and a transition with no position closes the cycle even in manual mode. |
| `agent` | no | - | The agent type the route the transition derives runs on. It must name an `[agents.*]` table. |
| `environment` | no | - | The environment the route the transition derives runs in. One of `live-worktree` or `worktree`. |
| `branches` | no | none | The judgment branches, in order. The first branch whose `when` holds fires; a branch with no `when` is the fallback the transition fires on when no judgment held. |

**`[[task-types.<name>.transition.branches]]`** (one table per branch, in order).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `when` | no | fallback | The judgment: `score-above-threshold`, `score-below-threshold`, `pull-request-open`, or `pull-request-closed`. Omitted: the fallback branch, which fires when no judgment branch did. |
| `ticket-facts` | no | the transition's | The labels this branch writes on the ticket, overriding the transition's when the branch fires. |
| `pull-request-facts` | no | the transition's | The labels this branch writes on the linked pull request, overriding the transition's when the branch fires. |
| `auto-advance` | no | the transition's | This branch's auto-advance, overriding the transition's when the branch fires. |
| `agent` | no | the transition's | This branch's agent pin, overriding the transition's when the branch fires. |
| `environment` | no | the transition's | This branch's environment pin, overriding the transition's when the branch fires. |

## Notes

A transition's `auto-advance` lets the control plane decide the completions
of its task type without the operator even in manual mode. A branch carries
its own `auto-advance` to decide one judgment's completion and leave the
others to the transition's. The plane fires the transition on every completed
turn: it writes the label facts, and the
machine re-derives the position from the written labels on the ticket and
its linked pull request. One ticket that is both the settled ticket and the
linked pull request - a pull request ticket - is one surface: the plane
converges it to the two fact lists at once, in one write. A derived position
hands off while the parallel limit and the per-ticket handoff limit have
room; a transition that derives no position closes the cycle, and a route at
either limit degrades the same way the open dispatch does. The agents never
write workflow labels (ADR 0027): the plane writes them, and a ticket's
position is always re-derived from the labels it carries.

The `filter` is a GitHub search string. Without one, the source lists what
the machine needs to see: the plane owns the workflow labels, so an item
enters the list before it carries any - a pull request the agent just opened
is invisible to no one, or the transition that labels it can never find it.
GitHub search applies `AND`, `OR`,
and `NOT` to search text only, and it has no parenthesized grouping.
Parentheses, and logical operators next to `label:`-style qualifiers, are
rejected at startup, so a source never degrades to a healthy-but-empty list.
The security feed kinds are REST endpoints, not GitHub searches, so they
take no `filter` at all: a filter there would be silently ignored, and the
key is rejected at startup instead of misread as applied.

### The security feed sources

The three security kinds read the repository security tab, one call set per
configured repository, and each item appears in the ticket list as one
ticket. The item's severity becomes its single ticket label, so the Priority
label list ranks security tickets; an open secret scanning alert always
carries the label `critical` (ADR 0029).

- `github-security-advisories` lists the repository's security advisories in
  `triage`, `draft`, and `published` state; `closed` and `withdrawn`
  advisories stay out. The ticket's external key is the GHSA id, the title
  the advisory summary, the description the advisory description plus a block
  listing each named vulnerable component (ecosystem, package, vulnerable
  range, patched versions) when the advisory carries one, the label the bare
  severity word, and the URL the advisory page.
- `github-dependabot-alerts` lists the open Dependabot alerts; `fixed`,
  `dismissed`, and `auto_dismissed` alerts stay out. The ticket's external
  key is the alert's per-repository number, the title the CVE id (or the GHSA
  id when there is no CVE) plus the embedded advisory summary, the
  description a composed block (package, ecosystem, manifest path, scope,
  relationship, vulnerable range, first patched version, severity, CVSS
  score) followed by the embedded advisory's full description, the label the
  bare severity word from the embedded advisory with the embedded security
  vulnerability's severity as the fallback, and the URL the alert page.
- `github-secret-scanning-alerts` lists the open secret scanning alerts;
  `closed` and `resolved` alerts stay out. The ticket's external key is the
  alert's per-repository number, the title the word `Exposed` plus the secret
  type name, the description a composed block (secret type, file path, line
  range), the label always `critical` while the alert is open, and the URL
  the alert page.

The sources share the auth table of the other kinds, and a token with the
`repo` or `security_events` scope reads all three feeds. The endpoints need
administrator access to the repository (advisories: owner or security
manager): a token without access makes the source stale with the readable
reason, like any failed refresh. The control plane is read-only on all three
feeds: it never writes labels, states, or dismissals to the security items.
The security task types' transitions write `ready-for-review` on the pull
request the agent opens for the finding, never on the finding itself.

Repository mappings are the one section the control plane writes back: a
sibling clone records its path there. The write-back is atomic: the config
goes to a temp file in the same directory and the rename over the target is
one step, so a crash leaves either the old file or the new one, never a
truncated file the next start would reject. The write-back serializes the
whole config, so operator comments in the file are dropped at the first
write-back: the data round-trips, the comments do not.

The shipped defaults define the three agent types `pi`, `codex`, and
`claude`, the four task types `implement`, `review`, `rework`, and
`merge`, the three security task types `resolve-security-advisory`,
`resolve-dependabot-alert`, and `resolve-secret-scanning-alert`, and the
states of the label workflow - the `ready-for-agent` issue to `implement`,
the `needs-work`, `ready-for-review`, and `ready-to-ship` pull requests to
`rework`, `review`, and `merge`, one state per security source kind pointing
at its task type, and one parking state for a pull request that carries none
of them - with the transitions that move a ticket between them. They also
define one `consult` Consultation type that passes your input straight
through. They carry the three priority labels `critical`, `high`, and `low`.
They have no ticket sources and no repository mappings: uncommenting one
security source block is the only setup a fresh install needs. The security
task types carry `thinking = "high"` and a transition that writes
`ready-for-review` on the opened pull request with `auto-advance = true`: the
turn auto-advances into the pull request's review position, and a turn that
opened no pull request settles closed, the completed task type resting the
ticket while the item still lists upstream. `config/development.toml` in
this repository configures the live development path through `--config`; it
carries the `grill-with-docs` Consultation type.
