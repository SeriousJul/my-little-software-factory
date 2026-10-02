---
title: Contributing
description: The development pages and the architecture decision records.
---

# Contributing

You are building the control plane, not running it. The development pages
carry the standards and the day-to-day commands, and the architecture
decision records carry the mechanics the operator pages do not.

## Development

- [Commands](../development/commands.md) - the repository's commands: build,
  test, the shared control gallery, the screenshots, and the site.
- [The shared control standard](../development/shared-controls.md) - the
  contract a control screen must keep, and the shared control library that
  answers for it.
- [Mutation testing](../development/mutation-testing.md) - what a mutation
  campaign measures, how to run one, and the budget a run costs.
- [The ticket labels](../development/labels.md) - the labels the workflow
  machine reads and writes, and how to make a repository factory-ready.

## Architecture decisions

- [The ADR index](../adr/index.md) - every decision the project made and
  why, in name order. Each entry is one decision; the body states the
  context, the decision, and the consequences. New decisions append to the
  end of the list.
