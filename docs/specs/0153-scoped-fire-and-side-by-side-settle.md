## Problem Statement

The operator runs the plane with several agents working, and on the cycles
where several of those agents finish at once the plane closes the turns out
one by one, and each closeout waits on a refresh of every pull request
source in the config: source by source, page by page, one subprocess per
page, for the sources that list nothing the settling ticket did. The
operator watches the completed turns sit unrecorded while the refreshes
run: the label facts and the position a settled turn owes land one at a
time, each behind a sweep of the pull request sources, and the machine's
work on the last ticket to settle waits behind the refresh sweeps of the
tickets ahead of it. A source that answers slowly holds every settling turn
behind it, and the record states the machine's facts a sweep at a time, in
the order the walk closes the turns out, not in the order the agents
finished.

## Solution

The fire refreshes only the sources that list the ticket, and the settling
tickets settle side by side.

The fire's refresh asks the ticket's own pull request sources - the sources
the ticket's source membership lists, narrowed to the pull request kind,
read from the same source membership fact the cycle end's re-read asks -
and no others. A ticket that lists a pull request source refreshes exactly
those sources before the fire writes its position, the way ADR 0079 pins
the fire, and a ticket that lists none stands on the projection the
scheduled refresh has landed, the answer the fire already gives when the
config lists no pull request source.

The in-flight walk starts the settlement chain of every ticket that settles
in the cycle - the read of the turn's end, the settle, and the fire the
settle takes on a completed turn - and joins the chains, instead of closing
one turn out before it reads the next. The cycle moves on when the last
chain settles, so the tickets that settle in one cycle pay one fetch per
source they list, at once instead of in series. Each state write a
settlement makes commits its own write transaction, and the state file
holds at most one open write transaction, so the side-by-side settlements
take the file's write in turn and write the same facts the sequential walk
writes. Nothing the operator reads changes: the same label facts, the same
positions, the same recorded skips, the same lines.

## User Stories

1. As an operator, I want a completed turn to land its labels and its
   position when the refresh of the sources my ticket lists is done, so
   that the machine's work on my ticket closes out without waiting on the
   refresh of the sources my ticket is not in.
2. As an operator, I want the turns that settle in one cycle to be recorded
   when the last of them settles, so that I see the machine close its work
   out at the pace the slowest source answers, not at the pace of a queue
   of refresh sweeps.
3. As an operator, I want a turn that settles on a ticket in one pull
   request source to pay a refresh of that source alone, so that the
   sweeps of the other pull request sources stop holding the turn's
   position back.
4. As an operator, I want a turn to be recorded when its own refresh
   answers, even while another settling ticket's refresh is still out, so
   that one slow source does not hold the other completed turns.
5. As an operator, I want the same label facts, the same positions, the
   same recorded skips, and the same re-fires on every line the plane
   states, so that this change moves nothing the record says.
6. As an operator, I want a completed turn whose refresh finds no fixing
   pull request to be recorded as the skip, so that I see the machine's
   fact that the pull request is not in the list yet, the way I see it
   today.
7. As an operator, I want a recorded skip to re-fire when a refresh finds
   the fixing pull request, and to land the position the fire derives, so
   that the machine finishes the work the first fire could not.
8. As an operator, I want my re-fire on a settled turn to refresh the
   ticket's own pull request sources and fire the turn's transition on the
   sources as they stand now, so that the re-fire answers from the source
   the settle-time fire reads.
9. As an operator, I want a source that stops answering to stand stale with
   its warning, and the fire on a settled turn to stand on the source's
   last successful snapshot, so that a failed refresh holds the ticket's
   turn back no further than its own warning does.
10. As an operator, I want the Work queue's Pickup and the top-up to run
    after every settling ticket's settlement has written, so that the
    queue's next step reads the state the settlements wrote, in the order I
    read it today.
11. As an operator, I want a stop that lands over a settling turn to close
    the state behind the fire and write nothing after the stop, so that the
    shutdown stays clean while the settling tickets run side by side.
12. As the machine, I want my fire's refresh to ask only the pull request
    sources that list the ticket, so that the refresh I await costs the
    sources the fire reads, not the sources the config happens to list.
13. As the machine, I want to read the fire's scope from the same source
    membership fact the cycle end's re-read asks, so that the fire and the
    cycle end cannot name different sources for the ticket.
14. As the machine, I want a ticket that lists a pull request source to
    refresh that source before the fire writes its position, so that the
    fixing pull request the agent opened is in the list when the fire looks
    for it.
15. As the machine, I want to start the settlement chain of every ticket
    that settles in the cycle at once, and to join the chains, so that the
    walk is as long as the slowest chain, not as long as the sum of them.
16. As the machine, I want each state write my settlement makes to open
    and commit its own write transaction, with the state file holding at
    most one open write transaction, so that a settlement that runs beside
    mine takes the file's write in turn with it.
17. As the machine, I want my writes to open and commit without spanning
    the refresh I await, so that the refresh I take out never holds the
    state file's write.
18. As the machine, I want a refresh of a source my neighboring fire is
    already fetching to join that fetch's settlement, so that the source
    two of us list is fetched once, not twice.
19. As the machine, I want the walk to return only when the last
    settlement chain settles, so that the cycle's later steps read the
    state every settlement wrote, in the order they run today.
20. As the machine, I want a ticket whose sources list no pull request to
    refresh no source and stand on the projection the scheduled refresh has
    landed, so that my fire on it answers the way my fire already answers
    when the config lists no pull request source.
21. As the machine, I want the re-fired skips to pay the scoped refresh the
    settle-time fire pays, so that the sweep's per-skip work stops sweeping
    the sources the skip's ticket does not list.
22. As the test suite, I want a fire on a ticket in one pull request
    source, run over the fake command runner, to issue fetches only for
    that ticket's own sources, so that a fetch against the other pull
    request sources shows up in the runner's command list and fails the
    pin.
23. As the test suite, I want the fire's outcome to stand pinned on the
    scoped refresh: its label writes, its position, and its recorded skip
    when nothing fixes the ticket, so that ADR 0027, ADR 0076, and ADR
    0079 keep their pins on the narrowed refresh.
24. As the test suite, I want a pin that a fire on a ticket that lists a
    pull request source refreshes that source before it writes its
    position, so that the scoped refresh never drops the ticket's own
    source out of the refresh set.
25. As the test suite, I want a pin that a fire on a ticket whose sources
    list no pull request refreshes none, and stands on the projection the
    scheduled refresh has landed, so that the scope's edge answers the way
    the fire already answers on an empty pull request config.
26. As the test suite, I want the tickets that settle in one cycle, driven
    through the real coordinator over the virtual clock, to produce the
    same state writes and the same lines as the sequential walk, so that
    the side-by-side walk records nothing the operator would read
    differently.
27. As the test suite, I want a pin, on the virtual clock, that a slow
    refresh for one settling ticket does not hold the other settling
    tickets' fires: the second fire lands while the first refresh is still
    out, so that a regression to the sequential walk shows up as a line
    that lands late.
28. As the test suite, I want a pin that two settling tickets that list
    the same pull request source run one fetch of it, so that the
    coordinator's one-fetch-per-source rule stands under the side-by-side
    fires.
29. As the test suite, I want the observation suite's per-command pins to
    stand, so that the cycle's lines, holds, and pickups stay exactly what
    the operator reads on the side-by-side walk.
30. As the test suite, I want the Stub world suites that wire the real
    fire to stand unchanged in their pins, so that the fire the standing
    world drives is the scoped fire.
31. As the test suite, I want a pin that a stop over a settling fire closes
    the state behind it and the plane writes nothing after the stop, so
    that the shutdown stays clean on the side-by-side walk, the way the
    sequential one stands today.
32. As the test suite, I want a pin that a cycle where no ticket settles
    takes no fire's refresh, so that a quiet cycle pays the probe and the
    walks and nothing more, the way it does today.

## Implementation Decisions

**The refresh scope the fire carries.** The fire's refresh request keeps
its shape: the fire awaits the refresh the plane hands it, first in the
fire, before its stop check and its reads. The plane's binding narrows:
instead of walking every pull request source in the config and awaiting
each, it reads the ticket's source membership at the moment the refresh
runs, keeps the sources whose kind is a pull request source, and refreshes
exactly those through the refresh coordinator, awaiting the refresh of
each. The scope is read at the moment the refresh runs, so the fire
refreshes the sources that list the ticket when the refresh runs, and the
ticket the fire acts on is the ticket the state names at that moment. A
ticket that lists a pull request source refreshes those sources, never
fewer; a ticket that lists none refreshes none.

**The fires that carry the scope.** The settle-time fire carries the scope
of the ticket the turn settled on. The operator's manual re-fire carries
the scope of the ticket the operator named on the Decision modal's re-fire
row, so the re-fire answers from the sources as they stand now, the way the
settle-time fire does. The re-fire sweep's per-skip fire carries the scope
of the ticket the skip records: a sweep over several skips refreshes the
union of the skips' own sources, not every pull request source per skip.
The plane action's fire runs no refresh and is unchanged.

**The side-by-side walk.** The in-flight walk walks the in-flight tickets
in the order it walks them today, and for each ticket that settles it
starts the ticket's settlement chain - the read of the turn's end, the
settle, and the fire the settle takes on a completed turn - instead of
awaiting the chain before it reads the next ticket. The walk joins the
chains it started and returns when the last of them settles, so the
cycle's later steps - the resume of the awaiting tickets, the re-fire
sweep, the awaiting close, the Work queue's Pickup, and the top-up - run
on the state every settlement has written, in the order they run today. A
chain that settles no ticket - a working report, a turn that ends no turn -
costs the read it takes and nothing more.

**The store's one-transaction rule.** Every state write a settlement makes
opens and commits its own write transaction on the state file, and the
file holds at most one open write transaction: a write that starts while
another stands is refused by name. The writes take the file's write in
turn, and none of them spans an await: the refresh a fire awaits is a fetch
the refresh coordinator owns, and the label facts the fire converges into
the state, and the turn the settle writes, are transactions that open and
commit between the settlement's awaits. Two settlements that run side by
side interleave between their transactions, and because the label facts a
fire writes are convergent - a second fire on the same labels writes
nothing - the side-by-side interleaving commits the same facts the
sequential walk commits, whatever order the transactions take.

**The coordinator's one-fetch rule.** The refresh coordinator keeps one
fetch per source: a refresh of a source that is already fetching joins the
fetch's settlement, so two settling tickets that list the same pull request
source pay one fetch of it. The sources the settling tickets do not share
are fetched at once, one fetch per source, and the walk is as long as the
slowest of the settlement chains it started, not as long as the sum of
them.

**The failure semantics that stand.** A refresh that resolves over a
failed fetch marks the source stale and pins its warning, and the fire
stands on the last successful snapshot the source gave, the way it does
today. A fire whose refresh finds no fixing pull request in the projection
it reads records the skip its transition names, derives no position, and
the re-fire sweep settles the skip when a refresh lists the pull request.
The refresh stands first in the fire, before its stop check and its reads,
so a stop that lands over the refresh closes the state behind the fire,
and the plane writes nothing after the stop, on the side-by-side walk as
on the sequential one.

## Testing Decisions

A good test here establishes the behavior at the two ends of the seam: at
the fire, the refresh it issues and the outcome it lands; at the cycle, the
lines the operator reads and the state the settlements write. No test
reaches inside the plane to check how it binds the refresh or how it joins
the chains; the runner's command list and the state writes are the outside
measurement.

The modules and suites that carry the test:

- The fire suites (test/workflow-transition.test.ts), with the fake command
  runner, pin the scoped refresh at the fire's seam. A fire on a ticket in
  one pull request source issues fetches only for that ticket's own
  sources: the runner's command list shows no fetch against the other pull
  request sources. A fire on a ticket that lists a pull request source
  refreshes it before the fire writes its position, so the ticket's own
  source never leaves the refresh set. A fire on a ticket whose sources
  list no pull request refreshes none, and stands on the projection the
  scheduled refresh has landed. Beside those pins the fire's outcome
  stands: the label writes, the position, and the recorded skip when
  nothing fixes the ticket, and the re-fire of the skip when a refresh
  finds the fixing pull request, exactly as ADR 0027, ADR 0076, and ADR
  0079 pin them.
- The observation suite (test/observation.test.ts), the coordinator seam,
  drives the real coordinator with per-command pins over the virtual clock.
  The tickets that settle in one cycle produce the same state writes and
  the same lines as today's sequential walk: the same settles, the same
  fires, the same label facts, the same positions, the same recorded
  skips. The virtual clock pins the side-by-side order: a slow refresh for
  one ticket does not hold the other tickets' fires, and the second fire
  lands on the clock while the first refresh is still out. A regression to
  the sequential walk shows up as a line that lands late on that clock.
- The Stub world suites of ADR 0132 (test/stub-world.test.ts), which wire
  the real fire into the standing world, stand unchanged in their pins: the
  world the suites stand on drives the scoped fire, and the pins the
  suites keep - the world's lines and the state the fires write - stay
  what they are.

The prior art is the observation suite's existing pattern: the real
coordinator over a virtual clock, a per-command pin on what the cycle does,
and a state pin on what the settlements write. The new pins take that same
shape, and the fire suites take the role the transition suites already play
for the fire's outcome.

## Out of Scope

- The herdr side of the work, the probe the cycle runs and its period: ADR
  0152 shortens both, and it touches no refresh.
- The scoped ticket read: ADR 0151 lands the fire's state reads on it.
  This record scopes the fire's refresh. Both stand on the same source
  membership fact, and neither re-litigates the other.
- The boot's initial load: ADR 0154.
- The refresh schedule's own cadence: the interval the refresh coordinator
  schedules a source's fetch on stands as it stands. This record scopes and
  orders the forced refreshes the fires take, not the schedule that runs
  between the cycles.
- The plane action's fire, which runs no refresh and stands as it stands.
- The order of the cycle's steps: the in-flight walk still runs first, and
  it returns before the cycle's later steps, in the order the Observation
  cycle runs them today.

## Further Notes

**Why the side-by-side settlement is safe.** The state file keeps one rule
the deepening stands on: it holds at most one open write transaction, a
write opens its transaction and commits it, and a second write that starts
while one stands is refused by name. Every state write a settlement makes
takes the rule the same way, and none of the writes spans an await: the
fetch a fire awaits is the refresh coordinator's, not the state file's, and
the transactions the settlement opens - the fire's convergence of the
labels it wrote, the settle's write of the turn and its outcome - open and
commit between the settlement's awaits. So two settlement chains that run
side by side take the file's write in turn, one write at a time, and the
interleaving they commit is an interleaving of whole transactions, never of
the writes inside one. Beside the rule, the facts the writes commit are
convergent: the label facts a fire writes are the facts the transition
named, a second fire on the same labels writes nothing, the fire is
idempotent on the labels it wrote the way it already is for the re-fire and
the crash-restart of a blocked merge, and the two settling tickets that
share a fixing pull request converge the one surface the way the sequential
walk already does, one write behind the other. The tickets that settle in
one cycle write rows of their own, the shared rows carry convergent facts,
and the side-by-side order the chains take changes the time the lines land,
not the facts they state; the cycle still sends its one report at the end
of the cycle, the report of ADR 0146, and the side-by-side walk changes
when the report's content settles, not what it carries.

**What the scope is, exactly.** The fire's refresh asks the ticket's own
sources, read from the source membership fact the cycle end's re-read asks:
the fact answers, for the ticket the fire acts on, the names of the sources
that list it, and the plane's binding keeps of those names the ones whose
source is a pull request source and refreshes exactly the sources it
keeps, through the refresh coordinator, awaiting each. The fact the fire
reads is the fact the cycle end's re-read reads, at the moment the refresh
runs, so the fire and the cycle end cannot name different sources for the
ticket, and ADR 0151's scoped read stands on the same fact beside them,
one read of the state and one re-read of the source from the one
membership. The scope is never zero for a ticket that lists a pull request
source: a ticket that is a pull request is listed by the pull request
source that lists it, and the fire refreshes that source before it writes
the position, so ADR 0079's pin - the fixing pull request listable before
the position write - stands on the scoped refresh. A ticket that is not a
pull request, an issue or an advisory or an alert, lists no pull request
source in its membership, refreshes none, and stands on the projection the
scheduled refresh has landed, the answer the fire already gives when the
config lists no pull request source; a fire on such a ticket that finds no
fixing pull request in that projection records the skip it records today,
and the re-fire sweep settles the skip when a scheduled refresh lists the
pull request.
