# ADR 0004: SQLite owns factory state

SQLite stores stable ticket identities, source memberships and health, work cycles, handoffs, and factory ticket state. Source refreshes replace external facts transactionally but cannot reset factory state. We use Node's built-in `node:sqlite` instead of a JSON or TOML state file because refresh reconciliation, crash-safe handoff attempts, schema migration, and durable history require transactions and indexed relationships.
