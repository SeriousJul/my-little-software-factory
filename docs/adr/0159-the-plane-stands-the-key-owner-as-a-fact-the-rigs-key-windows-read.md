# ADR 0159: The plane stands the key owner as a fact the rig's key windows read

Status: accepted

Date: 2026-11-14

Records that the plane stands the key owner as a fact the rig's key
windows read: which surface of the plane owns the keys, or no surface. The
owner is the shell's own dispatch fact, the active Interaction mode, or no
surface, and the plane stands it the way it already stands the shell's
other facts. The rig's key ownership windows resolve on the fact, keep
their names and named outcomes per ADR 0156, and retire the bus walk from
the windows' path where the fact names the owner completely. The rig keeps
on the key bus what the fact cannot say: the registrations the bus still
holds after a close, and the stale-claim dispatch to the handler a closed
surface left there.

## Context

The operator sees nothing, and the cost of the walk is the rig's. The
rig's key ownership windows are its own waits, not the operator's: after a
walk opens or closes a surface, the rig waits for the surface's key
ownership to settle with it, and for a closed surface to give the keys
back. ADR 0128 counted the windows in the census it keeps: 193 key-
ownership waits beside 875 frame waits, under the one liveness-aware
deadline of a 20 s window that holds for another window when the runner is
off schedule, under a 50 s outer bound. The owner the windows wait on is a
fact about the plane, and today the plane does not state it to the rig.

Today the rig finds the owner by walking the renderer's key bus. A second
polling loop stands beside the frame poll, at its 10 ms cadence, and reads
the bus's subscription list until it names the surface that owns the keys.
A standing watcher on the bus's listener registration witnesses a surface
take the keys even when it gives them back before the wait's first poll.
The base snapshot, the left-behind handler read, and the stale-claim
dispatch keep a press from landing on a surface that no longer owns the
keys: the walk's Enter, dispatched to the handler a closed surface left on
the bus, must be refused by the surface's guard, which runs no behavior
and reports nothing (issue #317). The walk works, and it is the rig's
knowledge of the bus's structure, not the plane's knowledge of itself.

The owner the walk walks to is the shell's own dispatch fact. The shell
routes every key by a rule it already runs: a standing overlay - the
Consultation launcher, the utility views, the override panel, the action
modals - owns its keys, and the shell keeps only the emergency exit; the
response editor of an open detail owns every other key; the Agent terminal
owns its keys; and the Main view's active screen answers through the
Control catalogue on the shared dispatch hook every surface uses. The
owner is the active Interaction mode, or no surface: the active screen of
the screen stack, an open modal, the open detail, the Consultation
launcher, the override panel, the Agent terminal, the Key guide, the
Message view, or nothing standing. The key bus stands on the renderer, the
renderer the rig owns under test, and the production entry's renderer
stands beside it through the renderer adapter of ADR 0145. The walk
crosses down into the renderer's internal structure to learn a fact the
shell already knows.

The walk is a shallow stand for a deep fact. Its knowledge lives in the
rig: the rig knows how the bus registers a handler, how it announces a new
listener, and how it compares handlers by identity, and every change to
the shell's dispatch that moves ownership can only be pinned by the rig
re-walking the bus. The plane knows the owner the moment the shell's
dispatch state settles, because the owner is that state under the rule its
dispatch runs. ADR 0156 stands the frame-pass resolution around the
windows and keeps their names and named outcomes; ADR 0157 remounts the
App per test on the warm renderer, and the fact must stand on the mounted
App's surface state the pool resets. The walk itself is the seam this
record settles.

## Decision

- The plane stands the key owner as a readable fact: which surface of the
  plane owns the keys, or no surface. The owner is the shell's own
  dispatch fact, the active Interaction mode, or no surface: the active
  screen of the screen stack, an open modal, the open detail, the
  Consultation launcher, the override panel, the Agent terminal, the Key
  guide, the Message view, or no surface standing. The shell computes the
  fact from its own dispatch state, by the same rule its key dispatch runs
  to route the key, and it stands the fact on the plane the way the plane
  already stands the shell's other facts: the mode the Action bar states,
  the hints the bar carries, and the surface the frame names. The Seeded
  plane record stands the fact beside the facts it already holds.
- The rig's key ownership windows keep their names and their named
  outcomes, per ADR 0156: opens, closes, refuses, shows, hides, moved,
  quiet. A window's body checks the fact on the renderer's frame passes
  once ADR 0156 lands, and on the rig's standing poll until then, and it
  ends when the fact names the surface the window wants. The poll that
  reads the fact runs the same settle in its own turn that the frame poll
  already runs: the flush a commit queues lands on the scheduler's clock,
  not on any frame (issue #311), and a fact read before the flush lands
  would settle on the owner the commit was about to move.
- The second polling loop the rig ran beside the frame poll, walking the
  bus's subscription list to find the owner, retires from the windows'
  path, and one loop stands where two stood. The standing watcher on the
  bus's listener registration retires as the owner witness, and the
  plane's record takes its place: it stands the owners the fact has stood
  since a named snapshot, so a surface that took the keys and gave them
  back before the wait's first read still leaves its mark, and a walk that
  never stood the opened surface's owner has no release to wait for. The
  release window's "proved nothing" refusal reads that standing and says
  so out loud, as it does today.
- The bus walk retires from the windows' path where the fact names the
  owner completely. What the fact cannot say stays named and stays on the
  key bus: the fact settles on the shell's dispatch state, and it projects
  neither the registrations the renderer's key bus still holds after a
  close, nor what a key delivered to a registration the plane no longer
  routes will do. Between the fallback frame and the close's cleanup
  landing, the closed surface's handler can still stand on the bus, and a
  key delivered there is the stale claim the surface's guard must refuse.
  The rig keeps the base snapshot, the left-behind handler read, and the
  stale-claim dispatch, the walk's Enter to the left-behind handler, whose
  refusal the guard answers.
- The key owner fact is a test-side projection on the plane. The
  production shell's key dispatch stands exactly as it stands: the shell
  keeps the keys, the paint, and the screen stack per ADR 0155, and no
  production interface gains a field for the test's benefit. The shell's
  dispatch hook, its report sinks, and the renderer's key bus stand
  unchanged. The record moves the rig's discovery cost, and nothing the
  operator drives.
- Under the warm rig pool of ADR 0157, the owner fact resets per test with
  the App's tree, which the pool remounts per test on the warm renderer.
  The pool's warm pieces, the test renderer with its terminal and its
  screen model, the App's root, and the frame event witness, hold no
  dispatch state and no registration of the predecessor: the unmount runs
  every surface's cleanup, and a window under the pool reads the current
  test's owner, never the predecessor's. A test that takes no pool reads
  the fact cold, exactly as its bus walk stands today.
- This decision is order-safe with ADR 0156 and ADR 0157 in both
  directions. Both are recorded on this tree and not yet implemented;
  their issues are open. If ADR 0156 lands first, the windows' checks run
  on the renderer's frame passes and read the fact there. If this record
  lands first, ADR 0156's frame-pass resolution applies to the same
  windows unchanged, and the fact stands on the mounted App's surface
  state, which ADR 0157's pool remounts per test. ADR 0158's static key
  and hint table stands on the catalogue and the mode, and the owner fact
  stands beside it: the table is static per setup, and the owner changes
  mid-test. ADR 0150's screen stack, when it lands, stands the owner's
  base surface, the active screen the stack holds.
- The owned surface grows and never shrinks. The architecture test's
  closed floor and counter walk stand, and the fact is one more owned fact
  beside the facts the plane already stands.
- The deletion test: deleting the fact returns the walk to the rig. The
  windows read the renderer's key bus structure again, the second polling
  loop stands beside the frame poll, the standing watcher stands on the
  bus's listener registration, and the knowledge of what owns the keys
  stands in the rig instead of at the seam.

## Considered options

- Keep the rig's bus walk and watcher (status quo): the poll keeps walking
  the subscription list at its 10 ms cadence beside the frame poll, and
  the watcher keeps witnessing the registration. Rejected: it stands a
  second polling loop per key operation across the 193 windows ADR 0128
  counted, it keeps the discovery knowledge, what owns the keys, as the
  rig's knowledge of the renderer's internal structure, and every change
  to the shell's dispatch that moves ownership can only be pinned by the
  rig re-walking the bus, where a pin on the plane's fact would stand.
- Let the rig watch the bus's listener registration instead of polling it:
  the standing watcher alone carries the windows, and the poll retires.
  Rejected: the rig still knows the bus's structure, the coupling moves
  from a poll to a subscription, the ADR 0128 census counts the windows
  either way, and the plane's fact, which the shell already computes to
  dispatch the key, is never stood at the seam the frame suites stand on.
- Stand the key owner as a production report sink of the shell, beside the
  list and status lines ADR 0155 names for the boot sequence module.
  Rejected: the report sinks are the plane's reports into the shell's
  paint, a production interface the test's fact borrows through; the plane
  is the seam the frame suites stand on, and the fact belongs on it, which
  keeps the production interface exactly as it stands.
- Let each key operation re-derive ownership from the frame it just read:
  the window parses the painted surface from the pixels of the last pass
  and ends when the pixels name the surface it wants. Rejected: the frame
  is the paint's output, and reading ownership back out of painted pixels
  is a walk of the paint, not of the dispatch; the fact stands one layer
  deeper than the pixels, in the shell's own dispatch state.

## Consequences

- The operator sees no change: the shell's key dispatch stands exactly as
  it stands, the operator's keys reach the same surfaces in the same
  order, and the emergency exit answers from every surface as it does
  today. The fact stands on the plane behind the frame the operator sees,
  and it changes nothing the operator drives.
- The machine: the rig runs one polling loop where it ran two. The
  windows' checks read the plane's fact on the rig's standing poll, and on
  the renderer's frame passes once ADR 0156 lands, instead of walking the
  renderer's key bus beside the frame poll. The discovery knowledge, what
  owns the keys, stands at the seam instead of in the rig: the plane is
  the deep module that knows its own dispatch state, and the rig is the
  shallow caller that reads the fact. A change to the shell's dispatch
  that moves ownership pins at the plane's fact, and the rig's leverage
  over the plane's behavior grows through the seam instead of through the
  bus's structure.
- The test: the frame suites pin the windows' named outcomes through the
  fact, the same outcomes ADR 0128's census counted, opens, closes,
  refuses, shows, hides, moved, quiet. A test author names a surface and
  an outcome, and the window's check reads the plane's standing of the
  owner beside the owners it stood since the snapshot. Under the warm rig
  pool the window reads the current test's owner: the App's tree remounts
  per test, and the predecessor's owner cannot stand warm. The
  architecture test's closed floor and counter walk stand, and the frame
  suites' call sites name no new key, no new predicate, and no new
  deadline.
- The test: the stale-claim check stands on the key bus as before. The
  fact settles on the dispatch state and says nothing the rig needs it to
  say about the registrations the bus still holds, so the rig keeps the
  base snapshot, the left-behind handler read, and the stale-claim
  dispatch, and a press still cannot land on a surface that no longer owns
  the keys.
- The glossary: the Interaction mode entry gains the fact, the plane
  stands the active Interaction mode as a fact the rig's key windows read,
  and the Frame rig entry's line on a surface's key ownership moves from
  the bus walk to the fact. Both entries land with the implementation, not
  with this ADR.
