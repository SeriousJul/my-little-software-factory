# ADR 0011: The observation reclaims an agent that outlives its work cycle

Status: accepted
Date: 2026-09-02

## Context

ADR 0005 ends a work cycle at close: the ticket returns to `open` at once with
an incremented cycle number. ADR 0006 keys every later read on the pane id the
handoff recorded, and the loop only looks at panes of tickets in `handed-off`,
`running`, or `awaiting`. Together these two rules assume that a closed cycle
leaves no live agent behind.

It does not always. The Close cleanup of a worktree handoff removes the herdr
workspace with its checkout, and herdr refuses to remove a dirty checkout
without `--force`. The control plane keeps the state transition and warns on
the message line (the rule from the auto-handoff spec, issue #7), so the cycle
closes and the agent's pane stays open. The operator can also re-prompt a
settled agent in herdr after the close, which the control plane cannot see: it
never re-prompts an agent it handed off.

Observed on a live ticket: the agent settled a cut-short turn, auto-handoff
closed the cycle in the same poll, the cleanup failed on the dirty checkout,
and the operator typed `continue the work of previous agent` into the herdr
pane. herdr reported that agent `working` for the next three hours. The
control plane showed the ticket as `open`, did not count its agent against the
parallel limit, and a fresh handoff of the same ticket failed with herdr's
`agent_name_taken`: the live agent still held the name derived from the
ticket's branch, and no later handoff of that ticket could ever start.

The considered alternatives:

- Do not end the cycle when the Close cleanup fails: keep the ticket
  `awaiting` with a pending trace, so the existing reopen path (issue #7)
  catches the re-prompted agent. Rejected: a cleanup that never succeeds
  (always a dirty checkout) strands the ticket in `awaiting` with no exit, and
  the automatic rule retries the same failing cleanup every poll.
- Refuse the close until the operator cleans up the checkout. Rejected: it
  makes close conditional on an external tool's opinion about the working
  tree, and it blocks the operator from ever closing a cycle.
- Give each handoff a unique herdr agent name, so a leftover agent cannot
  block the next handoff. Rejected as the fix: it hides the collision instead
  of seeing the agent, and the live agent stays invisible to the operator.
- Track the agent by its name or its checkout path instead of its pane id.
  Rejected: ADR 0006 already settled the pane id as the only reliable handle.

## Decision

The observation loop reclaims a live agent whose work cycle has closed.

Each poll, after a successful `herdr agent list` and before it counts agents
against the parallel limit, the loop takes every ticket that rests in `open`
and whose latest handoff recorded a pane. When herdr reports an agent `working`
or `blocked` in a pane no in-flight or awaiting ticket holds, the loop records
a Reclaim: a handoff attempt and a handoff row in the ticket's current work
cycle, with the previous handoff's choices and the same herdr handles, and the
ticket in `running`. It runs no external command, and it rewrites nothing: the
closed cycle keeps its handoff row and its decided completion trace.

The reclaim counts as a handoff, so the per-ticket handoff limit bounds a
close-and-reclaim loop. An idle, done, or unknown report reclaims nothing: only
herdr's evidence of live work opens a handoff. The warning names the ticket on
the message line, so the operator sees why a closed ticket is running again.

## Consequences

- The ticket list shows reality for an agent the control plane started, with
  no new state and no new polling command. When the reclaimed agent settles,
  its turn follows the normal path: `awaiting`, a completion trace, and the
  operator's or the automatic rule's decision.
- A closed ticket can become `running` without a handoff the operator asked
  for. The durable record says so: its attempt carries the `reclaimed` stage,
  and its `started_at` is the poll that saw the agent, not the moment the agent
  started.
- A reclaimed agent holds a parallel slot, so auto-handoff starts one fewer
  agent while it works.
- The `agent_name_taken` dead end goes away for the common case: the reclaimed
  ticket is no longer `open`, so nothing re-hands it off. A leftover agent that
  only reports idle still holds its name; a failed cleanup stays visible on the
  message line, and the operator clears it in herdr.
- The control plane trusts the pane id, so it treats any live agent in a pane
  it opened as that ticket's work. That is the intended reading: the pane sits
  in the workspace herdr made for the ticket's branch.
