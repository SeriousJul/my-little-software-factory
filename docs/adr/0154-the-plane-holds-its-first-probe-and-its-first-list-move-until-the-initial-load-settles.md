# ADR 0154: The plane holds its first probe and its first list move until the initial load settles

Status: accepted
Date: 2026-11-14

Records that the refresh coordinator gains the fact that the plane's initial
load has settled, the promise that resolves when every configured source's
first fetch has settled, success or failure, and that the plane stands on that
fact: the shell holds the ticket list on the state's boot read until the fact
resolves and replaces it once, from the state that stands when the load
settles, and the Observation coordinator holds its first cycle, the first
herdr probe, until the fact resolves, so the first probe lands after every
source's first fetch and the ticket list moves once, not once per settled
source.

## Context

The operator launches the plane, and the plane boots from its Plane boot
record: the state it read on the last run, and the sources it has been told to
read. The state carries a ticket list, and the sources carry more, and the two
are joined when the sources answer. The shell mounts in a fixed order. The
Observation coordinator starts first, and its start runs one Observation cycle
at once, so the first herdr probe fires immediately, before any source has
answered. The boot read then stands the ticket list from the state, and the
refresh coordinator starts: under the held loop policy it takes the one-shot
boot read, and otherwise it stands the refresh schedule. Either way the first
read of every source runs now.

Every source's first fetch settles on its own time, and each settled fetch
applies its result and fires the callback. Today the callback replaces the
ticket list and the consultations and ticks the Observation coordinator, and
the tick runs a full cycle: a herdr probe and a dispatch. So during the
initial load the list is replaced once per settled source, on a partial
snapshot, and the list rule of ADR 0042 re-orders the rows on every
replacement: the rows the operator sees at launch jump around as the sources
answer one after another. That is issue #347. And each of those per-settlement
ticks runs a herdr probe and a dispatch on the partial snapshot, so the plane
probes herdr and starts its dispatch before the load it is acting on has
settled.

The first herdr probe, the one the Observation coordinator ran at start, lands
while the load is still standing. On the herdr-core host a just-started agent
is not in the roster herdr lists until the desktop's start has landed in it.
The first probe can read that roster and find no agent where the state says a
ticket is in flight, and the ticket's row reads a Missing agent. The Startup
grace suppresses the restart the missing fact would earn, but nothing
suppresses the display: the missing marker stands until the next probe
answers, which is a full poll period later. That is issue #388.

The refresh coordinator has no fact that says the initial load has settled.
Its start and its one-shot boot read fire the first reads, and each settled
fetch applies on its own and fires the callback on its own, so the moment when
every configured source's first fetch is done is not expressed anywhere. The
shell and the Observation coordinator each see a stream of per-source
settlements and cannot tell the last first fetch from a later one. The
coordinator has no depth for the moment its load is done, and the two callers
that need that moment guess at it: the shell guesses per source, and the
Observation coordinator guesses at boot.

The held loop policy stands: ADR 0129's seeded plane takes the one-shot boot
read, and this decision names the order its fields only implied - the boot
read settles before the first probe, and the list moves once, when the load
settles, not per source. ADR 0146's one report stands beside it: the
Observation cycle still sends one report whose identity carries its change,
and holding the first probe and the per-settlement ticks means fewer cycles at
boot and no report on the settlements the load suppresses. The sibling
deepening that moves the boot order into its own module is a separate record;
this decision names the order the shell already runs, and it does not move the
mounts.

## Decision

The refresh coordinator gains the initial-load-settled fact, and the plane
stands on it.

- The fact is the promise that resolves when every configured source's first
  fetch has settled. The initial load is the plane's first read of every
  source it has been told to read, the fetches that stand on the Plane boot
  record. A settlement is the fetch's promise resolving, success or failure,
  and the per-source settlement running: the result is applied to the source
  fact, the callback fires, and the source's next read is scheduled where the
  policy stands one. The coordinator owns the fact: it begins with the set of
  its configured sources, and each source's first settlement marks that source
  done, and the last to mark resolves the promise. The fact is named for the
  load, not for the sources: it is the fact that the load has settled, and the
  shell and the Observation coordinator wait on that one promise instead of
  guessing from a stream of per-source settlements.

- A failed first fetch settles the load: the fetch's promise resolves with the
  failed outcome, the source records its failed read, the callback fires with
  the failed outcome, and the load advances. So a source that fails its boot
  read does not hold the first probe or the first list move open, and the boot
  does not hang on a source that will not answer: today a failed boot read
  fires the callback and stands no timer behind it, and this decision keeps
  that, with the settlement advancing the load instead of replacing the list
  per source. The fact also resolves when the coordinator stops: a shutdown
  does not wait on a load the plane is abandoning, and the held cycle and the
  held list move stand down on the stop, as they stand down on any stop.

- The shell holds the ticket list on the state's boot read until the fact
  resolves. While the load stands, no settled source fetch replaces the list
  or the consultations, and no settled fetch ticks the Observation
  coordinator: the per-settlement replacement and the per-settlement tick the
  callback runs today are suppressed while the load stands. When the fact
  resolves, the shell replaces the ticket list once, from the state that stands
  then: the tickets the sources that answered carry, joined with the tickets
  the state held, and the consultations beside them, the sources that failed
  recorded as the state stands. The operator's view between boot and settle
  stands on the boot read, and it moves once, when the load settles.

- The Observation coordinator holds its first cycle until the fact resolves.
  Its start runs no cycle while the load stands, and the cycle it runs when the
  load settles is the first herdr probe: it reads the roster the sources that
  answered make, and the just-started agent the desktop added is far likelier
  to be in it. A tick that lands while the load stands runs no cycle of its
  own: it marks a cycle owed, and the one held cycle, when the load settles,
  does that work on the state that stands then. The polling schedule start
  stands behind the first cycle, and it arms only after that cycle runs, on the
  settle.

- The held loop policy keeps its start: the seeded plane of ADR 0129 takes the
  one-shot boot read, and the one-shot read settles the load the same way the
  polling schedule does, each stub source's first fetch settling and the last
  resolving the fact. The frame rig settles the load the same way the plane
  settles it: its stub sources settle, and the first probe runs on the settle.
  The rig's named operation that settles the sources is the pin of the held
  probe and the held list, and it drives the same order the live plane runs.

## Considered options

- Run the first probe first and replace the list once per settled source
  (status quo): the probe lands while the roster is still empty and the list
  moves once per source, so the operator sees the list jump at launch and the
  just-started agent read missing for a full poll period. The probe and the
  load keep racing, and every source that answers after the probe re-opens the
  race on the cycle its tick runs.
- Suppress the displayed missing state while the load stands, without holding
  the probe: the row keeps its Starting face while the load stands, and the
  missing marker is withheld until the load settles. It loses because it hides
  the display without moving the probe, so the first probe still lands on an
  empty roster and still runs the cycle's dispatch on a partial snapshot, and
  the operator is protected from the marker for one window while the cycle the
  probe already ran shows the missing row and the restart the grace held on the
  next. The probe and the load still race, and the fix is a filter on the
  symptom, not the ordering that caused it.
- Lengthen the Startup grace so the first probe lands inside it: the marker
  does not appear until the grace runs out, so a longer grace hides the missing
  row longer. It loses because the grace is measured from the handoff, and the
  handoff on a boot the machine just made is old enough that a longer grace
  hides a genuinely dead agent, not just a booting one: the grace protects a
  start the plane made this run, and lengthening it trades a false missing for
  a false alive, and it does nothing for the list that still re-orders once per
  settled source.

## Consequences

- The operator sees the ticket list stand still at launch: it holds the state's
  boot read until the sources settle, and it moves once, to the settled order,
  when the load settles. A start the operator made this run reads as its state,
  not missing, for the window between boot and settle, and the Missing marker
  appears only when a probe answers that the agent is gone past the grace.
- The machine: the first herdr probe lands after the load settles, on the
  roster the settled sources make, so it is far likelier to see the
  just-started agent and to run the cycle's dispatch on the state the sources
  stand on, not a partial one. The Startup grace, the next period, and the
  Agent wait still correct a genuinely missing agent: the first probe is later
  and likelier to be right, and the correction paths stand behind it. The
  cycle's cost at boot is lower: one probe on the settled load, not one per
  settled source, and no dispatch on a partial snapshot.
- The test: the refresh coordinator's suite pins the initial-load-settled
  fact, that it resolves when every source's first fetch settles and a failed
  first fetch settles it the way the decision names; the observation suite,
  with its per-command pins over the pinned clock, pins the correction, a stub
  world whose first roster read lacks a just-started agent and whose next read
  sees it, where the missing display corrects without a restart, the grace pins
  standing, and the correction lands on the probe that sees the agent; the
  seeded-plane frame suites pin the window, the painted list standing on the
  boot read until the load settles and moving exactly once after, the fake
  runner's command list showing the first herdr probe after the sources' boot
  reads, and the in-flight ticket wearing its state face in the window with no
  Missing marker.
- The glossary gains the initial load and the fact that it has settled. These
  records land with the implementation, not with this ADR.
- The sibling deepening that moves the boot order into its own module, the
  probe's own cost and schedule, and the settlement's own shape are separate
  records: this decision names the order the shell already runs and holds the
  two moments it stands on, and it moves neither the probe nor the settlement
  nor the mounts.
