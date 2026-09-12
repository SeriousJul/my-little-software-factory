# Shared control verification

Status: the automated checks pass. The keyboard and visual acceptance targets
are verified in Ghostty and foot, in the dark, light, and no-color
presentations. The screen-reader target is not verified at all.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [the shared control standard](../shared-controls.md) for what the baseline
requires, and [ADR 0014](../adr/0014-shared-modules-own-control-behavior.md) for
who owns control behavior.

## What is verified automatically

Every check below runs in `npm test`, which is `npm run lint`,
`npm run typecheck`, and the behavior suite together.

| Requirement | Checked by | Result |
| --- | --- | --- |
| Text and Draft editing: caret, word movement, Home/End, Backspace/Delete, word delete, selection, replace-on-type, undo/redo | `test/shared-field-editing.test.ts`, `test/shared-controls.test.ts`, `test/handoff-frame.test.ts` | Passed |
| The Key guide's `Select all` key, Ctrl+A, selects the whole text in both field kinds, and F3 then copies the selection, reported as news on the Message line | `test/shared-controls.test.ts`, `test/consultation-launcher-editing.test.ts` | Passed |
| Ordinary and enhanced (Kitty keyboard protocol) key sequences mean the same operations | `test/shared-controls.test.ts` | Passed |
| Unicode, wide, and combined characters keep their cells and their caret | `test/shared-field-editing.test.ts` | Passed |
| Long text scrolls inside the field, and the visible caret is where the next edit lands | `test/shared-field-editing.test.ts`, `test/handoff-frame.test.ts` | Passed |
| Enter inserts a newline in a Draft field; a visible action submits | `test/consultation-launcher-editing.test.ts`, `test/consultation-frame.test.ts`, `test/executable-fields.test.ts` | Passed |
| Paste is text: it never submits a form and never runs an application control | `test/shared-field-editing.test.ts`, `test/executable-fields.test.ts` | Passed |
| A Context field refuses a non-digit paste as one operation, with and without selected text, keeps value, caret, and selection, and states why | `test/shared-controls.test.ts`, `test/tmux-fields.test.ts`, `test/executable-fields.test.ts` | Passed |
| A digit paste is taken, count validity and leading-zero folding stay in force | `test/shared-controls.test.ts`, `test/handoff-frame.test.ts`, `test/setting-resolution.test.ts`, `test/handoff.test.ts` | Passed |
| An oversized Draft field stays editable and states its size and limit | `test/consultation-launcher-editing.test.ts`, `test/consultation-launcher.test.ts` | Passed |
| Tab and Shift+Tab reach every field and action; arrows move the caret inside a Draft field | `test/consultation-launcher-editing.test.ts`, `test/consultation-launcher.test.ts` | Passed |
| A modal keeps focus inside itself; the base view takes no key while a form is open | `test/shared-field-editing.test.ts`, `test/override-panel.test.ts`, `test/handoff-frame.test.ts` | Passed |
| F1 opens the Key guide and F2 the Message view while editing, and neither loses the draft, caret, selection, or undo history | `test/consultation-launcher-editing.test.ts`, `test/key-guide.test.ts`, `test/message-line.test.ts` | Passed |
| Ctrl+C stays the emergency exit while a field holds a selection; F3 copies it and says what happened | `test/shared-field-editing.test.ts`, `test/action-bar.test.ts` | Passed |
| Closing keeps the launcher's whole form, and it comes back on the same Repository and Consultation type; Discard is the only delete | `test/consultation-launcher-editing.test.ts` | Passed |
| A Response draft stays saved through the existing persistence path | `test/consultation-frame.test.ts`, `test/consultation.test.ts`, `test/state.test.ts` | Passed |
| Type-ahead shows its search, matches by substring, keeps an unmatched query with `no match`, edits with Backspace, clears with one key, and keeps query and value distinct | `test/shared-gallery.test.ts`, `test/handoff-frame.test.ts`, `test/override-panel.test.ts` | Passed |
| The Action bar and Key guide agree with dispatch, and field editing is named in the guide | `test/key-guide.test.ts`, `test/action-bar.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Consultation list and Agent view navigation, response gating, recovery, history, close, delete, and refresh use the shared catalogue | `test/consultation-frame.test.ts` | Passed |
| Agent interaction mode exposes its configured exit control, preserves emergency exit, and forwards unclaimed input | `test/consultation-frame.test.ts` | Passed |
| The Consultation confirmation panel uses shared action selection and dispatch | `test/action-panel.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Contrast of the shared palette's text and indicator pairs, measured with the WCAG formula | `test/shared-presentation.test.ts` | Passed |
| The light and no-color presentations draw their own pairs; labels, the focus marker, and state words survive without color | `test/shared-presentation.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The overlay surface paints the presentation's own surface role, and every text the surface paints clears the measured contrast on the background it landed on, in dark and light | `test/shared-gallery.test.ts`, `test/key-guide.test.ts`, `test/shared-presentation.test.ts` | Passed |
| Decorative animation and caret blinking are off by default, and no check depends on a blink or a timer | `test/shared-presentation.test.ts`, the frame suite's bounded waits | Passed |
| Small and narrow frames keep the focused control and the way out; below a usable size the surface states its size and how to leave | `test/reserved-rows.test.ts`, `test/handoff-frame.test.ts`, `test/consultation-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The shared library is required: no screen builds its own field, names a renderer field, or hand-edits a draft string | `test/shared-control-architecture.test.ts` | Passed |
| The gallery's examples are the production modules | `test/shared-gallery.test.ts` | Passed |

## Environment these checks ran in

| Part | Version |
| --- | --- |
| OS | Arch Linux, kernel 7.1.9-arch1-2 |
| Node | v26.8.1 (the pinned minimum is 26.4.0) |
| Renderer | OpenTUI `@opentui/core` 0.5.9, `@opentui/react` 0.5.9 |
| Test runner | vitest 4.1.11 |
| Multiplexer (tmux path) | tmux 3.7c |

## Required acceptance targets and their state

| Environment | Required checks | Result |
| --- | --- | --- |
| Linux with Ghostty | Keyboard and visual checks | **Verified** on Ghostty 1.3.1-arch2 under Hyprland 0.56.2 on this machine. All four gallery examples walked: typing, caret movement, selection shading, F3 copy (the terminal confirmed the clipboard), a paste refused as a whole with its reason, a taken paste, undo and redo, the F1 Key guide opening and closing, and Esc leaving the gallery. |
| Linux with foot | Keyboard and visual checks | **Verified** on foot 1.28.0: the same walk, with paste driven by foot's clipboard-paste key; the refused paste kept its value and stated why, the taken paste landed at the caret, the F1 Key guide opened and closed, and Esc left the gallery. `FACTORY_PRESENTATION=mono` on the same window: labels, the focus marker, and the state words survived with the colors off. |
| A light terminal with the light presentation | Visual checks | **Verified after a fix, under the pin.** The light presentation is reachable only through `FACTORY_PRESENTATION=light`: the automatic switch on the terminal's own scheme is gated, because the base panes no shared module owns still paint the fixed dark color system (decision recorded below). On Ghostty over a light terminal, the first check found the shared overlays unreadable: the light ink painted on a fixed dark surface. The overlays now paint the presentation's own surface role, and the Key guide, the Message line, and the size notice take their ink from the presentation. The gallery's surface and every text it paints are checked span by span in the suite, and the desktop re-check showed the gallery readable on the light terminal. |
| A tmux path on Linux | Keyboard, paste, focus, and rendering checks | **Verified** by `test/tmux-fields.test.ts` on tmux 3.7c: the production gallery on a real pane, keys sent as terminal bytes, the screen read back with `capture-pane`. |
| Separate GNOME Terminal and Orca environment | Screen-reader operation | **Not verified.** Neither GNOME Terminal nor Orca is installed here, and the standard forbids changing an operator's desktop configuration as an unannounced setup step. No screen-reader claim is made anywhere in this repository. |

### Visual check procedure for Ghostty and foot

Run it on a machine with a desktop session, then record the versions and results
in this file. Do not mark the row verified from the automated suite.

1. `npm run gallery` and walk all four examples with `Tab`.
2. In the `fields` example: type into the focused Context field, press Left,
   Right, Home, End, Shift+Arrow, Ctrl+Arrow, Ctrl+Backspace, Ctrl+Z, Ctrl+Y;
   paste `1e3` and then `42`; paste a long single line and a multi-line draft.
3. Check the caret's cell, the selection's shading, the box's borders, the label
   column, and the reason line under the field. Resize the window narrow and
   short, then back, and confirm the draft and caret survive.
4. Repeat steps 2 and 3 in the real screens: `e` on an open Ticket for the
   override panel, `c` for the Consultation launcher, and `Enter` on an awaiting
   Consultation for the response editor.
5. Check `?`/`F1` (Key guide), `F2` (Message view), `F3` (Copy selection), `Esc`,
   and `Ctrl+C`, and confirm the Action bar names only keys that did what it
   said.
6. Repeat with a light terminal theme and with the theme's colors turned off
   (`FACTORY_PRESENTATION=light`, `FACTORY_PRESENTATION=mono`).

### Screen-reader procedure, not yet run

OpenTUI lists screen-reader support as future work, and Orca reads
AT-SPI-compatible applications, so this path must be measured rather than
inferred. A frame snapshot, raw PTY bytes, or a passing keyboard test proves
none of it.

1. On a GNOME session with Orca running, open GNOME Terminal and run
   `npm run gallery`, then the control plane itself.
2. For each field, ask Orca to read the focused control and confirm it states
   the field's label, its value, and the caret position; then edit and read
   again.
3. Select text by keyboard and read the selection; copy it with `F3` and paste
   it into another application to confirm what was copied.
4. Read a field's error line, a refused paste's reason, an unavailable action's
   reason, and a loading or empty state word.
5. Open and close the Key guide and the Message view from inside a field, and
   confirm Orca states the change of surface and, after the close, returns
   focus to the same field with the same caret and selection.
6. Watch a changing progress message and a Consultation state change, and
   confirm the operator learns of them without reading the screen.
7. Record the GNOME, GNOME Terminal, Orca, Node, and OpenTUI versions, and the
   result of each step, in this file.

If the renderer cannot give Orca any of this, stop and return for agreement on a
renderer change or an equivalent accessible interaction mode. Do not lower the
requirement to keyboard-only support, and do not claim the baseline complete.

## The light presentation: the decision

The light presentation is a pin, not an automatic switch. The terminal's own
scheme is never consulted, and the shared library exposes no path to switch to
light without `FACTORY_PRESENTATION=light`. The reason is the half-migration:
the base panes no shared module owns (the Ticket list and detail, the
Consultation list and detail panes, the Agent pane, and the Live view, with
their state and task badges) still paint the fixed dark color system, and they
paint no background. An automatic switch would paint a half-light plane on a
light terminal, where the shared controls and overlays read but the base panes
stay light gray on white. The pin keeps the light pairs exercised in the suite
and in visual checks until the panes follow.

The blocking follow-up is the full light migration: the base panes and their
badges take their ink from the presentation, and only then may the switch on
the terminal's scheme come back. Until that lands, a light terminal reads the
plane in its dark presentation, which is the one the base panes were built for.

## What the implementation still leaves open

The library, and every field, selector, search, form action, form focus route,
Consultation view, Agent interaction mode, and Consultation confirmation panel
the control plane owns, are wired to the shared Control catalogue. The
remaining gaps: the screen-reader path has not been measured (see above), and
the base panes no shared module owns (the Ticket list and detail, the
Consultation list and detail panes, the Agent pane, and the Live view, with
their state and task badges) still paint the fixed dark color system, so a
pinned light presentation reads its shared controls and overlays, but not those
panes, on a light terminal. The automatic light switch is gated until the full
light migration lands (decision recorded above).
