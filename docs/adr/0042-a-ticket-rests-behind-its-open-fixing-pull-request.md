# ADR 0042: A ticket rests behind its open fixing pull request

Status: accepted
Date: 2026-09-21

## Context

A completed turn on a Dependabot alert in `SeriousJul/pi-extensions` (alert
#5, pull request #97, 2026-09-21) exposed a structural gap in the machine
ADR 0023 and ADR 0027 built: the pull request the agent opened cannot be
linked to the security item it fixes. The link the plane reads is
`closingIssuesReferences`, and GitHub does not put a Dependabot alert, a
security advisory, or a secret scanning alert into that field: a pull request
body that says `Fixes ... security/dependabot/5` stores no reference, and the
plane's own fetch of the pull request carried none. The transition therefore
recorded `no linked pull request was found for the ticket`, wrote no
`ready-for-review` onto the pull request, derived no position, and
auto-advanced nowhere. The pull request parked unranked at the bottom of the
list with no suggested task, and the alert - still open upstream, because a
Dependabot alert stays open until the fix merges - stayed listed, ranked by
its severity, and still suggesting its task, inviting a second agent to open
a competing pull request.

The gap is not specific to Dependabot alerts: none of the three security
kinds can travel in `closingIssuesReferences`, and the pull request's rank
rule read only the issues it closes. The operator's expectation, which this
ADR records, is the mirror image of the failure: a ticket is done with its
own row once the work sits in an open pull request - the pull request takes
the ticket's place in the list, with the ticket's priority.

## Decision

**The factory branch is a link the plane owns.** The plane creates the
branch a handoff works, `factory/<ticket id>-<title slug>`, for both the
worktree and the live-worktree environments, and one ticket owns one branch.
The pull request source fetch gains the pull request's head branch name, one
scalar field with no possible-node cost. An open pull request in the same
repository whose head branch carries the ticket's `factory/<ticket id>-`
prefix fixes that ticket. The plane matches on the ticket-id prefix, not the
full slug: the branch is created at handoff time, and a title the upstream
source changes later must not sever the link. The closing references and the
branch match form one association, the **fixing pull request**: the newest
non-draft among the open pull requests that close the ticket or carry its
factory branch is the one the machine acts on.

**An `open` ticket that has an open fixing pull request is not listed.**
The list rule is a factory-owned visibility rule on top of source
membership: while the fixing pull request is open, the ticket leaves the
ticket list, and it re-enters when the pull request closes unmerged. A draft
pull request counts as open for this rule: the work is in flight, and the
rule's job is to withhold the ticket's task. The rule applies to every
source kind alike, and it suppresses only the `open` state: a ticket that is
`handed-off`, `running`, or `awaiting` stays listed whatever pull requests
exist, because live work must stay reachable for its Live view, its Close,
and its decision. The Work queue's pickup gate refuses a covered ticket: a
queued start whose ticket gained an open fixing pull request is cancelled
and the ticket keeps its state.

**A pull request inherits the priority of the tickets it fixes.** The
effective-rank clause of ADR 0023 generalizes from "the highest effective
priority of the issues it closes" to "the highest effective priority of the
tickets it fixes": the closing references and the fixing pull request's own
ticket feed one rule. The mechanism is unchanged: a live ticket's newest
membership labels supply the rank, a Priority override set on the ticket
travels the link, and a ticket that left its source leaves the pull request
unranked. The pull request sorts under the ordinary rank rule; it takes no
special position.

**A recorded skip re-fires when the link appears.** A refresh that finds a
fixing pull request for a ticket re-fires the newest completion trace of
that ticket that recorded the reason `no linked pull request was found for
the ticket`. The fire is idempotent: a label set that already matches its
spec writes nothing, so the re-fire takes a new egress point beside the
settle-time fire only when labels actually differ. The re-fire writes the
facts the skip left unwritten and derives the position the fire derives, so
an auto-advance task type advances through it.

## Considered options

- **Park instead of hide.** The covered ticket stays listed and ranked but
  offers no task, the way a parking state behaves. Rejected: the operator's
  expectation is that the done work takes the ticket's place in the list,
  and a covered ticket that still suggests its task keeps inviting a
  competing pull request in manual mode, where the Same-type hold does not
  reach it.
- **Parse the pull request body for a prescribed `Fixes <source-url>`
  line.** Rejected: free text is not a contract, the precedent ADR 0023 set
  stands, and the branch link severs only when someone renames a branch the
  plane created - a rare operator act whose result the skip fact already
  surfaces. A body parser would add a parse surface to guard a case the
  recorded skip handles.
- **No heal for pairs that already exist.** The operator fixes the broken
  pair by hand and the change applies to future tickets only. Rejected: the
  re-fire path is idempotent, bounded to traces that recorded the exact
  skip reason, and serves the future race - a pull request whose refresh
  lands after the settle - with the same code.
- **A special list position for a newly covered ticket.** Rejected: ticket
  priority is a fact of the ticket identity that orders the list, and a
  second ordering rule would contradict it. In the case that motivated this
  ADR, rank inheritance alone puts the pull request first.
- **Hide every ticket state, not only `open`.** Rejected: a hidden ticket
  has no row, and a row is how the operator reaches a running agent's Live
  view, Close, and Goto. Hiding in-flight work would strand it.

## Consequences

- The pull request fetch gains one scalar field. The possible-node budget
  note in ADR 0023 is unaffected: a scalar is not a connection.
- The plane's write surface to an external source widens from the
  settle-time fire to the settle-time fire plus the catch-up re-fire. The
  re-fire is the only refresh-time write the plane makes, and it is bounded
  to a recorded skip.
- The branch name `factory/<ticket id>-<slug>` becomes a contract: it is
  read back from the source and decides list membership and rank. Renaming
  the branch severs the link, and the severed link stands as a
  recorded skip, not a silent gap.
- The legacy pair heals on the next refresh: the re-fire writes
  `ready-for-review` onto the pull request, the pull request takes the
  review position and its inherited rank, and the covered alert leaves the
  list. No operator step.
- A covered ticket leaves the auto-handoff's candidate set and the section
  header counts with it. A covered ticket's re-handoff in flight stays
  visible, and when its cycle closes the ticket is covered again and leaves
  the list.
- A security item that is dismissed or withdrawn while its pull request is
  open leaves the pull request unranked: the rank source is a live ticket,
  and the security kinds carry no Referenced issue fact.
- The live development configuration, which lacked the shipped security
  states and `resolve-*` task types when the failure was observed, is synced
  to the full machine in a separate configuration change. The rules above
  are plane-owned and hold whatever machine the configuration carries.
- `CONTEXT.md` names the association: the **Fixing pull request**, and the
  Ticket priority entry reads "the tickets it fixes".
