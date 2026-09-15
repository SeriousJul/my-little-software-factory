---
title: First Launch
description: Start the control plane with npx; the first start writes the config file.
---

# First Launch

Run either name; both start the same app:

```sh
npx my-little-software-factory
npx mlsf
```

On the first start the app finds no config file, writes the [Default
configuration](./minimal-config.md#the-config-file) to
`~/.config/my-little-software-factory/config.toml`, and says so on the start
lines before the interface appears. The start lines name the path, so you
know where to edit.

A second start reads the file. A line that does not parse or does not
validate stops the start with one readable error line. A present file must
carry every required key, and a key the control plane does not read is an
error, so a typo surfaces at the start, not at handoff time.

Next: [the minimal config](./minimal-config.md).
