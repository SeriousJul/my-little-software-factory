# ADR 0162: A herdr-core start that stands in a worktree writes its own space label

Status: accepted
Date: 2026-11-15
Amends ADR 0148's Adoption label rule: a start that stands in a git worktree
the plane built writes the space label `herdr.space` as its own terminal name,
and reads no label from the plane's own terminal.

## Context

[ADR 0148](./0148-on-the-herdr-core-host-the-plane-adopts-its-start-into-the-space-not-the-tab.md)
decided that the plane copies the space label `herdr.space` from its own
terminal onto every terminal a herdr-core start takes, so a start from a
desktop terminal stands as its own tab in the plane's space in the Herdr
desktop.

The measurement of 2026-11-15 on this machine found what that placement hides.
The desktop's sidebar shows each space's **worktrees**: a space whose first
terminal stands in a linked git worktree is drawn under the space whose first
terminal stands in the main checkout, one row per worktree, named after the
worktree's folder and showing its branch and its distance from the checkout.
The machine state that day: the plane's own terminal stood in the main
checkout under the desktop's space label, a Ticket handoff the plane had
started stood in the git worktree the plane built for it, and a Consultation
stood in the main checkout. Both started terminals carried the plane's space
label and so stood as tabs inside the plane's space. No space stood in the
handoff's worktree: that space's first terminal was the plane's own, in the
main checkout. The handoff's worktree therefore never appeared in the
desktop's worktree view, although the terminal ran in it.

The desktop's source settles the remedy. The app on this machine is `herdr-app`
0.1.15. Its `reconcile` adopts every live terminal that carries a non-empty
`herdr.space` label and is not already shown, and when the label names a space
the app does not know, its `adopt` **creates the space**: the space takes the
terminal's live folder as its folder, and the terminal stands as the space's
only terminal. The sidebar then shows the space, named after the worktree's
folder, and its worktree row under the main checkout's space row. A terminal
the operator or the plane removes makes the desktop drop its tab and, with it,
its space.

## Decision

**A herdr-core start that stands in a checkout other than the one it resolved
into - on this host, the git worktree the plane built for it (ADR 0143) -
writes the space label `herdr.space` as its own terminal name, and reads no
label from the plane's own terminal.** The desktop creates the space in the
worktree, and the sidebar's worktree view shows that worktree under the space
of the main checkout, or as the space's own row when the desktop shows no
space in the checkout. The terminal name is the space id the plane writes: a
live terminal's name is unique on the host, the name is deterministic for the
terminal, and a terminal that goes away takes its space with it, so no
label of a dead terminal outlives it.

A start that stands in the checkout it resolved into keeps ADR 0148's rule:
it copies the plane's space label when the plane's terminal carries one, and
no tab label at all. The plane's run labels, the write-once rule, and the
forensics-only roster scoping stand unchanged.

## Consequences

- A Ticket handoff on the herdr-core host shows in the desktop's sidebar as a
  worktree row under its checkout's space: the operator sees the worktree the
  Agent runs in, not only a tab in the plane's space. Consultations and other
  starts in the checkout keep standing as tabs in the plane's space, as
  ADR 0148 decided.
- The plane reads its own terminal's record at the start only for a start in
  the checkout: a start in a worktree issues no `hc get` for the plane's
  terminal.
- The desktop's side of the new rule - the space created in the worktree, its
  row under the checkout's space, and the space going away with its terminal -
  is an operator read. The verification record stands it as a walk to run
  after this change, and a desktop that changes its adoption rule is a
  measured break, the way ADR 0141 stated it.
- A start in a worktree on the herdr host is untouched: the adoption labels
  are the herdr-core dialect's, and the herdr host's placements stay the
  desktop's and herdr's own.
