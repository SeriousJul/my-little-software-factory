# ADR 0118: A Fault is the only Message fact that leaves the terminal

Status: accepted
Date: 2026-10-06

## Context

ADR 0080 tied the Desktop notification to the Message line's severity: every
write of a warning or an error sent one notification. That tied two different
facts to one word. The pass over the plane's warning and error writes (issue
#331) counted about 120 of them, and most are answers to a key the operator
pressed a moment earlier: a control the catalogue refused, an action the plane
could not carry out, a result with nothing wrong in it. Each one spawned a
notification for a fact the operator was already looking at. The same pass
found facts that are not problems at all wearing the `Warning:` word, such as
the line a successful Close leaves.

The severity answers one question: what word and what color does the line wear.
Whether the fact leaves the terminal answers a different question: is anyone
away from it.

## Decision

The plane separates the two axes.

**Severity** stays the Message line's own fact: `working`, `info`, `warning`,
`error`. It is the written prefix, the line's color, and the history chip. The
rule for the word:

- `error`: the plane tried something and it failed, and the work cannot move on
  without the operator.
- `warning`: something did not happen, or a condition stands, and the operator
  must know it, but nothing failed.
- `info`: what a control did, or a fact with nothing wrong in it.

**Fault** is the second axis, and it is a property of the write, not of the
word. A Fault is a warning or an error the plane met on its own, not an answer
to a key the operator pressed. Only a Fault sends the Desktop notification. The
rule is who is waiting for the answer: a fact written while the operator waits
on their own key stays on the terminal, and a fact the plane produced on its
own, while the operator may be away, leaves it.

The Message facts module owns both channels at its interface: `warning`,
`error`, `news`, and `notice` write the line only, and `faultWarning` and
`faultError` write the line and send the notification. Every write site takes
one of the two, so the channel is visible where the fact is written.

The groups, and what each one is:

| Group | Severity | Fault |
| --- | --- | --- |
| A key the catalogue refused | warning | no |
| A control's own result, with nothing wrong in it | info | no |
| A failure of the action the operator just started | error | no |
| A machine operation that failed | error | yes |
| A machine step that was asked for and not run | warning | yes |
| A standing condition the plane is in: a stale source, a park, a hold, a collision | warning | yes |
| A Consultation turn that ended failed, aborted, truncated, or with no turn | warning | yes |
| A warning a successful source read carries | warning | yes |
| The plane's own degraded boot, such as the Theme fallback | info notice | no |

The notification's standing-fact rule (ADR 0080) and its `desktop-notification`
gate are unchanged, and no new config key joins them: whether a fact is a Fault
is a fact about the event, not a setting the operator tunes per run.

## Considered options

- **One axis: re-level the writes so only real problems are warnings and
  errors.** Rejected: a refusal is a warning the operator must see on the line,
  and it still never deserves a notification for a fact they caused a second
  ago. One word cannot carry both facts, so the re-level alone would trade a
  noisy desktop against a dishonest line.

- **Gate the notification on the module that wrote the fact.** Rejected: the
  channel is a fact about the event, not about the file. `handoff-dispatch`
  holds both kinds, because a force-dispatch refusal answers the operator's key
  while a queued handoff that was not run answers nothing.

- **A `notify-level` config key.** Rejected: it would move the decision out of
  the write and back onto one threshold over a single axis, which is the
  conflation this decision removes.

## Consequences

- The desktop stops carrying the operator's own key answers. The notification
  count drops to the facts the plane produced while the operator was away,
  which is the case ADR 0080 was written for.

- A refusal keeps the `Warning:` word on the line. The operator pressed a key
  and nothing ran, and the word is the honest marker for that.

- Every write site takes a decision, and the implementation's record lists the
  site, its severity, and its Fault answer. The groups above are the checklist
  that pass reads from.

- The current-behavior pages that say a standing warning "sends a desktop
  notification" stay true for the Faults they name, and a refusal is no longer
  one of the facts that sends.

- The Fault is not marked in the Message history. The chip carries the level,
  and whether the fact also left the terminal is a fact about the channel.
