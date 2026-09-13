# Control-plane contributor instructions

## Shared controls

- Read [CONTEXT.md](CONTEXT.md) for domain terms before changing control behavior.
- Follow [the shared control standard](docs/shared-controls.md) and
  [ADR 0014](docs/adr/0014-shared-modules-own-control-behavior.md) for all controls
  owned by the control plane.
- Use and extend the shared control library in
  [src/components/shared](src/components/shared): `fields.ts` for a Text field
  and a Draft field, `choices.ts` for a selector row and a visible action,
  `form.ts` for a form's slots, focus, and control facts, `type-ahead.ts` for a
  searchable list row, and `presentation.ts` for labels, focus markers, state
  words, and the tested color pairs. Do not add a separate screen-specific field,
  focus implementation, or key system, and do not name a renderer field
  (`InputRenderable`, `TextareaRenderable`) outside the library: an automated
  check rejects all three. Keep domain validation, draft storage, setting
  resolution, and Agent operations in the screen that owns them.
- Run `npm run gallery` to see a control, and add the state a reviewer must see
  to the gallery's examples rather than to a private sketch; the gallery's
  examples are exercised by the suite, so a preview cannot drift from a control.
- Every control the control plane owns dispatches from the shared Control
  catalogue: the fields, selectors, searches, form actions, and form focus
  routes, and the Consultation view's list and detail, the Agent interaction
  mode, and the Consultation confirmation panel. Build missing behavior at the
  shared module interface, never as another local implementation, and read the
  open items and the unverified acceptance targets in
  [the verification record](docs/verification/shared-controls.md): the
  screen-reader path is not verified, and the base panes no shared module owns
  still paint the fixed dark color system, so the light presentation stays an
  explicit `FACTORY_PRESENTATION=light` pin until those panes follow it.
- Start bug fixes with a reproduction through the real application flow. Use
  isolated test state and fake external operations, not live Agent work.
- Check `npm run lint`, `npm run typecheck`, and `npm test` for implementation
  changes, plus the applicable acceptance checks in the standard. Record what
  could not run as incomplete; do not extend a claim past what was measured.
- Frame snapshots and keyboard tests do not establish screen-reader support.
  Record tested versions and results. A skipped required check is not a pass.
- Update current-behavior documentation as migrations land. Keep implementation
  rules in the standard and architecture decisions in ADRs, not in the glossary.
