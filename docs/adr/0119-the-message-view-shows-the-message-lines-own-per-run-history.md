# ADR 0119: The Message view shows the Message line's own per-run history

Status: accepted
Date: 2026-10-06

## Context

The Message line shows one fact, and the `m` control showed only that fact,
and only when the terminal had cut it short (issue #331). An operator who
looked away for one refresh has no way back to a fact that passed.

The plane already keeps one durable record: the file log, one level-tagged line
per event, rotated by size and gated by the `[logging]` level. It is not the
same record. It holds the developer's lines, not the facts the Message line
showed, and no Message-line write goes into it. Its vocabulary is
`debug`, `info`, `warn`, `error`, and the Message line's is `working`, `info`,
`warning`, `error`. A config with no `[logging]` table keeps no file at all.

## Decision

The Message facts module keeps the Message line's own history: a per-run,
in-memory record of the facts it was asked to state, bounded at 500 entries
with the oldest dropped.

It records the four kinds that stand: an operation's outcome, a control's news,
a notice, and source health. It records no `Working` progress line, because
progress is transient by design, it would flood the record, and the outcome
that ends it already states the result. A write that repeats the previous
entry's severity and text is not recorded again. Each entry carries the local
time of the write, not the moment the row showed it, because the record follows
the order the plane stated its facts and not one row's paint order.

The Message view shows the whole history: oldest first, newest at the bottom,
open pinned to the newest and live while it is open, so a fact that lands while
the operator reads appends and the view holds their position once they scroll
up. It takes the near-fullscreen frame the Decision modal uses, and its body is
the shared Body pane, titled `Messages`, scrolled by the shared body scroll.
The Key guide keeps its own 100 by 24 caps.

One row is the date and time, a fixed-width level chip (`INFO`, `WARN`,
`ERROR`), and the full text, with a wrapped fact's continuation lines indented
to the text column. The chip paints the role the Message line already uses for
that severity, the time paints the dim role, and the no-color presentation
paints no color and loses nothing, because the word is written.

`m` opens whenever the history holds an entry, with the reason "no message has
been recorded yet" when it holds none. The truncation fact stops gating the
control, and the Standing facts the whole plane owns carry the history fact in
its place.

The Message line itself does not change, and the file log does not mirror the
history: the log keeps its own writers and its own level filter, and the
history stays the operator's record of what the Message line showed.

## Considered options

- **Show the tail of the file log.** Rejected: the two records hold different
  facts, the log's level filter and its absence by config decide what the
  operator can read, and one view over both would need a mapping between two
  level vocabularies for one screen.

- **Keep the history in the state file, so it survives a restart.** Rejected:
  it is session view state, like the Starting window and the notification's
  standing-fact memory, not a machine fact the machine reads back. A table, a
  migration, and its own rotation for a record whose durable form already
  exists as the log.

- **Newest first at the top.** Rejected: the row format imitates a log, and a
  log reads top-down. The "open pinned to the newest" rule is the one the
  Decision modal already uses for a body that grows.

- **Keep the utility overlay's 100 by 24 caps and raise them.** Rejected: a
  fixed cap is a second size rule, and the near-fullscreen frame the chrome
  already owns gives the history every row the terminal offers.

## Consequences

- A restart empties the history. The operator who needs the run's record reads
  the log file, and the two records answer different questions on purpose.

- The view's empty state is unreachable: the control is unavailable while the
  history holds nothing, and the buffer only grows within a run.

- The `message-view` mode states the body-pane facts, so the Action bar's
  scroll hint and range text follow the shared rule (ADR 0039), and the body
  scroll control gains the mode instead of the view growing its own scroll.

- The Message line's truncation stops being a gate, so the Standing facts entry
  in the glossary names the history fact instead.
