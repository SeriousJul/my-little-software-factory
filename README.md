# my-little-software-factory

The control plane of my little software factory. It is a terminal app that
observes the factory and issues work. It watches tickets and hands them off
to agents.

Today it renders built-in sample tickets, so the control plane already shows
its future shape while it watches the real factory in the future.

See `CONTEXT.md` for the domain language and `docs/adr/` for the framework
decision (ADR 0001: OpenTUI and TypeScript).

## Requirements

- node v22 or newer (developed on v26)
- npm

## Commands

| Command         | What it does                              |
| --------------- | ----------------------------------------- |
| `npm run dev`   | Start the control plane in watch mode     |
| `npm test`      | Run the full test suite                   |
| `npm run lint`  | Lint and check formatting with Biome      |
| `npm run fmt`   | Lint, format, and fix with Biome          |
| `npm run typecheck` | Typecheck with TypeScript             |

## Keys

| Key            | What it does                              |
| -------------- | ----------------------------------------- |
| `j` / `k`      | Move the selection down and up            |
| `Up` / `Down`  | Move the selection down and up            |
| `h` / `l`      | Switch focus between the list and detail  |
| `Left` / `Right` | Switch focus between the list and detail |
| `q`            | Quit                                      |

## Layout

Two panes side by side, flex-sized to the terminal. The list pane on the
left shows every ticket with its state badge, title, and repository. The
detail pane on the right shows the full detail of the selected ticket:
repository, ticket state, assigned agent, and the GitHub status as a
separate source fact. The panes share one focus. Switching focus never moves
the selection.

## Shape

- `src/factory.ts`: the entry module. Boots the renderer and mounts the app.
- `src/domain/`: the Ticket type and the ticket state machine.
- `src/data/`: the built-in sample tickets.
- `src/components/`: the app shell, the ticket list pane, the ticket detail
  pane.
- `test/`: the test suite. The seam is the rendered terminal frame.
