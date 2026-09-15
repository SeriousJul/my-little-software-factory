---
title: Commands
description: The npm commands of the repository, the shared control gallery, and the contained mutation testing.
---

# Commands

| Command                | What it does                                          |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Start the control plane in watch mode                  |
| `npm test`             | Run the full test suite                                |
| `npm run gallery`      | Run the shared control gallery, using the real modules |
| `npm run mutate`       | Run Stryker mutation testing, contained                |
| `npm run lint`         | Lint and check formatting with Biome                   |
| `npm run fmt`          | Lint, format, and fix with Biome                       |
| `npm run typecheck`    | Typecheck with TypeScript                              |
| `npm run screenshots`  | Regenerate the guide screenshots from fixture state     |

`npm run dev` runs the source tree; it reads
`config/development.toml` through `--config` and watches the tree while it
runs.

## Shared control gallery

`npm run gallery` opens the shared control gallery: every control the control
plane owns, drawn by the production modules and answering the production keys.
`Tab` shows the next example, and each one names its own state - normal and
focused, invalid, unavailable, loading, Type-ahead search, and narrow. Pass an
example name to land on it: `npm run gallery -- fields`. The gallery reads no
config file, opens no state, and starts no Agent, and the same examples are
exercised by `npm test`, so a gallery row cannot become an imitation of the
control. See [the shared control standard](../shared-controls.md).

## Mutation testing

`npm run mutate` runs Stryker through the crash guard
(`scripts/crash-guard.sh`). The suite spawns control plane processes, and a
native crash in the runner (the known case is the node:sqlite use-after-free
in node 26.5.0) would otherwise leave them orphaned under systemd and write
a core file for every death. The guard contains both: it runs the whole
process tree with core files disabled, so the OS records no crash, and when
Stryker exits, by success, failure, or crash, the guard terminates every
surviving process of the run. Extra arguments pass through to Stryker, such
as `npm run mutate -- --dryRunOnly`.

## Regenerating the screenshots

`npm run screenshots` rebuilds the images the
[operation guide](../operation/main-view.md) shows: the fixture world, the
production binary on a pseudo-terminal, the production keys, and the
cell-grid render. The drift test in `npm test` reruns the same path and fails
when a committed image no longer matches the screen, so a screen change
always lands with its image.
