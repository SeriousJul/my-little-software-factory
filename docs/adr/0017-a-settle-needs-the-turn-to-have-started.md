# ADR 0017: A settle needs the turn to have started

Status: accepted
Date: 2026-09-13

## Context

The Startup grace defends a fresh Handoff against the window in which a
booting agent reports idle before it picks up the prompt. The grace guards
only the `handed-off` state: the moment herdr reports the agent `working`,
the ticket runs, and the next idle or done report settles it at once. The
working report was the proof that the turn demonstrably started.

Herdr's working report is not that proof. ADR 0015 already rejects herdr's
status as the source of the turn end cause: it is herdr's view of the pane,
not the runtime's record of the turn. The same holds for the settle gate.
Measured against the dev state, a codex handoff into a directory whose hooks
were not reviewed settled 17 to 20 seconds after the start, auto-closed the
cycle, and its trace held the boot dialog as the turn's last message: herdr
flapped `working` during boot, the flap dropped the grace, and the parked
agent's idle settled a turn that never started. The task was recorded done
without running.

The session record the settle already reads (ADR 0008, ADR 0015) is the
evidence: it holds the turn when the turn ran, and it holds no turn when it
did not.

## Decision

**The gate reads the record, not the status.** A done or idle report settles
a fresh Handoff when the session record shows the turn ended, or when the
Startup grace is over. A working report no longer drops the grace: the
ticket still runs and still holds its seat, but the grace stays until the
record or the clock says otherwise. A real turn that ends inside the grace
settles at once, because its end is in the record; nothing that runs waits
longer than it does today.

**The read has three answers.** One read of the record returns: the turn
ended, with its log and cause; the record is readable and well-formed but
holds no turn; or the record is unavailable, the reader knows no such kind,
or the record is unreadable. The first settles at once. The second and the
third wait out the grace.

**`no-turn` is a turn end cause, and it holds.** The vocabulary ADR 0015
closed at five values grows a sixth: `no-turn`, the readable record with no
turn in it. It is a held cause alongside `failed`, `aborted`, and
`truncated` (ADR 0016): a settle that reaches it waits the grace out,
settles with the terminal capture standing in for the log, and rests in
`awaiting` with no automatic decision on it. The operator reads the hold and
decides. It does not pause the Dispatch: a turn that never started is a
local Handoff event, not the system pressure `failed` names.

**Unavailable still fails open.** No session reported, no reader for the
kind, or a missing, unreadable, or malformed record settles `unknown` past
the grace, exactly as ADR 0015 degrades it today: auto-decides, never
blocks. A record that is readable but empty of turns is not unavailable;
conflating the two would let a parked agent auto-close its cycle on a
capture of its own boot screen.

**The staleness guard is unchanged.** A record whose last turn end predates
the Handoff settles `unknown` at once, as it does today: the record says a
turn ended, and the guard only refuses to call it this turn's completion.

**Consultations fail open on `no-turn`.** A Consultation turn that settles
on a record with no turn settles `unknown` and rests in `awaiting-response`,
as an unreadable record does today. The ticket's auto-close is the damage
this ADR stops; a Consultation auto-decides nothing, and its operator is
present at the screen it settles on.

## Considered alternatives

- Keep the working report as proof and lengthen the grace. Rejected: the
  proof is herdr's view of the pane (ADR 0015's rejection still stands), and
  no grace length out-waits an agent parked in a dialog that never ends.
- Settle `no-turn` as `unknown` and only fix the gate. Rejected: the parked
  agent still settles past the grace and still auto-closes its cycle; the
  operator still sees a task done that never ran, thirty seconds later.
- Never settle a turn the record does not show. Rejected: a parked agent
  would hold its parallel seat forever, with no trace and no operator
  surface; settling held keeps the fact durable and the seat freed.

## Consequences

- The vocabulary ADR 0015 closed at five values holds six. Legacy traces
  predate `no-turn` and read their stored causes unchanged.
- A real turn that ends inside the grace settles at once, on its record:
  the gate's evidence is the turn end, so a fast turn does not wait the
  booting window out.
- A single working report - the flap - can no longer settle a fresh
  Handoff early. The startup window's protection is the record and the
  clock, not a status the pane can flicker.
- A parked agent settles `no-turn` past the grace, rests held in `awaiting`,
  and names itself on the Message line; the operator decides it, and the
  cycle it held is not closed on a boot screen.
- The Dispatch pause is untouched: it still reads only the held `failed`
  traces.
