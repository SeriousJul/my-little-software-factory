# ADR 0149: The frame module owns the plane's animation frames

Status: accepted
Date: 2026-11-14

Records that the plane's per-frame values, the spinner face's frame index
and the modal pop's scale, leave React state and stand in one new module of
the shared control library, the frame module. The module owns one tick port
and one frame owner interface. The tick port is wired in production to the
renderer's per-frame tick by the module that owns the renderer, the plane's
entry module today and the renderer adapter once ADR 0145 lands, and in the
test frame to the frame rig's one new named operation. A surface keeps only
its structural fact and registers a frame owner whose paint writes the
per-tick fact into the renderer's frame through the shared presentation and
the shared paint layer. React state holds no per-frame value, and a tick
costs one paint, not a root commit.

## Context

Two of the plane's motions are painted the expensive way. The spinner face
steps beside its written word while a ticket stands in its Starting window,
and the pop carries the Decision modal and the Live view to their settled
size in 120 ms. Today each step of each motion is a per-frame value in React
state on the plane's one root screen, and a per-frame value in state is a
commit: the face step re-runs the ticket list's row shaping and element
tree, and the pop step re-derives the modal's frame geometry and re-wraps
its body text at the intermediate width. The plane is one root React screen,
so a commit re-lays out the region's whole element tree. Then the module
that owns the renderer forces a full repaint on every frame (the workaround
ADR 0145 keeps until the byte-loss signal exists), so every step costs a
whole screen of terminal bytes: ten times a second while a face steps, and
on every tick of a pop's opening.

The machine running the plane pays this twice. Ten face steps per second are
ten element-tree re-layouts and ten full-screen rewrites per second, and
each pop's opening is a body re-wrap on every tick. The CPU the animation
steals is the CPU the Observation cycle needs to settle the turns the agents
end. And the test suite pays it a third way: the animation's clock stands in
a wall-clock interval inside the screen, and the test has no hand on it, so
the suites wait on wall-clock graces over the animation's budget, a 250 ms
sleep over the pop's 120 ms budget, or on frame-stream waits that can miss
the window.

The renderer ships its own animation engine, timelines that interpolate
renderable properties with the engine holding the renderer's liveness while
a timeline plays, but the plane does not take it, and the test renderer
never runs it. The seam is shallow: the clock stands inside each screen, and
the tick path re-runs the screen's layout. The deletion test: deleting the
per-screen clocks would scatter the liveness rule, the clock step, and the
paint handoff into each screen; concentrating them in one shared module
instead makes that module deep, two small interfaces (the tick port, the
frame owner) hiding the liveness rule, the step, the rest, and the paint
handoff.

## Decision

The shared control library gains one frame module, beside the shared
spinner module and the shared modal chrome module (ADR 0014 already puts the
spinner face and its written word there). The module is deep on purpose: two
small interfaces hide the liveness rule, the clock step, the rest, and the
paint handoff, and every animated control the plane owns later registers on
the same two interfaces instead of growing its own clock.

- Interface one: the tick port. Something outside the module hands it a
  tick, a delta of time. Behind the port stand two adapters that make the
  seam real. In production: the renderer's per-frame tick, wired to the port
  by the module that owns the renderer, the plane's entry module today, the
  renderer adapter once ADR 0145 lands, and that wiring holds the renderer's
  frame loop running while at least one frame owner is active, asking the
  renderer for liveness when the first owner registers and dropping it when
  the last owner leaves. In the test frame: the frame rig's one new named
  operation, which hands the module a named delta and then paints the frame
  that follows. The port's shape does not change between the two owners of
  the renderer, so this decision and ADR 0145 are order-safe in either
  direction. While a tick arrives, the module advances each active owner's
  clock by the delta and, when the owner's painted fact changes, hands the
  frame's facts to that owner's paint. Ticks that change no painted fact
  paint nothing.

- Interface two: the frame owner. A surface registers an owner with the
  structural fact that says the owner is active (the ticket is in its
  Starting window, the modal is in its opening) and a paint that takes the
  owner's per-tick fact (the face frame index, the pop scale) and writes it
  into the renderer's frame. The paint resolves its word and geometry
  through the shared presentation and its colors through the shared paint
  layer, so the no-color presentation keeps the word and drops the color.
  React state keeps only the structural fact. Registration stands in a
  surface effect that lives exactly as long as the owner's window: at the
  open the owner applies its opening fact before the first paint, so no
  frame shows the settled size, and at the close the surface's structural
  repaint takes the face or the box back to the settled state and the module
  releases the owner. While an owner stands, the module is the only writer
  of that owner's per-frame cells, so a structural repaint can never paint a
  stale frame: a repaint that changes the owner's static facts repaints
  through the same paint.

- The first owners: the spinner face and the modal pop. The shared spinner
  module keeps its frames, its 100 ms step, and its face text, and its
  self-driven frame hook leaves the ticket list, which keeps the structural
  fact that rows are Starting in React state and registers one face owner
  while any visible row wears the face; one face owner serves several
  starting rows. The shared modal chrome module keeps the pop's 120 ms
  budget, its opening scale, and its easing, and its self-driven scale hook
  leaves the Decision modal and the Live view, which register one pop owner
  for their openings. One tick source serves many owner clocks: the face's
  100 ms step runs on its own clock beside the pop's 120 ms opening on the
  same tick.

- The pop's body text is wrapped once, at the settled content width. The
  intermediate frames show the body clipped to the box, and the settled
  frame shows it exactly as today. The per-tick body re-wrap, the detail
  body's wrap and the live body's facts, leaves the tick path and runs only
  when the body's content or structure truly changes.

- The renderer's built-in animation engine is not adopted: the plane's frame
  facts are named values, a frame index and a scale on the plane's own
  easing, painted through the plane's own presentation, not interpolated
  renderable properties. The engine and the module stand on the same seam
  either way, the renderer's per-frame tick, and the test renderer never
  runs the engine's tick.

- The shared library's automated check extends to the frame clock: a
  surface that owns its own per-frame timer is rejected the way a separate
  key system or a color table is (ADR 0014).

## Considered options

- Keep the per-screen clock (status quo): a bug in the motion settles per
  screen, each new animated control adds another clock, another test wait,
  and another flake class, and under the blanket force the live loop's byte
  rate can stand above the face's step rate while any owner is active.
- Route the per-frame values through React state and lean on the renderer's
  diff once ADR 0145 lands: the diff makes each tick cheap in bytes, but the
  root commit, the element-tree re-layout, and the body re-wrap remain, and
  a per-frame value in state is a commit by construction.
- Adopt the renderer's animation engine: it interpolates renderable
  properties while the plane's frame facts are named values painted through
  the plane's own presentation, and the test renderer would need a second
  engine of its own.

## Consequences

- The operator sees no change: the same face, the same step, the same pop,
  the same settled size, and the same no-color presentation.
- The machine: a tick costs one paint, not a commit, not an element-tree
  re-layout, and not a body re-wrap. A resting plane burns no frame loop.
  Once ADR 0145's repaint policy restores the diff, the face step becomes a
  one-glyph change on the terminal. Until the policy stands, the tick frame
  rewrites the screen exactly as it does today, and the live loop under the
  blanket force is the one place this decision alone raises the byte rate,
  the exact cost ADR 0145 removes.
- The test: the wall-clock grace over the animation budget becomes the named
  tick, deterministic on the local runner and the CI runner alike. The
  frame rig's owned-surfaces floor gains the one new named operation and
  grows, never shrinks, and the export-count walk accepts the grown count.
- The decision is order-safe against ADR 0145 in either direction: landing
  it before the renderer adapter is correct on the full-repaint renderer,
  and the adapter landing first is correct on the repaint-driven clock. Once
  ADR 0145 lands, the live loop costs nothing while it waits for the next
  step, and this decision becomes the stronger play.
- The glossary gains Animation frame, Frame owner, and Tick source, the
  Spinner entry is rewritten to name the frame module as the driver of its
  frames, and the verification record names the new rig operation and the
  suites that exercise it. These records land with the implementation, not
  with this ADR.
