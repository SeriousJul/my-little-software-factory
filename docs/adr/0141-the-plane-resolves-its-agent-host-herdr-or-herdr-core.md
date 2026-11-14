# ADR 0141: The plane resolves its Agent host: herdr, or herdr-core

Status: accepted
Date: 2026-11-12

Records that the plane drives two **Agent hosts** and names them `herdr` and
`herdr-core`, that one start resolves its host from the operator's config, then
the environment mark, then the default, that the run states the host it resolved
beside the fact that resolved it, that both command dialects and the host's
state words live in one module the surfaces may not bypass, and that
[ADR 0002](./0002-handoffs-run-through-herdr.md)'s "herdr is the only host for
agent processes" narrows to "herdr is one of the two hosts". It moves no control,
decides no gate, and lands no code: this record and its three siblings
([ADR 0142](./0142-one-run-holds-agents-on-both-hosts-and-the-host-stands-on-the-handoff.md),
[ADR 0143](./0143-on-the-herdr-core-host-the-plane-owns-the-worktree-lifecycle.md),
[ADR 0144](./0144-on-the-herdr-core-host-the-plane-derives-the-agent-session-record-path.md))
land before the change they govern, the way ADR 0122, ADR 0128, ADR 0129,
ADR 0130, ADR 0131, and ADR 0132 did.

## Context

ADR 0002 fixed herdr as the only host for Agent processes, and the plane has
held to it: at head `2d5c3345` the sources spell `"herdr"` in **29 call sites**
and build **16 command shapes** over it - `agent list`, `agent start`,
`agent prompt`, `agent wait`, `agent read`, `agent focus`, `workspace list`,
`workspace get`, `workspace create`, `workspace close`, `tab create`, `tab list`,
`tab close`, `pane list`, `pane close`, `pane report-agent`,
`pane release-agent`, and the three `worktree` shapes - and read herdr's refusal
codes (`agent_name_taken`, `agent_pane_busy`, `workspace_not_found`,
`tab_not_found`, `worktree_not_found`) out of those answers.

herdr-core (`hc`) is a different program, and it is already on the operator's
machine beside herdr: `herdr` 0.9.5 with its own server and socket, and
`herdr-core` 0.1.20 running as `herdr-core serve`. The Herdr desktop app is one
of herdr-core's clients: its own generated instructions state that every
terminal and Agent in the desktop window is a herdr-core terminal, and that a
terminal carrying the labels `herdr.space=<id>` and `herdr.tab=<id>` shows up in
a space even when the plane or the operator started it
(`hc run --keep --label herdr.space=<id> --label herdr.tab=<id> -- claude`).

Measured by hand on 2026-11-12 against `hc` 0.1.20, in a scratch `HC_SESSION`
with `HC_SOCKET` and `XDG_RUNTIME_DIR` under `/tmp` (the method and every
command stand in
[the verification record](../verification/agent-host-herdr-core.md); every probe
terminal and the probe core were removed afterwards, and the operator's own core
was never touched):

- herdr-core answers the plane's whole loop: `run` with a name, a cwd, and
  labels; `send` for a prompt; `ls` and `get` for the roster and one record;
  `wait` for a turn; `read` for the screen; `kill` and `rm` for cleanup. A
  record carries `name`, `labels`, `state: live|finished`, `turn`,
  `exit_code`, `reason`, `parent`, and `argv`, and a taken name is refused
  with the code `name_taken`. A record's `status` is the reporting program's
  word beside its name: a live terminal whose program reports one carries
  `{"app": <program>, "state": <word>}`, and a terminal whose program reports
  no status, beside a finished one, carries no status. Corrected 2026-11-14
  on the operator's core: the 2026-11-12 probe's terminals reported no
  status, so the probe left the record's status shape unmeasured.
- herdr-core's name rule is `[a-z][a-z0-9_-]{0,31}`. The plane's own rule in
  `src/naming.ts` (`HERDR_NAME_MAX_LENGTH = 32`, the slug and identity tag)
  already builds that shape, so the naming module does not move.
- herdr-core knows no workspace, no tab, no pane, and no worktree. Its unit is
  one terminal, addressed by `t<n>` or by name, carrying labels.
- The plane reads the status from `hc get <terminal> --json`, never from the
  roster, and the roster alone cannot run the observation cycle. The roster's
  live rows can carry a `status` field beside the reported word (measured
  2026-11-14 on the operator's core; the 2026-11-12 probe's rows showed
  none), but the record's status is the read the cycle takes.
- On Unix every herdr-core command starts its session's core when none runs:
  `hc server status` on a fresh session answered with a core whose
  `uptime_ms` was `8`. There is no read that answers without starting one.
- A start from a non-terminal gets a `200x120` screen, and the child program
  receives `HC_TERMINAL_ID`.
- A finished terminal keeps its address, its `reason: "exited"`, and its
  `exit_code` until `hc rm` removes it, so a started-then-dead Agent stays a
  readable fact.
- The status words are the same five herdr reports, because both read the
  program's OSC 7501 reports, and herdr-core's own manual says the rule the
  plane already follows: "Do not guess status from screen text." Measured
  2026-11-14 on the operator's core beside live pi terminals, the words stand
  in the record's `state` beside the program's name, and the records that
  stood there carried `working`, `done`, and no status: the words
  `idle`, `blocked`, and `error` have not stood on that host.

Two of the plane's facts have no herdr-core answer at all: the Goto's view
focus, and the agent session-record path the Turn log reads (ADR 0008). Those
are the reason this decision names its limits instead of claiming parity.

## Decision

**The concept is the Agent host, and there are two of them.** The Agent host is
the program that runs an Agent's terminal and holds that Agent's facts while it
runs. `herdr` and `herdr-core` are its only values, and no surface invents a
third word for the same thing: the glossary's **Agent host** entry carries the
`_Avoid_` list. ADR 0002's rule that the plane never starts an Agent process
itself stands unchanged; its rule that herdr is the only host does not.

**Host resolution: config, then the environment mark, then the default.**
An explicit `agent-host` in the Config file wins. With no config, a non-empty
`HERDR_ENV` names `herdr` - the same in-herdr mark ADR 0024 and ADR 0139 already
read, set with any value - and a non-empty `HC_TERMINAL_ID` names `herdr-core`.
With neither mark the answer is `herdr-core`. Absent is the only word for
"resolve it yourself": no `"auto"` value stands beside it, and a value outside
the two names is a boot refusal through the same strict config rule that refuses
an unknown key today.

**The run states what it resolved, and it starts no host of its own.** One
Message line and one Plane boot record entry (ADR 0129) name the resolved host
and the fact that resolved it: the config key, the herdr mark, the herdr-core
mark, or the default. The same line states that the first herdr-core read starts
that session's core when none runs, because the measurement shows no herdr-core
command that answers without starting it. The plane runs no `server start`,
`server stop`, or `server restart` of either host, and it pre-checks nothing it
cannot check without causing the effect.

**The config carries the host and the host's own connection.** Top-level
`agent-host = "herdr" | "herdr-core"`, and `[agent-host.herdr-core]` with
`binary`, `session`, `cols`, and `rows`. An unset `session` is herdr-core's own
default session, the one the operator's terminals and the Herdr desktop use, and
the plane scopes its own Agents by label rather than by taking a private session
the operator cannot see into.

**One module owns both command dialects and the host's state words.** Every
herdr and herdr-core command the plane builds leaves through it, and the host
words (`state`, `status`, `turn`, `reason`, and their refusal codes) become the
plane's facts - Starting, running, settle cause, Missing agent - inside it, so
no surface reads a host word of its own. An automated check rejects a literal
`"herdr"` or `"hc"` argument outside that module, the way the shared-controls
check rejects a renderer field name today. The **Stub herdr world** (ADR 0132)
answers both dialects from one standing, and its closed-surface rule covers
both: a suite that starts an Agent on one host cannot be answered by the other
host's shape by accident.

**Every herdr-core start carries its flags, and the plane writes no herdr-core
config.** `--outlive-parent`, because a herdr-core terminal is a child of the
terminal that started it and ends with it otherwise, and the plane restarts while
Agents run. `--no-notify`, because herdr-core types notes about a child into the
parent's input, and the plane's Action bar owns its terminal's input. No
`--keep`, because a lost Agent replaced by a shell in place hides exactly the
fact the Missing agent marker exists to state. No `--rm`, because the finished
record is what the residue record and the operator's Close act on.

**The plane labels every herdr-core terminal it starts, and adopts it into the
desktop when its own terminal stands there.** Its own namespace carries the run,
the Ticket, the Handoff, and the repository, which is what scopes the roster read
and keeps a dead run's rows readable. Beside those it copies the Adoption labels
`herdr.space` and `herdr.tab` from its own herdr-core terminal when that terminal
carries them, and writes no such label when it does not. This is what keeps an
Agent started from a desktop pane visible in the desktop window at all: on this
host the plane has no view to aim, and the operator's only other route to an
Agent is to type an attach command.

**The version floor is the release the shapes were read against: herdr-core
0.1.20.** An older host is one Warning line at boot, and a shape that host
refuses comes back as that host's own reason. The plane does not guess which
shape an older core refuses.

**Two herdr facts stay herdr-only, stated rather than faked.** The Goto on this
host refuses and states the exact `hc attach <name>` command the operator types,
the way a refusal elsewhere in the plane hands the operator the next step. The
Live view's ANSI stream is not offered: herdr-core reads a screen as text and
answers no styled read, and a Live view built from a fake of that stream is
worse than a Live view that is absent.

## Considered options

- **Drive herdr-core everywhere, and let the Adoption labels carry the desktop.**
  Rejected for now, and it is the direction this decision keeps the door open
  for: the plane's stored Environment facts are a workspace, a tab, and a pane,
  and herdr-core answers none of them, so this change adds a host beside the one
  the plane ships against instead of replacing it.
- **No host at all when neither mark stands: the plane runs read-only.**
  Rejected: a plain terminal is a first-class way to run the plane, and
  herdr-core answers there with nothing installed beyond the binary. The run
  states the resolved host rather than refusing to start anything.
- **herdr as the fallback default.** Rejected on the measurement: in a plain
  terminal no herdr server answers, and the plane's first handoff fails on a
  command that cannot reach one.
- **Pin the host once per run.** Rejected in
  [ADR 0142](./0142-one-run-holds-agents-on-both-hosts-and-the-host-stands-on-the-handoff.md):
  the operator asked to choose at launch, and a Ticket that moves host
  mid-cycle must not be forced onto one host for its whole life.
- **Set the flags in the operator's `~/.config/herdr-core/config.toml`.**
  Rejected: that file is the operator's and covers terminals the plane does not
  own, and one flag there (`notes`, `shell`, `draft_wait`) changes the operator's
  own terminals to serve the plane's starts.
- **Refuse to run until the operator names a host.** Rejected: the mark is a
  fact the machine already states, and a refusal that ignores it spends the
  operator's attention on a question the environment answers.

## Consequences

- The plane's runtime dependency is now "one Agent host", not herdr. Inside
  herdr the default is herdr and nothing changes for today's operator; outside
  herdr the plane drives a host it has never driven, and that is where the risk
  of this change sits.
- The plane's state begins to hold a herdr-core terminal address beside a pane,
  tab, or workspace id, and every reader of those handles reads the host with
  them ([ADR 0142](./0142-one-run-holds-agents-on-both-hosts-and-the-host-stands-on-the-handoff.md)).
- Two command dialects and one host word map have one home, and the check keeps
  the spelling out of the surfaces. The Stub herdr world grows a second dialect,
  and its closed-surface rule is what keeps the two from drifting.
- The plane writes into another program's label namespace (`herdr.space`,
  `herdr.tab`), on the condition that its own terminal carries them. A desktop
  that changes that rule is a measured break, not a silent one, and the adoption
  walk is recorded as unverified until it runs.
- The Worktree Environment and the session-record path become the plane's own on
  this host, which is two new contracts with git and with the runtime's on-disk
  layout rather than a reuse of herdr's
  ([ADR 0143](./0143-on-the-herdr-core-host-the-plane-owns-the-worktree-lifecycle.md),
  [ADR 0144](./0144-on-the-herdr-core-host-the-plane-derives-the-agent-session-record-path.md)).
- herdr-core's own status words map onto the plane's facts through one table, so
  a host that renames a word is one module's change and not a surface's.
- The Goto and the ANSI Live view read as host-dependent availability facts with
  a stated reason, and no control appears in the Key guide that this host cannot
  run.
- Screen-reader support remains unverified, as before: this decision moves no
  accessibility surface, and the terminal walks in
  [the shared-controls verification record](../verification/shared-controls.md)
  stay open. Every herdr-core answer shape the plane reads is traced to a
  recorded herdr-core answer or recorded as unverified, the ADR 0132 rule, and
  nothing about this host has been run through the plane yet.
