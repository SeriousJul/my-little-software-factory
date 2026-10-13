# ADR 0137: The mutation campaign host runs the vendored typescript shim

Status: accepted
Date: 2026-10-13
Amends ADR 0055's campaign setup on one point of the host, not of the
campaign: the Stryker process resolves a vendored copy of the one typescript
function its ts-config preprocessor reads, so the campaign starts on the
typescript 7.0.2 this repository declares. The suite, the scope, and the
thresholds ADR 0055 fixed stand untouched.

## Context

The campaign's host process runs Stryker core on the Bun runtime. One part of
the host reads the repository's typescript: core's ts-config preprocessor
imports the bare specifier `typescript` from its own package and reads
`parseConfigFileTextToJson` from it. That is the parse it runs on the sandbox
copy's `tsconfig.json` before it rewrites the file's `extends`, `references`,
`include`, `exclude`, and `files` paths for the sandbox, and the preprocessor
runs before the campaign's scope is applied.

The typescript this repository declares is 7.0.2, the native compiler line
`bun run typecheck` and the Quality audit run (ADR 0120, ADR 0121). That line
exposes no compiler API: its entry stands on a version export and a compiler
process, and `parseConfigFileTextToJson` is not among its exports. A host that
resolves the top-level package therefore died at the campaign's first step
with `ts.parseConfigFileTextToJson is not a function`, and scoping the
campaign to a single file did not avoid it, because the preprocessor runs
either way (issue #377): no campaign, scoped or full, could start.

No release answers the native line. Stryker 10.0.0, the latest on the
registry, still reads the compiler API. And the declared version does not
move: ADR 0120 and ADR 0121 line the Quality audit and the type check on the
native line, and moving the repository's typescript to an older line to
satisfy one plugin's import would move the type check and the audit with it.

## Decision

The host resolves its own copy of the one function the preprocessor reads.
The checkout vendors a shim, `scripts/stryker-host-typescript`: a package
named `typescript` whose entry implements `parseConfigFileTextToJson` on a
small JSONC parse - plain JSON plus the comments and trailing commas the real
parse tolerates - and nothing else of the typescript API. `scripts/mutate.sh`
stages the shim at `node_modules/@stryker-mutator/core/node_modules/typescript`
before every run, where the preprocessor's import finds it before the
top-level 7.0.2, and it re-stages on every run because `bun install` can prune
a staged copy.

Bare-specifier resolution is per package, and the preprocessor is the only
`typescript` reader in the host process: the instrumenter and the Bun runner
plugin keep resolving the top-level line exactly as before. The declared
typescript, the type check, and the Quality audit stand untouched, and the
campaign measures the same suite, scope, and thresholds ADR 0055 fixed. The
shim touches no part of the instrumentation, the run, or the score.

## Consequences

- A campaign starts on the typescript 7.0.2 the repository declares. The
  crash of issue #377 stands closed, and the scoped campaign over the Handoff
  dispatch and the observation runs on this branch; its score stands in the
  [mutation-testing record](../verification/mutation-testing.md).
- The shim's surface is its contract. A Stryker release that reads more of
  the typescript API must widen the shim and its tests on purpose; the host
  never falls back to the native line, which carries no API to read.
- The staging stands in `node_modules`, which `bun install` rebuilds. The
  entry point owns the re-stage, and it refuses a campaign whose checkout lost
  the shim, so a tree cannot start the host on the top-level line again
  silently.
- The shim is not a compiler. It runs no type check and compiles nothing. It
  answers the one parse the preprocessor asks, and a tsconfig it cannot read
  answers `config: undefined`, the same answer the preprocessor gives a file
  it cannot rewrite.
