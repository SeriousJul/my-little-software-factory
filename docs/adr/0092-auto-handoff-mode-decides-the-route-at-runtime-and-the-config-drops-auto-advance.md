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
fault becomes loud instead: a marker on the ticket, a Message line, and the Decision
screen's fact line.

**A start line names how it started.** The dispatch's start line carries the dispatch
mode, the item's origin, and the seat count against the Parallel limit at the moment of
the start. Today the line names only the origin, so a force-dispatch over the cap, a
pickup start, and a top-up route read the same, and a reviewer cannot tell a cap breach
from an operator's hand.

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
- The `agent` and `environment` pins on a Transition and its branches stay. They name
  the Agent and Environment the derived route runs on, and they are the route's
  settings, not the deleted flag.
- A config that carries either deleted key fails at load. Both shipped configs, the
  docs example, and the docs tables change in the same move.
