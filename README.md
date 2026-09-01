# my-little-software-factory

The control plane of my little software factory.
It is a terminal app that observes the factory and issues work.
It watches tickets and hands them off to agents.

It fetches configured GitHub issue and pull request sources, stores factory
state in SQLite, and refreshes each source without resetting a ticket's work
cycle. Enter hands an actionable open ticket off through herdr. The `e` key
opens the override panel for a one-shot change of the handoff settings.

See `CONTEXT.md` for the domain language, `docs/labels.md` for source-label
meaning, and `docs/adr/` for the decisions (ADR 0001: OpenTUI and TypeScript,
ADR 0002: handoffs run through herdr).

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
| `Enter`          | Hand the selected open ticket off with the config defaults              |
| `e`              | Open the override panel for the selected open ticket                    |
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

## Layout

Two panes side by side, flex-sized to the terminal.
The list pane on the left shows every ticket with its state badge, title,
and repository.
The detail pane on the right shows the full detail of the selected ticket:
repository, ticket state, assigned agent, source name, source kind, external
key, source state, URL, labels, and source health. Factory ticket state and
external source state stay separate.
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
working, a second handoff is refused until the first one settles, and `e` is
refused with a hint on the line.

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

## Configuration

The config lives at `~/.config/factory/config.toml`. A missing file yields
the shipped defaults, so the control plane starts with no config at all, and
the start says so before the UI takes over, with the path to put a file at.
A file that does not parse or does not validate stops the control plane
with a readable error before the UI starts: every key the control plane
reads must be present, and every key it does not read is an error, so a
typo surfaces at startup, not at handoff time.

The config carries the defaults a handoff starts from (`default-agent`,
`default-environment`, `default-task-type`), agent types, task types,
repository mappings, ticket sources, ordered task rules, and an optional
`state-file`. A source has a unique name, a GitHub adapter kind
(`github-issues` or `github-pull-requests`), repositories, and a positive
`refresh-interval-seconds`. Sources can use normal `gh` authentication, a
literal token, a token environment variable, or a named authenticated account.
The shipped defaults have no sources. `config/development.toml` configures the
live development path for this repository through `--config`. A template's
brace pairs are placeholders. Task types know `{repository}`, `{title}`,
`{description}`, `{source-kind}`, `{external-key}`, `{source-url}`, and
`{labels}`. A task type can also set a `thinking` level. A handoff then
starts on that level, and the override panel shows it as the starting value
of the thinking row. Any other brace pair is a startup error, so a `{ticket-id}`
cannot stay literal in the prompt an agent receives. Repository mappings are
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
- `src/state.ts`: SQLite migrations, source reconciliation, work cycles,
  handoff attempts, and the process lease.
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
  pane, the override panel, the shared pane geometry, the shared palette,
  and the display-width-aware text helpers.
- `test/`: the test suite.
  The seam is the rendered terminal frame and the recorded command sequence.
  No test touches a real herdr session or a real git repository.
