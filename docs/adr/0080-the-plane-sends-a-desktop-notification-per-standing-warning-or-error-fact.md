# ADR 0080: The plane sends a desktop notification per standing warning or error fact

Status: accepted
Date: 2026-10-01

## Context

The Message line is a temporary surface: one row, cut at the terminal edge,
replaced by the next fact. A warning or an error written on it is exactly
the fact the operator must act on - a failed handoff, a blocked merge, a
missing Agent, a held turn - and it is visible only while the operator
watches the terminal.

In Auto-handoff mode the factory runs without the operator at the
terminal. The facts land on the line while the operator is away: the
truncation hides the reason, and the next fact takes the row. The terminal
bell (ADR 0016, the `attention-bell` config) says that something
happened, not what happened, and it reaches only a machine that plays a
bell at all.

The operator needs the full fact, at a distance, at the moment it stands.

## Decision

When the control plane writes a warning or an error to the Message line,
it sends a desktop notification to the operating system's notification
system, carrying the severity and the full, untruncated text of the fact.

The plane sends one notification per standing fact. While the same fact -
the same severity and the same text - stands, it sends none. A different
fact takes the line and resets the rule, so the fact notifies again when
it stands again after a different one. The rule mirrors the Message
line's own standing-fact semantics and stands as the second guard against
a fact that repeats every observation cycle, the first guard being the
state-change gates most warnings already carry at their source.

A new `desktop-notification` config key gates the send, a boolean defaulting
on, beside `attention-bell`. The bell and the notification cover different
events - attention states and warning or error facts - so the operator
switches each on its own.

Every send runs through the Command runner, the plane's single exit, as one
fire-and-forget command on the platform's own notification path:
`notify-send` on Linux with the app name and a critical urgency for errors,
the built-in `osascript` notification on macOS, and the static PowerShell
balloon tip on Windows with a sticky timeout for the error and a short
self-clearing timeout for the warning, so a warning announces itself
without holding the desktop the way an error does. The platform choice is
injectable, so the suite exercises every sender branch on any machine, and
the runner seam lets a test assert the exact command without touching a real
notification stack.

A send that fails - no notification tool, a nonzero exit - changes nothing
the operator sees on the plane: the Message line stands as written, the
operation settles, and the failure leaves a developer log line.

The two duplicated terminal bell writes in the app move into the same
shared service as the notification send, so the plane holds one place that
owns its out-of-band attention. The header flash state stays in the app;
only the bell write and its `attention-bell` gate move.

## Considered options

- **Speak the notification daemon's protocol directly** (the D-Bus
  interface on Linux, a native API elsewhere). Rejected: the per-platform
  OS commands are stable, install nothing, and travel through the runner
  seam every other external call already uses. A direct protocol client
  would add a dependency or a private client per platform and a second
  egress the tests cannot fake through the one seam.

- **A dedicated egress beside the Command runner.** Rejected: the runner
  is the plane's only exit and its only injected test seam. A second exit
  for one fire-and-forget command buys nothing and splits the test story
  in two.

- **Gate the notification on `attention-bell`.** Rejected: one switch over
  two different events forces the operator to trade a silent bell against
  no notifications. The two keys stay separate.

- **Notify every write.** Rejected: a fact that repeats per cycle would
  flood the desktop while the Message line shows it once. The standing-fact
  rule matches the line the operator already reads.

## Consequences

- The operator acts on a failure from the desktop while away from the
  terminal, the Auto-handoff case first, and reads the full reason the
  line truncates.

- Every warning or error now spawns one command. The send is
  fire-and-forget inside the runner's budget, and a dead notification
  stack degrades to a log line.

- An existing Config file that omits the new key reads the default on; a
  round-trip writes the key, and the configuration guide's reference table
  and complete example gain the row the tested contract demands.

- The terminal bell keeps its behavior - the held-count bell and the
  Consultation attention bell, each gated by `attention-bell` - with its
  two snippets gathered in the one shared service beside the notification.

- The built-in macOS sender cannot mark an error urgent or sticky:
  `display notification` carries no urgency, and the notification clears on
  its own. The error-stands-until-seen story holds on Linux (the critical
  urgency) and Windows (the sticky Popup), and does not hold on the
  built-in macOS path. A richer macOS sender is out of scope, so the trade
  stands: the macOS operator reads the full fact while the notification is
  up, but not a fact that waits for the operator.
