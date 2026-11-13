## Problem Statement

The operator of the plane reads a correct screen: the plane's workaround for
the terminal's lost bytes (OpenTUI issue 1187) rewrites the whole screen on
every frame, and the screen converges to the renderer's model within one
frame of any byte loss. What the operator pays is at the edge of the screen.
Every frame, a spinner tick while a ticket starts, the Observation cycle's
report every 5 s, the Consultation view's body refresh and the Live view's
stream line every 1 s, the modal pop-in's frames, a key press, rewrites the
entire terminal. The renderer's own diff path, which writes only the cells
that changed, never runs. The operator cannot see the price; it stands on
the terminal's traffic, in the herdr pane the plane runs in, or in the
operator's terminal beside it.

The cost imposes itself on every other screen change. A screen the plane
adds, a liveness the operator wants, a detail that moves on a key press,
pays the full-screen price on every frame it stands, and the developer who
builds it cannot measure the price on the test renderer, which paints a
virtual screen and counts no bytes. The workaround is a private field the
entry module marks per frame; no module owns the answer to how much of the
screen a frame should rewrite, so no one can lower the price without
redesigning the very seam that holds the workaround.

## Solution

The plane's screen keeps converging within one frame of a lost byte, and
every other frame the plane draws writes only what changed. The decision of
how much a frame rewrites moves out of a private flag the entry module marks
per frame and into a policy that reads the frame's facts: the default is the
renderer's native diff, and a full rewrite stands only where the renderer's
model of the screen can be wrong, on the terminal resize, on output that
lands on the terminal outside the renderer, and on a detected byte-loss
signal. The policy stands in a renderer adapter module, the one module that
owns the renderer.

The operator's screen behaves exactly as it does today until a byte-loss
signal exists: the policy keeps the blanket force as an explicit fact the
entry module passes on every frame, so the drift class of OpenTUI issue 1187
keeps its insurance. When a signal stands and a terminal walk verifies it,
the entry module withdraws the force and hands the signal over, the policy
takes its default, and the screen's cost falls to the cells that change,
without the operator reading anything different.

## User Stories

1. As an operator of the control plane, I want the screen to show the same
   content after the repaint policy lands as it shows today, so that I read
   no change from the move and lose nothing I can see.
2. As an operator of the control plane, I want a lost byte of a frame to be
   healed by a full rewrite of the screen within one frame, so that no
   stale fragment of an earlier frame stands on the screen I read, for as
   long as no byte-loss signal exists.
3. As an operator of the control plane, I want a resize of my terminal to
   redraw the screen in full, so that the pane, the list, and the detail
   reflow on the new geometry and no fragment of the old geometry stands.
4. As an operator of the control plane, I want the spinner face to keep
   stepping beside its word while a ticket wears the Starting window, so
   that I keep the motion that names the window, and the tick costs the
   terminal only the glyph it steps once the blanket force lifts.
5. As an operator of the control plane, I want the plane's bell on a Fault
   to reach my terminal without disturbing the screen the renderer owns, so
   that the row I am reading does not shift when the bell rings.
6. As an operator of the control plane, I want a key press to change only
   what the key means on the screen, so that the screen answers my keys,
   and the terminal carries only the change the key made, once the blanket
   force lifts.
7. As an operator of the control plane, I want a modal pop-in, the Decision
   modal, the Live view, the Key guide, to settle on the body at its final
   width, so that what I read after the pop is the body it ends on.
8. As an operator of the control plane, I want the Consultation view's body
   to keep its refresh while the agent works, so that I read the answer
   live on the Consultation I opened.
9. As an operator of the control plane, I want the Live view's stream to
   keep its one-second line while the agent works, on herdr and on
   herdr-core, so that I keep the live body of the turn on either Agent
   host.
10. As the control plane itself, I want the repaint policy to be a function
    of the frame's facts, so that the screen's correctness stands on facts
    the entry module hands over, not on a private field marked per frame.
11. As the control plane itself, I want a spinner tick, a poll report, a
    stream line, and a key press to be each a decision of the policy, so
    that once the blanket force lifts each of them rewrites only the cells
    that changed.
12. As the control plane itself, I want the blanket force to stand as an
    explicit policy input until a byte-loss signal exists, so that the
    screen keeps its insurance on the drift class of OpenTUI issue 1187.
13. As the control plane itself, I want output that lands on the terminal
    outside the renderer and could paint a cell to force a full rewrite of
    the next frame, so that the renderer's model cannot skip a cell an
    outside writer touched.
14. As the control plane itself, I want the Observation cycle's report
    every 5 s to be a frame like any other through the policy, so that a
    poll that changed nothing on the screen rewrites nothing on it.
15. As the control plane itself, I want a probe failure's paint, the Stale
    Agent output note and the Stale source warning on the Message line, to
    go through the same policy as any other fact, so that a failure states
    itself on the screen like any other fact, with no special rewrite path.
16. As the control plane itself, I want the renderer's own model-rebuild
    facts, the resize, the capability answer, the resume from suspend, to
    stand in the policy's fact set, so that one module owns the answer to
    when the screen model can be wrong.
17. As a developer of the control plane, I want the policy to be a small
    function of the frame's facts inside the adapter module, so that I test
    every fact combination without a terminal: given the facts, I assert
    the diff or the full rewrite.
18. As a developer of the control plane, I want the frame rig to keep
    asserting the painted frames after the move, so that the paint-seam
    change is proven on the screen the plane paints, through the test
    renderer, without a real terminal.
19. As a developer of the control plane, I want the entry module to hold no
    renderer private and no per-frame callback, so that the workaround
    stands in the one module that owns the renderer, and the next screen
    change does not re-mark the private.
20. As a developer of the control plane, I want the lift of the blanket
    force to be the withdrawal of one policy input by the entry module, so
    that when a byte-loss signal stands, the policy itself changes nothing
    and the diff branch my tests already prove becomes the production path.
21. As a developer of the control plane, I want the terminal walk after the
    move, and after the lift, to name the renderer version and the terminal
    it ran on, so that the exit condition is measured on the machine it
    claims, the way the verification record recorded the workaround.

## Implementation Decisions

- New module: the renderer adapter module. It owns the renderer: it
  constructs the renderer from the entry module's boot facts (the terminal,
  and the renderer options the entry stands today: no exit on Ctrl+C, mouse
  reporting, the kitty keyboard names that back the Agent interaction
  mode's exits), it installs the frame callback that runs the policy, it
  reads the renderer's own events (the resize, the external output the
  renderer detects, the capability answer) as frame facts, and it stands in
  the entry module's shutdown order, so the renderer returns the terminal
  before the run ends.
- The repaint policy: a small function inside the adapter module. Its
  inputs are the frame's facts: the resize fact, an external output that
  could paint or move a cell, a byte-loss signal, and the blanket force.
  Its answer is the frame's rewrite scope: the diff, which writes only the
  cells that changed, or the full rewrite of the screen. The default is the
  diff; the full rewrite stands when any of the force facts stands. The
  adapter's frame callback evaluates the policy on every frame and applies
  the answer to the renderer's repaint state.
- The renderer's private repaint flag is the one private the adapter module
  owns. The adapter is the only module that touches it, and it sets it only
  when the policy answers full. That is the depth of the seam: the private
  is a leak of the renderer's internals, and it is owned by the one module
  that stands between the plane and the renderer; the entry module and the
  UI module never see it. The renderer exposes no public ask for a full
  rewrite, which is why the owner of the flag must be the owner of the
  policy.
- The seam sits in the entry module: the entry module is the module that
  stands beside the terminal and the App, and the adapter is its leaf. The
  entry module keeps the construction of the App and its mount on the
  renderer, the herdr identity report before the first frame (which writes
  to the Agent host through the command runner, not to the terminal, so it
  is no frame fact), and the run's shutdown order. It hands the adapter the
  frame facts it alone can know: the writes the plane makes on the terminal
  outside the renderer (the bell on a Fault, which paints no cell and
  forces no rewrite), a byte-loss signal when one exists, and the blanket
  force until then.
- What the blanket force becomes: a standing frame fact the entry module
  passes to the policy on every frame until a byte-loss signal exists. It
  is data the policy consumes, not a side effect the entry performs on the
  renderer. The entry module owns the fact, because the entry module owns
  the run's knowledge of the terminal's transport; the adapter owns the
  answer it gives the fact.
- The renderer's internal forces stand: the renderer already forces a full
  rewrite on the resize, the capability answer, and the resume from
  suspend, on its own. The adapter observes those events and records them
  in the policy's fact set, so the answer to when the model's trust is
  rebuilt stands in one module even if the renderer's internals move.
- What the UI module loses and gains: the UI module (the App and the screens
  it paints) keeps requesting renders and painting its facts into the
  renderer, exactly as it does today. It stops being responsible for the
  screen model's correctness: today that responsibility stands unnamed in
  the entry module's per-frame callback, which every commit of the UI
  module triggers; after the move it stands named, in the adapter's policy.
  The UI module holds no knowledge of the renderer's model before the move
  and holds none after it, and a commit of the UI module costs the screen
  its changed cells once the blanket force lifts.
- The exit condition for lifting the blanket force: it lifts when a
  byte-loss signal exists and stands verified on the plane's own screens.
  The signal is a detection of the drift class of OpenTUI issue 1187 in a
  release of OpenTUI the plane installs, or a terminal-level probe the
  plane can read. A terminal walk on the installed renderer and on the
  terminals the verification record of the shared controls names must show
  a diffed frame healing a lost byte within one frame and no stale row
  standing behind a selection. At the lift, the entry module stops passing
  the blanket fact and hands the signal to the adapter, and the policy
  takes the signal the way it already answers the other force facts; the
  policy is unchanged by the lift.
- The interactions are unchanged on the renderer side: the UI module's
  commits (the spinner tick, the poll report, the stream line, the pop-in
  frames, the key press) keep requesting renders on the renderer, and the
  renderer keeps painting on invalidation. The only thing that moves is
  what the paint writes: the whole screen while the blanket force stands,
  the changed cells once it lifts.

## Testing Decisions

- What makes a good test here is external behavior only, in two shapes.
  First, the policy is a function of the frame's facts: a test names the
  facts (no force fact; the resize; an external output that could paint a
  cell; the bell alone; a byte-loss signal; the blanket force; any
  combination of them) and asserts the rewrite scope the policy answers:
  the diff on no force fact, the full rewrite on any force fact. Second,
  given the plane's actions, the screen shows the right content on the
  painted frame: the spinner face beside its word, the Observation cycle's
  report on the list and the section headers' counts, the Consultation
  view's body and the Live view's stream under a working agent, a modal
  pop-in settling on the final body, a key press's effect, the resize
  reflow, and a probe failure's note on the Message line. The frame rig's
  waits end only when the effect appears on the painted frame, so a stale
  frame cannot pass.
- The seams, and they are the highest existing ones in the suite: the
  frame rig in the test harness (`bootApp` and `withApp`) boots the App
  through OpenTUI's test renderer at a fixed size and reads the painted
  frame (`captureCharFrame` for the frame's characters, `captureSpans` for
  its styled spans). The rig already intercepts the renderer's frame
  events: `withholdFrameEvents` replaces the renderer's frame
  announcements with a count and keeps a witness listener, and
  `announceFramePass` names a pass to the surfaces; and it already
  intercepts the renderer's render asks: `withholdRenderAsksButThePlanesOwn`
  and `withholdEveryRenderAsk` swallow the asks and count the plane's own,
  which is how the suites keep a mid-assertion frame from moving the
  screen. A test of the moved seam runs through the rig unchanged: the rig
  proves the painted content of the screen, and the holds keep the
  renderer's announcements and asks from waking a surface. The new seam
  stands only inside the adapter module: the policy function itself, which
  the unit test drives with frame facts, and, if the adapter keeps a
  record of the rewrite scope it applied per frame, that record read
  through the adapter's own interface, never through the renderer's
  private.
- Prior art: the frame suites that drive the plane through the rig's named
  controls and its closed set of results (ADR 0128), the test renderer's
  frame-event and render-ask interception in the harness (issue #302: the
  renderer paints on invalidation, and the holds above stand beside it),
  and the small policy functions the repo already tests as pure functions
  of their inputs. The policy joins them; no new test style stands.
- What the suite cannot measure: the rewrite bytes of a live terminal, and
  the drift class of issue 1187 on a real screen. The test renderer paints
  a virtual screen and counts no bytes, so the amount of rewriting a frame
  performs on a real terminal stands on the terminal walk, recorded in the
  verification record with the renderer version and the terminal named. The
  walk runs after the move, with the blanket force still standing, to prove
  the handoff broke no paint, and after the lift, to prove the diffed frame
  heals a lost byte within one frame. A skipped required check is not a
  pass: until the walk stands, the lift is not taken.

## Out of Scope

- The spinner tick and the pop-in tick moving off the React commit and onto
  the renderer's animation engine: a separate candidate, and it pays off
  once this decision has landed.
- The Observation cycle's report identity: reporting a content change
  rather than a new identity on every cycle, so that a poll that changed
  nothing commits nothing: a separate candidate.
- Fixing OpenTUI upstream: the drift class of issue 1187 and the
  stale-buffer class of issue 1212 are upstream defects. The plane insures
  the drift class by policy and records both classes; an upstream fix or
  detection is the exit condition of the blanket force, not work of this
  decision.
- The App's regions re-deriving on every state write: the screen facts the
  App holds between the state and the paint are a separate candidate.
- Curing the stale-buffer corruption of issue 1212 by a paint-seam change:
  the force neither causes it nor cures it, and no policy of the plane's
  own rewrites can.

## Further Notes

- The byte-loss history stands in the verification record of the shared
  controls, measured on this machine's class (Bun 1.4.0, Linux x86-64,
  tmux 3.7a, 40 s runs): OpenTUI 0.5.9 lost the bytes of 19 to 30 captures
  per run, and the installed 0.5.11 lost 0 to 30. The record's byte reads
  place the measured fault in the renderer's own frames, not in the
  transport or tmux, and the measured form of the failure matches the
  stale-buffer class of OpenTUI issue 1212, whose fix's owner-retention
  mechanism the record found present in the Bun builds of both releases,
  with the corruption standing on. The record toggled the plane's forced
  full repaint and the rate stayed inside the baseline range, which is the
  measure that the force insures the drift class of issue 1187 without
  curing the stale-buffer class; the record keeps the force as the recorded
  workaround of the drift class. This decision keeps that insurance and
  moves its owner from the entry module's per-frame callback to the
  adapter's policy.
- The terminal walk after the move, with the blanket force still standing,
  must re-verify on the installed terminals the record names that the
  handoff to the adapter broke no paint: the spinner face beside its word
  in the Starting window, the Observation cycle's report on the list and
  the section headers' counts, the Consultation view's body and the Live
  view's stream under a working agent on each Agent host, a modal pop-in
  settling on the final body, a resize of the terminal mid-stream, the
  plane's bell on a Fault, and a selection over the screen, the act both
  the 1187 and the 1212 artifacts showed through.
- The terminal walk after the lift, when a byte-loss signal stands, must
  add the drift class itself: a diffed frame on the installed terminals
  healing a lost byte of the drift class within one frame, no stale row
  standing behind a selection, the pop-in and the stream over a full
  working turn, the recorded OpenTUI release beside the recorded terminal,
  and the record joining the verification record beside the exit
  condition.
