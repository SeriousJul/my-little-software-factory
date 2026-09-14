# ADR 0020: The control plane publishes from a version tag with a short alias package

Status: accepted
Date: 2026-09-14

## Context

The control plane could only be run by cloning this repository. An operator
who wanted the factory had no install path: no package on the public npm
registry, no release mechanism, and no sensible default configuration.

Two constraints shaped the decision. The npm name `factory` is taken, so the
short access path cannot be the main package name. And a maintainer account
should not carry a long-lived npm token: the publish permission should live
in the relationship between the npm account and this repository, not in a
secret.

## Decision

The control plane is published to the public npm registry under
`my-little-software-factory`, and a second package `mlsf` is its short alias.
An operator installs nothing and starts the app with
`npx my-little-software-factory` or `npx mlsf`.

The release is tag driven. A GitHub Actions workflow runs on tags matching
`v*`, runs lint, typecheck, the test suite, and the docs build, then publishes
both packages. Any failed check stops the publish. The tag must equal the
version both package manifests declare, so a tag and a manifest can never
name different releases.

Publishing uses OIDC trusted publishing with `npm publish --provenance`. No
npm token is stored in the repository or the account. The npm account grants
publish permission for both package names to this repository once, and the
registry checks the workflow's identity for every publish. The provenance
attestation names this repository and the commit, so a consumer can verify
what built a package.

The alias package lives in the `packages/` folder of this repository. It is
two files: a manifest with a pinned dependency on
`my-little-software-factory`, and a bin script that reads the main package's
own bin declaration and re-execs that bin with the operator's arguments. The
alias adds no behavior of its own, and it pins the exact version it ships
with, so `npx mlsf` and `npx my-little-software-factory` are the same
command.

On first run the control plane seeds its Config file from a Default
configuration checked in and shipped inside the package, at the standard
path, and loads the seeded file through the normal parse and validate path.
The in-code default config object is deleted so the two copies can never
drift. The standard paths live under the project name:
`~/.config/my-little-software-factory/config.toml`, and the state file under
`~/.local/state/my-little-software-factory/state.sqlite`, honoring the XDG
state home. No migration code is written: the package was never published,
and the maintainer's live config and state get a one-time manual move.

## Considered alternatives

- Publishing under the name `factory` was not possible: the name is taken on
  the public registry.
- A personal npm token in a GitHub secret was rejected because it is a
  long-lived credential that grants publish rights outside this repository's
  workflow, and it outlives any single release.
- Making `mlsf` a full copy of the package was rejected because two copies
  of the same app can drift, and the copy would need its own release.
- A version range in the alias manifest was rejected because a range pulls
  a newer main package at install time without the alias being republished,
  so the alias would silently change behavior under the same version.
- Publishing on push to `main` was rejected because a release is a decision,
  and one tag must name exactly one release.

## Consequences

- A release is one tag. The workflow is the only publish path, and a broken
  build never reaches the registry.
- The published package exposes the `factory` bin only. The gallery bin
  stays a development command of this repository.
- The bin entry checks the Node version before it launches, with a helper
  the refused runtimes can still load, so an operator below the floor gets
  the required version and the reason.
- The first publish verifies the parts no unit seam covers: the alias
  launcher, the bin spawn path, and the provenance attestation. The results
  live in the [release verification record](../verification/release.md).
- The maintainer performs the one-time npm trusted publishing setup before
  the first tag. Until then the workflow would fail at the publish step, not
  before the checks.
