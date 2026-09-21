# ADR 0056: The control plane ships as a prebuilt binary the npm package installs

Status: accepted
Date: 2026-09-22

## Context

ADR 0035 swapped the runtime to Bun and left the distribution on npm: the
package carries the app's source, and `npx mlsf` bootstraps on Node and
re-execs the app under a Bun found on the `PATH`. The `npx` path therefore
needs both runtimes installed before the control plane can start, on a
machine that only wants to run it.

Bun compiles a TypeScript entry to a standalone executable
(`bun build --compile`): the output embeds the Bun runtime, the app, and the
files the build imports, and runs with neither Node nor Bun on the machine.
The control plane's one machine-local read - the shipped Default
configuration - is made to reach the copy the build embeds, and the OpenTUI
native core the target runs is the file the compile embeds on its own.
OpenCode, the production OpenTUI application, distributes this way.

The release already exists (ADR 0020): a `v*` tag runs the checks and
publishes both packages to npm through trusted publishing. This ADR adds to
that release the binaries the package installs, and changes what the
package carries.

## Decision

**The release builds one prebuilt binary per supported target** and uploads
them to the GitHub Release beside the checksums file: `linux-x64`,
`linux-x64-musl`, `linux-arm64`, `linux-arm64-musl`, `darwin-x64`,
`darwin-arm64`, and `windows-x64`. Each leg compiles on a clean runner with
only the OpenTUI core of its target installed, so a binary embeds exactly
the native library it runs. The build stamps the package's version into the
binary, where the new `factory --version` flag reads it; a source run reads
the version from the repository's package.json instead.

**The binary complements the npm package; the package becomes its
installer.** The npm package no longer carries the app's source. It carries
the installer bin, which runs on Node - the runtime `npx` already provides -
resolves the machine's target, downloads this version's binary from the
GitHub Release of the same tag, verifies its SHA-256 against the release's
checksums file, and caches it under the data home
(`~/.local/share/my-little-software-factory`, or `%LOCALAPPDATA%` on
Windows) beside a version note. A second run finds the cached binary and
skips the network. `npx mlsf` and `npx my-little-software-factory` stay the
one command the operator types; a machine with no Bun and no Node of its
own runs the control plane once the binary is installed, and a machine that
keeps the binary cached needs neither.

**The checksums are verified on every install; the binaries are not signed
yet.** The checksums file is fetched before the asset and a mismatch
installs nothing. Code signing and notarization are a follow-up: until it
lands, macOS Gatekeeper and Windows SmartScreen show their first-run
warning on a freshly downloaded binary, and the operator confirms it. The
checksums file carries the name to verify.

**The `bun build --compile` build is part of the tag release.** The release
workflow checks the tree once, then publishes npm and builds the binaries in
parallel; the release job waits on the native-OS smoke jobs - the
`darwin-arm64` binary runs on macOS, the `windows-x64` binary on Windows,
the `linux-x64` binary on its build runner, and the `linux-x64-musl` binary
in an alpine container - before it uploads anything. A target whose smoke
fails is not uploaded, and a missing target stops the upload while the npm
installer degrades to its readable incomplete-release line.

## Consequences

- A machine runs the control plane with neither Node nor Bun: the binary is
  the whole runtime. The `npx` path needs Node only; Bun is a development
  requirement, not an operator one.
- The npm package shrinks to the installer and its decisions. The source
  leaves the tarball; the repository and the docs remain the source of
  truth for the app.
- Every update re-downloads the binary for the new version, because the
  version note beside the cached binary names the version it came with. The
  download is the size of the binary for the machine's target, once per
  version.
- The shipped Default configuration is embedded in the binary and is seeded
  verbatim, as before: the read that seeds a missing config file is the file
  import's read, which reaches the embedded copy in a compiled binary and
  the repository file in a source run.
- The installer resolves the Linux target by the runtime's glibc fact: a
  machine without it takes the musl binary. A machine the release does not
  build for - riscv64 Linux, arm Windows - gets the readable no-binary
  line naming the supported targets.
- The first-run warnings of macOS Gatekeeper and Windows SmartScreen are
  real until signing lands. The follow-up is signing and notarization of
  the release artifacts, which the checksums verification is built to sit
  beside.
- A release whose leg fails after the npm publish still leaves a usable
  npm package: the installer names the missing asset and installs nothing.
  Re-running the leg and the release job completes the release.
- The `linux-arm64` and `darwin-x64` binaries are built by the same leg
  that is smoke-tested for their siblings; a runner runs them in the
  verification record's first-publish pass, until the record gains a runner
  for them.
