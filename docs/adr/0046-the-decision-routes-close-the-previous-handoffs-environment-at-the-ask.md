# ADR 0046: The Decision screen's route closes the previous handoff's environment at the ask

Status: accepted
Date: 2026-09-22

## Context

When a turn settles, the operator decides from the Decision screen, and the
decision named **Handoff** asks for the next turn. The handoff the ask builds
reuses the environment the settled turn ran in: the reuse finds the stored
workspace by its checkout and starts the new agent in a fresh tab of it, and
only after the agent starts does it close the predecessor tab (ADR 0012).
When the seat is held, the ask waits in the Work queue, and the reuse stands
until the start runs.

A reuse is right when the machine advances on its own: an auto-handoff
continues the position, and a Restart re-runs the same choices, and both
take the stored workspace for the reason ADR 0012 states. The decision the
operator makes is a different act. The operator looks at the finished turn
and asks for the handoff, and the environment of the settled turn is what
the decision ends. Until the start runs, that environment stands: the
settled agent sits in its tab, and the worktree workspace of a worktree
cycle holds the checkout the operator no longer works in. The ask and the
end of the environment are two facts the operator expects to be one.

The close the Decision screen already offers, the Close route, ends the
environment on the record: the worktree cycle is removed with its branch,
the live-worktree tab closes beside its shared workspace. The route asks
for something else: the work keeps, and the environment goes. The route's
own worktree needs the checkout and the branch it found, so the close the
route asks for must be the close that leaves them: the worktree environment
loses its herdr workspace, the checkout and the branch stay on disk, and
the live-worktree environment loses its tab beside the shared workspace that
stands.

## Decision

**The route's ask ends the environment, and the handoff builds its own.**
The handoff the decision screen asks for - the manual workflow start -
closes the settled ticket's previous handoff environment before the
handoff builds its own, whatever path the start takes. A start that takes
its seat now closes the environment first, inside its run, before it lists
the workspaces, so the list no longer holds the stored workspace and the
handoff takes the build path: the worktree cycle reopens its branch in a
fresh workspace, and the live-worktree cycle starts its agent in the
checkout's shared workspace. A start that waits in the Work queue closes
the environment at the ask, on the seat, the moment the seat is free: the
close belongs to the selection, and the item's pickup closes it again when
the start runs, and the close is its own answer when herdr holds the
environment no more.

**The close is non-destructive, and the Close route keeps the destruction.**
The close the route asks for takes the herdr view of the environment and
nothing on disk: the worktree environment answers to a workspace close, the
checkout and the branch stay, and the worktree handoff's own branch
recovery reopens the worktree on its branch; the live-worktree environment
answers to a tab close, and the shared workspace and its other tabs stand.
The Close cleanup keeps the destruction it already owns, the `worktree
remove` and the branch removal, and the Close route of the Decision screen
keeps its own close, the record's end. The route's close and the record's
close are different acts on the same environment, and only the record's
close takes the work down.

**The branch recovery meets the worktree the close left.** The close takes
the workspace and leaves the checkout, and the agent that last worked the
ticket may have left the worktree on the branch the work needed, not the
branch the plane derives: the work of a pull request lands on the branch
the agent chose, and no worktree holds the branch the handoff asks for
while the worktree still stands at the path herdr names for the branch.
The recovery meets that worktree between the branch lookup and the fresh
create: it lists the repository's worktrees, takes the worktree that stands
at the path the branch names, and reopens it by its path, on the branch it
holds, so the next turn starts on the working state the agent left. A
worktree the list does not hold, that git prunes, or a list that does not
read answers the case no more, and the fresh create runs, the way the reuse
did before the close asked.

**The close rides the seat, and a refusal is a line, not a failure.** The
close is an environment change, and every environment change takes the seat
(ADR 0012), so the close of a running start holds the seat inside the run,
and the close of a queued start waits behind the work it rides on, the way
a Close cleanup does. When the close fails to run, a refusal herdr makes,
or the herdr it reaches holds the environment no more and the close says
nothing, the handoff still runs: the stored workspace the close could not
take down is the one the run reuses, the way it always did, the predecessor
tab the run closes after the agent starts is the residue the close left,
and the refusal stands once on the Message line. An environment herdr no
longer holds is already gone, and that answers the close, the way the Close
cleanup reads `workspace_not_found` and `tab_not_found`.

**The automatic route and the restart keep the reuse.** The close is the
ask's act. The auto-handoff that follows a settled turn, the machine's own
advance, and the Restart that re-runs the choices are not asks: they take
the stored workspace and reuse it, and the predecessor tab closes after the
agent starts, the way the reuse always did. The distinction is the one the
machine already carries: the manual workflow start, the one with no
automatic flag and no restart origin.

The alternatives:

- **Close the predecessor tab earlier, and keep the workspace reuse.**
  Rejected: the operator's ask names the environment, and the worktree
  workspace stands either way, holding the checkout of the turn the
  decision ended. The tab is a detail of the live-worktree environment;
  the workspace is what the ask reaches.
- **Destroy the worktree at the ask, the way the Close route does.**
  Rejected: the route's own handoff needs the checkout and the branch the
  destruction takes, and the work the settled turn left is the work the
  next turn starts on. The ask ends the view of the environment, not the
  environment's work.
- **Defer the queued start's close to the pickup, on the run.** Rejected:
  the seat can stay held for a long while, and the environment of the
  ended turn stands for its whole life in the queue. The ask is when the
  environment ends, and the seat is free at the ask or it is not, and the
  close waits on it like the work it rides on.

## Consequences

- The operator's ask and the end of the environment are one fact. After
  the route's ask, the settled turn's environment is gone, or its refusal
  is on the line, direct or queued alike, and the handoff that follows
  builds its own environment beside the work it found.
- The route's handoff of a worktree cycle now starts on the build path:
  the close takes the stored workspace, the list no longer holds it, and
  the branch recovery reopens the worktree on its branch in a fresh
  workspace. A route that could reuse the stored workspace now reopens
  instead, and the fresh workspace is the worktree the work stands in.
- The reuse path keeps its meaning for the machine's own starts: an
  auto-handoff and a Restart still take the stored workspace, and the
  predecessor tab closes after the agent starts.
- The Close cleanup's reach is unchanged: it still removes the worktree
  cycle and its branch, and the Close route of the Decision screen still
  ends the record with its own close. A route that closes the environment
  and a later Close that removes the work are two acts the record can
  stand between.
- A refusal of the route's close is a line, and the handoff runs on the
  reuse, the way it ran before the close asked. The environment the close
  could not take down is the fact the line names, and the leftover the
  record can carry, the way ADR 0012 carries every other leftover.
- The worktree handoff's branch recovery gains the case the close made:
  a branch no worktree holds, whose worktree still stands on disk on
  another branch, reopens that worktree by its path on the branch it holds,
  and the fresh create never runs on a directory a create would collide
  with. The create still runs when the worktree is gone from disk, is
  prunable, or the list does not read, and the agent starts on the branch
  the work stands in, the work the settled turn left.
