---
title: Handoffs
description: "Where each handoff setting comes from, model discovery, and repository resolution."
---

# Handoffs

Enter on an open ticket starts a handoff with the settings its task type
resolves. The override panel changes them for that one handoff only; it never
becomes a default. A workflow handoff resolves the next task type's own
settings and inherits nothing from the previous handoff, and `e` on its
decision row edits the resolved settings first. A Restart repeats the
interrupted handoff's settings, because that handoff is the decision being
resumed.

Each setting resolves on its own chain, closest to the handoff first:

| Setting        | Where it comes from, in order                                                            |
| -------------- | ---------------------------------------------------------------------------------------- |
| Agent          | Your override, then the transition's pin, then the task type's, then the default agent    |
| Model          | Your override, then the task type's, then the default model, then the agent's own default |
| Thinking level | Your override, then the task type's, then the agent's own default                          |
| Context window | Your override, then the task type's, then the agent's own default                          |
| Environment    | Your override, then the transition's pin, then the default environment                    |

A handoff that resolves a value the chosen agent cannot take fails before
anything starts, with a readable reason, and the ticket stays where it was.
So a model written for one agent never runs a different one quietly, and a
route onto a narrower agent is seen as a failure instead of being absorbed as
a default.

## One start, one pre-flight

Every start runs through one module: an open ticket's first handoff, a workflow
handoff, a Restart, and a Consultation launch. Each caller states the facts it
owns - the choice, the workspace its previous handoff recorded or none, the
branch policy, and the prompt - and the start answers with one outcome.

The pre-flight reads the same facts in the same order on every path: the Agent
type, then the Environment, then the task type a handoff names, then the
Environment a task type that opens a pull request needs, then the Setting fit.
One bad choice therefore carries one reason, whatever you asked for, and it
carries that reason before the plane touches your repository or your remote. An
unknown Agent type beside the reserved container Environment names the Agent
type, because that is the first fact the plane read.

A start that fails before its agent starts removes what that start created: the
fresh tab, the workspace it created, the fresh worktree checkout, and the branch
when it created the branch. The rule is the same in every environment. The pull
request open's handover, two paragraphs below, is the exception to the last of
them. What pre-dates the attempt stands: a workspace you own, a branch the
repository already carried, and a pull request the read found. A command the
plane cannot run at all is answered the way a refusal is, so a start that stops
in the middle of its own sequence still removes what it made. What the start
really closed is
confirmed in its record, under the kind the start recorded it under, so a
Consultation's detail names no resource that is already gone, and its Close does
not retry a workspace herdr no longer holds.

The pull request open hands the branch over. Once the plane's push lands the
factory branch on the remote, the branch and the draft pull request it carries
belong to the ticket and not to the start: a start that fails after that push
removes its herdr environment and nothing else - no draft close, no remote
branch delete, no local branch delete. A command that raises is answered the way
a refusal is, and a raise after the push carries the same handover. Your next
handoff of that ticket reopens the worktree on the branch that stands and reuses
the pull request the branch already carries, so a ticket wears at most one Fixing
pull request across any number of failed starts. Before the push the branch never
stood on the remote, and the start still removes the local branch it created. The
create's retry window is a failure after the push: a draft create that never
clears the fresh branch's lag leaves the branch standing on both sides with no
pull request on it, and your next handoff opens the first draft on it.

The branch on the remote is the standing branch. When the checkout no longer
carries it - you pruned local branches, or a fresh clone carries none - the next
handoff asks origin, fetches the branch it finds there, and reuses it, instead of
building a fresh branch whose push the remote would refuse every time. The ask
runs before either way of building a branch: the fresh build from the worktree
base, and the reopen of a stored worktree whose checkout is gone, which names no
base and would take whatever HEAD the source checkout stands on. And
because every failed start removes its checkout and keeps its branch, the retry
is the start that can meet the directory the removed checkout left behind with a
build cache in it: the plane moves that leftover aside under a `.leftover` name
and creates again (ADR 0062).

The standing draft does not hide the ticket. The covered rule that withholds a
ticket behind its Fixing pull request reads only the rows your sources fetched,
and the default pull request source fetches no unlabeled draft: it asks for
`no:draft`, or for a draft that carries `needs-work`. The draft a failed start
leaves wears no label, so the ticket keeps its row in the Ticket section, the
automatic top-up asks it again once the failed start's hold clears, and the next
start reuses the branch and the draft. A draft you labeled `needs-work` is the
case that does enter the list, and there the ticket rests behind its pull request
the way ADR 0042 says.

## Model discovery

The agent CLI owns the list of models it can run, and the config file names
no models. The control plane queries the agent on demand and keeps no cache:
the list is what the agent reports this moment, so you can change a
provider's auth while the plane runs. That is why a model you wrote passes or
fails. At startup, a config that names a model its agent does not offer stops
the start with a readable line per value; at a handoff, a model not on the
agent's current list fails it before it changes anything outside the control
plane. A list that cannot be fetched only warns, so one agent that cannot
answer does not block the control plane, and the agent's own rejection
stands. An agent whose CLI reports no list takes a free-text model value
instead, and those values are not checked.

## Repository resolution

The control plane finds the ticket's repository in this order:

1. The mapping in your config: `[repos] "github.com/owner/name" = "/path"`.
   The path must hold a checkout of exactly that repository - the remote is
   matched by repository, not by URL shape, so https and ssh, a port, and
   other spellings all count. A mismatch is a hard failure: the control plane
   never uses the wrong tree.
2. The convention path `~/src/<repository name>`.

When the convention path holds a different repository, the control plane
clones the ticket's repository to a sibling path (for example
`~/src/billing_1`), hands off there, warns on the Message line, and hands the
new mapping back to be written to your config file, so the next handoff
resolves it explicitly. [The Configuration page](../configuration/index.md)
carries the `[repos]` key.
