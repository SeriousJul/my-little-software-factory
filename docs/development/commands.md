---
title: Commands
description: The bun commands of the repository, the shared control gallery, and the guide screenshots.
---

# Commands

| Command               | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `bun run dev`         | Start the control plane in watch mode                  |
| `bun test`            | Run the full test suite                                |
| `bun run test:changed`| Run only the test files the current changes affect     |
| `bun run gallery`     | Run the shared control gallery, using the real modules |
| `bun run lint`        | Lint and check formatting with Biome                   |
| `bun run fmt`         | Lint, format, and fix with Biome                       |
| `bun run typecheck`   | Typecheck with TypeScript                              |
| `bun run screenshots` | Regenerate the guide screenshots from fixture state     |

`bun run dev` runs the source tree; it reads
`config/development.toml` through `--config` and watches the tree while it
runs. A change to a watched file restarts the control plane inside the same
process, so the reload keeps the state file: the run gives the state lease back
when the watch signals it, and the next boot takes the lease again. Only the
files the run imports are watched, so the state file and the worktrees never
trigger a restart.

## Scoped run

`bun run test:changed` is the suite, scoped: it runs only the test files that
the current changes can affect, so a change to one or two files keeps the run
short. It is a speed tool for iteration; the push gate stays the full suite.

The base ref defaults to `origin/main` and is overridable with the
`TEST_CHANGED_BASE` environment variable, so work based on another branch
scopes against its real base: `TEST_CHANGED_BASE=origin/feature bun run
test:changed`. The run covers committed changes against the base, uncommitted
edits, and untracked test files, and it works on a detached head, so a herdr
worktree gets the same tool. A clean, up-to-date worktree matches nothing, and
the run says so.

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
