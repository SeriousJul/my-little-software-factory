---
title: Prerequisites
description: What the machine needs before the first start of the control plane.
---

# Prerequisites

Before the first start, the machine needs:

- Node, for the `npx` that runs the installer. The installer downloads the
  prebuilt binary for your machine; the binary itself needs neither Node nor
  Bun.
- [herdr](https://herdr.dev) on the `PATH`, with a current
  [ghostty](https://ghostty.org) on the `PATH` (herdr runs each agent's
  terminal in ghostty), and `git`.
- The agent CLI of each agent type you use, with its own provider auth
  applied.
- Bun, only for the [from-source path](./first-launch.md#run-from-source).

On macOS and Windows, the first run of a freshly downloaded binary shows the
operating system's first-run warning, until you approve it.

On a musl Linux machine - Alpine and the Alpine-derived images - the binary
needs the GNU C++ runtime, which the base image does not carry: install
`libstdc++` (`apk add libstdc++`) before the first run.

Next: [first launch](./first-launch.md).
