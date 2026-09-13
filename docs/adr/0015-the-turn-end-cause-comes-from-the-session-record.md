# ADR 0015: The turn end cause comes from the agent's session record

Status: accepted
Date: 2026-09-02

## Context

ADR 0008 builds the Turn log from the agent's session record, the versioned
file the runtime writes for every turn. The control plane reads that record
once at settle and takes the log from it. But the same record already says why
the turn ended, and the control plane does not look.

herdr's `agent list` status is the wrong fact to build a cause from. It is the
herdr integration's view of the pane, not the runtime's own record of the turn.
A turn can end on an API error the pane still shows as `working`, or the pane
can report `done` for a turn the runtime cut short. The cause the operator
needs is the runtime's fact: `completed`, `failed`, `aborted`, `truncated`, or
- when the record says nothing the reader can read - `unknown`.

Consultations settle turns too, and their operators see the same screens. A
Consultation turn that settled without an answer (the agent errored or was
aborted) is a fact the operator must be able to act on, not a silent
`awaiting-response`.

## Decision

The Turn end cause comes from the agent's session record, in the same read
that already returns the Turn log.

The seam widens from "the log" to "the log, the cause, and the cause's
detail": one read of the record, parsed once, and a cause beside the log. The
terminal capture never produces a cause. A turn whose session the control
plane cannot read - no session reported, no reader for the kind, or a missing
or unreadable record - settles with an `unknown` cause and its log from the
capture, exactly as ADR 0008 degrades the log.

Each per-agent-type reader maps its record's own end-of-turn fact to the five
causes:

- pi reads the last assistant message's stop reason: `stop` is `completed`,
  `error` is `failed` with the record's error message as the detail, `aborted`
  and a mid-turn `toolUse` are `aborted`, and `length` is `truncated`.
- codex reads the task event: a clean `task_complete` is `completed`, one with
  an error, and a `stream_error`, are `failed`, and `turn_aborted` is read
  from its own text (`truncated` when it names the context, `aborted` when it
  names an interrupt or a timeout, `failed` otherwise), and its reason stays
  the detail verbatim, so the operator reads codex's own words.
- claude reads the last assistant message: an API error is `failed`, a
  `max_tokens` stop is `truncated`, and `end_turn` or `stop_sequence` is
  `completed`; a `tool_use` stop is a turn still mid-work, not an end.

A record the reader cannot interpret settles `unknown`, never a guessed
`completed`.

**Fail open.** `unknown` is not a held cause. A turn the control plane could
not read, or that ended in a way no reader recognizes, auto-decides exactly as
it did before this ADR. The cause never blocks work the operator can see; only
a cause the record states - `failed`, `aborted`, `truncated` - may hold a turn.

**The staleness guard.** The cause is read for the turn that just settled. A
record whose last turn-end event predates the handoff's start is not this
turn's end: the reader settles it `unknown`, never `completed`. An
unparseable timestamp is skipped, so a bad record degrades to `unknown`, not
to a wrong `completed`.

**The detail is bounded.** The cause's detail is the agent's or the provider's
own text. It is capped at 2000 characters so a verbose error cannot push a
trace past the state the operator already sees.

The cause and its detail are stored on the Completion trace and on the
Consultation turn. A re-settle of the same still-pending turn refreshes both.
A Consultation turn that settled `failed` or `aborted` is not an answer: it
leaves the Consultation in `failed`, for recovery. Every other cause -
`completed`, `truncated`, `unknown` - leaves it `awaiting-response`, as a turn
that settled with its output does today.

The considered alternatives:

- Read the cause from herdr's status. Rejected: it is herdr's view of the
  pane, not the runtime's record of the turn, and it can disagree with the
  record on exactly the turns - the failed and the truncated ones - the cause
  exists to name.
- A new herdr command that reports the cause. Rejected: ADR 0006 holds, the
  poll reads herdr and writes nothing to it, and the cause is read, never
  provoked. The record already reports it, so the control plane takes it
  without a new dependency.

## Consequences

- ADR 0008 is extended, not replaced: the record that already gives the Turn
  log now gives the cause beside it, in the same read, and the fail-open and
  the staleness guard ride the same degradation path.
- The Completion trace and the Consultation turn each grow a `cause` and a
  `detail` cell. A legacy trace predates the cells and reads `unknown`, which
  fails open, so an old record behaves exactly as it did before this ADR.
- A Consultation turn that settled without an answer is visible as `failed`,
  so the operator recovers it instead of finding it silently waiting.
- A turn the control plane cannot read never blocks: it settles `unknown` and
  auto-decides as it did before, so a runtime that changes its record format
  breaks the cause, not the flow.
