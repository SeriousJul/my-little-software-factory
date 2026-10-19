---
title: Commands
description: The bun commands of the repository, the shared control gallery, and the guide screenshots.
---

# Commands

| Command               | What it does                                          |
| --------------------- | ----------------------------------------------------- |
| `bun run dev`         | Start the control plane in watch mode                  |
| `bun run test`        | Run the full test suite, watched for a spinning worker   |
| `bun run test:changed`| Run only the test files the current changes affect     |
| `bun run gallery`     | Run the shared control gallery, using the real modules |
| `bun run mutate`      | Run a Stryker mutation campaign over `src`             |
| `bun run lint`        | Lint and check formatting with Biome                   |
| `bun run fmt`         | Lint, format, and fix with Biome                       |
| `bun run typecheck`   | Typecheck with TypeScript                              |
| `bun run audit`       | Run the Quality audit: type check, Biome, jscpd, and the code-scanning read, in one payload |
| `bun run build`       | Compile one prebuilt binary of the control plane        |
| `bun run screenshots` | Regenerate the guide screenshots from fixture state     |
| `bun run hero`        | Regenerate the documentation homepage's hero shot       |
| `bun run docs:dev`    | Start the documentation site in development mode        |
| `bun run docs:build`  | Build the documentation site                            |
| `bun run docs:preview`| Preview the built documentation site                    |

`bun run dev` runs the source tree; it reads
`config/development.toml` through `--config` and watches the tree while it
runs. A change to a watched file restarts the control plane inside the same
process, so the reload keeps the state file: the run gives the state lease back
when the watch signals it, and the next boot takes the lease again. Only the
files the run imports are watched, so the state file and the worktrees never
trigger a restart.

## The spin watch

`bun run test` runs the suite under a small watch
([`scripts/test-spin-watch.ts`](../../scripts/test-spin-watch.ts)): the same
`bun test` command, the same output, and a reader beside it that samples the
run's own processes every five seconds (issue #403, ADR 0138).

The watch reads the run's `bun test` parent - so a run that stands no
worker child, a single-file parallel run whose tests run in the parent, stands
in its sight - and the parent's test workers, matched on the `--test-worker`
argument of each child's argument list: the kernel joins a process's command
line with NUL bytes, and a spaced word of that byte string never matches the
arguments it holds, so the match stands on the argument list, not on a word of
the line.

A process whose thread holds a full CPU share on every beat of a sixty-second
window and makes no voluntary context switches in it is the spin the issue
measured: a spinning thread makes no system calls, and every turn a healthy
thread takes on a timer or a pipe is one. The watch reads the share against
the kernel's own clock ticks, which it reads by compiling a one-line helper
once, in the user's cache, the way `scripts/crash-guard.sh` builds its library,
and falls back to 100 when the read stands nowhere, naming which one stood. When
the signature stands, the watch prints the process's pid, its per-beat CPU
share, the switches the window held, and any dead child the process had left
unreaped; it takes the process down so the run can end, and the run exits red:
a run pulled out of a spin is not a green run. When the run ends, the watch
prints the set of processes it held in its sight over the run, so a green run
names the run it watched instead of standing silent, and a green run whose set
is empty says so.

The watch reads only the run's own parent and the parent's children. The run's
grandchildren - a check's own tmux server and pane, a stub a test spawns - stand
outside it, and a run standing beside another run on the same machine cannot
trip it. The watch stands only where it can read the processes' `/proc`
entries (Linux); elsewhere it passes the run through untouched, with the same
exit code. A `bun test` run outside this entry - the inner loop's `bun test <file>` and a hand-run suite - stands under no watch.

## Scoped run

`bun run test:changed` is the suite, scoped: it runs only the test files that
the current changes can affect, so a change to one or two files keeps the run
short. It is a speed tool for iteration; the push gate stays the full suite, run
once against the merged tree. See [the quality gate](./quality-gate.md) for the
two loops and what each one runs.

The base ref defaults to `origin/main` and is overridable with the
`TEST_CHANGED_BASE` environment variable, so work based on another branch
scopes against its real base: `TEST_CHANGED_BASE=origin/feature bun run
test:changed`. The run covers committed changes against the base, uncommitted
edits, and untracked test files, and it works on a detached head, so a herdr
worktree gets the same tool. A clean, up-to-date worktree matches nothing, and
the run says so.

## The pre-push hook

`scripts/git-hooks/pre-push` is the cheap half of the push gate (ADR 0105): it
runs `bun run lint` and `bun run typecheck`, about 0.6 s at head 30d603c4, and
refuses a push whose branch is behind the remote-tracking ref the checkout
already holds. It fetches nothing, and it never runs the suite.

A committed hook is not active by itself. Set it once per checkout:

```sh
git config core.hooksPath scripts/git-hooks
```

The hook prints which check ran, and a refusal names the rule it enforced. Do not
bypass it with `--no-verify`: CI runs the same checks, so a bypass only moves the
failure to a red check on the pull request.

The hook gates a contributor's push. The control plane's own pushes - the
ticket's factory branch at the Handoff start, and a Repository init's first
commit - name the bypass instead, because the hook reads the tree it stands in
and would refuse them for a dependency the checkout never installed
([ADR 0127](../adr/0127-the-plane-pushes-its-own-branches-outside-the-contributor-pre-push-hook.md)).

## Mutation testing

`bun run mutate` rewrites one expression at a time in `src` and runs the suite
against the rewritten copy, to answer the question a passing suite cannot: would
the tests notice a wrong program. A full campaign takes hours, so it is not part
of the push gate, and a run usually picks its own scope:
`bun run mutate -- "--mutate=src/domain/**"`. See
[mutation testing](./mutation-testing.md) for what a campaign measures and what
it costs, and [ADR 0055](../adr/0055-mutation-testing-runs-on-the-bun-test-runner.md)
for the setup and the measured budget.

## Prebuilt binary

`bun run build <target> --out <dir>` compiles the control plane into the
standalone executable the release publishes (ADR 0056), for one target:
`linux-x64`, `linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`,
`darwin-x64`, `darwin-arm64`, or `windows-x64`. It prints the usage line and
the target list when it is called without them.

```sh
bun install --omit=optional
bun run build linux-x64 --out dist
./dist/factory-$(node -p "require('./package.json').version")-linux-x64 --version
```

The build adds the target's OpenTUI native cores when they are not in
`node_modules`, with `--no-save`, and stops before the compile when the tree
holds a core the target must not embed. The compile embeds every core it can
resolve, so one build tree carries one target: after a leg for another target,
`bun install --omit=optional` clears the leftover cores back to the release's
tree, and the line the build prints names that command. The example above puts
that install first because it is the step every release leg runs; a tree already
carrying exactly the target's cores needs no reinstall. That add is what makes the core resolvable to the
bundler, not a size measure: `@opentui/core` names eight platform packages in
literal dynamic imports, and the bundler prunes the platform and arch tests per
`--target` but cannot prune the libc test, which reads `process.env.OPENTUI_LIBC`.
So a Linux leg places both libc variants and its binary carries both, and a
Darwin or Windows leg builds with one. Each release leg builds one target on a
clean runner (`bun install --omit=optional` first), and `bun run build` is the
same command the leg runs; the measured core count and byte size per target are
in [the release record](../verification/release.md). The app's runtime
libraries are development dependencies: the binary carries them, and the npm
package that installs the binary carries nothing but the installer.

## Shared control gallery

`bun run gallery` opens the shared control gallery: every control the control
plane owns, drawn by the production modules and answering the production keys.
`Tab` shows the next example, and each one names its own state - normal and
focused, invalid, unavailable, loading, Type-ahead search, and narrow. Pass an
example name to land on it: `bun run gallery -- fields`. The gallery reads no
config file, opens no state, and starts no Agent, and the same examples are
exercised by `bun run test`, so a gallery row cannot become an imitation of the
control. See [the shared control standard](./shared-controls.md).

## Regenerating the screenshots

`bun run screenshots` rebuilds the images the
[operation guide](../operation/main-view.md) shows: the fixture world, the
production binary on a pseudo-terminal, the production keys, and the
cell-grid render. The drift test in `bun run test` reruns the same path and fails
when a committed image no longer matches the screen, so a screen change
always lands with its image. The renderer rasterizes every glyph at run time
from the two vendored terminal faces, so a font change lands with the faces
and the images it moves (ADR 0123).

`bun run hero` refreshes the documentation homepage's hero shot: the same
fixture world, running in one pane of an isolated herdr workspace. The shot
is refreshed by hand and stays out of the drift test: herdr's chrome belongs
to herdr, and it changes when herdr changes.
