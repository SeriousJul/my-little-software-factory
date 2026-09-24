# ADR 0059: A Group presents the attention order and never a new sort

Status: accepted
Date: 2026-09-24

## Context

The ticket list already has one order: the attention bands, then newest
external update, then ticket identity (ADR 0050). That order is the
plane's answer to "what needs me now", and the automatic top-up acts on
it too (ADR 0051).

Grouping the list by Repository, Ticket source, Task type, Ticket state,
or Workflow position puts the same rows into runs behind headers. Three
orders compete for those headers: the attention order the list holds, a
name order that reads tidy, and a group-internal order that could sort
each run on its own. And a fold, the point of a Group, can hide work: a
Group of open tickets folded shut can hide the one ticket whose turn
settled and waits for a decision.

## Decision

**A Group is a presentation of the list order, never a new sort.** The
Groups stand by the best attention band among the tickets they hold,
then by the newest external update in the Group, then by the group
value. Inside a Group the order is exactly the order the flat list
holds, band rules and all. The axis at `none` is the list as it stands
today, row for row.

**A fold hides rows, never facts.** The Section header's counts, the
held count, the Parallel limit, the Pickup, the Top-up, the handoff
gates, and every Decision route read the same facts with a Group open or
shut. A collapsed Group's own header carries its count and its held
count, so the hidden obligation stays named where the fold was made.

**The plane never opens a Group by itself.** A ticket that moves into a
folded Group, or a held turn behind a fold, changes no fold. The operator
folds and unfolds. This is what makes the fold safe to keep at all: it
cannot move under them, and it cannot come back from a restart (ADR
0058).

**A group key is a fact of the ticket, never a face a row wears.** A
Queue wait's `queued` badge groups under `open`, a Starting window's
spinner groups under `handed-off`, and a held turn groups under
`awaiting`, because the badge is a presentation of a state and a
poll-time marker, not a Ticket state. The Task type axis reads the row's
own rule for the same reason: a ticket's task is the recorded Handoff's
task while it is in flight and the Suggested task type while it is
`open`, and each of those is a fact at that position of the ticket. The
rule holds everywhere, so the Group a row sits in is always explainable
from the row itself.

## Considered options

- **Groups alphabetical by value.** It reads tidier and it costs the
  ordering its meaning: an `awaiting` ticket's Group could sit below a
  quiet Repository's, and the operator would have to unfold to find their
  own decisions.
- **A group-internal sort that overrides attention.** It buries decisions
  inside a Group, which is the one failure this plane should not build.
- **Automatic unfold on new attention.** It makes a fold unpredictable
  and steals rows the operator is looking at, and a fold the plane can
  lift is not a control the operator can rely on.

## Consequences

- Grouping by Ticket state draws four contiguous runs the list already
  holds, so that axis makes the attention bands visible rather than
  reordering anything. Grouping by Repository, source, task, or position
  pulls rows together from across bands, which the header order keeps
  honest.
- A short terminal can show nothing but Group headers, because each
  header costs a window row. That is accepted: the headers carry the
  counts, and one key press returns the flat list.
- The word "group" now names the visible run, so the invisible rank in
  the list order is the **attention band** in the glossary. ADR 0050 and
  ADR 0022 keep the wording they were written with.
- The Work queue's order and the queue's own keys are untouched: the
  queue is the order of work, and a Group is the order of attention
  (ADR 0049, ADR 0050).
