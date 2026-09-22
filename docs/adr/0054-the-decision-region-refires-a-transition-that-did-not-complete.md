# ADR 0054: The Decision region re-fires a transition that did not complete

Status: accepted
Date: 2026-09-22

## Context

A completed review turn on a Dependabot fix in `SeriousJul/pi-extensions`
(pull request #97, 2026-09-22) settled with a transition that did not
complete: the score read found no verdict, no branch held, and the trace
recorded `the pull request carries no review score`. The machine re-fires
only one kind of recorded non-fire on its own, the skip of a ticket with no
linked pull request, and only at the next refresh (ADR 0042). Every other
non-fire - a missing score, a verdict that held no branch - stands on the
trace until the operator decides the turn. The Decision region showed the
reason as a fact line and offered Close, Goto, and, when a position stood,
the handoff row. It offered no way to ask the machine to look again, so the
operator's only paths out were to close the cycle or to hand the work off
elsewhere while the machine's own judgment stayed unwritten.

The operator's expectation, which this ADR records: a decision row that says
"look again." The fire is idempotent - it converges the labels to the
machine's facts and re-derives every position from the written labels - so
running it again on the source as it stands now is safe, and it is the same
operation the settle ran, not a new one.

ADR 0053 made the score read take the pull request's comments and its
reviews, which removes the specific no-fire this came from. The row stands
for the whole class: any recorded outcome that did not complete the
machine's work.

## Decision

**The Decision region stands a Re-fire row on an outcome that did not
complete.** The row shows when the turn's recorded transition outcome
fired no branch or failed its label write. A complete outcome - a fire with
clean writes - shows no row: the machine's work is done, and the region
keeps its close, goto, and handoff rows. The row is data in the region's
rows, like the handoff row; the shared control catalogue dispatches it with
no new control.

**The confirm reads the source as it stands now and fires the turn's
transition again.** The plane forces a refresh of the pull request sources,
the same seam the settle-time fire uses (ADR 0027), then runs the fire for
the turn's task type through the command runner. The fire writes labels and
re-derives positions exactly as the settle's fire did; a fire that writes
nothing converges to what stands, so the re-fire's side effects are the
machine's own facts.

**The re-fired outcome swaps onto the trace in place of the one the
operator acted on.** The swap is conditional: it applies only while the
ticket's newest completion trace still records the exact outcome the
Decision region showed, so a trace that moved between the read and the
write - a reopened turn that settled again, the skip re-fire (ADR 0042) -
stands as it moved, and the swap declines. The decision the trace carries
stands: the re-fire rewrites the fire's fact, not the decision on the turn.

**The turn stays awaiting with no decision change.** No cycle ends, nothing
hands off, and the ticket's state does not move. The region re-renders on
the new outcome: the fact lines show what the re-fire wrote, the Re-fire
row stands down when the outcome completes, and the handoff row appears
when the re-fire derived a position. The row stands in both surfaces the
region rides, the decision modal on an awaiting ticket and the Live view's
decision sub-mode, because both read the same rows.

**One re-fire runs at a time.** A guard holds the in-flight re-fire by
ticket identity, so a second confirm on the visible row while the fire runs
stands down. The working word rides the Message line under its own owner,
and the landing lands there too: the fire's fact when a branch held, the
reason when none did, and the fact when the fire reached no ticket or the
swap declined.

## Consequences

- The operator no longer parks a turn on a non-fire the source outgrew: the
  row asks the machine to look again, and the machine's answer - fire or
  reason - stands on the trace and the region.
- The fire stays one operation: the settle, the skip re-fire, and the
  manual re-fire all run the same fire, so their writes cannot drift.
- A re-fire that finds no branch held records its reason, the same fact the
  settle's fire would have recorded: the region can show the row again, and
  it does, until the outcome completes or the operator closes the cycle.
