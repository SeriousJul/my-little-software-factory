# ADR 0003: Fetch tickets through source adapters

Ticket sources satisfy one internal `TicketSource` interface and return normalized external facts as complete snapshots. GitHub issues and GitHub pull requests are separate built-in adapters that share an internal GitHub client, while filters and authentication stay source-specific. This keeps factory state and task selection outside source implementations, supports external issue systems without pretending their query languages are portable, and defers runtime-loaded packages until a real external plugin requires that complexity.
