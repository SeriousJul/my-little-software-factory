# ADR 0090: The tag's version is the release's version, and the workflow syncs the manifests to it

Status: accepted
Date: 2026-10-02
Supersedes in part ADR 0020: the requirement that the tag already equal the version both package manifests declare no longer holds. The tag as the release trigger, the trusted-publishing grant, and the short alias package stand.

## Context

ADR 0020 makes the release tag driven: a `v*` tag runs the checks, publishes both packages, and builds and uploads the binaries. It also requires the tag to equal the version both package manifests declare, so a tag and a manifest can never name different releases. That requirement puts a local step in the release path: before the operator cuts the tag, someone must edit `package.json` and `packages/mlsf/package.json` (three version fields between them), commit, and push.

The operator cuts the tag from the GitHub interface, and the interface offers no edit box for a manifest. The v0.0.2 cut of 2026-10-02 met the requirement exactly as it was written: the tag named `0.0.2`, the manifests in the tagged tree declared `0.1.0`, and the tag check stopped the run before any publish. The release then needed a human to re-do the local step and re-cut the tag, which is the failure the interface-first operator cannot absorb.

## Decision

**The tag's version is the release's version.** The operator's one release action is to cut the tag from the GitHub interface; no manifest is edited by hand first.

The release workflow writes the tag's version into both manifests before any step reads or writes a version. The write is a checked-in script (`scripts/sync-release-version.ts`), and every job that touches a version runs it first: the checks job before its gates, each build leg before it compiles (the compile stamps the manifest's version into the binary and the smoke compares it with the tag), and the publish job before it publishes (the publish reads the version it publishes from the manifest). The write moves exactly two kinds of field: the `version` of each manifest and the alias's exact pin on `my-little-software-factory`. A manifest that already carries the version is left byte-identical, so a re-run re-syncs nothing.

The checks job is the one job that lands the sync outside the tag's tree: where the write moved a field, it commits the two manifests and pushes the commit to `main`, so a later read of the repository agrees with the release. The push is a plain push from the tag's tree, and a `main` that moved on since the cut refuses it. A refused push stops the release instead of merging two histories the operator never asked for: the operator re-cuts the tag from the newer `main`.

The tag check the ADR 0020 wording stood stays in the checks job, now as a tripwire over the sync: after the write, the check fails only where the sync itself broke.

## Considered alternatives

- Keeping the manual bump and documenting it better was not acceptable: the release path then holds a step only a repository checkout can do, and the interface-first operator meets the failure every time the two disagree.
- Deriving the version from the tag in every step instead of writing it was not acceptable: the npm publish reads the manifest, and a derived version that the manifest never carries would publish a package whose manifest names the wrong release.
