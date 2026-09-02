# my-little-software-factory

The control plane of my little software factory.
It is a terminal app that observes the factory and issues work.
It watches tickets and hands them off to agents.

It fetches configured GitHub issue and pull request sources, stores factory
state in SQLite, and refreshes each source without resetting a ticket's work
cycle. Enter hands an actionable open ticket off through herdr. The `e` key
opens the override panel for a one-shot change of the handoff settings.

The control plane polls herdr for the agents it started. It marks a blocked
agent and a missing agent on the ticket, reclaims an agent that outlived its
work cycle, reads the agent's turn log when a turn settles, and records a
completion trace. In auto-handoff mode it
hands eligible open tickets off by itself within the configured limits, and
routes or closes completed turns along the configured workflows.

See `CONTEXT.md` for the domain language, `docs/labels.md` for source-label
meaning, and `docs/adr/` for the decisions (ADR 0001: OpenTUI and
TypeScript, ADR 0002: handoffs run through herdr, ADR 0005: a work cycle
ends at close, ADR 0006: the control plane polls herdr, ADR 0011: the
observation reclaims an agent that outlives its work cycle).

## Requirements

- node v26.4 or newer (developed on v26.5.0).
  The OpenTUI native renderer loads `node:ffi`, which node 26 still gates
  behind `--experimental-ffi`, and the `factory` binary re-execs node with that flag.
- The project pins the node version in `.tool-versions`.
  Run the commands through mise to get that version.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH` for handoffs.
  The control plane drives it through its CLI and never starts an agent
  process itself (ADR 0002).
- The agent CLI of an agent kind whose Model list the control plane can read.
  For the `pi` kind it runs `pi --list-models` to learn the models that agent
  actually offers, with its provider auth already applied (ADR 0010). A kind
  that reports no list keeps a free-text Model row, and its configured models
  go unchecked until the agent itself refuses one.

## Commands

| Command         | What it does                              |
| --------------- | ----------------------------------------- |
| `npm run dev`   | Start the control plane in watch mode     |
| `npm test`      | Run the full test suite                   |
| `npm run lint`  | Lint and check formatting with Biome      |
| `npm run fmt`   | Lint, format, and fix with Biome          |
| `npm run typecheck` | Typecheck with TypeScript             |

## Keys

| Key              | What it does                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| `j` / `k`        | Move the selection, or move the detail by its configured row speed      |
| `Up` / `Down`    | Move the selection, or move the detail by its configured row speed      |
| `PageUp` / `PageDown` | Select one list page, or move the detail one viewport with one shared row |
| `Home` / `End`   | Select the first or last Ticket, or move the detail to its start or end |
| `h` / `l`        | Switch focus between the list and detail                                |
| `Left` / `Right` | Switch focus between the list and detail                                |
| `Enter`          | Hand the selected open ticket off, or open the decision modal on an awaiting ticket the factory does not decide itself, or the missing modal on a ticket whose agent is gone, or focus the agent of a blocked ticket |
| `e`              | Open the override panel for the selected open ticket                    |
| `a`              | Toggle auto-handoff mode for this session                              |
| `r`              | Refresh ticket sources, or retry a failed Consultation                 |
| `q`              | Quit                                                                    |
| `v` / `t`        | Open Consultations / return to Tickets                                 |
| `c`              | Open the Consultation launcher                                          |
| `f`              | Cycle open, closed, and all Consultations                              |
| `x`              | Close the selected Consultation                                         |
| `d`              | Delete a selected closed Consultation                                   |
| `?`              | Open the contextual key guide                                           |
| `m`              | Open the full current Message view                                     |

### Consultation controls

The Consultation view keeps an independent list and Agent view. In the
launcher, `Tab` changes fields, arrows choose a type or Repository, `Enter`
launches, `Shift+Enter` inserts a newline, and `Esc` cancels. `Enter` on an
awaiting response opens the response editor. The editor stores its draft in
SQLite, `Enter` submits it, `Shift+Enter` inserts a newline, and `Esc` leaves
the draft in place. `End` follows the latest Agent output after scrolling.
Closed history shows cleanup results and retained resources, including resources
left by a Force-close.

A blocked Agent uses Agent interaction mode instead of the response editor.
The default exit key is `F12`; configure `interaction-exit-key` with a
function key or `Ctrl` plus one letter. All other controls are shown in the
in-app guide when the contextual Action bar is available.

### Override panel keys

The panel is a modal. While it is open, the keys of the app below are inert.
Its rows are the agent type, the environment kind, the task type, and the
settings the chosen agent type maps; a setting it does not map has no row.
The rows start on the settings the resolved Task profile names (ADR 0009),
so the panel shows what the handoff will run on.

| Key                                 | What it does                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `j` / `k`                           | Move rows, or type into a row that takes typing                              |
| `Up` / `Down`                       | Move between setting rows                                                    |
| `Tab`                               | Move to the next setting row                                                 |
| `Shift` + `Tab`                     | Move to the previous setting row                                             |
| `h` / `l`                           | Cycle a list value, or type into the Model list and a text row               |
| `Left` / `Right`                    | Cycle a list value, jump a type-ahead match, or move the caret in a text row |
| `Home` / `End`                      | Move the caret to the start or end of a text row                             |
| `Shift` + Left/Right, `Home`, `End` | Select text in a text row                                                    |
| typed text                          | Jump a Model list to a match, or insert text at the caret in a text row      |
| `Backspace` / `Delete`              | Clear a Model or Thinking row, or delete before or at the caret              |
| `Ctrl` + `Backspace` / `Delete`     | Delete one word before or after the caret                                    |
| `Ctrl` + `Z` / `Y`                  | Undo or redo text editing                                                    |
| bracketed terminal paste            | Insert sanitized text at the caret; ANSI and line breaks are removed         |
| `Enter`                             | Confirm: the handoff starts with these settings                              |
| `Esc`                               | Cancel: nothing runs, nothing changes                                        |

The Model row offers the selected agent's own Model list (ADR 0010). It is a
list row that also takes type-ahead: every typed letter extends the typed
text, and the row's value jumps to the first model whose whole value contains
that text, case-insensitively. The typed text is never displayed; the jumping
value is the feedback. Typing accumulates until the operator selects with the
arrows, clears with `Backspace`, or leaves the row. While the control plane
fetches the list the row shows `(loading...)` and takes no input. When the
agent's kind reports no list, or the query fails, the row is the standard
single-line text field: typing, caret movement, selection, `Home` and `End`,
word deletion, undo and redo, and bracketed terminal paste. A list the agent
reports empty shows `(no models available)`.

The Thinking row is a list of the levels the selected agent declares, in the
order it declares them, so the operator can never choose a level that agent
cannot run.

A row owns the keys it needs, so `j`, `k`, `h`, and `l` type into a row that
takes typing, and move or cycle everywhere else; `Up`, `Down`, `Tab`, and
`Shift` + `Tab` always move the selection. The guide under the rows follows
the selected row and shows its available controls.
A row shows `(empty)` for an unset text value, `(unset)` for a list value the
operator has not chosen, and `(loading...)` while the Model list is being
fetched. A value that is set but not available for the current agent shows in
the warning color, so a handoff that would fail is visible before it is
confirmed. Switching the task type row re-derives the agent, model, and
thinking rows from the new task type's profile while the operator has not
touched each row, so the panel keeps showing what the handoff will run on; a
touched row keeps its value. Switching the agent never re-derives the model:
every setting resolves on its own chain. Clearing a Model or Thinking row
leaves that setting to the agent. The container environment is a future kind
and is not offered by the panel.

The panel sizes itself to the terminal. When the rows do not fit, the value
column shrinks first, then the label column, then the marker. The guide drops
when it does not fit. The rows scroll within the remaining viewport, and the
selected row stays visible. A row never wraps: it carries less, not broken
text.

### Decision modal keys

Enter on an `awaiting` ticket opens the decision modal: a near-fullscreen
modal that pops in over the app with a short fade and grow, one cell of
margin on every side. In auto mode, and on an auto-close task type, the
factory decides the ticket itself: Enter only reports that, and the modal
stays closed. Its border reads `Decision: <ticket title>`, and the
first row under the border names the context: repository, task type,
agent, completion time.

The body is the turn log of the settled turn, in order. The agent's text
blocks carry light markdown dressing: headings render bright without their
hashes, bold renders bright, code renders dim, lists keep their markers
and indent per level, links keep their label. Each tool call is one dim
note, `▸ name: target`; a failed call wears the warning color. The agent's
thinking text is not shown. The log comes from the agent's session record
(ADR 0008); when no session is known, the terminal capture stands in. The
modal opens at the bottom, where the agent's conclusion is, and a
proportional scrollbar shows the position when the log is longer than the
window.

The modal offers the choices the state allows.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `Up` / `Down`  | Move between the choice rows                                      |
| `j` / `k`      | Scroll the turn log, one row up or down                           |
| `PgUp` / `PgDn` | Scroll the turn log by a page                                    |
| `Home` / `End` | Jump to the top or the bottom of the turn log                     |
| `Enter`         | Choose the selected row                                            |
| `Esc`           | Close the modal: nothing runs, the ticket stays awaiting           |

The first row, "Close", ends the work cycle: the ticket returns to open
with its cycle number incremented, and the handoff's environment is closed
without touching the git branch, so pushed work and pull requests survive:
a worktree handoff loses its worktree checkout and its herdr workspace,
a live worktree handoff loses its tab.
The second row, "Goto", focuses the agent's pane so the operator can steer
it; the ticket returns to `running`. Goto is a state move, not a completion
decision, so the trace does not record it: the turn's pending trace stays
pending, and the next settle refreshes it with the agent's new last message.
Then one "Handoff: `<task type>`" row per outgoing workflow edge the
completed task type has, in config order: an edge naming several targets
offers one row per target, and two edges to the same target keep both
rows, so every edge stays reachable. The row's detail shows the edge's
pinned agent type and environment when the edge defines them, so two
rows that share a target differ. Choosing a row hands the ticket off again with that
target task type, pinning the edge's agent type and environment when the
edge defines them. The row's "handed-off" decision lands on the turn's
trace only when the routed handoff settles with the agent started; a
failed route leaves the trace pending, so Close and Goto keep working
on the awaiting ticket.

### Missing modal keys

Enter on a ticket whose agent is missing opens the missing modal.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `Up` / `Down`  | Move between the choice rows                                      |
| `j` / `k`      | Scroll the modal message                                          |
| `Enter`         | Choose the selected row                                            |
| `Esc`           | Close the modal: nothing runs, the badge stays                     |

"Restart" hands the ticket off again with the same choices, in the
workspace the handoff recorded, and the last completion's message as the
previous message. "Abandon" ends the work cycle: the ticket returns to open
with its cycle number incremented, the handoff's environment is closed,
and the missing badge clears.

## Layout

Two panes side by side, flex-sized to the terminal.
The list pane on the left shows every ticket with its state badge, task
type badge, title, and repository. The task type badge is the type the
control plane would hand off: an open ticket shows its suggested task type,
every other ticket shows the task type its recorded handoff started with.
A non-open ticket without a recorded handoff shows `[unknown]`, and only
that badge wears a warning color; every configured task type uses one
neutral style. The detail pane on the right shows the full detail of the
selected ticket: repository, ticket state, assigned agent, source name,
source kind, external key, source state, URL, labels, and source health. It
carries one explicit task type line for every ticket: `Suggested task
type:` for an open ticket, `Handoff task type:` for every other, with
`Handoff task type: unknown` when the handoff data is absent. The detail
also carries
the ticket's handoff count against its per-ticket limit, counting the
handoffs of every work cycle the ticket ran, and, when one exists, the last
completion: its date, the task type, the agent, and the recorded decision.
Factory ticket state and external source state stay separate.
The panes share one focus.
Switching focus never moves the selection.

The vertical keys act on the focused pane.
With the list focused, they move the selection. Page keys move by one visible
list page, and Home and End select the list edges. With the detail focused,
the row keys move at the configured speed, PageUp and PageDown retain one row
of context, and Home and End move to the detail edges. A new selection starts
the detail at the top.

The detail is a native OpenTUI viewport. Its complete content stays mounted,
so wheel bursts translate one stable surface instead of rebuilding visible
rows. When the content overflows, its right inner column has a proportional
scrollbar. The gutter is always reserved when width permits, so wrapped text
does not reflow as the bar appears. Click or drag the scrollbar, or use the
wheel or trackpad over any part of the detail. Fast vertical wheel events
accelerate to the configured limit. Horizontal and Shift-wheel input is
ignored. A click or wheel action focuses its pane. Clicking a visible Ticket
selects it, and a list wheel event selects one adjacent Ticket.

When the terminal is too narrow for a field, the field drops out of the row
instead of wrapping it.
The repository drops before the title does, and the task type badge is
complete or absent: the row keeps the whole badge with a readable title,
or the badge drops and the title takes the cells. A partial badge could
read as another task type, so it never truncates; the full value stays in
the detail pane.

Under the panes sits a status line. It carries the progress and the outcome
of the last handoff: `handing off "..."...` while one is in flight, the
warning a sibling clone raises, or the readable reason a handoff failed.
A clean handoff clears the line. While a handoff is in flight the keys keep
working, and `e` is refused with a hint on the line. A second handoff claim
records its attempt, which blocks a further claim on the same ticket, and
queues its external work until the in-flight handoff settles; the ticket
moves to `handed-off` only when the handoff settles and its agent starts,
so claims never race each other.

Above the panes sits a mode line. It shows the auto-handoff state and the
live agents against the parallel limit: `auto: on 1/2`, or `auto: off 1`
when no limit is set. The count is the in-flight tickets whose agent was
alive in the latest herdr poll. The `a` key toggles the mode for the
session; the config's `auto-handoff` key sets the startup value only.

A blocked agent replaces the state badge in the list row with a `blocked`
badge: the agent shows an approval or question UI and waits for a human.
The ticket stays in flight, in `handed-off` or `running`, and still counts
against the parallel limit. A missing agent replaces the state badge with a
`missing` badge: the stored pane is gone or holds no agent, so the work
stops there until the operator restarts or abandons the cycle. Both badges
clear when the next poll no longer shows the condition. The first poll has
not landed yet, so no badge appears before it.
A ticket that has used up its per-ticket handoff limit wears a trailing
`handoff limit` marker at the end of the row, and the detail pane shows the
count as `Handoffs: 2/2`. Auto-handoff leaves such a ticket open; a manual
handoff may still pass the limit.

## Handoffs

Enter on an open ticket starts a handoff on the settings its Task profile
resolves. The override panel changes them for that one handoff only; it never
becomes a new default. Each setting resolves on its own chain, and the closer
a decision is to the handoff in front of the operator, the more weight it
gets (ADR 0009):

- Agent: operator override, workflow edge pin, task profile `agent`,
  `default-agent`.
- Model: operator override, task profile `model`, `default-model`, the agent's
  own default.
- Thinking: operator override, task profile `thinking`, the agent's own level.

A workflow handoff resolves those chains for its target task type, so it
starts fresh: it does not inherit the Model or Thinking of the handoff that
just settled. A Restart repeats the interrupted handoff's Model and Thinking,
because that handoff is the decision being resumed.

Before an agent start, the control plane checks that the settings fit the
resolved agent (ADR 0010): its model must be one the agent's own CLI reports,
and its level must be one the agent declares. An unfit setting fails the
handoff with a readable reason before it changes anything outside the control
plane, and the ticket stays open. A model list that cannot be fetched skips
the model check, and the agent's own rejection stands.

- The agent runs through herdr (ADR 0002): a live worktree handoff creates a
  herdr workspace at the checkout with a fresh tab, and a worktree handoff
  lets herdr create a git worktree first.
- A worktree handoff branches `factory/<ticket id>-<title slug>` from the
  checkout's current `HEAD`, and an existing branch is a hard failure.
  A worktree handoff that fails before the agent starts removes the
  worktree and the branch, so a retry can run.
- The agent starts under the title slug as its herdr name, with the settings
  the agent type maps (model, thinking level), and receives the prompt
  rendered from the task type's template with the ticket's repository,
  title, and description.
- The ticket moves to `handed-off` when the agent starts, even if the prompt
  later fails. The agent is running and can be prompted by hand. A failure
  before the start (a missing herdr, a missing checkout, a clone target the
  filesystem refuses, a model the agent does not offer) leaves the ticket
  open and shows the reason on the status line. The app never crashes on a
  handoff failure.

### Model discovery

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

### Repository resolution

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
`~/src/billing_1`), hands off there, warns on the status line, and hands the
mapping back to be written to the config file, so the next handoff resolves
it explicitly. The mapping is handed back even when a later step of the
handoff fails, so the clone is not lost.

## Completion and auto-handoff

The control plane polls herdr for its agents every
`agent-poll-interval-seconds`. The poll reads the agent list, and it reads
the last message of an agent that has settled its turn. It never writes to
herdr.

An agent can outlive the work cycle that started it: the Close cleanup cannot
remove a dirty checkout, and the operator can re-prompt a settled agent in its
herdr pane. The cycle is closed, so the ticket rests `open`, and the next
handoff of that ticket fails on the herdr agent name the live agent still
holds. The poll reclaims it (ADR 0011): a working or blocked agent in the pane
of a ticket's last closed handoff records a handoff of the current cycle and
runs the ticket again, with a warning line that names the ticket. An idle, done,
or unknown report reclaims nothing. The reclaimed agent settles, awaits, and
closes like any other, and it holds a parallel slot while it works.

When the agent settles its turn (herdr reports it as done, or it is idle at
the end of the turn), the ticket moves to `awaiting`. The
completion trace records the task type, the agent, the completion time, the
last message, and the decision that ends the awaiting state. A workflow
handoff that follows an awaiting ticket renders its prompt with the
`{previous-message}` placeholder filled from that last message, so the next
agent reads what the previous one left behind.

In manual mode, `awaiting` waits for the operator. Enter opens the decision
modal. The operator routes the ticket to a workflow target or closes the
work cycle.

Auto-handoff mode decides without the operator, within the configured
limits:

- With auto-handoff on, the control plane decides every settled turn
  without the operator: it routes when the task type has exactly one
  outgoing workflow edge with exactly one target, and the parallel limit
  has room. At the per-ticket handoff limit the route degrades to close.
  Zero or multiple edges close the cycle. A full parallel limit leaves the
  ticket awaiting until a slot frees.
- With auto-handoff off, the same decisions apply to auto-close task
  types only. A task type that is not auto-close leaves its settled turn
  awaiting for the operator.
- Every eligible open ticket is handed off with the config defaults when the
  parallel limit allows it. The limit counts the live agents: the in-flight
  tickets in `handed-off` or `running` whose agent was alive in the latest
  poll. A blocked agent still counts; a missing agent holds no slot.
- The per-ticket handoff limit stops the close-and-rehandoff loop. When a
ticket reaches it, auto-handoff leaves it open. A manual handoff may pass
  the limit.

Both limits gate auto-handoff only. A manual handoff is always allowed.

A missing agent in auto mode restarts the handoff once, with the last
message as the previous message. At the per-ticket handoff limit, the
cycle is abandoned instead. When the agent is missing again, or the
parallel limit is full, the control plane stops: the `missing` badge stays
until the operator restarts or abandons from the missing modal. In manual
mode the control plane never touches a missing agent. Abandon ends the
work cycle, closes the handoff's environment, and returns the ticket to
open with its cycle number incremented.

## Configuration

The config lives at `~/.config/factory/config.toml`, or at the path the
`--config` flag names: `factory [--config <path>]`. A missing file yields
the shipped defaults, so the control plane starts with no config at all, and
the start says so before the UI takes over, with the path to put a file at.
A file that does not parse or does not validate stops the control plane
with a readable error before the UI starts: a present file must carry every
required key, and a key the control plane does not read is an error, so a
typo surfaces at startup, not at handoff time.

A present file replaces the shipped defaults wholesale. An optional key the
file omits takes the per-key default the key reference names, and that
default is empty for lists and tables. The key reference marks each key
required or optional.

### Complete example

The example below is one valid config. It sets every key the control plane
reads, optional keys included, so the example and the key reference agree
line for line. The values are illustrative.

```toml
# --- Handoff defaults ----------------------------------------------

# The agent type a handoff starts with when the workflow edge does not
# pin one. It must name an [agents.*] table.
default-agent = "pi"

# The environment a handoff starts with when the workflow edge does not
# pin one. One of "live-worktree" or "worktree".
default-environment = "worktree"

# The task type of a handoff when no task rule matches.
# It must name a [task-types.*] table.
default-task-type = "implement"

# The model a handoff starts on when its Task profile names none. It is
# passed through the resolved agent's model template, and it reaches an
# agent that maps no model setting at all. Omitted: the agent's own default.
# It is checked at startup through every task profile that resolves it.
default-model = "anthropic/claude-sonnet-4-5"

# The SQLite state file. A relative path resolves against the directory
# of this config file. Omitted: $XDG_STATE_HOME/factory/state.sqlite,
# else ~/.local/state/factory/state.sqlite.
state-file = "factory.sqlite"

# --- Auto-handoff and limits -----------------------------------------

# Start in auto-handoff mode. The a key toggles it per session.
auto-handoff = false

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

# --- Agent types ---------------------------------------------------------

# kind is the herdr agent kind. model and thinking are command-line
# templates for the agent start and must contain {value}.
# thinking-values lists the levels this agent supports, in the order the
# override panel offers them. An agent that maps thinking must declare a
# non-empty subset of the standard set: off, minimal, low, medium, high,
# xhigh, max. Thinking is never free text (ADR 0010).
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

[agents.claude]
kind = "claude"
model = "--model {value}"
thinking = "--effort {value}"
thinking-values = ["low", "medium", "high", "xhigh", "max"]

# --- Task types -----------------------------------------------------------

# template is required. Placeholders: {repository}, {title},
# {description}, {source-kind}, {external-key}, {source-url}, {labels},
# {previous-message}. Any other brace pair is a startup error.
# The three settings below are the Task profile: what a handoff of this
# type starts on. agent names an [agents.*] table, model is a model that
# agent offers, and thinking must be one of that agent's thinking-values.
# An omitted agent leaves the agent to default-agent, an omitted model
# leaves the model to default-model, and an omitted level leaves it to the
# agent.
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
# placeholder. model and thinking map through the agent's templates.
[consultation-types.grill-with-docs]
agent = "pi"
environment = "live-worktree"
template = "/skill:grill-with-docs {input}"
model = "anthropic/claude-opus-4-6"
thinking = "high"

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
# "github-pull-requests". filter is a GitHub search applied to the list.
# auth takes exactly one of token, token-env, or account.
# Omitted auth uses gh's current authentication.
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

### Key reference

**Top level.**

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `default-agent` | yes | - | The agent type a handoff starts with when the workflow edge does not pin one. It must name an `[agents.*]` table. |
| `default-environment` | yes | - | The environment a handoff starts with when the workflow edge does not pin one. One of `live-worktree` or `worktree`. |
| `default-task-type` | yes | - | The task type of a handoff when no task rule matches. It must name a `[task-types.*]` table. |
| `default-model` | no | - | The model a handoff starts on when its Task profile names none, and the starting value of the Model row. It is passed through the resolved agent's `model` template, so it never reaches an agent that maps no model setting. Omitted: each agent's own default. A list the agent reports is checked at startup through every task profile that resolves it (ADR 0010). |
| `state-file` | no | `$XDG_STATE_HOME/factory/state.sqlite`, else `~/.local/state/factory/state.sqlite` | The SQLite state file. A relative path resolves against the directory of this config file. |
| `auto-handoff` | no | `false` | Start in auto-handoff mode. The `a` key toggles it per session. |
| `max-parallel-agents` | no | `2` | The in-flight agents the control plane keeps. `0` means unlimited. |
| `agent-poll-interval-seconds` | no | `5` | Seconds between herdr polls. A positive number. |
| `completion-message-lines` | no | `200` | Lines of the agent last message captured when a turn settles. A whole number of 1 or more. |
| `max-handoffs-per-ticket` | no | `10` | Handoffs per ticket after which auto-handoff stops dispatching it. A manual handoff may pass the limit. |
| `attention-bell` | no | `true` | Ring the terminal bell when a Consultation settles. |
| `interaction-exit-key` | no | `f12` | Exit Agent interaction mode. A function key `f1` to `f24`, or `ctrl` plus one letter. |
| `scroll` | no | the `[scroll]` defaults | The detail-pane scroll. |
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

**`[agents.<name>]`** (one table per agent type).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `kind` | yes | - | The herdr agent kind, passed to the herdr agent start. |
| `model` | no | - | The model command-line template. It must contain `{value}`. A Consultation may set a model only when the agent defines one. |
| `thinking` | no | - | The thinking-level command-line template. It must contain `{value}`. |
| `thinking-values` | yes, when the agent maps `thinking` | - | The non-empty subset of the standard levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) this agent supports, in the order the override panel offers them. A Consultation `thinking` and a task type `thinking` must be one of them. An agent that maps no `thinking` setting declares no levels. |

**`[task-types.<name>]`** (one table per task type; names are one word).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `template` | yes | - | The prompt. Placeholders: `{repository}`, `{title}`, `{description}`, `{source-kind}`, `{external-key}`, `{source-url}`, `{labels}`, `{previous-message}`. Any other brace pair is a startup error, so an unknown name cannot stay literal in the prompt an agent receives. `{previous-message}` is empty on a first handoff and carries the previous agent's last message on a workflow handoff. |
| `agent` | no | - | The Task profile's agent type: the agent a handoff of this type starts on. It must name an `[agents.*]` table. Omitted: `default-agent`. |
| `model` | no | - | The Task profile's model: the model a handoff of this type starts on, passed through the profile agent's `model` template, so that agent must define one. Omitted: `default-model`, then the agent's own default. |
| `thinking` | no | - | The Task profile's level: the level a handoff of this type starts on, and the starting value of the thinking row. It must be one of the profile agent's `thinking-values`. Omitted: the level is left to the agent. |
| `auto-close` | no | `false` | The control plane decides the completions of this type without the operator even in manual mode. |

**`[consultation-types.<name>]`** (one table per Consultation type).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `agent` | yes | - | The agent type to start. It must name an `[agents.*]` table. |
| `environment` | yes | - | The environment the agent runs in. One of `live-worktree` or `worktree`. |
| `template` | yes | - | The opening prompt. It contains `{input}` exactly once and no other placeholder. |
| `model` | no | - | The model, passed through the agent's model template. The agent must define one. |
| `thinking` | no | - | The thinking level, passed through the agent's thinking template. The agent must define one, and the level must be one of its `thinking-values`. |

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
exactly that repository. See [Repository resolution](#repository-resolution)
for the match rules and the sibling clone.

**`[[sources]]`** (one table per ticket source).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `name` | yes | - | The source name. It must be unique, and it is what a rule's `source-name` matches. |
| `kind` | yes | - | `github-issues` or `github-pull-requests`. |
| `refresh-interval-seconds` | yes | - | The refresh interval. A positive number. |
| `repositories` | yes | - | A non-empty list of `owner/name` strings. |
| `host` | no | `github.com` | The GitHub host. |
| `filter` | no | - | A GitHub search applied to the list. See the filter note below. |
| `auth` | no | gh's current authentication | The authentication. Exactly one of `token` (a literal token; the file then carries mode 0600), `token-env` (an environment variable name), or `account` (a gh-authenticated account name). |

**`[[task-rules]]`** (one table per rule, in order).

| Key | Required | Default | What it does |
| --- | --- | --- | --- |
| `task-type` | yes | - | The task type the rule selects. It must name a `[task-types.*]` table. |
| `when` | yes | - | The condition table. The set conditions must all hold. An empty table matches every ticket. |

**`[task-rules.when]`** conditions (all optional; omitted conditions are ignored).

| Key | Required | What it does |
| --- | --- | --- |
| `source-name` | no | The source `name`. |
| `source-kind` | no | `github-issue` or `github-pull-request`. |
| `repository` | no | The repository identity, for example `github.com/seriousjul/my-app`. |
| `labels-all` | no | Every listed label must be present. Case-insensitive. |
| `labels-any` | no | At least one listed label must be present. Case-insensitive. |
| `labels-none` | no | No listed label may be present. Case-insensitive. |

### Notes

A task type can set `auto-close = true`. For its completions the control
plane decides without the operator even in manual mode: exactly one outgoing
workflow edge hands off with that task while the parallel limit has room,
any other edge count closes the cycle, and a route at the per-ticket
handoff limit degrades to close.

The `filter` is a GitHub search string. GitHub search applies `AND`, `OR`,
and `NOT` to search text only, and it has no parenthesized grouping.
Parentheses, and logical operators next to `label:`-style qualifiers, are
rejected at startup, so a source never degrades to a healthy-but-empty list.

Repository mappings are the one section the control plane writes back: a
sibling clone records its path there. The write-back is atomic: the config
goes to a temp file in the same directory and the rename over the target is
one step, so a crash leaves either the old file or the new one, never a
truncated file the next start would reject. The write-back serializes the
whole config, so operator comments in the file are dropped at the first
write-back: the data round-trips, the comments do not.

The shipped defaults define the three agent types `pi`, `codex`, and
`claude`, the four task types `implement`, `fix`, `review`, and `rework`,
and two task rules for `ready-for-review` and `needs-work` pull requests.
They have no sources and no Consultation types. `config/development.toml`
in this repository configures the live development path through `--config`;
it carries the `grill-with-docs` Consultation type.

## Shape

- `src/factory.ts`: the entry module.
  Checks the node version, loads and validates the config, boots the
  renderer, and mounts the app.
- `src/runtime.ts`: the node version gate.
- `src/config.ts`: config types, strict startup validation, state path
  resolution, and atomic TOML write-back.
- `src/ticket-source.ts`: the ticket-source seam and built-in GitHub Issues
  and Pull Requests adapters.
- `src/refresh.ts`: independent source refresh scheduling.
- `src/observation.ts`: the herdr observation loop. Polls the agent list,
  reads the settled agent's last message, marks blocked and missing agents,
  reclaims an agent that outlived its work cycle, settles turns into
  `awaiting`, applies the automatic completion rule, and dispatches open
  tickets in auto-handoff mode.
- `src/state.ts`: SQLite migrations, source reconciliation, work cycles,
  completion traces, completion decisions, handoff attempts, and the
  process lease.
- `src/task-selection.ts`: ordered task-rule selection.
- `src/domain/`: the Ticket type and the ticket state machine.
- `src/handoff.ts`: the handoff. Resolves the repository, runs the pinned
  command sequence through herdr, starts the agent, and sends the prompt.
- `src/repo.ts`: the repository resolution and the sibling clone.
- `src/naming.ts`: the branch names and the herdr agent names.
- `src/runner.ts`: the single egress for commands.
  Every external command goes through one `CommandRunner`, and the tests
  inject a fake that records the calls.
- `test/sample-tickets.ts`: deterministic data used by legacy frame tests only.
- `src/components/`: the app shell, the ticket list pane, the ticket detail
  pane, the override panel, the shared action panel (the completion decision
  and the missing agent modal both render through it), the shared pane
  geometry, the shared palette, and the display-width-aware text helpers.
- `test/`: the test suite.
  The seam is the rendered terminal frame and the recorded command sequence.
  No test touches a real herdr session or a real git repository.
