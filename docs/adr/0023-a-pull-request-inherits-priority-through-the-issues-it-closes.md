# ADR 0023: A pull request inherits priority through the issues it closes

Status: accepted
Date: 2026-09-14

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
identities of the referenced issues are stored as a source fact on the
pull request's membership, and a refresh can change them.

**A reference resolves by the issue's identity.** When the issue is or was
a ticket, its stored labels supply the rank; an issue that left the source
keeps its last known labels. When the issue is neither, the control plane
reads it directly by repository and number, batched into one extra request
per pull request source refresh, and stores the answer as a Referenced
issue fact: a fact, not a ticket. It takes no row in the Main view and is
never handed off.

**The direct fetch covers every reference the snapshot does not, on every
refresh.** One rule for the never-seen issue and the issue that left the
source. A referenced issue's labels are as fresh as the last refresh.

**A failed direct fetch never fails the source.** The previous labels stay
in place, one warning line, and the rest of the refresh applies. The extra
request runs only when at least one reference is uncovered.

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
- One pull request source refresh can run one extra batched request,
  bounded by the count of uncovered references.
