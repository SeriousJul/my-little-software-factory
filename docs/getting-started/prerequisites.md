---
title: Prerequisites
description: What the machine needs before the first start of the control plane.
---

# Prerequisites

The control plane ships through npm, and the npm package installs a
prebuilt binary for the machine (ADR 0056). You install nothing: `npx` runs
the current published version. Before the first start, the machine needs:

- Node, for the `npx` that bootstraps the installer. The installer runs on
  Node, downloads the prebuilt binary for the machine from the release, and
  hands it the command. The binary itself needs neither Node nor Bun: it
  carries its own runtime.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH`. The control
  plane drives it through its CLI and never starts an agent process itself.
- The agent CLI of each agent type you use, with its own provider auth
  applied.

Bun is a development requirement of the repository, not an operator one: it
builds, tests, and runs the control plane from source, and it compiles the
prebuilt binary the release publishes.

On macOS and Windows, the first run of a freshly downloaded binary shows
the operating system's first-run warning - Gatekeeper on macOS, SmartScreen
on Windows - until the release's binaries are signed (ADR 0056). The binary
is verified against the release's SHA-256 checksums before the installer
keeps it.

On a musl Linux machine - Alpine and the Alpine-derived images - the binary
needs the GNU C++ runtime, which the base image does not carry: install
`libstdc++` (`apk add libstdc++`) before the first run. The release's musl
smoke runs in a container that installs it, and measured without it the
binary stops on a relocation error before it answers anything.

Next: [first launch](./first-launch.md).
