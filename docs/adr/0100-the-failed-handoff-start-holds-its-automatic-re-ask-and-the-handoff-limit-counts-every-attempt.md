# ADR 0100: The failed Handoff start holds its automatic re-ask, and the Handoff limit counts every attempt

Status: accepted
Date: 2026-10-04
Extends ADR 0077: the hold it decided for a blocked Plane action now stands for a
failed Handoff start too, and both read one rule. Amends ADR 0005's Handoff
limit: the count it reads is the Ticket's attempts, not its started handoffs.

## Context

The development install's state file held 17,891 Handoff attempts, 16,802 of them
at stage `failed`. One Ticket, #37, carried 9,365 attempts over seven handoffs:
herdr was asked about every 5.8 seconds for five days, each ask a Message-line
warning and a Desktop notification for the same failure. #78 looped 4,870 times on
the same cause, and #45 looped 1,773 times on another. The cause did not matter -
a worktree path that already existed, and a herdr Agent name a stranger held,
both looped the same way.

The loop is the auto top-up's re-ask. A start that never reached its Agent leaves
the Ticket exactly where it stood: the Ticket stays open, its source stays
healthy, its position offers the same task, the queue drains, and the cycle-end
re-verify gate and the Same-type hold both read clear because no turn settled.
Nothing held the next cycle's ask of the same Ticket, so the walk asked the same
failing start again on every empty-queue cycle, for as long as the Ticket stood.

The Plane action walk already owns the right shape (ADR 0077): its blocked attempt
holds the top-up's re-ask until one of the Ticket's active sources re-reads the
Ticket after the attempt ran. The Handoff walk had no equivalent.

The brake that was supposed to bound this could not reach it. `handoffCount` -
what the Handoff limit reads - counted the `handoffs` table beside the plane
action attempts, and a start that never reached an Agent writes no `handoffs`
row. #37 stood at 7 against a limit of 20 while its attempts ran into four
figures.

## Decision

**The failed Handoff start holds its automatic re-ask.** The Ticket's newest
Handoff attempt that settled `failed` - it claimed, it ran, and it started no
Agent - holds the auto top-up's ask of that Ticket until one of the Ticket's
active sources re-reads the Ticket after the attempt's outcome landed. The hold
stands in the top-up's Handoff ask, the one step all four walks share: the
continuation, the re-fired skip's route, the restart, and the open ticket. It is
silent: the re-ask on the refresh is the expected path, not a refusal to report,
and the walk moves on to its next candidate. It gates the automatic adds only -
the operator's confirm, the pickup's claim, and the force-dispatch pass it, the
way they pass the Handoff limit and the Same-type hold.

The hold is the same wait ADR 0077 waits for. The failed start changed nothing on
the source, so the read that lands the Ticket's current facts is the new signal
that makes the next ask worth making. A Ticket with no active source holds
nothing: no read can release it, and no automatic add stands on it either. An
attempt still in flight holds nothing here - it has no outcome to wait out, and
the unresolved attempt is what the claim gate and the queue's one-item rule
already hold the re-ask on.

**Both channels read one rule.** The blocked-and-unrefreshed decision lives once,
in `src/domain/attempt-hold.ts`. The Handoff aggregate supplies its newest
`handoff_attempts` row - the newest attempt by the time it was claimed, the time
its outcome landed, and the word `failed` - and the Plane action aggregate
supplies its newest `plane_action_attempts` row and the word `blocked`. Each
aggregate answers through its own interface method over its own tables; the
comparison, the source walk, and the answer are the shared module's. ADR 0077's
hold does not change behavior.

**The Handoff limit counts every attempt.** `handoffCount` is the Ticket's
`handoff_attempts` rows plus its Plane action attempts. Every `handoffs` row has
an attempt row under it, so a Ticket whose starts all reached their Agents
carries the same number it carried before; what the count gains is the starts
that never reached one. The limit keeps gating auto-handoff only: a Ticket at the
limit rests from the automatic walks, and the operator's ask passes it.

## Considered options

- **Only the hold, and leave the limit on started handoffs.** Rejected: the hold
  bounds the cadence to one attempt per source refresh, not the total. A Ticket
  whose cause never clears - a worktree path that stands, a name a stranger holds
  - would ask once per refresh forever, and the cap that exists to bound a
  run-away loop would still be blind to it.
- **Only the limit, and no hold.** Rejected: the limit is a different brake with
  a heavier failure mode. It ends the Ticket's automatic work after N tries, and
  for an in-flight Ticket the abandon is a decision written on the trace. The
  hold waits for a fact the source will supply, which is the right first answer
  for a start that failed once.
- **A fixed cooldown after a failed start.** Rejected for ADR 0077's reason: a
  timer is not a fact. The refresh is the event that makes the next ask worth
  making, and waiting for it bounds the hold to one refresh interval with no new
  knob.
- **Count only the failed attempts, and leave the in-flight ones out.** Rejected:
  the ledger is one row per start the factory made, and a start that has not
  settled yet is a start. Counting a subset makes the number depend on when the
  read happens.
- **Converge the Ticket's position locally when a start fails.** Rejected for
  ADR 0077's reason: the source's fetch is the one writer of the Ticket's
  position, and a second writer that copies the plane's intent opens a divergence
  the plane must then repair.

## Consequences

The glossary carries the Attempt hold and the amended Handoff limit. The
`max-handoffs-per-ticket` setting keeps its name and its default, and its meaning
widens to the attempts the factory made.

The limit now reaches the loop the issue reports. On the development install's
state file, #37 reads 9,365 against a limit of 20 and #45 reads 1,773: both stop
being handed off automatically on the next run, and an in-flight Ticket in that
state is abandoned by the in-flight walk's limit check the way a Ticket at the
cap is today. That is the count of an install that ran without the hold; with the
hold in place the attempts accumulate at one per source refresh, so reaching the
cap takes as many refreshes as it takes starts.

`recoverUnsettledHandoffs` settles the claim a crashed run left behind as a failed
start, so a Ticket whose start was cut off keeps the hold until its sources
re-read it, the way ADR 0077's hold survives a restart on the attempt's row.

The hold adds no read to the cycle: the top-up's ask already holds the Ticket's
identity, and the hold answers from the newest attempt row and the source reads
the gates already use.
