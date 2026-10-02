---
title: First Launch
description: Start the control plane with the npx one-liner or from source; the first start downloads the binary and writes the config file.
---

# First Launch

Start the control plane with the one-liner:

```sh
npx my-little-software-factory
```

The one-liner is for a machine without a checkout. Inside a checkout, the
name resolves to the local project, which carries no published bin, and the
start answers `factory: command not found`. From a checkout, start with
`bun run start`.

The first start downloads the prebuilt binary for your machine and caches it
under your data home, in a directory per target -
`~/.local/share/my-little-software-factory/bin/<target>`, or
`%LOCALAPPDATA%\my-little-software-factory\bin\<target>` on Windows - so a
second start finds the cache and skips the network. To drop the cache, delete
the data-home directory: `rm -rf ~/.local/share/my-little-software-factory`.

With no config file, the start writes the [Default
configuration](./minimal-config.md#the-config-file) to
`~/.config/my-little-software-factory/config.toml` and says so on the start
lines, so you know where your config file lives and where to edit. A line
that does not parse or does not validate stops the start with one readable
error line.

`factory --version` answers with the version the install carries, and
`factory --config <path>` starts on the config file you name; both flags work
before any config exists. An install you keep uses the same launcher:
`npm install -g my-little-software-factory` puts a `factory` command on your
`PATH`, and it runs the binary the way `npx` does.

## Run from source

To run the plane from source instead of the published binary:

```sh
git clone https://github.com/SeriousJul/my-little-software-factory
cd my-little-software-factory
bun install
bun run start
```

This runs the same app the binary runs, with no hot reload and no development
config, and it reads the same config file the binary uses -
`~/.config/my-little-software-factory/config.toml` - so your setup is
identical to a binary install.

Next: [the minimal config](./minimal-config.md).
