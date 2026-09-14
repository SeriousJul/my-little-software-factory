# ADR 0020: The control plane resolves the herdr theme from herdr's config file

Status: accepted
Date: 2026-09-14

## Context

The control plane runs inside a herdr pane, surrounded by herdr's own
chrome. herdr themes that chrome from the `[theme]` section of its
`config.toml`: a built-in theme name (18 names, including light
variants), an `auto_switch` that follows the host terminal appearance,
and per-token `theme.custom` overrides. The control plane painted a
fixed dark palette of its own, so the pane it draws never matched the
chrome around it, and its light presentation was an explicit pin
(`FACTORY_PRESENTATION`), not something an operator could set.

herdr gives a child process no channel to learn the active theme: no
environment variable carries it, and the socket API snapshot exposes no
theme field. The config file is the only record of the choice. The
built-in theme definitions live inside the herdr binary, and herdr has
no command that prints them.

## Decision

**The control plane resolves the Theme itself, at startup, from herdr's
config file.** It reads the file herdr reads (`$XDG_CONFIG_HOME/herdr/config.toml`,
falling back to `~/.config/herdr/config.toml`) when it runs inside herdr
(`HERDR_ENV` set). It carries its own copy of the 18 built-in theme
definitions and herdr's name and alias rules, and it records the herdr
version the copy was taken from.

**Resolution mirrors herdr.** `auto_switch` selects the `dark_name`
theme: the control plane does not follow the host light appearance. An
unknown theme name, a missing section, or an unparseable config falls
back to `catppuccin`, the same result herdr shows, with one warning on
the Message line. A missing config inside herdr also gives `catppuccin`,
herdr's built-in default. Outside herdr, a missing config gives the
standalone fixed dark palette, the colors the control plane has always
used. `theme.custom` overrides apply per token on top of the base
theme; a bad or unknown override value drops only that token.

**The theme owns the colors; the no-color presentation stays.** The
shared presentation module's role set becomes the theme's color roles,
named after herdr's tokens. The roles a value can hold are hex,
`rgb(r,g,b)`, the 16 named ANSI colors, and `reset`, which means the
control plane emits no color code so the terminal default shows
through. The no-color presentation remains a separate axis on top of any
theme, and written prefixes and markers keep meaning off color.
Inherited color pairs are not contrast-tested; the verification record
says so.

**The whole plane follows the theme.** The base panes move from their
own fixed palette to the shared module, and the light/dark presentation
pin is removed: a light appearance is a light theme name, and there is
one source of brightness.

## Considered alternatives

- Ask upstream herdr to expose the resolved theme (an environment
  variable or a socket API field) and read only that. Cleanest channel,
  but it depends on a change the control plane does not control, and
  herdr 0.9.0 has none. Revisit if herdr adds one: the resolver keeps
  its shape, and the config read is replaced by the new channel.
- Honor only the `theme.custom` overrides and ignore built-in names.
  Rejected: it does nothing for the common case, an operator who set
  only `name`.
- Re-read the config at runtime, or watch it for changes. Rejected for
  the first version: the control plane restarts often in this workflow,
  and watching a file the control plane does not own adds a failure
  path for a rare benefit.
- Follow the host light appearance when `auto_switch` is on (a terminal
  background query). Rejected: it needs raw terminal I/O through the UI
  kit for a case that almost never fires; the documented limit is to
  take the `dark_name` theme.

## Consequences

- The vendored theme definitions can drift when herdr changes a
  theme. The module records the herdr version they were copied from, so
  the drift is detectable and the fix is a data update, not a design
  change.
- A theme change in herdr's config takes effect at the next control
  plane startup, not live.
- The light/dark presentation concept is superseded by the Theme; the
  no-color presentation survives as the only remaining axis, and
  `FACTORY_PRESENTATION` is removed.
- The open item in the verification record that the base panes paint
  the fixed dark color system is closed by this decision's
  implementation.
