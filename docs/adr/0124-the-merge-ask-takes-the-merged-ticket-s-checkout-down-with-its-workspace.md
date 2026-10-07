# ADR 0124: The merge ask takes the merged Ticket's checkout down with its workspace

Status: accepted
Date: 2026-10-07
Amends ADR 0099's merge ask: the close it sends at the ask is the Close cleanup
reach, not the Route close reach ADR 0046 defines. It changes no other ask's
close, and it does not change ADR 0046's rule that a route keeps the checkout its
next turn reads.

## Context

The merge of pull request #326 landed, and its workspace closed, and the
checkout stayed on disk.

The development install's record carries the merge and its close in one second:

```text
17:19:29.891 merge queued: "Pseudo-terminal waits miss their deadline under load in the executable-fields rig" (origin workflow, automatic)
17:19:30.061 merge started: ... (mode pickup, origin workflow, automatic, seats 0/2)
```

The record carries no `handoff environment did not close` line anywhere in its
last 3,000 lines, so the close the merge ask sent ran and herdr answered it. The
workspace is gone. The checkout is not:

```text
/home/seriousjul/.herdr/worktrees/my-little-software-factory/factory-326-pseudo-terminal-waits-miss-their-deadline-under-load-in-the-executable-fields-rig
```

The machine holds 33 standing herdr worktrees on branches whose pull request
already merged. Of the 18 pull requests merged since ADR 0099 landed on
2026-10-06, 9 still have their checkout on disk. Nothing reclaims them: the
Close cleanup reach runs when the operator presses its key, and the merge ask
never reaches it.

The cause is the reach, not the command. ADR 0099 says the merge ask closes the
settled turn's environment "through the same reach the Handoff close uses", and
the implementation took that as the Route close reach ADR 0046 defines: herdr
`workspace close <id>`, which takes the workspace down and keeps the checkout and
the branch, because a route's next turn reads that checkout. For a route that
fact is right. For a merge it is wrong twice over. The merged Ticket retires: its
work cycle ends at the merge, its pull request leaves the projection, and no
later turn of that Ticket reads the checkout. And the merge Plane action starts
no Agent and opens no workspace of its own, so the ask has no other act on the
environment - the close is its whole act, and it is the one place the checkout
can go.

## Decision

**The merge ask's close is the Close cleanup reach.** The dispatch module closes
the settled turn's environment with herdr `worktree remove --workspace <id>`,
the one command the Close cleanup reach already sends for a Consultation row: it
takes the checkout and the workspace behind it, and it leaves the branch.

**The reach is a parameter of the one close, not a second close.** The dispatch
module holds one `closePreviousHandoffEnvironment`, and the ask names which
reach it wants: `route` for every handoff route, which keeps ADR 0046's command,
and `cleanup` for the merge ask. The environment kind still
decides the command inside the reach: a worktree environment goes through
`worktree remove`, a live-worktree environment closes its own tab and keeps the
operator's source checkout, and a direct-local environment sends nothing.

**The branch stays.** The Close cleanup reach has always kept the branch, and
this decision keeps that. The merged branch is the record of what landed, GitHub
holds the merge commit, and a stale local branch costs nothing a stale checkout
does not.

## Considered options

- **Keep the Route close for the merge ask, and reclaim the checkouts on boot.**
  Rejected: it adds a second sweeper over a fact the plane already knows at the
  moment it retires the Ticket, and it leaves every checkout standing for the
  whole session, which is where the 33 came from.
- **Send both commands at the merge ask: `workspace close`, then `worktree
  remove`.** Rejected: `worktree remove --workspace` already takes the workspace,
  so the first command is dead weight, and two commands make a partial failure
  ambiguous - the record could not say which half the fault is in.
- **Remove the branch with `--branch` as well.** Rejected: the Close cleanup
  reach keeps the branch today, the glossary's Close cleanup entry says so, and
  deleting a branch the operator may still want is a different decision from
  taking down a checkout the plane made.
- **Close the checkout at the merge's settle rather than at the ask.** Rejected:
  ADR 0099 put the close at the ask for both asks precisely so the environment
  does not wait on the run, and a merge that blocks still ends its turn's
  environment at the ask.

## Consequences

The merged Ticket's checkout is gone when its merge ask runs, so the machine
stops accumulating a worktree per merged pull request. The glossary's Route
close entry names the merge ask as the one ask that leaves the Route close
reach.

The close is still one command, still fire-and-forget, and still records
`handoff environment did not close` when the command fails. A close that fails
now leaves a checkout, which is what a failed Route close leaves today; the
record line is the same, and the operator's Close cleanup key is the retry.

A merge that blocks keeps its outcome: it blocks with the source's reason, and
the rework route the blocked outcome derives stands on the pull request's
needs-work fact. The ask still closed the settled turn's environment at the
ask, the way a landing merge does, and the close took down the checkout of the
turn that ended and kept the branch. A later rework of the ticket reopens that
branch in a fresh worktree, the reuse rule the handoff's own gone-worktree
case already answers, because the close left no stored workspace to reuse. The
checkout the merge took down is the checkout of the turn that ended, not the
checkout the rework needs.
