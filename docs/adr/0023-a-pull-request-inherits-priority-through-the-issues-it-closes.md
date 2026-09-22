# ADR 0023: A pull request inherits priority through the issues it closes

Status: accepted
Date: 2026-09-14
Superseded in part by ADR 0050: the rank a pull request inherited through the issues it closes, and the labels fetched for the referenced issues, no longer hold. The closing references stay the source fact ADR 0042's fixing pull request rule and the Transition's linked pull request lookup read.

## Context

The operator declares priority on the GitHub issue. The pull request that
does the work is a different ticket with its own membership, and nothing in
the state links the two. Without the link, the pull request's ticket is
unranked, and the pull request of a critical issue would be worked after
the backlog.

The referenced issue may not be a ticket at all: the issue source lists
only the issues that match its filter, and an issue can leave that list
while the pull request that closes it is still open.

## Decision

**The link is `closingIssuesReferences`, read in the existing search
query.** One field on the pull request node, no extra request. The
reference nodes carry the identity, the number, and the repository - and
no labels, because GitHub's possible-node budget is computed from the
query's page arguments and a nested label connection exhausts it (see the
note). The identities of the referenced issues are stored as a source fact
on the pull request's membership, and a refresh can change them.

**A reference resolves by the issue's identity.** When the issue is a live
ticket, the labels of its newest membership supply the rank. The refresh
passes the live tickets and those labels to the fetch, and a covered
reference's stored fact refreshes to them. When the issue is no live
ticket, the control plane reads it directly by its identity when the
identity is known, else by repository and number, batched in requests of at
most 250 references per pull request source refresh, and stores the answer
as a Referenced issue fact: a fact, not a ticket. It takes no row in the
Main view and is never handed off.

**The direct fetch covers every reference the snapshot does not, on every
refresh.** One rule for the never-seen issue and the issue that left the
source. A referenced issue's labels are as fresh as the last refresh.

**A failed direct fetch never fails the source.** The previous labels stay
in place, one warning line, and the rest of the refresh applies. The extra
requests run only when at least one reference is uncovered.

## Considered options

- **Parse the pull request body for closing keywords.** Rejected: free text
  is not a contract, and GitHub already computes the structured list those
  keywords feed.
- **Fetch only the references that were never seen.** Rejected: two rules
  instead of one, and the labels of an issue that left the source go stale
  for good.
- **Promote every referenced issue to a ticket row.** Rejected: a ticket is
  actionable work from a ticket source. An issue outside every source
  would take a list row it can never be handed off, and the operator's
  source filters would no longer own what is work.

## Consequences

- A pull request's rank can change when its references change, when a
  referenced issue's labels change, or when the operator's issue source
  filter changes. All of it is a refresh changing source facts (ADR 0022).
- An issue that later matches the issue source becomes a real ticket. Its
  snapshot beats the Referenced issue fact, and a Priority override set on
  it then travels the link: inheritance reads the issue's effective
  priority, override included.
- One pull request source refresh can run a small number of extra batched
  requests, at most 250 references each, so the read stays under GitHub's
  possible-node budget as the snapshot grows.

## Note

2026-09-15 (issue #65): GitHub validates a query's possible-node count
against a 500,000 budget before running it, computed from the query's page
arguments. The original search nested the reference labels inside the
reference list inside the search page: 100 x 100 x 100 possible nodes, over
the budget, and every pull request source refresh failed. The decision
above is amended accordingly: the reference nodes carry no labels, a
covered reference's fact refreshes from the live ticket's newest membership
labels, and the direct read is chunked at 250 references per request. The
rank rule is unchanged.
