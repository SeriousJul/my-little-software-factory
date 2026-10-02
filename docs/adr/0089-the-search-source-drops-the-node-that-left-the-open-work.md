# ADR 0089: The search source drops the node that left the open work

Status: accepted
Date: 2026-10-02

## Context

A source is the live snapshot of the open work (ADR 0027): the `is:open`
scope stands with the filter, and a closed item the filter still matches
must not enter the list. The scope rides on the search query, and the
GitHub search index answers it with a lag. A pull request merged a moment
ago, or an issue closed a moment ago, still answers the `is:open` search,
and the node the index returns already carries the new state: the pull
request in `MERGED`, the issue in `CLOSED`, and the labels the index still
held.

The snapshot took every node the search answered. The state's refresh
upsert sets a listed membership active, whatever the node's state read,
and it writes the node's labels on it. So the refresh that follows a
merge revives the ticket the merge retired: the merged pull request
reappears in the list, in the state `merged`, wearing the labels the
index still held, and the machine offers the merge on a pull request
that is already merged. This is the recorded failure on the operator's
own install of 2026-10-02: the pull request #200 merge settled, and the
refresh four seconds later listed the pull request again, `merged`, with
the `ready-to-ship` label the merge had removed.

## Decision

**The search source drops a node whose state is not open.** The node's
own state carries the fact the lagged index cannot keep out of the
snapshot: a node in any state other than `OPEN` has left the open work,
and it leaves the snapshot the way a blocked link does, before the
snapshot answers. The drop stands for every search source, the issue
source and the pull request source alike.

**The state's refresh keeps its upsert.** The refresh still sets a
listed membership active and writes the node's labels, because a node
the source lists is live work. The lag lives at the index, and the drop
lives at the source that reads it: the one place that sees both the
index's answer and the node's own state.

## Consequences

- A merged ticket the plane retires stays retired. The retirement the
  merge pickup runs is the source's own move done now, and the lagged
  refresh that follows lists nothing for it to undo.
- The lag window moves inside the source contract. A test of the source
  proves the drop on a `MERGED` pull request and a `CLOSED` issue, and
  a test of the merge flow proves the ticket stays out of the projection
  through the refresh that follows the merge.
- An in-flight ticket whose source item closed while the agent worked
  stays visible for the decision the projection already keeps: the drop
  deactivates the membership, and the projection lists an in-flight
  ticket on its stored memberships whatever the sources answer.
- The security sources keep their own states: they list their working
  states by their own reads, and the drop stands on the search source
  that reads the index.
- ADR 0047's settle-time read stands. It decides the pull request state
  judgment from the pull request's own record, and it still does: this
  ADR keeps the snapshot honest, and the read keeps the judgment honest.
