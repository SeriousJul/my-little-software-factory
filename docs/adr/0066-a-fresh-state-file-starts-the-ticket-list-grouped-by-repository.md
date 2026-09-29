# ADR 0066: A fresh state file starts the Ticket list grouped by repository

Status: accepted
Date: 2026-09-29

## Context

ADR 0058 made the grouping axis factory state on the state file, per
section, and chose the flat list - the axis at `none` - as the axis a
fresh state file starts with. That choice was natural when the flat list
was the only list the plane drew: the default was the list itself.

The flat list is still one press of Tab away from any split, but it shows
no structure at all, and the operator works the list by its Groups. The
repository split is the first rung of the cycle after the flat list and
the fact every ticket carries, so a newly configured plane should come up
showing the work the way the operator reads it, not the way the plane
used to draw it.

## Decision

**A fresh state file seeds the Ticket section's axis at `repository`.**
The state migration that adds the axis table (the v20 to v21 migration)
writes `('tickets', 'repository')` for a file that does not yet hold the
table, so a newly configured app opens with the Ticket list split by
repository, the headers on screen and the Action bar naming the axis
before any press.

**A stored axis always wins.** A state file that already holds a row for
the Ticket section keeps whatever axis the operator left there, including
the `none` the earlier migration seeded. The migration writes a row only
where the table is new; it never rewrites a stored axis, and a restart
finds the split where the operator left it (ADR 0058).

**The no-row fallback keeps the flat list.** `DEFAULT_GROUPING_AXIS` is
what a plane reads when the state file names no row for the section or
names a value the plane does not. It stays `none`: the production plane
always runs on a state file, so the fallback serves only the in-memory
plane and a hand-edited file, and those keep the list the plane drew
before the split existed (ADR 0058).

## Considered options

- **Keep the flat list the fresh default.** It is the list the plane
  used to draw, but it shows no structure, and an operator who wants the
  structure presses Tab once at every fresh boot.
- **Turn the no-row fallback to `repository` as well.** One constant, two
  answers avoided, but the in-memory plane - the one the frame tests and
  the preview boot - would re-sort with it, and no operator sees the
  fallback in a freshly configured app, because that app has a file.
- **Default to another axis.** Source, task, state, and position each
  hide part of the list's facts for a fact only some tickets carry;
  repository is the fact every ticket carries and the first rung of the
  cycle, so it is the split the operator reaches first anyway.

## Consequences

- A newly configured app opens with the Ticket list split by repository,
  the headers on screen and the Action bar naming the axis before any
  press.
- An existing state file is untouched by the change: the stored axis
  wins, and a file seeded at `none` by the earlier migration stays flat
  until the operator presses Tab.
- A file that predates the axis table migrates to `repository` now
  instead of `none`, because the table it receives is the new table.
- The cycle is unchanged: `none` is one press of Tab away from
  `repository`, and the bar's rule is unchanged - the flat list states
  no axis, and a split names it.
- The in-memory plane and a file with a missing or invalid row keep
  reading the flat list (ADR 0058), and a plane with no state file keeps
  its axis in memory for the run, the way it always did.
