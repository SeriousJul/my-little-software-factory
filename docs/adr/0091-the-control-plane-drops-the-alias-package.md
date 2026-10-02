# ADR 0091: The control plane drops the alias package

**Status:** accepted
**Date:** 2026-10-02

## Context

ADR 0020 published two npm packages for one release: `my-little-software-factory`, which carries the installer, and the short alias `mlsf`, which re-runs the main package's bin so `factory` stayed a short name on the registry where that name is taken.

The alias never made it to the registry. Measured on 2026-10-02 while setting up trusted publishing, the name `mlsf` is frozen on the public registry: `npm view mlsf` answers 404, staging `mlsf` at any version fails with a registry error that names the version-uniqueness check, while brand-new sibling names, four-letter and long, staged in the same seconds. The registry will not let anyone claim the name, and the name is not usable for the package.

## Decision

**The alias package is dropped.** The release publishes one package, `my-little-software-factory`, and the access path is `npx my-little-software-factory`. The alias package, its launcher, and its tests leave the tree; the installer's own error prefix moves from the alias's short name to the binary's name, `factory:`.

## Consequences

- The release workflow publishes, checks, and syncs one package. The version sync in ADR 0090 moves one field, the main manifest's `version`; the alias's pin clause no longer applies.
- The npm trusted publishing setup grants the workflow on one package name, and the one-time placeholder is one staged and approved version instead of two.
- `factory` stays a taken npm name. If the registry ever frees it or `mlsf`, taking the short name back is a new decision, not a revival of this one.
- The alias launcher's signal-path fix and its verification record stand as the history of code that is no longer shipped; the record says so where it names the file.

## Considered alternatives

- Keeping the alias on a different short name was possible: several candidates were free on the registry on 2026-10-02. Not acceptable as the default: the short name earns its keep only if the operator actually types it, and the name the repository had settled on was the one the registry would not give. The operator chose the full name over a coinage.
- Filing a support ticket with npm to unfreeze `mlsf` was open. Not acceptable as the path: the answer is slow and uncertain, and the first release does not wait on a registry name.
