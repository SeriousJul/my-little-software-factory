# ADR 0068: The plane action resolves a position without an agent

Status: accepted
Date: 2026-09-30
Superseded in part by ADR 0099: the automatic merge ask no longer keeps the
settled turn's environment. The confirm's close, its reach, and its timing at
the ask stand, and everything else this page decides about the plane action
stands. Where this page says the automatic ask keeps the environment, read the
ADR 0099 rule: every workflow-origin merge ask closes it at the ask.
Amended in one sentence by ADR 0109: the run takes the Shared checkout hold of
its pull request's Repository from its claim until its run settles, so a
worktree Handoff of that Repository never creates its worktree while the merge
runs. The run's own commands work the Repository through the source, and ADR
0108 records that measurement. The seat rule this page decides is unchanged:
the plane action takes no Parallel limit seat, and the checkout hold is not one.

## Context

The `ready-to-ship` position of the shipped machine offers the `merge` task
type, and the merge is the only task whose whole work is one command: the
squash merge of the pull request. The factory ran it as a full Handoff: a
Parallel limit seat, a worktree environment, a herdr pane, and an agent turn
that read the template, called the command, and settled. The machine already
owned the blocked outcome: the merge task type's Transition reads the pull
request from the source at settle time and writes `needs-work` while it stays
open. The agent's added work was a comment on a blocked merge, and a
judgment to close the related ticket that the machine could not read: GitHub
closes the referenced issues at merge time, and the re-verify gate reads a
closed issue after the merge. The plane also already held the egress: every
label write and pull request Judgment runs through the Command runner.

## Decision

A Workflow position's task can be work the control plane runs itself. The
task type gains an action form beside its prompt form, and the plane action
is a named built-in with typed settings, executed through the Command runner
with no Agent, no Environment, and no Parallel limit seat.

**The task type gains an action form.** An action task type names a built-in
plane action with its settings, and holds no template and no Task profile. A
prompt task type holds a template as before, and the two forms never mix on
one type. The shipped built-in set holds one action: the merge of a pull
request, with a method setting whose default is squash. The Default
configuration ships the merge task type in the action form.

**The start is a queue item without a seat.** The plane action's start enters
the Work queue like any start: a manual confirm from the Decision screen, or
the auto top-up's add. It takes no Parallel limit seat, because it holds no
agent, and the pickup's walk runs it when it reaches it, whatever the cap
bounds: a full cap breaks the walk at the first seats-bound item that cannot
start, and the item behind that break waits the way every item does. The
item takes no seat to hold its start, so the row is the claim: the pickup
removes it before the run starts, and two pickups that read the queue together
cannot both run the merge - the second claim finds no row and leaves, and the
attempt row stands once. The queue pause holds it while it stands, the
Dispatch pause holds its automatic add, and the Handoff limit counts its
attempts. A manual confirm passes the limit, the way a manual handoff does.
The run takes the Shared checkout hold of its pull request's Repository from
the claim until the run settles, so a merge and a worktree Handoff of one
Repository never reach that checkout at the same time, and the hold costs no
seat (ADR 0109).

**Manual mode keeps its gate.** Nothing ships without the operator's key:
the Decision screen's row offers the merge of the pull request, and the
operator confirms it. In Auto-handoff mode the top-up runs it when the
position is reached.

**The outcome fires the transition.** The attempt settles `merged` or
`blocked`. On a block, the plane posts a comment on the pull request
carrying the failure reason, the way the agent did. The outcome then fires
the task type's Transition the way a `completed` settle does: the same
branch machinery, the same Judgment reading the pull request fresh from the
source, the same writes. The config keeps the blocked outcome, an operator's
customized transition keeps its meaning, and one branch path serves both
trigger events. The fire runs on both outcomes alike, and its fact lands on
the attempt's record, because no Completion trace stands for it.

**The attempt is a fact, not a handoff.** Each attempt records the time, the
task type, the outcome, and the reason, on the ticket and outside any work
cycle. The action opens no cycle, settles no turn, and takes no handoff
number. The routing turn's trace records the new decision words `merged`
and `auto-merged`, beside `handed-off` and `auto-handed-off`. The ticket
detail shows the latest attempt beside the handoff facts, and the Decision
screen shows the outcome where the handoff row stood.

**No pre-attempt, idempotent by the source fact.** The attempt holds no
durable row before its first external change, the way the Handoff attempt
does: the command is one call, and the pull request's merged state is a
source fact the machine re-reads on every refresh. A crash between the
command and the record leaves no row, and a merged pull request leaves the
feed. The one idempotency rule: a merge that finds its pull request already
merged settles `merged`.

**The merged pull request leaves the projection at once.** The source stops
returning the merged pull request at the next refresh, and the retirement
does it now, the way that refresh would: the pull request's memberships
retire, and so do the memberships of every issue the pull request closed on
the merge, because GitHub closes those issues at merge time. The issue's row
never stands again behind the merged pull request, and the next refresh
finds nothing new.

**The confirm closes the settled turn's environment.** The Decision
screen's merge ask makes the route close at the ask, the way its handoff ask
does (ADR 0046): the confirm closes the environment the settled turn stored,
and the automatic ask keeps it, the way the automatic route does. The merge
run builds no environment of its own, so the close is the ask's whole act on
the environment. (Retired by ADR 0099: the automatic ask closes it too, and
only the automatic handoff route and the Restart keep the reuse.)

**The close-ticket judgment drops.** GitHub closes the issues a pull request
references at merge time, and the re-verify gate reads a closed issue after
the merge. The agent's judgment to close a related ticket by its own reading
of the acceptance criteria does not transfer to code, and the machine does
not hold it.

**The migration keeps the operator's words.** A merge task type whose
template matches the shipped seed exactly takes the action form at load, the
way the seed templates migrate today. A customized template stays a prompt
task type untouched, and the agent merge path remains available to it. The
report names each choice.

**The surfaces.** Both outcomes take a Message line: the pull request key,
and the outcome, with the reason on a block. No bell: a block lands
`needs-work`, and the rework handoff carries the fact forward. No face on
the ticket row: the attempt is a sub-second fact, and the ticket keeps its
`open` state. A decision row that offers a plane action offers no override,
because the action holds no settings the panel can edit.

## Considered options

- A generic command in the config, such as `command = "gh pr merge ..."`.
  Rejected: a shell string in the operator's file, with the exit code as the
  only fact, and an injection surface the factory does not need.
- A hard-coded special case for the task type named `merge`. Rejected: it
  breaks the config-driven machine and makes the name unchangeable.
- A full Handoff record with no agent. Rejected: the Handoff assigns a
  ticket to an agent type and an environment, and a command holds neither.
  The Decision screen would show a turn log that never existed.
- A full pre-attempt discipline with a boot settle. Rejected: the source
  fact is the truth here, the way it is for the Fixing pull request, and the
  pre-attempt row buys a settle path for a window that lasts one command.

## Consequences

The glossary gains the Plane action, and the Task type, the Handoff limit,
the Transition, the Completion decision, the Queued state, the Work queue,
the Parallel limit, the Decision modal, and the Override carry the new form.
The `queued` state settles a plane action's route to `open` without a cycle.
The blocked merge's label stays a config-owned fact, and the operator who
customized the merge transition keeps it. The agent merge path remains for a
customized template, and a pull request that never referenced its issue does
not close it: the operator closes that one by hand.
