# ADR 0099: The merge ask closes the settled turn's environment, automatic and manual alike

Status: accepted
Date: 2026-10-04
Supersedes part of ADR 0068: the sentence "the confirm closes the environment
the settled turn stored, and the automatic ask keeps it, the way the automatic
route does" no longer stands. Everything else ADR 0068 decides about the plane
action stands, and ADR 0046's close, its reach, and its timing at the ask
stand unchanged.

## Context

ADR 0068 gave the merge ask two different acts on the settled turn's
environment. The operator's confirm closed it at the ask, the way the Decision
screen's handoff ask does (ADR 0046). The auto top-up's ask kept it, "the way
the automatic route does".

That second half borrowed its reason from the wrong act. The automatic route
keeps the stored workspace because the handoff it starts runs in it: the reuse
finds the workspace by its checkout, starts the new Agent in a fresh tab of
it, and closes the predecessor tab after the start (ADR 0012). The keep is not
a preference for leaving herdr environments standing. It is the cost of the
next turn's work.

The merge has no next turn. The run builds no environment of its own, and when
it lands `merged` it retires the pull request and every issue the pull request
closed on the merge (ADR 0068). The ticket leaves the projection in the same
settle that ran the command, so nothing later reads it: no continuation, no
cycle end, no Close cleanup, and no Decision screen. The environment the ask
kept is kept for nobody.

Observed on the shipped machine in Auto-handoff mode: the only workspaces that
survived a full run stood on tickets whose review scored above the configured
`score-threshold = 90`. A score below the threshold lands the ticket on
`needs-work`, whose continuation is a rework handoff; that handoff reuses the
workspace, and the cycle ends later with the Close cleanup that removes the
checkout and its workspace. A score above the threshold lands the ticket on
`ready-to-ship`, whose task type is the merge, and the merge was the one path
that sent no herdr command at all.

The leak is also silent. The plane records a leftover environment only when a
close ran and herdr refused it (ADR 0012). A close that was never asked records
nothing, and the retired ticket's detail - the surface that would state the
fact - is gone with the ticket. The operator sees a workspace in herdr with no
record of it anywhere in the plane.

The alternatives:

- **Close after the merge lands, inside the pickup.** Rejected: it splits the
  ask's act across two places, and it keeps the environment for the one outcome
  that does not need it. A blocked merge's rework handoff reopens the worktree
  in a fresh workspace today, because the confirm already closed it at the ask;
  the automatic ask is the only ask that still had the old rule.
- **Keep the automatic ask's keep, and record a leftover when the merge
  retires the ticket.** Rejected: ADR 0012's leftover is a fact the operator
  acts on, and this would manufacture the very residue it then asks the
  operator to clear. The close is one command the plane already owns.
- **Let the observation's cycle-end cleanup cover the merge route.** Rejected
  on the facts: `handleAwaiting` returns when the settled turn already holds a
  decision, and the `auto-merged` decision lands at the ask (ADR 0072), so no
  walk reaches a cleanup for this route.

## Decision

**The merge ask closes the settled turn's environment at the ask, whichever
hand asks it.** The `automatic` flag no longer decides it. A workflow-origin
merge ask - the Decision screen's confirm and the auto top-up's continuation
alike - queues the close of the settled ticket's newest handoff environment at
the ask, on the seat, the way every environment change rides the seat
(ADR 0046). An open-position merge ask names no settled turn and closes
nothing.

**The close is the same close.** It stays the non-destructive close ADR 0046
defines: a worktree environment loses its herdr workspace, and the checkout and
the branch stay on disk; a live-worktree environment loses its tab beside its
shared workspace. This ADR changes which asks run the close, not what the close
takes down. Removing the merged ticket's checkout directory is a separate
question, and this decision does not reach it.

**The close belongs to the ask, not to the run.** A merge item that later drops
at the pickup - the task type lost its action form, the ticket moved on - still
had its environment closed at the ask, the way a confirm's merge does. A
refused close is a line on the Message line, not a failure, and the merge runs
(ADR 0046).

**A blocked merge loses its reuse.** After a block the ticket lands on
`needs-work`, and its continuation handoff takes the fresh-workspace path
ADR 0046 defines: the branch recovery reopens the worktree on the branch it
holds. That is what the confirm's blocked merge already does, and the automatic
ask now answers the same way.

## Consequences

- No herdr environment survives a merged ticket. The automatic merge sends its
  close the way the confirm's does, and the shipped machine's workspaces all
  end.
- The `automatic` flag decides the gates and the decision word
  (`auto-merged`), never the environment. The one rule for the automatic keep
  is the automatic handoff route and the Restart, which reuse the workspace
  because their next turn runs in it.
- `test/plane-action-merge.test.ts` states both asks close the environment, and
  its automatic test asserts the exact herdr command the closed workspace takes
  (`herdr workspace close <id>`).
- The blocked merge's rework handoff reopens its worktree in a fresh workspace
  in Auto-handoff mode too, the way it did under the operator's confirm.
- The checkout directory a merged ticket leaves on disk is unchanged by this
  decision, and still stands outside herdr's reach and outside the plane's
  surfaces.
