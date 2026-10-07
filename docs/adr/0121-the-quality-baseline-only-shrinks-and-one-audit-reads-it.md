# ADR 0121: The Quality baseline only shrinks, and one Quality audit reads it

Status: accepted
Date: 2026-10-07

## Context

ADR 0120 turns rules on over a tree that does not pass them. Measured on head `b4c305e6` with
the settings that ADR 0120 adopts: 133 cognitive complexity findings in `src scripts bin` and
35 in `test`, 86 function-length findings in `src scripts bin`, 30 parameter findings in
`src scripts bin` and 19 in `test`, and 11 duplication clones of 192 lines in `src scripts
bin`. That is 303 complexity findings and 11 clones standing the day the rules arrive.

Three ways to land that. Pick thresholds the tree already passes, and the ceiling is the worst
function in `src`, a cognitive score of 244, which states nothing. Turn the rules into
warnings, and an unattended agent ignores them, which is the failure mode the quality gate
page already names for a level no fake can tell apart. Or record the count and refuse to let
it grow.

The repository already owns the third shape: `test/domain-export-architecture.test.ts` holds
a baseline "that can only shrink and that stands empty since issue #301 answered its 14
names".

The agent side is the other half. An agent working this repository today runs `bun run lint`,
`bun run typecheck`, and a scoped test run, and reads three outputs. Issue #340 asks for one
command and one token-cheap payload an agent reads after its edits.

## Decision

**One command: `bun run audit`, the Quality audit, in `scripts/quality-audit.ts`.** It runs
the type check, Biome, jscpd, and the code-scanning read, and prints one payload on stdout.
It runs no test suite: the suite is its own loop step and costs seconds the audit does not.

**Every value lives in a dotfile the tool reads, never in the script.** `biome.json` holds the
Biome rules and thresholds, `.jscpd.json` holds jscpd's scope and thresholds, `.quality.json`
holds the audit's own values (the metric list, the scopes, the finding cap, and the changed
base), and `.quality-baseline.json` holds the counts. The script parses and reports; it owns
no number.

**The baseline holds one count per metric, and it only shrinks.** A count above the baseline
fails the audit. A count below it is rewritten down in the same change, so the ratchet holds
in both directions. The counts at head `b4c305e6` are 168 cognitive complexity, 86 function
length, 49 parameter count, and 11 duplication clones, and issue #350 is the campaign that
lowers them.

**The payload is a line form, not JSON.** A status line, then one count per metric, then the
findings as `path:line rule message`. Counts always print; findings cap at 20 per metric with
one `and N more` line, because 303 findings in a turn is noise. The ticket's JSON shape is
replaced: the consumer is an agent reading a turn, and JSON keys cost tokens that carry no
information.

**Nothing is written inside the worktree.** jscpd's JSON reporter needs an output path, so the
audit writes it to a temp directory outside the repository, reads it, and removes it. No
`reports/` directory, no `.gitignore` write, and no report file goes stale beside the code it
described.

**`--changed` narrows the findings, not the counts.** It lists only findings in files that
differ from the changed base, which `.quality.json` states as `origin/main` and
`QUALITY_CHANGED_BASE` overrides, mirroring `TEST_CHANGED_BASE` in the scoped test run. The
counts stay whole, so the ratchet never reads a partial tree.

**A non-zero exit means the tree is worse than its baseline:** a type error, a lint error, a
duplication clone, or a count above the baseline. The security read never fails the audit on
its own; it reports, and a failed read prints its reason.

**The gate placement.** CI gains one step after `bun run typecheck`. The pre-push hook stays
the cheap half ADR 0105 settled: lint, typecheck, and the behind-ref refusal. The push gate
gains the audit as a fourth check, and `AGENTS.md` names it as the inner-loop command an agent
runs after its edits, in place of the three commands it would otherwise run.

## Considered options

- **Thresholds the tree already passes.** Rejected: the ceiling would be a cognitive score of
  244, and a rule set tuned to what the tree does today guards nothing.
- **Warnings, advisory only.** Rejected: an unattended agent that can ignore a finding will,
  and the quality gate page already treats an unread level as drift.
- **A per-entry baseline of `file:rule` with a reason each, the domain-export shape.**
  Rejected at 303 entries: the list is unreadable, and the count is the fact a reviewer acts
  on. Issue #350 carries the entries.
- **The ticket's JSON payload.** Rejected for the line form, for token cost alone.
- **Report files under `reports/`, as the guide shows.** Rejected: they go stale between runs,
  they dirty the worktree an agent is working in, and they need a `.gitignore` write.
- **Thresholds as flags the script passes.** Rejected: a dotfile the tool reads is legible to
  a human and to every other caller, and a script with flags is neither.

## Consequences

- The rules land green: the tree passes on day one because the baseline records where it
  stands, and every campaign after that moves a number down.
- A Biome or jscpd bump that finds new problems shows up as a count that fails the audit, so
  the dependency PR carries the cleanup or the baseline note.
- The audit's cost is documented at a head, the way every number in this repository is: Biome
  0.23 s, `tsc` 0.44 s on TypeScript 7.0.2, jscpd 0.84 s, plus one `gh api` call. The quality
  gate page's 2.7 s typecheck cost stands at an older head and is re-measured when the audit
  lands.
- A new metric means a row in `.quality.json`, a count in `.quality-baseline.json`, and a
  test that reads both back.
- The ratchet is a machine rule, so the backlog issue is a campaign plan and not a permission
  to leave the counts where they are.
