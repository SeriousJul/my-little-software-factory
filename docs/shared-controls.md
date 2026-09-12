# Shared control standard

Status: accepted, and the baseline is implemented for every editable field,
selector, search, form action, and form focus route the control plane owns.
Confirmed on 2026-09-09; implemented in the shared control library under
[src/components/shared](../src/components/shared).

The current results for every acceptance target, with their versions, are in
[the verification record](verification/shared-controls.md): the keyboard and
visual targets ran in Ghostty and foot, and a tmux path runs in the suite; a
screen reader has never read this application, and no claim of screen-reader
support is made anywhere in this repository.

This is the required baseline for human and agent contributors.

See [the glossary](../CONTEXT.md) for domain terms,
[ADR 0014](adr/0014-shared-modules-own-control-behavior.md) for ownership, and
[the accessibility research](research/terminal-accessibility.md) for evidence.

## Scope and ownership

Every control owned by the control plane must use shared modules: Text fields,
Draft fields, selectors, actions, list navigation, modal focus, and help and
message controls. The library stays inside this repository. It is not a separate
published package or a library for other projects.

Controls inside an external Agent's own application are excluded. The control
plane still owns its way into and out of the Agent terminal. Shared editing
bindings must not replace the keys that this mode forwards to the Agent.

The shared modules own:

- Editing, caret movement, selection, undo and redo, and safe paste.
- Focus movement, modal focus containment, and focus restoration.
- Labels, hints, error presentation, state indicators, and sizing.
- Integration with the Control catalogue, Action bar, and Key guide.

Screens supply values, validation rules, availability facts, and domain actions.
Draft storage and Agent operations stay outside the shared modules. Callers must
not need to manage renderer buffers, keyboard subscriptions, or caret repair to
use a field correctly.

Reuse the existing shared control and modal code where it fits this standard.
OpenTUI's field primitives are candidates for the shared implementation, not
public escape routes for separate screen-specific editors. Do not create a
second key definition system that can disagree with dispatch or help.

## Editing and keyboard ownership

Both field kinds must support normal caret and word movement, Home and End,
Backspace and Delete, selection, undo and redo, and bracketed paste. Unicode
editing must not corrupt characters or place the visible caret at a different
location from the next edit. The focused field must remain visible as its text
scrolls and the terminal resizes.

| Control | Required behavior |
| --- | --- |
| Tab / Shift+Tab | Move to the next or previous field or action. |
| Arrows in a Draft field | Move the caret, not the form's focus. |
| Enter in a Draft field | Insert a newline. |
| Send / Launch | Visible, keyboard-reachable actions that submit the draft. |
| Modified Enter | May supplement submission; never its only route. |
| F1 | Open the Key guide without modifying the field. |
| F2 | Open the Message view when available. |
| Ctrl+C | Emergency exit for control-plane input; selection does not change it into Copy. |
| Copy selection | A keyboard-reachable action, separate from emergency exit. |

Ordinary printable characters belong to a field that accepts typing, including
letters that act as shortcuts outside that field. Support terminal paste.
Essential actions must remain available with ordinary terminal key sequences,
without an enhanced keyboard protocol.

Keyboard field selection and Copy do not decide global host mouse ownership.
Do not enable mouse reporting merely to implement keyboard editing or replace
host selection and clipboard policy. Coordinate with
[the host-selection issue](https://github.com/SeriousJul/my-little-software-factory/issues/10)
without treating field Copy as a replacement for host copy of visible output.

A modal keeps focus inside itself and restores the previous focus when closed.
Opening and closing Help must preserve the draft, caret, selection, and undo
history. Input must not reach a field or screen behind an active modal.

## Values, validation, and paste

Every field has a visible label. Errors identify the affected field and explain
why the value cannot be used. State and errors must not depend on color alone.
Validation rules belong to the caller; their presentation and editing behavior
belong to the shared module.

A Context Text field still takes digits only. Reject a paste containing any
non-digit as a whole, preserve the previous value and selection, and explain the
rejection. Never turn `1e3` into `13` by removing the letter. Keep the existing
count validation and leading-zero normalization: `007` and `7` represent the
same count, while `0` is not a valid count.

This refines the entry behavior in [ADR 0009](adr/0009-handoff-setting-resolution.md).
It does not change setting resolution, the meaning of a count, or the rule that
an invalid setting cannot start Agent work.

Keep an oversized Draft field editable and state its size and limit. Do not
silently truncate it to make submission succeed. Paste is text entry, not an
instruction to submit or invoke application shortcuts.

## Type-ahead

Keep substring matching against the Model list. Show the editable search text.
When no Model matches, retain that text and show `no match`; do not silently
restart the search from the last character. Backspace edits the search. Provide
an explicit clear action.

The search is distinct from the selected Model value. This changes the old
invisible-search definition; it does not change how the Agent supplies its
Model list or which Models are valid.

## Draft retention

Closing an editor and discarding its content are different actions.

- Escape leaves a Response draft saved as it is today.
- Closing and reopening the Consultation launcher during one application run
  restores the complete unfinished form: text, Repository, and Consultation type.
- The launcher states that this form is not saved across application restarts.
  Durable launcher drafts are outside this baseline.
- Provide an explicit Discard action. Closing the launcher must not silently
  discard its text or restore it with a different Repository or type.

Draft persistence belongs to the screen's domain state, not to the field module.

## Presentation

- Use tested foreground/background pairs with at least 4.5:1 text contrast and
  3:1 contrast for essential control indicators.
- Support light, dark, and no-color presentation. Preserve labels, focus markers,
  and written state and error indicators when color is absent.
- Keep the focused control and the way out visible at supported small sizes.
  Below a usable size, preserve editing state and provide a readable size message
  and a way out rather than allowing overlapping or hidden controls.
- Decorative animation and caret blinking are optional and off by default.
- Progress remains understandable through text and static indicators.

These are testable application requirements, not a claim of WCAG conformance or
of compatibility with every terminal color override.

## Contributor examples and enforcement

Provide one runnable terminal gallery that uses the real shared modules. It must
show normal, focused, invalid, unavailable, loading, and narrow-size states where
applicable. Use those examples in automated tests so examples cannot become a
separate imitation of the production controls.

Human and agent contributor instructions link to this standard and to the
gallery. The gallery command is `npm run gallery`, or
`node bin/factory-gallery.mjs [example]`, and it draws the production modules.
The same examples are driven by `test/shared-gallery.test.ts`, so an example
cannot become an imitation of a control.

Automated checks must reject new separate field implementations and bypasses of
the shared control modules. Add behavior tests through the modules' public
interfaces and end-to-end tests through real application flows. A screenshot
alone does not prove keyboard ownership, editing, or screen-reader access.

## Required verification

The initial acceptance targets are:

| Environment | Required checks | Current result |
| --- | --- | --- |
| Linux with Ghostty | Keyboard and visual checks | [The verification record](verification/shared-controls.md) |
| Linux with foot | Keyboard and visual checks | [The verification record](verification/shared-controls.md) |
| A tmux path on Linux | Keyboard, paste, focus, and rendering checks | [The verification record](verification/shared-controls.md) |
| Separate GNOME Terminal and Orca environment | Screen-reader operation | Not verified |

The results live in [the verification record](verification/shared-controls.md),
which states what was measured, on what, and what was not measured: the
screen-reader path is the target that has never run. Record the exact OS,
terminal, multiplexer, renderer, and screen-reader versions used, as
applicable. Other platforms remain unverified, not implicitly supported.

The checks must cover:

- Caret and word movement, selection, deletion, undo and redo, and Unicode text.
- Normal and enhanced key sequences, bracketed paste, numeric paste rejection,
  oversized drafts, and prevention of accidental submission.
- Tab order, modal containment and restoration, and Help without loss of editing
  state.
- Draft retention, explicit discard, and Repository/type identity on reopening.
- Type-ahead feedback and correction, including no-match searches.
- Light, dark, and no-color output, contrast, resize, and narrow/short terminals.
- A real screen reader's access to labels, values, focus and caret location,
  selection, errors, modal changes, and progress feedback.
- Agreement between available actions, dispatched keys, the Action bar, and the
  Key guide.

Use rendered-frame tests, the production executable's PTY tests, visual review,
and a real screen-reader test. These checks complement each other. PTY bytes and
frame snapshots cannot establish what Orca receives. A required test that is
skipped or cannot run is not a pass.

## Migration and completion

1. Reproduce the reported field failures through real application flows with
   isolated state and fake external operations. Record failing regression tests.
   Done: `test/shared-field-editing.test.ts`,
   `test/consultation-launcher-editing.test.ts`, and
   `test/executable-fields.test.ts`.
2. Test screen-reader feasibility early, before broad migration. Upstream still
   lists screen-reader support as future work. If the current renderer prevents
   the agreed access, return for agreement on a renderer change or an equivalent
   accessible interaction mode. Do not silently remove the requirement.
3. Build the shared field behavior and real examples. Migrate Text fields and
   Draft fields first, including the override panel, Consultation launcher, and
   response editor. Done: the library, the gallery, and all three surfaces,
   with the replaced local implementations removed.
4. Migrate selectors and the remaining owned controls in small changes. Remove
   replaced implementations rather than retaining permanent alternatives.
5. Add and enforce the architecture checks. Update current-behavior documentation
   and contributor instructions as each migration lands. Done: the architecture
   test, this standard, [the README](../README.md), and
   [the contributor instructions](../AGENTS.md).
6. Complete all acceptance checks and record their results.

The migration is complete only when every owned control follows this standard
and lint, type checks, behavior tests, terminal tests, visual review, and
screen-reader checks pass. Documentation and a new component directory alone do
not meet this condition.

The verification commands are `npm run lint`, `npm run typecheck`, `npm test`,
and `npm run gallery`. The architecture rule is checked by
`test/shared-control-architecture.test.ts`, which rejects a separate field
implementation, a hand-edited draft string, and a screen that names a renderer
field instead of the library. The screen-reader procedure is written down in
[the verification record](verification/shared-controls.md); it has not been
run, and no result is claimed for it.
