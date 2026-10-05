# ADR 0105: The push gate runs the three checks on the merged tree, and a hook owns the two cheap ones

Status: accepted
Date: 2026-10-05
Records the check order an agent runs while it works and the one it runs before
it pushes. It does not change what any check measures: `bun run lint`,
`bun run typecheck`, and `bun run test` are the same commands CI runs
(ADR 0055 leaves mutation testing outside every gate, and the shared control
standard keeps its own acceptance targets).

## Context

The repository already named the checks. `AGENTS.md` said "Check `bun run lint`,
`bun run typecheck`, and `bun run test` for implementation changes", and CI runs
all three on every pull request. What it did not say is when each one runs, and
nothing placed them at the moment of the push.

The review to rework cycles on pull requests #222, #224, #227, #229, #233, and
#300 show what that gap costs.

- The first review of #300 measured `bun run lint` failing on the branch: two
  Biome errors in `test/attempt-record.test.ts`, an import sort and a formatter
  line. `main` at the base commit was clean, so the branch introduced both. The
  check costs 0.25 seconds.
- The second and third reviews of #229 each required "Rebase or merge
  `origin/main` and run `bun run lint`, `bun run typecheck`, and `bun run test`
  against the merged tree." The third stated it had been required the round
  before and the branch had fallen behind again. The suite result an agent
  reports for a tree that is not the tree that merges says nothing about the
  tree that merges.
- #222 wrote an ADR under a number `main` had already taken, and the rework
  renumbered the file and every reference to it.
- #224's second review found the pull request body still stated the test count
  and the assertion count of an earlier head, and #229's first review found the
  body still carried an acceptance criterion ADR 0100 had retired.
- #233's first review found "two probes that no reviewer can re-run", and its
  second review found one of the two did not reproduce as written.

The same reviews also show the opposite cost. The full suite is about 40 seconds
and 2,900 tests. An agent that runs it after every edit pays that price dozens of
times a session, and an agent that will pay it dozens of times looks for a way to
skip it. The cheap checks, measured on this tree, are 0.25 seconds for lint, 2.8
seconds for the typecheck, and 1.7 seconds for one test file.

## Decision

**The work runs in two loops, and each loop has its own checks.**

The inner loop runs while the agent works: `bun run fmt` on the files it touched
(or `bun run lint`), `bun run typecheck`, and `bun test <file>` for the file it
changed, or `bun run test:changed` when several files changed. That loop costs
about 5 seconds. `bun run test` stands outside it.

Exactly one full `bun run test` gates the push, and it runs against the merged
tree: rebase onto `origin/main`, then run `bun run lint`, `bun run typecheck`,
and `bun run test`. A branch that falls behind again during a rework round
rebases and runs all three again. `bun run docs:build` joins the gate when the
change touches `docs/`, `CONTEXT.md`, or an ADR, because CI blocks on that build.
A new ADR number is checked against `origin/main` after the rebase.

**A committed hook owns the two cheap checks and the behind check.**
`scripts/git-hooks/pre-push` runs `bun run lint` and `bun run typecheck`, and
refuses a push whose branch is behind its remote-tracking branch. It is active
only in a checkout that set `core.hooksPath`; the setup line is on the commands
page. The hook reads the local remote-tracking ref and does not fetch.

**The rules the reviews kept restating become one standard page.**
[The quality gate](../development/quality-gate.md) carries the doc-claim rule,
the rename sweep, the documented-line-has-a-test rule, the probe rule, the
determinism rule, the fake-fidelity rule, the file-the-defect rule, the
failure-mode sweep, the measurement-names-its-head rule, the small shape rules,
and the reviewer's floor. `AGENTS.md` carries the two loops and points there.

## Considered options

- **Leave lint and typecheck to the instruction.** Rejected: the instruction has
  stood since the checks were added, and #300 pushed a branch that failed a
  0.25-second check. A gate an agent can forget is not a gate.
- **Have the hook run the full suite too.** Rejected: 40 seconds in a hook is the
  cost that makes people reach for `--no-verify`, and the suite is the one check
  the agent must choose deliberately, against the merged tree, once. CI runs it
  regardless.
- **Have the hook fetch `origin` before the behind check.** Rejected: a network
  call inside every push, on a plane whose own design rule is that a check states
  what it measured. The hook reads the ref the checkout already holds and says so
  in the line it prints.
- **Refuse a push that is behind, and nothing else, and let the checks stay
  prose.** Rejected as half a gate: the behind rule was the repeated required
  change, but the lint failure was the one that reached CI red.
- **Put every rule in `AGENTS.md`.** Rejected: that file is the short read an
  agent loads first, and the probe, doc-claim, and reporting rules need their
  measured context and their worked examples. The standard page carries them, the
  way the shared control standard does.
- **Automate the whole set.** Rejected for most of it. A check can hold a
  documented line to the code that writes it, and a check can hold a module map's
  paths to the tree, and both patterns already exist. A check cannot tell that a
  sentence claims more than the code does, or that a probe was not re-run. Those
  stay rules, and the reviewer's floor is what measures them.

## Consequences

The commands page carries the hook's setup line, so a fresh checkout knows what
it is not running.

The gate is a claim about the automated checks and the tree they ran on. It adds
no claim about the live terminal walk or the screen-reader path, and
[the verification record](../verification/quality-gate.md) keeps those open,
beside the CI load flake on the frame tests, which this decision does not fix.

The review loop gains a written floor. The reviewers of these six pull requests
already re-ran the probes, ran the checks on the merged tree, and scored the head
they measured; writing that floor down keeps the implementer and the reviewer
from measuring different trees.

The reporting rules make a superseded number in a pull request body a rule
break, not a nit, which is what it has been in practice on #224 and #229.
