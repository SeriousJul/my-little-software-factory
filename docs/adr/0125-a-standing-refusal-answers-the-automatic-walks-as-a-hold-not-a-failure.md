# ADR 0125: A standing refusal answers the automatic walks as a hold, not a failure

Status: accepted
Date: 2026-10-07
Amends ADR 0104's consequence that the merge run's refusal "reaches the
automatic walks' warning line", and ADR 0049's one-item-per-ticket refusal
beside it. It changes no refusal, no record line, and no operator's ask.
Amended by ADR 0128: the automatic walks read the Work queue's row and the run's
mark before they ask, so a standing row or a standing run earns one ask and one
hold line, not one per cycle. The hold's words, and the refusal's answer to an
ask that crosses either mark, stand.

## Context

The Message line warned about a merge that was landing:

```text
work queue top-up could not merge "Pseudo-terminal waits miss their deadline under load in the executable-fields rig": "Pseudo-terminal waits miss their deadline under load in the executable-fields rig" already has a merge
```

The merge landed. The record says so:

```text
18:33:35.607 merge queued: "Pseudo-terminal waits miss their deadline under load in the executable-fields rig" (origin workflow, automatic)
18:33:35.795 merge started: ... (mode pickup, origin workflow, automatic, seats 0/2)
18:33:40.259 merge refused: ... (already has a merge running; the first run stands)
```

The refusal is correct. ADR 0104 put a run mark on the Plane action's claim
precisely so a second ask cannot run the same `gh pr merge` twice over one pull
request, and this refusal is that mark answering. The fault is what the plane
does with the answer.

The development install's record carries 25 of these refusals across
2026-10-05 to 2026-10-07, every one of them between 0.48 s and 6.11 s after its
own `merge started:` line: the walk re-asks the position while the merge command
is still out, on every poll and every source fetch in that window. The record
carries one further refusal of the same family, the Work queue's
one-item-per-ticket refusal (ADR 0049) for a merge row.

The top-up classifies three refusal shapes: the stopped dispatch, the Handoff
limit, and the Failed-start park. Everything else becomes a `warning` status,
which reaches the Message line and, for a standing warning, the Desktop
notification ADR 0118 allows. So the plane wrote, in one line, that it could not
merge a pull request it was merging at that moment. The line is not a small
cosmetic miss: it is the plane calling its own successful work a failure, on the
one surface the operator reads, and it repeats for every merge the factory makes.

The refusal carries no fact that tells the walks what kind of refusal it is. The
reason string is prose for a human, and the walks match it with
`includes("Handoff limit")` and `includes("handoff recovery")`. A standing
refusal has no word to match, so it falls through to the warning.

## Decision

**A refusal that stands for work the plane already entered says so in its
answer.** The dispatch module's refusal arm carries an optional standing fact:
`queue-row` for the Work queue's one-item-per-ticket refusal, and `merge-run` for
ADR 0104's run mark. The dispatch module owns both facts, so it marks both.

**The automatic walks take a standing refusal as a hold.** The observation cycle
reads the marker before it reads the reason string, and records the hold in the
walks' own voice, once for as long as the fact stands and again when it changes:

```text
automatic walks hold: the Work queue already holds an item for the Ticket ("Persist source facts")
automatic walks hold: the Ticket's merge is already running ("Persist source facts")
```

The first is the fresh-work walk's existing candidate hold, which the queue's
guard already wrote before the ask; the ask's own refusal now reaches the same
word, so the two paths state one fact. The second is new.

**The refusal line stays.** The dispatch module still writes `merge refused:` and
`handoff refused:` at `warn`, in the one shape every refusal line wears (issue
#223), once per standing fact. The record keeps its full account of what the
plane asked and what answered; only the Message line changes.

**The operator's ask still reads the refusal.** The marker is read by the
automatic walks alone. An ask the operator made by key reports its refusal on the
Message line exactly as before, because for that ask nothing else is in flight
and the refusal is the fact the operator asked for.

**A new refusal kind decides whether it stands for entered work.** The marker is
not a general "ignore this" flag: a refusal that means a start could not run -
the Handoff limit, a stale route, a blocked recovery - keeps its current path.
The module that refuses decides, at the refusal, which family it belongs to.

## Considered options

- **Have the walks check the queue and the run mark before they ask.** Rejected:
  it reads a second time the facts the ask already reads, and the window between
  the check and the ask is where the duplicate lives. The ask is the one read of
  the truth; the answer is where the fact belongs.
- **Match the reason string, the way the Handoff limit match works.** Rejected:
  it pins behavior to wording, and the two existing string matches are the reason
  this shape keeps breaking. The marker is typed, and the compiler checks it.
- **Suppress the warning line for these two refusals and state nothing.**
  Rejected: a walk that started nothing must say why (issue #223). Silence reads
  as a walk that broke, which is the failure mode that ADR's whole rule exists to
  prevent.
- **Keep the warning and drop the Desktop notification for it.** Rejected: it
  fixes the loudest symptom and leaves the Message line telling the operator the
  merge failed.
- **Retry the ask until it succeeds, and warn only after a bounded number of
  tries.** Rejected: the ask is not failing, so a retry has nothing to recover
  from, and the retries are what produced the 25 refusals.

## Consequences

The glossary's Work queue top-up entry carries the walks' hold beside the
refusals.

The record gains one hold line per standing fact and loses nothing. The
configuration reference states both lines, and the check that reads every hold
word against the guide (issue #223) covers the new word.

A refusal that neither the walks nor the screen classifies still warns. That is
the right default for an unknown fact; the marker is how a known fact opts out,
and the marker's two values are the only ones the dispatch module writes today.
