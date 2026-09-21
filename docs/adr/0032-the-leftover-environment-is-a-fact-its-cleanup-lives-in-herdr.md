# ADR 0032: The leftover environment is a fact; its cleanup lives in herdr

Status: accepted (supersedes the action of ADR 0012 in part)
Date: 2026-09-18

## Context

ADR 0012 made a ticket's leftover environment a durable, visible fact with
one action: key `w` retried the Close cleanup of every leftover of the
ticket, and herdr's `--force` was a row of the same panel the operator
chose. The action is the rarest operation of the plane: a leftover stands
only when herdr refused a removal, most often a dirty checkout, and it is
visible in the row and in the detail for as long as it stands.

The operator asked for `w` to be Close in both sections (ADR 0031), and said
the leftover clear is not needed. The close paths already own the cleanup
machinery: every close runs the Close cleanup, records the leftover it
cannot remove, and names the dirty-checkout outcome in its own dialog. A
leftover that stands after a close is exactly the state that close's dialog
already warned about.

## Decision

**The control plane offers no leftover clear.** The control, its panel, and
the dispatch method go away. The leftover stays a durable, visible fact: the
row marker, the detail block with its reason, and a line that points the
operator to herdr, the way the Consultation detail already does for its
remaining resources. The `w` key is free, and Close takes it (ADR 0031).

Everything else of ADR 0012 stands. The fact is recorded on the same paths,
the seat still serializes environment changes behind handoffs, the reach
still bounds what a successful cleanup clears, and a handoff still starts
beside its ticket's leftover under the cycle name instead of failing on the
held agent name.

The considered alternatives:

- Keep the clear on another key. Rejected: the operator does not want the
  operation, and every key the Ticket section keeps beyond the Consultation
  widens the gap this alignment closes.
- Make the clear a row of the Ticket detail pane. Rejected: a detail row for
  a rare cleanup mixes an action into a facts surface, and the row would
  show only while a leftover stands, so it teaches nothing in the common
  case.
- Retry the failed close cleanup on its own. Rejected: ADR 0012's force rule
  stands - a forced removal is never the side effect of an unrelated action -
  and the clean retry was never automatic either.

## Consequences

- A leftover that stands is cleared in herdr. The detail block says so, and
  the operator knows where the workspace, tab, and pane still live: the
  block already names them with the handles herdr gave.
- A close whose cleanup fails leaves a leftover that only herdr clears. The
  close's dialog names the dirty-checkout outcome before the operator
  confirms, so the outcome is not a surprise.
- The close cleanup machinery - the seat, the reach, the recording - is
  untouched and keeps serving every close path, automatic and manual.
- The agent-name behavior of ADR 0012 stands: a handoff beside its ticket's
  leftover starts under the cycle name, and the leftover's agent holding
  the stable name is the case the fact makes visible, not the case the clear
  used to fix.
