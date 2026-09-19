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
# one nor a workflow edge pins one. It must name an [agents.*] table.
default-agent = "pi"

# The model a handoff starts with when its Task profile names none. Free
# text: it is passed through the resolved agent's model template, so a
# handoff whose resolved agent maps no model fails with a readable reason.
# It is checked at startup through every task profile that resolves it.
default-model = "anthropic/claude-opus-4-6"

# The environment a handoff starts with when the workflow edge does not
# pin one. One of "live-worktree" or "worktree".
default-environment = "worktree"

# The task type of a handoff when no task rule matches.
# It must name a [task-types.*] table.
default-task-type = "implement"

# The SQLite state file. A relative path resolves against the directory
# of this config file. Omitted:
# $XDG_STATE_HOME/my-little-software-factory/state.sqlite, else
# ~/.local/state/my-little-software-factory/state.sqlite.
state-file = "factory.sqlite"

# --- Limits ----------------------------------------------------------

# The in-flight agents the control plane keeps. 0 means unlimited.
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
# auto-close lets the control plane decide the completions of this type
# without the operator even in manual mode.
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
auto-close = false

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
auto-close = false

[task-types.rework]
template = '''
Rework pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
auto-close = false

[task-types.merge]
template = '''
Merge pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
thinking = "low"
auto-close = true

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

# --- Workflows ----------------------------------------------------------------

# from and to name [task-types.*] tables. to is a non-empty list.
# agent and environment pin the handoff the edge triggers.
[[workflows]]
from = "implement"
to = ["review"]
agent = "pi"
environment = "worktree"

[[workflows]]
from = "review"
to = ["merge", "rework"]

[[workflows]]
from = "rework"
to = ["review"]

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

# --- Task rules ----------------------------------------------------------------------

# Ordered. The first rule whose when table matches a ticket wins.
# The set conditions in one when table must all hold. An empty when
# table matches every ticket.
[[task-rules]]
task-type = "review"
[task-rules.when]
source-name = "my-app-pull-requests"
source-kind = "github-pull-request"
repository = "github.com/seriousjul/my-app"
labels-all = ["ready"]
labels-any = ["ready-for-review", "needs-work"]
labels-none = ["do-not-process"]

[[task-rules]]
task-type = "implement"
[task-rules.when]
source-kind = "github-issue"
```

## Key reference

**Top level.**

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `default-agent` | yes | - | The agent type a handoff starts with when neither its Task profile names one nor a workflow edge pins one. It must name an `[agents.*]` table. |
| `default-model` | no | empty | The model a handoff starts with when its Task profile names none, and the starting value of the Model row. Free text, and it is left to the agent when empty. The resolved agent must map a model for a handoff to carry one. A list the agent reports is checked at startup through every task profile that resolves it (ADR 0010). |
| `default-environment` | yes | - | The environment a handoff starts with when the workflow edge does not pin one. One of `live-worktree` or `worktree`. |
| `default-task-type` | yes | - | The task type of a handoff when no task rule matches. It must name a `[task-types.*]` table. |
| `state-file` | no | `$XDG_STATE_HOME/my-little-software-factory/state.sqlite`, else `~/.local/state/my-little-software-factory/state.sqlite` | The SQLite state file. A relative path resolves against the directory of this config file. |
| `max-parallel-agents` | no | `2` | The in-flight agents the control plane keeps. `0` means unlimited. |
| `agent-poll-interval-seconds` | no | `5` | Seconds between herdr polls. A positive number. |
| `completion-message-lines` | no | `200` | Lines of the agent last message captured when a turn settles. A whole number of 1 or more. |
| `max-handoffs-per-ticket` | no | `10` | Handoffs per ticket after which auto-handoff stops dispatching it. A manual handoff may pass the limit. |
| `attention-bell` | no | `true` | Ring the terminal bell when a Consultation settles. |
| `interaction-exit-key` | no | `f12` | Exit Agent interaction mode. A function key `f1` to `f24`, or `ctrl` plus one letter. Not `ctrl+c`: the emergency exit owns that key. |
| `scroll` | no | the `[scroll]` defaults | The detail-pane scroll. |
| `priority` | no | none | The ordered priority labels that rank tickets. Omitted: tickets are not ranked and the list keeps its previous order. |
| `agents` | yes | - | The agent types. At least one table. |
| `task-types` | yes | - | The task types. At least one table. |
| `consultation-types` | no | none | The Consultation patterns. |
| `workflows` | no | none | The workflow edges. |
| `repos` | no | none | The repository identity to checkout path mappings. |
| `sources` | no | none | The ticket sources. `ticket-sources` is an alias for the same key; use one name, not both. |
| `task-rules` | no | none | The ordered task rules. |

**`[scroll]`** (optional table).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `speed` | no | `1` | Rows moved by one detail key step or one slow wheel event. A whole number of 1 or more. |
| `acceleration` | no | `0.8` | Wheel-burst acceleration strength. A finite number of 0 or more. `0` keeps wheel movement linear. |
| `maximum-speed` | no | `6` | Rows moved by one accelerated wheel event. A whole number of 1 or more, at least `speed`. Equal to `speed` also keeps wheel movement linear. |

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
| `agent` | no | `default-agent` | The Task profile's agent type: the agent a handoff of this type starts on. It must name an `[agents.*]` table. A workflow edge's pin beats it. |
| `model` | no | `default-model` | The Task profile's model: free text the resolved agent's model template renders, so that agent must define one. The override panel prefills it, and clearing that row leaves the model to the agent. |
| `thinking` | no | - | The Task profile's thinking level: the level this task type's handoffs start on, and the starting value of the override panel's thinking row. It must be one of the profile agent's `thinking-values`. |
| `context-window` | no | - | The Task profile's context window: a whole count of tokens, written as digits with no separators, that this task type's handoffs start their agent with. The profile agent must define a `context-window` template. There is no top-level default: a profile that names none leaves the room to the agent. |
| `auto-close` | no | `false` | The control plane decides the completions of this type without the operator even in manual mode. |

**`[consultation-types.<name>]`** (one table per Consultation type).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `agent` | yes | - | The agent type to start. It must name an `[agents.*]` table. |
| `environment` | no | `worktree` | The environment the agent runs in. One of `live-worktree` or `worktree`. A worktree starts from the repository's `main` branch, or its `HEAD` when the repository has no `main`. |
| `template` | yes | - | The opening prompt. It contains `{input}` exactly once and no other placeholder. |
| `model` | no | - | The model, passed through the agent's model template. The agent must define one. |
| `thinking` | no | - | The thinking level, passed through the agent's thinking template. The agent must define one, and the level must be one of its `thinking-values`. |
| `context-window` | no | - | The context window, a whole count of tokens in digits, passed through the agent's context-window template. The agent must define one. |

**`[[workflows]]`** (one table per workflow edge).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `from` | yes | - | The task type the edge routes from. |
| `to` | yes | - | The task types the edge may start. A non-empty list. |
| `agent` | no | - | The agent type the handoff the edge triggers runs on. |
| `environment` | no | - | The environment the handoff the edge triggers runs in. One of `live-worktree` or `worktree`. |

**`[repos]`** (a table, repository identity to checkout path).

The identity is `<host>/<owner>/<name>` in lowercase, for example
`"github.com/seriousjul/my-app"`. A mapped path must hold a git checkout of
exactly that repository. See [the Handoffs guide](../work-flow/handoffs.md#repository-resolution)
for the match rules and the sibling clone.

**`[[sources]]`** (one table per ticket source).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `name` | yes | - | The source name. It must be unique, and it is what a rule's `source-name` matches. |
| `kind` | yes | - | `github-issues`, `github-pull-requests`, or one of the security feed kinds `github-security-advisories`, `github-dependabot-alerts`, `github-secret-scanning-alerts`. See the security source note below. |
| `refresh-interval-seconds` | yes | - | The refresh interval. A positive number. |
| `repositories` | yes | - | A non-empty list of `owner/name` strings. |
| `host` | no | `github.com` | The GitHub host. |
| `filter` | no | - | A GitHub search applied to the list. See the filter note below. The security feed kinds reject the key at startup. |
| `auth` | no | gh's current authentication | The authentication. Exactly one of `token` (a literal token; the file then carries mode 0600), `token-env` (an environment variable name), or `account` (a gh-authenticated account name). The security feeds reuse this table. |

**`[[task-rules]]`** (one table per rule, in order).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `task-type` | yes | - | The task type the rule selects. It must name a `[task-types.*]` table. |
| `when` | yes | - | The condition table. The set conditions must all hold. An empty table matches every ticket. |

**`[task-rules.when]`** conditions (all optional; omitted conditions are ignored).

| Key | Required | What it does |
| --- | --- | --- |
| `source-name` | no | The source `name`. |
| `source-kind` | no | `github-issue`, `github-pull-request`, `github-security-advisory`, `github-dependabot-alert`, or `github-secret-scanning-alert`. |
| `repository` | no | The repository identity, for example `github.com/seriousjul/my-app`. |
| `labels-all` | no | Every listed label must be present. Case-insensitive. |
| `labels-any` | no | At least one listed label must be present. Case-insensitive. |
| `labels-none` | no | No listed label may be present. Case-insensitive. |

## Notes

A task type can set `auto-close = true`. For its completions the control
plane decides without the operator even in manual mode: exactly one outgoing
workflow edge hands off with that task while the parallel limit has room,
any other edge count closes the cycle, and a route at the per-ticket
handoff limit degrades to close.

The `filter` is a GitHub search string. GitHub search applies `AND`, `OR`,
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
`resolve-dependabot-alert`, and `resolve-secret-scanning-alert`, the three
task rules of the label workflow - `needs-work` pull requests to `rework`,
`ready-for-review` to `review`, and `ready-to-ship` to `merge` - and one
task rule per security source kind pointing at its task type. They also
define one `consult` Consultation type that passes your input straight
through. They carry the three priority labels `critical`, `high`, and `low`.
They have no ticket sources and no repository mappings: uncommenting one
security source block is the only setup a fresh install needs. The security
task types carry `auto-close = true` and `thinking = "high"`: the cycle
auto-closes on a completed settle, and the completed task type rests the
ticket while the item still lists upstream. `config/development.toml` in
this repository configures the live development path through `--config`; it
carries the `grill-with-docs` Consultation type.
