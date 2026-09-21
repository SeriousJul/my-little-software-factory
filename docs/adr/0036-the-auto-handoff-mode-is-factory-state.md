# ADR 0036: The Auto-handoff mode is factory state, not a config setting

Status: accepted
Date: 2026-09-19

## Context

The Auto-handoff mode answered two different questions with one stored
value. The config file carried the startup default, and the `a` key in the
Ticket section toggled a session-only copy of it: a restart, or a dev
reload, dropped the mode back to the default. The operator's last choice of
how the factory ran was not a fact the plane could rely on, and the plane
had no durable answer to "how did the factory last run".

The mode describes how the factory runs, and the factory's running facts
live in the factory state (the state file). The decision was where the mode
belongs, and how an existing config file that still carries the setting is
treated.

## Decision

**The mode is factory state on the state file.** A fresh state file starts
with the mode off. The `a` key in the Ticket section writes the new value
to the state file at once; the in-session flip stands either way, and a
write failure reports on the Message line. The plane reads the mode from
the state file on startup, so a restart and a dev reload find the mode
where the operator left it. The mode is per state file: two state files
keep separate modes, and two configs that share one state file share the
mode.

**The setting is removed from the config, not demoted to a default.** The
key leaves the config schema, and a config file that still carries the line
fails startup with the existing unknown-top-level-key error, which names
the key. The operator removes the line by hand; an operator who ran auto on
confirms the mode once with the `a` key after the upgrade.

## Considered options

- **The config keeps the default, and the toggle writes the config back.**
  The plane rewrites the operator's file on every toggle, keeping the mode
  visible in a file the operator can read and edit, at the cost of the plane
  owning a file the operator owns, of full rewrites that lose comments, and
  of a startup precedence between two writers.
- **A separate file for the mode.** A second operator file to seed, read,
  and validate for one value.
- **A self-healing migration: seed the state from the legacy line and
  remove the line from the file at startup.** It preserves a configured
  value invisibly, adds a surgical edit to the operator's file on the
  startup path, and gives the plane a second write to that file. The hard
  break instead makes the operator re-confirm a safety-relevant switch
  once, with a readable error that names the key.
- **A permanent legacy alias: the key stays accepted and seeds the state
  once.** A dead key the strict validator must special-case forever, and a
  value that silently stops working after the first seed. The
  `ticket-sources` alias stayed because the setting stayed functional; a
  removed setting has no functional alias.

## Consequences

- The mode is controlled only from the TUI: there is no config knob and no
  CLI flag.
- The config file stays fully operator-owned; the Repository mapping
  section remains the one section the control plane writes back.
- The state schema gains the mode in a new version.
- The session facts that are not factory state (section collapse,
  selection, the history filter, the launcher draft) stay session-only.
