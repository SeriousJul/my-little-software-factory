# ADR 0144: On the herdr-core host the plane derives the Agent session record path

Status: accepted
Date: 2026-11-12

Records that ADR 0008's session record path has a second supplier: on the
herdr-core host the plane derives it in a per-Agent-type module from facts it
already holds, that a derivation which is not unique or not visible answers
unavailable rather than a guessed path, and that every unavailable answer takes
ADR 0008's terminal capture fallback with one line in the run's record. It
changes no wording the operator reads, decides no gate, and lands no code
([ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md)).

## Context

ADR 0008 put the Turn log on the Agent's own session record instead of the
terminal's rows, and it took the record's path from the poll: herdr's `agent list`
reports each Agent's session record when the matching herdr integration is
installed, the Handoff stores that path, and `readSessionTurnEnd` and
`readSessionExchange` read it at settle. Three per-kind readers stand behind that
seam today (`turnEndFromPiSession`, `turnEndFromCodexSession`,
`turnEndFromClaudeSession`), and one fallback beside them: the terminal capture,
through `turnLogFromCapture`.

herdr-core reports no session record at all. Measured on 2026-11-12 against `hc`
0.1.20 ([the verification record](../verification/agent-host-herdr-core.md)): its
terminal record carries `argv`, `cwd`, `labels`, `status`, `turn`, `exit_code`,
and `reason`, and names no session file; its roster read carries no status word
either. So the same Turn log, the same settle causes, and the same Session view
would fall to the capture on that host for every kind, which is ADR 0008's
degraded body, not its designed one.

The capture is thinner on this host than on herdr, and that is measured too:
herdr-core answers a read of a program in `working`, `blocked`, or `error` state
with the screen alone, marked incomplete, and sends no scroll input to harvest
history. On the herdr host ADR 0140 chose the visible screen for the same reason.
So on the herdr-core host a turn whose record cannot be read has a body of one
screen, and the record's absence costs more there than it does here.

## Decision

**A per-Agent-type module supplies the session record path when the host does
not.** It stands beside the Agent type's other per-kind knowledge (the Model list
command map in `src/runner.ts`), keyed by the same kind, and it answers one
path or an unavailable answer. The herdr host keeps its supplier: herdr's reported
path stays the source there, and the derivation never overrules a host that
names the record.

**pi first.** The pi reader exists, pi is the shipped `default-agent`, and pi's
session home and per-checkout session directory are readable facts on the
machine the Agent runs on. codex and claude follow when their own readers move
onto a path the plane can name.

**A derivation is a lookup in the open, never a guess.** It names a path only
when the file stands there, and only when one record can be the Agent's: the
Agent type, the checkout the Agent runs in, and the start time the plane already
recorded pick the record. Two candidates that both fit, a session home the plane
cannot read, or a kind with no derivation all answer unavailable, and the settle
takes the capture. The plane writes nothing into a runtime's session home, and it
never follows a name it has not seen.

**Unavailable is a line, not a failure.** The settle settles on the capture and
the run's record states that the session record was unavailable, the same way the
`unknown` turn end cause of ADR 0017 fails open today. A turn whose record cannot
be read is never `no-turn`: the record's absence says nothing about whether the
turn ran.

**The derivation stands only for a local Agent.** The session record is a file on
the machine the Agent runs on, and herdr-core's remote machines are out of this
change's scope
([ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md)); an
Agent on another machine has no readable record and takes the capture.

## Considered options

- **Capture only on this host, for every kind.** Rejected: the Turn log is the
  body the operator reads to decide a settled turn, and ADR 0008 exists because
  rendered terminal rows mix the Agent's text with tool rows and prompt echo. On
  this host the capture is one screen at that, so the loss is larger than the
  capture's loss on herdr.
- **Refuse the herdr-core host for any kind but pi.** Rejected: the capture is
  the designed degrade for an unreadable record, and a refusal would take the
  operator's choice of host away for a reason the plane already handles.
- **Ask herdr-core to report the session record, and wait.** Rejected for now,
  and it is the ask this decision replaces rather than hides: the plane reads
  runtime files today by ADR 0008's own choice, so a second supplier of the same
  path costs no new dependency, while a herdr-core feature request buys nothing
  this release.
- **Have the plane pass its own session identity into the Agent's environment and
  read it back.** Rejected: it invents a contract with three runtimes to solve a
  lookup the machine already answers, and a value the Agent echoes back is less
  evidence than a file the plane can see.

## Consequences

- The plane holds a second contract with a runtime's on-disk layout. ADR 0008
  named the first (the record's format); this one names the record's location. A
  runtime that moves its session home breaks the derivation, which answers
  unavailable and settles on the capture, and the break is one module's change.
- A herdr-core Agent whose record cannot be read has a Turn log of one screen, and
  the Stale Agent output and the `unknown` cause read the same way they do on the
  herdr host: they name a record that truly cannot be read.
- The derivation runs on the settle path, so it is cheap and bounded: a directory
  read of one session home, not a scan of the home directory tree, and its own
  unit tests hold the ambiguous-match case as a first-class answer.
- The verification record states which kinds have a derivation, which stand on
  the capture, and which flows were measured against a real runtime on this host;
  an unmeasured flow is recorded as unverified, and no screen-reader claim is made
  for either host.
