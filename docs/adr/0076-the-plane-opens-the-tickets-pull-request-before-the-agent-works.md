# ADR 0076: The plane opens the ticket's pull request as a draft before the agent works

Status: accepted
Date: 2026-10-01

## Context

The `implement` task type and the three security task types instruct the
agent to commit, push, open a pull request, and link the ticket. The agent is
the pull request's writer. The link between the work and the ticket then
depends on what the agent wrote: a closing reference in the body, or the
branch prefix the plane already owns through its branch naming. The agent can
open the pull request late, link it wrong, or open none at all, in which case
the transition fire records a skip and waits.

Every other link in the chain is already deterministic and plane-owned. The
plane creates the branch (the worktree on the ticket's factory branch), the
plane writes the labels at settle time through the Transition (ADR 0027: the
agents never write workflow labels), and the plane finds the fixing pull
request structurally, through the closing reference or the branch prefix.
Pull request creation is the one act left to the agent. The plane already
holds the egress the act needs: its Command runner runs `gh` with the sources'
own authentication, the same exit its label writes and its Repository init
take (ADR 0075).

## Decision

**The plane owns the pull request of a task type that opens one.** The
`implement` and the three security task types have their pull request opened
by the plane at the Handoff start, before the agent's first commit: the plane
pushes the ticket's factory branch and opens the pull request on it as a
draft, with the title and body the plane writes. The title is the ticket's
title. The body of `implement` carries the closing reference to the issue,
the ticket's URL, and the ticket's description; the body of a security task
type carries the source item's URL as a plain reference, never a closing
reference, because closing a finding stays a maintainer decision. The agent
works the branch the pull request already stands on: it commits and pushes,
it posts its notes as a pull request comment, and it never creates or merges
a pull request or edits the body.

**The create retries the fresh branch's lag.** The push reaches the source's
git server, but the source's read may not carry the fresh branch's commits
yet when the create runs straight after the push. The create then answers
`No commits exist` on a branch that stands, and the plane retries only that
answer for a bounded window. A create that never clears the lag fails the
open with the last answer the source gave. The push runs before the create, so
that failure lands after the handover the amendment below describes: the
branch stands on the remote and in the checkout with no pull request on it,
and the ticket's next Handoff reopens the worktree on that branch and opens
the first draft on it.

**A fresh branch opens with the plane's hold commit.** The source opens no
pull request on a head that carries no commit ahead of its base: the create
answers `No commits between`, and no retry of the create clears it, because
the branch stands at its base until the agent commits. A branch the remote
did not carry therefore first receives one empty hold commit from the plane,
and the push carries it. The commit moves the factory branch by its name,
never the checkout's current branch: the open step runs from the source
checkout, and that checkout's current branch is the operator's. The hold stays on the branch: pushing the branch
back to its base after the open closes the pull request the source opened,
and the agent's commits stack on the hold. A squash merge, the merge
method's default, leaves the hold out of main.

**The pull request without work is the missing pull request.** Before it
publishes, the fire reads the pull request's head against its base. The test
is the work - the head's tree against the base's - not the commit count,
because the hold commit stands on every fresh branch. A head that carries no
work against its base is treated exactly like the missing pull request: the
skip is recorded on the completion trace under its own reason, nothing is
published or labeled, the ticket rests in `awaiting`, and the re-fire sweep
lands the labels when work appears. Without the guard, a turn that settles
with no pushed work would publish an empty pull request, label it ready for
review, and walk it through review and rework until the handoff limit.

**The pull request opens as a draft, and the fire publishes it.** A draft
keeps the empty pull request out of the ticket list, out of the machine's
acts, and out of reach of a stray merge, and a draft that dangles after a
closed cycle is inert. When a completed turn of such a task type settles, the
Transition fire makes one act before its label write: it reads the ticket's
own pull request straight from the source by its head branch - a draft the
machine has not labeled never stands in the ticket list, so the projection
cannot reach it - and it marks the draft ready for review. The
`ready-for-review` label then lands in the same fire, the way it already
does. No GitHub workflow takes part: "done" is the turn settle, which only
the plane observes, and the label writer stays the single one the machine
has.


**The open is a hard gate on the start.** A failed open refuses the Handoff
start with a readable reason, the way a refused Placement does. A pull request
the branch already carries is reused, never re-created, and the open runs only
on a worktree environment, because only that environment holds the factory
branch; a live-worktree start of a task type that opens a pull request is
refused with a readable reason.

**Amended by issue #296: the failed start holds the branch and the draft.** The
rule first written here was the no-residue contract extended: a Handoff that
failed after the open closed the pull request it opened and deleted the remote
branch it created, and the start's residue cleanup deleted the local branch too.
That is retired. Once the open's push lands, the branch stands on the remote
under the draft it carries, and the start owns neither copy of it: a Handoff
that fails after the push removes its herdr environment and nothing else, and
the ticket's next Handoff reopens the worktree on the standing branch and reuses
the standing pull request. Before the push the branch never stood on the remote,
and the start still removes the local branch it created, so the no-residue
contract of ADR 0097 stands for everything the open did not hand over.

The old rule spent the whole lifecycle on every failed start. Measured on the
development run over the night of 4-5 October: three tickets, 20 attempts each,
60 branch pushes, 60 draft pull requests opened with a written title and body,
and 60 closes - 98% of every closed-unmerged pull request the factory had ever
made. Each of those pull requests carried the ticket's full description and a
`Closes #<ticket>` line, so one ticket's timeline ended with twenty closed pull
requests each claiming to close it. The reuse path the plane already had - the
worktree reopens on a branch that stands, and the open reads the branch's own
pull requests before it creates - reaches that work for free once the failed
start stops tearing it down.

**The standing draft does not rest the ticket.** A draft left on the branch
can hide its ticket only by entering the projection, because the covered rule
of ADR 0042 reads the projection and nothing else. The default Pull request
source policy keeps it out: the source asks for
`is:open is:pr repo:<repository> -label:blocked no:draft`, and for a draft
only with `label:needs-work`. The draft a failed start leaves wears no label,
so the covered rule has no row to read: the ticket keeps its place in the
Ticket section, the top-up asks it again once the failed start's hold clears,
and the next start runs the reuse path. The corner where a standing draft does
cover is one the source carries into the projection on its own - a draft the
operator labeled `needs-work`, or a source whose own `filter` fetches drafts -
and there ADR 0042's rule stands as written: the ticket rests behind its pull
request until that pull request closes or loses the label.

**A cycle end closes the draft, and never the published pull request.** A
Close, an abandon, or a decision close that ends the cycle while the ticket's
pull request is still a draft closes that pull request: the work was never
published, the branch keeps its commits, and the ticket's next cycle opens a
fresh pull request on the same branch. A pull request the machine has
published is never closed by a cycle end: its work carries the machine's
position (ADR 0042). The rule exists because a draft left in place can reach
the projection after all - the policy fetches a draft that carries
`needs-work`, and a covered ticket leaves the ticket list while the top-up
cancels its queued start - and a draft the operator sees in no pull request
list is inert there too. The cycle end takes the draft out instead of leaving
the ticket's reach to a label.

**The pull request opens under the source's authentication.** The same
egress the label writes use, so the pull request is plane-owned in the same
sense the labels already are, and no new credential path appears.

**The templates change unconditionally, in both shipped configs.** The
`default` and `development` configs drop the "create a pull request" step
from the four task type templates and give them the pull request's URL: the
prompt is sent only after the open, so the URL the agent reads is real. The
agent's standing orders become: the pull request already stands at the URL,
commit and push, never create or merge a pull request, post your notes as a
comment. No config gate separates the old behavior from the new: the factory
runs one operator, and the mixed state - the plane opens the pull request
while the template still tells the agent to open one - would fail the
agent's own create against the existing pull request.

## Consequences

- An implement handoff now needs GitHub reachable at start. A GitHub outage
  refuses new implement starts with a readable reason; the ticket stays open
  and a retry starts it.
- The pull request's author is the source account, not the worktree's git
  credentials. A pull request an agent opened before this change still links
  through the branch prefix or its closing reference, so in-flight work is
  untouched.
- The stub world must answer the new commands - the branch push, the pull
  request open, ready, close, and list by head branch - and keep the draft
  fact, the way it already answers the label writes (ADR 0073). The handoff
  tests' pinned command sequences change with the new steps.
- A manual override that routes a review or rework onto a pull request that
  is still a draft strands the fire, because the machine acts on non-draft
  pull requests only. The operator marks the pull request ready in GitHub.
  The machine's own routes never reach this corner: the publish runs before
  the machine ever routes onto the pull request.
- The pull request stands in the parking state for one refresh after the
  publish and before the label write of the same fire: a brief row with no
  suggested task, on the order of the source's refresh interval.
