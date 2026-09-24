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
installer says it is downloading, takes the binary from the release's GitHub
Release, verifies its SHA-256 against the release's checksums file, and keeps
it under your data home, in a directory per target -
`~/.local/share/my-little-software-factory/bin/<target>/factory`, or
`%LOCALAPPDATA%\my-little-software-factory\bin\<target>\factory.exe` on
Windows. The binary's `.install` note beside it names the version, the
target, and the SHA-256 it was verified against. A second start finds the
cached binary, checks its bytes against that note, and skips the network; a
new release version, a note for another target, and a binary someone else
wrote over all download the right one again.

The download is about 100 MB and has a time bound of its own. On a slow link,
raise the bound with `MLSF_DOWNLOAD_TIMEOUT_MS`, in milliseconds:
`MLSF_DOWNLOAD_TIMEOUT_MS=1800000 npx mlsf`.

To drop the cache, delete the data-home directory: `rm -rf
~/.local/share/my-little-software-factory`.

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
Both flags work before any config exists. `--version` on a machine that has
not downloaded the binary yet is answered by the installer, from the package
version, so the flag costs no download; once the binary is cached the same
flag goes to the binary itself.

An install you keep uses the same launcher: `npm install -g
my-little-software-factory` puts a `factory` command on your `PATH`, and it
installs and runs the binary the way `npx` does.

Next: [the minimal config](./minimal-config.md).
