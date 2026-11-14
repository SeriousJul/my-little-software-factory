# 0159: The plane stands the key owner as a fact the rig's key windows read

## Problem Statement

The frame rig drives a key before it knows which surface of the plane owns
the keys. Today it finds out by walking the renderer's key bus: a second
polling loop beside its frame poll, at its 10 ms cadence, reads the bus's
subscription list until it names the surface that owns the keys; a
standing watcher on the bus's listener registration witnesses a surface
take the keys even when it gives them back before the wait's first poll;
and the base snapshot, the left-behind handler read, and the stale-claim
dispatch keep a press from landing on a surface that no longer owns the
keys. ADR 0128 counted the windows in the census it keeps: 193 key-
ownership waits beside 875 frame waits, under the one liveness-aware
deadline of 20 s under a 50 s outer bound. The operator sees nothing in
any of it; the cost of the walk is the rig's.

The walk is the rig's knowledge of the bus's structure, not the plane's
knowledge of itself. The owner the walk walks to is the shell's own
dispatch fact: the active screen of the screen stack, an open modal, the
open detail, the Consultation launcher, the override panel, the Agent
terminal, the Key guide, the Message view, or no surface. The shell
computes that fact the moment its dispatch state settles, because it
routes the key by it. The key bus stands on the renderer, one layer below
the shell's dispatch state, and the walk crosses down into the renderer's
internal structure to learn a fact the shell already knows. Every change
to the shell's dispatch that moves ownership can only be pinned by the rig
re-walking the bus, and the rig must know how the bus registers a handler
and how it announces a new listener.

The frame-pass resolution of ADR 0156 stands the windows' settle on the
renderer's frame passes and keeps the windows' names and named outcomes.
The warm rig pool of ADR 0157 remounts the App per test on the warm
renderer, and whatever fact the windows read must reset with the App's
tree and must not stand warm on the pool's warm pieces. The static key and
hint table of ADR 0158 stands on the catalogue and the mode, per setup,
and the owner, which changes mid-test as surfaces open and close, cannot
stand in that table. The walk itself is the seam this record settles.

## Solution

The plane stands the key owner as a readable fact beside the facts the
Seeded plane record already stands: the current owner, and the owners the
record has stood since a named snapshot. The owner is the shell's own
dispatch fact, the active Interaction mode, or no surface. The shell
computes the fact from its own dispatch state, by the same rule its key
dispatch runs to route the key, and it stands the fact on the plane the
way the plane already stands the shell's other facts: the mode the Action
bar states, the hints the bar carries, and the surface the frame names.
The fact is a test-side projection on the plane: the production shell's
key dispatch stands exactly as it stands, the shell keeps the keys per ADR
0155, and no production interface gains a field for the test's benefit.

The rig's key ownership windows keep their names and their named outcomes,
per ADR 0156: opens, closes, refuses, shows, hides, moved, quiet. A
window's body checks the fact on the renderer's frame passes once ADR 0156
lands, and on the rig's standing poll until then, and it ends when the
fact names the surface the window wants. The second polling loop the rig
ran beside the frame poll, walking the bus's subscription list to find the
owner, retires from the windows' path, and the standing watcher on the
bus's listener registration retires as the owner witness. The record's
standing of the owners since the snapshot takes the watcher's place: a
surface that took the keys and gave them back before the wait's first read
still leaves its mark, and a walk that never stood the opened surface's
owner has no release to wait for.

Where the fact names the owner completely, the bus walk retires from the
windows' path. What the fact cannot say stays named and stays on the key
bus: the registrations the renderer's key bus still holds after a close,
and what a key delivered to a registration the plane no longer routes will
do. Between the fallback frame and the close's cleanup landing, the closed
surface's handler can still stand on the bus, and a key delivered there is
the stale claim the surface's guard must refuse. The rig keeps the base
snapshot, the left-behind handler read, and the stale-claim dispatch on
the key bus for as long as the fact cannot say what they say. Under the
warm rig pool of ADR 0157 the owner fact resets per test with the App's
tree, which the pool remounts per test, and the pool's warm pieces hold no
dispatch state and no registration of the predecessor, so a window under
the pool reads the current test's owner, never the predecessor's.

## User Stories

1. As an operator, I want my keys to reach the surface that owns them
   after this record lands, so that the record changes nothing I drive.
2. As an operator, I want a key I send while a surface is closing to be
   refused by the surface's guard, so that a stale press runs no behavior.
3. As an operator, I want the emergency exit to answer from every surface,
   so that I can leave the plane from where I stand.
4. As the machine, I want the plane to stand the key owner as a readable
   fact, so that the rig's windows read the owner instead of walking the
   key bus's structure.
5. As the machine, I want the owner fact computed in the shell's own
   dispatch state, so that the fact stands one layer deeper than the
   pixels, in the dispatch, not in the paint.
6. As the machine, I want the second polling loop beside the frame poll to
   retire, so that a key operation settles on one loop where two stood.
7. As the machine, I want the owner fact to stand beside the mode and the
   hints the plane already projects, so that the plane's facts stand
   together on one record.
8. As the machine, I want the record to stand the owners the fact has
   stood since a named snapshot, so that a surface that took the keys and
   gave them back before the wait's first read still leaves its mark.
9. As the machine, I want the owner fact to reset with the App's tree on
   each test's remount, so that a window under the warm pool reads the
   current test's owner, never the predecessor's.
10. As the machine, I want the stale-claim dispatch to stay on the key
   bus, so that the rig still proves the closed surface's guard refuses
   the walk's key.
11. As the machine, I want the production shell's key dispatch to stand
   exactly as it stands, so that the record moves the rig's discovery cost
   and nothing the operator drives.
12. As the machine, I want no production interface to gain a field for the
   test's benefit, so that the test's concern stands on the test's seam.
13. As the machine, I want the owner fact to be order-safe with the frame-
   pass resolution of ADR 0156, so that either record can land first.
14. As the machine, I want the owner fact to stand on the mounted App's
   surface state, so that the warm rig pool of ADR 0157 remounts it per
   test.
15. As the test suite, I want the windows' named outcomes to stand through
   the fact, so that the outcomes ADR 0128's census counted pin unchanged.
16. As the test suite, I want a pin of the fact's projection that reads
   the shell's dispatch state in and the owner out, so that the projection
   pins as values without a terminal, a process, or a state file.
17. As the test suite, I want the architecture test's closed floor and
   counter walk to stand, so that the owned surface grows and never
   shrinks.
18. As the test suite, I want a warm-pool pin that a window under the pool
   reads the current test's owner, so that the predecessor test's owner
   cannot stand after the remount.
19. As the test suite, I want the release window's "proved nothing"
   refusal to read the record's standing, so that a too-late snapshot says
   so out loud.
20. As the test suite, I want the release window to end when the fact
   names the surface it wants, so that a release pins on the dispatch
   state, not on the bus's subscription list.
21. As the test suite, I want the stale-claim check to dispatch the walk's
   key to the left-behind handler and read the handler's word, so that the
   guard of the undrawn surface proves its refusal on the record.
22. As the test suite, I want the window's check to run on the renderer's
   frame passes once ADR 0156 lands, so that the record's two halves
   resolve on the same settle.
23. As the test suite, I want the window's check to run on the rig's
   standing poll until ADR 0156 lands, so that the record is order-safe in
   both directions.
24. As a test author, I want to name a surface and an outcome and have the
   window check the plane's fact, so that I name no bus, no subscription
   list, and no watcher.
25. As a test author, I want to take the snapshot before the surface opens
   and have the release window refuse a too-late snapshot out loud, so
   that my mistake says so instead of passing silently.
26. As a test author, I want a change to the shell's dispatch that moves
   ownership to pin at the plane's fact, so that I pin the change without
   re-walking the bus.
27. As a test author, I want the owner fact's projection to pin in the
   shell's own suite, so that a wrong projection fails where it is
   computed.
28. As a test author, I want the windows' names and named outcomes to
   stand unchanged, so that the walks I have written keep their words.

## Implementation Decisions

**The Seeded plane record stands the key owner fact.** The record gains
the current owner and the owners it has stood since a named snapshot,
beside the facts it already holds: the state file, the config, the home
and checkout directories, the Command runner double, the Ticket source
doubles, the clock, and the props the App boots from. The record takes its
snapshot in the base mode the walk returns to, beside the mode the plane
stands, and it stands the owner on every settle the rig runs after the
snapshot.

**The fact is the shell's own dispatch fact.** The owner is the active
Interaction mode, or no surface. The shell computes it from its own
dispatch state, by the same rule its key dispatch runs to route the key: a
standing overlay owns its keys first, the open detail owns every other key
of its surface next, the Agent terminal owns its keys, and the Main view's
active screen answers through the Control catalogue. The rule is the guard
order the shell's dispatch already runs, and the fact names the surface
that rule names. The owner is never re-derived from the painted frame: the
frame is the paint's output, and the fact stands one layer deeper than the
pixels, in the shell's own dispatch state.

**The fact stands beside the plane's other facts.** The shell stands the
owner on the same projection it stands the mode, the hints, and the
surface the frame names, in the same pass that stands them, and the Seeded
plane record stands it on its record beside the facts the rig already
reads off the frame it settles.

**The windows keep their names and their named outcomes.** Per ADR 0156, a
window ends on one named outcome: opens, closes, refuses, shows, hides,
moved, or quiet. A window's body checks the fact on the renderer's frame
passes once ADR 0156 lands, and on the rig's standing poll until then, and
it ends when the fact names the surface the window wants. The poll that
reads the fact runs the settle in its own turn that the frame poll already
runs, so a fact read before a queued flush lands never settles on the
owner the commit was about to move.

**The bus walk retires where the fact names the owner completely.** The
second polling loop the rig ran beside the frame poll, at its 10 ms
cadence, walking the key bus's subscription list to find the owner,
retires from the windows' path. The standing watcher on the bus's listener
registration retires as the owner witness, and the record's standing of
the owners since the snapshot takes its place, so a surface that took the
keys and gave them back before the wait's first read still leaves its mark
on the standing.

**The rig keeps on the key bus what the fact cannot say.** The fact
settles on the shell's dispatch state, and it projects neither the
registrations the renderer's key bus still holds after a close, nor what a
key delivered to a registration the plane no longer routes will do. The
rig keeps the base snapshot, the left-behind handler read, and the stale-
claim dispatch, the walk's Enter to the left-behind handler, whose refusal
the guard of the undrawn surface must answer. The stale-claim dispatch
keeps the walk's key plain: an Enter with no modifier, the key the rows
confirm on.

**The owner fact resets per test with the App's tree.** Under the warm rig
pool of ADR 0157, the owner stands on the mounted App's surface state, and
the pool remounts the App per test on the warm renderer. The pool's warm
pieces, the test renderer with its terminal and its screen model, the
App's root, and the frame event witness, hold no dispatch state and no
registration of the predecessor: the unmount runs every surface's cleanup
and stops the App's loops with the teardown handle, and a window under the
pool reads the current test's owner, never the predecessor's.

**The production interface gains no field for the test's benefit.** The
production shell's key dispatch stands exactly as it stands: the shell
keeps the keys, the paint, and the screen stack per ADR 0155, and the boot
sequence stands as ADR 0155 records it. The shell's dispatch hook, its
report sinks, the renderer's key bus, and the held loop policy stand
unchanged, and the plane's production behavior is identical before and
after the record lands.

**The record is order-safe with its siblings.** ADR 0156 and ADR 0157 are
recorded on this tree and not yet implemented; their issues are open. If
ADR 0156 lands first, the windows' checks run on the renderer's frame
passes and read the fact there; if this record lands first, ADR 0156's
frame-pass resolution applies to the same windows unchanged. If ADR 0157
lands first, the fact stands on the mounted App's surface state the pool
remounts per test; if this record lands first, the pool's reset takes the
owner fact with the App's tree, as this record names. ADR 0158's static
key and hint table stands beside the owner fact: the table names what the
plane paints, and the fact names what the plane routes.

## Testing Decisions

A good test pins external behavior at the seam. The seams this record
stands on are the plane's record and the rig's windows: the Seeded plane
record gains the key owner fact beside the facts it already stands, and
the rig's key ownership windows keep their names and named outcomes while
their bodies resolve on the fact. Prior art names the pins: the frame
suites, which pin the windows' named outcomes through the plane; the
plane's fact-projection pins, which read the shell's standing as values
without a terminal, a process, or a state file, the way the boot-sequence
module's suite pins its decisions as values; and the architecture test,
whose closed floor and counter walk stand the owned surface.

- **The frame suites pin the windows' named outcomes through the fact.** A
  walk that opens a surface ends when the fact names the opened surface,
  and a walk that closes it ends when the fact names the surface it
  returns to. The outcomes ADR 0128's census counted, opens, closes,
  refuses, shows, hides, moved, quiet, pin unchanged, and the frame
  suites' call sites name no new key, no new predicate, and no new
  deadline.
- **A pin of the fact's projection.** The projection reads the shell's
  dispatch state in and names the owner out, the active Interaction mode
  or no surface. The pin runs without a terminal, a process, or a state
  file, beside the plane's other fact-projection pins: it names the
  dispatch state it drives, the owner the projection stands, and the order
  the projection runs, a standing overlay first, the open detail next, the
  Agent terminal, the Main view's active screen, and no surface when
  nothing stands.
- **A pin of the record's standing.** The record stands the owners the
  fact has stood since a named snapshot, and a surface that took the keys
  and gave them back before the wait's first read leaves its mark on the
  standing. The pin takes the snapshot in the base mode, opens and closes
  the surface inside one settle, and reads the standing: the release
  window's "proved nothing" refusal reads that standing, so a too-late
  snapshot says so out loud.
- **The architecture test stands the closed floor.** The owned surface
  grows and never shrinks, and the fact is one more owned fact beside the
  facts the plane already stands. The counter walk gains the owner fact's
  standing beside the facts it already counts.
- **A warm-pool pin.** Two tests run on the warm pool back to back, and
  the second test's window reads the current test's owner: the predecessor
  test's owner cannot stand after the remount, because the App's tree
  remounts per test and the pool's warm pieces hold no dispatch state and
  no registration of the predecessor.
- **The stale-claim pin stands on the key bus, as before.** The rig
  dispatches the walk's Enter to the left-behind handler and reads the
  handler's word: the guard of the undrawn surface refuses the key, runs
  no behavior, and reports nothing, and a live handler claims the same
  key. The pin names the surface it closed and the one registration its
  dispatch left on the bus.

## Out of Scope

- The production shell's key dispatch stands exactly as it stands; the
  record changes nothing the operator drives.
- The shell keeps the keys per ADR 0155: the boot-sequence module owns the
  plane's boot order and its teardown, and the shell keeps the paint, the
  keys, and the screen stack.
- The frame-pass resolution of the rig's waits is ADR 0156's record: this
  record stands the fact the frame passes read, and it keeps the windows'
  names and named outcomes for that resolution to take.
- The boot price is ADR 0157's record: the warm rig pool's remount, its
  warm pieces, and the per-test reset of the plane and the App's tree
  stand there; this record names what the reset takes and what the warm
  pieces must not leak.
- The static key and hint table is ADR 0158's record; the owner fact
  stands beside it, and neither table moves the other.
- The window names and the named outcomes never shrink: opens, closes,
  refuses, shows, hides, moved, quiet stand. No production interface gains
  a field for the test's benefit.

## Further Notes

- **Order safety with ADR 0156.** The windows keep their names and named
  outcomes, and the two records resolve on each other's settle. If ADR
  0156 lands first, the windows' checks run on the renderer's frame passes
  and read the fact there, and the standing poll retires as the settle's
  witness. If this record lands first, the poll that reads the fact is the
  same poll ADR 0156's resolution retires, and the frame-pass resolution
  applies to the same windows unchanged. Both are recorded on this tree
  and not yet implemented; their issues are open.
- **Order safety with ADR 0157.** The owner fact stands on the mounted
  App's surface state, and the pool remounts the App per test on the warm
  renderer. The pool's warm pieces hold no dispatch state and no
  registration of the predecessor, so the record is order-safe in both
  directions with the pool: if the pool lands first, the fact resets per
  test with the App's tree, and if this record lands first, the pool's
  reset takes the fact with the tree it already resets.
- **What the fact cannot say, named.** The fact settles on the shell's
  dispatch state, and it projects neither the registrations the renderer's
  key bus still holds after a close, nor what a key delivered to a
  registration the plane no longer routes will do. Between the fallback
  frame and the close's cleanup landing, the closed surface's handler can
  still stand on the bus, and a key delivered there is the stale claim the
  surface's guard must refuse (issue #317). The rig keeps the base
  snapshot, the left-behind handler read, and the stale-claim dispatch on
  the key bus for as long as the fact cannot say what they say.
- **The elision branch agrees.** A surface that opened and closed in a
  render the plane never drew never stood its owner: no commit drew it,
  its dispatch never stood on the plane, and its handler never joined the
  bus. The record's standing catches it, and the release window refuses it
  out loud, the way it refuses a too-late snapshot.
- **The deletion test stands.** Deleting the fact returns the walk to the
  rig, and the knowledge of what owns the keys stands in the rig instead
  of at the seam.
