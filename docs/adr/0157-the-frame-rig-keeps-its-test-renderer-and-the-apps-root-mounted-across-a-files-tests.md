# ADR 0157: The frame rig keeps its test renderer and the App's root mounted across a file's tests

Status: accepted
Date: 2026-11-14

Records that the frame rig's boot call keeps the test renderer and the App's
React root mounted across the tests of a file. A file's first test fills the
pool with a full cold boot, and every following test reseeds the plane's
facts - the state, the command runner, the plane's clock, and the Stub herdr
world - and mounts the App with them under the same warm root. The one-shot
boot read of ADR 0129 runs on every test, warm or cold, and no plane fact
crosses a test. A test that takes no pool boots cold exactly as today.

## Context

The frame rig boots a full plane per test. Re-counted on this tree, 411 boot
calls stand across 34 frame suites, and the largest suites boot 57, 46, 36,
and 32 times. Every boot pays both prices: the Seeded plane's, the temporary
home and checkout, the config write, the state's open with its process
lease, the fake command runner, the ticket sources' doubles, and the
standing's seeding, and the test frame's, the test renderer with its
terminal, the App's React root, the App's mount, and the one-shot boot read
under the held loop policy.

Measured on the 32-core machine, in one process, at the rig's fixed 120 by
30 test terminal, on the installed renderer: the file's first boot takes
63 ms, the state's open and the seeding 8 ms, the renderer's one-time
initialization and the root and the App's mount 35 ms, the first flush after
the one-shot boot read 18 ms. A steady-state cold boot takes about 30 ms,
the state 5 ms, the test renderer and the root and the mount 7 to 10 ms, the
first flush 16 to 18 ms, the teardown about 1 ms. The same App remounted
under a warm renderer and a warm root takes about 17 ms, the state's open
included, and paints the full 30-line frame. The pool therefore warms the
renderer-and-root piece, about 8 to 13 ms of the steady-state boot, and the
boot's dominant piece stands per test either way: the one-shot boot read's
first flush, about 17 ms, which the held loop policy makes non-skippable by
decision.

The suite's wall time stands on the rig's waits, not on the boots: about
3,000 wait sites across the frame suites, each polling the painted frame
every 10 ms. This decision moves the boot price and moves no wait. The
sibling record that resolves the rig's waits on the renderer's frame passes
rides on the same rig, and the interplay is one of locality: the warm pool
drives the same waits that record deepens, and a wait that listens to the
renderer's frame passes wants a renderer that survives across the tests of a
file, not one rebuilt per test.

The landed records already absorb part of the candidate's surface, and this
record is scoped to what remains: ADR 0154 settled how the rig settles the
initial load and its first probe, and ADR 0145's renderer adapter and ADR
0149's frame module own the production renderer and the plane's animation
frames. What remains is the ownership of the rig's test renderer across the
tests of a file, and the landed records stand around it: ADR 0129's held
loop policy and its one-shot boot read stand, the warm rig runs the same
one-shot boot read on every test and does not skip it; ADR 0128's one
deadline stands; ADR 0132's Stub herdr world stands on the pool per test, on
the per-test plane's runner, beside the fake command runner of the default
path.

## Decision

- The rig's boot call keeps its shape: the test hands it a named world spec,
  the plane record it built against the Seeded plane, and receives a working
  App it drives through the rig's named operations. The rig now keeps a
  file-scoped warm pool behind that call: the test renderer with its
  terminal, the App's React root on it, and the rig's frame event witness on
  the renderer. A file's first test fills the pool, and the fill step is the
  full cold boot, so the pool's fill and the cold path are one implementation.

- What stays warm is the test renderer, its terminal, its screen model, the
  App's root, and the frame event witness. What resets per test is the plane
  in full: the state and its open, the config record, the home directory,
  the command runner with its fresh command log, the Stub herdr world that
  stands on it, the ticket sources' doubles, the plane's clock. And the
  App's tree resets per test: its screen stack, its modal state, its
  coordinator, its loops, stopped by the teardown handle before the unmount.
  The warm reuse is of the renderer and the mount, never of the plane's
  facts: two tests in one file never share a state, a runner, a clock, or a
  world.

- The App unmounts and remounts under the same warm root on every test. The
  plane's facts are the App's boot props, mount-time facts from which the
  App derives its internals once, and the production entry builds the App
  once per run and never reseeds a mounted one. Keeping the App mounted and
  reseeding its facts would add a production reset semantic that no
  production run uses, a test concern leaking through the App's interface
  into the screen stack, the coordinator, and the loops, each of which would
  need a reset path. Unmount and remount keeps the App's interface exactly
  what it stands, mount with facts, clean up on unmount, and it keeps the
  cold path and the warm path different in exactly one fact, whether the
  renderer and the root are new, which is exactly the fact the rig's own
  pin checks.

- The one-shot boot read runs on every test: the App's mount runs it under
  the held loop policy against the test's fresh state, and the rig's named
  settle operation settles that test's stub sources the same way it settles
  them today, the first probe running on the settle (ADR 0154). The pool
  changes what renderer the frames land on; it changes neither when the load
  settles nor what the boot read reads.

- The warm remount paints onto a terminal whose screen model still holds the
  previous test's pixels. While ADR 0145's blanket force stands, the App's
  first frame is a full rewrite and overwrites the predecessor entirely.
  When the force lifts and the frames diff, the convergence of a diffed
  first frame on a warm screen model is what the rig's same-frames pin
  checks on the installed renderer. The rig's waits read the painted
  terminal after the flush, so they read the converged screen either way.

- The pool is scoped to the test file: the test runner gives each file its
  own process, and a pool cannot cross a process. Per-describe scoping
  fragments the pool inside a file and names a scope the call site does not
  need, and per-test scoping is the status quo. The call site names no
  scope: the named world spec in, the working App out.

- The cold boot remains: the fill step is the cold boot, and it is the path
  a test takes when it takes no pool. The rig's boot call stays the one seam
  between the frame suites and the App's mount, and the pool is the
  implementation of that seam, not a second seam beside it.

- The rig's owned surface grows and never shrinks: the named operations and
  the boot call the suites drive stand, the architecture test's closed floor
  of owned suites stands, and the counter walk that polices the rig's
  exports accepts the grown count, the rule ADR 0128's interface deepening
  set.

## Considered options

- Keep the per-test cold boot: every test pays the renderer and the root,
  the interface stays one-shot, and nothing in the plane moves. The measured
  price is small on a fast machine, about 8 to 13 ms per test, so the
  decision would be a wash on milliseconds. It is not a wash on structure:
  the per-test renderer swap strands the sibling deepening, because a wait
  that resolves on the renderer's frame passes needs a renderer that
  survives the test it waits in, and the pool's leverage is that it stands
  that renderer. Rejected: it keeps the shallow one-shot interface and
  spends the locality the sibling record needs.
- Keep the App mounted and reseed its facts: it saves the remount's measured
  12 ms, and it costs the plane a production reset semantic. The App's
  internals, the screen stack, the coordinator, the loops, would each need a
  reset path that production never runs, and the App's interface, which
  today says mount with facts, would come to say also swap facts while
  mounted. Rejected: it trades a measured 12 ms for a behavior the plane
  must support forever.
- Scope the pool per describe block: a file with many blocks pays the fill
  once per block, the call site must name the block, and the measured gain
  over file scoping is nothing, because the fill is the file's first test
  either way. Rejected: it fragments the pool and grows the interface to
  name the fragment.
- Warm the state across tests, reseeding its aggregates in place: the
  state's open is about 5 ms, a fifth of the boot and its cheapest line, and
  it is the one line that owns the plane's facts, the aggregates, the lease,
  the ticket sources. Warming it would let one test read another test's
  facts through the state, which is the isolation breach the fresh-plane
  rule exists to prevent. Rejected: it spends the guarantee the suite stands
  on to save the cheapest stage of the boot.

## Consequences

- The operator sees nothing: the plane's screens, keys, and hints are
  untouched, and the production entry's renderer construction and its
  repaint policy stand as ADR 0145 recorded them.
- The machine: each frame test still pays the state's open and the one-shot
  boot read, and the file's tests pay the test renderer and the App's root
  once instead of per test. Measured on the 32-core machine, the
  steady-state cold boot of about 30 ms per test becomes about 17 ms warm,
  and the file's first test pays the fill. The rig's waits, the suite's
  dominant cost, are untouched by this decision, and the sibling record that
  resolves them on the renderer's frame passes lands on the warm renderer
  this decision stands.
- The test: each test still sees a fresh plane, a fresh state, a fresh
  command log, a fresh clock, a fresh Stub herdr world, and the one-shot
  boot read still runs on it. The rig gains one pin: the warm rig and the
  cold boot paint the same frames, so the pool cannot drift a suite's frames
  from the frames the cold boot paints. The architecture test's closed floor
  and the counter walk stand, and the frame suites' call sites change no
  line.
- The test: deleting the pool returns the boot cost to per test; it does
  not concentrate, because the fill step is the pool. The suites return to
  the cold figure and the rig loses its pin, which is the shape of a module
  the suites stand on: its deletion is felt in every file, not in one.
- The glossary rewrites the Frame rig entry to name the pool: the rig keeps
  its test renderer and the App's root mounted across a file's tests and
  reseeds the plane's facts per test. The entry lands with the
  implementation, not with this ADR.
