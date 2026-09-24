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
only its own operating system's and architecture's OpenTUI cores installed.
That is one core for `darwin-x64`, `darwin-arm64`, and `windows-x64` and two
for each Linux target. `@opentui/core`'s loader names eight platform packages
in literal dynamic imports, and the bundler prunes the `process.platform` and
`process.arch` branches to the `--target` it is given, so a leg needs only the
cores its target can reach. What no target settles is the libc test inside the
Linux branches, `process.env.OPENTUI_LIBC === "musl"`: an environment read is
not knowable at build time, so both siblings of the target's architecture must
resolve. A Linux binary therefore carries both libc variants, about 6.3 MB of
native library the machine it runs on never loads. The measured core count and
byte size per target are in the verification record. The build stamps the
package's version into the binary, where the new `factory --version` flag reads
it; a source run reads the version from the repository's package.json instead.

**The npm package complements the binary; the package is the installer.** The
npm package no longer carries the app's source. It carries
the installer bin, which runs on Node - the runtime `npx` already provides -
resolves the machine's target, downloads this version's binary from the
GitHub Release of the same tag, verifies its SHA-256 against the release's
checksums file, and caches it under the data home
(`~/.local/share/my-little-software-factory`, or `%LOCALAPPDATA%` on
Windows) in a directory per target, beside an install note that names the
version, the target, and the digest it was verified against. A second run
finds the cached binary, checks its bytes against that note, and skips the
network. An empty or relative data home from the environment is no data home:
the run ignores it the way the Config paths do, and a cache never lands in the
working directory, where a planted binary could arrive with a note that agrees
with it. `npx mlsf` and `npx my-little-software-factory` stay the
one command the operator types; a machine with no Bun and no Node of its
own runs the control plane once the binary is installed, and a machine that
keeps the binary cached needs neither.

**The installed binary is the package's only runtime content.** The app's
libraries - the OpenTUI core and React, the TOML reader, the width reader -
are development dependencies of the repository: the build embeds them in the
binary, and an operator who installs the package installs the installer alone
and nothing else.

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
- Each Linux binary carries the glibc and the musl OpenTUI core, and the dead
  variant is most of the size difference between a Linux binary and a Darwin or
  Windows one. It is not a flag the build can drop: measured on this branch,
  `--external` on the sibling left the artifact byte-for-byte unchanged, and a
  Linux tree without the sibling failed the compile with an unresolved import.
  Taking it out needs the loader to make the libc choice statically knowable -
  the platform and architecture branches already are, which is why a non-Linux
  leg builds with one core - and that is upstream's change to make. The release
  accepts the extra 6.3 MB, and the record states the core count and the byte
  size per target.
- Every update re-downloads the binary for the new version, because the
  install note beside the cached binary names the version it came with. The
  note also names the target and the digest, so a cache that cannot account
  for itself - another machine's note in a shared home, a file written over -
  re-downloads instead of failing every later run. The download is the size
  of the binary for the machine's target, once per version.
- `--version` is answered by the installer while no binary is cached, and by
  the binary once one is. The flag exists to work on a machine with no state,
  so a cold run must not pay for a ~100 MB download to print one line; the
  installer holds the version it is about to install, and the line is the text
  the compiled binary prints for the same flag.
- The shipped Default configuration is embedded in the binary and is seeded
  verbatim, as before: the read that seeds a missing config file is the file
  import's read, which reaches the embedded copy in a compiled binary and
  the repository file in a source run.
- The installer resolves the Linux target by the runtime's glibc fact: a
  machine without it takes the musl binary. A machine the release does not
  build for - riscv64 Linux, arm Windows - gets the readable no-binary
  line naming the supported targets. The musl binary links the GNU C++
  runtime, which an Alpine machine does not carry by default, so the
  prerequisites name `libstdc++` as a requirement of that machine.
- The first-run warnings of macOS Gatekeeper and Windows SmartScreen are
  real until signing lands. The follow-up is signing and notarization of
  the release artifacts, which the checksums verification is built to sit
  beside.
- A release whose leg fails after the npm publish still leaves a usable
  npm package: the installer names the missing asset and installs nothing.
  Re-running the leg and the release job completes the release, because the
  release job creates the release only where it is missing and uploads with
  `--clobber` either way.
- The `linux-arm64` and `darwin-x64` binaries are built by the same leg
  that is smoke-tested for their siblings; a runner runs them in the
  verification record's first-publish pass, until the record gains a runner
  for them.
