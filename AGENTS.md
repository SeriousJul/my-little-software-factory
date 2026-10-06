# Control-plane contributor instructions

## Shared controls

- Read [GLOSSARY.md](GLOSSARY.md) for domain terms before changing control behavior.
- Follow [the shared control standard](docs/development/shared-controls.md) and
  [ADR 0014](docs/adr/0014-shared-modules-own-control-behavior.md) for all controls
  owned by the control plane.
- Use and extend the shared control library in
  [src/components/shared](src/components/shared): `fields.ts` for a Text field
  and a Draft field, `choices.ts` for a selector row and a visible action,
  `form.ts` for a form's slots, focus, and control facts, `region.ts` for the
  Decision region's selection, wrap, auto-scroll, visible window, and range
  text, `type-ahead.ts` for a searchable list row, `spinner.ts` for the
  animated spinner face beside its written word, `presentation.ts` for labels, focus markers, state words, and
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
  routes, the Consultation view's list and detail, the Work queue's list and
  item detail, the Agent interaction mode, the Consultation confirmation
  panel, and the Live view's mode. Build missing behavior at the
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
- Record what could not run as incomplete; do not extend a claim past what was
  measured. Run the two loops below, plus the applicable acceptance checks in
  the standard.
- Frame snapshots and keyboard tests do not establish screen-reader support.
  Record tested versions and results. A skipped required check is not a pass.
- Update current-behavior documentation as migrations land. Keep implementation
  rules in the standard and architecture decisions in ADRs, not in the glossary.

## Two loops: the inner loop and the push gate

During development run the small loop, never the full suite:

- `bun run fmt` on the files you touched, or `bun run lint` (0.25 s)
- `bun run typecheck` (2.8 s)
- `bun test <file>` for the file you changed, or `bun run test:changed` when
  several files changed

That loop costs about 5 seconds. `bun run test` does not belong in it.

Exactly one full `bun run test` gates the push, and it runs against the merged
tree: rebase onto `origin/main` first, then run `bun run lint`, `bun run
typecheck`, and `bun run test`. If the branch falls behind again during a rework
round, rebase and run all three again. When the change touches `docs/`,
`GLOSSARY.md`, or an ADR, `bun run docs:build` joins the gate. A new ADR number is
checked against `origin/main` after the rebase.

`scripts/git-hooks/pre-push` runs lint and typecheck, and refuses a push on a
branch behind `origin/main`. It is active only where
`git config core.hooksPath scripts/git-hooks` has been set; the setup line is in
[the commands page](docs/development/commands.md). Do not bypass it with
`--no-verify`: CI runs the same checks.

See [the quality gate](docs/development/quality-gate.md) for the probe rules,
the reporting rules, and the measured costs, and
[ADR 0105](docs/adr/0105-the-push-gate-runs-the-three-checks-on-the-merged-tree-and-a-hook-owns-the-two-cheap-ones.md)
for the decision.

## Remote gates

Never check a remote gate by hand. Do not run `gh run list`, `gh run watch`, or
`gh pr checks`, and do not open the Actions pages to see whether CI passed. CI
runs the same checks this file names, on the tree that merges, and a push either
lands or it does not. A remote run is not feedback the work waits on: reading it
spends a turn to learn what the push already said.

Two exceptions:

- the user asks for the remote state;
- the work is a CI flakiness investigation, where the remote's runs are the
  evidence, and the record names every run read.

A suspected load flake is settled at the unit layer, not on the remote: run the
file alone, run the base commit in the same worktree, and record both. See
[the test failure triage](#test-failure-triage).

## Testing limits

- A frame test states the arithmetic that fixes the terminal width it picks.
- One copy of a describe block per test file: a split leaves a duplicated suite
  behind once, and it doubles the run.
- A wording that has its own test is not restated literally in a table of
  records. Read it from the helper, so a wording change moves one place.
- Do NOT control the desktop environment to test the app. Never run
  `hyprctl` (or any other window manager or desktop tool) from a test,
  a script, or by hand while verifying a change.
- Test the app at the unit test layer, and only at that layer. Run tests
  with `bun run test` and the shared test harness. Use fake external operations
  and isolated test state.

## Test failure triage

When `bun run test` goes red, gather the evidence with these rules and record
it in the report, beside the existing honesty rule: a skipped required check
is not a pass, and a recorded load flake is evidence, not a dodge.

- A file that fails in the full suite but passes alone is a load flake, not a
  regression. The report names the file and records it as such, so a reviewer
  can weigh the evidence without re-running anything.
- To prove a failure pre-exists, check out the base commit inside the same
  worktree, run only the failing files, and restore your work. No new
  worktree, no repository copy, no clone: the modules, state, and git refs
  you already have do the work.
- `/tmp` is for scratch scripts only. Probe files land there; a repository
  copy, worktree, or clone never does.
- Iterate with targeted file runs (`bun test <file>`) or the scoped suite
  (`bun run test:changed`). Exactly one full `bun run test` gates the push, on
  the merged tree; do not pay the full-suite price on every intermediate state.
- Before the full run, check once whether another `bun test` process is
  running on this machine, and record the machine state in the report. No
  sleep or `pgrep` poll loops.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `SeriousJul/my-little-software-factory`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
