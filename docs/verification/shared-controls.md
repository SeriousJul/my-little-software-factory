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

Every check below runs in `bun test`, which is `bun run lint`,
`bun run typecheck`, and the behavior suite together.

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
| Consultation list and Agent view navigation, response gating, recovery, history, close, delete, and refresh use the shared catalogue, and Enter opens the recovery surface each broken or stuck state needs (ADR 0038) | `test/controls.test.ts`, `test/consultation-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| Consultation close is key `w` in both Consultation modes (#80): a closed record refuses readably, a `missing` or a `failed` one closes directly, a live Agent stops behind the shared panel, a `closing` one opens the panel with its retry and force-close, and the Ticket section's `w` stays its own Close in each section's guide and bar | `test/controls.test.ts`, `test/consultation-frame.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Consultation detail reads the Agent's session record as its body (operator input, agent text, tool notes), capped, and keeps the Agent view and captured history as its fallbacks | `test/turn-log.test.ts`, `test/consultation-detail.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The Consultation-only keys `d` and `f` refuse in both Ticket base modes with the section's own words, claim the key so nothing else answers it, and the Ticket guide and bar omit both controls; the Consultation Delete stands in neither of the Work queue's modes, where `d` is the queue's own reorder and answers with its own refusal | `test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/main-view-frame.test.ts` | Passed |
| No refused key is hinted by the Action bar unless the Key guide names it, in every base mode (the catalogue-wide guard that keeps the refusal, the guide, and the bar in step) | `test/controls.test.ts` | Passed |
| Goto in the Consultation base mode focuses the Agent pane while the pane is alive in the last poll and states its reason otherwise, and never changes the Consultation | `test/controls.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Goto in the Ticket base modes (`g`) focuses the agent's pane on an in-flight ticket while the pane is alive in the last poll, on an `awaiting` ticket while the handoff recorded a pane, and states the Consultation's own refusal otherwise; it never moves the ticket's state, and the Decision modal's and Live view's Goto rows moved none | `test/controls.test.ts`, `test/live-view.test.ts`, `test/auto-mode.test.ts`, `test/domain.test.ts`, `test/state.test.ts` | Passed |
| Close in the Ticket base modes (`w`) ends the selected ticket's work cycle behind the shared confirmation panel: it refuses an `open` ticket with its reason, opens the dialog with the body its own handoff's environment states on an in-flight or `awaiting` one, leaves everything unchanged on Cancel, ends an in-flight cycle with no completion trace, records the `closed` decision on an `awaiting` one, stops the agent through the Close cleanup, and records the leftover herdr refuses | `test/controls.test.ts`, `test/ticket-close.test.ts`, `test/domain.test.ts`, `test/state.test.ts`, `test/handoff-dispatch.test.ts`, `test/auto-mode.test.ts` | Passed |
| The confirmation panel dispatches the Ticket close's rows through the catalogue, and the gallery holds the dialog's states | `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Work queue's list and its item detail dispatch from the catalogue: the row keys, `u` and `d` reorder and `Del` removal of the item under the cursor in both of the queue's modes, each with its stated refusal (no item selected, the item already first or last), and the detail's scroll answers where the facts overflow the pane | `test/work-queue-frame.test.ts`, `test/shared-control-architecture.test.ts`, `test/key-guide.test.ts`, `test/action-bar.test.ts` | Passed |
| The queue's detail states the captured facts - the ticket, the origin, and the choice with its settings left to the agent - and a stored row the reader cannot name stays in view with its damage in place of a repaired start; the gallery holds both states and the empty queue | `test/work-queue-frame.test.ts`, `test/work-queue.test.ts`, `test/shared-gallery.test.ts` | Passed |
| One queue item per ticket (ADR 0034): the store refuses a second add of a ticket that already waits, and the handoff that reached it reports the refusal on the Message line with the queue's depth unchanged | `test/work-queue.test.ts`, `test/work-queue-frame.test.ts` | Passed |
| The cursor crosses to and from the Work queue over a section the operator collapsed or the terminal cannot pay for, in both directions, and the Action bar's Move hint agrees with the key | `test/work-queue-frame.test.ts`, `test/main-view-frame.test.ts` | Passed by the automated suite. The frame is what the checks read: no screen-reader path was measured for the queue, and the terminal walks above have not been re-run for it. |
| Agent interaction mode exposes its configured exit control, preserves emergency exit, and forwards unclaimed input | `test/consultation-frame.test.ts` | Passed |
| The Consultation confirmation panel uses shared action selection and dispatch | `test/action-panel.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The standalone theme's text and indicator pairs clear the measured contrast (the only contrast-checked theme; an inherited herdr theme is not contrast-checked, ADR 0024) | `test/shared-presentation.test.ts` | Passed |
| The no-color presentation strips color and keeps labels, the focus marker, and state words | `test/shared-presentation.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The spinner paints its named first frame beside its written word in the state-word tone, drives its own frames in the test renderer through the shared `useSpinnerFrame`, stands still on that hook's inactive flag, and the no-color presentation keeps its word and drops only its color | `test/shared-controls.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Starting window (ADR 0030): a claim in flight or a `handed-off` ticket wears the face - the animated glyph with the written word `starting` - in the state badge slot of the list row and of the detail's state line, from the keypress, for every origin (manual, auto, workflow route, restart), and the `[handed-off]` badge is never drawn; a failed start ends the face and returns the row to its state, a turn that settles under a `handed-off` ticket ends it at the badge that state rests in, and the observation ends it at `[running]`; the failure markers (`blocked`, `missing`) and a crash remnant's recovery fact beat the face, and the detail states the marker's word in the line the face held; `NO_COLOR` keeps the written word in row and detail and drops only the color | `test/starting-face.test.ts`, `test/app.test.ts`, `test/handoff-frame.test.ts`, `test/live-view.test.ts`, `test/action-bar.test.ts`, `test/theme-frame.test.ts` | Passed by the automated suite. The animated frame is not something a frame snapshot verifies: the checks run on the written word beside any glyph of the face. The row and the detail drive the shared frame separately, so the two glyphs can stand on different frames for a moment; the word carries the fact. The terminal walks above have not been run for the face, and the suite has not been re-run on a herdr-inherited theme for it. |
| The overlay surface paints the theme's own `panel_bg` role, and the text the surface's own rows paint clears the measured contrast on the surface it landed on | `test/reserved-rows.test.ts`, `test/shared-gallery.test.ts`, `test/key-guide.test.ts`, `test/shared-presentation.test.ts` | Passed, but with the shared-presentation contrast checks skipped (issue #103) and the Key guide 44-column reason walk skipped (issue #104) |
| The plane paints the Theme the environment resolves: the inherited herdr theme's colors on rows, borders, badges, and the Message line, a light theme painting the whole plane light, the fallback warning on an unknown name, the standalone theme outside herdr, and `reset` roles and `NO_COLOR` painting no color | `test/theme-resolver.test.ts`, `test/theme-source.test.ts`, `test/theme-frame.test.ts` | Passed, but with the theme-frame inheritance checks skipped (issue #103) |
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
| OS | Arch Linux, kernel 7.2.5-3-omarchy |
| Node | v26.8.1 (the pinned minimum is 26.4.0) |
| Renderer | OpenTUI `@opentui/core` 0.5.11, `@opentui/react` 0.5.11 |
| Test runner | `bun test`, Bun 1.4.0 |
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

1. `bun run gallery` and walk every example with `Tab`, the theme examples included.
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
   `bun run gallery`, then the control plane itself.
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
navigation, and it never changes the Consultation. Its confirmation is a
result on the Message line, never a warning, and it names the workspace
herdr shows, so the operator can switch herdr's view there: since herdr 0.9
a CLI focus no longer moves an attached client's view.

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

## The Consultation-only keys in the Ticket section (issue #85)

Keys `d` (Delete) and `f` (History) belong to the Consultation section. In
both Ticket base modes the keys still resolve, and the shared dispatch states
the refusal on the Message line in the catalogue's own words - "this control
is available only in the Consultation section", the mirror of the Ticket
section's refusal - and claims the key, so nothing else may answer it. The
Ticket guide omits both controls from every one of its sections, and the
Ticket bar hints neither key: the bar hints no key its guide omits. The
Consultation section's guide and bar keep both hints unchanged, and the keys
keep their Consultation meanings, including the closed-Consultation delete.

The section ownership is stated once per control in the catalogue
(`consultationSectionOnly`), and the refusal (availabilityFor), the guide
omission, and the bar omission all read it; no id list, and no inverted copy
of the same predicate. A catalogue-wide guard test walks every base mode and
fails if a refused key is hinted by the bar while the guide does not name it,
so the next Consultation-only key cannot refuse in the Ticket section and
still show up in its guide or bar.

The automatic suite covers the refusal and the key claim in both Ticket
modes, the untouched Consultation meanings, and the guard test itself
(`test/controls.test.ts`), the bar's omission (`test/action-bar.test.ts`),
the guide's rows and ranges (`test/key-guide.test.ts`), and the frame test
that presses `d` and `f` in the Ticket list and again in the Ticket detail,
checks the refusal on the Message line, and compares both sections' rows and
both list selections before and after every press, so the refusal is shown
to change nothing (`test/main-view-frame.test.ts`).

On the rebased catalogue (after ADR 0031 put a `w Close` row in the Ticket
guide) the counts were re-measured, not computed: the Ticket guide holds 54
rows at the full width where it held 56 with Delete and History present, the
scroll ladder walks 35 steps to the bottom row `36-54/54`, and the narrow
60x12 case holds 75 rows where it held 77. The guide screenshots need no
regeneration: neither section's Action bar changed, and the Key guide is not
screenshotted, so `test/screenshot-drift.test.ts` passes against the
committed images.
On this branch `bun run lint` and `bun run typecheck` pass, and
`test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`,
`test/main-view-frame.test.ts`, and `test/screenshot-drift.test.ts` each pass
in isolation. The full `bun run test` passes on the rebased branch (1506 pass,
13 skip, 0 fail): the frame flakes issues #103 and #104 record did not show on
this run, and the 13 skips are the ones that record already holds.

The display rule the section asymmetry rests on - the Consultation guide
names a refused `e Override` dim, while the Ticket guide and bar omit the
refused `d` and `f` - is written down in the
[shared control standard](../development/shared-controls.md), so the next
contributor does not "fix" one direction to match the other.

The terminal walks were not re-run on the changed bar and guide rows: they
are recorded as not re-verified for this change, not as a pass. The
screen-reader target remains unverified.

## The Ticket section's Goto key (issue #82, ADR 0033)

ADR 0033 makes key `g` a base-mode control of the Ticket section, in both
base modes: it runs the same focus the Decision modal's and the Live view's
Goto rows run, confirms on the Message line with the workspace name, and
changes no record. It is available on an in-flight ticket whose agent is
alive in the last poll and on an `awaiting` ticket whose handoff recorded a
pane; elsewhere it refuses with the Consultation's own words. The state move
the modal Goto carried, `awaiting` back to `running`, is gone from every
Goto: the poll already makes that move when the agent works again, and the
badge stays true while the ticket rests.

The automatic suite covers the control's availability, refusal, and dispatch
(`test/controls.test.ts`), the gallery example a reviewer must see
(`test/shared-gallery.test.ts`), the Action bar's and the Key guide's rows
for the new control (`test/action-bar.test.ts`, `test/key-guide.test.ts`),
the domain and state machines without the `goto` decision
(`test/domain.test.ts`, `test/state.test.ts`), and the end-to-end frames: `g`
on an in-flight ticket focuses the pane and moves nothing
(`test/live-view.test.ts`), `g` on an `awaiting` ticket focuses the recorded
pane and leaves it `awaiting` (`test/auto-mode.test.ts`), and `g` on an
`open` ticket refuses on the Message line without focusing anything
(`test/live-view.test.ts`). The guide screenshots were regenerated on this
branch (`npm run screenshots`), and the drift check passed. The suite passed
in full on this branch.

The terminal walks were not re-run on the Action bar's and the Key guide's
new row: they are recorded as not re-verified for this control, not as a
pass. The screen-reader target remains unverified.

## The Ticket section's Close key (issue #83, ADR 0031)

ADR 0031 makes key `w` a base-mode control of the Ticket section, in both base
modes, on the key ADR 0032 freed. ADR 0037 later gave the same key to the
Consultation section's close, so `w` closes whichever section holds the cursor:
the catalogue resolves it per mode, and the Key guide of a Ticket pane lists the
Consultation close among the control-plane controls it catalogues on its own
terms, never as this mode's key (`test/controls.test.ts`). It refuses an `open`
ticket with its reason, and asks first on every state that has work behind it.
The shared confirmation panel states who is alive - the Agent working, the pane
herdr no longer lists, or the turn settled - and then what survives, read off
that ticket's own environment: the worktree checkout and the workspace behind
it, with a dirty checkout left standing as a leftover, or the live worktree's
tab alone with the checkout, the workspace, and the tabs beside it kept. The git
branch stays in every case, and the Cancel row states the same fact about the
pane that the body's first line states.

The confirmed answer is two closes with one cleanup. An `awaiting` ticket takes
the Decision modal's own close: the `closed` decision on its settled turn's
trace, then the Close cleanup - one function, so the modal's row and the key
cannot drift. An in-flight ticket ends its cycle through a state operation of
its own that writes no completion trace, because the turn never settled and no
cause, turn log, or message exists to record. Both wait their turn on the
shared environment seat, so a close that meets a Handoff of the same ticket
runs after it settles. The whole close suite measures the two cycle-end gates
reading the absent row as a cycle end that holds nothing and re-verifies
nothing, the way they read an abandon without a cause, and the Handoff limit
counting the closed cycle like any other. Both gates name the newest ended
cycle as `work_cycle - 1`, and a check pins the invariant that reading stands
on: the only statements that move a ticket's `work_cycle` are the two cycle ends
(`test/state.test.ts`).

The automatic suite covers the control's availability, refusal, and queue
(`test/controls.test.ts`), the dialog's facts (`test/ticket-close.test.ts`),
the state line and the durable close with its gates
(`test/domain.test.ts`, `test/state.test.ts`), the seat order and the leftover
fact through the dispatch interface (`test/handoff-dispatch.test.ts`), the
gallery's two dialog examples (`test/shared-gallery.test.ts`), the Action
bar's and the Key guide's rows for the new key (`test/action-bar.test.ts`,
`test/key-guide.test.ts`), and the end-to-end frames: the refusal on an open
ticket, the body and Cancel on both environments, the traceless close with its
cleanup, the refused cleanup's leftover, the awaiting close with its decision,
and the open dialog that lets go of its keys when the observation ends its cycle
from under it (`test/auto-mode.test.ts`). The Action bar's ladder and the Key
guide's row counts are re-measured on the rebased catalogue, where both sections
hold a Close at priority 50 in their own modes, and the close's frames wait on
the `missing` marker ADR 0030 puts before the Starting face. The guide
screenshots were regenerated on this branch (`bun run screenshots`), and the
drift check passed. The suite passed in full on this branch (1497 pass, 13 skip,
0 fail), with the checks issues #103 and #104 already record as skipped still
skipped.

The terminal walks were not re-run on the new key, its bar row, or the dialog:
they are recorded as not re-verified for this control, not as a pass. The
screen-reader target remains unverified.

## Enter's recovery meaning in the Consultation section (issue #84, ADR 0038)

ADR 0038 gives the Consultation section a third meaning of `Enter`: the key
opens the surface the selected record's state needs. A `working`, an
`awaiting-response`, and a blocked Consultation keep Interact, Respond, and
Interact. An `opening`, a `missing`, or a `failed` one opens the recovery panel,
whose rows the record's state names: Recover and Close on the interrupted
opening, Replace and Close on the record with no Agent. A `closing` one opens
the close panel that already carries its Retry and Force-close, and a `closed`
one refuses with the reason the close control already stated.

The automatic suite covers the resolution and the reasons
(`test/controls.test.ts`), the flows through the real application: `Enter`
opening the panel and each row running its own operation, the Replace row
carrying the durable recovery context onto the launcher and the link onto the
new record, the Close row taking the close path with its dialog for a live
Agent and without one for a record with none, and the closed refusal
(`test/consultation-frame.test.ts`), and the panel's three states drawn from
the production module in the gallery (`test/shared-gallery.test.ts`). The Key
guide names the recovery meaning of `Enter` in the Consultation section, and
the Action bar's row and reason follow the catalogue
(`test/key-guide.test.ts`, `test/main-view-frame.test.ts`).

The Action bar's ladder and the Key guide's row counts are re-measured on the
rebased catalogue, not computed: the guide now holds 55 rows at the full width
where PR #114 measured 54, its scroll ladder walks 36 steps to the bottom row
`37-55/55`, the narrow 60x12 case holds 79 rows where it held 75, and the
Control plane section lists `Enter Recovery` ahead of `Enter Respond` and
`Enter Interact`. The gallery's example list carries the three recovery states
beside the two Ticket Close dialogs (`test/shared-gallery.test.ts`). The guide
screenshots still match the app: the drift check in
`test/screenshot-drift.test.ts` passed on the merged catalogue, so no image was
redrawn. The suite passed in full on this branch:
`bun run lint`, `bun run typecheck`, and `bun run test` (1517 pass, 13 skip,
0 fail).

The terminal walks were not re-run for this control's Action bar and Key guide
row: they are recorded as not re-verified for it, not as a pass. The
screen-reader target remains unverified.

## The Work queue's rows join the recovery rows (issue #88, ADR 0034)

This PR's queue rows (`u Move up`, `d Move down`, `Del Remove`, and the
queue's detail rows) and ADR 0038's `Enter Recovery` row now ride the same
catalogue. The counts are re-measured on the merged catalogue from real
frames, not computed: the guide holds 59 rows at the full width where the
recovery row alone measured 55, its scroll ladder walks 40 steps to the
bottom row `41-59/59`, and the narrow 60x12 case holds 83 rows where it
held 79 (`test/key-guide.test.ts`). The queue's own guide entries, mode
names, and refusals stand as recorded above.

## The aligned control surface (issues #80–#85)

The acceptance pass over the finished close and goto alignment, per the
shared control standard. The alignment gave the two sections the same
discipline on the same keys: the Consultation close moved to `w` with its
confirmation on a live Agent (#80), the leftover clear was removed while the
leftover stayed a fact herdr clears (#81), the Ticket Goto took `g` as pure
navigation (#82, ADR 0033), the Ticket Close took `w` with its confirmation
dialog (#83, ADR 0031), `Enter` gained its recovery meaning in the
Consultation section (#84, ADR 0038), and the Consultation-only keys in the
Ticket section learned to refuse in the section's own words (#85).

The full automated suite passed in full on this branch: lint, typecheck, and
the behavior suite, run through the package scripts, with 1517 pass, 13
skip, 0 fail - the same counts the issue #84 record measured on the merged
catalogue, and the 13 skips are the ones this record already holds as
skipped. On the versions in the table below.

The gallery holds every state the alignment added or changed, drawn from the
production modules, and `test/shared-gallery.test.ts` walks each one:

- `ticket-goto`: the Ticket Goto available on an alive pane and refused
  otherwise, as two rows of the real Action bar.
- `ticket-close` and `ticket-close-live-worktree`: the Ticket Close dialog
  on an in-flight ticket (the worktree checkout goes, a dirty one stays)
  and on an `awaiting` ticket with the live worktree.
- `close-dialog-awaiting-response` beside `close-dialog-opening`,
  `close-dialog-working`, and `close-panel-closing`: the Consultation close
  dialog on an `awaiting-response` record, and the panel the `closing` one
  opens instead.
- `recovery-panel-opening`, `recovery-panel-missing`, and
  `recovery-panel-failed`: the Consultation recovery panels on their states.

The Action bar names only keys that did what they said, in every mode the
alignment touched, by the automated checks rather than by this pass's walk:
in the four base modes the catalogue-wide guard fails if a bar hint names a
key the mode refuses while its guide does not name it, and the per-mode
tests press each aligned key where dispatch claims it - `g` in the Ticket
and the Consultation panes, `w` in each section's own modes, and `Enter` on
the broken and stuck Consultations - and check the operation, while the
refused keys refuse on the Message line and leave every row unchanged
(`test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`,
`test/main-view-frame.test.ts`, `test/live-view.test.ts`,
`test/auto-mode.test.ts`, `test/consultation-frame.test.ts`).

The required checks this pass could not run are recorded as incomplete, not
as a pass:

- The gallery walk over the new states was not performed in a terminal on
  this pass; the states stand verified by the automated gallery suite only.
  Incomplete against the gallery-walk criterion.
- The terminal walks (Ghostty, foot) were not re-run on the aligned Action
  bar and Key guide rows, so the visual confirmation that the bar names
  only keys that did what they said was not observed in a terminal on this
  pass. Incomplete for the alignment, in the standing sense recorded for
  the earlier changes.
- The light-herdr-theme visual walk remains unverified under the theme
  mechanism, and the screen-reader path remains unverified, as recorded
  above. No screen-reader claim is made for the alignment.

Measured on Arch Linux (kernel 7.2.5-3-omarchy), Bun 1.4.0, Node v26.8.1,
OpenTUI `@opentui/core` 0.5.11, and tmux 3.7c.

## The native row-update corruption (OpenTUI, open as of 0.5.11)

A user report: streaming agent output in the Session view left stale text
overlapping the new rows, until a text selection cleared it. The reproduction
is `scripts/repro-tmux-live.ts`: it runs the real control plane inside tmux
(the byte path is a battle-tested VT) on the repo fixture, streams 120-249
cell lines from the fixture agent pane at 80 ms, captures the pane every
100 ms for 40 s, and checks that the visible stream lines stay a contiguous
run. It also records the exact bytes the app writes (tmux `pipe-pane`), so a
corrupted frame can be decoded and told apart from a transport or terminal
defect.

Measured on this machine (Bun 1.4.0, Linux x86-64, tmux 3.7a), 40 s runs:

- `@opentui/core` 0.5.9: 19-30 corrupted captures per run.
- `@opentui/core` 0.5.11: 0-30 corrupted captures per run; the corruption
  was measured present in 0.5.11 as well. The upgrade to 0.5.11 landed
  anyway: it is the newest release, and it carries fixes for the same
  failure family (a final frame lost behind backpressure, and split diffs
  misaligned after a resize).

The byte records place the fault in the renderer, not in the transport or
tmux: the app's own synchronized frames carry the corrupted rows. The
corruption takes two forms - a row's head truncated with the next row's
text merged into the same physical row, or a row truncated with the next
row or rows missing - and the corrupted content persists in the emitted
frames until the next content update overwrites it. In a streaming view the
next update heals it within a second; in a static view nothing re-sets the
row, so the artifact stands until any interaction forces a re-render. A text
selection does exactly that, which matches the user's report.

The failure signature matches the stale-buffer class of OpenTUI issue 1212
(fixed for the Node 26 adapter), but the owner-retention mechanism that fix
added is present in the Bun builds of both 0.5.9 and 0.5.11, and the
corruption still occurs: the remaining window is a separate native defect,
or a path the fix did not cover.

Local variations were measured, not reasoned: re-keying the body rows by
identity (40, 39, 9, 10 corrupted captures), toggling the plane's
force-full-repaint (29, 0, 10, 9, 29, 29), and pinning the wrapped row
strings to stable references (20, 30, 30, 29, 29) all landed inside or
above the 0.5.11 baseline range (0-30); none reduced the rate, and the
stable-reference change made the worst runs worse, so it was reverted.
Consolidating the body into one text element rendered wrong and was
reverted. The force-full-repaint in `src/factory.ts` stays: it is the
recorded workaround for the drift class of OpenTUI issue 1187.

This is recorded as an open upstream defect, not as a pass. The
`bun run lint`, `bun run typecheck`, and `bun test` checks pass in full on
0.5.11 (1461 tests).
