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
The [README key reference](../../README.md#key-reference) names every key,
its default, and what it does.

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

## Extend the workflow template

The task types and task rules of the Default configuration form the workflow
template, and the file marks them as meant to be extended. The template
carries the four task types `implement`, `review`, `rework`, and `merge`,
and the three rules of the label workflow:

| Rule | When | Task type |
| ---- | ---- | --------- |
| 1 | A pull request carries the `needs-work` label. | `rework` |
| 2 | A pull request carries the `ready-for-review` label. | `review` |
| 3 | A pull request carries the `ready-to-ship` label. | `merge` |

Add your own task type with a `[task-types.<name>]` table. The `template`
carries the prompt body, and the `{placeholders}` name the ticket facts the
control plane fills in. Add a rule that routes a ticket to it:

```toml
[task-types.my-type]
template = "My prompt for {title}."

[[task-rules]]
task-type = "my-type"
[task-rules.when]
source-kind = "github-pull-request"
labels-any = ["my-label"]
```

The rules run in file order, and the first match wins. A ticket no rule
matches takes the `default-task-type`.
