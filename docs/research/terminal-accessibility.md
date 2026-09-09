# Terminal accessibility: evidence and open checks

Checked on 2026-09-09 during the shared control library design session.
This note records evidence, not a claim that the control plane is accessible.
No screen-reader acceptance test has run.

## Findings

### OpenTUI has editing primitives

The installed OpenTUI declarations provide single-line `InputRenderable` and
multi-line `TextareaRenderable`. Their shared edit-buffer interface includes
caret movement, selection, undo and redo, wrapping, and cursor presentation.
Textarea also handles paste. These are candidates for reuse, not proof that
the control plane uses them correctly or that assistive technology can read them.

Sources inspected:

- [Installed Input declarations](../../node_modules/@opentui/core/renderables/Input.d.ts)
- [Installed Textarea declarations](../../node_modules/@opentui/core/renderables/Textarea.d.ts)
- [Installed edit-buffer declarations](../../node_modules/@opentui/core/renderables/EditBufferRenderable.d.ts)

### Upstream screen-reader support is still a roadmap item

The OpenTUI roadmap places this item under "Next":

> Accessibility: add screen-reader support

The fetched issue was open and was last updated on 2026-08-25. This supports
treating screen-reader compatibility as an open risk. It does not prove that
every terminal and screen-reader combination fails.

Sources:

- [OpenTUI roadmap, issue 821](https://github.com/anomalyco/opentui/issues/821)
- [First-party issue API used to check the exact text](https://api.github.com/repos/anomalyco/opentui/issues/821)

### Orca depends on the terminal's accessibility integration

GNOME describes Orca as a screen reader with speech and refreshable-braille
output. Its documentation states that it works with applications and toolkits
that support AT-SPI. Testing terminal output bytes alone therefore cannot
establish that Orca receives the required information.

Source: [GNOME: Welcome to Orca](https://help.gnome.org/orca/introduction.html).

A local executable check found Ghostty, foot, tmux, and the `script` tool on
PATH. It did not find `orca`, `gnome-terminal`, or `kgx`. This is a PATH check,
not a full package inventory. No software was installed or desktop settings
changed for this research.

### The repository already has a production-executable test seam

`test/executable-pty.ts` starts the shipped executable in an isolated
pseudo-terminal and captures its terminal protocol output. This can supplement
rendered-frame tests with real startup and key-sequence tests. Its current helper
can return null when PTY support is unavailable, so a required acceptance job must
not treat a skipped PTY test as proof of support.

Source: [Production PTY test helper](../../test/executable-pty.ts).

## Open acceptance work

- Run the agreed Linux terminal and GNOME Terminal/Orca checks in the
  [shared control standard](../shared-controls.md). These are acceptance targets,
  not verified support claims.
- Test labels, values, focus and caret location, selection, validation errors,
  modal entry and exit, and changing progress messages with a real screen reader.
- Test ordinary terminal key sequences as well as enhanced keyboard protocols.
- Test Unicode editing, bracketed paste, resize, and preservation of drafts and
  editing state through Help and modal transitions.
- Record exact tested versions and failures. A frame snapshot or keyboard-only
  test is not a substitute for a screen-reader test.
- If the renderer prevents the agreed access, return to the design decision
  before accepting the baseline. Do not silently remove the requirement.
