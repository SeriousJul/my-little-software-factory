# ADR 0150: The screen stack holds one active screen, and a suspended screen runs nothing

Status: accepted
Date: 2026-11-14

Records that the plane holds exactly one active screen at a time. The shell
owns one screen stack module that owns the stack's record, the open, close,
and replace transitions, and the per-screen preserved facts. The contract it
states: a suspended screen runs nothing, it unmounts, it holds no timer, no
read, no spinner frame, and no key claim, and it resumes from the store plus
the stack's preserved facts on the same frame it was suspended on.

## Context

The operator works one terminal screen at a time, and the plane is one root
screen: overlays stand over it, and the screen beneath an overlay keeps
living. Its one-second reads of the Agent's pane keep running and keep asking
herdr through the plane's runner, its spinner faces keep stepping every
hundred milliseconds, and every one of those ticks commits at the root of the
plane's single tree, so the machine re-lays out the screen the operator reads
as well as the screen the operator does not see. The operator sees none of
this work: the screen above covers the screen below. The machine pays for it
all, a wake, a command to herdr, a pass over the whole tree, on every tick,
for as long as the operator reads the screen above. On a loaded machine those
background passes interleave with the active screen's frame waits, one of
the flake classes ADR 0128 records, and the test suite that measures the
active screen pays the same interleaving in its frame waits.

Meanwhile the plane's loops, the Observation cycle, the refresh schedule, and
the Handoff dispatch, keep working whether or not any screen shows their
results, and they must: the factory does not wait for the operator. The
distinction the deepening draws is between the loops and the screens: the
loops run through every transition on the cadence the boot record names, and
the screens stop when they are not the screen the operator reads.

Two facts make the deepening cheap. The unmount cleanups that already stop a
screen's subscriptions when it closes stand in every screen today; nothing
mid-run ever unmounts a screen, but the machinery that would stop it is
already there. And the key-ownership apparatus stands on stable wrappers: the
frame rig's four kept reads, keyBase, releaseKeys, leftKeyHandler, and
staleKeyClaim, survive a suspend and resume of a screen only if the key bus
holds one stable wrapper per screen slot, detached on suspend and re-attached
on resume.

## Decision

The shell gains one screen stack module. It owns three things and nothing
else: the stack's record (the ordered suspended screens, the Main view at the
bottom, the active screen at the top, one entry per screen), the transitions,
and the per-screen preserved facts.

- The screens of the stack are the Main view and the screens that open above
  it: the Consultation launcher, with the Replacement Consultation as the
  same screen in a second context, the Key guide, the Message view, the
  Decision modal, the Missing modal, the ticket and Consultation close,
  safety, recovery, force, and delete panels, the repository select, the
  repository init, the override panel, and the Live view. The response editor
  and the Agent terminal are modes of the Main view's detail pane: they are
  not screens of the stack, they suspend with the Main view, and their drafts
  and editing positions are preserved facts of the Main view. The Live view's
  sub-modes switch in place on the same surface (ADR 0040).

- The transitions: open puts the opened screen on top and suspends the
  screen that was active; an open of the screen that is already active
  updates that screen's fact in place (the guide's captured Interaction
  mode), never a second entry; an open of a screen the stack already holds
  at a lower level is refused, one entry per screen. Close removes the
  active screen and resumes the screen beneath it. Replace, the close of one
  screen immediately followed, in the same transition pass, by the open of a
  different screen (the decision route confirm that opens the routed ticket's
  Live view, the repository select's confirm that opens the repository
  init), swaps the top without resuming the screen beneath, so a screen that
  would be suspended again in the same pass is never remounted for nothing.

- Suspension is an unmount: the suspended screen's tree comes down, so its
  timers, its pane reads, its spinner frames, and its key wrappers stop by
  the standard effect cleanup, the same cleanup that already stops a
  screen's subscriptions when it closes. The decision of which screen is
  active is made in one place, the stack module. Rejected: the active screen
  fact that each screen's hook would consult, which scatters the stack's one
  decision across every screen's hooks and leaves a second shallow seam into
  the stack that a screen can drift from.

- The preserved facts are the screen-local facts the store does not hold:
  the Main view's selection, selected row, detail scroll, list filters,
  focused pane, section expansions, grouping folds, response draft and editor
  standing, Agent terminal standing, and the presented Consultation detail
  facts; the Live view's presented stream lines, stale note, body scroll, and
  ticket identity with its work cycle; the launcher's form draft, slot
  values, and replacement identity; the override panel's pending ticket,
  origin, and form values under the cursor; the panels' body scroll and row
  under the cursor; the repository panels' marked choices and body scroll;
  the Key guide's and the Message view's captured mode. Factory state is
  never a preserved fact: it comes from the store on resume, and the shell's
  standing facts, the last polled agents, the Auto-handoff mode, the config,
  and the message history, stand in the shell through every transition, so a
  screen resumed after a long suspend shows the factory's current state.

- Stale resume: a screen the stack resumes is checked against the store
  before it stands. A Live view whose ticket left the work cycle its screen
  stands on (ADR 0110) closes instead of resuming, the stack form of the
  rule ADR 0110 decided for the work cycle, and a resumed screen whose
  selected item left the factory's lists stands on the fact the store now
  answers, the same fallbacks the screen already derives today.

- The key-ownership contract: the active screen owns the keys, and a
  suspended screen claims none. The shell keeps its own base key
  subscription on the key bus through every transition with an identity that
  never changes, because the shell owns the emergency exit in every mode and
  the legacy keys of the base screen. The shared dispatch module deepens one
  rule: the key bus holds one stable wrapper per screen slot, not per
  mounting of a screen; suspend detaches the screen's wrappers, and resume
  re-attaches the same wrappers, so the rig's four kept reads keep their
  meaning across a suspend and resume. A screen's close gives back its keys
  in the commit that draws the resumed frame, and the stale-key guard stands
  unchanged: a key landed in the window between a closed surface's last frame
  and its key release claims nothing. The stack adds no key of its own,
  moves no control, and changes no hint (ADR 0014, ADR 0040).

- The loops, the shell, and the theme: the Observation cycle, the refresh
  schedule, and the Handoff dispatch are the plane's loops, owned by the
  shell under the named Loop policy (ADR 0129), and they run through every
  screen transition on the cadence the boot record names. Every screen, the
  base panes included, paints the Theme the environment resolved through the
  shared paint layer (ADR 0024). The two render sites stand as they stand:
  the production entry and the frame rig boot the same module from the same
  total Plane boot record (ADR 0129), and the stack is inside the module they
  both render.

- The stack refuses to hand the frame rig a live active-screen fact: the rig
  reads the active screen off the painted frame's markers, and the Action bar
  keeps being the fact the test reads (ADR 0128).

## Considered options

- Keep the base alive under the overlay (status quo): the machine pays for
  the work no one sees, on every tick, for as long as the operator reads the
  screen above.
- An inert screen that stays mounted: it still wakes, still asks herdr, still
  re-lays out the tree, and a test cannot distinguish it from a screen that
  runs nothing, the shallow form of the deepening.
- Each screen's hook asks an active-screen fact whether to tick: it scatters
  the stack's one decision into a second seam into the stack that every
  screen can drift from.
- Mount the overlay in a second tree or a second renderer scene: it breaks
  the one element tree the frame rig walks and the two-render-site invariant
  of ADR 0129.

## Consequences

- The operator: the same screens, the same keys, the same written words. A
  resume stands on the suspended frame without the pop-in of an opening, and
  a suspended screen owes no motion and no read.
- The machine: the plane's cadence is the active screen's cadence plus the
  loops' cadence, never the sum of the screens behind it. A suspended screen
  owes no wake, no herdr read, no spinner step, and no background commit
  interleaves with the active screen's frame.
- The loops are untouched: the factory keeps working, and the list the
  operator returns to already shows what happened.
- The test: "a suspended screen runs nothing" is the pair of measurements the
  frame rig's seam exposes, the runner's command list standing across a
  window longer than the suspended screen's tick period, and the painted
  frame standing across the same window. A resume is proven alive by the
  runner's list growing again and the frame showing the preserved lines. The
  rig's owned-surface floor grows with the new stack-behavior suites and
  never shrinks.
- The deepening is complementary with ADR 0149: after both land, the plane's
  paint cadence is a function of the one active screen plus the loops, and
  the frame module tunes that one screen's drawing without racing the ticks
  of the screens behind it.
- The glossary gains Screen, Screen stack, Suspended screen, and Preserved
  screen facts. These records land with the implementation, not with this
  ADR.
