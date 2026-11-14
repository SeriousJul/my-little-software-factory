# ADR 0153: The settled turn's fire refreshes the ticket's own pull request sources, and the settling tickets settle side by side

Status: accepted
Date: 2026-11-14

Records that the settled turn's fire refreshes only the pull request sources
that list the ticket: the plane binds the refresh the fire awaits before it
reads the projection and writes its position to the ticket's own pull
request sources, read from the same source membership fact the cycle end's
re-read asks, instead of to every pull request source in the config; and
that the in-flight walk of the Observation cycle settles the tickets that
settle in one cycle side by side, starting the settlement chain of every
ticket that settles and joining the chains, so a cycle that settles K
tickets pays one fetch per source the settling tickets list, and each state
write a settlement makes commits its own write transaction under the store's
one-transaction rule.

## Context

The operator runs the plane with several agents working, and on the cycles
where several of those agents finish at once the plane closes the turns out
in the in-flight walk of the Observation cycle. The closeout of a completed
turn is the fire of the turn's transition: the fire refreshes the pull
request sources, reads the projection, judges the transition, writes the
label facts, and derives the position the ticket moves to. The refresh
stands first in the fire, before its stop check and its reads, because the
position the fire writes stands on a fixing pull request that must be
listable before the write (ADR 0079): the agent's new pull request must be
in the list before the fire can find it. Today the plane binds that refresh
to every pull request source in the config.

The binding walks the pull request sources one at a time, awaiting one
source's refresh before it starts the next, and a source's refresh is a
fetch that walks its search queries page by page, one subprocess per page,
over the repositories the source covers. The fire on one ticket in one
repository pays, on top of the refresh of the sources that list the ticket,
a refresh of every other pull request source in the config, page by page,
for the sources that list nothing the fire is about. The operator feels it
on the cycles where several turns settle at once: the completed turns sit
unrecorded while the refreshes run, and the machine's work on the last
ticket to settle waits behind the refresh sweeps of the tickets ahead of
it.

The in-flight walk serializes the closeouts. It reads one ticket's turn
end, settles the turn the read shows, awaits the settle's fire and the
fire's full refresh, and only then reads the next ticket's turn end. K
tickets that settle in one cycle pay K sequential unscoped refreshes, and
the walk returns to the cycle only when the last of them settles, so the
cycle's later steps - the resume of the awaiting tickets, the re-fire
sweep, the awaiting close, the Work queue's Pickup, and the top-up - run
behind the queue of sweeps.

The scope the refresh needs is already answered on the state side. When a
ticket's cycle ends, the plane re-reads the sources that list the ticket
and no others: it asks the source membership fact which sources list the
ticket, and re-reads those. The fire's refresh needs the same membership,
narrowed to the pull request sources: a source's fetch covers the
repositories the source lists, and the sources that list a ticket are the
sources whose rows the fire reads the ticket from, so a refresh of the
sources that list the ticket refreshes what the fire reads. The unscoped
refresh pays, on top of those sources, for every pull request source the
membership fact does not name.

The deepening that runs the settlements side by side stands on a rule the
state file already keeps. The store holds at most one open write
transaction: a write opens its transaction, commits it, and a second write
that starts while one stands is refused by name. Every state write a
settlement makes - the fire's convergence of the labels it wrote, the
settle's write of the turn - is one such transaction, and it opens and
commits without crossing an await, so two settlements that run side by side
take the file's write in turn and cannot corrupt each other's writes. The
label facts a fire writes are convergent: a second fire on the same labels
writes nothing, the way the fire already stands for the re-fire and the
crash-restart of a blocked merge. The refresh coordinator stands beside the
store: a refresh of a source that is already fetching joins the fetch's
settlement, so two fires that refresh one source pay one fetch for it.

## Decision

- The fire's refresh asks the ticket's own pull request sources. The plane
  binds the refresh it hands the fire to the ticket's scope: at the moment
  the refresh runs, it reads the source membership fact - the same fact the
  cycle end's re-read asks - keeps the sources whose kind is a pull request
  source, and refreshes exactly those through the refresh coordinator,
  awaiting the refresh of each the way the unscoped refresh awaits the
  source it refreshes. A ticket that lists a pull request source refreshes
  those sources, never fewer: the fire still refreshes the ticket's own
  pull request source before it writes the position, and ADR 0079's pin
  stands on the scoped refresh. A ticket whose sources list no pull request
  refreshes none, and stands on the projection the scheduled refresh has
  landed, the answer the fire already gives when the config lists no pull
  request source.

- The refresh seam of the fire request keeps its shape. The fire awaits the
  refresh the plane hands it, first in the fire, before its stop check and
  its reads, and the deepening narrows the plane's binding, not the fire's
  request: from every pull request source in the config to the ticket's own
  pull request sources. Every fire the plane runs carries the scope: the
  settle-time fire carries the ticket the turn settled on, the operator's
  manual re-fire carries the ticket the operator named, and the re-fire
  sweep's per-skip fire carries the ticket the skip records, so a sweep
  over several skips refreshes the union of the skips' own sources. The
  plane action's fire runs no refresh and is unchanged.

- The in-flight walk settles the settling tickets side by side. The walk
  starts the settlement chain of every ticket that settles - the read of
  the turn's end, the settle, and the fire the settle takes on a completed
  turn - and joins the chains, instead of awaiting one chain before it
  reads the next ticket's turn end. The walk returns when the last chain
  settles, so the cycle's later steps run on the state every settlement has
  written, in the order they run today.

- The state file keeps its one-transaction rule under the side-by-side
  settlements: each state write a settlement makes opens and commits its
  own write transaction, the writes take the file's one open write
  transaction in turn, and the writes never span the awaits the
  settlements take, so the side-by-side fires interleave between their
  transactions and commit the same facts the sequential walk commits.

## Considered options

- Keep the unscoped sequential refresh (status quo): every fire pays a sweep
  of every pull request source in the config, and the walk pays the sweeps
  one after another, so a cycle where K tickets settle pays K full sweeps in
  series, and the completed turns wait behind refreshes of the sources no
  settling ticket lists.
- Scope the refresh and keep the sequential walk: each fire pays less, but
  the walk still closes the settling tickets out one by one, and the last
  ticket's position still waits behind the refreshes of the tickets ahead of
  it; the queue of closeouts the operator watches standing is the queue the
  walk keeps.
- Settle side by side and keep the unscoped refresh: the fires overlap, and
  the coordinator's join saves one fetch per source two fires share, but
  every fire still sweeps every pull request source in the config, so the
  machine pays the full sweep once per settling ticket, at once instead of
  in series; the cost the machine owes sits in what each fire refreshes,
  not in the order the fires run.

## Consequences

- The operator sees no change in what the plane records: the same label
  facts, the same positions, the same recorded skips, and the same re-fires
  stand on the same lines. The operator feels the change in time: a cycle
  where several turns settle records them when the last settlement settles,
  instead of one per refresh sweep, and a completed turn in a repository one
  source lists stops waiting on the sweeps of the sources that list nothing
  the turn did.
- The machine: the fire's refresh cost scales with the sources that list the
  ticket and the pages those sources carry, not with the number of pull
  request sources in the config; the walk's time is bounded by the slowest
  settlement chain of the settling tickets, not by the sum of the chains;
  and two fires that refresh one source pay the coordinator's one fetch for
  it.
- The test: the fire suites, with the fake command runner, pin that a fire
  on a ticket in one pull request source issues fetches only for that
  ticket's own sources, the runner's command list showing no fetch against
  the other pull request sources, and pin the fire's outcome, its label
  writes, its position, and its recorded skip when nothing fixes the
  ticket, exactly as ADR 0027, ADR 0076, and ADR 0079 pin them. The
  coordinator seam suites, with their per-command pins over the virtual
  clock, pin that the tickets that settle in one cycle produce the same
  state writes and the same lines as the sequential walk, and that a slow
  refresh for one ticket does not hold the other tickets' fires. The Stub
  world suites that wire the real fire stand unchanged in their pins.
- The fire on a ticket whose sources list no pull request refreshes no
  source and stands on the projection the scheduled refresh has landed: a
  fire that finds no fixing pull request in that projection records the skip
  it records today, and the re-fire sweep settles the skip when a refresh
  lists the pull request.
- ADR 0151 lands the fire's state reads on the scoped ticket read; this
  record scopes the fire's refresh. Both stand on the same source
  membership fact, and neither re-litigates the other. ADR 0152 shortens the
  herdr-side probe and its period, and it touches no refresh. ADR 0146's
  one report stands: the cycle still sends one report when the cycle ends,
  and the side-by-side walk changes when the report's content settles, not
  what the report carries.
- The glossary gains the fire's refresh scope and the side-by-side
  settlement. These records land with the implementation, not with this
  ADR.
