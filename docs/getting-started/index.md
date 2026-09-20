---
title: Getting Started
description: Start the control plane with npx, and shape the Default configuration to your workflow.
---

# Getting Started

The control plane ships through npm. You install nothing: `npx` runs the
current published version, and the first start writes the config file that
the rest of this guide edits.

## Requirements

- Node `26.4.0` or newer. Below the floor the start fails with the required
  version and the reason: the OpenTUI renderer loads `node:ffi`, which Node
  gates behind `--experimental-ffi`.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH`. The control
  plane drives it through its CLI and never starts an agent process itself.
- The agent CLI of each agent type you use, with its own provider auth
  applied.

## Start the control plane

Run either name; both start the same app:

```sh
npx my-little-software-factory
npx mlsf
```

On the first start the app finds no config file, writes the [Default
configuration](#the-config-file) to
`~/.config/my-little-software-factory/config.toml`, and says so on the start
lines before the interface appears. The start lines name the path, so you
know where to edit.

A second start reads the file. A line that does not parse or does not
validate stops the start with one readable error line. A present file must
carry every required key, and a key the control plane does not read is an
error, so a typo surfaces at the start, not at handoff time.

## The Config file

The config lives at:

```
~/.config/my-little-software-factory/config.toml
```

or at the path the `--config` flag names:

```sh
npx my-little-software-factory --config /path/to/config.toml
```

The state file lives at:

```
~/.local/state/my-little-software-factory/state.sqlite
```

or at the path `$XDG_STATE_HOME/my-little-software-factory/state.sqlite`
when the environment sets it, or at the path the `state-file` key names when
the config sets one.

The shipped Default configuration carries a working control plane and the
parts it cannot know about your machine: no ticket sources, no repository
mappings, and no `state-file` key. Everything else is on: the `pi`, `codex`,
and `claude` agent types, the four workflow task types, the three task rules,
and one `consult` Consultation type that passes your input straight through.
The [configuration key reference](../configuration/index.md#key-reference) names every key,
its default, and what it does.

## Upgrading an older install

An install whose Config file still carries `[[task-rules]]` or `workflows`
is rewritten once, at load (ADR 0027). The rules become states, an edge whose
target one state offers becomes that task type's transition, the shipped task
templates are replaced when they match the old seed exactly, and the shipped
machine's parking state comes over with them. The rewrite is validated before
anything is written, and it leaves two files beside the config: the
pre-migration `config.toml.bak`, and `config.toml.migration-report.md`, which
names every state, transition, dropped edge, and untouched template. A
failure there stops the control plane with your file unchanged. The start
line states the migration once, and a config that still carries an old key
after it is one readable config error.

## Add a ticket source

The Default configuration holds a commented-out source block where you add
your own. Unmark it and edit the `repositories` list to your
`owner/name` values:

```toml
[[sources]]
name = "issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = ["owner/name", "owner/other"]
```

The `name` is what the interface shows. The `kind` is
`github-issues` or `github-pull-requests`. The `refresh-interval-seconds`
sets how often the control plane refreshes the source. The source reads the
labels on each ticket; [docs/labels.md](../labels.md) names what each label
means to the control plane.

Repository checkout paths live in the `repos` table, one key per
`owner/name`:

```toml
[repos]
"owner/name" = "~/src/name"
```

## Extend the workflow machine

The states and the task-type transitions of the Default configuration are the
workflow machine, and the file marks them as meant to be extended. The plane
owns the workflow labels: it reads a ticket's position from the labels it
carries, and it writes those labels itself when a task completes. The agents
write no workflow labels, so a prompt template names none.

The shipped machine is the label workflow. Its states are ordered and the
first match wins:

| State | When | Task type |
| ----- | ---- | --------- |
| 1 | An open issue carries the `ready-for-agent` label. | `implement` |
| 2 | A pull request carries the `needs-work` label. | `rework` |
| 3 | A pull request carries the `ready-for-review` label. | `review` |
| 4 | A pull request carries the `ready-to-ship` label. | `merge` |
| 5 | A pull request carries none of them. | none: the plane waits |

A state with no `task-type` is a parking state: the plane suggests nothing
for a ticket that sits there, and a label write is the only thing that moves
it. The fifth state is what holds a pull request someone else opened until a
transition or a human puts it in the machine.

A `[task-types.<name>.transition]` table is what happens when a turn of that
type completes: the plane writes the transition's labels on the ticket, and on
the pull request the ticket links, and the machine re-derives every position
from the labels it wrote. The write is a convergence, not an addition: after
it runs, the surface wears exactly the labels the transition named, and labels
outside the machine are left alone. The shipped transitions move an
implemented issue's pull request to `ready-for-review`, decide a review by its
score against `score-threshold` (90 in the shipped machine, and the one place
that number lives), and send a blocked merge back to `needs-work`.

Add your own task type with a `[task-types.<name>]` table. The `template`
carries the prompt body, and the `{placeholders}` name the ticket facts the
control plane fills in. Add a state that routes a ticket to it, and a
transition on the type that completes it:

```toml
[task-types.my-type]
template = "My prompt for {title}."
[task-types.my-type.transition]
ticket-facts = ["my-label"]
pull-request-facts = []

[[states]]
name = "mine"
task-type = "my-type"
[states.match]
source-kind = "github-pull-request"
labels-any = ["my-label"]
```

A ticket no state matches takes the `default-task-type`, and that task type's
transition fires the same way: the completion behavior follows the task type
to whatever ticket it runs on.
