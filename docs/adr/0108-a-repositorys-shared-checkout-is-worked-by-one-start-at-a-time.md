# ADR 0108: A Repository's shared checkout is worked by one start at a time

Status: accepted
Date: 2026-10-05
Amends ADR 0068 in one sentence: the Plane action still takes no Parallel limit
seat, and this decision adds the gate that stands beside the seat. Extends
ADR 0034 (the Work queue is the one place a start waits) and ADR 0049 (a pickup
attempt ends in start or drop). Reuses the Repository key ADR 0053's Operation
serializer normalizes, and follows the record voice issue #231 sets for a
standing fact.

## Context

A worktree Handoff creates its worktree out of a Repository's shared checkout:
the start reads the checkout, runs the branch rule, and asks herdr for the
worktree. The merge Plane action is the other start of the pair the record
measured. Its run issues `gh` commands and nothing else - the fresh read of the
pull request, `gh pr merge`, the block's comment, and the transition fire's
label writes - and no `git` command, and no `-C <checkout>`, anywhere in the
merge run or its fire. The merge works the Repository's remote, not its
checkout. The issue's premise, that the merge "runs its Git work in the shared
checkout", is not what the code does, and this decision records that
measurement.

The plane knew the collision the worktree starts cause and named it in a comment
without acting on it: the worktree add is "the one place two Handoffs can
collide".

The Parallel limit cannot see the pair, because the Plane action takes no seat
(ADR 0068). The measured failure is exactly that reading: a merge started at
`00:30:43.830` with the seats read `0/1`, a Handoff started at `00:30:43.922`
with the seats read `0/1`, and the worktree create reached the checkout at
`00:30:46.013` while the merge still ran. Both starts were correct against the
cap, and both were wrong about the checkout. The create that met the checkout
was a create meeting another create; the merge's own commands never reached it.
What the merge and the create share is the Repository, and the absence of any
gate between them.

The failure is not rare and not self-limiting. The plane re-asks a position
every observation cycle, so one stuck position spends the Handoff limit and
starts again on the next source read. The issue measured 9,356 failed attempts
on one Ticket, 4,864 on a second, and 585 on a third, in about a day. The
refusals the collision produced - a worktree add that reports its own branch as
already used, a merge that meets a checkout moving under it - were the whole
record, and nothing in the record said the two starts had met.

Two facts made the pair easy to start and hard to see:

- **The seat is the only gate the queue has.** ADR 0034 gives the Work queue one
  bound, the Parallel limit, and ADR 0068 deliberately takes the Plane action
  outside it, because a merge holds no Agent and no Environment. Nothing else
  stands between a merge and a worktree create.
- **The two starts name the same Repository by different routes.** The merge
  aims at a pull request and works through its membership's Repository; the
  Handoff resolves its Repository from its Ticket's membership and the config's
  mapping. Nothing in the plane compared them.

## Decision

**One Repository's shared checkout is worked by one start at a time, and the
Handoff dispatch owns that rule.** Two starts take the hold: a Handoff whose
Environment is a worktree, which creates that worktree out of the checkout, and
the merge Plane action, which the record shows meeting that create with no gate
between them. The dispatch holds one checkout hold per Repository, taken at the
start's claim and let go when that start settles. The hold is keyed by the same
Repository key the Operation serializer normalizes (issue #203), so `acme/factory`
and `github.com/acme/factory` are one checkout and not two.

The hold names the Repository the start works, read from the projection: the
pull request's Repository for a merge, and the Repository the Handoff's Ticket
stands in for a worktree start. A Ticket listed in two Repositories holds the
checkout its start works and not the pair of them, so a merge of one Repository
never waits behind a start that works the other (issue #297 review).

**The hold stands beside the Parallel limit and is never counted against it.**
ADR 0068 is unchanged: the Plane action takes no seat, and the pickup runs it
whatever the limit reads. The checkout hold is a second, independent gate, and
a start that waits on it takes no seat either, so the walk reaches the starts
behind it. Two Handoffs that take worktrees in different Repositories start in
one pass, and the Parallel limit still gates them on its own.

**The hold covers the checkout work, not the turn.** A worktree Handoff holds
the checkout from its claim until its attempt settles, which is when its Agent
started - not when its turn ends. The Agent works inside its own worktree, so
the shared checkout is free again the moment the worktree stands. A claim the
herdr seat parks behind another run holds the checkout while it waits: the
worktree create is the next thing that start will do, and a merge must not walk
into the checkout ahead of it.

**A start that finds the checkout at work stays in the Work queue.** The gate
runs ahead of the claim, so the row is never taken: the row keeps its place, the
Ticket keeps its state and its `queued` badge, and the next pass runs the start.
The record names the wait once while it stands, in the voice issue #231 sets,
and names the start that holds the checkout:

```text
handoff waits: "Add a webhook retry policy" (the shared checkout is at work: the merge of "Persist the source facts" runs in it)
merge waits: "Persist the source facts" (the shared checkout is at work: the handoff of "Add a webhook retry policy" runs in it)
```

The line follows the plane's one rule for a standing fact: once while it stands,
again when the fact changes - a new row, or the same row waiting behind a
different start - and never once per poll. The entry follows its row the way the
standing-row refusal's entry does, and the pickup pass sweeps the entries whose
row is gone.

**The wait is bounded, on two clocks.** The bound is the checkout work's own
budget: ten minutes, the budget the Command runner already gives a single
command. A start is refused with the reason and leaves the queue when either
clock reaches it, the way every pickup attempt ends in start or drop (ADR 0049):

- the hold's own age, from the clock reading its start took the checkout. A hold
  that stands a whole budget after the start took it is a start that stopped
  answering.
- the waiting row's own wait, from the clock reading its line was first stated.
  A Repository whose checkout keeps changing hands gives every new holder a
  fresh reading, so the hold's age alone lets a chain of short starts hold one
  row past any bound: the review measured sixteen worktree Handoffs of one
  Repository queued behind one merge row, the clock moved in steps of a third of
  the budget with one command answered per step, and the bound that read only
  the holder's age fired zero times in fifty simulated minutes.

```text
handoff refused: "Add a webhook retry policy" (the shared checkout stayed at work past its budget)
```

The queue never waits on a row that cannot reach an exit.

**The hold is dropped wherever its start settles, and a read drops a hold whose
holder no longer stands.** The merge run's mark and the Handoff attempt are the
two facts that say a start stands. A hold outliving both is a bookkeeping miss,
not work, and the plane keeps the Repository working rather than lock it out for
the rest of the run.

**The operator's force-dispatch passes the cap and nothing else.** The key on a
row whose checkout is at work leaves the row standing and answers with the fact
that holds it, on the Message line beside the record. The checkout rule is not
the cap, and the key that crosses the cap does not cross it.

**A live-worktree Handoff takes no hold, and a Consultation's work stays behind
its own lock.** A live-worktree Handoff works a checkout the operator chose and
already owns, and the Live checkout conflict is the rule that asks about it. A
Consultation's topology and cleanup work is already serialized per Repository by
the Operation serializer (issue #203). Neither is the pair this decision found,
and neither gains a second rule.

## Options considered

- **Give the merge a Parallel limit seat.** Rejected: ADR 0068's whole point is
  that a merge holds no Agent, and a seat is the count of Agents. A merge would
  then wait behind two running Handoffs of unrelated Repositories, and the
  Handoff limit would count work it was never bounding.
- **Chain the two starts on the Operation serializer's promise queue.** Rejected:
  the serializer holds its work in a promise chain, not in the Work queue, so
  the waiting start would leave the queue, wear no badge, answer no ask, and
  state nothing. The issue asks for the wait to be visible, and ADR 0049 makes
  the queue the one place a start waits.
- **Serialize every start of one Repository, Environment kind aside.** Rejected:
  a live-worktree Handoff works a checkout for its whole turn, and the merge
  would wait minutes behind an Agent that touches the checkout once. The rule
  has to name the checkout work, not the Repository's every use.
- **Let the worktree create retry on the collision.** Rejected: the collision is
  the symptom, not the fault. A retry runs the same create against a checkout
  another start is changing, and the merge's own failure - the second half of
  the pair - has nothing to retry against.
- **Bound the wait by the waiting row's own age, alone.** Rejected as the only
  bound, and taken as the second of the two clocks above: the bound has to answer
  "how long may this checkout be at work", and the hold's age answers that for
  one holder. The review's sixteen-handoff measurement showed the hold's age
  alone resets at every hand-off and cannot bound a chain, so the row's own wait
  stands beside it.
- **Scope the rule to the worktree Handoff pair the evidence names.** Considered
  and not taken. The pair the issue names, and the pair the record shows meeting
  with no gate between them, is the merge and the worktree create, and the
  measured fact that the merge's commands are `gh` commands narrows what the
  hold buys from the merge's side: a merge of a Repository waits behind that
  Repository's worktree starts, which is the seconds a create takes, and the
  budget bounds it. The rule narrows to the Handoff pair alone if the merge's
  serialization ever costs more than that, and the open limit is recorded below.
- **Refuse the second start instead of queueing it.** Rejected: the second start
  is a start the factory already decided to make, and ADR 0049's queue is where
  a start that cannot run now waits. A refusal would spend the Handoff limit on
  a collision the plane could have waited out in seconds.
- **Hold the checkout in the state file, so two plane processes cannot collide.**
  Rejected for now, and the cost is recorded: the collision the issue measured
  is one plane against itself, and the state file's lease already bounds one
  plane per state. A second install working one checkout is a real case, and it
  needs a durable hold with a stale-holder rule; the in-memory hold does not
  cover it.

## Consequences

The glossary carries the Shared checkout hold, and the Plane action and Parallel
limit entries state the rule beside the seat. ADR 0068 and ADR 0034 carry the
same sentence, so the two decisions that own the starts name the gate the pair
now crosses.

The dispatch owns the hold, because it owns the claim: the merge's claim is its
queue row's removal, and the Handoff's claim is its attempt. No new durable
table stands for the hold - it lives and dies inside one run, and the record is
the durable account of it. The gate reads the Repository the start works out of
the projection the pickup already reads for its own gates, so no read runs per
queue row beyond the one the claim path takes.

`repositoryOperationKey` is now the shared spelling of one Repository, read by
the Operation serializer and the checkout hold alike, so the plane holds one
fact per Repository and not one per spelling.

`CHECKOUT_WORK_BUDGET_MS` is the one bound, and the suite reads it rather than
restating it, so moving the budget moves the test with it.

The wait is a record fact and a queue fact, not a surface fact: the row already
wears the `queued` badge, and no new badge or marker was added. The screen-reader
path for the two new record lines is not verified - the suite reads the `log`
seam and the queue's rows, and no assistive technology ran against either. The
inherited-theme walks have not been re-run on this change either (see the
shared-controls verification record).

The hold is in-memory, so a plane restart does not carry one. A restart cannot
collide with a run it no longer has, and the boot settles the claims a crashed
run left behind (ADR 0041) before its first pickup pass.

**The open limit this decision leaves.** The merge's half of the rule rests on
the pair the record names, not on checkout work the merge does: the merge's
commands are `gh` commands, measured above. The plane keeps the merge held
because the issue names the pair and nothing else separates the two starts, and
the cost it records is the seconds a worktree create takes. A later change
narrows the rule to the worktree Handoff pair alone if the merge's serialization
costs more than that. The verification record states what the suite measured for
this rule and what it did not.
