# ADR 0092: Auto-handoff mode decides the route at runtime, and the config drops auto-advance

Status: accepted
Date: 2026-10-03

## Context

ADR 0027 gave a Transition an `auto-advance` flag, and ADR 0051 made that flag the
gate on the top-up's continuation: a fired, auto-advancing Transition whose new
position offers a task routes, and anything else closes. Auto-handoff mode grew into
the operator's lights-off mode over the same period, and the two now answer one
question twice. The flag has four readers: the automatic Completion decision, the
re-fired skip's walk, the handoff key's notice line, and the Live view's mode. The
Decision screen reads the derived position and reads none of them, so the screen
offers a route the machine refuses to take.

The shipped configs show what the duplication costs. `auto-advance = true` stands on
the three security task types and on nothing else, in both `config/default.toml` and
`config/development.toml`. The whole issue-to-pull-request chain, implement, review,
rework, and merge, closes its cycle at every step and re-enters the top-up as fresh
open work. The continuation the top-up was built for never fires on that chain. A dev
run on 2026-10-03 recorded it directly: an implement turn on an issue fired, derived
its review position on the linked pull request, and closed, because the flag was off.

## Decision

**Delete `auto-advance`.** The key leaves the parser, both shipped configs, the two
config docs table rows, the Notes paragraph, and the docs' example config. The parser
rejects unknown keys in a transition table and in a branch table, so a config that
still carries the key fails at load with that error. There is no ignore path and no
migration shim.

**The mode decides at runtime.** A settled turn has a Next step when its Transition
fired, wrote its label facts, and its new position offers a task. In Auto-handoff mode
the machine routes it, and the top-up's continuation walk adds it first, ahead of a
restart, an open pull request ticket, and fresh work. With no Next step the machine
closes, as it did. In manual mode the machine decides nothing, as it does today.

**One derivation carries the gates.** The Next step is derived once, in the module
that owns the machine, and it answers the task type, the ticket the position stands
on, whether the step is a Handoff or a Plane action, and the reason the step will not
run when a gate holds it: the position no longer offers the task, the position is not
actionable, the Same-type hold, or the Handoff limit. The Decision screen states that
reason where it today offers a key the machine would refuse.

**The automatic merge is accepted.** With the flag gone, the review's
above-threshold branch lands the Next step on the merge, and the top-up's automatic
Plane action ask runs it: an agent's own score squash-merges a pull request with no
keypress. The operator accepts this, because the mode's promise is unattended work and
the score threshold is the gate the review task type exists to provide.

**`no-auto-decision` survives, renamed `operator-decides`.** It answers a different
question from the flag: not which step the machine may take, but whether the machine
decides at all. It is the only per-task-type brake Auto-handoff mode carries, and the
shipped `analyze` type needs it: a live interview task type carries no Transition, so
without the brake the machine closes the cycle of a turn whose interview is still
running. The rename lands in the same change, and the parser rejects the old key as
loudly as it rejects `auto-advance`.

**A fault the machine caused gets no seat priority.** A ticket parked on a failed
label write holds no seat, and the top-up fills the seat with other work. The plane
considered holding the top-up's restart, open pull request, and fresh walks while such
a ticket waits, and rejected it: a failed label write never heals by itself, the only
exits are the operator's close or route, so the hold idles the factory until the
operator returns. The operator chose an unoptimized workflow over a stopped chain. The
fault becomes loud instead, on the two surfaces the plane already has for a settled
turn: the Message line states it on the settle whose write failed and on the re-fire
of a recorded skip, and the Decision screen states it as its fact line beside the
facts the fire did write. No marker stands on the ticket's row: the row's markers are
the poll-time Agent facts, `blocked` and `missing`, and a failed write is a fact of
the fire, not of the Agent. The parked row already reads as a decision owed, and the
Decision screen is where the operator reads the reason.

**Superseded during implementation: what the parser answers.** The Decision paragraph
above accepts the plain unknown-key error for a config that still carries the key. The
implementation the review measured answers a named retirement instead: `"auto-advance"
is retired (ADR 0092): Auto-handoff mode decides the route from the settled turn's Next
step`, the way the renamed `no-auto-decision` names its new key. Both shipped configs
wrote the key on three transitions, so an install that upgrades from either reads the
retirement and not a bare unknown key. This is a deliberate change to the ticket's
acceptance, which asked for "the parser's unknown-key error": the named error tells an
upgrading install what replaced its key instead of only that a key is unknown. The rest
of that paragraph stands - no ignore path, no migration shim, and the one-shot config
migration does not take the key.

**A held Next step is stated where the operator reads it.** A gate hold was the one
route decision with no reader in the mode that produces it: the Decision screen never
opens on a settled turn in Auto-handoff mode, so a turn whose step a gate holds rested
in awaiting as an ordinary owed decision, and the operator had to open the Decision
screen by hand to learn the gate. The mode that produces the hold now states it: the
observation reports the held step on the Message line beside the settle that produced
it - the step, the position it stands on when that is not the settled ticket, and the
same gate sentence the Decision screen states in manual mode. One line per settled turn,
and it is news, not a warning: a hold is often the gap between the labels a fire wrote
and the refresh that re-reads them, and the cycle that closes the gap states its own
routing line over it. `park` keeps no line of its own because its reader is the row
itself: the Operator-decides type is the operator's own brake, and its awaiting row
says the turn awaits them.

**A start line names how it started.** The dispatch's start line carries the start
mode, the item's origin, and the seat reading: `handoff started: <name> (mode <mode>,
origin <origin>, seats <held>/<limit>)`, and the same shape on the `merge started:` line
a Plane action start now writes. The mode is `pickup`, `force-dispatch`, or `direct-ask`,
one token each. `max-parallel-agents = 0` lifts the cap, and then the seat part states no
limit: `seats <held>`. Today the line names only the origin, so a force-dispatch over the
cap, a pickup start, and a top-up route read the same, and a reviewer cannot tell a cap
breach from an operator's hand.

**Amended by ADR 0102: a third start line, owned by a third module.** A Consultation
start now writes `consultation started: "<type>" <id8> (mode <mode>, origin consultation,
seats <held>/<limit>)`, and the Consultation operations write it, not this dispatch. The
dispatch holds no Consultation start fact - it neither re-reads the Consultation type's
settings nor moves the record to `opening` nor runs the opening - so it carries the mode
across the `pickupConsultation` seam and lets the module that performed the start state
it. `StartMode` moved to `src/domain/start-mode.ts`, the one name both line owners read,
and the `seats` field's text moved to `parallelSeatReading` in `src/parallel.ts`, beside
the count rule and the limit text rule the three lines share.

**The seat reading is the count the gate stood on.** The reading is taken before the
start claims its own seat, so it is the count the Parallel limit gate stood on, never a
count the start raised itself. The pickup starts only into a free seat, so its reading
always sits under the limit; a reading that already stands at the limit - `seats 1/1`
under a cap of 1, `seats 2/2` under a cap of 2 - is the force-dispatch that crossed it.
A `merge started:` line is the exception a reader must know: a Plane action takes no
seat, and the pickup runs it whatever the limit reads (ADR 0068), so `seats 1/1` on a
merge line states the count the plane stood on at the start and is a normal start, not a
breach. A `consultation started:` line carries the second exception (ADR 0102): the
Consultation section's key names `mode force-dispatch` whatever the count reads, so there
the mode names the operator's key on the record and not a crossing, and `mode
force-dispatch` beside `seats 0/2` is a normal start.

**The mode names the pass, not the ask.** Every start enters the Work queue first (ADR
0049), so the dispatch cannot tell the operator's row from the factory's row at the
claim. Only the immediate pass an operator's own ask runs names that ask's row as
`direct-ask`. A row the operator asked for that found no free seat reads `mode pickup`
when a later cycle starts it, the same line an automatic top-up start writes. The log
tells a pickup from a force-dispatch from a seat-count fault; it does not tell an
operator's ask from the factory's ask for a start that waited in the queue.

## Consequences

- ADR 0027's `auto-advance` flag is superseded. Its machine, fire, and label rules
  stand.
- ADR 0051's continuation definition changes: a continuation is the Next step, not an
  auto-advancing Transition's outcome. Its single-channel, one-item-per-cycle, and gate
  rules stand.
- The four readers collapse to one rule, "Auto-handoff mode is on, and the settled turn
  has a Next step". The handoff key's `task type X auto-advances` notice line is
  deleted, and in manual mode the handoff key on an awaiting ticket always opens the
  Decision screen.
- The review and rework loop runs unattended up to the Handoff limit, 20 in the dev
  config. The limit is the brake, and the operator accepts it: the models the factory
  runs on may need the extra turns.
- The Handoff limit gate reads the position the step stands on, not the ticket the
  settled turn ran on. For the common case - the position is the settled ticket -
  nothing changes. For a cross-ticket route the rule flips: the old flag read the
  settled ticket's own count and rested the turn in `awaiting`, and the new rule reads
  the position's count, closes the settled turn, and the top-up's fresh walk then
  re-dispatches the settled ticket as open work. A settled ticket whose own routes
  land on a position at its limit can therefore spend its own handoff budget on those
  turns. Each round spends one handoff of that budget, so the loop ends where the budget
  ends: the settled ticket stands at its own limit, the fresh walk holds it out, the queue
  stays empty, and the ticket rests open owing its next start to the operator. The test
  follows the loop to that end. The operator accepts this: the two continuation walks read
  one rule, and the limit that holds a step is the limit of the ticket the step starts on.
- The `agent` and `environment` pins on a Transition and its branches stay. They name
  the Agent and Environment the derived route runs on, and they are the route's
  settings, not the deleted flag.
- A config that carries either deleted key fails at load, each with the error that
  names what replaced it - the superseding note above records why that is not the plain
  unknown-key error the ticket asked for. Both shipped configs, the docs example, and the
  docs tables change in the same move.
- The gate sentence table lives with the derivation that owns the gates, because two
  surfaces read it: the Decision screen in manual mode, and the Message line in
  Auto-handoff mode. A gate added without a sentence, or a sentence reworded, fails a
  test.
