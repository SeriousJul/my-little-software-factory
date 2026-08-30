# ADR 0002: Handoffs run through herdr

Status: accepted
Date: 2026-08-30

## Context

A handoff must start an interactive agent (pi, codex, claude code, or others).
Agents are terminal UIs and need their own terminal, but the control plane is
itself a terminal UI. The control plane will also need agent state later for
the `running` and `done` ticket states.

## Decision

herdr is the only host for agent processes.
The control plane never starts an agent process itself.
It drives herdr through its CLI (child process, JSON output) for every
environment kind: a live worktree is a herdr workspace at the existing
checkout with a fresh tab, a worktree is a herdr-created git worktree, and a
container is a reserved future kind.

## Considered Options

- Start processes directly for the live worktree kind, and use herdr only for
  worktrees. Rejected: two execution paths, two sets of
  spawn/readiness/prompt/observe code, and no terminal for an interactive
  agent in the control plane's own screen.

## Consequences

- herdr is a hard runtime dependency of the control plane.
- The agent-agnostic seam stays in the control plane: agent types are config
  entries, and herdr's agent kind is one field among them.
