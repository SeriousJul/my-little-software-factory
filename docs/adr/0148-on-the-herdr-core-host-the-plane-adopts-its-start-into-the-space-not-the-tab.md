# ADR 0148: On the herdr-core host, the plane adopts its start into the desktop's space, not the plane's tab

Status: accepted
Date: 2026-11-13
Amends ADR 0141's Adoption label rule: the plane copies the space label its
own terminal carries, and no tab label.

## Context

[ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md)
decided that the plane copies the Adoption labels `herdr.space` and
`herdr.tab` from its own herdr-core terminal onto the terminal a start takes,
beside its own run labels, so the Herdr desktop shows a start the plane made
the way it shows a terminal it made itself.

The live walk of 2026-11-13 measured the placement that rule produces (the
machine state and the roster stand in
[the verification record](../verification/agent-host-herdr-core.md)). The
plane ran in a terminal the desktop created, and that terminal carried both
labels. A Consultation the plane started that day carried both labels too, and
the desktop showed it as a **split pane in the plane's own tab** - the
Consultation beside the plane, left and right in one tab - not as a separated
window of its own. The operator expected the start to stand separated, in its
own tab beside the plane's.

The desktop's source settles the mechanism. The window on this machine is
`herdr-app` 0.1.15. Its `reconcile` adopts every live terminal that carries a
`herdr.space` label and is not already shown, and its `adopt` places it: when
the terminal also carries `herdr.tab=<id>` and the app knows a tab by that id,
the app splits the terminal **into that existing tab**, beside the tab's own
panes; when it carries the space label alone, the app **creates a tab in that
space** for the terminal. The desktop's own instructions state the rule:
"`herdr.tab=<id>` chooses its tab; without it, Herdr creates a tab in that
space."

## Decision

**The plane copies the space label `herdr.space` from its own terminal's
record, and no tab label.** With the space label the start's terminal stands,
when the plane stands in the desktop, as its own tab in the plane's space -
separated from the plane's tab. The plane writes no label into the desktop's
tab namespace at all; that label stays the desktop's own, on the terminals the
desktop creates and moves. A run outside a herdr-core terminal writes no
Adoption label, as before. The plane's run labels, the write-once rule, and
the forensics-only roster scoping stand unchanged.

## Consequences

- A start from a desktop terminal shows in the desktop as its own tab in the
  plane's space, not as a pane beside the plane in that tab. Several
  Consultations started from one plane stand as several tabs in that space.
- ADR 0141's statement that the plane "copies the Adoption labels
  `herdr.space` and `herdr.tab`" narrows to the space label. The plane's
  reader of its own terminal's record still takes the record's whole label
  map; only the copy the start writes narrows.
- The desktop's side of the new rule - a space-labeled terminal standing as
  its own tab in the space - is an operator read. The verification record
  stands it as not re-walked until the operator confirms it after this
  change, and a desktop that changes its adoption rule is a measured break,
  the way ADR 0141 stated it.
