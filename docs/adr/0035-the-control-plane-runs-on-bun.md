# ADR 0035: The control plane runs on Bun

Status: accepted
Date: 2026-09-19

## Context

The control plane renders through OpenTUI, whose native core talks to the
terminal through FFI: it opens the pseudo-terminal and reads the terminal's
state directly. On the Node runtime that FFI is experimental and gated behind
the `--experimental-ffi` flag, so the bin had to check the version, re-spawn
itself with the flag, and hand the process across the boundary before the
renderer could load. Node's SQLite binding added a second problem: the
node:sqlite use-after-free in Node 26.5.0 crashed a mutation run, and a crash
guard had to contain the orphaned children.

Bun ships stable, built-in FFI (`bun:ffi`) and SQLite (`bun:sqlite`) with no
flag and no re-spawn. OpenCode, the production OpenTUI application, runs on
Bun for exactly this reason. The version gate and the re-spawn wrapper exist
only to satisfy Node's experimental FFI; on Bun they are dead weight.

The test suite ran on Vitest. It drives the real terminal through FFI for the
PTY tests and the real state file through SQLite for the state tests, so the
runner already needed both bindings. Bun's built-in test runner (`bun:test`)
provides them in the same runtime as the app, so one runtime covers the app,
the PTY tests, and the state tests.

## Decision

**The control plane runs on Bun `1.3.0` or newer, replacing Node.** The bin
checks the floor against `Bun.version` and, on a pass, runs the production
entry in the same process. There is no re-spawn and no `--experimental-ffi`
flag: Bun's FFI is stable and built in.

**The test suite runs on `bun:test`, replacing Vitest.** The PTY tests open
the terminal through `bun:ffi`; the state tests open the state file through
`bun:sqlite`. One runtime drives the app and every test that touches a native
binding.

**Bun owns the package.** Dependencies install through `bun install` against
`bun.lock`, and the scripts run on Bun, including the VitePress docs build.
Node stays for the two things only Node does: the `npm publish` of the
release, and the `npx` bootstrap of the launcher, which then hands the app to
Bun on the `PATH`.

ADR 0001's framework choice - OpenTUI and its first-party React binding, in
plain TypeScript with no build step - is preserved. This ADR supersedes the
runtime (Node) and the test runner (vitest) that 0001 named.

## Consequences

- The version gate is a simple floor check against `Bun.version`; the
  re-spawn wrapper and the `--experimental-ffi` flag are gone.
- FFI and SQLite are stable and flag-free. The node:sqlite 26.5.0 use-after-free
  that drove the crash guard is no longer the operating mode; the guard stays
  as a general containment tool for a native crash in the OpenTUI core.
- `bun:sqlite` reports a missing row as `null`, not `undefined`, so the state
  layer's no-row checks test for null.
- The npm alias (`npx mlsf`) bootstraps on Node and re-execs the app under
  Bun, so a machine needs both runtimes for the `npx` path; a global install
  runs the app on Bun alone.
- The Strykr mutation-testing setup is removed with the swap: its containment
  rode on the node:sqlite crash that Bun removes, and Strykr's instrumentation
  of a Bun process is unverified. Re-adding mutation testing on Bun is tracked
  separately, as is a prebuilt binary distribution.
