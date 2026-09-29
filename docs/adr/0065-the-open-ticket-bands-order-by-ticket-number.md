# ADR 0065: The open ticket bands order by ticket number

Status: accepted
Date: 2026-09-29

## Context

ADR 0050 made the ticket list sort within its attention band by newest
external update, then ticket identity. The external update time is a source
fact: every refresh re-reads it, and both the source and the plane itself
(its own label writes) can move it. Every refresh therefore re-sorts the
open pile, and rows the operator never touched jump places.

The rank answers a different question in the two regimes of the list. In the
live bands - awaiting, running, and handed-off - "what moved most recently"
is what the operator watches: a turn that just settled, an agent that just
started. In the open pile the rank answers "what changed on the source",
which is not the work queue: a ticket's number is the stable fact of the
pile, and the pile is the queue of work the factory has not started.

## Decision

**The band keeps its first rank, and the second rank follows the band's
regime.** The live bands (awaiting, running, handed-off) keep ADR 0050's
rank: newest external update, then ticket identity. The open bands (open
actionable, open not actionable) order by ticket number ascending: the
lowest-numbered ticket - the one that has waited longest - stands at the
top of the pile. A ticket whose external key names no number (a security
advisory) stands after every numbered ticket in its band, and ties, and the
no-number run, break by ticket identity.

**The one order stays one order.** The flat list, the ignored pile, and the
Group rank all read this same comparator (ADR 0059): the Group's second rank
is the smallest second rank among the rows it holds - its newest external
update in the live regime, its lowest ticket number in the open regime. The
automatic top-up keeps taking its continuation and its next open ticket in
the list's order (ADR 0050, ADR 0051), so the factory now starts its
lowest-numbered eligible open ticket first. Oldest ticket first becomes the
open dispatch policy, and the order the operator sees stays the order the
factory acts in.

## Considered options

- **Keep the update order everywhere and give the display a stable copy.**
  Two orders answering one question, the competition ADR 0050 retired, and
  the top-up would act on an order the operator no longer sees.
- **Order the open bands by number descending.** It reads "what is new", but
  it puts the longest-waiting ticket at the bottom of the pile, and the
  top-up would start the newest ticket first.
- **Order every band by number.** It loses the recency the operator uses in
  the live bands to see what just moved.

## Consequences

- A row in the open pile no longer jumps on a refresh: a number never
  changes, and a new ticket enters at the bottom of the pile as its larger
  number. Rows still move when they cross a band, and that is the band
  design working as intended.
- The auto top-up's open-ticket walk changes its pick when two open tickets
  compete: the lowest-numbered eligible ticket starts first, not the
  most-recently-updated one.
- Group headers of open tickets stand by their lowest ticket number, not
  their newest update, where the two disagree.
- The live bands are untouched: awaiting, running, and handed-off still put
  the most recently moved work first, and the top-up's continuation walk
  keeps the order it had.
- A ticket without a number (a security advisory) stands last in its open
  band, in ticket identity order.
