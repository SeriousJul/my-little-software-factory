---
title: Minimal Config
description: The config file paths, the shipped defaults, a working ticket source, and how to extend the workflow template.
---

# Minimal Config

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
and `claude` agent types, the four workflow task types, the three security
task types, the states of the label workflow plus one state per security
source kind, and one `consult` Consultation type that passes your input
straight through.
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
`github-issues` or `github-pull-requests`, or one of the security feed kinds
`github-security-advisories`, `github-dependabot-alerts`, and
`github-secret-scanning-alerts`: the three kinds read the repository security
tab, each item appears as one ticket, and the shipped machine already routes
each kind to its resolve task type. The security feed kinds take no
`filter`. The `refresh-interval-seconds` sets how often the control plane
refreshes the source. The source reads the labels on each ticket; [the
ticket labels](../development/labels.md) name what each label
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
write no workflow labels, so a prompt template names none. The machine carries
the four task types `implement`, `review`, `rework`, and `merge`, plus the
three security task types `resolve-security-advisory`,
`resolve-dependabot-alert`, and `resolve-secret-scanning-alert`.

The shipped machine is the label workflow. Its states are ordered and the
first match wins:

| State | When | Task type |
| ----- | ---- | --------- |
| 1 | An open issue carries the `ready-for-agent` label. | `implement` |
| 2 | A pull request carries the `needs-work` label. | `rework` |
| 3 | A pull request carries the `ready-for-review` label. | `review` |
| 4 | A pull request carries the `ready-to-ship` label. | `merge` |
| 5 | A ticket comes from a `github-security-advisories` source. | `resolve-security-advisory` |
| 6 | A ticket comes from a `github-dependabot-alerts` source. | `resolve-dependabot-alert` |
| 7 | A ticket comes from a `github-secret-scanning-alerts` source. | `resolve-secret-scanning-alert` |
| 8 | A pull request carries none of them. | none: the plane waits |

A state with no `task-type` is a parking state: the plane suggests nothing
for a ticket that sits there, and a label write is the only thing that moves
it. The last state is what holds a pull request someone else opened until a
transition or a human puts it in the machine. A completed security turn rests
its ticket on the same-type hold while the finding still lists upstream.

A `[task-types.<name>.transition]` table is what happens when a turn of that
type completes: the plane writes the transition's labels on the ticket, and on
the pull request the ticket links, and the machine re-derives every position
from the labels it wrote. The write is a convergence of the machine's own
labels: it adds the named facts and removes the labels the machine's writes
name that the facts do not, and a scoping label a state match names but no
transition writes - such as a `labels-all` gate - is left alone. The labels
your machine writes must exist in the repository before a fire can succeed:
a write that names a missing label fails, and [the ticket labels page](../development/labels.md)
carries the one command that creates them. The shipped transitions move an
implemented issue's pull request to `ready-for-review`, decide a review by its
score against `score-threshold` (90 in the shipped machine, and the one place
that number lives), send a blocked merge back to `needs-work`, and move an
opened security fix's pull request to `ready-for-review` and into its review
position.

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

The writes run as the source's own authentication: the `[sources.auth]` table
of the source the item lists on is the credential the plane's `gh edit`
carries, so the plane's writes and its reads come from the same account.
