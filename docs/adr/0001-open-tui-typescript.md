# ADR 0001: Build the control plane on OpenTUI and TypeScript

Status: accepted. Date: 2026-08-30.

## Context

The control plane is a terminal application.
It needs to render a ticket list and a ticket detail pane, track keyboard
focus, and grow into agent handoff without a rewrite.
The factory's agents and tooling are TypeScript: the tickets, the state
machine, and the future handoff code all live in the same language.

## Decision

We build the control plane on OpenTUI through its first-party React
binding, in plain TypeScript on the node runtime, with no build step.

The alternatives were:

- ratatui (Rust): the most battle-tested TUI framework, but it puts the
  control plane in a second language.
  Every feature becomes a bridge across the FFI instead of a function call
  into shared TypeScript domain code.
- Bubble Tea (Go): the same language-seam problem, with a weaker story for
  sharing types with the agent tooling.
- Ink (React for the terminal, JavaScript): the same React model, but the
  project is dormant relative to OpenTUI's activity, and it lacks the
  production proof the factory needs.

OpenTUI is active, is production-proven by OpenCode, and ships a first-party
React binding from the same team and the same release.
The framework risk and the binding risk are one risk.
Plain TypeScript runs directly on node v26 or newer, so the dev loop is
`node src/factory.ts` with nothing to compile.
A bundler arrives only when a distributable binary is needed.

## Consequences

- The control plane shares types and modules with the factory's agent
  tooling from day one.
- Keyboard input, layout, and rendering are solved by the framework; the
  codebase owns only the domain, the data, and the panes.
- The test seam is the rendered terminal frame, through the first-party
  OpenTUI test renderer, so tests assert what an operator sees.
- The stack is typed end to end, which keeps the scaffold boring: Biome
  for lint and format, vitest for tests, and one npm script for each.
