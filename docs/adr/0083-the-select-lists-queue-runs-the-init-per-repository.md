# 0083: The select list's queue runs the init per repository

The operator marks rows in the init's select list with `Tab`, and a
marking of two or more makes Enter run the queue: one repository per
entry, one confirmation panel per entry, in list order.

## Context

ADR 0082 gave the plane the select list: the `o` key opens the list of
the repositories the operator's `gh` identity can init, and Enter hands
the row under the cursor to the init's planning. Bootstrapping a factory
that holds several new repositories then meant re-opening the list and
re-filtering it between each repository, because the plane's act, its
confirmation, and the instruction-file choice are all per-repository:
each init pushes to that repository's branch, names its labels and its
files, and a repository with neither instruction file owes the operator
a different answer.

## Decision

- `Tab` marks the row under the cursor for the queue, and the key
  unmarks it. The mark is the panel's own state: the list keeps no
  draft, so a close discards it, and a marked row wears the word
  `queued` at its end.
- Enter keeps its meaning: it plans and confirms the repository under
  the cursor. A marking of two or more runs the queue instead: the
  marked repositories in list order, the cursor's row among them when
  it is marked. A marking of one, or none, is the plain select the
  panel has always run.
- The queue runs one confirmation panel per entry, in the panel the
  operator already knows. The confirm runs the act and moves on. The
  cancel skips the entry, and the next stands in its place.
- A repository without a local checkout, or whose plan refuses, states
  its reason on the Message line, and the queue moves on.
- A failed act stops the queue. The line the failure leaves already
  names the repository and the failure, and the operator takes the
  rest of the marking back by hand when ready.
- The drained queue leaves its settled line on the Message line: how
  many ran, how many skipped, how many refused.

## Consequences

- The plane does not merge the confirmations into one. A merged panel
  would compress each repository's branch, labels, and file treatments
  into counts the operator cannot check, and it breaks on the
  instruction-file choice, where each repository may owe a different
  answer. The queue keeps every review whole and reuses the panel
  ADR 0082's select already opens.
- The bar's Enter hint states `Start queue` while a marking of two or
  more stands, because the key then starts the queue instead of
  selecting one.
- The queue stands in a ref in the screen that owns the init, not in
  state: no surface renders the waiting entries, and the confirmation
  panel names only the entry under review.
- The `i` on a Group header opens the init for the repository under the
  cursor, and it runs outside the queue: a panel owns the keyboard
  while one stands, so the two paths never interleave.
