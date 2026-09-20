# Release verification

Status: the automated checks pass. The publish itself is not verified: the
first release runs on the first `v*` tag, after the one-time npm trusted
publishing setup.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [ADR 0020](../adr/0020-the-control-plane-publishes-from-a-version-tag-with-a-short-alias-package.md)
for the release mechanism and the alias package.

## What is verified automatically

These checks run in `bun run test` and the docs build.

| Requirement | Checked by | Result |
| --- | --- | --- |
| A missing Config file is seeded at the path from the shipped Default configuration, verbatim, and the load reports that it seeded | `test/config.test.ts`, `test/startup.test.ts` | Passed |
| The checked-in Default configuration validates through the seam and carries the four workflow task types, the three task rules, the `consult` Consultation type, zero ticket sources, and zero repository mappings | `test/config.test.ts` | Passed |
| The Default configuration keeps the development config minus the repository mappings, the ticket sources, the personal Consultation type, and the state file entry | diffed against `config/development.toml` by the author | Passed |
| The default Config path and the default state path live under the project name, and the state path honors the XDG state home | `test/config.test.ts` | Passed |
| The Node version gate accepts versions at and above the floor, rejects versions below it, and the failure message names the required version, the actual one, and the reason | `test/runtime.test.ts` | Passed |
| A missing config starts the real executable through a pseudo-terminal with the seed note, and the control plane UI comes up on the seeded config | `test/executable.test.ts` | Passed |
| A `v*` tag runs lint, typecheck, the tests, and the docs build before any publish step, and a failed check stops the workflow | `.github/workflows/release.yml` structure, reviewed | Measured by inspection |

## What is verified at the first publish

The alias launcher, the bin entry spawn path, the workflow itself, the
trusted publishing grant, and the provenance attestations have no unit seam.
They are verified on the first `v*` tag, after the one-time npm trusted
publishing setup that grants publish permission for both package names to
this repository. Until that tag runs, every row below is incomplete.

| Requirement | How it is measured | Result |
| --- | --- | --- |
| `npx my-little-software-factory` starts the control plane on a machine with no repository checkout | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| `npx mlsf` starts the same app, through the alias launcher | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| The first start seeds the Config file at `~/.config/my-little-software-factory/config.toml` and the start lines carry the seed note | Inspect the file and the start lines after the first run | Incomplete |
| The published package carries provenance naming this repository and the release commit | `npm view` with the attestations for both package versions | Incomplete |
| A tag whose version does not match the manifests stops before any publish | The workflow's tag check step fails the run | Incomplete |

## Notes

- The npm name `factory` is taken on the public registry. That is why the
  short access path is the separate `mlsf` alias.
- The one-time trusted publishing setup is interactive on the npm account
  side and is guided by a wizard the maintainer runs before the first tag.
- The first release is `0.1.0`, the version the package already declares.
  Both manifests must match the tag; the workflow checks it.
