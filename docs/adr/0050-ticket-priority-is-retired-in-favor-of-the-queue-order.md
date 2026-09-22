# ADR 0050: Ticket priority is retired in favor of the queue order

Status: accepted
Date: 2026-09-22

## Context

Ticket priority was a fact of the ticket identity: a rank from the
Priority label list, an operator override, and the inheritance of a pull
request through the issues it closes (ADR 0022, ADR 0023). One comparator
ordered the ticket list within each attention group, the open
auto-handoff dispatch, and the waiting workflow advances that competed
for a freed parallel slot.

The Work queue is the single start channel now (ADR 0049), and the
operator steers its order with `+` and `-`. Two answers to "what starts
next", the queue order the operator moves and the priority the labels
and the override carry, compete for the same question: a rank the
operator's reorder cannot beat, or a promoted item the rank pushes back.
One of the two has to lose.

## Decision

**Ticket priority is retired.** The config's priority label list, the
rank computation, the pull request's inheritance, the operator's
override and its keys, and the priority verification record all go.
ADR 0022 and the rank rule of ADR 0023 are superseded. The queue order
is the order of work: the position an item holds in the Work queue is
the position its start takes.

**The list orders by attention, not by rank.** Within its attention
group, the ticket list sorts by newest external update, then ticket
identity, the order that stood before the rank. The list shows where the
operator's attention goes, and the queue shows what starts next.

**The link stands, its rank goes.** The closing references a pull request
carries stay the source fact they are: ADR 0042's fixing pull request
rule derives from them, and the Transition's linked pull request lookup
reads them (ADR 0027). What goes is the rank they carried: the labels
the control plane fetched for a referenced issue that no source lists,
to supply a priority, are no longer fetched, and the Referenced issue
fact that held them is removed.

**Severity stays a label.** The security sources still synthesize their
severities as labels (ADR 0029): the labels are source facts the
Workflow states may match on. They no longer order anything.

**The migrations.** A state file that stored priority overrides drops
the values in a one-time migration. A config file that carries the
priority table is migrated at load, the way the workflow machine
migration carried its old keys (ADR 0027): the table is removed, the old
file is backed up to `config.toml.bak`, the change is named in a
readable report, and the loader is strict afterwards.

## Consequences

- The ticket detail loses the priority row of the override panel, and
  the ticket section loses the keys that raised, lowered, and cleared a
  rank. `+` and `-` keep their keys and gain the queue's meaning
  (ADR 0049); the sections that do not own them name them nowhere.
- A pull request no longer wears the rank of the issues it closes; the
  ticket it fixes still rests behind it in the list (ADR 0042), which
  is the rule the operator sees.
- The automatic top-up orders several competing continuations by the
  ticket list order: the order the operator sees is the order the
  factory acts in (ADR 0051).
- The priority verification record is removed with the feature.
