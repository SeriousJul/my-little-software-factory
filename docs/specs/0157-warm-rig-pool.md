# 0157: The warm rig pool

## Problem Statement

The frame suites pin the screens the operator reads, and they pin them
through the frame rig, whose boot call is one-shot: every test boots a full
plane and a full test frame, and every test tears both down. Re-counted on
this tree, 411 boot calls stand across 34 frame suites, and the largest
suites boot 57, 46, 36, and 32 times.

Each boot pays two prices. The Seeded plane's price: a temporary home and
checkout, a config write, the state's open with its process lease, the fake
command runner, the ticket sources' doubles, and the standing's seeding.
And the test frame's price: the test renderer with its terminal, the App's
React root, the App's mount, and the one-shot boot read under the held loop
policy. Measured on a 32-core machine at the rig's fixed 120 by 30 terminal,
a steady-state cold boot takes about 30 ms: the state about 5 ms, the test
renderer and the root and the mount about 8 to 13 ms, and the one-shot boot
read's first flush about 17 ms, the boot's dominant line.

The operator pays nothing directly: the rig's bookkeeping is invisible on the
screen, and ADR 0129's one-shot boot read, which the operator's boot
semantics mirror, stands per test either way. The cost is the machine's, and
it is structural as much as measured. Because the renderer is rebuilt per
test, a wait that wants to resolve on the renderer's frame passes has no
renderer to listen on that outlives the test. The frame rig's interface is
shallow: one test in, one boot, one renderer, one frame, one teardown, and
the one-shot seam is what keeps the renderer from standing. The suite's wall
time stands on the rig's waits - about 3,000 wait sites, each polling the
painted frame every 10 ms - and those waits are the sibling record's to
deepen. This record deepens the boot: the renderer and the App's root should
be paid once per file, not once per test.

## Solution

The frame rig keeps a warm pool behind its boot call, scoped to the test
file. A file's first test fills the pool, and the fill step is the full cold
boot, so the pool and the cold path are one implementation. Every following
test reseeds the plane's facts - a fresh state and its open, a fresh config
record and home directory, a fresh command runner and its command log, a
fresh Stub herdr world, fresh ticket sources' doubles, a fresh plane clock -
unmounts the previous App under its teardown handle, and mounts the test's
App with the test's facts under the same warm root: the same test renderer,
the same terminal, the same React root, the same frame event witness.

The one-shot boot read runs on every test, warm or cold: the App's mount
runs it under the held loop policy against the test's fresh state, and the
rig's named settle operation settles that test's stub sources the same way
it settles them today. What the pool changes is what renderer the frames
land on; it changes neither when the load settles nor what the boot read
reads. The test author's call site is unchanged: the named world spec, the
plane record the test builds against the Seeded plane, in; a working App out.
The rig's own pin checks that the warm rig and the cold boot paint the same
frames, so the pool cannot drift a suite's frames from the frames the
operator's plane paints.

From the operator's view the screen is untouched: no production change, the
production entry's renderer construction stands, and the rig's deadlines
still name the plane's slowness, not the rig's bookkeeping. From the
machine's view the boot price moves from per test to per file: measured on
the 32-core machine, the steady-state cold boot of about 30 ms per test
becomes about 17 ms on the filled pool - the renderer-and-root piece of
about 8 to 13 ms moves to the fill step, and the one-shot boot read's first
flush of about 17 ms stands per test by decision.

## User Stories

1. As the machine, I want to build my test renderer and the App's root once
   per file, so that the file's tests pay that price once instead of per
   test.
2. As the machine, I want to fill the pool with the full cold boot, so that
   the file's first test stands on exactly the boot the cold path stands
   on.
3. As the machine, I want to reseed the plane's facts on every test, so that
   each test sees a fresh state, a fresh command log, a fresh clock, and a
   fresh Stub herdr world.
4. As the machine, I want to unmount the App and remount it under the same
   warm root, so that the App's interface stays mount with facts, clean up
   on unmount, exactly as the production entry uses it.
5. As the machine, I want to run the one-shot boot read on every test under
   the held loop policy, so that the warm rig settles the initial load the
   same way the cold rig does.
6. As the machine, I want to keep my frame event witness on the renderer
   that survives the file's tests, so that the sibling deepening, which
   resolves my waits on the renderer's frame passes, listens to one renderer
   per file.
7. As the machine, I want to stop the App's loops with the teardown handle
   before the unmount, so that no loop of one test reads another test's
   state.
8. As the machine, I want the warm remount's first frame to overwrite the
   previous test's pixels, so that the terminal my waits read holds only the
   current test's screen.
9. As the machine, I want the pool scoped to the test file, so that the pool
   cannot cross the process the test runner gives each file.
10. As the machine, I want a test that takes no pool to boot cold exactly
    as today, so that taking no pool costs nothing in semantics.
11. As the machine, I want to hand the renderer back to the pool's teardown
    once at the file's end, so that the file ends with one destroy instead
    of one per test.
12. As the test suite, I want the test author's call site to be unchanged:
    the named world spec in, the working App out.
13. As the test suite, I want the same pins to run on the warm rig and on
    the cold boot, so that a suite written against the cold boot passes on
    the pool without an edit.
14. As the test suite, I want a pin that the warm rig and the cold boot
    paint the same frames, so that the pool cannot drift a suite's frames
    from the frames the operator's plane paints.
15. As the test suite, I want the frame rig's architecture test to keep its
    closed floor of owned suites, so that a suite that leaves the rig's
    named operations is caught.
16. As the test suite, I want the counter walk to accept the grown export
    count, so that the rig's owned surface grows and never shrinks.
17. As the test suite, I want deleting the pool to return the boot cost to
    per test, so that the pool's value is felt in every file, not in one.
18. As the test suite, I want ADR 0128's one deadline to stand on the warm
    rig, so that a slow plane is still named by the deadline, not hidden by
    a warm renderer.
19. As the test suite, I want every test's frame reads to stand on the
    test's own fresh plane, so that no test reads another test's ticket,
    consultation, or command log.
20. As the test suite, I want the Stub herdr world and the fake command
    runner to stand on the pool per test, so that ADR 0132's world and the
    default path's pin tables keep their semantics.
21. As the test suite, I want the pool filled before the file's first test
    reads a frame, so that no test waits on a half-filled pool.
22. As the test suite, I want the warm remount to run the App's mount
    effects on fresh facts, so that the coordinator, the screen stack, and
    the loops stand on the test's plane, not on the file's first test's
    plane.
23. As the test suite, I want the largest suites, the ones that boot 57,
    46, 36, and 32 times, to feel the pool first, so that the measured
    saving lands where the boot count is highest.
24. As the test suite, I want the rig's waits to be untouched by the pool,
    so that this record's figures read clean of the sibling record's.
25. As the operator, I want the frames the frame suites pin to be the frames
    my plane paints, so that a green suite is evidence about the screen I
    read.
26. As the operator, I want the rig's deadlines to be unchanged by the
    pool, so that the slowness the rig names is my plane's slowness, not the
    rig's bookkeeping.
27. As the operator, I want no production change for the pool, so that the
    screen I read is built by the same implementation the suites drive.
28. As the operator, I want the one-shot boot read to run on every frame
    test, so that the boot my plane takes is the boot the suites pin.
29. As the machine, I want the pool to keep the App's root alive across
    tests, so that a remount is a render into a standing root, not a new
    root.
30. As the test suite, I want the sibling record, which resolves the rig's
    waits on the renderer's frame passes, to land on this pool, so that the
    two deepenings share one renderer instead of each standing on its own.

## Implementation Decisions

**The warm pool behind the boot call.** The rig's boot call keeps its
shape: the test hands it a named world spec, the plane record it built
against the Seeded plane, and receives a working App it drives through the
rig's named operations. Behind the call, the rig keeps a file-scoped pool:
the test renderer with its terminal and its screen model, the App's React
root on it, and the rig's frame event witness on the renderer. The pool is
filled once per file by the rig's full cold boot, so the fill step and the
cold path are one implementation. The per-test path is shorter: the test's
plane record stands as the facts, the rig stops the previous App with its
teardown handle, unmounts the App's tree from the warm root, mounts the
test's App on the warm root, and the test drives it.

**What stays warm, what resets.** Stays warm: the test renderer, its
terminal, its screen model, the App's root, and the frame event witness.
Resets per test: the plane in full - the state and its open, the config
record, the home directory, the command runner with its fresh command log,
the Stub herdr world that stands on it, the ticket sources' doubles, the
plane's clock - and the App's tree: its screen stack, its modal state, its
coordinator, its loops, each stopped or torn down by the unmount with the
teardown handle run first. The warm reuse is of the renderer and the mount,
never of the plane's facts: two tests in one file never share a state, a
runner, a clock, or a world.

**The App unmounts and remounts.** The plane's facts are the App's boot
props: mount-time facts from which the App derives its internals once. The
production entry builds the App once per run and never reseeds a mounted
one, so a design that kept the App mounted and reseated its facts would add
a production reset semantic that no production run uses, and every internal
that holds a fact, the screen stack, the coordinator, the loops, would need
a reset path the plane must support forever. Unmount and remount pays a
measured 12 ms to keep the App's interface exactly what it stands, and it
keeps the cold path and the warm path different in exactly one fact,
whether the renderer and the root are new, which is the fact the rig's
same-frames pin checks.

**The one-shot boot read stands.** The App's mount runs the one-shot boot
read under the held loop policy of ADR 0129 against the test's fresh state,
on every test. The rig's named settle operation settles the test's stub
sources the same way it settles them today, and the first probe runs on the
settle, as ADR 0154 recorded. The pool changes what renderer the frames
land on; it changes neither when the load settles nor what the boot read
reads.

**The warm remount converges the terminal.** On the warm remount the
renderer's screen model still holds the previous test's pixels. While
ADR 0145's blanket force stands, the App's first frame is a full rewrite and
overwrites the predecessor entirely. When the force lifts and the frames
diff, the convergence of a diffed first frame on a warm screen model is what
the rig's same-frames pin checks on the installed renderer. The rig's waits
read the painted terminal after the flush, so they read the converged screen
either way.

**The pool's scope is the test file.** The test runner gives each file its
own process, and the pool cannot cross a process. A per-describe scope
would fragment the pool inside a file and name a scope the call site does
not need, and a per-test scope is the status quo the record replaces. If the
runner's isolation ever changes, the pool's scope re-derives from the
process it rides on, not from a name the test author types.

**The cold boot remains.** The fill step is the cold boot, and it is the
path a test takes when it takes no pool. The rig's boot call stays the one
seam between the frame suites and the App's mount; the pool is the
implementation of that seam, not a second seam beside it.

**The rig's owned surface grows and never shrinks.** The named operations
and the boot call the suites drive stand; the architecture test's closed
floor of owned suites stands, and no suite joins or leaves because of this
record; the counter walk that polices the rig's exports accepts the grown
count, the rule ADR 0128's interface deepening set.

**The record's order safety.** The pool is order-safe against the sibling
record that resolves the rig's waits on the renderer's frame passes, in
either direction: this record landing first gives that record a renderer
that survives the file's tests, and that record landing first gives the pool
waits that cost less on the warm renderer. It is order-safe against ADR
0145: the fill step constructs the test renderer as the rig does today, and
it takes the renderer adapter's construction if that record lands first.

## Testing Decisions

The seams the test stands on are the existing ones. No new seam opens in the
plane: the Seeded plane's interface, the App's boot props, and the Loop
policy are untouched, and the frame suites drive the rig's named operations
exactly as they do today.

- The rig's boot call, at every frame suite. The suites' call sites change
  no line: the named world spec in, the working App out. The same pins the
  suites stand on today - the frames they assert, the controls they drive,
  the outcomes they name - run on the warm rig, and the boot is paid once
  per file instead of per test. Prior art: ADR 0128's interface deepening
  left every suite's pins unchanged while the rig's owned surface grew, and
  this record follows that pattern, with the pool behind the seam instead
  of the named operations beside it.
- The rig's own architecture test. Its closed floor of owned suites stands:
  a suite that leaves the rig's named operations fails the floor, a suite
  that lands the pool on keeps it, and the floor grows only as suites join,
  never as they leave.
- The rig's own pin that the warm rig and the cold boot paint the same
  frames. A named world spec is driven under both: the cold boot as today,
  and the same spec on the warm rig, and the frames the rig's waits read are
  the same frame for line. The pin is the guard that the pool cannot drift a
  suite's frames from the frames the cold boot paints, and it is the test
  the warm remount's terminal convergence stands on.
- The rig's own suite, which pins the pool's lifecycle: the fill step is the
  full cold boot; the per-test path reseeds the plane's facts, a fresh
  state, a fresh command log, a fresh clock, a fresh Stub herdr world; the
  one-shot boot read runs on every test, warm or cold; the App's loops stop
  on the teardown handle before the unmount; the file ends with one destroy;
  and a test that takes no pool boots cold, exactly as today.
- The sibling interplay. The record that resolves the rig's waits on the
  renderer's frame passes rides on the same rig: the warm pool drives the
  same waits that record deepens, and the same-frames pin above stands
  whichever record lands first.

## Out of Scope

- The rig's waits themselves: the settle, the frame waits, the 10 ms poll,
  and the one deadline. That record deepens them, and this record moves the
  boot price without moving a wait, so the two records' figures read clean
  of each other.
- The production renderer: ADR 0145's renderer adapter and ADR 0149's frame
  module own the production entry's renderer construction and the plane's
  animation frames. This record warms the rig's test renderer only; the
  production entry builds its renderer exactly as it does today.
- The plane's facts and the Seeded plane: the state's open, the seeding
  machinery, the Stub herdr world, and the ticket sources' doubles all stay
  per test. The pool reuses the renderer and the root, never the facts.
- The App's interface: no reset semantic is added, the App's boot props are
  unchanged, and the App learns nothing that production does not already
  run.
- The test runner's configuration: parallelism, per-file processes, and the
  test timeout budget stand. The pool stands inside the file's process; it
  neither needs the runner to change nor changes what the runner schedules.
- The one-shot boot read and the initial load settle: ADR 0129 and ADR 0154
  stand. The pool changes which renderer the frames land on, not when the
  load settles or what the boot read reads.

## Further Notes

**The measured figures, and what this decision does not buy.** One process,
32-core machine, the rig's fixed 120 by 30 test terminal, the installed
renderer: the file's first boot takes 63 ms (the state's open and the
seeding 8 ms, the renderer's one-time initialization and the root and the
mount 35 ms, the first flush after the one-shot boot read 18 ms); a
steady-state cold boot takes about 30 ms (the state 5 ms, the test renderer
and the root and the mount 7 to 10 ms, the first flush 16 to 18 ms); the
same App remounted under a warm renderer and a warm root takes about 17 ms,
the state's open included, and paints the full 30-line frame. The pool
warms the renderer-and-root piece, about 8 to 13 ms per test, and the
boot's dominant line, the one-shot boot read's first flush, stands per test
warm or cold, as does the state's open. The suite's wall time stands on the
rig's waits, about 3,000 sites polling every 10 ms, which this decision
does not move. The saving is a few seconds of suite CPU on this machine, and
the decision's case is structural, not the milliseconds: a file's tests
sharing one renderer and one root is the deep one-shot interface the sibling
deepening needs, and its deletion is felt in every file, because the fill
step is the pool.

**Why unmount and remount, precisely.** The App derives its internals, the
screen stack, the coordinator, the loops, once from its boot props on
mount, and the production entry builds the App once per run and never swaps
a mounted App's facts. A reseed-while-mounted design would add that swap to
the App's interface, and every internal that holds a fact would need a reset
path the plane must support forever, for a measured 12 ms. The unmount and
the remount reset all of them with the one mechanism the App already runs,
and they make the cold path and the warm path differ in exactly one fact,
whether the renderer and the root are new, so the rig's same-frames pin
checks the pool's only new behavior.

**The pool's scope tracks the process it rides on.** The test runner gives
each file its own process, and a pool cannot cross a process. The scope is
therefore the file, and the test author names nothing: the named world spec
in, the working App out. If the runner's isolation changes, the scope
re-derives from the process the pool rides on; it does not become a choice
the test author makes, because a choice would let two tests in one process
share a renderer in ways the fresh-plane rule exists to prevent.
