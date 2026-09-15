---
title: Prerequisites
description: What the machine needs before the first start of the control plane.
---

# Prerequisites

The control plane ships through npm. You install nothing: `npx` runs the
current published version. Before the first start, the machine needs:

- Node `26.4.0` or newer. Below the floor the start fails with the required
  version and the reason: the OpenTUI renderer loads `node:ffi`, which Node
  gates behind `--experimental-ffi`.
- [herdr](https://github.com/seriousjul/herdr) on the `PATH`. The control
  plane drives it through its CLI and never starts an agent process itself.
- The agent CLI of each agent type you use, with its own provider auth
  applied.

Next: [first launch](./first-launch.md).
