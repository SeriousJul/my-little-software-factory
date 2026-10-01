# ADR 0079: The fire's successful label write converges the projection at once

Status: accepted
Date: 2026-10-01

## Context

A transition fire that writes the outcome's labels on the source used to
leave the projection's copy of those labels standing. The write landed on
the source, the fire derived the outcome's position from the written
labels in memory, and the projection's membership kept the labels the
source last fetched until the next refresh overwrote them.

For most fires the window was quiet: a review turn that wrote
`ready-to-ship` on its pull request left the position one review behind
for up to a refresh, and the next read settled it. The blocked merge made
the window loud. The block wrote `needs-work` on the pull request, the
position the machine derived from the projection still read
`ready-to-ship` and offered the merge, and every machine that derives an
ask from that position - the Auto-handoff Top-up's walk and the operator
reading the list - read the merge offer until the refresh. The
blocked attempt's hold (ADR 0077) gates the automatic re-ask, but it is
a gate, not a fact: the position itself stood on labels the machine
knew it had just moved.

## Decision

The fire's label write converges the projection the moment the write
succeeds. After the fire runs its writes, the plane updates the
ticket's newest active membership to the labels the write produced, the
way the fire computed the outcome's position from them. The position the
machine derives next stands on the labels the machine wrote, with no
refresh in between: the blocked merge's `needs-work` lands on the
projection at once, and the position offers the rework instead of
re-offering the merge.

The convergence writes the projection only, through the state: the
source's own fetch remains the single writer of the labels on the
source, and the next refresh overwrites the converged set with the
source's truth the way it overwrites every other fact the projection
holds. A failed write converges nothing: the fire that could not write
its labels derives no position from them and leaves the projection as
the source left it, and the hold (ADR 0077) keeps the automatic re-ask
gated while the position still offers the merge the block could not
move. A ticket no source lists answers nothing: there is no membership
row for the write to land on, and the refresh that lists the ticket
carries its labels.

## Considered options

- **Let the refresh do the convergence.** Rejected: the refresh is the
  source's poll, and its interval is a tuning value, not a fact. The
  machine knew at the fire that the labels had moved; standing on the
  old labels until the next poll held the merge offer on a blocked merge
  for a whole refresh and left every position read in that window
  answering from a fact the machine had already superseded.

- **Converge from the command result instead of the fire.** Rejected:
  the command result says the edit ran, not what the labels stand on.
  The fire already computes the written set from the branch's facts over
  the item's labels, and it is the fire that derives the position from
  the same set: one computation, one place.

## Consequences

- The blocked merge's aftermath stands on the projection at once: the
  position offers the rework the moment the block lands, the
  Auto-handoff Top-up asks the rework handoff on the next cycle instead
  of waiting for the refresh, and the list the operator reads wears the
  labels the machine wrote.

- ADR 0077's hold keeps its role as the guard on the write-failure path:
  a block whose label write failed leaves the position offering the
  merge, and the hold gates the automatic re-ask until the source
  re-reads the ticket.

- Every fire that writes labels now touches the projection a second
  time. The write is local, it lands before the fire answers, and the
  refresh that follows overwrites it; a crash between the source write
  and the local convergence leaves the projection the way the old code
  left it, one refresh behind.
