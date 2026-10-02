# ADR 0086: The settling agent writes the operator-owned labels

Status: accepted
Date: 2026-10-02

## Context

The standing rule is that the agents never write workflow labels: the plane's
fire is the only writer of the machine-owned label facts a Transition names,
and the operator-owned entry labels - for example `ready-for-agent` - are the
operator's to write. The `analyze` task type's interview ends with the design
settled, and the ticket needs to move to the implementation position. The
agent already runs gh in the session - it reads the ticket and writes the
specification - and waiting for the operator to label the ticket by hand
after every interview is friction in a flow the operator has put in the
machine's hands.

## Decision

A sanctioned exception, named in the `analyze` template: when, and only
when, the specification is settled and the documentation is committed, the
agent applies `ready-for-agent` to the ticket through gh. In the fallback,
where the ticket body cannot be edited and the specification opens in a
second issue, the agent additionally applies a `spec:<issue number>` label
carrying that issue's number.

The agent writes only operator-owned labels the template names: a label no
Transition writes. It never writes a label the machine writes in a
Transition, and it never writes a label the template does not name. The rule's
wording updates where it stands: the agents never write the labels the
machine writes.

## Consequences

- The ticket moves to the implementation position at session end without
  operator action, and the machine picks the label up on its source refresh,
  because the position is re-derived on every refresh and never stored.
- The operator keeps the gate: in auto mode the implementation starts only
  after their close of the parked cycle (ADR 0085), and a specification they
  reject is rewound through the Placement, an override back to `analyze`
  re-places the labels onto the spec state.
- A write the operator did not want is visible as a plain external label
  write and removable the same way any label is; the exception is bounded to
  the template's named labels, so the machine-owned set stays machine-only.
