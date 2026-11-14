# 0158: The frame rig derives the plane's key and hint facts once per setup

## Problem Statement

The operator reads the plane through the frame suite's verdict, and the
operator pays the suite's wall time and the CPU it spends. What the operator
does not pay is the plane's paint: the production paint path, the shell's
hint painting through the shared presentation module, stands exactly as it
stands, and a frame the plane paints for the operator is the frame the frame
suite pins. The cost this record moves is the machine's cost on the test
seam: the CPU the frame rig spends re-deriving the plane's static key and
hint facts, on every key operation it drives and on every frame it reads.

Every key operation the rig drives re-derives the facts from the Control
catalogue beside the plane's config record: which controls the plane paints,
their key labels, the key labels the frame paints, which hint each row or bar
owns, the bar's hints, the facts the shared-hint guard reads, and the
display-only key labels. Every frame the rig reads to resolve an operation
pays the same derivation beside the frame read. The census ADR 0128 counted
for this seam stands in the thousands: 875 frame waits and 1,888
hand-written wait descriptions behind the key operations that pay the
derivation, and the 193 key-ownership waits that stand on the ownership
read. And the suite's wall time stands on the rig's waits, about 3,000 wait
sites polling every 10 ms, so the derivation pays on the machine's dominant
cost, beside the waits it shadows.

The facts are static per setup. They stand on facts that change per setup -
the config record, the standing, the world spec, the plane record - and they
do not change per press or per frame: a press that sends the bar's key for a
control does not repaint the catalogue, and a frame the plane owes stands on
the same controls the previous press resolved. One of the facts already
stands on the deep side: the display-only key labels are derived once from
the catalogue's standing facts, memoized, and the parser answers its
per-hint read from that one derivation. The pattern is proven at one fact,
and this record generalizes it to the whole table: the rig derives the table
of the plane's static key and hint facts once per setup, at the rig's boot
call, from the named world spec and the plane record the call takes, and the
operations and the frame reads read them.

Every reader of the plane's key and hint facts pays the derivation it
needs. The resolution of an operation reads which controls the frame's bar
paints, which hint each paints, and which hint the operation's control
owns, and the shared-hint guard reads the co-owners the catalogue names for
a hint the bar painted more than once. The guide reads the control's
aliases, the escape operations read their keys, and the press-until re-reads
the bar it paints on every press it re-sends. The closed walk of the bar, the
walk of the bar's owners, and the display drift each pay their own copy of
the same catalogue walk beside the frame they stand on. What the table
gathers is this set of readers: one derivation per setup, and a read from
it for every press and every frame.

Deleting the table returns the per-operation derivation to every key
operation and every frame read, and the suite feels it as CPU on its
dominant cost. That is the shape of the deepening this record names: the
table is small, and its absence is the cost the suite pays per press and per
frame across the census ADR 0128 counted in the thousands.

## Solution

The frame rig derives the table of the plane's static key and hint facts
once per setup, at the rig's boot call, from the named world spec and the
plane record the call takes. The table's contents are the facts the
operations and the frame reads use: which controls of the Control catalogue
the plane paints, and the modes each runs in; each control's key labels, the
frame's exit key read off the plane's config record among them; the key
labels the frame's Action bar paints, and the hint each paints; which hint
each control's rows or bar owns on each mode; the bar's hints, and the facts
the shared-hint guard reads from them; and the display-only key labels, the
labels the catalogue paints for a control that claims no key.

The per-press and the per-frame paths read the table and derive nothing. The
named key operations keep their names, their fields, and their named
outcomes, and their bodies read the table; the settle still settles the
plane to a frame the plane owes, and the resolution of that frame reads the
table. A setup is the test's mounted plane. Under the warm rig pool of ADR
0157 a setup is per test, because ADR 0157 resets the plane's facts per
test, so the table derives per test against that test's facts and never
crosses a test or a setup; on the per-test cold boot of today, per setup
means per test as well. The rig's boot call keeps its shape, no call site
changes a line, and the production paint path stands exactly as it stands:
the record moves the derivation cost of the test seam, and nothing in the
operator's plane.

## User Stories

1. As the operator, I want the frame suite to spend its time on the plane under test and not on the rig re-deriving facts the setup already stands on, so that the review time I wait on shrinks.
2. As the operator, I want the production plane's keys and hints to stand exactly as they stand, so that how the rig reads its facts changes nothing on the screen I read.
3. As the operator, I want a red frame suite to name a plane fact or a frame fact, so that the fix stands on the plane I run.
4. As the operator, I want the suite's CPU to stand on the plane's waits and paints, so that a slow machine slows the suite for the plane's work, not the rig's bookkeeping.
5. As the machine, I want to derive the plane's key and hint facts once per setup, at the boot call, so that a press and a frame read cost a table read, not a derivation.
6. As the machine, I want the table to stand on the named world spec and the plane record the boot call takes, so that the facts I derive are the facts the mounted plane stands on.
7. As the machine, I want the table to hold the controls the plane paints, their key labels, the key labels the frame paints, the hints each row or bar owns, the bar's hints, the shared-hint guard facts, and the display-only key labels, so that the press, the guard, and the walk read one table.
8. As the machine, I want the frame's exit key to stand on the plane's config record, so that the table names the key the frame will paint.
9. As the machine, I want the per-press path to read the table and derive nothing, so that a press costs the key send and the wait, not the catalogue walk.
10. As the machine, I want the per-frame path to read the table and derive nothing, so that a frame the plane owes costs the paint and the read, not the derivation beside them.
11. As the machine, I want one table per setup instead of one memo per fact, so that the knowledge of which facts are static stands in one place.
12. As the machine, I want a setup change to derive a new table rather than invalidate a cache per fact, so that invalidation stands at the derivation and nowhere else.
13. As the machine, I want the display-only key labels to stand in the table beside the other facts, so that the pattern that already stands on the deep side names the shape of the whole table.
14. As the machine, I want the table per test under the warm rig pool, against that test's config record, standing, and world, so that two tests in one file never share a table the way they never share a state.
15. As the machine, I want the table never to cross a test or a setup, so that a frame the warm remount paints reads the facts of the plane it stands on.
16. As the machine, I want the boot call to keep its shape while it derives the table, so that the table is the call's internal deepening and not a second seam beside it.
17. As the machine, I want the table to cost one derivation per test behind the rig's waits, so that my wall time stands on the waits, as it does.
18. As the test suite, I want my same-frames pin to stand with the table, so that the pool and the cold boot cannot drift my frames from the frames the rig paints and reads.
19. As the test suite, I want my named outcomes, my named key operations, and my immediate press to stand unchanged, so that no pin changes meaning when the rig reads its facts from the table.
20. As the test suite, I want a pin of the table's contents against a fixed setup, read as values with no terminal, process, or state file, so that the derivation stands on a pin the way the startup module's suite pins its decisions.
21. As the test suite, I want my closed walk of the bar to keep walking, so that a painted hint the catalogue does not own still breaks the walk.
22. As the test suite, I want my shared-hint guard to keep naming its co-owners, so that a hint two on-bar controls can both paint still fails the press it would not own.
23. As the test suite, I want my architecture test's closed floor of owned suites and my counter walk to stand, so that the owned surface grows and never shrinks as the table lands.
24. As the test suite, I want my call sites to change no line, so that the table lands behind the seam I already cross.
25. As the test suite, I want my per-test facts to stand on the table derived for that test, so that my frame never reads a fact the previous test's setup stood on.
26. As the test suite, I want the frames I pin to be identical with the table, so that a frame the table's derivation moved is a frame the pin catches.
27. As the test suite, I want the table's readers to keep their failure words, so that a press that fails on the table's read names the control, the hint, and the key the read answered.
28. As a test author, I want to name a control and an outcome and not the table, so that my test stands on the rig's interface and not on its internals.
29. As a test author, I want a key operation I add to the rig to read the table instead of re-deriving the facts, so that the operation does not re-pay the derivation on every press it serves.
30. As a test author, I want the table to stand where the display-only labels stand, so that one pattern names the shape of a fact that is static per setup.
31. As a test author, I want the production paint path to stand exactly as it stands, so that a test-side change cannot move what my frame pins on the operator's screen.
32. As a test author, I want this record to be order-safe with the frame-pass record and the warm pool record, so that it lands before or after either and the seams both records deepen stand.
33. As a test author, I want the table to be small, so that the cost it saves per press and per frame stands beside the rig's waits as a line behind them.
34. As the machine, I want the table to die with the setup that derived it, so that the warm remount of the next test derives the next table before the test's first press.
35. As the test suite, I want my display drift, my closed walk of the bar, and my walk of the bar's owners to read the table, so that each of them stops paying its own copy of the catalogue walk.
36. As the test suite, I want the frame's painted hints matched against the table's hints, so that the resolution of a frame the plane owes reads the facts the frame stands on.
37. As the machine, I want the guide to read the control's aliases from the table, so that a key the catalogue names nowhere for the control still fails the press the way it does today.
38. As the machine, I want the escape operations to read their keys from the table, so that the catalogue walk they pay per operation stands once per setup.
39. As a test author, I want the table's contents named in this spec, so that I can see which facts are static per setup and which facts stand per frame.

## Implementation Decisions

- The frame rig. The rig derives the table of the plane's static key and
  hint facts once per setup, at its boot call, from the named world spec and
  the plane record the call takes. The table's contents: which controls of
  the Control catalogue the plane paints, and the modes each runs in; each
  control's key labels, the frame's exit key read off the plane's config
  record among them; the key labels the frame's Action bar paints, and the
  hint each paints; which hint each control's rows or bar owns on each mode;
  the bar's hints, and the facts the shared-hint guard reads from them; and
  the display-only key labels, the labels the catalogue paints for a control
  that claims no key. The table is the rig's resolution of which of the
  plane's facts its operations and frame reads use, and it stands at the
  rig: the production shell's paint of the same facts, through the shared
  presentation module, stands exactly as it stands.

- The named key operations. The press, the guide, the page, and the
  press-until keep their names, their fields, and their named outcomes, and
  their bodies read the table. The press resolves its control against the
  table's hints, reads a hint's ownership off the table, and reads the
  shared-hint guard's co-owners from the table. The guide reads the
  control's aliases from the table, and a key the table names nowhere for
  the control fails the press the way it does today. The page resolves its
  keys against the table's bar facts, the press-until re-sends on the
  table's read of the bar it paints, and the escape operations read their
  keys from the table the same way the catalogue gave them before. The
  immediate press and the key-ownership window stand as ADR 0128 left them.

- The frame reads. The settle still settles the plane to a frame the plane
  owes, and the resolution of that frame reads the table: the bar's painted
  hints are matched against the table's hints, a hint's ownership is read
  off the table, and the shared-hint guard reads its co-owners from the
  table. The frame-dependent reads stay per frame: the surface the frame
  stands on, and the hints the frame's bar painted, are facts of the frame,
  and the frame the plane owes is the frame they stand on. What leaves the
  per-frame path is the catalogue derivation the path paid beside them: the
  controls, their key labels, and the ownership facts now read off the
  table.

- The setup and the table's lifetime. A setup is the test's mounted plane,
  and the table is per setup: it derives at the setup's boot call, and it
  dies with the setup. Under the warm rig pool of ADR 0157 a setup is per
  test, because the pool resets the plane's facts per test, so the table
  derives per test against that test's config record, standing, and world,
  and it never crosses a test or a setup. On the per-test cold boot of
  today, per setup means per test as well: the table the boot call derives
  stands for exactly the plane that call mounts. The warm remount of the
  pool derives the next test's table before the test's first press, beside
  the warm renderer.

- The display-only key labels stand in the table. They already stand on the
  deep side: derived once from the catalogue's standing facts, memoized, and
  read by the parser per hint. The table takes their place: the parser reads
  them from the table, and the one memo per fact gives way to one table per
  setup. The generalization runs in this direction and not the other: the
  alternative of one memo per fact scatters the invalidation knowledge
  across a cache per fact, and a setup change must invalidate every cache
  by hand.

- The boot call keeps its shape. The named world spec and the plane record
  in, a working App out; no call site changes a line. The table is the
  call's internal derivation against the record the call takes: it is the
  implementation of the seam the frame suites cross, not a second seam
  beside it, the same rule ADR 0157 applied to the pool behind the boot
  call.

- The scope of the decision is the test seam. It deepens the frame rig and
  the plane the frame suites drive through, and the production paint path,
  the shell's hint painting through the shared presentation module, stands
  exactly as it stands. The table is a fact the rig derives for its own
  operations; the operator's plane reads no table, and the operator's screen
  stands on the plane's paint alone.

## Testing Decisions

- A good test pins external behavior at the seam: the frames the rig paints
  and reads, the named outcomes the operations wait for, the failures the
  operations name, and the values the table's derivation answers. The
  table's internals are the implementation's, and the pin reads what stands
  at the seam.

- The frame suites. The frame suites of the Seeded plane drive the named key
  operations against the Stub herdr world and the stub sources, under the
  held loop policy the suite names. Their same-frames pin stands with the
  table: the frames the rig paints and reads are identical with it, so the
  warm rig pool and the cold boot cannot drift a suite's frames from the
  frames the rig reads. Prior art: ADR 0128's interface deepening left every
  suite's pins unchanged while the rig's owned surface grew, and ADR 0157's
  same-frames pin checks the pool against the cold boot the same way.

- The table's contents pin. The table's contents are pinned against a fixed
  setup, read as values with no terminal, no process, and no state file:
  the controls the plane paints and the modes they run in, their key labels,
  the display-only key labels, and the hints each control owns on each mode,
  against the config record and the standing the pin names. Prior art: the
  startup module's suite, which pins the startup module's decisions as
  values with no process and no pseudo-terminal in the way, the words and
  the order of them.

- The rig's own suite. The rig's own frame suite, head of the owned list,
  pins the table's readers: the resolution reads the table's hints, the
  shared-hint guard reads its co-owners from the table, the closed walk of
  the bar walks the table beside the frame, and the display drift, the
  display-only labels, and the label wordings stand on the table's contents.
  The suite's failure words stand: a press that fails on the table's read
  names the control, the hint, and the key the read answered.

- The architecture test. The architecture test's closed floor of owned suites
  stands: a suite that leaves the rig's named operations fails the floor,
  and the counter walk's number grows and never falls as the table's pin
  joins the owned list. Prior art: the floor and the walk that stood through
  ADR 0128's deepening of the input face and ADR 0157's landing of the warm
  rig pool.

## Out of Scope

- The production paint path: the shell's hint painting through the shared
  presentation module stands exactly as it stands. The table is a fact the
  rig derives for its own operations, and the plane the operator runs paints
  its keys and hints the way it does.
- The render-ask stack classification: it stands confined to the rig's two
  render-ask holds, per ADR 0156 - the hold that lets the plane's asks
  through and the hold that swallows every ask. This record does not
  propose replacing it, and the residual stack-walk cost inside the two
  holds stands per that record.
- The rig's waits: the settle, the frame waits, the frame poll, and the one
  deadline stand as ADR 0156 records them. This record moves the
  derivation cost beside them and moves no wait.
- The boot price: the test renderer, the App's root, the mount, and the
  one-shot boot read under the held loop policy stand as ADR 0157 records
  them. The table derives at the boot call against the record that call
  takes; it adds no boot stage and removes none.
- The table never crosses a test: no table is shared across tests or across
  setups, and the fresh-plane rule the Seeded plane stands on is untouched.

## Further Notes

- The residual stack-walk cost inside the two render-ask holds stands per
  ADR 0156: the holds still read the call stack to classify an ask's source,
  and this record does not touch that walk. The table lands beside the
  holds, and the two records' costs read clean of each other.
- Order-safety with ADR 0156: the table is derived at the rig's boot call
  against the record that call takes, and ADR 0156 resolves the rig's waits
  on the renderer's frame passes. The waits and the table meet only in the
  operations that read both, and each record's seams stand on the other's
  landing: this record landing first gives ADR 0156 operations that read the
  table when it deepens their waits, and ADR 0156 landing first gives this
  record waits that resolve earlier on the same operations that read the
  table.
- Order-safety with ADR 0157: under today's per-test cold boot, per setup
  means per test; under the warm rig pool, ADR 0157 resets the plane's
  facts per test, so the table is per test either way, and it is never
  shared across the file's tests. This record landing first gives the pool
  a table the pool's per-test reset re-derives, and the pool landing first
  gives this record a warm renderer beside which the table derives per
  test. The same-frames pin stands whichever order the records land in.
- The readers of the table are named at the seam: the resolution of an
  operation, the shared-hint guard, the guide, the page, the press-until,
  the escape operations, the closed walk of the bar, the walk of the bar's
  owners, and the display drift. Each of them reads the table and derives
  nothing; a reader that leaves the table re-pays the catalogue walk the
  table was gathered to end.
