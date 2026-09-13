# ADR 0019: The Main view holds two lists and one detail pane

Status: accepted
Date: 2026-09-14

## Context

ADR 0013 merged the Tickets and Consultation views into one Main surface
with two accordion sections: the expanded section owned both list and
detail panes, the collapsed one shrank to a header row, and `t` and `v`
switched the expansion. That shape keeps the operator inside one section
at a time: to check the Consultation list, the operator switches away
from the ticket list, and the list they were reading leaves the screen.

The operator's real need is to see the pipeline and the Consultation
state at the same time (issue #49): the ticket list and the Consultation
list are two facets of one board, and the detail of whichever item the
cursor holds is the thing they are working on. One item is selected at a
time across both lists, so the two sections never need two detail panes.

## Decision

**Both sections are lists, and both can be expanded at once.** The Main
view's left side stacks the Ticket list over the Consultation list under
their section headers. Both start expanded. Each section is
independently collapsable with `x` or a click on its header: collapsing
shrinks the section to its header row and its rows leave the navigation
flow, and the toggle is reversible. The `t` and `v` view-switch keys are
gone.

**The detail pane is one, and it follows the selection.** The right side
is a single context-dependent pane: it shows the ticket detail while the
cursor holds a ticket, and the Consultation detail while it holds a
Consultation. Collapsing the section that holds the selection keeps the
selection and its detail: the detail pane is a right-side fact about the
cursor, not a child of the section that owns it.

**Navigation is one continuous flow.** Up and down move the cursor
through the visible rows and cross the section boundary when the sections
are adjacent; left and right still move the focus between the list and
the detail. Crossing out of the Ticket list walks the cursor off its last
row the way a page turn leaves the page, so the walk never erases the
scroll offset the operator parked on that ticket.

**The Ticket header carries steady pipeline counts.** It always shows
open, running, and awaiting, computed from the in-memory ticket array on
each render, with the held count appended only when it is non-zero so the
alert stands out against the steady shape. The Consultation header's
attention facts are unchanged, and the two headers now share one visual
pattern.

## Considered alternatives

- Keep ADR 0013's accordion: one section owns both panes, `t` and `v`
  switch. Rejected: the operator's other list is always off-screen, and
  the switch costs the visual continuity of the list they were reading.
- One merged list with two groups and no independent collapse. Rejected:
  the operator cannot free vertical space for the list they are working
  in; the per-section minimum also keeps a small terminal usable for both
  headers at once.
- Keep the section's own detail pane alongside the shared one (two detail
  panes, one per section). Rejected: only one item is selected at a time,
  so a second pane would show a stale copy of a detail the cursor no
  longer holds.

## Consequences

- ADR 0013's decisions that one expanded section owns both list and
  detail, and that `t` and `v` switch sections, are superseded by this
  ADR. Its surviving decisions hold: one Main surface, one Message line,
  one Action bar, one control catalogue, Consultation attention on its
  header.
- The minimum terminal height rises: both headers, two section minimums,
  the Message line, and the Action bar must fit, so 40 columns by 19 rows
  is the shortest terminal the Main frame renders.
- The `x` key moves from closing the Consultation to toggling the section
  under the cursor; the Consultation close takes `z`.
- A section below its minimum rows collapses rather than vanishing, so
  both headers keep their counts on a small terminal.
