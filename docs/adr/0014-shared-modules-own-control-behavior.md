# Shared modules own control behavior

Status: accepted; migration pending.

The control plane has shared modal layout and a Control catalogue, but individual
screens still implement different editing and focus behavior. All controls owned
by the control plane will use one internal library of shared modules that owns
editing, focus, labels, error presentation, and integration with the catalogue
and guides. Screens retain domain validation, draft storage, and Agent actions;
external Agents retain their own controls.

We chose required shared behavior over optional style wrappers or documentation
alone because those alternatives still allow each screen to implement different
keyboard and accessibility rules. A small interface must hide the field's
editing state and renderer details, so fixes apply to every caller rather than
requiring each screen to repair its own caret or key handling.

## Consequences

- Contributors must extend the shared modules instead of adding separate control
  implementations. Automated checks enforce this rule; real examples and tests
  establish the common behavior.
- The library remains inside this repository. This decision does not create a
  published package or replace OpenTUI by itself.
- The [shared control standard](../shared-controls.md) defines editing, numeric
  paste rejection, draft retention, presentation, verification, and migration.
  Its numeric paste rule refines ADR 0009 without changing setting resolution or
  the meaning of a Context window.
- Screen-reader support must be verified early. If OpenTUI prevents the agreed
  access, a renderer change or equivalent accessible interaction mode requires a
  further decision before the baseline can be accepted as implemented.
