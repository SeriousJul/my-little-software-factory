# ADR 0045: A task type override places the ticket on the chosen task's state

Status: accepted
Date: 2026-09-22

## Context

The workflow machine places a ticket by its labels: the position is the first
state whose match holds on the ticket, re-derived on every refresh (ADR
0027). In the machines the operators run, the entry into the machine is a
hand-applied label - `ready-for-agent` on an issue, the states matched in
order on `labels-any` - and no transition writes that label back.

The Override panel lets the operator change the task type of one Handoff. The
completion behavior already follows the override: the chosen task type's
Transition fires on its `completed` settle. What the override does not change
is the entry side. The ticket keeps the label that put it on the old state,
the old state still matches first, and the machine re-derives the ticket's
position where it started. The operator's skip is not durable: the next
suggestion, and any auto-advance, points back at the step the operator just
skipped, and an auto-handoff re-runs it.

The plane's write path so far is the settle-time fire, which owns the
transition-written label set and removes nothing else. The entry labels are
outside that set, so no fire can move the ticket between hand-applied
positions, and the override has no effect the labels can see.

## Decision

**The Placement.** When a manual Handoff's final task type differs from the
task the ticket's current position suggests, the control plane writes the
ticket's labels before the agent starts: a **Placement**. The target is the
first state, in machine order, that offers the chosen task and whose non-label
conditions (source name, kind, repository) hold for the ticket. The write
adds the target state's all and any labels and removes the placement labels
the state does not name. After it runs, the ticket's derived position offers
the chosen task, whatever writers ran before.

**The entry is derived from the match spec, not configured.** ADR 0027 makes
the labels the states and names no destination. The Placement extends the
same principle to the handoff side: the match spec is the single source of a
ticket's position, so the entry to a state is what the match says. No config
key names the entry. A **placement label** is a label named in a state's all
or any match set; the none set names exclusion, not ownership, and a label no
state names - a priority or severity label, an operator label - is never
touched by the write.

**The detection and the Placement share one computation.** The Placement
reuses the detection's ordered state walk and its match test. The post-write
label set is the ticket's labels minus the placement labels, plus the target
state's all and any labels, and the first state to match that set must offer
the chosen task. When it does not, the Placement is infeasible: the task is
offered by no state that matches the ticket's kind, a label the target state
excludes stands on the ticket, two states claim one label, or no state
matches the post-write set. The override's confirm refuses an infeasible
Placement with a readable reason that names the cause, and the override
panel's Task row carries that reason as a warning sentence, the way an unfit
setting row does. The infeasible types stay selectable: the panel offers
every configured task type, and the refusal is the fact.

**The write sits in the Handoff's external sequence.** It runs after the
durable claim and before the agent start, through the same command runner
path the fire uses, as the source the item lists on - the membership the
target state matches on, the newest one when several match. A failed write
refuses the start with a readable reason: the ticket keeps its position, and
the attempt records as a failed start. A start failure after a good write
leaves the write standing: the operator's assertion holds, and the next
handoff of the ticket converges at its settle. The write is idempotent: a
label set that already matches the spec writes nothing, so a Restart that
repeats the interrupted choices re-runs the rule and takes egress only when
the labels still differ.

**The scope is the ticket, on the trigger the override makes.** The write
touches the ticket being handed off, never its fixing pull request: the
pull request's position follows its own transitions. The trigger is the
difference between the final task type and the ticket's current suggestion,
on both panel origins: the open ticket, and the route edit from the Decision
modal or the Live view. A Restart re-runs the same rule, with no special
case. An auto-handoff, a workflow advance, and the default handoff of a
parked ticket never differ from the suggestion, so they never fire. From a
parked ticket, picking a task a state offers places the ticket into the
machine; picking the default task type writes nothing.

The alternatives:

- **A configured entry list per state** (an `entry` key beside the match).
  Rejected: it adds a second source of position next to the match spec, and
  the entry is already determined by the spec the detection reads. A config
  key the machine derives for free is drift waiting for an edit.
- **The write at settle time, as an extension of the fire.** Rejected: the
  fire's facts are the task's completion facts, and folding the entry move
  into them would make one task type's transition responsible for another
  task's entry, and for the position the ticket wore before this turn.
- **Proceed on a failed write, report it as a fact.** Rejected: the agent
  runs on the chosen task while the labels still name the old position, and
  a failed turn leaves the ticket where the machine re-suggests the skipped
  step. The operator's assertion is either made or not made.

## Consequences

- The plane now holds two external write paths with two ownership sets: the
  fire owns the transition-written set at settle time (ADR 0027), the
  Placement owns the placement label set at handoff time. A gate label named
  in one state's all set alone is a placement label and travels with the
  state: a Placement strips it when the ticket leaves the state. A
  machine-wide gate, named in every state's all set, sits in every target's
  add set and is never stripped.
- The operator's skip is durable. After the Placement, the position offers
  the chosen task, and the machine cannot re-suggest the skipped step. When
  the chosen task's Transition leaves the position where the Placement put
  it, the Same-type hold (ADR 0026) catches the repeat the way it already
  does.
- A Placement failure refuses a start the operator asked for. The refusal is
  a readable fact on the Handoff, the ticket stays open on its old position,
  and a retry re-runs the write.
- A ticket listed on more than one source takes one write, on the
  membership the target state matches; the other memberships converge on the
  next refresh, the same lag a fire's write carries.
- The override panel's Task row can now carry a reason sentence for this
  ticket's infeasible choices, and a confirm can refuse on it. The row's
  options stay the full task type list, per ticket kind.
