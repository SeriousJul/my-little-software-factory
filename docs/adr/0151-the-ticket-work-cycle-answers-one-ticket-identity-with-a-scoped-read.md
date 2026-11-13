# ADR 0151: The ticket work cycle answers one ticket identity with a scoped read

Status: accepted
Date: 2026-11-14

Records that the ticket work cycle aggregate's interface gains the scoped
ticket read: given one ticket identity, it answers the ticket's own row, the
same value the full projection makes for that identity before the list rule
withholds it, or the fact that no row stands, together with the ticket's
pull request link, the open pull requests that fix the ticket and the listed
pull request it opened. The read answers from targeted reads on that one
identity, through narrow named operations of the source fact and handoff
aggregates beside the global reads the list keeps, so its cost is a constant
number of statements that does not grow with the size of the ticket record.

## Context

The operator runs the plane in front of a ticket record that grows: every
source fetch adds rows, and the machine keeps working on them. Today the
plane's state side pays for the whole record on every Observation cycle, not
just for the tickets that moved. The cycle walks the list twice, and every
per-ticket action on top of that re-projects the record: a full pass over the
tickets table, eight batched reads over every identity, and the construction
of every ticket row, once per ticket name the cycle writes to a queue line, a
hold line, a park line, or a collision line, and once per ticket the handoff
dispatch claims, cancels under the covered rule, or merges for a plane
action. The fire pays twice: one full pass to find the ticket and the pull
request it acts on, and a second to resolve the position to the pull request
the ticket opened.

So a record with many tickets keeps the plane heavy on every cycle, even
when one agent moves: the state-side cost scales with the product of the
tickets that moved and the size of the record. The operator feels it as a
plane that gets slower to name, hold, and start as the record grows.

The seam is shallow on the per-ticket side: the aggregate's interface exposes
only the whole-list read, so the per-ticket work re-derives the whole list to
ask about one ticket. The full projection earns its keep on the list:
ADR 0042's list rule is cross-ticket, a ticket rests behind every open pull
request that fixes it, and no read of one ticket can answer that question.
And one premise of the review that suspected this seam does not stand: the
shared name rule consumes none of the eight batched reads. It reads the title
of the identity's own row, or the identity when the projection holds no row
for it, and the fact that looks like a name-collision read is a different
fact, the Agent name collision of ADR 0107, which the top-up start gate
already reads per identity. The cross-cutting fact the per-ticket work really
needs is the pull request link, which the ticket's own row cannot answer.

The deepening reaches every caller through wiring that already exists: the
state composition builds exactly one ticket work cycle module, and the
Observation cycle, the Handoff dispatch module, and the fire flows all hold
that same instance, and the ObservationDispatch port (ADR 0130, ADR 0133)
governs dispatch operations only, so the port gains nothing and no caller
changes in behavior.

## Decision

The ticket work cycle aggregate's interface gains one operation, the scoped
ticket read, and the per-ticket work stands on it.

- The scoped ticket read, proposed name `ticketOf(identity)`, answers the
  ticket's own row, the same ticket value the full projection makes for that
  identity before the list rule withholds it, or the fact that no row stands;
  and the ticket's pull request link: the rows of the open pull requests that
  fix the identity, and the identity of the listed pull request the identity
  opened, or its absence. The row carries everything the per-ticket work
  reads from a ticket: the title, the state, the memberships, the repository,
  the handoff, the counts and streaks, the completion, the leftover, the name
  collision, and the ignore and mute flags.

- The read answers from targeted reads on the one identity: the aggregate's
  own scoped store handle for its own row, and narrow named operations of the
  owning aggregates. The source fact aggregate gains one new per-identity
  operation that answers the pull request link: the open pull request rows
  that fix the identity, found by the same rule the domain already states, a
  closing reference to the ticket or a factory head branch prefix on the
  ticket's key, restricted to pull request rows, and the listed pull request
  the identity opened, found by the repository identity and the factory head
  branch. The handoff aggregate gains the per-identity form of its
  unresolved-attempt fact, beside the global form the list keeps. ADR 0095
  already mandates this shape for cross-aggregate calls: the caller sees one
  interface, and the borrowing sits inside the aggregate.

- The call sites that switch to the scoped read: the per-name read both the
  cycle and the dispatch use to name a ticket on a line; the claim path's
  resolution of the per-claimed-item ticket, from which the start reads the
  title, the state, the memberships, the repository, and the source kind; the
  covered gate's decision on an open-origin item, which reads the row and the
  link and asks the covered rule; the plane-action merge, which reads the row
  for the ticket and the link for the target; the pickup's checkout gate
  read; and the settled turn's fire, which reads the row for the ticket, the
  link for the pull request it acts on, and the link's listed identity for
  the position, so the fire's second full pass goes away with it. The
  re-fire sweep's per-skip fire inherits the scoped fire through the fire's
  own switch.

- The full projection keeps its place: the visible ticket list and its views,
  the ignored and muted reads, the two top-up walks' enumeration passes, and
  the awaiting walk's shared read keep paying the whole-record price, because
  ADR 0042's list rule is cross-ticket and each walk must see the state at
  the moment it runs. The projection's fields, its eight batched reads, and
  its statement count do not move: the list pays the same price it pays
  today, once per walk, not once per ticket the cycle touches.

- The domain rules narrow their input, not their judgment: the covered rule,
  the merge and fire target rule, and the name rule keep deciding exactly
  what they decide, on the identity's row and its pull request link instead
  of the projection.

- The scoped read is a read: it runs on the aggregate's own scoped store
  handle, it asks the owning aggregates for their facts through their narrow
  named operations, and it opens no transaction. The rule of one open write
  transaction, owned by the aggregate that writes the atomic fact, stands
  untouched, and the store's scope check keeps the read inside the
  aggregate's tables.

## Considered options

- Keep the per-ticket work on the full projection (status quo): the
  state-side cost scales with the product of the movers and the record size,
  on the cycles where one ticket moves as much as on the cycles where many
  do.
- A per-ticket projection builder each caller uses: it scatters the
  projection's construction across the callers, the caller still pays to
  build the row and the cross-cutting facts, and the seam stays shallow, a
  second way to ask about one ticket beside the first.
- Scope only the name read, the smallest change: the name is the cheapest of
  the per-ticket facts, and the claim, the cancellation, the merge, and the
  fire keep re-projecting the record.

## Consequences

- The operator sees no change: the same rows, the same names, the same
  holds, the same starts, and the same lines.
- The machine: the cycle's state-side cost scales with the tickets that
  moved this cycle, and the record size enters the cycle's cost through the
  two list passes alone. On a record of a thousand tickets where two move,
  the cycle pays two scoped reads where it paid a full pass per name it wrote
  and per action it took.
- The test: the aggregate's suite pins the scoped read's row against the
  projection's row, identity for identity, in every state the plane decides
  on, and pins the pull request link against the rule's answer on the full
  array; the statement-count suite pins the scoped read's constant cost on a
  small file and a large file and pins the full projection's count
  unchanged; the coordinator seam suites, the dispatch suites, the fire
  suites, and the name rule suite stand on the narrowed input; the
  per-command pins of the observation suite catch any split between the two
  reads.
- The observation cycle's reach into state and the dispatch module's state
  are unchanged, and the handoff dispatch port names no new call.
- The glossary gains the scoped ticket read, the ticket's row, and the
  ticket's pull request link. These records land with the implementation,
  not with this ADR.
- The herdr side of the work, one process per terminal the plane polls (the
  review's O2), and the refresh a settle takes when the turn's source gives
  nothing (the review's O3), are separate deepenings.
