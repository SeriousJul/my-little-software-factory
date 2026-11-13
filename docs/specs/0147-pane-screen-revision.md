## Problem Statement

From the operator's perspective: the operator's screen works - the Consultation
detail shows the agent's visible screen, the Live view streams it, the
Decision modal's turn log reads - but every second of a running turn the plane
burns CPU re-deriving text that did not change, and the modal's turn log
stutters through roughly seven re-parses of every entry's markdown on its
pop-in. The operator never sees the waste: the bodies are right, the cadences
are right, and the cost is machine time paid on every tick and every render,
which on a slow machine is the lag the operator does feel.

## Solution

From the operator's perspective: nothing changes on screen, and the machine
stops paying for unchanged text. The Consultation detail, the Live view's
stream, and the Decision modal's turn log show the same bodies at the same
cadences. The difference is when the plane re-derives them: only when the
pane's content actually changed, or when the width the body stands at changed.
A pane that stands still costs one quiet read per tick and no re-derivation
at all. A pane that changed is re-shown on the next read. A resize re-shapes
the body once at the new width. The modal's turn log shapes at most once per
width on its opening, and the repeated frames of the pop-in read the stored
lines. In interaction mode the operator sees the agent's screen parsed, as
before, and the plane's key presses and polls no longer make it re-parse the
whole pane.

## User Stories

1. As the operator of the control plane, I want the Consultation detail to
   keep showing the same body while the agent's pane is unchanged, so that
   the plane ticks behind me every second without the machine re-deriving a
   body that stands still.
2. As the operator of the control plane, I want the Consultation detail to
   show the agent's new output on the tick after the pane changed, so that I
   see the agent's progress at the same one-second cadence I have always had.
3. As the operator of the control plane, I want the Live view's stream to
   show the lines the pane gains, and to stand still when the pane does not,
   so that the stream carries the turn without the machine re-wrapping the
   unchanged lines every second.
4. As the operator of the control plane, I want the Decision modal's turn log
   to stand up at its opening width without re-parsing its entries on every
   frame of the pop-in, so that the log settles in front of me instead of
   flickering through intermediate shapes.
5. As the operator of the control plane, I want the turn log to re-shape
   correctly when my terminal resizes, so that it wraps at the new width.
6. As the operator of the control plane, I want interaction mode to show me
   the agent's screen parsed - its colors and layout, not the escape text -
   so that I drive the agent's screen as I see it.
7. As the operator of the control plane, I want interaction mode to
   re-interpret the pane only when the pane's read differs or the width
   changes, so that my key presses and the plane's polls do not make the
   machine re-parse the whole pane.
8. As the operator of the control plane, I want a pane that becomes
   unreadable to keep showing its last body under the stale warning,
   unchanged by this decision, so that I still know the pane is dead and what
   it last showed.
9. As the operator of the control plane, I want the body pane's scrollbar to
   stand or leave exactly as before, decided at the final width, so that the
   box does not flicker during the pop-in and an overflowing log keeps its
   rows.
10. As the operator of the control plane, I want a closed Consultation's
    detail to show the Session view when it reads, and the Captured history
    when it does not, unchanged, so that this decision costs me no body.
11. As the operator of the control plane, I want the Consultation's refresh
    to keep its one-second cadence, and its two-fifty cadence in interaction
    mode, so that the liveness I read on does not move.
12. As the control plane itself, I want the read of a pane's screen to answer
    whether the pane changed, so that I publish a new screen fact only when
    the read differs from the previous read of the same pane.
13. As the control plane itself, I want the shaping of a body to run once per
    (revision, width) pair, so that my ticks and renders cost a stored read,
    not a re-interpretation and re-wrap of the whole body.
14. As the control plane itself, I want the Consultation detail's body, the
    Live view's stream, and the Decision modal's turn log to stand on one
    screen-fact interface, so that the revision and its cache have one home
    and the three bodies cannot drift apart.
15. As the control plane itself, I want the comparison of a read with the
    previous read to stand in the reader that owns the previous read, so that
    the UI never compares two reads and never holds a copy of the previous
    read.
16. As the control plane itself, I want the body pane's layout to stand on
    the final width, with the body shaped at most once per width it stands
    on, so that my frames pay one shaping per width instead of two layouts
    per tick.
17. As the developer of the control plane, I want the shaping of a screen
    fact to be a pure function of (screen, width), so that I can test it
    without a terminal, a host, or a renderer.
18. As the developer of the control plane, I want a test that drives a
    sequence of fake pane reads - unchanged, changed, changed again - and
    asserts the shaped body changes only when the revision changes, so that a
    regression to per-tick re-shaping is caught at the read seam.
19. As the developer of the control plane, I want the frame rig to drive the
    same visible-screen read the Consultation and Live views already fake, so
    that the end-to-end bodies of the views show the screen fact through the
    real refresh path.
20. As the developer of the control plane, I want the revision to be produced
    where the read happens, so that a host adapter that reads a pane in a
    different form, herdr-core's single form of read, still hands back the
    same screen fact on both hosts.

## Implementation Decisions

- The pane screen module stands at the read seam, between the reader that
  reads the pane's visible screen from the Agent host and the consumers of
  the body. Its interface is one: a screen fact, and the shaping of a screen
  fact at a width. The three consumers of the body stand on this interface,
  and no consumer shapes its own body.
- The screen fact holds three things: the plain text the read returns, the
  parsed ANSI screen of the interaction mode's read, and a revision. The
  plain text is the read's body, ANSI-stripped for the ordinary read and the
  ANSI text for the interaction mode's read. The parsed ANSI screen is the
  interpretation of that ANSI text into a screen of styled lines. The
  revision changes only when the read differs from the previous read of the
  same pane.
- The comparison of the read with the previous read stands in the reader: the
  reader is the module that owns the previous read, and the revision it hands
  back is that comparison, made into a fact of the screen fact. The UI
  receives the screen fact and the revision; it does no comparison and keeps
  no copy of the previous read. On the herdr host the read takes the visible
  screen in the form ADR 0140 names, text for the ordinary read and ANSI for
  the interaction mode's read. On the herdr-core host the merged reader routes
  the pane's read to the host's single form, and the screen fact is the same
  shape on both hosts.
- The shaping cache keys on (revision, width). The shaping has three steps,
  and each of them runs once per (revision, width) pair: the ANSI
  interpretation of the pane's text into a screen of styled lines, the wrap
  to width of the plain text, and the markdown interpretation of the turn
  log's entries. A render in between reads, a key press, a poll, a spinner
  frame, at the same revision and width reads the stored shaped lines. What
  the interaction mode's per-render ANSI re-parse becomes is a read of the
  cached interpretation: the interpretation runs on a read that differs or on
  a width that changes, and a render at the same revision and width touches
  the escape text only through the cached screen.
- The three consumers stand on the same interface. The Consultation detail's
  body stands on the pane's screen fact in the two bodies it reads from the
  pane: the Agent view's lines from the visible screen, and the parsed screen
  of interaction mode. The Live view's stream stands on the same screen fact
  for the ticket's agent pane. The Decision modal's turn log stands on a
  screen fact of the log, whose content is the log's entries and whose
  revision the log's read owns. Each view hands the module the width the body
  stands at, and reads back the shaped lines.
- The double layout computation of the body pane collapses to one shaping per
  width: the body pane's layout stands on the final width, the body is shaped
  at the full pane width to decide whether the scrollbar stands, and at the
  scrollbar-adjusted width only when the scrollbar stands. A frame of the
  pop-in that visits a width the cache holds reads the stored lines, and the
  steady tick of a body whose pane does not move shapes nothing at all.
- The views lose the shaping. They stop interpreting ANSI, stop wrapping the
  pane's text, stop interpreting the turn log's markdown, and stop comparing
  reads. They keep the choice of which body stands under which border title,
  the scroll the pane clamps, and the presentation of the body the module
  hands back. They are left shallow on purpose: the deep work, the
  comparison, the interpretation, and the cache, stands in the pane screen
  module at the read seam, where the shaping's inputs live.

## Testing Decisions

- A good test shows the external behavior of the seam. Given a sequence of
  pane reads, the shaped body changes only when the revision or the width
  changed: a read that returns the same text publishes no new revision,
  shapes nothing, and leaves the stored body standing; a read that differs
  publishes a new revision, and the shaped body changes at the width the body
  stands at. A render in between reads, a key press, a poll, a frame, costs
  nothing: the shaped body read after it is the stored one. Given a (screen,
  width) pair, the shaped text is deterministic: the same screen at the same
  width shapes to the same lines, a different width shapes once and caches,
  and a second shaping at a held width reads the cache.
- The highest seam is the pane read itself: the reader the Consultation and
  Live views already call, with the visible-screen contract of ADR 0140. The
  tests already drive it with fake host operations, and the screen fact and
  its revision are asserted at this seam: a sequence of reads through the
  reader, and the screen facts the consumers receive. The revision's rule is
  asserted here too: same text, same revision; different text, new revision.
  The comparison stands in the reader, and no test reaches past it into the
  UI.
- Inside the module, the shaping is a pure function of (screen, width), and
  it is its own test seam: no terminal, no host, no renderer. The cache's
  behavior is asserted at this seam by shaping the same screen fact repeatedly
  and counting the interpretations: once per (revision, width) pair, and not
  again while the pair stands.
- The frame rig is a second, lower seam for the end-to-end body behavior of
  the views: a frame of the Consultation detail on a pane that does not
  change across its ticks, a frame of the Live view's stream on a pane that
  appends lines, a frame of the Decision modal's opening with the turn log,
  and a frame of a body at a resized width.
- Prior art to extend: the Consultation frame tests, which already fake the
  host's visible read, text and ANSI, through the fake command runner; the
  Live view tests, which fake the same visible read for the stream; the
  reader's unit tests, which answer the host's read commands with a fake
  runner and already hold the visible-screen contract of ADR 0140; and the
  pure tests, the ANSI screen's interpretation tests, the text helpers' tests
  for the wrap to width and the width of a line, the Consultation detail's
  pure shaping tests, and the turn log's tests.

## Out of Scope

- The renderer's repaint policy, which frames write the whole screen and
  which diff it: that is ADR 0145.
- The Observation cycle's poll report identity, the poll that hands out new
  identities even when nothing moved: that is ADR 0146.
- Moving the modal's pop-in off per-frame re-shaping, shaping the body once
  at the final width and running the pop as a paint-time transform: that is a
  separate candidate. This decision only makes each width the pop-in visits
  cost at most one shaping.
- Changing the read source: ADR 0140's visible screen stands on both hosts.
- Changing the cadences: the Consultation's one second, two-fifty in
  interaction mode, and the Live view's one second stand.

## Further Notes

- A terminal walk must re-verify the two things this decision touches on
  screen. The bodies still show the visible screen of ADR 0140: the
  Consultation detail's Agent view and the Live view's stream show the screen
  the Agent host shows in the neighboring pane, and the host answers the read
  without scrolling the pane the operator watches. And the scrollbar's width
  adjustment: the body pane's scrollbar stands exactly as before, decided at
  the final width, the body is wrapped at the scrollbar-adjusted width, and
  the thumb's rows are right on a log that overflows.
- The herdr-core host answers its pane's read in one form, the terminal's
  history, and the merged reader routes the read to it: the screen fact, and
  its revision, is the same shape on both hosts, and the visible-screen
  contract of ADR 0140 holds for the plane's reads on either host.
