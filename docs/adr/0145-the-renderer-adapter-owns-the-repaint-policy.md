# ADR 0145: The renderer adapter owns the repaint policy

Status: accepted
Date: 2026-11-13

Records that the plane's entry module stops marking the renderer's private
full-repaint flag on every frame and instead hands the frame's facts to a
renderer adapter module that owns the renderer and the repaint policy. The
policy answers how much of the screen each frame rewrites: the default is
the renderer's native diff, which writes only the cells that changed, and a
full rewrite stands when the frame's facts say the renderer's model of the
screen can be wrong, on a terminal resize, on output that lands on the
terminal outside the renderer, and on a detected byte-loss signal. Until a
byte-loss signal exists, the entry module keeps passing the blanket force as
an explicit policy input on every frame, so the screen keeps its recorded
insurance against the drift class of OpenTUI issue 1187 and the operator
reads the same screen as today. The decision lands in one step: the adapter
with the full policy stands now, and the lift of the blanket force is the
entry module's withdrawal of one fact, not a redesign of the policy.

## Context

The entry module constructs the native renderer from OpenTUI (installed
0.5.11) and installs a frame callback on it. The callback marks the
renderer's private full-repaint flag on every frame, so every frame rewrites
the whole screen. The renderer otherwise diffs a frame against its own model
of the screen: it marks a model cell as written when it emits the cell's
bytes. If the host terminal loses the bytes of a frame, the model and the
screen drift apart, and the later diffed frames skip the lost cells, so a
stale fragment of an earlier frame stands on the screen until the next full
rewrite. The blanket force overwrites any lost byte within one frame, and
the screen always converges to the model. It is the recorded workaround for
the drift class of OpenTUI issue 1187.

The price of the blanket force multiplies on every screen change the plane
makes. A spinner tick every 100 ms while a ticket wears the Starting window,
the Observation cycle's report every 5 s, the Consultation view's body
refresh and the Live view's stream line every 1 s, the modal pop-in's frames
every 16 ms, and a key press each rewrite the entire terminal, and the
renderer's diff path, which writes only the cells that changed, never runs
in a production run. Every screen the plane adds, and every fix that touches
how the screen paints, pays that price again: the lever that would make a
tick cost one glyph is held down, so no change to the paint buys back the
difference.

The verification record of the shared controls measures what the force does
and does not buy, on the installed renderer and the terminals it names (Bun
1.4.0, tmux 3.7a, 40 s runs: 0.5.9 lost 19 to 30 captures per run, 0.5.11
lost 0 to 30): the byte records place the measured corruption in the
renderer's own frames, not in the transport, and the measured form of the
failure matches the stale-buffer class of OpenTUI issue 1212, a native
defect the force neither causes nor cures, and the record's standing toggle
of the force leaves the rate inside the baseline range. Two defect classes
stand, then: the 1187 drift class, in which lost bytes falsify the model
and only a full rewrite heals it, which the force insures, and the 1212
stale-buffer class, in which the renderer's own frame carries the
corruption, which it does not. No detector of the drift class stands in the
installed renderer or in the terminals: the plane cannot tell a drifted
model from a sound one, and the blanket force is the answer it gives to a
question it cannot ask.

The seam where the cost stands is shallow. The entry module marks a private
renderer field per frame and owns no policy: it cannot tell a frame in
which the model may be wrong from a frame in which one cell changed, and the
knowledge of when the screen model can be wrong has no module. The UI module
paints its facts into the renderer and asks for renders; it stands on
neither side of the seam between the plane's commits and the screen's bytes,
and screen-model correctness rides on a per-frame callback in the entry
module that the UI module's commits unknowingly trigger. The renderer
already forces a full rewrite on the frames where it rebuilds its model, the
resize, the capability answer, the resume from suspend, on its own; the
entry's blanket force is the only force on the frames the renderer would
otherwise diff.

## Decision

A renderer adapter module owns the renderer and the repaint policy. It
constructs the renderer from the entry module's boot facts, the terminal and
the renderer options the entry stands today, it installs the frame callback
that runs the policy, it reads the renderer's own events, the resize and the
external output the renderer detects, as frame facts, and it stands in the
entry module's shutdown order, so the renderer returns the terminal before
the run ends. The entry module keeps the construction of the App and its
mount on the renderer, the herdr identity report before the first frame, and
the run's shutdown order, and it hands the adapter the frame facts it alone
can know: the writes the plane makes on the terminal outside the renderer,
a byte-loss signal when one exists, and the blanket force until a byte-loss
signal exists.

The policy is a function of the frame's facts, and it answers how much of
the screen the frame rewrites:

- The default is the renderer's native diff: the frame writes only the
  cells that changed.
- A terminal resize forces a full rewrite. The renderer already rebuilds
  its model on the resize and answers it with a forced rewrite on its own,
  and the adapter observes the renderer's resize event, so the fact stands
  in the policy's set and the answer to when the model's trust is rebuilt
  stands in one module.
- Output that lands on the terminal outside the renderer and could paint or
  move a cell forces a full rewrite of the next frame: the renderer's model
  does not know the bytes an outside writer put on the screen, and a diff
  would skip the cells the writer touched. The plane's own bell write on a
  Fault paints no cell and moves no cursor, so it forces no rewrite, and
  the entry module reports it to the adapter as the fact it is.
- A detected byte-loss signal forces a full rewrite for the frames it
  covers, so the lost cells are overwritten within one frame, the way the
  blanket force did. No such signal stands in the installed renderer or in
  the terminals the verification record names. That is the honest edge of
  the decision: while no signal stands, the plane cannot tell a drifted
  model from a sound one, and the policy trusts no diff it cannot check.
- Until a byte-loss signal exists, the blanket force stands as an explicit
  policy input the entry module passes on every frame. The policy's answer
  is a full rewrite on every frame, the screen behaves exactly as it does
  today on the drift class of issue 1187, and the private field the entry
  module marked on every frame stands now as the one private the adapter
  module owns, set only when the policy answers full.

The decision lands in one step: the adapter with the full policy stands
now, and the diff branch is testable on the day it lands, because the
policy is a function the developer can feed with frame facts. The two-step
shape, an adapter now whose policy always forces, and a second change that
lifts the force after the signal is verified, is rejected: it ships a
policy that is not yet a policy, it records this decision's risk analysis
twice, and it makes the lift a redesign of the very module this decision
builds. The lift is cheaper when the fact is already named: the entry
module stops passing the blanket force and hands the signal over, and the
policy, which already answers a byte-loss signal like any other force
fact, is unchanged by the lift.

The UI module is untouched by the move. It keeps requesting renders and
painting its facts into the renderer, and it stops being responsible for
the screen model's correctness: today that responsibility stands unnamed in
the entry module's per-frame callback, which every commit of the UI module
triggers; after the move it stands named, in the adapter's policy. The
depth is the point of the seam: the private renderer field, a leak of the
renderer's internals, is owned by the one module that stands between the
plane and the renderer, and the rest of the plane, the entry module
included, never sees it.

## Considered options

- Keep the blanket force in the entry module's frame callback, permanently:
  the screen keeps converging within one frame of a lost byte, and the
  plane keeps paying for every commit a full rewrite of the terminal, and
  the private field marking stays where the policy that justifies it is not
  written. When a byte-loss signal arrives, the plane would redesign the
  very seam this decision moves, and the entry module would keep owning a
  fact it cannot read, the state of the terminal's transport.
- Diff without a byte-loss signal: lift the force now and trust the
  renderer's diff on every frame. The renderer's model of the screen is
  exactly what a lost byte falsifies, and no fact would tell the policy the
  model is wrong, so the diffed frames keep skipping the lost cells and the
  stale fragment stands until any full rewrite, which the diff-only policy
  schedules rarely. The operator reads that screen as the plane's own
  facts, and the plane does not take an unobserved screen for a correct
  one.
- Move the policy into the UI module instead of the entry-level adapter:
  the UI module knows the screen's content, but it knows nothing of the
  renderer's model of the screen, of the terminal's transport, or of the
  writes that land on the terminal outside the renderer. The policy's facts
  are facts the UI module cannot read, so placing the policy there would
  make a module own a decision it cannot make, and the seam would move from
  the renderer's edge to the middle of the paint, further from the facts
  than it stands now.

## Consequences

- The screen the operator reads is unchanged while the blanket force
  stands: every frame still rewrites the whole screen, the frame tests read
  the same painted frames, and the drift class of issue 1187 keeps its
  insurance. What moves is where the decision stands: a policy of explicit
  frame facts in the adapter module, instead of a private field the entry
  module marks on every frame.
- The leverage pays out at the lift. When the entry module withdraws the
  blanket force, a spinner tick writes one glyph, the Observation cycle's
  report writes the rows that moved, the Consultation view's refresh and
  the Live view's stream write their changed lines, the pop-in writes its
  transform, and a key press writes its effect, and every screen change the
  plane builds after that pays per changed cell instead of per screen.
- The risk that stands after the lift is the one the force insures: a byte
  loss of the drift class of issue 1187 that no signal reports. The screen
  then converges on the next forced rewrite, which the policy schedules on
  the resize and on outside output that could paint a cell, and it stands
  open between them. The stale-buffer class of issue 1212 is a separate
  native defect the force never cured and this move does not worsen; the
  verification record keeps it open beside the drift class.
- The exit condition for the blanket force: it lifts when a byte-loss
  signal exists and stands verified on the plane's own screens. The signal
  is a detection of the drift class of issue 1187 in a release of OpenTUI
  the plane installs, or a terminal-level probe the plane can read; the
  lift is not the signal alone, a terminal walk on the installed renderer
  and on the terminals the verification record names must show a diffed
  frame healing a lost byte within one frame and no stale row standing
  behind a selection. Until both stand, the entry module keeps passing the
  blanket force, and the policy's diff branch is the path the walk will
  prove before it becomes the production path.
- A terminal walk must re-verify after the move, with the blanket force
  still standing, that the handoff to the adapter broke no paint: the
  spinner face beside its word in the Starting window, the Observation
  cycle's report on the list and the section headers' counts, the
  Consultation view's body and the Live view's stream under a working agent
  on each Agent host, a modal pop-in settling on its final body, a resize
  of the terminal mid-stream, the plane's bell on a Fault, and a selection
  over the screen, the act the 1187 and 1212 artifacts both showed
  through. After the lift, the walk adds the drift class itself, a diffed
  frame on the installed terminals with the recorded renderer version
  beside the recorded terminal, and the record joins the verification
  record of the shared controls.
