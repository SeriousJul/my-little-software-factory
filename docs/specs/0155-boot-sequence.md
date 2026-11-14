# 0155 - The boot-sequence module owns the plane's boot order and its teardown

## Problem Statement

The order the plane's boot runs is not a fact the plane owns: it is the
declaration order of the shell's hook chain. ADR 0154 named the order the plane
runs - the state's boot read, the sources' first reads, the initial load's
settle, the first herdr probe on the settle, and the polling schedule behind
it - and it named its own limit: it does not move the mounts. The sequence's
steps stand as separate stages in the shell's chain, one each, in the chain's
order, and a stage inserted into the chain reorders the boot, with the reorder
landing before the first frame shows it. The teardown's reverse order lives in
a separate registration the shell keeps in agreement with the start order by
hand, and the entry, the frame rig, and the shell each carry a fragment of the
order's knowledge: the policy they name, the handle they hold, and the settle
they drive.

The operator launches the plane and cannot tell that the order the boot runs
is the order the shell's stages happen to declare: the order is not in the
frame, so a boot that runs its steps out of order can paint frames that look
right. The test cannot pin the order where it lives: it can only pin it
through the shell, and the shell's chain is not a seam the order stands on, so
an order the frame cannot show is pinned, or not pinned, through the paint.

## Solution

The boot-sequence module owns the plane's boot order and the teardown that
reverses it. The shell calls the module once at mount: the module takes the
Plane boot record, the loop policy, and the shell's report sinks, and it runs
the sequence - the state's boot read, the sources' first reads under the
policy's arm, the list's one move on the initial load's settle, the first
Observation cycle on the settle, and the polling schedule behind it - and it
gives back the one teardown that reverses the start, which the shell registers
as the run's stop. The shell keeps the paint, the keys, and the screen stack.
The entry and the frame rig stand on the same face they stand on today: the
record, the policy, and the handle.

The order becomes the module's depth: the interface is the record, the policy,
and the sinks in, and the ordered start and its reverse out, and the test pins
the sequence and its reverse at the module's seam without a process, a
terminal, or a state file. The deepening moves the order into the module, and
nothing it owns changes: the operator's launch runs the same settled order,
and the machine runs the same loops and the same stops.

## User Stories

1. As an operator, I want the order my launch runs to be a fact the plane
   owns, so that the boot I depend on is the boot the plane is tested on.
2. As an operator, I want the ticket list to stand on the state's boot read
   before the plane reads the sources or probes herdr, so that the first list
   I read is the record the run booted from.
3. As an operator, I want the ticket list to move once, on the initial
   load's settle, so that the order I read is the settled order, not a partial
   snapshot of a load still running.
4. As an operator, I want the plane's first probe of herdr to land on the
   roster the settled sources make, so that an agent I started this run is not
   read Missing before the plane ever looked for it.
5. As an operator, I want a shutdown to reverse the boot the way it ran, so
   that no loop writes the state after the state file closes.
6. As an operator, I want a held run to boot the state and the sources'
   one-shot read and to start no Observation loop, so that the run I hold
   settles its load and stops without polling.
7. As an operator, I want a reorganization of the plane's stages not to change
   the order my launch runs, so that the boot I depend on does not move when
   the shell is reworked.
8. As an operator, I want the live plane and the plane the frame rig drives to
   run the same sequence, so that what is tested is what I run.
9. As an operator, I want the loop policy to change only which loops the boot
   starts, so that a held boot and a polling boot differ in their loops, not
   in their order.
10. As the machine, I want one module to own the boot sequence and its
    reverse, so that the order is my implementation, not my caller's
    declaration order.
11. As the machine, I want my interface to take the Plane boot record, the
    loop policy, and the shell's report sinks, and to give back the ordered
    start and the one teardown, so that the shell, the entry, and the frame
    rig stand on the same small face.
12. As the machine, I want the held loop policy to be a branch inside my
    sequence, so that the Seeded plane and the live plane run the same
    sequence with two arms: the one-shot boot read with no Observation loop,
    or the sources' first reads and the polling schedule.
13. As the machine, I want the initial-load-settled fact to stand inside my
    sequence between the sources' first reads and the first Observation
    cycle, so that the one gate between them stands in the one place that owns
    the sequence.
14. As the machine, I want the list's one move to stand on the settle from the
    state that stands, so that I pay the list's price once, and no per-settle
    move runs while the load stands.
15. As the machine, I want my teardown to stop the Observation coordinator and
    the refresh coordinator, then the Handoff dispatch and the Consultation
    operations, before the state file closes, so that no settlement lands on a
    closed state.
16. As the machine, I want the Startup grace and the Agent wait to stand
    inside the Observation cycle I start, so that I decide when the loop
    starts, and the cycle keeps its grace window and its wake.
17. As the machine, I want the paint, the keys, and the screen stack to stay
    out of my sequence, so that I stand the facts the shell paints, and never
    paint.
18. As the machine, I want the shell to call me once at mount and keep the
    sinks I report to, so that my effects stand on the record, and the paint
    stands on my sinks.
19. As the machine, I want my interface to be small and my sequence to be deep,
    so that the callers see the face and never the order, and a change to the
    order is a change to me, not to my callers.
20. As the test suite, I want a seam on the module's interface: the boot
    record and the loop policy in, the ordered effects and the teardown out, so
    that I can pin the sequence and its reverse without a process, a terminal,
    or a state file.
21. As the test suite, I want to pin the sequence's order: the state's boot
    read before the sources' first reads, the first Observation cycle on the
    settle, the polling schedule behind the first cycle, so that a step that
    runs early is caught.
22. As the test suite, I want to pin the teardown's reverse: the loops stop,
    the dispatch operations stop behind them, and a second stop changes
    nothing, so that a stop that lands out of order is caught.
23. As the test suite, I want to pin the held policy's branch: no Observation
    loop, the one-shot boot read, and the load's settle on the last source's
    first fetch, so that a branch that drifts from the owned sequence is
    caught.
24. As the test suite, I want to read the order as a value: the effects the
    module ran, in order, beside the teardown that reverses them, so that the
    sequence is a fact I assert, not a timing I watch.
25. As the test suite, I want the seeded-plane frame suites, through the frame
    rig, to pin the painted plane's order: the list stands on the boot read
    until the settle and moves once after, and the first probe lands after the
    sources' boot reads in the runner's command list, so that an order the
    frame cannot show is pinned where the frame can.
26. As the test suite, I want the refresh coordinator's suite to stand its
    initial-load-settled fact on the owned sequence, so that a gate the
    sequence does not wait on is caught.
27. As the test suite, I want the Observation suite's pins over the pinned
    clock to stand the first cycle on the settle, so that a first cycle that
    runs on a partial snapshot is caught.
28. As the test suite, I want the frame rig's named operations to keep their
    meaning on the owned sequence: the settle of the sources, the key it
    presses, the frame it reads, so that the rig's pins stand on the module's
    order without the rig knowing it.
29. As the test suite, I want the deletion test to hold: with the module
    removed, the order's knowledge scatters across the shell's hook chain, the
    entry's shutdown wiring, and the rig's policy naming, and no seam pins the
    order, so that the module is the one place the order can be pinned.

## Implementation Decisions

**The boot-sequence module.** The module's interface takes the Plane boot
record, the loop policy, and the shell's report sinks: the writes that stand
the ticket list, the consultation list, the queue pause, and the message and
status lines the loops report onto. It takes the shell's dispatch operations,
the Handoff dispatch and the Consultation operations, whose stops the teardown
runs. It gives back the ordered start and the one teardown that reverses it.
The module owns the sequence in full: it stands the ticket list, the
consultations, and the queue pause on the state's boot read, it starts the
refresh coordinator - the one-shot boot read under the held policy, and the
sources' first reads plus the polling schedule under the others - it runs the
list's one move and the first Observation cycle on the initial-load-settled
fact, and it arms the polling schedule behind the first cycle. The teardown
reverses the start: the Observation coordinator stops, the refresh coordinator
stops, its initial-load-settled fact resolving on the stop, and the Handoff
dispatch and the Consultation operations stop behind them, in the one order
the module fixes, before the state file closes.

**The shell calls the module once.** The shell's stages keep the paint, the
keys, and the screen stack, and they stand the report sinks the module reports
to. The shell calls the module once at mount, and it registers the module's
teardown as the run's stop, the same handle the entry's shutdown installer
reads on every ending that closes the state. The stages that carry the
sequence's steps leave the sequence's order to the module: they keep the facts
the sequence stands, and the module stands them in the order it owns.

**The entry and the frame rig stand on the same face.** The entry keeps naming
the production loop policy and holding the handle: the deepening changes what
the handle stands on, not the handle. The Seeded plane of the frame rig keeps
naming the held policy, or the polled policy where the test names an interval,
and the rig's named operations - the settle of the sources, the key it presses,
the frame it reads - stand on the sequence the module owns. Under the held
policy the Seeded plane runs the sequence's held branch: the boot read, the
one-shot boot read, the settle, and no Observation loop, the way the live
plane runs the sequence's polling arm.

**The correction paths stand inside the cycle.** The Startup grace, the Agent
wait of ADR 0084, and the polling interval the Observation coordinator derives
from the config stand inside the Observation cycle the module starts. The
module decides when the loop starts; the cycle keeps its rules. The module's
sequence holds no grace window, no wake, and no interval: it names the steps,
and the step it starts with its rules is the Observation coordinator.

**The module is deep.** The interface is small: the record, the policy, and
the sinks in, and the ordered start and the one teardown out. The sequence,
its policy branches, and its corrections - the held branch that starts no
Observation loop, the settle's one list move, the teardown's reverse - are the
module's implementation, and the callers see the face, never the order. The
module gives the order the locality the chain does not, and the test the
leverage the chain does not: one seam to pin it at, and one place a change to
it lands. The deletion test says the module is where the order belongs: with
it removed, the order's knowledge reappears across the shell's hook chain,
where the declaration order of separate stages fixes the start and a separate
registration fixes the stop, the entry's shutdown wiring, where the handle
must be re-derived, and the frame rig's policy naming, where the plane
re-derives which loops stand, and no seam can pin the order, because the order
is not in the frame. The module re-gathers it in one place with a seam the
test can stand on.

## Testing Decisions

The seams the tests stand on are the module's own interface and the three
suites that already pin the sequence's behavior at their ends.

The boot-sequence module's suite pins the sequence at the module's interface:
the Plane boot record and the loop policy in, the ordered effects and the
teardown out. The suite reads the order as a value, the way the startup
module's suite reads the boot decisions the startup module returns: no
process, no terminal, no state file. It pins the sequence's order - the
state's boot read before the sources' first reads, the first Observation cycle
on the settle, the polling schedule behind the first cycle - and the
teardown's reverse - the loops stop, the dispatch operations stop behind them,
and a second stop changes nothing. It pins the held policy's branch: no
Observation loop, the one-shot boot read, and the load's settle on the last
source's first fetch, so the Seeded plane's branch stays the live plane's
branch under a different policy.

The seeded-plane frame suites, through the frame rig, pin the painted plane's
order. The rig boots the real shell on the Seeded plane, settles the sources
through its named operation, and reads the painted frames and the runner's
command list. The pins that stand on the owned sequence: the painted ticket
list stands on the state's boot read until the settle and moves exactly once
after it, and the first herdr probe lands after the sources' boot reads in the
command list, not before them. The rig's named operations keep their meaning:
the settle of the sources, the key it presses, the frame it read, all standing
on the sequence the module owns.

The refresh coordinator's suite stands its initial-load-settled fact on the
owned sequence: the fact resolves when every configured source's first fetch
settles, it resolves on the coordinator's stop, and a failed first fetch
settles it the way a successful one does. The Observation suite's pins over
the pinned clock stand the first cycle on the settle: the grace's pins and the
Missing marker's pins stand unchanged, and the first probe lands on the settled
roster.

## Out of Scope

- The startup module's boot order, ADR 0010: the config's load and
  validation, the Agent host's resolution, the model list check, and the
  state's open. The entry runs those before the shell mounts, and the record
  owns the sequence that starts where the record stands.
- ADR 0154's mechanism: the initial-load-settled fact, the held first probe,
  and the list's one move. This record owns who runs the order; it changes
  none of the steps' behavior.
- The Observation cycle's own machinery: the probe and its period, the one
  report, the Startup grace, and the Agent wait. The module starts the cycle's
  loop; the cycle keeps its rules.
- The frame rig's owned surfaces and its named operations: the rig keeps
  driving the shell and reading the painted frames. The deepening moves the
  order the rig pins, not the rig's face.
- The entry's argument handling and the shutdown installer's rule of which
  endings close the state: the entry keeps naming the policy, holding the
  handle, and wiring the installer. The record changes what the handle stands
  on, not the handle.
- The loop policy's set: production, held, and polled. The record takes the
  policy as it stands, and the module's branches are the policy's arms.
- The paint, the keys, and the screen stack: the shell keeps them, and the
  module reports to the shell's sinks without painting.

## Further Notes

**The deletion test, in one precise paragraph.** Delete the boot-sequence
module and the plane keeps working: the shell's stages re-run the sequence's
steps in the chain's order, the teardown's registration re-stops the loops in
the hand-kept reverse order, and the entry and the rig keep naming the policy
and holding the handle. What the deletion shows is that the order's knowledge
scatters: it stands in the chain's declaration order, in a separate teardown
registration, in the entry's shutdown wiring, and in the rig's policy naming,
and none of those places is a seam the test can stand on, because none of them
exposes the order as a fact - the chain exposes paint, the registration
exposes stops, and the callers expose their policies. The module re-gathers
the knowledge in one place whose interface is the order in and the order out,
and that is the whole of the deepening: the plane's behavior at boot and at
shutdown does not move, and the order goes from being the shell's accident to
being the machine's fact.

**Why the shell keeps the sinks the module reports to, in one precise
paragraph.** The boot-sequence module stands the facts: the ticket list, the
consultations, the queue pause, the message and status lines. The shell
paints from those facts, and it owns the paint, the keys, and the screen stack
- the module's interface takes the writes and gives back the start and the
stop, so the module cannot reach a pane or a key, and the shell cannot reach a
loop or a probe. The division follows what each side is: the module is the
sequence, and it reports through the sinks because a sequence that painted
would own the screen, and the shell is the screen, and it calls the sequence
once because a screen that owned the order would be back to fixing the boot
by its own declaration order. The frame rig's Seeded plane stands on the same
division: it drives the shell, the shell calls the module, and the rig's
named operations settle, press, and read around the sequence they never own.
