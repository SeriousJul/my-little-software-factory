# ADR 0008: The turn log comes from the agent's session record, not the terminal

Status: accepted
Date: 2026-09-02

## Context

When a turn settles, the decision modal shows the agent's work as a Turn log.
Today the control plane captures that work as the agent pane's last 200
terminal rows (`herdr agent read`). Terminal rows are rendered UI: for pi and
codex they mix the agent's text with tool call lines, tool output, spinner
rows, and prompt echo. The operator asked for the agent's messages without
that garbage.

The same observation poll that reports agent state (`herdr agent list`) also
reports each agent's native session record when the matching herdr integration
is installed: for pi a JSONL session file, for codex and claude a session
reference of the same shape. The session record stores every event of the
turn in order: the agent's text (raw markdown), tool calls, tool results, and
thinking blocks. It is a versioned file format the runtime writes, not a
screen scrape.

## Decision

The Turn log is built from the agent's session record.

At settle time the control plane takes the session path from the poll's
`agent list` result, hands it to a per-agent-type reader (the pi reader first,
codex and claude when needed), and stores the resulting entries in the
Completion trace. The trace's last message becomes the agent's final text, so
the restart prompt and the detail pane read the same clean message.

A terminal capture remains as the fallback: when herdr reports no session,
when the record is missing or unreadable, or when the agent type has no
reader, the turn's log degrades to the capture, switched to herdr's
`recent-unwrapped` source.

The considered alternatives:

- Heuristic filtering of the terminal text. Rejected: it keeps the control
  plane runtime-free, but every runtime that changes its screen layout can
  break the filter, and a rendered screen cannot say where one message ends
  and the next begins.
- A new herdr command that returns a clean message. Rejected for now: it
  would keep the control plane thin, but it waits on a herdr release and
  pushes the same runtime knowledge into herdr. The session record is
  already reported by herdr today, so the control plane can take it without a
  new dependency.

## Consequences

- The control plane now parses runtime file formats. The parsers are keyed
  by the agent type's kind and live behind one seam, so a runtime that
  changes its format breaks one reader, not the observation loop, and degrades
  to the terminal capture instead of failing the turn.
- The Completion trace grows a turn log column. Old traces carry no log, so
  the reader derives a plain-text log from their last message.
- The restart prompt and the detail pane read the clean final text instead of
  raw terminal rows.
- An agent type without a reader still works, on the fallback.
