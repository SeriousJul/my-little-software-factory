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

# Handoff attempts per ticket after which auto-handoff stops dispatching it.
max-handoffs-per-ticket = 10

# --- UI ----------------------------------------------------------------

# Ring the terminal bell when a Consultation settles.
attention-bell = true

# Also send a desktop notification per standing warning or error fact.
desktop-notification = true

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
# xhigh, max. Thinking is never free text.
# A handoff or a Consultation can pass one of those settings only when the
# agent defines its template; a setting the agent cannot take fails the
# handoff with a readable reason.
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

# Exactly one of template and action is required: the prompt the type's
# turns run on, or the plane action the type runs without an agent.
# Placeholders in a template: {repository}, {title},
# {description}, {source-kind}, {external-key}, {source-url}, {labels},
# {previous-message}, {review-verdict}. Any other brace pair is a startup
# error.
# agent, model, thinking, and context-window are the Task profile: the
# settings this task type's handoffs start on. agent must name an
# [agents.*] table, model is free text the profile agent's model template
# renders, thinking must be one of that agent's thinking-values, and
# context-window must be a whole count of tokens in digits. An omitted agent
# leaves the agent to default-agent, an omitted model leaves the model to
# default-model, and an omitted level or window leaves it to the agent. The
# override panel prefills all four, and each one applies to its own setting
# only. The action form takes no profile keys.
# operator-decides is a boolean either form carries: when set, the automatic
# Completion rule parks the type's completions for the operator ahead of its
# outcome checks (ADR 0085, renamed by ADR 0092).
# A [task-types.X.transition] table fires when a turn of this type
# completes - or, for the action form, when the action's run answers:
# it writes the label facts on the ticket and its linked pull
# request, and the machine re-derives every position from the written labels.
# The agents never write the labels the machine writes: the one sanctioned
# exception is the analyze type's settling agent, which applies the
# operator-owned labels its own template names (ADR 0086).
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

# The analyze grills the ticket's specification with the operator in the live
# session and writes it back to the ticket (ADR 0085, ADR 0086). Its
# operator-decides flag parks its completions for the operator, so
# unattended mode keeps the live session alive between the agent's questions
# and the operator's answers. It carries no transition and no pull request.
[task-types.analyze]
thinking = "xhigh"
operator-decides = true
template = '''
/skill:grill-with-docs

### The ticket

{external-key}: {title}

URL: {source-url}

Labels: {labels}

Description:
{description}

### Rules

1. **Ground Yourself**
   - Read the repository's agent instructions and its domain docs (CONTEXT.md and the ADRs) before your first question.
   - Read the ticket in full, comments included, so the agreement behind it stands behind your questions.

2. **Work the Design Tree**
   - Every decision branches into the decisions that hang off it. Ask your whole open frontier in one turn, numbered, each question with your recommended answer.
   - Finding facts is yours, never the operator's: read the code, the docs, and the source before you ask.
   - When the frontier is empty, the design is settled. Never settle it on a guess.

3. **Keep the Session Alive**
   - End a turn only to ask the operator a question or to report the settled design. The operator answers here, and your session continues.
   - Never post the interview to the ticket. This terminal is the record.

4. **Write the Docs as the Design Settles**
   - When a term resolves, update the repository's glossary (CONTEXT.md) right there.
   - When a decision is hard to reverse, surprising without context, and the result of a real trade-off, write an ADR.
   - Commit the documentation directly to the repository's default branch, and never push the ticket's branch or create or merge a pull request: the branch stands for the implementation that follows.

5. **Land the Spec on the Ticket**
   - When the design is settled, rewrite the ticket's body into the specification: the context, the decisions with their reasons, and the acceptance criteria.
   - Keep the original request text, quoted, inside the new body.
   - When the body cannot be edited, open a specification issue in the same repository, apply a spec:<new issue number> label to the ticket, and say so in your final message.

6. **Mark the Ticket Ready**
   - When - and only when - the specification is settled and the docs are committed, apply the ready-for-agent label to the ticket through gh.

Repository: {repository}

Previous session message (empty on a first session): {previous-message}'''

# The merge is a plane action: the plane runs it without an
# agent and without a worktree, and its transition takes the needs-work
# path on a blocked merge and the empty facts on a landed one.
[task-types.merge]
action = "merge-pull-request"
method = "squash"
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []
[[task-types.merge.transition.branches]]
when = "pull-request-open"
pull-request-facts = ["needs-work"]
[[task-types.merge.transition.branches]]
pull-request-facts = []

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
# The spec position (ADR 0085, ADR 0086): an agreed ticket that needs a
# specification before the work is worth implementing. It orders after the
# ready-for-agent state, so a ticket carrying both labels rests at
# ready-for-agent and is offered for implementation, not re-specified. The
# ready-for-spec label is operator-owned: no transition writes it.
[[states]]
name = "ready-for-spec"
task-type = "analyze"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-spec"]

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
| `default-model` | no | empty | The model a handoff starts with when its Task profile names none, and the starting value of the Model row. Free text, and it is left to the agent when empty. The resolved agent must map a model for a handoff to carry one. A list the agent reports is checked at startup through every task profile that resolves it. |
| `default-environment` | yes | - | The environment a handoff starts with when a transition does not pin one. One of `live-worktree` or `worktree`. |
| `default-task-type` | yes | - | The task type of a handoff when no state matches. It must name a `[task-types.*]` table. |
| `state-file` | no | `$XDG_STATE_HOME/my-little-software-factory/state.sqlite`, else `~/.local/state/my-little-software-factory/state.sqlite` | The SQLite state file. A relative path resolves against the directory of this config file. |
| `max-parallel-agents` | no | `2` | The one cap over all running work: the in-flight ticket seats and every Consultation in `opening` or `working`. `0` means unlimited. |
| `agent-poll-interval-seconds` | no | `5` | Seconds between herdr polls. A positive number. |
| `completion-message-lines` | no | `200` | Lines of the agent last message captured when a turn settles. A whole number of 1 or more. |
| `max-handoffs-per-ticket` | no | `10` | Handoff attempts and plane action attempts per ticket after which auto-handoff stops dispatching it. An attempt that never started an Agent counts (ADR 0101). A manual handoff may pass the limit. |
| `attention-bell` | no | `true` | Ring the terminal bell when a Consultation settles. |
| `desktop-notification` | no | `true` | Send a desktop notification per standing warning or error fact on the Message line, carrying the full text the line truncates. Switches independently of `attention-bell`. |
| `interaction-exit-key` | no | `f12` | Exit Agent interaction mode. A function key `f1` to `f24`, or `ctrl` plus one letter. Not `ctrl+c`: the emergency exit owns that key. |
| `scroll` | no | the `[scroll]` defaults | The detail-pane scroll. |
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

The plane's start lines name the path that started the work, the item's origin,
who put the item in the Work queue, and the seat reading that path stood on:

```text
handoff started: "Add a webhook retry policy" (mode pickup, origin open, automatic, seats 1/2)
merge started: "Persist the source facts" (mode force-dispatch, origin workflow, operator-staged, seats 2/2)
consultation started: "review" 1a2b3c4d (mode pickup, origin consultation, seats 1/2)
```

`mode` is `pickup`, `force-dispatch`, or `direct-ask`. `origin` is the item's
origin: `open`, `workflow`, `restart`, or `consultation` for a Consultation
row. The staging word is `automatic` for a row one of the observation cycle's
walks added and `operator-staged` for a row your own ask left when no seat stood
free; a Consultation's start line states no staging, because the Consultation
row is never one of the two. `seats` is the held seats beside the Parallel
limit, and an unlimited cap states no limit. A row you asked for that waited in
the Work queue reads `mode pickup`, not `direct-ask`: the mode names the path
that took the seat, not the ask that made the row.

The queue lines name the row the Work queue took and the refusal that left a row
out:

```text
handoff queued: "Add a webhook retry policy" (origin open, operator-staged)
merge queued: "Persist the source facts" (origin workflow, automatic)
handoff refused: "Add a webhook retry policy" (already has a waiting queue item; the first item keeps its place)
merge refused: "Persist the source facts" (already has a waiting queue item; the first item keeps its place)
handoff refused: "Add a webhook retry policy" (handoff recovery is required before another handoff)
```

The Work queue holds one item per ticket, so a second ask for a ticket that
already waits is refused. The refusal reaches the Message line and the file
alike. Every refusal line wears one shape - the prefix, the ticket's name, and
the fact in parentheses - so one rule reads them all (issue #223).

The file states a standing-row refusal once for the row that stands, not once
per ask. The automatic walks re-ask every observation cycle while the row
stands, and a five-second poll cannot pin the file with the same refusal; a row
that leaves the queue and a later row for the same ticket are two facts, and
each states itself (issue #223).

The observation cycle states each hold its automatic walks take, once for as long
as the fact stands and again when the fact changes, so a run that started nothing
says why (issue #223):

```text
automatic walks hold: auto-handoff is off
automatic walks hold: the Work queue is paused
automatic walks hold: a failed turn waits for the operator
automatic walks hold: the Work queue already holds a continuation
automatic walks hold: the Work queue holds an item the operator staged
automatic walks hold: the Work queue holds a waiting row
```

The two lines about a standing row name whose row it is, because the origin
cannot: the row your own route decision left in the queue and the row the
factory owes for a settled turn are both `workflow`.

Auto-handoff mode and the Work queue pause are facts you set by key, and each
flip states itself:

```text
auto-handoff is on
auto-handoff is off
the Work queue is paused
the Work queue resumed
```

A mode flip the state file refused states itself as what it is - the line lands
beside the Message line that names the state file it could not write, and the
next run reads the mode the file still holds:

```text
auto-handoff is on for this session only: cannot store the Auto-handoff mode at /path/to/state.sqlite: Error: no such table: auto_handoff_mode
```

A Consultation's start line is the Consultation operations' own. Its name is the
record's Consultation type beside the identity prefix the plane's other
Consultation lines name it by, and its origin word is `consultation`, the same
word the Work queue stands a Consultation row under. The seat reading is
measured before the record takes its seat, so it names the count the Parallel
limit stood on. For a Consultation the mode names the key, not a cap crossing:
the Work queue's Pickup reads `mode pickup`, and your own start now key reads
`mode force-dispatch` whatever the seat reading says, so `mode force-dispatch`
beside `seats 0/2` is a normal start, not a breach of the cap.

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
| `template` | exactly one of `template` or `action` | - | The prompt. Placeholders: `{repository}`, `{title}`, `{description}`, `{source-kind}`, `{external-key}`, `{source-url}`, `{labels}`, `{previous-message}`, `{review-verdict}`. Any other brace pair is a startup error, so an unknown name cannot stay literal in the prompt an agent receives. `{previous-message}` is empty on a first handoff and carries the previous agent's last message on a workflow handoff. `{review-verdict}` carries the pull request's review verdict, read live from the source when the handoff renders the prompt: the newest post on the pull request's comment and review timelines that carries the review template's fixed score line, under a one-line header naming its posting timeline and post time. A template without the placeholder issues no read. When no verdict stands or the read fails, the placeholder carries the fact and the agent reads the pull request's comments itself. A verdict score that stands at or above the score-threshold of the transition that tests a score judgment fills the gates fact instead: the review passed, so the failure stands in the pull request's gates - a merge conflict or a failing CI check - and the prompt sends the agent to rebase the branch and fix what the gates report. |
| `action` | exactly one of `template` or `action` | - | The plane action the type runs instead of an agent's turn: the plane starts it with no agent and no worktree, and the Handoff limit counts its attempts. The registry holds one action, `merge-pull-request`: the squash merge of the ticket's pull request. The action form takes no profile keys. |
| `method` | no | `squash` | The merge method the `merge-pull-request` action runs with: `squash`, `merge`, or `rebase`. An omitted method takes the default. |
| `agent` | no | `default-agent` | The Task profile's agent type: the agent a handoff of this type starts on. It must name an `[agents.*]` table. A transition's pin beats it. |
| `model` | no | `default-model` | The Task profile's model: free text the resolved agent's model template renders, so that agent must define one. The override panel prefills it, and clearing that row leaves the model to the agent. |
| `thinking` | no | - | The Task profile's thinking level: the level this task type's handoffs start on, and the starting value of the override panel's thinking row. It must be one of the profile agent's `thinking-values`. |
| `context-window` | no | - | The Task profile's context window: a whole count of tokens, written as digits with no separators, that this task type's handoffs start their agent with. The profile agent must define a `context-window` template. There is no top-level default: a profile that names none leaves the room to the agent. |
| `operator-decides` | no | `false` | The Operator-decides flag (ADR 0085, renamed by ADR 0092). When set, the automatic Completion rule parks every completion of the type for the operator ahead of its outcome checks: the ticket rests in `awaiting` in Auto-handoff mode, the environment and the agent stay untouched, and the operator's explicit close or route still runs. The auto top-up leaves the ticket alone: a Next step needs a transition that fired, and a parked ticket is not open. Allowed on both forms; the shipped `analyze` type is its only user. |
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
| `pull-request-facts` | no | none | The labels the transition writes on the ticket's fixing pull request, the same convergence. No fixing pull request: the fact is skipped, the ticket's facts still stand, and the skip is a fact on the fire. A pull request ticket is its own fixing pull request: one surface takes both fact lists in one write. |
| `score-threshold` | no | - | The score a `score-above-threshold` or `score-below-threshold` branch compares the review's score against. The review posts its score on the pull request - a comment or a review body - in the template's fixed line, and the branch reads the newest record that carries one. A whole number from 0 to 100. A score branch requires it. |
| `agent` | no | - | The agent type the route the transition derives runs on. It must name an `[agents.*]` table. |
| `environment` | no | - | The environment the route the transition derives runs in. One of `live-worktree` or `worktree`. |
| `branches` | no | none | The judgment branches, in order. The first branch whose `when` holds fires; a branch with no `when` is the fallback the transition fires on when no judgment held. |

**`[[task-types.<name>.transition.branches]]`** (one table per branch, in order).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `when` | no | fallback | The judgment: `score-above-threshold`, `score-below-threshold`, `pull-request-open`, or `pull-request-closed`. Omitted: the fallback branch, which fires when no judgment branch did. |
| `ticket-facts` | no | the transition's | The labels this branch writes on the ticket, overriding the transition's when the branch fires. |
| `pull-request-facts` | no | the transition's | The labels this branch writes on the fixing pull request, overriding the transition's when the branch fires. |
| `agent` | no | the transition's | This branch's agent pin, overriding the transition's when the branch fires. |
| `environment` | no | the transition's | This branch's environment pin, overriding the transition's when the branch fires. |

## Notes

A fired Transition leaves a Next step (ADR 0092): the task type the written
labels put the ticket on, the ticket that position stands on, and whether the
step is a Handoff or a Plane action. Auto-handoff mode decides every settled
turn from that one fact - the mode's rule is "Auto-handoff mode is on, and the
settled turn has a Next step" - so no config key stands between a Transition
and the route it derives. A turn with no Next step closes its cycle: the facts
landed on a parking state, or no branch held. A turn whose label write failed
parks for the operator: the plane does not route from labels it did not write.
A step a gate holds - the position offers no task, the position is not
actionable, the Same-type hold, or the Handoff limit - rests in `awaiting` for
the operator, and the Decision screen states the hold; a step the Handoff limit
holds closes the cycle. Manual mode runs no top-up, so a settled turn rests in
`awaiting` for the operator's Decision screen in every case.

Every gate reads the position the step stands on, not the ticket the settled turn
ran on. When a route crosses from an issue to its linked pull request, the pull
request's standing, hold, and limit are the ones that hold the step, and a
position at its Handoff limit closes the settled turn: the top-up's fresh walk
then re-dispatches the settled ticket as open work (ADR 0092).

The `pull-request-open` and `pull-request-closed` judgments read the linked
pull request's own record straight from the source at fire time, live the
moment a merge lands, and they fall back to the pull request's state on the
last refresh when the read fails.

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
ticket, labelled with its severity. An open secret scanning alert always
carries the label `critical`. The shipped machine already routes each kind to
its resolve task type, so uncommenting a security source block is the only
setup it needs.

- `github-security-advisories` lists the repository's security advisories;
  `closed` and `withdrawn` advisories stay out.
- `github-dependabot-alerts` lists the open Dependabot alerts; `fixed`,
  `dismissed`, and `auto_dismissed` alerts stay out.
- `github-secret-scanning-alerts` lists the open secret scanning alerts;
  `closed` and `resolved` alerts stay out.

The sources share the auth table of the other kinds, and a token with the
`repo` or `security_events` scope reads all three feeds. The endpoints need
administrator access to the repository (advisories: owner or security
manager): a token without access makes the source stale with a readable
reason, like any failed refresh. The control plane is read-only on all three
feeds: it never writes labels, states, or dismissals to the security items.

Two sections are the control plane's to write back: a sibling clone records
its path in the `[repos]` table, and a repository init registers the ticket
sources it generated as `[[sources]]` blocks. The write-back edits only those
sections, so your comments, your blank lines, and the order you wrote your
keys in stay where you put them. A comment you wrote beside a mapping key the
plane re-points stays on that line. The Message line names the file each write
lands on, and when the line is longer than the terminal the Message view on
`F2` holds the whole fact. A write that replaced your whole file leads the line
it lands on, so the warning that your comments did not survive is what stands on
the visible row. A write that changed nothing leaves the file untouched,
timestamp included, and says nothing. The write keeps the mode your
file already carries when that mode is stricter than the one the text asks for:
a file you locked to `0600` stays `0600` even when the config the plane holds
names no literal token, and a file the plane creates takes the mode its own
text asks for.

The plane rewrites the whole file - and your comments do not survive that
write - only when it cannot vouch for its own edit of your text. It checks the
edited text before it lands: the text must parse, must pass the same validation
the plane starts with, and must carry every mapping and every source the plane
holds. A file that check will not vouch for takes the rewrite, and the Message
line says plainly that the comments did not survive.

What the two sections hold, and what happens when you edit them while the plane
is running, is not the same on both sides.

- The `[repos]` table is the plane's own writing: a write-back puts the value
  the plane holds onto the line that names that key. If you re-point a key the
  plane holds while the plane runs, the next write-back writes the plane's own
  value back over yours, and no line says it was replaced. If you delete such a
  key, the next write-back writes it again. A key the plane does not hold is
  yours, and it stays. A key the plane holds that you restated as an inline
  table - `"github.com/acme/factory" = { path = "/x" }` - is a key line the
  plane owns like any other: the write-back writes its own value over it, and
  the rest of your file keeps its place.
- The `[[sources]]` blocks the plane holds stand byte for byte, so an edit of
  one of them while the plane runs is a file that no longer says what the plane
  holds. The check refuses the edit, and that is the case the plane names on
  the Message line: change a held block's `kind` or its `repositories` while
  the plane runs and the whole file is rewritten. If you delete such a block,
  the next write-back appends the plane's own copy of it at the end of the
  file.

The other shapes that take the rewrite are the ones the check cannot vouch for:
a mapping value the plane must write and cannot carry in place - a multiline
string or a multiline array standing on a key the plane holds - and a file your
edit left in a shape the startup loader itself refuses: a broken line, a stray
byte-order mark, a dotted key in the `[repos]` table, a `[sources]` table instead
of `[[sources]]` blocks, or a `[[sources]]` block that names no `name`. The
loader refuses those at startup, so the plane only meets one of them through an
edit made while it runs. The empty source list is not in that group: the plane
writes no `sources` key at all for no sources, and a `sources = []` line an
earlier version wrote is one the write-back drops before it appends its blocks.

The shipped defaults define the three agent types `pi`, `codex`, and
`claude`, the four task types `implement`, `review`, `rework`, and
`merge`, the three security task types, and the states of the label workflow
with the transitions that move a ticket between them. They also define the
`consult` and `pair` Consultation types. They have no ticket sources and no
repository mappings, so [the minimal
config](../getting-started/minimal-config.md) is the only setup a fresh
install needs.
