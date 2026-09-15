# ADR 0024: The control plane inherits the Theme from herdr

Status: accepted
Date: 2026-09-17

## Context

The operator runs the control plane inside a herdr pane. herdr themes its own
chrome from the `[theme]` section of its config file, and the operator has
already picked that theme for the whole workspace. The control plane ignored
the choice: it painted a fixed dark palette of its own, so the pane the
operator works in never matched the chrome around it. The light presentation
existed only as a hidden environment pin (`FACTORY_PRESENTATION=light`), gated
because the base panes still painted the fixed dark system (the open item in
[the shared-controls verification
record](../verification/shared-controls.md)).

herdr 0.9.0 is the herdr the control plane ships against. Its config carries
the theme name (with light variants and aliases), an `auto_switch` flag, and
per-token `theme.custom` overrides. Herdr pushes the host terminal's default
foreground and background into its panes, so a theme role that resolves to
`reset` inherits the terminal's own colors.

## Decision

**The plane resolves one Theme at startup, and every surface paints from it.**
When the process runs inside a herdr pane (herdr marks its children with a
non-empty `HERDR_ENV`, and the mark is its being set), the plane reads
herdr's config file - the operator's explicit
`HERDR_CONFIG_PATH` first, else the XDG config home, else the standard home
location - and resolves the theme from it. The resolution happens once per
process; a theme change takes effect at the next startup, so the plane keeps
exactly one theme setting: the one the operator set for herdr.

**The resolution is a pure shared module.** `src/components/shared/theme.ts`
takes the herdr config text (or its absence) and the in-herdr fact, and
returns the resolved theme plus any warning. It owns every rule: name
normalization and herdr's aliases, `auto_switch` selecting the `dark_name`
theme, the 18 built-in theme definitions vendored from herdr 0.9.0 (recorded
by version so drift is a data update), per-token `theme.custom` overrides,
color parsing, and the fallbacks. The one seam that touches the machine - the
environment and the file read - lives in `src/theme-source.ts`.

**The roles are herdr's token names.** The plane defines only the roles it
paints: `text`, `subtext0`, `surface_dim`, `accent`, `active_row_bg`,
`panel_bg`, `red`, `yellow`, `blue`, `green`, `mauve`. The old palette maps
onto them: text to `text`, dim to `subtext0`, border to `surface_dim`,
focused border to `accent`, focused background to `active_row_bg`, overlay to
`panel_bg`, error to `red`, warning to `yellow`, working to `blue`. State
badges: open to `blue`, running to `green`, awaiting to `mauve`, handed-off to
`yellow`. The separate bright-text role is dropped: the emphasis it carried
now rides on bold, so the terminal's own definition of emphasis decides how a
selected row or a heading reads.

**A role value is hex, `rgb(r,g,b)`, one of the 16 named ANSI colors (mapped
to the standard SGR values), or `reset`.** `reset` makes the renderer emit no
color code for that role, so the terminal default shows through - which is
what makes herdr's `terminal` theme meaningful, since herdr pushes the host
terminal's defaults into its panes.

**Fallbacks mirror herdr.** Inside herdr, a missing config, a missing or
unparseable `[theme]` section, or a name the vendored set does not know all
resolve to `catppuccin` - the default herdr shows - with one `Warning:` line
on the Message line when the name was present but unknown. A bad color value
on one custom override drops only that token to the base theme's value, so one
typo never loses the whole theme. Outside herdr the config file is never read
and the plane keeps its own fixed dark palette, defined as the control plane's
own theme with the same role set, so standalone use is unchanged.

**The light/dark presentation concept and the `FACTORY_PRESENTATION` pin are
gone.** A theme carries its appearance, light or dark, and one theme name is
the one source of appearance. Light `auto_switch` (host appearance
detection) is not followed: the plane resolves the `dark_name` theme, and the
limit is documented rather than guessed. The no-color presentation survives as
the only remaining presentation axis: the `NO_COLOR` environment variable
selects it, it works on top of any theme, and written prefixes and markers
keep their meaning off color. The plane does not contrast-check or clamp an
inherited theme: the operator picked it for the terminal they run in.

**The base panes paint from the shared theme module.** The Ticket list and
detail, the Consultation list and detail, the modal chrome, the Agent view,
the Live view, the Message line, and the Action bar move from the fixed dark
palette to the shared module's paint layer (`src/components/theme.ts`), per
the shared-controls standard: no screen-specific color code outside the shared
modules. This closes the open item that the base panes painted the fixed dark
color system and removes the pin that item was waiting on.

## Considered alternatives

**Watch or re-read herdr's config at runtime.** Rejected: the config is a
startup fact like the rest of the plane's configuration, a file watch adds a
second theme authority mid-session, and the spec's one theme change rule is
the next startup.

**Ask herdr for the resolved theme through an environment or IPC channel.**
Rejected until herdr grows it: the config read keeps the plane working against
herdr 0.9.0 today, and the resolver's shape (config text in, theme out) lets a
future channel replace the read without touching the paint layer.

**Keep `FACTORY_PRESENTATION` and let it override the inherited theme.**
Rejected: a second appearance axis beside the theme name is the setting
duplication the operator asked to lose, and no state of the pin survived the
migration - dark and light are themes, and no-color is the one axis left.

## Consequences

- The pane matches the chrome around it in every built-in theme, including
  light ones, with no setting of the operator's. Personalization carries over
  through `theme.custom`.
- The vendored definitions can drift from a future herdr. The recorded herdr
  version makes the drift detectable, and closing it is a data update in the
  pure module.
- An operator's unknown or missing theme inside herdr reads as `catppuccin`
  with a written reason, never as a black or broken surface.
- Inherited theme pairs are not contrast-tested (limit recorded in the
  verification record); the plane's own themes keep the tested pairs.
- Screen-reader support remains unverified, as before: a theme change moves
  colors, not the accessibility surface.
