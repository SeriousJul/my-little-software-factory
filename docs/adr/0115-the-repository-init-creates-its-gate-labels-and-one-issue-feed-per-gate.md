# ADR 0115: The Repository init creates its gate labels, and one issue feed per gate

Status: accepted
Date: 2026-10-06

Supersedes part of ADR 0075: the init's label set now holds the scoping labels
a state match gates on, and the act registers one issues feed per issue-side
gate. Its generator, its worktree, its fact, and its panel decisions hold.
Refines the coverage rule of issue 195: a source that names a filter covers
only the feed that names the same filter.

## Context

ADR 0075 derived the init's label set from the transitions alone: the union of
every label a transition writes, plus the five canonical triage labels, with
the scoping labels excluded on the ground that a state gate is the operator's
own decision. It also registered one issues feed per repository filtered on
`label:ready-for-agent`, and it skipped a planned feed whenever a configured
source of the same host and kind already listed the repository.

The `analyze` task type (ADR 0085, ADR 0086) made that combination a dead
path. Its position is the `ready-for-spec` state, which gates on a label no
transition writes:

- the act never creates `ready-for-spec`, so the label does not exist in an
  initialized repository, and GitHub refuses a write of a label the repository
  does not hold - the gate cannot be applied at all;
- the act's issues feed reads `label:ready-for-agent` alone, so a ticket that
  does carry the gate is never fetched, and the position stays empty even after
  the operator creates the label by hand;
- the coverage rule then swallows the second feed: the first issues feed the
  plane registered "covers" a repository on host, kind, and repository alone,
  so a further feed for a second gate could never register.

`ready-for-agent` reaches the machine only because it happens to be one of the
canonical triage labels. Every other gate of the shipped machine is
unreachable in a repository the plane initialized.

The feeds cannot be merged into one query. GitHub issue search applies AND, OR,
and NOT to search text only, and a comma inside a `label:` qualifier does not
behave as a union; the plane rejects those shapes at config time and states one
source per query branch (the same rule its built-in policies are built from).
So a machine with two issue-side gates needs two feeds.

## Decision

**The init's label set is what the machine names.** It is the union of every
label a transition writes, every label a state match gates on, and the five
canonical triage labels, with `blocked` excluded. A state's gate labels are its
`labels-any` and its `labels-all`; its `labels-none` labels stay out, because
the state asks for their absence and nothing needs to write them. A gate the
config does not name is still the operator's own to create, exactly as ADR 0075
decided: the act creates what the machine names, and no more. The shipped
`ready-for-spec` gate joins the fixed palette with its own color and
description, so a fresh repository's spec gate reads the same in every
repository.

**The act registers one issues feed per issue-side gate, in state order.** A
gate counts for the issues feed when the state's match names no source kind or
names `github-issue`; a pull request state or a security feed is no issue gate.
The first feed keeps the plain `<repository>-issues` name, and each further
feed appends its label: `<repository>-issues-<label>`. Each carries
`label:<label>`, quoted when the label is not a plain word, so the query stays
one token and passes the config's own filter validation. A machine that gates
no issue at all falls back to the canonical entry label, `ready-for-agent`,
which is today's behavior. The pull request feed keeps no filter.

**Coverage compares the query branch.** A configured source covers a planned
feed when it names the repository on the same host and kind, and either names
no filter at all - it lists its kind's whole open set, so it covers every
branch - or names the planned feed's filter. A filtered operator source reads
one branch, so it no longer swallows a feed for a gate it does not read. The
name and the refresh interval still count for nothing, and the collision
refusal stands unchanged.

**The generator's version goes to 2.** The label set and the feeds are derived
from the settings, but the rule that derives them changed, so the bump stands
every Initialized repository in Init drift at once, which is how the operator
reaches the new labels and feeds: re-run the act.

## Consequences

- The `analyze` position is reachable in a repository the plane initialized:
  the gate label exists after the act, and a feed reads it. The manual label
  pass ADR 0075 retired for transition labels now covers the machine's gates
  too.
- A machine with two issue-side gates gains two issues feeds per repository.
  Each is one source row in the Config file, one refresh, and one health row.
  A ticket two feeds both read stands once in the list: the projection keys
  memberships by source and identity and converges the labels, so an overlap
  costs a fetch, not a duplicate row.
- The coverage skip narrows. A broad, filter-free operator feed still covers
  every planned feed of that kind, which is the shape issue 195 was about, and
  the double fetch stays solved. A filtered operator feed now lets the plane's
  feeds for other gates register.
- A gate the operator writes into their own states is created by the act as
  well. A label the operator deletes by hand comes back on the next re-init:
  the settings name it, so the act writes it.
- A `labels-none` gate is still not created, and a label no state and no
  transition names is still not created. The label page keeps saying those are
  the operator's.
- Every Initialized repository reads Init drift once after this lands. The
  Group header's marker and the one-time Message note are the signal, and the
  act's panel lists the labels it will create and the files it will write
  before anything is written. The feeds the act registers are not on the panel;
  the act's answer counts the sources it registered.
