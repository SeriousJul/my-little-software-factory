# ADR 0140: The plane's periodic pane reads take the visible screen

Status: accepted
Date: 2026-10-20

Records that the plane's periodic pane reads - the Consultation view's
one-second body refresh and the Live view's one-second stream - ask herdr for
the pane's visible screen instead of its recent output, that the settle of a
working Consultation takes the visible screen when the agent's session record
holds the turn, and that the recent scroll capture stands only as the
documented fallback beside an unreadable record. It is the plane's answer to
the scroll that runs back and forth in the neighbour pane a Consultation or a
Live stream reads (issue #405, the second of that issue's two mechanisms;
ADR 0139 removed the first, the plane's own pane misread).

## Context

Herdr 0.9.1 answers an `agent read` of `recent` or `recent-unwrapped` output
from an idle agent's alternate screen by scrolling the pane: the server's
read walks the pane's visible window up through the history with synthetic
wheel events, capturing the screen at each step, and walks it back to where
it stood. In the installed herdr's source the read's phases run from a settle
and a bottom probe to an upward harvest and a restore, and every step renders
on the client. While the agent works, herdr refuses those reads outright:
the read fails with `agent_not_idle`, its one-line reason naming the scroll
it would have run.

The Consultation view's one-second body refresh and the Live view's one-second
stream both asked for the recent output of the agent pane the operator
watches. While the agent works, herdr refuses every such read, and the plane
wears the Stale Agent output warning on the Consultation for the whole
working turn, a warning that names a pane that reads fine, one herdr refused
on the agent's state. The moment the agent reaches idle, the same read is
answered, and with every one of the view's one-second reads the pane the
operator watches runs up through its history and back down on the screen.
The refresh runs once a second for as long as the view stands, so the
neighbour pane runs back and forth for the whole time the operator reads the
settled answer. The Live view's stream ran the same read on the ticket's
agent pane on the same cadence. That is the screen the operator reported
(issue #405): the neighbour pane running back and forth on the Consultation
view, still once the plane stops.

The measurement ran on the operator's live session on the installed herdr
0.9.1, late on 2026-10-20: the server's log holds the plane's 681 reads,
one per second while the view stood, and herdr refused every one of them
(`agent_not_idle`) while the Consultation's agent worked. Herdr runs no scroll of the pane on a refused
read; its source computes the refusal before the scroll mechanism begins. The
operator stopped the plane at the turn's settle, before a read had succeeded,
and the restart stood off the Consultation view. The scroll herdr does run on
a read that succeeds is documented in the installed herdr's source: the read's
wheel events walk the pane's screen up through its history and back. That
scroll is the screen state ADR 0139's verification never produced, and the
neighbour-tab confirmation its record left to the operator is the one this
incident reports. The operator's next Consultation settle on the fixed build
settles the report: with the visible read, the plane's tick has no scroll to
cause, so a still neighbour pane stands as the confirmation the record asked
for.

## Decision

The plane's periodic pane reads take the visible screen - herdr's `visible`
source in text format: the screen herdr shows in the pane, the same body the
operator sees in the neighbour tab. Herdr answers the visible read without
scrolling the pane, and it answers it while the agent works as well as while
it rests, so:

- The Consultation view's one-second refresh and the Live view's one-second
  stream keep their cadence and their bodies, and the pane they read stays
  still on the operator's screen for the whole run, working turn and settled
  turn alike.
- The Stale Agent output warning and the Live view's stale note name a pane
  that truly cannot be read - the pane is gone, or herdr is down. A working
  agent no longer reads as stale: herdr refuses no visible read of it.

The settle of a working Consultation reads the agent's session record first,
the same reader the ticket settle uses (ADR 0015). When the record holds the
turn's end, the settle takes the visible screen as the turn's stored body:
herdr answers it without the scroll, the record view reads the turn's history
from the session record beside it, and the stored snapshot holds the last
screen the agent stood on. When the record holds no turn or cannot be read,
the settle keeps the recent scroll capture, the documented fallback the
ticket settle already runs (ADR 0008): the terminal is the turn's only body,
and the one scroll it costs per turn buys that body.

The recent read keeps its standing where the history is the point: the
fallback capture above, and the awaiting Consultation's one snapshot per
external turn, which stands as measured and moves with the same rule when its
cost shows.

## Considered options

- Widen the refresh cadence or drop the refresh while the agent works: the
  bodies are live while the turn runs, and the operator reads the Consultation
  screen on that liveness; the cadence is not the scroll, the read's source
  is.
- Ask herdr for a side effect free of the scroll: the installed herdr 0.9.1
  has no recent read that does not scroll, and the plane does not keep a
  second herdr client with another ask; the plane takes the source that
  answers quietly.
- Keep the recent read and suppress the client's rendering of the capture:
  the scroll is the pane's own screen moving under the agent; no rendering
  choice hides it, and a herdr that renders it faithfully is behaving to
  spec.

## Consequences

- The Consultation record's stored snapshot beside a readable session record
  holds the last visible screen, not the turn's scrolled history. The record
  view reads the turn's history from the session record, so the operator
  loses no body; the snapshot is the stand-in for the record's own rows.
- Beside an unreadable session record the settle's one recent capture keeps
  its scroll of the agent's pane. An agent with no session record is the
  fallback's case, and the scroll is the price of its history.
- The Live view's stream shows the visible screen, the body the operator sees
  in the neighbour pane, live while the agent works. A stream that held the
  pane's history behind a read herdr refused while the turn ran showed
  nothing of the turn at all; the visible screen shows it.
- A Consultation that works no longer wears the Stale Agent output warning,
  and the Live view no longer wears its stale note on a working agent. Both
  warnings stand only on a pane that cannot be read.
