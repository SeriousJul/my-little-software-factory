---
title: Commands
description: The bun commands of the repository, the shared control gallery, and the guide screenshots.
---

# Commands

| Command               | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `bun run dev`         | Start the control plane in watch mode                  |
| `bun test`            | Run the full test suite                                |
| `bun run gallery`     | Run the shared control gallery, using the real modules |
| `bun run lint`        | Lint and check formatting with Biome                   |
| `bun run fmt`         | Lint, format, and fix with Biome                       |
| `bun run typecheck`   | Typecheck with TypeScript                              |
| `bun run screenshots` | Regenerate the guide screenshots from fixture state     |

`bun run dev` runs the source tree; it reads
`config/development.toml` through `--config` and watches the tree while it
runs.

## Shared control gallery

`bun run gallery` opens the shared control gallery: every control the control
plane owns, drawn by the production modules and answering the production keys.
`Tab` shows the next example, and each one names its own state - normal and
focused, invalid, unavailable, loading, Type-ahead search, and narrow. Pass an
example name to land on it: `bun run gallery -- fields`. The gallery reads no
config file, opens no state, and starts no Agent, and the same examples are
exercised by `bun test`, so a gallery row cannot become an imitation of the
control. See [the shared control standard](./shared-controls.md).

## Regenerating the screenshots

`bun run screenshots` rebuilds the images the
[operation guide](../operation/main-view.md) shows: the fixture world, the
production binary on a pseudo-terminal, the production keys, and the
cell-grid render. The drift test in `bun test` reruns the same path and fails
when a committed image no longer matches the screen, so a screen change
always lands with its image.
