# ADR 0025: The Consultation detail presents the Agent's session record

Status: accepted
Date: 2026-09-15

## Context

The Consultation detail's body is the Agent view: the capped plain-text read
of the agent pane (`herdr agent read`, the `recent-unwrapped` source),
refreshed every second while the Consultation is selected. It is a screen
scrape. It is capped, it strips the terminal's styling, and it mixes the
runtime's own screen (spinner rows, tool output, prompt echo) into the
exchange. The operator asked for the exchange itself in the detail: the
operator's inputs and the agent's messages, in order.

The agent's real pane cannot be shown inside the detail. The control plane
owns the whole terminal it runs in, and the agent pane is a separate herdr
pane. herdr offers snapshots of that pane, a focus of it, and a full-screen
attach that takes over the running terminal. None of these renders inside
the control plane's own surface. The operator's path to the real pane is a
focus, the same one the Ticket Live view's Goto row already runs.

The session record is already the control plane's source of truth for the
turn: the Turn log (ADR 0008) and the turn end cause (ADR 0015) both come
from it, and the observation reads it while the work is still live. The
record file grows while the agent works, so a live read returns the whole
exchange so far: every operator input and every agent message, with the tool
calls between them.

## Decision

**The Consultation detail body is the Session view.** It presents the
agent's session record: the operator's inputs and the agent's messages in
order, with one short note per tool call. It is the default body for open
and closed Consultations alike, and the detail's border title states which
body shows: "Session view" when the record renders, "Agent view" when the
fallback does.

**The read goes through the per-agent-kind session reader.** The module that
already builds the Turn log (ADR 0008) gains a full-session read, the `pi`
kind first. The control plane adds no runtime package: an Agent type's kind
selects the reader, and a kind without one simply has no Session view.

**The terminal stays the fallback.** When the kind has no reader, herdr
reports no session path, or the record is unreadable, the body degrades to
what the detail shows today: the plain-text pane read for an open
Consultation, the Captured history for a closed one. The pane read keeps
running either way: it feeds the Stale Agent output fact and the fallback
body, so a failing terminal is still reported while the Session view is
fresh.

**A Goto control reaches the real pane.** Key `g` in both Consultation base
modes, available while the selected Consultation's pane is alive in the last
poll. It runs `herdr agent focus` and changes no Consultation state: it is
navigation, not a decision. A note confirms it on the Message line.

**Nothing else moves.** The Agent interaction mode keeps the visible ANSI
screen, its fast refresh, and its key forwarding. The Ticket side keeps its
Live view stream and the Turn log in the Decision modal.

## Considered alternatives

**Embed the agent's real pane in the detail.** Rejected: not buildable. The
control plane renders the whole terminal it runs in, and herdr offers no way
to render another pane inside a third program's surface. The focus is the
real pane.

**Make the visible ANSI re-render the primary body.** The mechanism exists -
the interaction mode uses it - but it is still a screen scrape: the visible
screen is a cap, and the runtime's UI mixes into the exchange. The session
record is complete and structured. The ANSI screen stays where the operator
types: the interaction mode.

**Depend on the runtime's own package to read the record.** Rejected: it
couples every Agent type to one runtime and breaks the agent-agnostic rule
for a capability the per-kind reader already provides. A format change breaks
one reader and degrades to the fallback, as ADR 0008 already bounds.

## Consequences

- The per-kind reader grows from a settle-time read to a live read on the
  detail's refresh tick. A runtime that changes its record format now also
  affects the live body, but the failure is a fallback to the terminal body,
  never a dead detail.
- The Consultation detail shows the exchange, not the screen: tool calls
  read as one note each, and an operator input appears where the agent's
  answer to it appears.
- An Agent type without a session reader is unchanged in everything the
  operator sees: its detail keeps the terminal body, the Goto, and the
  interaction mode.
- The Stale Agent output fact keeps its meaning: the pane read still runs, so
  a terminal that fails is reported even while the Session view is fresh.
