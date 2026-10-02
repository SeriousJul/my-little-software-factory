# ADR 0085: A no-auto-decision task type parks its completions for the operator

Status: accepted
Date: 2026-10-02

## Context

In Auto-handoff mode the control plane resolves every awaiting ticket with
its automatic Completion decision: a completion whose Transition fired routes
or, on a label write failure, parks, and a completion with no Transition
closes, ending the cycle and removing its environment. A ticket-driven
interview - the `analyze` task type - is a task type with no Transition, and
its interview continues live with the operator in the terminal: the agent
asks its open frontier, ends the turn, and the awaiting ticket reopens to
running when the operator answers and the agent works again. The auto close
on every settled turn would remove the environment and kill the live session
before the operator answers.

## Decision

A new task type property, `no-auto-decision`. When it is set, the automatic
rule returns the park outcome for every completion of the type, ahead of its
outcome checks: the ticket rests in `awaiting` for the operator, the
environment and the agent stay untouched, and the operator's explicit close
or route still runs. The park is the standing park, not a new state: the
ticket shows as a decision owed, and the auto top-up leaves it alone, because
a continuation needs a Transition that fired and a parked ticket is not open.

The key is validated as a boolean, is allowed on either task type form, and
in the shipped configuration the `analyze` type is its only user. In auto
mode the operator's close is the gate between the parked turn and whatever
the ticket's new position offers next.

## Consequences

- A live interview survives auto mode: a settled turn rests for the operator
  instead of killing the session, and the same-type hold, the dispatch
  pause, and the top-up walks are unchanged, because they already leave a
  parked completion alone.
- The machine never auto-routes a parked completion either: the operator
  confirms the handoff their close sets up, so a spec that the operator has
  not seen starting the implementation is not a machine path.
- The key is declarative config: an operator can park any task type's
  completions for themselves, not only the shipped `analyze` type.
- A task type without the key closes exactly as before; the auto-mode suite
  keeps that behavior under a regression guard beside the new park cases.
