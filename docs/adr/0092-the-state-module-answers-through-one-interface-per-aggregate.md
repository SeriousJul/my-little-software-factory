# ADR 0092: The state module answers through one interface per aggregate

**Status:** accepted
**Date:** 2026-10-03

## Context

`src/state.ts` was one 4,000-line module holding one `FactoryState` interface over
one SQLite file. Every caller - the observation loop, the Work queue screen, the
Consultation screen - reached the same interface, so a caller could read a fact
and write a fact on any table in the file, and a change to one fact's row shape
touched the whole module. Issue #202 split it into nine aggregate modules, one
per fact the factory keeps: the Consultation record, the grouping axis and Group
order, the Handoff and its starts, the lease, the plane action start, the
repository init fact, the source fact and its memberships, the Ticket work cycle,
and the Work queue.

The first cut of that split (the branch as it first stood) moved the text into
nine files and left the boundary on paper only: every module kept the raw
connection, the interfaces carried each module's internal helpers, three
cross-aggregate calls ran on raw-row helpers, and two reads the observation loop
runs every cycle changed shape - the Ticket projection read one joined statement
before and one statement per Ticket after, and the in-flight Ticket read split a
single statement in two. That is a split with the cost of a split and none of
its protection.

## Decision

**The state module answers through one interface per aggregate, and the boundary
that interface draws is the same boundary the running code enforces.**

- **Each aggregate owns its tables, and the ownership is written down once.**
  `src/state/tables.ts` names the owner of every table the state file holds. A
  table with two owners, or with none, is an error the checks fail.
- **The store hands each aggregate a scoped handle, not the connection.**
  `store.ts` keeps the connection private. `scopeOf(aggregate, tables)` answers a
  handle that carries the path, the clock, and the transaction, and that refuses
  to prepare a statement naming a table the aggregate does not own. The runtime
  refuses the reach, so no module can drift past the boundary quietly, and the
  text check in `test/state-architecture.test.ts` refuses it in review. The two
  rules hold the same line.
- **A cross-aggregate call is a narrow named operation, never a raw-row helper.**
  The Handoff aggregate answers `ticketsWithUnresolvedAttempts`, the source fact
  aggregate answers `ticketsWithMutedSource`, and the Ticket work cycle aggregate
  answers `ticketCycleFacts` - a `{ state, workCycle }` fact - where the first cut
  handed out row lookups. An operation an aggregate does not publish to callers
  is `private` on its module, so the interface is the whole surface a caller can
  reach.
- **A split may not change the read shape of a read the observation loop runs
  every cycle.** Where the split forced a fact onto another aggregate's tables,
  the read batches instead of looping: `src/state/batch.ts` chunks the identity
  list at 400 and each aggregate answers one grouped statement per chunk. The
  Ticket projection costs a constant number of statements - measured at 8 for a
  file of 300 Tickets, where the first cut cost 2,101 - and the in-flight Ticket
  read costs two. `test/state/reads.test.ts` counts the statements a read runs,
  so a later change that turns a batch back into a loop goes red.
- **`handoffCount` stays two statements on purpose.** The count adds the Agent's
  starts (`handoffs`) to the control plane's starts (`plane_action_attempts`), and
  those tables have different owners. One joined statement would put both tables
  behind one handle and break the ownership rule above. The count is batched in
  the projection path, so the observation loop pays two statements for the whole
  list rather than two per Ticket.
- **The Leftover environment fact stays with the Handoff aggregate.** Issue #202
  listed it under the Ticket work cycle. It lives on the `handoffs` row -
  `leftover_reason`, `leftover_at`, `leftover_cleared_at` - it is written when a
  handoff's worktree or pane survives the turn, and it is cleared by the Handoff
  aggregate's own clear path, which matches the row on its workspace, its tab, or
  its attempt id. The fact is a fact about a handoff's environment, not about a
  Ticket's cycle. Moving it to `tickets` would move three columns, cost a schema
  migration, and change no behavior.
- **The composition is built as a whole.** `graph.ts` assembles the nine modules
  in one typed object, and each module takes a thunk that answers the finished
  graph. The first cut cast an empty object into the graph type; a missing
  aggregate could not fail the build. The check reads the construction and fails
  on a cast.
- **The architecture test stays out of the mutation campaign**, beside the shared
  control architecture test, for the same reason: it reads production source as
  text, and instrumentation rewrites exactly the shapes it counts.

## Consequences

- A caller names the aggregate it reads. `test/state-architecture.test.ts` fails
  a file that reaches `state.handoff.…` without naming `HandoffAggregate`, and a
  file that reaches the whole composition instead of an aggregate interface.
  `src/startup.ts` is the one caller allowed to hold the composition, because it
  is the open path.
- Adding a fact means deciding its owner before writing a query, and adding a
  table means naming its owner in `tables.ts`. A table no aggregate claims fails
  the ownership check.
- A read that needs a fact from another aggregate goes through that aggregate's
  batch operation. A per-row lookup in a loop over the visible list is a
  regression the read test catches.
- The state tests split with the modules: `test/state/` holds one file per
  aggregate, files for the behavior that spans two of them (`ignore.test.ts`,
  `mute.test.ts`, `route.test.ts`, `turnCause.test.ts`), `seam.test.ts` for the
  open path and the migration chain, and `reads.test.ts` for the statement count
  of the reads the observation loop runs. The behavior the flat
  `test/state.test.ts` covered is re-homed, not dropped.
- `src/state.ts` keeps no rule of its own. It opens the file, composes the
  graph, and closes it.

## Considered alternatives

- **Keep one interface and one module, and only move code into files.** Rejected:
  it leaves every caller able to reach every table, which is the property the
  split exists to remove.
- **Give each aggregate its own connection to the file.** Rejected: the plane
  depends on one write transaction spanning the aggregates - a handoff that
  records a start and takes a queue item is one atomic fact - and two connections
  on one file add lock contention for no isolation the scoped handle does not
  already give.
- **Let the aggregates share raw-row helpers behind a shared internal
  interface.** Rejected: a raw row is the table's shape, and passing it across
  moves the table's shape into the caller. The narrow named facts
  (`ticketCycleFacts`, `ticketsWithUnresolvedAttempts`) cost a little more code
  and keep each table's shape inside its module.
- **Restore the single joined statement for the Ticket projection and the
  in-flight read.** Rejected: the join reaches `handoffs`, `memberships`,
  `completion_traces`, and `plane_action_attempts` from one handle, which is the
  boundary the runtime enforces. Batching keeps the statement count constant
  without crossing it.
