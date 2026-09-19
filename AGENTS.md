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
  searchable list row, `spinner.ts` for the animated spinner face beside its
  written word, `presentation.ts` for labels, focus markers, state words, and
  the tested color pairs, and `theme.ts` for the pure Theme resolution. Colors leave the plane through the shared paint layer
  ([src/components/theme.ts](src/components/theme.ts)): a surface asks it for a
  role's color, it answers from the Theme the environment resolved (ADR 0024),
  and no surface holds its own palette. Do not add a separate screen-specific
  field, focus implementation, key system, or color table, and do not name a
  renderer field
  (`InputRenderable`, `TextareaRenderable`) outside the library: an automated
  check rejects each of them. Keep domain validation, draft storage, setting
  resolution, and Agent operations in the screen that owns them.
- Run `bun run gallery` to see a control, and add the state a reviewer must see
  to the gallery's examples rather than to a private sketch; the gallery's
  examples are exercised by the suite, so a preview cannot drift from a control.
- Every control the control plane owns dispatches from the shared Control
  catalogue: the fields, selectors, searches, form actions, and form focus
  routes, and the Consultation view's list and detail, the Agent interaction
  mode, and the Consultation confirmation panel. Build missing behavior at the
  shared module interface, never as another local implementation, and read the
  open items and the unverified acceptance targets in
  [the verification record](docs/verification/shared-controls.md): the
  screen-reader path is not verified, and the terminal walks have not been
  re-run on the theme-inherited paint. Every surface, the base panes included,
  paints the Theme the environment resolves (ADR 0024): inherited from herdr's
  config inside herdr, the standalone theme outside, and the `NO_COLOR`
  presentation over any theme. Inherited theme pairs are not contrast-checked; the
  plane's own themes keep the tested pairs.
- Start bug fixes with a reproduction through the real application flow. Use
  isolated test state and fake external operations, not live Agent work.
- Check `bun run lint`, `bun run typecheck`, and `bun test` for implementation
  changes, plus the applicable acceptance checks in the standard. Record what
  could not run as incomplete; do not extend a claim past what was measured.
- Frame snapshots and keyboard tests do not establish screen-reader support.
  Record tested versions and results. A skipped required check is not a pass.
- Update current-behavior documentation as migrations land. Keep implementation
  rules in the standard and architecture decisions in ADRs, not in the glossary.

## Testing limits

- Do NOT control the desktop environment to test the app. Never run
  `hyprctl` (or any other window manager or desktop tool) from a test,
  a script, or by hand while verifying a change.
- Test the app at the unit test layer, and only at that layer. Run tests
  with `bun test` and the shared test harness. Use fake external operations
  and isolated test state.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `SeriousJul/my-little-software-factory`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.

### Documentation site content

New site pages follow the content conventions in `docs/agents/site-content.md`: kebab-case file names, a required frontmatter title, guide subfolders under the docs root, and a local `npm run docs:build` before pushing. See [ADR 0018](docs/adr/0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md).
