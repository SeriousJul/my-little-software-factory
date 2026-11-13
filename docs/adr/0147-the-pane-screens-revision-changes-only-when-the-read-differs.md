# ADR 0147: The pane screen's revision changes only when the read differs from the previous read

Status: accepted
Date: 2026-11-13

Records that the read of a pane's screen hands back a screen fact: the plain
text the read returns, the parsed ANSI screen of the interaction mode's read,
and a revision that changes only when the read differs from the previous read
of the same pane. Records that the comparison with the previous read is owned
by the reader that keeps it - the adapter that reads the pane's visible screen
from the Agent host - and that the UI does no comparison; that the shaping of
the body, the ANSI interpretation and the wrap to width, runs once per
(revision, width) pair and is cached on the revision, so that renders in
between reads read the stored shaped lines and cost nothing; and that the
Consultation detail's body, the Live view's stream, and the Decision modal's
turn log stand on this one interface of the pane screen module, the read
source and the cadences of ADR 0140 unchanged.

## Context

The body of a view is the pane's screen. The Consultation detail reads the
agent's visible screen once a second, and every 250 ms in interaction mode
(ADR 0140). The Live view's stream reads the ticket's agent pane once a
second. Today, every tick of those reads, and every render of the app,
re-derives the whole body:

- The Consultation detail re-wraps every line of its body to the pane's width
  on every render of the app, whether the pane changed or not. In interaction
  mode it does more: it runs the full ANSI interpretation of the pane's text,
  the escape, cursor, and erase stepping over the whole screen, on every
  render of the app, not only on a new read. A render of the app is any state
  write: the spinner's 100 ms frame, a poll, a key press. The pane's text
  arrives on the tick, and the interpretation runs at render time, so while
  the pane stands still the machine pays the full interpretation on every
  render.
- The Live view's stream hands out a new body object on every tick of its
  one-second read, even when the pane the read covers is unchanged. The
  view's two layout memoizations key on that object's identity, so both miss
  on every tick, and each of them re-wraps the whole body: once at the full
  pane width, to decide whether the scrollbar stands, and again at the
  scrollbar-adjusted width. The body pane's layout is computed at both widths
  on every render of the view: once at the final width, once at the current
  width.
- The Decision modal's turn log interprets every entry's markdown at the
  pane's width. On the modal's pop-in the width changes on every animation
  frame, and the log is re-interpreted at every intermediate width the frames
  visit: roughly seven re-parses of the whole log on one opening, on a log
  that does not change while the box grows in.

The real unit of change is that the pane's content changed, and the read is
the only record of it. The read hands out raw text, and nothing in the module
structure holds a revision: nothing says a body may stand still between two
reads that differ. The consumers treat every read and every render as a
reason to re-derive, and the memoizations that do exist key on the identity
of an object that is re-allocated on every tick, so they never hit.

## Decision

The pane screen module stands at the read seam, between the reader that reads
the pane's visible screen from the Agent host and the consumers of the body.
The merged reader reads the pane's screen and returns a screen fact: the
plain text the read returns, the parsed ANSI screen of the interaction mode's
read, and a revision. The revision changes only when the read differs from
the previous read of the same pane.

The comparison of the read with the previous read is owned by the reader: it
is the module that owns the previous read, and it is where the visible-screen
contract of ADR 0140 already points. The UI receives the screen fact and the
revision, does no comparison, and keeps no copy of the previous read.

The shaping of the body runs once per (revision, width) pair and is cached on
the revision, not on the identity of the object that carries the body: the
ANSI interpretation of the pane's text into a screen of styled lines, the
wrap to width of the plain text, and the markdown interpretation of the turn
log's entries. A render in between reads, a spinner frame, a poll, a key
press, at the same revision and the same width reads the stored shaped lines
and re-parses nothing. What the interaction mode's per-render ANSI re-parse
becomes is a read of the cached interpretation. The double layout computation
of the body pane collapses to one shaping per width: the layout stands on the
final width, the body is shaped at the full pane width to decide whether the
scrollbar stands, and at the scrollbar-adjusted width only when the scrollbar
stands. A frame that visits a width the cache holds reads the stored lines.

The module serves the three bodies from the same interface: a screen fact
with a revision, and a shaping cached on (revision, width). The Consultation
detail's body stands on it in the two bodies it reads from the pane: the
Agent view's lines from the visible screen, and the parsed screen of
interaction mode. The Live view's stream stands on it. The Decision modal's
turn log stands on it, its screen fact the read of the log, its revision
owned by the log's read. The three views keep the choice of which body stands
under which border title, and the scroll the pane clamps. They stop
interpreting ANSI, stop wrapping the pane's text, and stop re-interpreting
the log, and they hand their width to the module.

The read source and the cadences are unchanged: ADR 0140's visible screen on
the herdr host, the merged reader's routing to the herdr-core host's own read
form, the Consultation's one second (250 ms in interaction mode), and the Live
view's one second.

## Considered options

- Memoization on the UI side keyed on a content hash: the views hash the
  pane's text and cache the shaped body on the hash. The comparison, a hash
  of the read against a stored hash, stands in every view that caches, and
  the three consumers carry three copies of a comparison the reader can do
  once with the previous read in its hands. It quiets the steady tick, but
  the interaction mode's interpretation still stands in the view and re-runs
  on every render the view runs, and the turn log's per-width
  re-interpretation is untouched, because the log's content is entries, not
  text. The comparison belongs to the module that owns the previous read,
  and this option scatters it across the UI.
- Widen the refresh cadences: the cost stands per read and per render, and a
  slower cadence touches only the reads. The per-render re-interpretation of
  interaction mode, the per-width re-shaping of the pop-in, and the per-tick
  re-wrap of an unchanged pane stand on the module structure, not on the
  clock. ADR 0140 already declined this option on the reads: the bodies stand
  on the liveness of the one-second read, and the operator reads the
  Consultation screen on that liveness.
- Keep the per-consumer shaping: the three consumers keep their own shaping,
  their own memoizations, and their own comparison of the read with the
  previous read. The pane screen's unit of change, the revision, has no
  home, the reader's comparison is duplicated three times, and the next
  consumer of a pane's screen builds a fourth.

## Consequences

- A tick of a body whose read answers with an unchanged pane costs the read
  and the comparison in the reader: it publishes no new screen fact, shapes
  nothing, and leaves the shaped body standing. Only a read that differs
  publishes a new revision and shapes the body once per width it stands on.
- A render of the app at an unchanged revision and width reads the stored
  shaped lines. The per-render ANSI interpretation of interaction mode is
  gone: the interpretation runs on a read that differs or on a width that
  changes, and the render touches the escape text only through the cached
  screen.
- The body pane's layout stands on the final width, and the body is shaped
  once per width it stands on. A steady tick of a stream whose pane does not
  move pays no wrap at all, and the modal's pop-in pays at most one shaping
  per width it visits.
- The Consultation detail, the Live view, and the Decision modal lose the
  parsing: they stop interpreting ANSI, stop wrapping the pane's text, stop
  interpreting the turn log's markdown, and stop comparing reads. They are
  left shallow on purpose: the deep work, the comparison, the interpretation,
  and the cache, stands in the pane screen module at the read seam, where
  the shaping's inputs live, and the comparison's locality follows the
  previous read into the reader that keeps it. The views keep the choice of
  which body stands under which border title, and the scroll the pane clamps.
- The cache's invalidation rule: an entry is valid while its revision and
  the width it was shaped at stand. A read that differs moves the revision
  and invalidates the entries shaped on the old revision. A width that
  changes, a resize, a frame of the pop-in, the scrollbar standing or
  leaving, invalidates the entries shaped at the old width. The close of the
  surface that asked for the body drops its entries. The module keeps no
  entry past its (revision, width) key.
- ADR 0140 stands beside this decision, and it names the relationship: ADR
  0140 decides what the herdr host's read takes, the pane's visible screen
  without scrolling the pane the operator watches, and on the herdr-core host
  the merged reader keeps routing the read to that host's own read form, and
  this decision decides
  what the read hands back, a screen fact with a revision, and how often the
  body re-derives, on the revision, not on the read, and not on the render.
  The read source and the cadences move neither.
- The frame tests must show: a frame of a body on a pane that does not
  change across its reads is the same frame the tick before; a frame of a
  body on a pane whose next read differs stands on the new screen fact; and
  a frame of a view at a width it has not stood on shapes the body once at
  that width. The terminal walk re-verifies the two things this decision
  touches on screen: the bodies still show the visible screen of ADR 0140,
  and the scrollbar's width adjustment still stands on the final layout.
