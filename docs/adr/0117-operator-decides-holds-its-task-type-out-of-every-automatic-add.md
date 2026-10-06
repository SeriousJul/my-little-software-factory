# ADR 0117: Operator-decides holds its Task type out of every automatic add

Status: accepted
Date: 2026-10-06
Extends ADR 0085 (renamed by ADR 0092): the flag parked that type's completions
for the operator, and this decision gives it the starts as well. Amends ADR 0051
and ADR 0108: the Top-up's automatic adds now hold on the Task type they
resolve, and a Restart the flag holds leaves its seat unreserved.

## Context

ADR 0085 gave a Task type one brake: when `operator-decides` stands, the
automatic Completion rule returns the park for every completion of the type, so
the turn rests in `awaiting`, the environment and the Agent stay untouched, and
the operator's close or route is the gate to whatever comes next. The flag was
built for the shipped `analyze` type, a ticket-driven interview the agent runs
with the operator in the live terminal: an auto close would take the environment
down between the agent's question and the operator's answer.

The flag reaches one place in the code, `decideAwaiting`, and that place answers
only the Completion decision. The Top-up's automatic adds (ADR 0051) read no
per-task-type fact at all, so the mode asks a start of the flagged type
wherever a walk resolves one:

- the open Ticket's fresh-work row, gated only on the row offering *some* task;
- the Continuation, whose Next step can land on a position that offers a flagged
  type;
- the re-fired skip's route, which reads the same derivation;
- the Restart of a Missing agent, which repeats the interrupted Handoff's
  choices, its Task type included;
- the Plane action's automatic merge ask, since the flag is allowed on either
  Task type form (ADR 0068).

The shipped machine makes the first of these a live fault. Its `ready-for-spec`
state offers `analyze`, the Repository init registers an issues feed on that
label (ADR 0115), and the flag stands on the type. So an open issue carrying
`ready-for-spec` sits in the pile as an ordinary open Ticket that offers a task,
and in Auto-handoff mode the Top-up hands it off. The factory then starts an
interview with nobody at the terminal to answer its frontier: the agent asks its
open questions, ends the turn, and the ticket-driven grilling waits on an
operator who was never asked whether the interview should run.

issue #332 states the expectation the flag was meant to carry: "Tasks flags by
'operator-decide' (or whatever its called in config), should not automatically
be schedule by auto handoff mode".

ADR 0085's own consequence claims the Top-up already leaves such a Ticket alone,
"because a continuation needs a Transition that fired and a parked ticket is not
open". That is true of a parked *turn* and false of a *type*: a Ticket that has
never run an analyze is open, its position offers analyze, and the walk asks it.

## Decision

**One key, one meaning: an Operator-decides Task type is the operator's, and
Auto-handoff mode asks no start of it.** No second key. The flag's purpose is
that the operator is a participant in that type's turns, and a start the machine
makes alone is the same fault as a close it makes alone. A second key, say
`no-auto-start`, would buy one combination the shipped machine does not want -
auto-started interviews whose completions wait for the operator - at the price
of two flags on one type and four states to document and test.

**The brake covers every automatic add.** The open Ticket's fresh-work row, the
Continuation and the re-fired skip's route, the Restart of a Missing agent, and
a Plane action's automatic merge ask all hold when the Task type the add
resolves carries the flag. Each walk holds that Ticket only and falls to the
next candidate, exactly as every other row gate does, so a `ready-for-agent`
Ticket later in the list's order still gets its row.

**The Restart is covered, not carved out.** A restart is recovery rather than
fresh work, and ADR 0108 reserves the seat a Missing agent left for that
Ticket's own restart row. The flag still holds it: re-opening an interview the
operator must answer, while they are away, spends a Handoff attempt and a seat
on the same act the flag exists to keep out of the machine's hands. ADR 0108
already names this case - "a seat no Restart can take - the flag, the Handoff
limit, or the mode stands - is not reserved" - and the Operator-decides brake
joins that list. The Missing modal stands, and the operator's Restart or
abandon is the act that answers.

**The Next step gains a fifth gate, and it is read first.** `deriveNextStep`
owns the gates a step can stand under, and one derivation serves the automatic
Completion rule, both continuation walks, and the Decision screen. The new gate
is `operator-decides-type`, its sentence is "the task type carries
Operator-decides", and the derivation reads it before it looks the position up
and before the Handoff limit gate. The order is behavior, not wording: the
Handoff limit gate degrades a held step to `close` and ends the work cycle, and
a step the operator owns must not be closed away by a cap. So the automatic
rule answers `hold`, the settled turn rests in `awaiting` with no decision
recorded, and the gate sentence reaches the Message line, the plane's record,
and the Decision screen - where the row keeps its key, because the operator's
confirm passes the brake.

**The fresh-work and restart skips are silent.** No new hold reason, no Message
line, no row marker, no detail line. The Failed-start park and the Agent name
collision state themselves because they are faults the operator has to
diagnose; a flag the operator set in their own config is a designed silence, the
way the Same-type hold and the parking state are silent. The Ticket's own task
badge and its position name already answer what it waits on.

**The operator's hand passes it, everywhere.** The handoff of a Ticket parked on
a flagged position, the override panel, the Decision screen's handoff and merge
rows, the Pickup of a row already standing in the Work queue, and a
force-dispatch all start the type. The brake gates the machine's own asks, the
way the Handoff limit, the queue pause, the Attempt hold, the Failed-start park,
and the Agent name collision do.

**The Handoff limit's cycle end is not covered.** `handleMissing` ends the work
cycle with `abandoned` and runs the Close cleanup when a missing agent's Ticket
has used up its handoffs. That is the loop guard's cycle end, not a start, and
holding it would leave a dead in-flight Ticket with no brake at all. With the
restart held, that count only grows from the operator's own starts, so the path
is nearly unreachable for a flagged type.

**No new setting, and no startup warning.** If an operator sets
`default-task-type` to a flagged type, every Ticket no state matches suggests a
type the machine will never start, and Auto-handoff mode asks no fresh work.
That follows from one rule the same way a config that names only parking states
starts nothing, and a startup warning would be one more fact to keep true.

## Options considered

- **A second config key for the start brake.** Rejected above: two flags, four
  states, and the combination it buys is the one the flag's purpose forbids.
- **Cover the fresh-work walk only.** Rejected: it fixes the shipped symptom and
  leaves the Continuation, the Restart, and the merge ask asking the same type
  by another path, so the rule would read "the machine does not start it
  usually".
- **Leave the Restart as recovery.** Rejected: one rule with no exception is
  simpler to hold in mind and to test, and every other automatic brake gates the
  automatic adds and leaves the operator's key.
- **Check the flag once in the shared ask step, `topUpAsk`.** Rejected: the
  walks would get no gate fact to report, and the Completion decision needs the
  check at the Next step derivation anyway, so the one check would still leave a
  second copy.
- **State the skip on the row, the detail, or the record.** Rejected: the flag is
  the operator's own config, and a new hold reason would extend the hold
  vocabulary for a fact nobody has to diagnose.
- **Read the new gate after the Handoff limit gate.** Rejected: the limit
  degrades to `close`, so the order would end cycles the operator owns.

## Consequences

The glossary's Operator-decides entry now names both brakes, and its old
sentence - "the auto top-up leaves the ticket alone: a continuation needs a Next
step, and a parked ticket is not open" - is retired, because it described the
parked turn and never the type. The Parallel limit entry's reserved-seat clause
gains the brake.

The rule is one predicate over the Task type, read at three gates: the Next step
derivation, the Top-up's open-ticket row gate, and its restart candidate gate.
No walk holds its own copy, and no surface states a hold the rule did not answer.

The shipped machine's `ready-for-spec` position becomes a position the operator
starts by hand. Auto-handoff mode still reads the position, still shows the
badge and the position name, and asks nothing; the operator's key on the Ticket
starts the interview, and the analyze agent's own label write (ADR 0086) still
hands the Ticket to the `ready-for-agent` position for the machine to work
unattended. That is the intended division: the human decides when a design
interview runs, and the machine does the rest.

The `operator-decides` key keeps its name, its type, and its default, so no
config migration and no state file migration follows.

What is not measured is recorded in the workflow machine verification record:
the acceptance targets issue #332 carries have no test until the implementation
lands, and the shipped machine hands off a `ready-for-spec` Ticket in auto mode
today.
