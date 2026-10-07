# ADR 0126: The Attention band reads the row's standing, and the machine's gate waits for the read

Status: accepted
Date: 2026-10-07

## Context

The Ticket list's first sort is the Attention band (ADR 0050): awaiting work,
then the in-flight states, then open work the plane can act on, then open work
it cannot. The band's two open runs read the row's `actionable` fact, and that
fact requires a source whose last read stands good.

The refresh coordinator marks every configured source `loading` when it starts,
and it starts at the boot and again on every config write-back. So the boot
took every open row out of the actionable band, and each source's first fetch
brought that source's rows back at its own moment. With the five sources a
development config carries, the operator watched the open pile reorder itself
several times before it settled, on work no source had changed yet (issue
#345).

The same mark is also what keeps the automatic walks from starting work before
this run has read its sources: the Handoff claim refuses a Ticket whose source
data is stale, removed, or absent, and ADR 0049 counts that check among the
hard start gates. One fact was answering two questions, and only one of them is
a question about the Ticket.

## Decision

**The Attention band reads the row's own standing, and the machine's gate keeps
waiting for the read.** The projection read answers both facts beside each
other:

- `actionable` - the machine's gate - stands when a source whose last read
  succeeded lists the row. It is unchanged: the Handoff claim, the Top-up
  walks, and the Next step derivation keep reading it, so no start runs on
  facts the run has not read.
- `listActionable` - the band's read - stands when the row lists on a source
  the Config still holds, that source's last read did not fail, and no start of
  the Ticket already stands. `loading` counts as standing: it states that a
  read is outstanding, which is the plane's schedule and no fact about the
  Ticket.

The flat list, the Group rank, and the ignored and muted ledgers read the band,
so one order still answers "what needs me now" (ADR 0059, ADR 0065, ADR 0071).
A row still crosses a band when its source's read fails, when the source leaves
the Config, when a start of it stands, and when the Ticket itself moves: the
band keeps working as ADR 0065 states it.

## Considered options

- **Let the boot keep the health the state file holds.** One fact instead of
  two, and the churn goes away. It also lets the Top-up start an open Ticket on
  the previous run's facts before this run has read a source, which moves when
  the factory starts Agents - a change no report asked for.
- **Paint nothing until the boot's first refresh round settles.** It hides every
  intermediate order, the ones where the work really changed included, and it
  costs the operator the projection they already hold for as long as the
  slowest source takes. The fact still flips under every other read.
- **Re-read the list once per refresh round instead of once per source.** It
  lowers the repaint count and leaves the flip itself in place: the first order
  after the round is still the one the boot's mark made.

## Consequences

- The boot, and the config write-back that re-runs the refresh, no longer
  reorder the open pile. The list comes up in the order the previous run left
  and stays there until a source answers with different work.
- The two facts differ only while a read is outstanding. Through that window a
  row stands in the actionable band while `Enter` refuses with the gate's own
  line, `Ticket is not actionable because source data is stale, removed, or
  absent`: the refusal states the reason the band no longer carries.
- The Work queue and its keys are untouched: the queue is the order of work and
  the band is the order of attention (ADR 0049).
- The glossary's Attention band entry now names the standing the band reads.
