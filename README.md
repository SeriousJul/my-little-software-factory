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
observation reclaims an agent that outlives its work cycle, ADR 0012: a
leftover environment is a fact the operator can act on).

## Requirements

- node v26.4 or newer (developed on v26.8.1).
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

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start the control plane in watch mode     |
| `npm test`          | Run the full test suite                   |
| `npm run mutate`    | Run Stryker mutation testing, contained   |
| `npm run lint`      | Lint and check formatting with Biome      |
| `npm run fmt`       | Lint, format, and fix with Biome          |
| `npm run typecheck` | Typecheck with TypeScript                 |

### Mutation testing

`npm run mutate` runs Stryker through the crash guard
(`scripts/crash-guard.sh`). The suite spawns control plane processes, and a
native crash in the runner (the known case is the node:sqlite use-after-free
in node 26.5.0) would otherwise leave them orphaned under systemd and write
a core file for every death. The guard contains both: it runs the whole
process tree with core files disabled, so the OS records no crash, and when
Stryker exits, by success, failure, or crash, the guard terminates every
surviving process of the run. Extra arguments pass through to Stryker, such
as `npm run mutate -- --dryRunOnly`.

## Controls

The control plane keeps a contextual Action bar in the last row of the
terminal. It shows the controls the current interaction mode can run, dims
one it will not run in the present state, and names the reason on the Message
line when the operator presses it anyway.

The in-app Key guide lists the controls of the modes the app dispatches from
its catalogue. Press `?` or `F1` to open it from anywhere, including the
panes and the modals. It carries the Ticket list, the Ticket detail, the
override panel in both of its row kinds, the decision modal, the missing
modal, the guide and the Message view, the controls that are only reachable
from another mode, Quit, and the `Ctrl+C` emergency exit, each with what it
does and, where the app will not run it, why. Press `Esc`, `F1`, or `?` to
close it.

This file does not repeat that list. A table of keys here went stale twice:
the guide and the Action bar are generated from one control catalogue
(`src/components/controls.ts`), so what the app shows is what the app runs.

The controls the Consultation surfaces use are listed below. They are the
part of the app that does not dispatch from the catalogue yet, so the Key
guide does not list them at all: this file and each surface's own key handling
are where those keys are stated.

### Consultation controls

The Consultation surfaces are the part of the app that still handles their
own keys: the Consultation launcher, the legacy Consultation view, the
response editor, Agent interaction, and the Consultation confirmation panel
are not wired to the shared control catalogue yet (issue #9). The keys they
use are these:

- The Consultation view keeps an independent list and Agent view. In the
	launcher, `Tab` changes fields, arrows choose a type or Repository, `Enter`
	launches, `Shift+Enter` inserts a newline, and `Esc` cancels.
- `Enter` on an awaiting response opens the response editor. The editor
	stores its draft in SQLite, `Enter` submits it, `Shift+Enter` inserts a
	newline, and `Esc` leaves the draft in place.
- `End` follows the latest Agent output after scrolling. Closed history shows
	cleanup results and retained resources, including resources left by a
	Force-close.
- A blocked Agent uses Agent interaction mode instead of the response editor.
	The default exit key is `F12`; configure `interaction-exit-key` with a
	function key or `Ctrl` plus one letter.
Every surface the control plane owns dispatches from the catalogue, so the Key
guide and the Action bar state its controls: the Ticket list, the Ticket
detail, the override panel in both of its row kinds, the decision modal, the
missing modal, and the two utility overlays. The five Consultation surfaces
named above do not: each keeps its own key handling, and no control of theirs
is in the catalogue or the guide. The Consultation confirmation panel is the
one surface of those five that shares the modal chrome and the Message line;
it shares neither the dispatch nor the catalogue. The Ticket list and detail
move with the row, page and jump keys, focus the detail with `l` or `Right` and
the list with `h` or `Left`, hand an open ticket off with `Enter`, open the
decision modal on an awaiting one, the missing modal on a ticket whose agent
is gone, and the override panel with `e`. `a` toggles auto-handoff, `r`
refreshes the sources, `v` and `t` switch views, and `q` quits.

When the Message line is truncated, press `m` in a base pane or `F2` in any
mode to read the captured message in the Message view. The Message line and
the Action bar reserve the two bottom rows at every terminal size: below the
smallest useful frame the panes give way to a size message and a compact Help
control, and a surface that cannot draw its own rows says so instead of
painting them over its border. One hint holds the row's end cells: Help on a
bar that can open the Key guide, and the overlay's own Close on a utility
overlay. A frame too narrow for that hint states one of its whole keys, so the
way out of a screen is named at any width and never cut in half.

### Entry controls

The basic entry controls are `?` or `F1` for the Key guide, `F2` for a
truncated Message view, and `Ctrl+C` for emergency exit. Use the in-app
guide and the contextual Action bar for the control plane's fixed control set.

The override panel is a modal. While it is open, the keys of the app below
are inert, and the shared Action bar at the terminal bottom changes between
its list-row, model-row, and text-row modes. `Up` and `Down` move the
setting rows, and `Tab` and `Shift` + `Tab` move the next or previous row
from either row kind. On a list row, `j` and `k` also move the rows, and
`h`/`l` and `Left`/`Right` cycle the value. A free-text row is a standard
single-line input: typed text, the caret keys, `Home` and `End`, `Backspace`
and `Delete`, word deletes, undo and redo, and sanitized bracketed paste all
work in it. It owns printable `j`, `k`, `h`, `l`, `?`, and `m`; `F1` still
opens Help and `F2` the Message view. Enter confirms the handoff; Esc
cancels.

The rows start on the settings the resolved Task profile names (ADR 0009),
so the panel shows what the handoff will run on. The Model row offers the
selected agent's own Model list (ADR 0010). It is a list row that also takes
type-ahead: every typed letter extends the typed text, and the row's value
jumps to the first model whose whole value contains that text,
case-insensitively. The panel's rule is a plain substring test, stricter than
the pattern search the `pi --list-models` filter applies, which lets the
matched letters sit apart from each other. The typed text is never displayed;
the jumping value is the feedback. A run that finds nothing is over, because
a longer run can only match less, so the letter that found nothing starts a
new run and the row keeps answering every letter. On that row `j`, `k`, `h`,
and `l` type letters; only the arrows, `Tab`, and `Shift` + `Tab` move the
selection. While the control plane fetches the list the row shows
`(loading...)` and takes no input, and a value the fetch has not judged yet
shows in the dim tone. When the agent's kind reports no list, or the query
fails, the
row is the standard single-line text field, and an empty list the agent
reports shows `(no models available)`.

The Thinking row is a list of the levels the selected agent declares, in the
order it declares them, so the operator can never choose a level that agent
cannot run. A row shows `(empty)` for an unset free-text value and
`(unset)` for a list value that is not one of its options. The operator
picks another level, or clears a Model or Thinking row to leave the setting
to the agent. Switching the task type row re-derives the agent, model, and
thinking rows from the new task type's profile while the operator has not
touched each row, so the panel keeps showing what the handoff will run on;
a touched row keeps its value. Switching the agent never re-derives the
model: every setting resolves on its own chain. A value that is set but not
available for the current agent shows in the warning color, so a handoff that
would fail is visible before it is confirmed; a waiting Model row is not
judged, because its list has not arrived to judge it against. The container
environment is a future kind and is not offered by the panel.

The panel sizes itself to the terminal. When the rows do not fit, the value
column shrinks first, then the label column, then the marker. The rows
scroll within the viewport when the height cannot hold them all, and the
selected row stays visible. A row never wraps: it carries less, not broken
text. The shared Action bar sits at the terminal bottom and names the
controls the panel dispatches.

### Decision modal

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

The modal offers the choices the state allows. `Up` and `Down` move between
the choice rows; `j` and `k` scroll the turn log one row, with the page and
jump keys as aliases. `Enter` chooses the selected row, and `Esc` closes
the modal: nothing runs, and the ticket stays awaiting. The shared Action
bar at the terminal bottom names these controls.
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

### Missing modal

Enter on a ticket whose agent is missing opens the missing modal. It shows
the badge fact and the handoff count, and it offers "Restart" and
"Abandon". `Up` and `Down` move between the choice rows, `j` and `k` scroll
its message, `Enter` chooses the selected row, and `Esc` closes the modal:
nothing runs, and the badge stays. The shared Action bar at the terminal
bottom names these controls. "Restart" hands the ticket off again with the
same choices, in the
workspace the handoff recorded, and the last completion's message as the
previous message. "Abandon" ends the work cycle: the ticket returns to open
with its cycle number incremented, the handoff's environment is closed,
and the missing badge clears.

### Leftover environment action keys

`w` on a ticket wearing the `leftover` marker opens the clear panel.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `Up` / `Down`  | Move between the choice rows                                      |
| `Enter`         | Choose the selected row                                            |
| `Esc`           | Close the panel: nothing runs, the leftover stays recorded          |

"Retry" runs the Close cleanup again. "Force" is a row only where the
leftover is a checkout, because a forced removal discards uncommitted work
and stops the agents in the workspace: the control plane never reaches for
it by itself. A removal that succeeds clears the leftover; a removal that
fails records the reason again. The git branch survives either way.

A clear ends the environments its cleanup reaches: a workspace removal clears
the leftovers that named that workspace, a tab close the one that named that
tab, and a cleanup that ran no command only the fact of its own cycle. Facts
outside that reach stand. Because a cleanup reaches an environment, it refuses
a leftover naming the ticket's own live agent: the workspace, tab, or pane
that agent runs on, and the Message line names what it refused. Close that work
cycle first, and its own cleanup ends the leftover with it. A clear refused
because a handoff or another clear is already at herdr reports that too, and
the operator presses `w` again. A clear holds the handoff seat while it runs,
and a handoff the operator starts beside one waits for it, so herdr never
builds an agent in a workspace it is taking away.

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

Above the Action bar sits the Message line. It carries the progress and the outcome
of the last handoff: `Working: handing off "..."...` while one is in flight,
`Warning:` for a sibling clone or other recoverable issue, and `Error:` for a
failed handoff. A clean handoff clears its Working line, and a warning the
operator drew while it ran - a refused key or clear - then takes the line. While
a handoff is in flight keys keep working, and `e` is refused with a warning. A second handoff claim
records its attempt, which blocks a further claim on the same ticket, and
queues its external work until the in-flight handoff settles; the ticket
moves to `handed-off` only when the handoff settles and its agent starts,
so claims never race each other. A leftover clear holds that same seat,
and so does the Close cleanup of any path that runs one: an environment
change and a handoff never work beside each other.

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
A ticket whose previous herdr environment is still alive wears a trailing
`leftover` marker, and its detail pane names the workspace, tab, and pane that
remain, the reason the control plane knows, and since when. `w` clears it.

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
	title, and description. When the ticket's own leftover agent still holds
	that name, the handoff starts under the same slug with its work cycle, as
	`persist-source-facts-c2`, and says so on the Message line (ADR 0012). A
	name held by any other agent fails the handoff, with the pane and workspace
	that hold it in the reason.
- The ticket moves to `handed-off` when the agent starts, even if the prompt
	later fails. The agent is running and can be prompted by hand. A failure
	before the start (a missing herdr, a missing checkout, a clone target the
	filesystem refuses, a model the agent does not offer) leaves the ticket
	open and shows the reason on the Message line. The app never crashes on a
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
`~/src/billing_1`), hands off there, warns on the Message line, and hands the
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
handoff of that ticket meets the herdr agent name the live agent still
holds. The poll reclaims it (ADR 0011): a working or blocked agent in the pane
of a ticket's last closed handoff records a handoff of the current cycle and
runs the ticket again, with a warning line that names the ticket. An idle, done,
or unknown report reclaims nothing. The reclaimed agent settles, awaits, and
closes like any other, and it holds a parallel slot while it works.

What the poll cannot reclaim stays as a fact on the ticket (ADR 0012): a Close
cleanup that fails, or a handoff that meets its own leftover name, records the
herdr environment that is still alive, and the ticket wears the `leftover`
marker until the operator clears it with `w`. That handoff still starts: it
takes the ticket's cycle name, and it works beside the leftover agent in the
reused workspace until someone ends it.

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
# passed through the resolved agent's model template, so it never reaches
# an agent that maps no model setting at all. Omitted: the agent's own
# default. It is checked at startup through every task profile that resolves it.
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
| `interaction-exit-key` | no | `f12` | Exit Agent interaction mode. A function key `f1` to `f24`, or `ctrl` plus one letter. Not `ctrl+c`: the emergency exit owns that key. |
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
	Checks the node version, loads and validates the config, checks the config's
	model values against what the agent runtimes report, opens the state, boots
	the renderer, and mounts the app.
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
- `src/setting-resolution.ts`: the handoff setting chains (ADR 0009). The Task
	profile of each task type, and the agent, model, and thinking one handoff
	resolves to before an operator override replaces it.
- `src/model-settings.ts`: the Model list checks (ADR 0010). The startup
	validation of the config's model values, and the setting fit check every
	agent start runs before its first external change.
- `src/domain/`: the Ticket type and its state machine, the agent-side facts
	every Agent type shares (the standard Thinking level set), and the handoff
	environment kinds.
- `src/handoff.ts`: the handoff. Resolves the repository, runs the pinned
	command sequence through herdr, starts the agent, and sends the prompt.
- `src/repo.ts`: the repository resolution and the sibling clone.
- `src/naming.ts`: the branch names and the herdr agent names.
- `src/runner.ts`: the single egress for commands.
	Every external command goes through one `CommandRunner`, and the tests
	inject a fake that records the calls. The runner also answers the Model list
	query (ADR 0010): it maps an agent kind to the command that prints its list
	and the reader of the table that command prints, and it never throws.
- `test/sample-tickets.ts`: deterministic data used by legacy frame tests only.
- `src/components/`: the app shell, the ticket list pane, the ticket detail
	pane, the native ticket detail viewport, the override panel, the decision
	and missing modals, the turn log and markdown rendering, the shared
	Action bar and control catalogue, the Key guide and Message view, the
	shared pane geometry, the shared palette, message facts, and
	display-width-aware text helpers.
- `test/`: the test suite.
	The seam is the rendered terminal frame and the recorded command sequence.
	No test touches a real herdr session or a real git repository.