# ADR 0122: The Delete key is the plane's one destructive key

Status: accepted
Date: 2026-10-07

Amends ADR 0031's key decision: the work-cycle close no longer takes `w`.
Supersedes three consequences of ADR 0114: the Ticket close no longer keeps
`w`, the Consultation record removal no longer keeps `d`, and a `queued`
Consultation no longer closes at the key. ADR 0037's and ADR 0038's
confirmation decisions hold for every state that still closes.

## Context

The keys arrived one act at a time. ADR 0031 put the Ticket work-cycle close on
`w`. ADR 0037 moved the Consultation close to the same key, and ADR 0114 moved
it again, to the Delete key, so that taking a Consultation out of the Work queue
was one gesture in the two sections that list the same row. ADR 0114 stated the
edge of that unification in writing: the Ticket close "keeps `w`", and the
Consultation section's `d`, which removes a finished record and its history,
"keeps its key".

The operator reads the key for a different job. The three base sections all list
items, and the destructive gesture on the item under the cursor reached for
three keys: `w` on a Ticket, the Delete key on a Consultation and on a Work
queue row, and `d` on a Consultation record the factory finished with. The
catalogue already resolves one key to different controls by state: Enter means
Hand off, Decide, Live view, or Queue item, and the state under the cursor picks
which. The operator asked for the destructive key to work the same way, on every
item, and for `w` and `d` to leave.

The cost is real and it is the reason for this record. Delete is the key a
terminal already reads as destruction, it is not present on every layout
without a modifier, and it now carries three different acts. The counterweight
is that every act which can end live work or destroy a record stands behind a
confirmation of its own.

## Decision

**The Delete key is the plane's one destructive key.** It answers in all six
base modes: the Ticket list and detail, the Consultation list and detail, and
the Work queue list and detail. `w` and `d` leave the catalogue: they resolve to
no control anywhere, and the plane states nothing when either is pressed, the
way it answers any unclaimed key. There is no alias and no second binding.

**The act follows the item the cursor stands on.** Each act keeps its own
availability, its own refusal sentence, and its own confirmation shape. The
state rules are disjoint, so no state has two acts under the key and the
catalogue never breaks a tie between them.

| The cursor stands on | Delete runs | Confirmation |
| --- | --- | --- |
| a Ticket whose cycle is in flight or settled: `handed-off`, `running`, `awaiting` | Close, the work cycle | the Close dialog, always |
| an `open` Ticket that waits with a Work queue row | Remove, that row; the Ticket stays `open`, and a removed route leaves its mark (ADR 0069, ADR 0072) | none |
| any other `open` Ticket | nothing; the refusal names that no work is in flight | - |
| a Work queue item, in either queue pane | Remove, the item (ADR 0049) | none |
| a Consultation that is `opening`, `working`, `awaiting-response`, `missing`, `failed`, or `closing` | Close, the Consultation | the panel when a live Agent stops, direct on `missing` and `failed`, the Retry and Force-close panel on `closing` (ADR 0037, ADR 0038) |
| a `queued` Consultation | Remove, its Work queue row; the record stays `unscheduled` | none |
| an `unscheduled` or `closed` Consultation | Remove, the record and its history | the removal panel, always |

**The state split comes before the row.** A Ticket that holds live or settled
work always closes, even when the Top-up also stands a Restart row for it in the
queue (ADR 0108). The queue removal answers only an `open` Ticket, the case
where the waiting row is the only thing the Ticket holds.

**The queue removal is one control, not one control per section.** The
catalogue's `queue-remove` claims the Delete key in all six base modes and reads
"the row under the cursor waits with a Work queue item". It leaves its
`work-queue-list` scope and its single-mode binding, the way `queue-jump`
already did for Enter, and it takes no section marker, because the key is
genuinely dispatched in every base section. The queue's `queue-promote` and
`queue-demote` keep their `queueSectionOnly` marker: those keys stay inside the
queue. `ticket-close` takes the `ticketSectionOnly` marker, so each section's
Action bar and Key guide name only the act that mode runs.

**Two act words carry the key: Close and Remove.** The bar and the guide print
`Delete Close` or `Delete Remove`, and the guide's note states what each Remove
takes out. The Key guide stays section-scoped, so a section never names another
section's meaning of the key.

## Consequences

- One key, one gesture, everywhere the operator can stand on an item. The Work
  queue's removal now answers in its own detail pane too, where it answered
  nothing before.
- A Consultation leaves in two steps: the row first, then the record. A Delete
  on a `queued` record no longer retires it, so the record stays `unscheduled`
  and the operator can put it back into the queue with `s`. A `queued` record
  can no longer become `closed` at the key.
- The removal of a record always confirms, so an `unscheduled` record now meets
  the panel that names what it destroys, where it met no panel before.
- The Work queue's removal never confirms, including from a Ticket row. It ends
  a waiting start, and the operator can ask for that start again.
- The destructive key is not configurable, and the Agent terminal forwards it to
  the Agent, as it forwards every key.
- The catalogue guard that stops the bar hinting a key its guide does not name
  still holds, because the control that owns the key is genuinely in the mode.
- Frame snapshots and keyboard tests still say nothing about screen-reader
  support, and the terminal walks have not been re-run on the theme-inherited
  paint. The verification record keeps both as open items.
