# ADR 0156: The frame rig's waits resolve on the renderer's frame passes

Status: accepted
Date: 2026-11-14

Records that the frame rig's waits resolve on the renderer's frame passes
instead of on a frame-equality shadow the rig samples on a wall-clock tick:
its settle resolves when the renderer owes no further pass after the plane's
asks have painted, and its frame waits resolve on the renderer's pass
announcement as a one-shot promise, the frame poll standing behind under the
same liveness-aware deadline. The wall-clock grace survives only as the rig's
one named boot settle.

## Context

Every wait the frame rig's named operations stand on resolves on a derived
fact. The settle opens on a 30 ms wall-clock grace and then samples the
renderer's painted buffer every 10 ms, accepting the frame when two
consecutive samples read equal. The frame waits sample the same buffer on the
same tick under the liveness-aware deadline ADR 0128 set: a 20 s window that
holds for another window when it stood off the CPU for more than half, under
a 50 s outer bound. The suite's census counts more than 3,200 wait sites
across the frame suites, and the settle stands behind every key operation of
them: a wait on a plane that owes no more paint costs the grace and two
polls on top of the work the plane owed.

The fact the rig samples is a shadow of the renderer's state, and the rig
pays for the blindness twice. A poll straddles a paint by a full poll
interval: a paint that lands between two polls is read on the sample after
it, one interval late. ADR 0128 paid for that class by doubling the deadline
to 20 s; its census at the head that doubled it counted 875 frame waits, 1,888
hand-written wait descriptions, and 193 key-ownership waits, and the twelve
flake issues of that class stand behind the doubled deadline. And the grace
is the second payment of the same blindness: because the shadow cannot tell
"the plane owes no more paint" from "the paint has not been sampled yet", the
rig waits out wall time before it trusts the buffer, on every wait, not on
the one that needs it.

The source facts already stand at the rig. The renderer announces each pass
it paints, and it announces after it has written the buffer: the
announcement names the pass, and the frame it names is the frame a pin can
read. The rig already intercepts that announcement: it swallows the pass and
re-announces it to the surfaces that register for it, so the announcement is
a fact the rig already holds and already routes. And the renderer reports its
own scheduling state on the renderer's public surface, whether a pass is
owed, whether it is rendering, whether its frame loop is running. The same
renderer class stands at both render sites, the production entry and the
frame rig: the plane module they boot is one module, from one Plane boot
record, and the renderer adapter ADR 0145 owns the production entry's
renderer while the rig owns the test renderer. The renderer's test
operations already stand on exactly these two facts: they await the pass
announcement as a one-shot promise, and they fall back on the renderer's own
idle report when the frame loop is down.

Two landed records absorbed part of this candidate, and this record scopes to
what remains. ADR 0128 moved the rig's deadline to the liveness-aware
window, so a descheduled worker stretches a wait instead of failing it; that
decision stands, and this record keeps the window, the hold, and the outer
bound. ADR 0149 took the per-screen animation clocks out of the frame stream,
so the tick source of the plane's animation frames is a fact the renderer's
frame facts already carry, and the test renderer runs no tick of its own.
What remains is the resolve rule: the waits stand on the renderer's frame
facts instead of the polled shadow, and the grace survives only in the boot
window.

## Decision

The frame rig's waits resolve on the renderer's frame facts: the pass
announcement and the renderer's report of its own scheduling state. The rig
stops resolving its waits on the frame-equality shadow sampled on the
wall-clock tick, and it reads the renderer's own report and awaits the
renderer's own announcement instead. The deepening is one seam: the wait and
the paint meet at the renderer's pass announcement, and the rig asks the
renderer for the two facts it resolves on. That is the locality the shadow
never had, the rig re-deriving by sampling what the renderer reports, and
the leverage stands on the interface: two facts and a deadline serve the
suite's more than 3,200 wait sites the way the one deadline already serves
them.

- The settle: after the rig has run the operation, it settles the passive
  work the renderer owes, reads the renderer's report, and while the
  renderer owes a pass it awaits the renderer's next pass announcement as a
  one-shot promise; on each pass it settles the passive work again and
  re-reads the report. It resolves with the frame the renderer last painted
  when the renderer owes nothing more, and a settle that runs after an
  operation that owes no paint resolves on the frame that stands, with no
  pass owed after it. While a face steps on the frame module's tick port
  (ADR 0149), the renderer owes a pass only between ticks, and the settle
  resolves in the gap, the same behavior the equal-frame settle shows
  today.

- The frame waits: the wait attaches a one-shot promise to the renderer's
  pass announcement. On each announcement the pin reads the buffer the pass
  painted; the announcement names the pass, and it comes after the renderer
  has written the buffer, so the frame the announcement names is the frame
  the pin reads. The pin stands as it stands today, a read of the painted
  buffer, and the wait resolves on the frame the pin accepts. The suites'
  pins keep their meaning, and they resolve earlier.

- The frame poll stands behind under the same liveness-aware deadline. It
  witnesses a renderer that paints without announcing, and it measures the
  off-schedule time the liveness-aware deadline stands on; a bare one-shot
  promise has no such witness. The deadlines stand as ADR 0128 set them, the
  20 s window that holds for another window when it stood off the CPU for
  more than half, the 50 s outer bound, and the wait fails on the last
  painted frame. A wait that never gets its pass fails on the deadline,
  never a hang.

- The resolve rule reads no stack and counts no ask. The renderer's
  scheduling report is the renderer's own authority over what it owes, and a
  count the rig kept of the asks it intercepted would read a quiescence that
  is not there where an ask path schedules without the public ask. The
  stack-trace classification of render asks stands confined to the rig's two
  render-ask holds, the hold that lets the plane's asks through and the hold
  that swallows every ask, whose contract needs the plane-versus-internal
  distinction.

- The wall-clock grace survives only as the rig's one named boot settle. It
  covers the plane's boot under the held loop policy: the one-shot boot
  read, the initial-load settle ADR 0154's refresh coordinator stands on, and
  the first probe that runs on the settle, and their first paints. The boot
  is the one window in which a plane fact is not yet a renderer fact: before
  the plane's first pass, the plane can owe a paint it has not yet asked the
  renderer for, and the renderer's owed-pass report is not armed over that
  window. The named grace covers that window once per boot, and after it the
  boot settle stands on the renderer's frame facts the way every other
  settle does. Every settle outside the boot window holds no wall grace.

- The rig's interface stands unchanged. The operations keep their names,
  their fields, their named outcomes, the immediate press, and the
  key-ownership window; the interface is two renderer facts and a deadline,
  and the implementation is the announcement, the report, the passive-work
  settle, and the poll standing behind. The owned surface grows and never
  shrinks: the one new named surface, the boot settle, joins it, and the
  rig's own architecture test and the campaign's counter walk police it the
  way they police it today.

- The decision is order-safe against the frame module (ADR 0149) and the
  renderer adapter (ADR 0145) in either direction. The waits stand on the
  renderer's frame facts whatever tick source the plane's animation frames
  come from, the test renderer runs no tick of its own, and each side of the
  seam owns its own renderer: the rig owns the test renderer, and the
  production entry owns the production renderer, through the renderer
  adapter once it lands. The decision touches the test render site alone.

## Considered options

- Keep the polled shadow (status quo): the poll keeps sampling the buffer's
  stability on the wall tick, the grace stays on every wait, and the
  straddle stays behind the doubled deadline. It loses because the renderer
  already announces the fact the shadow re-derives, and the rig already
  intercepts the announcement for the surfaces; keeping the shadow keeps
  both payments of the blindness, the straddle ADR 0128 paid for with the
  deadline and the grace every wait pays.
- Resolve only on the renderer's pass announcements and retire the poll: it
  loses because the renderer announces a pass only to the listeners it has,
  and a renderer that paints through a path the rig did not intercept would
  leave the wait to fail on the deadline with the pin never having read the
  paint. The poll standing behind keeps the pin honest, and it keeps the
  off-schedule measurement the liveness-aware deadline stands on; retire the
  poll and the window loses its witness.
- Count the rig's own intercepted asks: a wrapper on the renderer's ask
  reports outstanding asks instead of the renderer's own scheduling report.
  It loses because that is the shadow again: the rig re-derives the
  renderer's private scheduling state from its own interception, and an ask
  path that schedules without the public ask reads a quiescence that is not
  there. The renderer is the authority over what it owes, and it reports it.
- Announced-pass frame equality: keep the two-equal-frames rule, but take
  the frames on the pass announcements instead of on the wall tick. It loses
  because equality is a test of the buffer's contents, not of the plane's
  obligation: a face stepping on its 100 ms step makes equal frames
  impossible to observe across the step, so the rule still waits on wall
  time between passes, and a pass that changes one glyph waits out the gap
  before the rig learns the plane owes nothing. The renderer's own owed-pass
  report is the fact the equality test approximates, and the report stands on
  the renderer's public surface.

## Consequences

- The operator sees no change: the decision stands on the test render site
  alone. The plane the operator runs keeps its renderer, its entry, its
  frame module, and its screens, and the operator's share is the frame
  suite's wall time, which the rig no longer spends on sampling.
- The machine: a wait costs the passes the plane owes and nothing else. A
  wait that owes no paint costs no grace, and a paint that lands mid-wait is
  caught on the pass it lands on, not on the deadline it outruns. The rig's
  waits and the renderer's test operations stand on the same two facts, so
  the rig and the renderer it tests read the same thing.
- The test: the frame suites keep every pin and wait earlier. The rig's own
  frame suite, head of the owned list, pins the new resolve rule: the settle
  on a pass and on no pass owed, the frame wait on the announcement, the
  poll under the deadline when the renderer announces nothing, the deadline's
  failure on a renderer that owes no pass and announces none, and the boot
  settle's grace over the one-shot boot read and the initial-load settle.
  The rig's own architecture test keeps pinning the owned surface, the floor
  growing and never shrinking, the retired surface, and the shape of the
  waits, and the campaign's counter walk keeps pinning the rig's exports.
- The glossary: the Frame rig entry is rewritten to name the renderer's
  frame pass as the fact the rig's waits stand on, the boot settle as the
  one place the wall-clock grace stands, and the frame poll as the witness
  standing behind under the same deadline. This record lands with the
  implementation, not with this ADR.
