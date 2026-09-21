---
title: First Launch
description: Start the control plane with npx; the first start downloads the binary and writes the config file.
---

# First Launch

Run either name; both start the same app:

```sh
npx my-little-software-factory
npx mlsf
```

The first start installs the prebuilt binary for your machine: the
installer downloads it from the release's GitHub Release, verifies its
SHA-256 against the release's checksums file, and keeps it under your data
home - `~/.local/share/my-little-software-factory`, or
`%LOCALAPPDATA%\my-little-software-factory` on Windows. A second start finds
the cached binary and skips the network; a new release version downloads its
own binary.

The control plane then finds no config file, writes the [Default
configuration](./minimal-config.md#the-config-file) to
`~/.config/my-little-software-factory/config.toml`, and says so on the start
lines before the interface appears. The start lines name the path, so you
know where to edit.

A second start reads the file. A line that does not parse or does not
validate stops the start with one readable error line. A present file must
carry every required key, and a key the control plane does not read is an
error, so a typo surfaces at the start, not at handoff time.

The binary answers `factory --version` with the version the release stamped
into it, and `factory --config <path>` starts on the config file you name.
Both flags work before any config exists.

Next: [the minimal config](./minimal-config.md).
