# ADR 0058: The grouping axis is factory state and the folds are not

Status: accepted
Date: 2026-09-24

## Context

The Ticket section's list can be split into Groups by one fact at a
time: the Repository, the Ticket source, the Task type, the Ticket
state, or the Workflow position. Two operator choices came with it:
which axis is on, and which Groups stand collapsed.

The axis is a preference the operator picks once per setup and wants
kept: an operator who reads the list by repository should not press the
key again on every launch. A fold is different. A fold hides rows, and
a hidden group can hide an `awaiting` ticket whose decision is owed.
ADR 0036 named the view facts that stay session-only: section collapse,
selection, the history filter, and the launcher draft. This decision
moves one of those neighbors' peer across the line, and leaves the fold
behind.

## Decision

**The Grouping axis is factory state on the state file**, the way the
Auto-handoff mode (ADR 0036) and the queue pause (ADR 0052) are. A
fresh state file starts with the axis at `none`, the flat list. The key
that changes the axis writes the new value at once, and a restart finds
the grouping where the operator left it.

**The record is keyed by section, not by one section.** The axis value
stands in a table with one row per section, so the Ticket section is the
only row today and a second list that takes grouping needs no new schema
version.

**Collapsed Groups are session facts.** Which Groups stand folded lives
in memory for the run, keyed by the axis and the group value, so an axis
the operator visits twice comes back as they left it. A restart, a dev
reload, and a fresh launch open every Group. The plane never restores a
fold, so no decision can be out of sight because of a choice made in an
earlier run.

**A plane with no state file keeps both in memory.** Where the
projection runs without SQLite state, the axis choice holds for the run
and nothing is written. Grouping degrades to session-only; it never
refuses the key.

## Considered options

- **Both durable: the axis and the folded group keys.** It keeps the
  whole view the operator left, and it can bring a restart back with an
  owed decision behind a fold the operator set days ago. Rejected for
  the same reason the Dispatch pause is a gate and not a surprise: the
  plane must not hide work the operator has not seen.
- **Both durable, with a boot guard that opens any fold holding an
  awaiting ticket.** It answers the failure above, and it makes a fold
  unreliable: the same keystroke opens or keeps a Group shut depending on
  facts the operator did not touch. Rejected because the plane already
  refuses to open a Group by itself mid-run, and a guard that only runs
  at boot is two rules, not one.
- **Both session-only.** The cheapest shape, and it makes the operator
  re-pick the axis every launch, which is the one part of the request
  this decision exists to serve.
- **The axis in the Config file.** The Config file is the operator's and
  the plane writes back only the Repository mapping section. A per-run
  view choice does not belong in a file the operator hand-edits, and the
  factory-state pattern already carries two operator switches.

## Consequences

- The state schema gains a version for the axis table.
- The two facts read differently at boot: the axis is read from the
  state file, and every Group starts open. The Message line names the
  axis on every change, so a durable value never arrives silently.
- Two planes on one state file share one axis, last write wins, exactly
  as they share the queue pause and the Auto-handoff mode.
- The other session view facts (section collapse, selection, the history
  filter, the launcher draft, and now the folds) stay session-only, so
  ADR 0036's list stands with one named exception.
