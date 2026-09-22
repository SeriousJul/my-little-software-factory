# ADR 0029: Security tickets synthesize severity as labels

Status: accepted
Date: 2026-09-16
Superseded in part by ADR 0050: the Priority label list that ordered the synthesized severities no longer exists. The severities stay source-fact labels the Workflow states may match on.

## Context

Three of the security ticket sources carry no labels on GitHub. A repository
security advisory carries a severity, a Dependabot alert carries one on its
embedded security advisory, and a secret scanning alert carries neither. The
factory ranks tickets through the Priority label list and matches task rules
on label sets, so a severity that never reaches the label set cannot rank a
ticket and a rule cannot target it. For issues and pull requests every label
is an external fact the control plane only reads; the security item types have
no label slot to put the severity in, so the source must decide what the
ticket's label set carries.

## Decision

**The source synthesizes one label per security ticket from its severity
fact.** A security advisory and a Dependabot alert take the bare severity
word as their single label: `critical`, `high`, `medium`, or `low`; an item
with no severity takes none. An open secret scanning alert takes the label
`critical`: an exposed credential stays live until it is rotated, so it ranks
at the top of the list while it is open.

**The synthesized label is a source fact, not a writable label.** A refresh
can change it when the severity changes, and a ticket that leaves the source
list drops it with the ticket. The control plane never writes it to the
external source: none of the three item types takes labels on GitHub, and the
shipped task types of the security kinds write no transition labels on their
tickets.

The bare word is deliberate, against a prefixed name such as
`severity-critical`: the Priority label list the Default configuration ships
already names `critical`, `high`, and `low`, so a security ticket ranks the
moment its source is configured, with no operator edit. A severity the list
does not name (the default list omits `medium`) ranks no ticket, exactly as
an unlabeled issue does; the operator extends the list when they want that
rank.
