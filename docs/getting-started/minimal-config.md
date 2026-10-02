---
title: Minimal Config
description: The config file paths, the shipped defaults, a working ticket source and repository mapping, and where the workflow machine lives.
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

A config file from an older install migrates once at load, and the start line
says so when it runs.

The shipped Default configuration is a working control plane with the parts
it cannot know about your machine left out - no ticket sources and no
repository mappings. Everything else is on:

- the three agent types `pi`, `codex`, and `claude`
- the four workflow task types: `implement`, `review`, `rework`, and `merge`
- the three security task types, one per security feed source kind
- the workflow's states and the transitions that move a ticket between them
- the `consult` and `pair` Consultation types: `consult` passes your input
  straight through, and `pair` runs a pair programming session with the agent
  as the driver

[The key reference](../configuration/index.md#key-reference) names every key,
its default, and what it does.

## Add a ticket source and a repository mapping

Unmark the commented source block in your config file and edit the
`repositories` list to your `owner/name` values:

```toml
[[sources]]
name = "issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = ["owner/name"]
```

Map where the repository's checkout lives, one key per `owner/name`:

```toml
[repos]
"owner/name" = "~/src/name"
```

Once a repository is mapped, the
[Repository init](../development/labels.md#making-a-repository-factory-ready)
(`i` on the repository's Group header, grouped by repository) makes it
factory-ready: it creates the labels your machine writes, writes the
convention files, and registers the repository's sources. A repository the
factory has not seen yet stands in no Group: press `o` in the main view, type
to find the repository, and press Enter. The repository needs a local clone
on the path the plane names; the plane never clones.

## Extend the workflow machine

The `[[states]]` tables and each task type's `transition` table are where the
machine's states and transitions live in your config, and the file marks them
as meant to be extended. The plane owns the workflow labels: it reads a
ticket's position from the labels the ticket carries, and it writes those
labels when a task completes, so the agents write no workflow labels.
[The Configuration page](../configuration/index.md) carries the complete
example and the key reference for every state, transition, and task type key.
