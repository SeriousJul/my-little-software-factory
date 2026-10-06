# ADR 0102: A Consultation start line belongs to the Consultation operations, and the start mode is one shared fact

Status: accepted
Date: 2026-10-04

Amends ADR 0092's "A start line names how it started" and "The seat reading is
the count the gate stood on" paragraphs: a third start line exists, it belongs
to a third module, and the mode it names is no longer the dispatch's own type.

## Context

ADR 0092 gave the Handoff start line and the Plane action's `merge started:`
line their start mode, their origin, and their seat reading. Both lines are the
Handoff dispatch's: the dispatch claims the seat, so the dispatch states the
start.

A Consultation start had no line at all. The dispatch reports a Consultation's
pickup and its force-dispatch on the Message line only
(`force-dispatched Consultation <id> over the Parallel limit`), and a Message
line never reaches the plane's file logger. The Parallel limit counts a
Consultation seat (ADR 0034), so the one work kind the cap counts kept the
least readable start record: a Consultation force-dispatch over a full cap was
invisible in the log file, and a reviewer could not tell a Consultation pickup
from a Consultation force-dispatch (issue #220).

Writing that line in the dispatch was the obvious move and the wrong one. ADR
0096 and ADR 0097 are this plane's module-ownership decisions, and the dispatch
holds no Consultation start fact: it does not re-read the Consultation type's
settings, it does not move the record to `opening`, and it does not run the
opening. Those are the Consultation operations' (ADR 0096). A line the dispatch
wrote would state a start the dispatch did not perform, and the mode type that
names the path lived inside the dispatch as a private type, so the Consultation
module could not name it without importing the dispatch's internals.

## Decision

**The Consultation operations write the Consultation start line.**
`ConsultationOperations.pickup` leaves
`consultation started: "<type>" <id8> (mode <mode>, origin consultation, seats <held>/<limit>)`
through a `log` seam the App wires to the plane's file logger. The line is the
shape ADR 0092 decided for the other two start lines. The dispatch keeps no
Consultation start line; its own `log` documentation now says so.

**The record's name on the line is its Consultation type beside its identity
prefix.** A Consultation type name alone cannot name a record: two `grill`
records can stand at once, and every other Consultation line the plane writes
names a record by its 8-character identity prefix. The line follows that rule.

**`StartMode` is a shared domain fact.** The type moves to
`src/domain/start-mode.ts`. The dispatch names it for a Handoff and for a Plane
action, and the Consultation operations name it for a Consultation. Each module
owns its own start line, and both read this one name for the path.

**The dispatch hands the mode across the pickup seam.**
`pickupConsultation(consultationId, mode)` carries the path fact: `pickup` for
the Work queue's pickup walk, `force-dispatch` for the operator's key on the
waiting row. The path is the queue's fact while the line that states it is the
Consultation module's. The App names the same fact for the Consultation
section's own start now key.

**For a Consultation the mode names the key, not a cap crossing.** The
Consultation section's key names `force-dispatch` whatever the seat count reads,
because the key is the pickup seam with the cap skipped (GLOSSARY.md
"Force-dispatch"). So `mode force-dispatch` beside `seats 0/2` is a legal line
and a normal start. ADR 0092's reading rule - a pickup's reading always sits
under the limit, and a reading at the limit is the force-dispatch that crossed
it - holds for the dispatch's two lines, where the dispatch itself decides the
mode from its own cap check. It does not carry over to a Consultation line:
there the mode is the operator's key, and the seat reading is the count the cap
stood on at the key, not proof the cap was crossed.

**The seat reading is measured before the record takes its seat**, through the
same shared seat count the Parallel limit gate and the Ticket header's mode cell
read (ADR 0034). The line states the count the gate stood on, never a count this
start raised. The start line is the Consultation module's only reader of that
count, so the module runs the read only where a logger stands to state the line.

**The seat field's text is shared too.** `parallelSeatReading` in
`src/parallel.ts` owns the `seats <held>/<limit>` field the three start lines
carry, beside the `parallelSeatText` rule that decides whether a limit is named
at all. Three lines in two modules state one measurement; the text lives in one
place so they cannot drift.

## Consequences

- The log file now records every Consultation start the app can make. Every
  fresh Consultation enters through the Work queue and leaves it through the
  pickup, so every real start writes a line. `recover` and the safety-conflict
  confirmation continue an opening that already claimed its seat, so they write
  no line, and a start that claims nothing - a record that left the queue's
  wait, a type that left the config - writes none either.
- A Consultation line's `origin` is always `consultation`, the word the Work
  queue's detail stands a Consultation item under: the queue's row stands under
  the task type and the ask instead (issue #90's row wording). The
  configuration guide states the four origin words together instead of three
  plus a note.
- The plane's three start lines now read as one family in the log file, and a
  reviewer can tell a Consultation pickup from a Consultation force-dispatch.
  For a Consultation the mode names the key, so a reader must not read
  `mode force-dispatch` beside a reading under the limit as a contradiction of
  ADR 0092.
- `src/domain/start-mode.ts` is the one place the three mode tokens are named.
  A new start channel adds a token there, not a second string union.
