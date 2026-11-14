# Spec 0156: The frame rig's waits resolve on the renderer's frame passes

## Problem Statement

The operator reads the plane through the frame suite's verdict: when a suite
is red or slow, the operator re-runs it, and every wait in it spends wall
time on the rig's sampling instead of on the plane under test. The operator
has seen this class before: the twelve flake issues ADR 0128 paid for by
doubling the frame waits' deadline to 20 s were the operator's signal that a
wait could miss the paint it was waiting for.

Every wait the frame rig's named operations stand on resolves on a derived
fact. The settle opens on a 30 ms wall-clock grace and then samples the
renderer's painted buffer every 10 ms, accepting the frame when two
consecutive samples read equal, so a wait on a plane that owes no more paint
costs the grace and two polls on top of the work the plane owed. The frame
waits sample the same buffer on the same tick under the same deadline. The
suite's census counts more than 3,200 wait sites across the frame suites,
and the settle stands behind every key operation of them. The renderer the
plane paints through already holds the facts the rig is sampling for: it
announces each pass it paints, after it has written the buffer, and it
reports its own scheduling state, whether a pass is owed, whether it is
rendering, whether its frame loop is running, on the renderer's public
surface. The rig already intercepts the announcement and re-announces it to
the surfaces that register for the pass. The settle and the frame waits
simply do not stand on the fact.

The machine pays the blindness twice. A poll straddles a paint by a full poll
interval: a paint that lands between two polls is read one interval late, and
a pin that should resolve on the paint resolves on the sample after it. And
the grace is the second payment: because the shadow cannot distinguish "the
plane owes no more paint" from "the paint has not been sampled yet", the rig
waits out wall time before it trusts the buffer, on every wait, not on the
one that needs it. The rig re-derives, by sampling, what the renderer
reports: the wait and the paint never meet, and the seam between them is the
poll.

## Solution

The operator sees the same plane: the decision stands on the test render
site alone. The rig owns the test renderer, and the production entry owns the
production renderer, through the renderer adapter once ADR 0145 lands, and
both stand on the same renderer class, so the facts are one fact. The
machine's waits resolve on the renderer's frame facts. The settle settles the
passive work the renderer owes, reads the renderer's report of its own
scheduling state, and while the renderer owes a pass it awaits the
renderer's next pass announcement as a one-shot promise, settling the
passive work again and re-reading the report on each pass; it resolves with
the frame the renderer last painted when the renderer owes nothing more. The
frame wait attaches a one-shot promise to the renderer's pass announcement:
the announcement names the pass, the pin reads the buffer the pass painted,
and the wait resolves on the frame the pin accepts. The frame poll stands
behind under the same liveness-aware deadline: it witnesses a renderer that
paints without announcing, and it keeps the off-schedule measurement the
deadline stands on, and the deadlines stand as ADR 0128 set them, the 20 s
window that holds for another window when it stood off the CPU for more than
half under the 50 s outer bound, the wait failing on the last painted frame
and never hanging. The wall-clock grace survives only as the rig's one named
boot settle: the settle that covers the plane's boot under the held loop
policy, the one-shot boot read, the initial-load settle ADR 0154's refresh
coordinator stands on, and the first probe it runs on the settle. It is the
one window in which a plane fact is not yet a renderer fact: before the
plane's first pass, the plane can owe a paint it has not yet asked the
renderer for. The rig's interface, the operations, the fields, the named
outcomes, the immediate press, and the key-ownership window, stands
unchanged: the suites keep every pin, and they wait earlier.

## User Stories

1. As an operator, I want the frame suite to spend its time on the plane under test and not on the rig's sampling, so that the review time I wait on shrinks.
2. As an operator, I want the flake class the doubled deadline paid for to narrow, so that a slow paint is caught on the pass it lands on, not on a deadline.
3. As an operator, I want the decision to stand on the test render site alone, so that the plane I run is untouched by how the rig waits.
4. As an operator, I want the boot settle to keep its grace over the plane's boot, so that the first paint the boot owes lands before the suite reads it.
5. As the machine, I want my settle to resolve on the renderer's report that it owes no further pass, so that I stand on the renderer's own authority over what it owes and not on a sampled shadow.
6. As the machine, I want my settle to await the renderer's next pass announcement as a one-shot promise while the renderer owes a pass, so that I pay the passes the plane owes and nothing else.
7. As the machine, I want my settle to settle the passive work the renderer owes on each pass it awaits, so that the frame I resolve on is the frame the plane finishes painting.
8. As the machine, I want my frame wait to resolve on the renderer's pass announcement, so that the paint and my wait meet at the renderer's own seam and not at my poll.
9. As the machine, I want the announcement to name the pass it announces, so that my pin reads the buffer that pass painted, not a frame a later pass overwrote.
10. As the machine, I want my frame poll to stand behind the announcement under the same deadline, so that a renderer that paints without announcing still answers my pin.
11. As the machine, I want the poll to keep measuring my off-schedule time, so that the liveness-aware deadline stands on its witness.
12. As the machine, I want every wait to fail on its deadline with the last painted frame and never to hang, so that a renderer that never answers is a failure the suite names.
13. As the machine, I want my settle to hold no wall grace except my boot settle, so that the grace is paid once per boot and not on every wait of the suite.
14. As the machine, I want my boot settle to keep its grace over the one-shot boot read, the initial-load settle, and their first paints, so that the work the plane does that I did not ask for lands before I read it.
15. As the machine, I want my resolve rule to read no stack and count no ask, so that classifying an ask's source is not on the wait's hot path.
16. As the machine, I want my waits to stand on the renderer's frame facts whatever tick source the plane's animation frames come from, so that the frame module's ticks and the test renderer's absence of ticks of its own change nothing in my waits.
17. As the machine, I want the production renderer to stand on the same frame facts, so that a pin green on the test renderer reads of the same renderer class the plane paints through.
18. As the test suite, I want my frame pins to stand unchanged and resolve earlier, so that no pin changes meaning when the rig's waits stand on the renderer's facts.
19. As the test suite, I want my settle to resolve in the gap between the animation steps the way it does today, so that a plane whose face steps settles while it stands.
20. As the test suite, I want my immediate press to keep skipping the pre-settle, so that a key landing during a live cycle behaves the way ADR 0128 named it.
21. As the test suite, I want a pin that my settle resolves on a pass the plane's asks painted and on no pass owed after, so that a settle that resolves before the plane's paint is caught.
22. As the test suite, I want a pin that my frame wait resolves on the pass announcement and reads the buffer that pass painted, so that a wait that resolves on a stale buffer is caught.
23. As the test suite, I want a pin that a wait on a renderer that paints without announcing resolves on the poll under the deadline, so that the witness still stands.
24. As the test suite, I want a pin that a wait on a renderer that announces no pass and owes none still fails on the deadline with the last painted frame, so that the deadline never becomes a hang.
25. As the test suite, I want a pin that the boot settle keeps its grace over the held loop policy's one-shot boot read and the initial-load settle, so that the first paint the boot owes lands before the suite reads it.
26. As the test suite, I want the rig's architecture test and the campaign's counter walk to keep pinning the owned surface and the rig's exports, so that this decision grows the rig's surface and never shrinks it.
27. As the test suite, I want my key-ownership window and my named outcomes to stand unchanged, so that the input face the rig owns is untouched by the wait-side decision.
28. As the test suite, I want a pin that my waits keep their liveness-aware deadline, a window that stood off the CPU for more than half holds for another window until the outer bound, so that the descheduled-worker flake class ADR 0128 paid for is not reopened.

## Implementation Decisions

**The frame rig.** The shared test module deepens the resolve rule behind its
existing wait operations. The operations keep their names, their fields,
their named outcomes, the immediate press, and the key-ownership window: the
settle, the frame waits behind the named outcomes, the named operations that
drive a control and wait for its outcome, and the escape operations. The rig
stands on two renderer facts, both on the renderer's public surface: the
renderer's frame pass announcement (the rig already swallows and
re-announces it for the surfaces that register for the pass) and the
renderer's report of its own scheduling state (a pass owed, rendering, the
frame loop running). The same renderer class stands at both render sites, so
the facts are one fact, and the deepening moves the resolve rule to the
renderer's own frame facts: the wait and the paint meet at one seam, the
renderer's pass announcement.

**The settle.** After the operation the rig has run, the settle settles the
passive work the renderer's frame drains, reads the renderer's report, and
while the renderer owes a pass it awaits the renderer's next pass
announcement as a one-shot promise; on each pass it settles the passive work
again and re-reads the report; it resolves with the frame the renderer last
painted when the renderer owes nothing more. A settle that runs after an
operation that owes no paint resolves on the frame that stands, with no pass
owed after it. While a face steps on the frame module's tick port (ADR
0149), the renderer owes a pass only between ticks, and the settle resolves
in the gap, the same behavior the equal-frame settle shows today.

**The frame waits.** A frame wait attaches a one-shot promise to the
renderer's pass announcement. On each announcement the pin reads the buffer
the pass painted; the announcement names the pass, and it comes after the
renderer has written the buffer, so the frame the announcement names is the
frame the pin reads. The pin stands as it stands today, a read of the
painted buffer, and the wait resolves on the frame the pin accepts.

**The poll stands behind.** The frame poll keeps running under the same
liveness-aware deadline. It witnesses a renderer that paints without
announcing, and it measures the off-schedule time the liveness-aware
deadline (ADR 0128) stands on; a bare one-shot promise has no such witness.
The deadlines stand as ADR 0128 set them: the 20 s window that holds for
another window when it stood off the CPU for more than half, the 50 s outer
bound under the runner's budget, and the wait fails on the last painted
frame. A wait that never gets its pass fails on the deadline, never a hang.

**The boot settle.** The wall-clock grace survives only in the rig's one
named boot settle: the settle that covers the plane's boot under the held
loop policy, the one-shot boot read, the initial-load settle ADR 0154's
refresh coordinator stands on, and the first probe it runs on the settle,
and their first paints. The boot is the one window in which a plane fact is
not yet a renderer fact: before the plane's first pass, the plane can owe a
paint it has not yet asked the renderer for, and the renderer's owed-pass
report is not armed over that window. The named grace covers that window
once per boot, and after it the boot settle stands on the renderer's frame
facts the way every other settle does. The rig's named operation that
settles the sources drives the settle the same way. Every settle outside the
boot window holds no wall grace.

**The render-ask holds keep their classification.** The rig's two
render-ask holds, the hold that lets the plane's asks through and the hold
that swallows every ask, keep classifying an ask as the plane's or internal
by the caller's site. The resolve rule parses no stack and counts no ask,
because the renderer's scheduling report is the renderer's own authority
over what it owes.

**Order-safety.** The decision is order-safe against the frame module (ADR
0149) and the renderer adapter (ADR 0145) in either direction: the waits
stand on the renderer's frame facts whatever tick source the plane's
animation frames come from, the test renderer runs no tick of its own, and
each side of the seam owns its own renderer, the rig owning the test
renderer and the production entry owning the production renderer through the
renderer adapter once it lands.

**The owned surface grows and never shrinks.** The rig's own architecture
test pins the owned surface, the floor growing and never shrinking, the
retired surface, and the shape of the waits; the campaign's counter walk
pins the rig's exports. The decision retires no operation and renames none;
the one new named surface, the boot settle, grows the walk's number.

## Testing Decisions

The seams the test stands on are the existing ones. The rig's own wait
operations, the settle, the frame waits behind the named outcomes, and the
named operations that drive a control and wait for its outcome, exercised by
every frame suite the rig owns: the suites keep every pin, and they wait
earlier. A pin that stood on two equal samples read on the wall tick stands
on the pass announcement and the renderer's owed-pass report, and it
resolves on the same frame. No suite changes a pin. No new seam is named in
the plane: the renderer, the frame module, the renderer adapter, and the
plane's screens are untouched, and the decision stands on the test render
site alone.

- **The rig's own frame suite**, head of the owned list, pins the new
  resolve rule: a settle that resolves on a pass the plane's asks painted
  and on no pass owed after; a settle that resolves on the frame that stands
  after an operation that owes no paint; a frame wait that resolves on the
  pass announcement and reads the buffer that pass painted; a wait on a
  renderer that paints without announcing that resolves on the poll under
  the deadline; and a wait on a renderer that announces no pass and owes
  none that fails on the deadline with the last painted frame. It pins the
  boot settle's grace over the held loop policy's one-shot boot read and the
  initial-load settle, and the first probe ADR 0154 runs on the settle.
  Prior art: the suite already pins the liveness-aware deadline, the window
  that stood off the CPU for more than half holding for another window until
  the outer bound, and the render-ask holds with their witness, the
  frame-pass swallow that counts the passes the surfaces could not see.
- **The rig's own architecture test and the campaign's counter walk** keep
  pinning the owned surface, the retired surface, the shape of the waits,
  and the rig's exports. The decision adds the boot settle to the expected
  surface and grows the export walk's number; the rule is that the owned
  surface grows and never shrinks, and the walk's number grows and never
  falls.
- **The frame suites of the seeded plane** exercise the settle and the frame
  waits through every named outcome over the stub herdr world and the stub
  sources, with the loop policy the suite names. Their pins stand unchanged:
  the frame the pin names is the frame the pin reads, whether the wait
  resolved on the announcement or on the poll behind it.

## Out of Scope

- The renderer adapter and the repaint policy of ADR 0145: the production
  entry's renderer is not the rig's, and the decision adds no observer to
  the production render site.
- The frame module and its tick port (ADR 0149): the tick source of the
  plane's animation frames is not named by this decision; the waits stand on
  the renderer's frame facts whatever the tick source is, and the test
  renderer runs no tick of its own.
- The screen stack and the suspended screens (ADR 0150): a suspended screen
  owes no pass, and the decision reads that the way the renderer's report
  already does.
- The initial-load settle fact (ADR 0154) and the rig's named operation that
  settles the sources: the boot settle stands on them, and it changes
  neither.
- The rig's input face: the Control catalogue, the Action bar, the named
  outcomes, the key-ownership window, and the immediate press (ADR 0128).
- The spin watch and the runner's budget (ADR 0138).
- The production renderer and its frame loop: the rig drives no tick and
  adds no listener the production renderer stands on.

## Further Notes

- Census: more than 3,200 wait sites across the frame suites, the
  press-family operations, the settle, the frame waits, and the command and
  state waits; the cost per wait today is the 30 ms grace and two 10 ms
  polls on a plane that owes no paint. ADR 0128's census at the head that
  doubled the deadline to 20 s: 875 frame waits, 1,888 hand-written wait
  descriptions, 193 key-ownership waits, and the twelve flake issues, #302,
  #303, #304, #310, #311, #312, #314, #316, #318, #323, #326, #342.
- The announcement comes after the paint: the renderer writes the buffer and
  then announces the pass, so the pin that reads the buffer on the
  announcement reads the frame the announcement names, and the one-shot
  promise needs no copy of its own.
- The poll has two jobs after the deepening: the witness (a renderer that
  paints without announcing) and the off-schedule measurement (the
  liveness-aware deadline's witness). Both jobs are why the poll survives
  the deepening.
- The boot settle's grace is the one place a wall fact stands in for a plane
  fact: before the plane's first pass, the plane can owe a paint the
  renderer has not been asked for, and the renderer's owed-pass report is not
  armed over that window. After the first pass, every owed paint goes
  through the renderer's ask path, and the report is complete.
- Order-safety, precisely: against ADR 0149, the waits stand on the
  renderer's frame facts whatever tick source the plane's animation frames
  come from; against ADR 0145, the rig owns the test renderer and the
  production entry owns the production renderer, and the decision touches
  the test side only. Landing this record before either, or after either,
  stands on the same two facts.
