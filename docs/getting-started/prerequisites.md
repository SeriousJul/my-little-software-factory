---
title: Prerequisites
description: What the machine needs before the first start of the control plane.
---

# Prerequisites

The control plane ships through npm. You install nothing: `npx` runs the
current published version. Before the first start, the machine needs:

- Bun `1.3.0` or newer. The control plane runs on Bun. Below the floor the
  start fails with the required version and the reason: the OpenTUI renderer
  uses Bun's stable FFI, and the bin gates the version before it loads the
  native core.
- Node, for the `npx` that bootstraps the launcher. The launcher finds Bun on
  the `PATH` and hands it the app, so both runtimes are needed for the `npx`
  commands; a global install runs the app on Bun alone.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH`. The control
  plane drives it through its CLI and never starts an agent process itself.
- The agent CLI of each agent type you use, with its own provider auth
  applied.

Next: [first launch](./first-launch.md).
