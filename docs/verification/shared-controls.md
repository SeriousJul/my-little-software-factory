# Shared control verification

Status: the automated checks pass. The keyboard and visual acceptance targets
were verified in Ghostty and foot, in the dark and no-color presentations,
before the control plane began inheriting the Theme from herdr (ADR 0024); the
terminal walks have not been re-run on the theme-inherited paint, so they are
recorded as not re-verified for it, not as a pass. The screen-reader target is
not verified at all.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [the shared control standard](../development/shared-controls.md) for what the baseline
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
| Auto copy: a drag release ends with the selected text on the clipboard, a click that did not drag copies nothing, a refused write warns on the Message line while a copy that takes is silent, a drag release over a list row leaves the row selection as the press set it, and the ended selection clears its own highlight | `test/auto-copy.test.ts` | Passed |
| Closing keeps the launcher's whole form, and it comes back on the same Repository and Consultation type; Discard is the only delete | `test/consultation-launcher-editing.test.ts` | Passed |
| A Response draft stays saved through the existing persistence path | `test/consultation-frame.test.ts`, `test/consultation.test.ts`, `test/state.test.ts` | Passed |
| Type-ahead shows its search, matches by substring, keeps an unmatched query with `no match`, edits with Backspace, clears with one key, and keeps query and value distinct | `test/shared-gallery.test.ts`, `test/handoff-frame.test.ts`, `test/override-panel.test.ts` | Passed |
| The Action bar and Key guide agree with dispatch, and field editing is named in the guide | `test/key-guide.test.ts`, `test/action-bar.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Consultation list and Agent view navigation, response gating, recovery, history, close, delete, and refresh use the shared catalogue | `test/consultation-frame.test.ts` | Passed |
| The Consultation detail reads the Agent's session record as its body (operator input, agent text, tool notes), capped, and keeps the Agent view and captured history as its fallbacks | `test/turn-log.test.ts`, `test/consultation-detail.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Goto in the Consultation base mode focuses the Agent pane while the pane is alive in the last poll and states its reason otherwise, and never changes the Consultation | `test/controls.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Agent interaction mode exposes its configured exit control, preserves emergency exit, and forwards unclaimed input | `test/consultation-frame.test.ts` | Passed |
| The Consultation confirmation panel uses shared action selection and dispatch | `test/action-panel.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The standalone theme's text and indicator pairs clear the measured contrast (the only contrast-checked theme; an inherited herdr theme is not contrast-checked, ADR 0024) | `test/shared-presentation.test.ts` | Passed |
| The no-color presentation strips color and keeps labels, the focus marker, and state words | `test/shared-presentation.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The overlay surface paints the theme's own `panel_bg` role, and the text the surface's own rows paint clears the measured contrast on the surface it landed on | `test/reserved-rows.test.ts`, `test/shared-gallery.test.ts`, `test/key-guide.test.ts`, `test/shared-presentation.test.ts` | Passed |
| The plane paints the Theme the environment resolves: the inherited herdr theme's colors on rows, borders, badges, and the Message line, a light theme painting the whole plane light, the fallback warning on an unknown name, the standalone theme outside herdr, and `reset` roles and `NO_COLOR` painting no color | `test/theme-resolver.test.ts`, `test/theme-source.test.ts`, `test/theme-frame.test.ts` | Passed |
| The gallery shows the states a theme change must keep: the inherited theme's swatches, the fallback warning, a light theme painting the shared controls' ink, the per-token `[theme.custom]` overrides, and the no-color presentation | `test/shared-gallery.test.ts` | Passed |
| Decorative animation and caret blinking are off by default, and no check depends on a blink or a timer | `test/shared-presentation.test.ts`, the frame suite's bounded waits | Passed |
| Small and narrow frames keep the focused control and the way out; below a usable size the surface states its size and how to leave | `test/reserved-rows.test.ts`, `test/handoff-frame.test.ts`, `test/consultation-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The shared library is required: no screen builds its own field, names a renderer field, or hand-edits a draft string | `test/shared-control-architecture.test.ts` | Passed |
| The gallery's examples are the production modules | `test/shared-gallery.test.ts` | Passed |
| A control's written reason uses the width its surface names, and is cut to its own cells when the surface names none | `test/shared-controls.test.ts`, `test/override-panel.test.ts`, `test/shared-gallery.test.ts` | Passed |
| A row whose value cannot reach its Agent wears the warning tone and writes the Setting fit sentence under itself, at every width the panel renders at | `test/override-panel.test.ts`, `test/handoff-frame.test.ts` | Passed |
| A row that waits for the list its value would be judged against keeps that value in the tone of a setting it cannot confirm | `test/shared-controls.test.ts`, `test/handoff-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The override panel's state tones come from the shared palette, and the no-color presentation keeps a warning row's value and its whole sentence | `test/override-panel.test.ts` | Passed |

## Environment these checks ran in

| Part | Version |
| --- | --- |
| OS | Arch Linux, kernel 7.2.3-arch1-3 |
| Node | v26.8.1 (the pinned minimum is 26.4.0) |
| Renderer | OpenTUI `@opentui/core` 0.5.9, `@opentui/react` 0.5.9 |
| Test runner | vitest 4.1.11 |
| Multiplexer (tmux path) | tmux 3.7c |

## Required acceptance targets and their state

| Environment | Required checks | Result |
| --- | --- | --- |
| Linux with Ghostty | Keyboard and visual checks | **Verified** on Ghostty 1.3.1-arch2 under Hyprland 0.56.2 on this machine. All four gallery examples walked: typing, caret movement, selection shading, F3 copy (the terminal confirmed the clipboard), a paste refused as a whole with its reason, a taken paste, undo and redo, the F1 Key guide opening and closing, and Esc leaving the gallery. |
| Linux with foot | Keyboard and visual checks | **Verified** on foot 1.28.0: the same walk, with paste driven by foot's clipboard-paste key; the refused paste kept its value and stated why, the taken paste landed at the caret, the F1 Key guide opened and closed, and Esc left the gallery. `NO_COLOR` set on the same window: labels, the focus marker, and the state words survived with the colors off. **Not re-run** after the plane began inheriting the Theme from herdr (ADR 0024): the paint the walk measured was the fixed dark palette. |
| A light terminal with herdr's light theme | Visual checks | **Not verified under the theme mechanism.** The earlier check ran under the old `FACTORY_PRESENTATION=light` pin, which ADR 0024 removed: light is now a theme the plane inherits from herdr's config, and the base panes that half-migrated under the pin now paint the theme's roles. The suite checks the gallery's surface and every text it paints span by span, and a desktop re-walk on a light herdr theme is still to be recorded here. |
| A tmux path on Linux | Keyboard, paste, focus, and rendering checks | **Verified** by `test/tmux-fields.test.ts` on tmux 3.7c: the production gallery on a real pane, keys sent as terminal bytes, the screen read back with `capture-pane`. |
| Separate GNOME Terminal and Orca environment | Screen-reader operation | **Not verified.** Neither GNOME Terminal nor Orca is installed here, and the standard forbids changing an operator's desktop configuration as an unannounced setup step. No screen-reader claim is made anywhere in this repository. |

### Visual check procedure for Ghostty and foot

Run it on a machine with a desktop session, then record the versions and results
in this file. Do not mark the row verified from the automated suite.

1. `npm run gallery` and walk every example with `Tab`, the theme examples included.
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
6. Repeat with herdr's light theme active in the config (the plane inherits
   it on its next startup) and with the colors turned off (`NO_COLOR` set).

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

## The gallery's `notes` example

The gallery's `notes` example - the written reason at the width the surface
names, and the waiting row's dim tone - joined the gallery earlier in this
branch's line of work. The terminal walks above were run before it existed:
they are recorded as not re-verified for that example, not as a pass for it.

## The inherited Theme (issue #55, ADR 0024)

The control plane now inherits the Theme from herdr. The pure resolver
(`src/components/shared/theme.ts`) and its machine seam (`src/theme-source.ts`)
are covered by `test/theme-resolver.test.ts` and `test/theme-source.test.ts`:
name normalization and aliases, `auto_switch` to `dark_name`, all 18 vendored
built-in definitions (recorded as taken from herdr 0.9.0), per-token custom
overrides including `reset`, a bad override dropping only its token, the
inside-herdr versus outside-herdr defaults, and the `catppuccin` fallback with
its warning. The app frame seam is covered by `test/theme-frame.test.ts`: the
real app paints the inherited theme's colors on rows, borders, badges, the
Message line, and an overlay surface; the fallback warning reaches the Message
line in the fallback theme's own severity color; the standalone theme stands
outside herdr; and `reset` roles and `NO_COLOR` paint no color.
`test/shared-presentation.test.ts` keeps the contrast floor for the standalone
theme and the no-color integrity, and `test/shared-gallery.test.ts` drives
the gallery's `theme`, `theme-fallback`, and `no-color` examples. The full
suite passed in green on this branch.

The recorded limits, stated rather than hidden:

- Inherited theme pairs are **not contrast-checked**. The operator picks a
  herdr theme for the terminal they run in, and the plane neither tests nor
  clamps it. The contrast check runs on the standalone theme alone: the
  vendored set is the plane's data, and no test contrast-checks it.
- Light `auto_switch` is not followed: the plane resolves the `dark_name`
  theme and never guesses the host appearance.
- The terminal walks above (Ghostty, foot) measured the fixed dark paint and
  have **not been re-run** on the theme-inherited paint, so they are recorded
  as not re-verified for it. The light-herdr-theme visual walk is new and
  unrun.

## The light presentation: the decision (superseded)

The light presentation was once a pin, not an automatic switch: reachable only
through `FACTORY_PRESENTATION=light`, gated because the base panes no shared
module owned still painted the fixed dark color system. ADR 0024 supersedes
that decision: the pin and the light/dark presentation concept are removed,
light is a theme the plane inherits from herdr's config, and the base panes
now paint the theme's roles. The recorded desktop check under the pin stands
as history, not as a pass for the theme mechanism.

## What the implementation still leaves open

The library, and every field, selector, search, form action, form focus route,
Consultation view, Agent interaction mode, and Consultation confirmation panel
the control plane owns, are wired to the shared Control catalogue, and every
surface - the base panes included - paints from the shared Theme module (ADR
0020). The remaining gaps: the screen-reader path has not been measured (see
above), the terminal walks have not been re-run on the theme-inherited paint
(see the inherited-Theme record above), and inherited herdr theme pairs are
not contrast-checked (limit recorded there).

## The merged Main view (PR 42)

The merged Main view keeps the Consultation launcher and the response editor
on these same shared modules, so the checks above cover the fields, choices,
actions, and focus routes those two surfaces now run. The section
architecture around them - the section headers, the pane switch, and the
Catalogue rows the Ticket and Consultation sections add - is covered by the
automatic suite, which passed in full on the merged branch. The terminal
walks above were not re-run on the merged Main view: they are recorded as
not re-verified for that view, not as a pass.

## The dual-list Main view (issue #49)

ADR 0019 replaces the accordion with two stacked list sections and one
context-dependent detail pane: `t` and `v` are gone, `x` toggles the section
under the cursor, the Consultation close moved to `z`, and up and down cross
the section boundary. The automatic suite covers the headers, the steady
counts, the collapse, and the cross-section navigation, and it passed in full
on this branch. The terminal walks above were not re-run on the dual-list Main
view: they are recorded as not re-verified for that view, not as a pass.

## The Session view in the Consultation detail (issue #67)

ADR 0025 reads the Agent's session record as the Consultation detail's body:
the operator's inputs, the agent's text, and the tool notes, in order, capped,
re-read on the detail's refresh while the Consultation is open, and read once
for the after-the-fact review of a closed Consultation. The record's rows sit
under the `Session view` border title; when the record cannot be read, the
older bodies remain the fallback under the `Agent view` title: the live pane
output for an open Consultation, the captured history for a closed one. The
Goto control in the Consultation base modes (`g`) focuses the Agent pane while
it is alive in the last poll and states its reason otherwise; it is a
navigation, and it never changes the Consultation.

The automatic suite covers the record's parsing and caps (`test/turn-log.test.ts`),
the body's selection and rows (`test/consultation-detail.test.ts`), Goto's
availability and dispatch (`test/controls.test.ts`), the four new gallery
examples a reviewer must see (`test/shared-gallery.test.ts`), and the two
end-to-end frame tests: a working detail that shows the record's rows and
focuses with `g` without touching the Consultation, and a closed Consultation
whose record is shown and whose Goto states its reason when the poll drops
the pane. It passed in full on this branch.

The terminal walks above were not re-run on the Session view's paint: they are
recorded as not re-verified for that body, not as a pass. The screen-reader
target remains unverified.
