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

**The pull request without commits is the missing pull request.** Before it
publishes, the fire reads the pull request's head against its base. A head
that carries no commit ahead is treated exactly like the missing pull
request: the skip is recorded on the completion trace under its own reason,
nothing is published or labeled, the ticket rests in `awaiting`, and the
re-fire sweep lands the labels when a commit appears. Without the guard, a
turn that settles with no pushed work would publish an empty pull request,
label it ready for review, and walk it through review and rework until the
handoff limit.

**The open is a hard gate on the start, and the no-residue contract extends
to it.** A failed open refuses the Handoff start with a readable reason, the
way a refused Placement does. A Handoff that fails after the open closes the
pull request it opened and deletes the remote branch it created; a branch or
a pull request that pre-dates the attempt is never touched, and a pull
request the branch already carries is reused, never re-created. The open
runs only on a worktree environment, because only that environment holds the
factory branch; a live-worktree start of a task type that opens a pull
request is refused with a readable reason.

**A cycle end closes the draft, and never the published pull request.** A
Close, an abandon, or a decision close that ends the cycle while the ticket's
pull request is still a draft closes that pull request: the work was never
published, the branch keeps its commits, and the ticket's next cycle opens a
fresh pull request on the same branch. A pull request the machine has
published is never closed by a cycle end: its work carries the machine's
position (ADR 0042). The rule exists because a draft left in place would
cover its ticket - the list withholds a covered ticket and the top-up
cancels its queued start, while a draft without `needs-work` stands in no
pull request list at all - and the ticket would be unreachable.

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
