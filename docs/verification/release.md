# Release verification

Status: the automated checks pass, including the installer, the build
script, and the shipped-default read of the prebuilt binary (ADR 0056). The
publish itself is not verified: the first release runs on the first `v*`
tag, after the one-time npm trusted publishing setup.

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
| The embedded read of the shipped Default configuration returns the checked-in file's text verbatim in a source run, and the text validates, so a first run always seeds a usable config | `test/shipped-default.test.ts` | Passed |
| The checked-in Default configuration validates through the seam and carries the four workflow task types with their transitions, five states of the label machine, the `consult` Consultation type, zero ticket sources, and zero repository mappings | `test/config.test.ts` | Passed |
| The Default configuration keeps the development config minus the repository mappings, the ticket sources, the personal Consultation type, and the state file entry | diffed against `config/development.toml` by the author | Passed |
| The default Config path and the default state path live under the project name, and the state path honors the XDG state home | `test/config.test.ts` | Passed |
| The Node version gate accepts versions at and above the floor, rejects versions below it, and the failure message names the required version, the actual one, and the reason | `test/runtime.test.ts` | Passed |
| A missing config starts the real executable through a pseudo-terminal with the seed note, and the control plane UI comes up on the seeded config | `test/executable.test.ts` | Passed |
| A `v*` tag runs lint, typecheck, the tests, and the docs build before any publish step, and a failed check stops the workflow | `.github/workflows/release.yml` structure, reviewed | Measured by inspection |
| The installer resolves every supported machine to a buildable target, and no machine resolves to a target the build does not publish | `test/installer.test.ts`, `test/build-binary.test.ts` | Passed |
| The producer and the consumer agree on the asset names, the checksums file name, and the download addresses | `test/installer.test.ts`, `test/build-binary.test.ts` (one `assetFileName` shared by both) | Passed |
| The checksums file is read before the asset, a mismatched or missing checksum installs nothing, and a verified asset lands at its cache path with its version note | `test/installer.test.ts`, with the network faked | Passed |
| The build command compiles the entry per target with the package's version stamped into the binary | `test/build-binary.test.ts` | Passed |
| The source run's `factory --version` reports the repository's package.json version | `test/version.test.ts` | Passed |
| A compiled `linux-x64` binary answers `factory --version` with the stamped version and seeds a missing config file from the embedded Default configuration, verbatim | The author compiled the binary and ran it on a pseudo-terminal (bun 1.4.2, linux-x64, 2026-09-22) | Passed |
| Every one of the seven targets cross-compiles from one Linux host through the release leg's exact steps, and the output is the true executable of each target | The author ran the release leg's install and build for all seven targets (bun 1.4.2, 2026-09-22) | Passed |
| Every release binary answers `--version` on its own operating system: `linux-x64` on its build runner, `linux-x64-musl` in an alpine container, `darwin-arm64` on macOS, `windows-x64` on Windows | The smoke jobs of `.github/workflows/release.yml`, run on every tag | Not measured until the first tag |

## What is verified at the first publish

The alias launcher, the installer's download and exec, the workflow itself,
the trusted publishing grant, and the provenance attestations have no unit
seam. They are verified on the first `v*` tag, after the one-time npm trusted
publishing setup that grants publish permission for both package names to
this repository. Until that tag runs, every row below is incomplete.

| Requirement | How it is measured | Result |
| --- | --- | --- |
| `npx my-little-software-factory` installs the prebuilt binary from the release and starts the control plane on a machine with no repository checkout and no Bun | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| `npx mlsf` starts the same app, through the alias launcher and the same installer | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| The first start seeds the Config file at `~/.config/my-little-software-factory/config.toml` and the start lines carry the seed note | Inspect the file and the start lines after the first run | Incomplete |
| A second start runs the cached binary without the network, and a new version downloads its own binary | Run the command twice; record that the second run makes no download and that a version bump re-downloads | Incomplete |
| The published package carries provenance naming this repository and the release commit | `npm view` with the attestations for both package versions | Incomplete |
| A tag whose version does not match the manifests stops before any publish | The workflow's tag check step fails the run | Incomplete |

## Notes

- The npm name `factory` is taken on the public registry. That is why the
  short access path is the separate `mlsf` alias.
- The `linux-arm64` and `darwin-x64` binaries are built by the release but
  take no runner smoke: no runner for them exists in the workflow. They are
  unverified on a machine until one runs them, and this record says so.
- The release binaries are not signed. macOS Gatekeeper and Windows
  SmartScreen show their first-run warning on a freshly downloaded binary
  until signing lands (ADR 0056); the SHA-256 verification is the check that
  stands in for the signature until then.
- The one-time trusted publishing setup is interactive on the npm account
  side and is guided by a wizard the maintainer runs before the first tag.
- The first release is `0.1.0`, the version the package already declares.
  Both manifests must match the tag; the workflow checks it.
