# my-little-software-factory

The control plane of my little software factory.
It is a terminal app that observes the factory and issues work.
It watches tickets and hands them off to agents.

It fetches configured GitHub issue and pull request sources, stores factory
state in SQLite, and refreshes each source without resetting a ticket's work
cycle. Enter hands an actionable open ticket off through herdr. The `e` key
opens the override panel for a one-shot change of the handoff settings.

The control plane polls herdr for the agents it started. It marks a blocked
agent and a missing agent on the ticket, captures the agent's last message
when a turn settles, and records a completion trace. In auto-handoff mode it
hands eligible open tickets off by itself within the configured limits, and
routes or closes completed turns along the configured workflows.

See `CONTEXT.md` for the domain language, `docs/labels.md` for source-label
meaning, and `docs/adr/` for the decisions (ADR 0001: OpenTUI and
TypeScript, ADR 0002: handoffs run through herdr, ADR 0005: a work cycle
ends at close, ADR 0006: the control plane polls herdr).

## Requirements

- node v26.4 or newer (developed on v26.5.0).
  The OpenTUI native renderer loads `node:ffi`, which node 26 still gates
  behind `--experimental-ffi`, and the `factory` binary re-execs node with that flag.
- The project pins the node version in `.tool-versions`.
  Run the commands through mise to get that version.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH` for handoffs.
  The control plane drives it through its CLI and never starts an agent
  process itself (ADR 0002).

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
| `j` / `k`        | Move the selection, or scroll the detail, depending on the focused pane |
| `Up` / `Down`    | Move the selection, or scroll the detail, depending on the focused pane |
| `h` / `l`        | Switch focus between the list and detail                                |
| `Left` / `Right` | Switch focus between the list and detail                                |
| `Enter`          | Hand the selected open ticket off, or open the decision panel on an awaiting ticket, or the missing panel on a ticket whose agent is gone, or focus the agent of a blocked ticket |
| `e`              | Open the override panel for the selected open ticket                    |
| `a`              | Toggle auto-handoff mode for this session                              |
| `r`              | Refresh every ticket source now                                        |
| `q`              | Quit                                                                    |

### Override panel keys

The panel is a modal. While it is open, the keys of the app below are inert.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `j` / `k`      | Move between the setting rows, or type into the selected free-text row |
| `Up` / `Down`  | Move between the setting rows                                     |
| `h` / `l`      | Cycle a list value, or type into the selected free-text row        |
| `Left` / `Right` | Cycle a list value (agent type, environment, task type, thinking) |
| typed text      | Edit the selected free-text row (model, or thinking without a list) |
| `Backspace`     | Delete in the selected free-text row                                |
| `Enter`         | Confirm: the handoff starts with these settings                     |
| `Esc`           | Cancel: nothing runs, nothing changes                               |

A free-text row owns `j`, `k`, `h`, and `l`, so `Up` and `Down` move the
selection past it.
A row shows `(empty)` for an unset free-text value and `(unset)` for a list
value that is not one of its options. The thinking row starts on the
suggested task type's `thinking` level when the task type sets one. The
operator picks another level, or clears a free-text row to leave the level
to the agent. Switching the task type row re-derives the thinking row from
the new task type's level while the operator has not set it, so the panel
always shows what the handoff will run on. The container environment is a
future kind and is not offered by the panel.

The panel sizes itself to the terminal. When the rows do not fit, the value
column shrinks first, then the label column, then the marker. When the
terminal is too small, the hint row and the last rows drop. A row never
wraps: it carries less, not broken text.

### Completion decision panel keys

Enter on an `awaiting` ticket shows the last completion: the agent's last
message. The panel offers the choices the state allows.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `Up` / `Down`  | Move between the choice rows                                      |
| `j` / `k`      | Scroll the completion message                                     |
| `Enter`         | Choose the selected row                                            |
| `Esc`           | Close the panel: nothing runs, the ticket stays awaiting           |

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

### Missing agent panel keys

Enter on a ticket whose agent is missing shows the missing panel.

| Key             | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `Up` / `Down`  | Move between the choice rows                                      |
| `j` / `k`      | Scroll the panel message                                          |
| `Enter`         | Choose the selected row                                            |
| `Esc`           | Close the panel: nothing runs, the badge stays                     |

"Restart" hands the ticket off again with the same choices, in the
workspace the handoff recorded, and the last completion's message as the
previous message. "Abandon" ends the work cycle: the ticket returns to open
with its cycle number incremented, the handoff's environment is closed,
and the missing badge clears.

## Layout

Two panes side by side, flex-sized to the terminal.
The list pane on the left shows every ticket with its state badge, title,
and repository.
The detail pane on the right shows the full detail of the selected ticket:
repository, ticket state, assigned agent, source name, source kind, external
key, source state, URL, labels, and source health. The detail also carries
the ticket's handoff count against its per-ticket limit, counting the
handoffs of every work cycle the ticket ran, and, when one exists, the last
completion: its date, the task type, the agent, and the recorded decision.
Factory ticket state and external source state stay separate.
The panes share one focus.
Switching focus never moves the selection.

The vertical keys act on the focused pane.
With the list focused, they move the selection.
With the detail focused, they scroll the detail, and a new selection starts
the detail at the top.
When the terminal is too narrow for a field, the field drops out of the row
instead of wrapping it.
When a list row cannot hold both, the title is kept and the repository
drops, so the title stays readable in a split terminal.

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

Enter on an open ticket starts a handoff with the config defaults.
The override panel changes them for that one handoff only.

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
  filesystem refuses) leaves the ticket open and shows the reason on the
  status line. The app never crashes on a handoff failure.

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

When the agent settles its turn (herdr reports it as done, or it is idle at
the end of the turn), the ticket moves to `awaiting`. The
completion trace records the task type, the agent, the completion time, the
last message, and the decision that ends the awaiting state. A workflow
handoff that follows an awaiting ticket renders its prompt with the
`{previous-message}` placeholder filled from that last message, so the next
agent reads what the previous one left behind.

In manual mode, `awaiting` waits for the operator. Enter opens the decision
panel. The operator routes the ticket to a workflow target or closes the
work cycle.

Auto-handoff mode decides without the operator, within the configured
limits:

- Automatic decisions apply to auto-close task types only, and they apply
  in both modes. A settled turn of an auto-close type routes when its task
  type has exactly one outgoing workflow edge with exactly one target, and
  the parallel limit has room. At the per-ticket handoff limit the route
  degrades to close. Zero or multiple edges close the cycle. A full
  parallel limit leaves the ticket awaiting until a slot frees.
- A task type that is not auto-close always leaves its settled turn
  awaiting for the operator, in both modes.
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
until the operator restarts or abandons from the missing panel. In manual
mode the control plane never touches a missing agent. Abandon ends the
work cycle, closes the handoff's environment, and returns the ticket to
open with its cycle number incremented.

## Configuration

The config lives at `~/.config/factory/config.toml`. A missing file yields
the shipped defaults, so the control plane starts with no config at all, and
the start says so before the UI takes over, with the path to put a file at.
A file that does not parse or does not validate stops the control plane
with a readable error before the UI starts: every key the control plane
reads must be present, and every key it does not read is an error, so a
typo surfaces at startup, not at handoff time.

The config carries the defaults a handoff starts from (`default-agent`,
`default-environment`, `default-task-type`), the auto-handoff startup value
(`auto-handoff`, default `false`), the parallel limit
(`max-parallel-agents`, default `2`), the herdr poll interval
(`agent-poll-interval-seconds`, default `5`), the completion message line
cap (`completion-message-lines`, default `200`), the per-ticket handoff limit
(`max-handoffs-per-ticket`, default `10`), the workflow edges (`workflows`),
agent types, task types, repository mappings, ticket sources, ordered task
rules, and an optional `state-file`. A source has a unique name, a GitHub adapter kind
(`github-issues` or `github-pull-requests`), repositories, and a positive
`refresh-interval-seconds`. Sources can use normal `gh` authentication, a
literal token, a token environment variable, or a named authenticated account.
The shipped defaults have no sources. `config/development.toml` configures the
live development path for this repository through `--config`. A template's
brace pairs are placeholders. Task types know `{repository}`, `{title}`,
`{description}`, `{source-kind}`, `{external-key}`, `{source-url}`,
`{labels}`, and `{previous-message}`. The last one is empty on a first
handoff and carries the previous agent's last message on a workflow handoff.
A task type can also set a `thinking` level. A handoff then
starts on that level, and the override panel shows it as the starting value
of the thinking row. Any other brace pair is a startup error, so a `{ticket-id}`
cannot stay literal in the prompt an agent receives.

A task type can set `auto-close = true`. For its completions the control
plane decides without the operator, in both modes: exactly one outgoing
workflow edge hands off with that task while the parallel limit has room,
any other edge count closes the cycle, and a route at the per-ticket
handoff limit degrades to close.

A `[[workflows]]` edge routes a completed task type to the next one. It
names the `from` task type, the list of `to` task types it may start, and
optionally pins the `agent` type and `environment` of the handoff it
triggers. Repository mappings are
the one section the control plane writes back: a sibling clone records its
path there. The write-back is
atomic: the config goes to a temp file in the same directory and the rename
over the target is one step, so a crash leaves either the old file or the
new one, never a truncated file the next start would reject. The write-back
serializes the whole config, so operator comments in the file are dropped at
the first write-back: the data round-trips, the comments do not.

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
  settles turns into `awaiting`, applies the automatic completion rule, and
  dispatches open tickets in auto-handoff mode.
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
  and the missing agent panel both render through it), the shared pane
  geometry, the shared palette, and the display-width-aware text helpers.
- `test/`: the test suite.
  The seam is the rendered terminal frame and the recorded command sequence.
  No test touches a real herdr session or a real git repository.
