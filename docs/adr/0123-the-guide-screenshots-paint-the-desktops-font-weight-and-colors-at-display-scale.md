# ADR 0123: The guide screenshots paint the desktop's font, weight, and colors at display scale

Status: accepted
Date: 2026-10-07

Amends one consequence of ADR 0120: the generated screen font table that
record's `noSecrets` override names no longer exists, and the override leaves
with it. Every other decision in ADR 0120 stands. ADR 0028's decision about the
hero is untouched; this record moves the shared renderer both captures paint
with, and keeps ADR 0028's rule that the theme is a pinned input.

## Context

The six operation screenshots and the homepage hero are painted from the
production renderer's own bytes over a deterministic fixture world, and
`test/screenshot-drift.test.ts` holds the six to the screen byte for byte.
Issue #348 reported that they read badly on the site: low resolution, no font
antialiasing, and not the app the operator runs on their desktop.

Every fact below was measured on `08cee20e`.

- The cell was 9 by 20 device pixels: a 15 px font, 4x supersampling, and
  16-piece curve subdivision. A 180 by 40 grid came to 1620 by 800. The site's
  documentation column is 1120 CSS pixels, so on a 2x display the lightbox
  upscales that image.
- The capture's PTY named only `TERM=xterm-256color`. OpenTUI then quantized
  every Theme hex before it wrote: the stream carried eleven distinct SGR
  parameter sets, and its only colors were `38;5;` with indices 15, 75, 108,
  168, 176, 236, 247, and 249. herdr advertises `TERM=xterm-256color` and
  `COLORTERM=truecolor` for every pane it starts, so the desktop path is
  24-bit. The same fixture world with `COLORTERM=truecolor` writes
  `38;2;40;44;52` and `38;2;97;175;239`, which are one-dark's `#282c34` and
  `#61afef`.
- The renderer then snapped every color to the nearest xterm-256 entry. That
  moved the hero too, since the hero's plane already ran in a herdr pane and
  already wrote truecolor.
- The Main view names no background at all: every background cell is SGR 49,
  the terminal's own. The renderer painted those cells with a hardcoded
  `(17,17,27)`, which is neither the plane's Theme nor the operator's terminal
  background.
- The plane carries its emphasis on bold: a title or a selected row paints its
  role and sets bold. The renderer drew those cells with the Regular face and
  brightened the palette index instead.

## Decision

**The capture advertises what the desktop advertises.** Every captured PTY
names `TERM=xterm-256color` and `COLORTERM=truecolor`, the pair herdr gives
every pane, for the six guide shots and for the hero's client alike.

**The renderer paints the color the stream names.** The 240-entry cube and the
truecolor-to-nearest-index snap leave. The 16 basic colors stay, because
herdr's own chrome in the hero names them with SGR 30-37 and 90-97.

**The terminal's own colors are a pinned input, not a live read.** The fixture
holds one named block beside `HERDR_THEME_NAME`: the terminal background, the
terminal foreground, and the 16 basic colors, copied from the theme the
operator's desktop stands on, which is tokyo-night today. A capture reads
nothing from the machine it runs on, so the committed bytes stay the same on
every machine, and the block moves by hand when the desktop theme moves.

**The paint scale is pinned.** The font rasterizes at 45 px, three times the
size the retired table used, which gives a 27 by 61 cell: 4860 by 2440 for the
180 by 40 guide grid and 6912 by 3416 for the 256 by 56 hero grid. The grids
do not move, and no image is resampled after the paint.

**Glyph coverage is rasterized at run time from the vendored faces.** The
committed coverage table and `bun run font` leave. The rasterizer keeps its
winding fill and takes 8x supersampling and 64-piece curve subdivision, with
no hinting and no subpixel antialiasing.

**Bold is a face, not a color.** The Bold face of the same family is vendored
beside the Regular one and rasterized the same way, and a bold cell paints
with it. The bold-to-bright palette bump leaves.

## Considered Options

- **Photograph the app in a real terminal on a desktop.** Rejected: the drift
  test guards the six shots byte for byte, CI has no desktop, and this
  repository forbids driving the desktop environment to test the app. The
  complaint is about pixels per cell and the color path, both of which the
  painted path can answer.
- **Keep the committed coverage table and grow it to the pinned scale.**
  Rejected: 236 KB of coverage becomes about 314 KB of base64 in one source
  file, and the table and the images must then move together. The whole glyph
  set rasterizes in 102 ms, against a capture case that already costs 0.8 to
  1.2 s.
- **Subset the Bold face to the 143 characters the screens use.** Rejected for
  now: the full file matches the Regular one already vendored and keeps its
  provenance obvious.
- **Subpixel RGB antialiasing, or hinting.** Rejected: a browser rescales the
  PNG, so subpixel coverage reads as colored fringes, and hinting would tie
  the glyphs to one rasterizer's choices.
- **Shrink the grids so the text reads larger on the page.** Rejected: the
  guides' content and the drift test stand on 180 by 40, and the complaint is
  about pixels per cell, not cells per screen.

## Consequences

- The committed images move. The six shots become 4860 by 2440 and weigh about
  1.5 to 2 MB together; the hero becomes 6912 by 3416 and weighs about 1 MB.
- The colors in the images change, because the Theme's hexes now reach the
  PNG. one-dark's `#282c34` replaces the `(48,48,48)` the snap produced, and
  the outer background becomes the pinned terminal background instead of the
  hardcoded `(17,17,27)`.
- The hero is regenerated with the six shots, the way ADR 0028 already words a
  theme change: the pinned inputs moved, so both are re-run.
- ADR 0120's `noSecrets` override for `**/screen-font.ts` leaves, and ADR 0120
  carries the amendment line.
- The drift case costs about a second more: 102 ms for one rasterization per
  process, and about 173 ms per screen for paint and encode against about
  37 ms. `docs/development/quality-gate.md` is re-measured when this lands.
- Two guards join the suite. The committed PNGs' IHDR dimensions are checked
  against the pinned scale without opening a PTY, so a scale change fails with
  its own reason rather than as an opaque byte diff. The rasterizer is checked
  to produce partial coverage for a curved glyph, so a regression to a
  hard-edged raster goes red.
- The inline image on a documentation page still reads a little smaller than
  the desktop: at 1120 CSS pixels a 180-column shot shows a 12.4 device-pixel
  cell on a 2x display, against the desktop's roughly 15. The lightbox is
  where the shot reads at desktop size, and the column stays where it is.
- Nothing under `src/` changes behavior. The one `src/` edit is a comment that
  names the retired screen-font table.
