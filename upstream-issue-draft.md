# Row text corruption in emitted frames on Bun: truncated head with merged or missing rows (0.5.9 and 0.5.11)

## Environment

- `@opentui/core` 0.5.11 (also measured on 0.5.9)
- Bun 1.4.0, Linux x86-64
- Host terminal: tmux 3.7a (pane 200x50); corruption was captured in the app's own emitted bytes via `tmux pipe-pane`, so it is independent of the host terminal.

## Symptom

An app renders a bottom-pinned scrolling list of text rows (one `text`
element per visible row, each a span with an `fg` color) and refreshes it
under load: a new row arrives roughly every 80-1000 ms and every visible row
changes as the window slides. Intermittently, emitted synchronized frames
(`\x1b[?2026h ... \x1b[?2026l`) contain corrupted rows:

1. A row's head is truncated and the following row's full text is merged
   into the same physical row, with the following row's own row then absent.
2. A row's head is truncated and the following one or two rows are missing
   entirely.

Corrupted frame 22 (expected vs. emitted, 200 columns):

```
expected row: "L128 the old the and cold jumps the back by stone low runs fox lazy bank the old the and cold jumps the back by stone low runs fox lazy bank the old the and cold jumps the back by stone low runs fox lazy bank"
emitted row:  "and cold jumps the back by stone low runs fox lazy bank the old the and cold jumps the back by"
```

The emitted row is the last 39 characters of the expected row 1 plus the
full 52 characters of the expected row 2, concatenated without a line break;
the expected row 2's own physical row is absent. 195 characters of the
expected row 1 head are gone.

Properties, all measured:

- The corruption is in the bytes the app writes, before any terminal
  processing: `pipe-pane` records show the same corrupted content inside
  well-formed, complete synchronized frames. Frames are valid UTF-8 with no
  byte loss; a byte-faithful VT emulation of the whole stream converges.
- The corrupted content persists across repeated frame emissions (the same
  corrupted frame is emitted several times in a row) until the next content
  update overwrites the row. In a view that keeps updating, the artifact
  heals within ~1 s. In a static view it persists indefinitely until any
  interaction triggers a re-render.
- Frequency is load/intermittent: 40 s streaming runs show 0 to 30
  corrupted captures (100 ms cadence) on both 0.5.9 and 0.5.11.

## Why I suspect a stale-buffer read at the FFI boundary

The merged content is a classic stale-pointer read: row A's assembled text
is a suffix of A's own string followed by row B's full string, and B's row
then disappears. That is what you get if A's styled-text chunk buffer was
read after A's text buffer had been reclaimed and reused for B's, or if A's
chunk pointer/length pair went stale.

The signature matches #1212 (use-after-free of the styled-text buffer,
fixed for Node 26 in #1221). But the owner-retention mechanism that #1221
added (`retainPointerTarget` on the packed buffer, direct buffer passing in
`textBufferSetStyledText`) is present in the Bun builds of both 0.5.9 and
0.5.11, and the corruption still occurs on Bun. So either the remaining
window is a different native defect, or a path #1221 did not cover (for
example a pointer the Zig side retains beyond the call, or the
`textBufferRegisterMemBuffer(ptr, bytes, false)` borrow path).

Questions for maintainers:

1. Does any Zig-side path retain a JavaScript-owned text pointer beyond the
   FFI call (contrary to the "consumed or copied synchronously" contract
   stated in #1212)?
2. In the Bun FFI path, is `textBufferSetStyledText` guaranteed to copy the
   chunk text before returning, and is the nested text buffer lifetime
   handled the same as the Node 26 path after #1221?
3. Is there a known open issue for row layout loss (missing rows) under
   high-frequency row updates on Bun?

## Reproduction

`scripts/repro-tmux-live.ts` (attached): builds the repo fixture, replaces
the herdr stub with one whose agent pane serves a growing stream file
(120-249 cell lines appended every 80 ms, newest 100 kept), runs the real
app in a 200x50 tmux pane, drives it to the streaming Live view, captures
the pane every 100 ms for 40 s, and checks that the visible `L<number>`
rows stay a contiguous run. It also `pipe-pane`-records the app's exact
output bytes for offline frame decoding.

Run: `bun scripts/repro-tmux-live.ts` (requires tmux on PATH). Corrupted
captures appear in the majority of runs on 0.5.9 and 0.5.11.

## Workarounds tried (none effective)

- Re-keying the rows by content identity: no improvement (worse in some
  runs).
- Toggling a force-full-repaint per frame: no change in rate.
- Pinning unchanged row strings to stable references so unchanged rows skip
  the native re-set: no improvement.
- Consolidating the visible rows into one `text` element with `br`:
  rendered wrong.
