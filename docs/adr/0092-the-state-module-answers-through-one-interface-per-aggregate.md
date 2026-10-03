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
  rules hold the same line: `tables.ts` answers `tablesNamed(sql)`, the one
  matcher both read, so neither can drift from the other. The matcher reads the
  keywords in either case - a statement written `from handoffs` reaches
  `handoffs` - and it lets a name the statement binds for itself (a CTE, a
  subquery alias) through, because that name is not a table the statement
  reaches. A name may carry its schema: `FROM main.tickets` is read as `tickets`,
  the table the statement reaches, so the refusal names the table and not the
  schema that holds it (issue #202 review). A name the statement binds for itself
  is its own only while no aggregate claims it. A CTE or a derived table aliased
  `handoffs` stands a claimed table in for the statement's own result, so the
  hiding is the reach and the matcher reports it. The earlier reading let the
  engine close the CTE form - a CTE that reads the table its own name shadows is a
  `circular reference` - and left the derived-table form,
  `(SELECT attempt_id FROM handoffs) AS handoffs`, reaching rows with neither
  guard refusing: the matcher suppressed the name and the scoped handle saw none
  of it. The matcher
  closes both forms now, so the runtime handle refuses them and no guard depends
  on the engine; `test/state/seam.test.ts` states which guard holds for each.
  A name no aggregate claims (`held`, `tickets_view`) still passes through. The
  text check reads the module's string literals, not its comments, so a sentence
  about another aggregate's table is not a reach.
- **No caller outside the module imports its plumbing.** `store.ts`, `graph.ts`,
  `tables.ts`, `schema.ts`, `batch.ts`, and `json.ts` are importable only inside
  `src/state/`. `openStore` beside `scopeOf` builds a handle over any table the
  caller names, so the door the other rules close is open to a file that imports
  the store itself. `src/state.ts` is the module's open seam and is not a caller;
  a caller that needs `StateError` takes it from `src/state.ts`, which re-exports
  it. `json.ts` holds the shared decoders only - the one JSON read every aggregate
  needs - and each aggregate decodes its own columns in its own file.
- **The file holds one write transaction at a time, and an operation another
  aggregate calls never opens one.** The plane's atomic facts span aggregates - a
  handoff that records a start and takes a Work queue item is one fact - so the
  aggregate that owns the fact opens the transaction and calls the other
  aggregates' operations inside it. That holds only while every operation the far
  side of a cross-aggregate call reaches runs inside the caller's transaction and
  never opens its own. `store.ts` refuses a nested open and names the aggregate
  that asked, and the boundary check reads the call graph and refuses a
  transaction inside any method on that far side - the interface method another
  aggregate calls, the published operation, or the private method it can call
  (issue #202 review). The check reads the whole far side of a call: the method's
  own body, every method it calls on itself through `this.`, and every method it
  reaches in a third aggregate through `graph()`, followed to the end. A method
  that opens its transaction two calls away is the same nested open as one that
  writes it in its own body; the first reading looked at the one body only, so a
  `newestHandoffsFor` that called `this.settleHandoff` passed every check. An
  aggregate that needs an atomic fact of its own opens the
  transaction at its own interface method, which is the caller's entry point and
  not a published operation. A write whose rollback fails as well is reported as
  both failures with the write's own error kept as the cause, so the rollback
  never hides what the write did (issue #202 review).
- **A caller holds an aggregate under the aggregate's own name.** The boundary
  rules read `.<aggregate>.<method>`; a caller that binds `state.sourceFact` to a
  local name, a field, or a renamed destructuring reaches the aggregate through
  the alias, and the rules read nothing. The check refuses the binding - a
  declaration, an assignment, a destructuring rename, or a member typed as an
  aggregate interface - and refuses a distinctive aggregate method called on any
  other receiver, so the alias has nowhere to be written (issue #202 review). The
  method-name half reads the callables a caller's own file declares, never the
  union of names every caller declares: a name is this file's own, so a file that
  declares `queuePaused` for itself is no allowance for a second file that calls
  `pickQueue(state).queuePaused()`. The call sites the rule cannot read on its own
  are written in `NAME_ALLOWANCE` in `test/state-architecture.test.ts` beside the
  reason - today two: the Handoff dispatch's own `enqueueWork`, standing in the
  same file as the queue's `enqueueWork` it calls, and the dispatch's
  `closeWorkCycle`, which the app shell reaches through its dispatch field. A
  recorded allowance no call site needs any more goes red, so the list cannot
  gather allowances nobody uses. A function that hands an aggregate over as its
  return value is a hold the call rules cannot see, so the check refuses it where
  it is declared, and the shapes the rules are meant to refuse are kept as probe
  sources the suite runs (issue #202 review).
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
  behind one handle and break the ownership rule above. The count is batched as
  `handoffCountsFor(identities)` - two statements for a list of any length - in
  the projection path and in the auto top-up's restart walk, so the observation
  loop pays two statements for the whole in-flight list rather than two per Ticket.
- **The auto top-up's walks read a list's facts from one read of the list.** The
  restart walk holds an identity, a pane, and a start time and no row of its own,
  so its two non-row facts arrive as batched reads: `handoffCountsFor` for the
  start counts, and the Work queue's `items` for the standing item - the same read
  the cycle gate already pays for the queue's depth, so the walk costs no statement
  for it. Asked per candidate these cost three statements for every in-flight
  Ticket on every cycle the walk ran (issue #202 review). The check reads the two
  walk members in `src/observation.ts` and refuses a per-candidate read of either
  fact.
- **The Leftover environment fact stays with the Handoff aggregate.** Issue #202
  listed it under the Ticket work cycle. It lives on the `handoffs` row -
  `leftover_reason`, `leftover_at`, `leftover_cleared_at` - it is written when a
  handoff's worktree or pane survives the turn, and it is cleared by the Handoff
  aggregate's own clear path, which matches the row on its workspace, its tab, or
  its attempt id. The fact is a fact about a handoff's environment, not about a
  Ticket's cycle. Moving it to `tickets` would move three columns, cost a schema
  migration, and change no behavior.
- **The Source memberships stay with the Source fact aggregate.** Issue #202
  listed the memberships under the Ticket work cycle, beside source health and
  the mute. The membership row is a source's own listing of a work item: its
  primary key is `(source_name, ticket_identity)`, the fetch writes it, the mute
  and the source's removal write it, and its columns are the source's -
  `source_kind`, `external_key`, `source_state`, `url`, `title`, `labels_json`,
  the repository reference, and `attributes_json` - read beside the source's
  health and mute. The Source fact aggregate is the module that writes the
  listing, so it is the module that owns it; putting the table under the Ticket
  work cycle would move the fetch's write and the mute's write into the cycle
  module and split one fact's writes across two. The Ticket work cycle reads the
  listing through the source fact aggregate's named batch operation
  `membershipsForTickets`, and the source fact aggregate answers the one title a
  Ticket's Agent name comes from - `newestMembershipTitle` for one Ticket and
  `newestMembershipTitlesFor` for a list - which is the narrow operation this ADR
  asks a cross-aggregate call to be.
- **The composition is built as a whole.** `graph.ts` assembles the nine modules
  in one typed object, and each module takes a thunk that answers the finished
  graph. The first cut cast an empty object into the graph type; a missing
  aggregate could not fail the build. The check reads the construction and fails
  on a cast.
- **An interface method is either a caller's answer or the aggregate's test
  surface.** Every method an aggregate's interface declares is reached - by a
  caller in the plane, by another aggregate across the boundary, or by the
  aggregate's own tests. A method no caller and no test reaches is neither, and
  the check refuses it (issue #202 review). The list of methods with no caller in
  the plane is written in the check, so a new one has to be named there before it
  can stand in an interface.
- **A method that only restates another answer is not an answer.** The #202 review
  named five interface methods that answered a fact the same interface already
  answers, and they are off the interfaces: `consultationRecord.pendingConsultationResponse`
  (the stored record's own `pendingResponse`), `handoff.leftoverEnvironments` (the
  batched `leftoverEnvironmentsFor` and the one-row `leftoverEnvironment`),
  `ticketWorkCycle.ticketObligation` (the ignore write's refusal carries the
  obligation), `ticketWorkCycle.visibleTickets` (a wrapper over
  `ticketListViews(...).rows`), and `planeAction.planeActionAttempts` (the newest
  attempt and the count are what the plane reads). Three of them - the pending
  Response read, the leftover rows for a list, and the obligation - are called
  only inside their own aggregate and are `private` on the class. The Work queue's
  third enqueue operation, `enqueueConsultationWork`, is gone: the Consultation
  record's own schedule path owns the one Consultation enqueue, and a second
  operation that opened its own transaction could not be called across the
  boundary from inside that schedule anyway. One method keeps its place with no
  caller in the plane: `ticketWorkCycle.ignoredTickets`, the ledger of Tickets the
  operator put away, which no other operation answers as a set.
- **A method pulled out of an aggregate as a value is refused where it happens.**
  The call rules read `.<aggregate>.<method>(`; a method that leaves the aggregate
  as a value - a destructured entry, a `.bind`, a method handed to a function -
  leaves no call behind for them to see. The check refuses the pull itself, at the
  line that makes it (issue #202 review). The limit of the rule is the limit of
  reading source text: it refuses a name that stands for an aggregate's interface
  and a method that leaves an aggregate, and it cannot see a caller that builds
  its own structurally identical interface and calls that. That caller is not
  reaching across the boundary - it is reaching through a copy of the aggregate's
  answer the compiler typed by shape, and no text rule can tell the two apart.
- **The architecture test stays out of the mutation campaign**, beside the shared
  control architecture test, for the same reason: it reads production source as
  text, and instrumentation rewrites exactly the shapes it counts.

## Consequences

- A caller names the aggregate it reads. `test/state-architecture.test.ts` fails
  a file that reaches `state.handoff.…` without naming `HandoffAggregate`, a file
  that reaches the whole composition instead of an aggregate interface, and a file
  that holds an aggregate under another name.
  `src/startup.ts` is the one caller allowed to hold the composition, because it
  is the open path.
- A method that stands in an aggregate's interface has to be reached, and it has
  to answer something no other method answers. A new interface method no caller
  and no test reaches goes red, and a new method with no caller but a test has to
  be written into the recorded list first. A method that only restates another
  answer on the same interface is plumbing with a name, and it goes on the class
  as `private` or it goes away.
- Adding a fact means deciding its owner before writing a query, and adding a
  table means naming its owner in `tables.ts`. A table no aggregate claims fails
  the ownership check.
- A read that needs a fact from another aggregate goes through that aggregate's
  batch operation. A per-row lookup in a loop over the visible list is a
  regression the read test catches. The seat count the Parallel limit reads is
  one such read: the app shell takes the in-flight Tickets and their Agent names
  in two batched reads - `agentNamesForTickets` on the Ticket work cycle
  aggregate, measured at four statements for a file of 300 Tickets where the
  per-Ticket lookup it replaces ran two per row.
- A rule the plane states in words is a function that takes its facts as data,
  so its test states the facts and opens no state file (issue #202, user story
  23). The Parallel limit cap gate is `overParallelLimit(limit, seatCount)` in
  `src/parallel.ts`, where the force-dispatch's three sites and the mode line's
  start-now each restated `limit > 0 && count >= limit`. The Dispatch pause and
  the Same-type hold are `dispatchPauseHolds` and `sameTypeHoldHolds` in
  `src/domain/ticket.ts`, over the completion trace order and the cycle end; the
  Ticket work cycle aggregate reads the two facts and calls the rule, so the
  derived fact stays derived. The Handoff limit gate is
  `handoffLimitReached(handoffCount, limit)` in the same file, where seven sites
  - six in the observation loop and one on the Handoff panel - each restated
  `ticket.handoffCount >= config.maxHandoffsPerTicket`; `test/top-up.test.ts`
  refuses a surface that writes the comparison again (issue #202 review). The auto
  top-up's gates are `topUpCycleOpen`, `refiredRoute`, `refiredPositionStands`,
  `restartCandidateHolds`, `openTicketRowGate`, and `openTicketWaitsHold` in
  `src/domain/top-up.ts`. The observation loop keeps the walk, because the add the
  walk makes is a call to the dispatch, and keeps the reads, so a row an earlier
  wait holds out costs no statement; the rules answer (issue #202 review).
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
