# ADR 0161: The herdr-core derivation bounds the session record by the host's terminal creation time

Status: accepted
Date: 2026-11-14

Records that ADR 0144's identity facts gain a second bound: when the herdr-core
host reports the time it created the run's terminal, that time stands in for the
start time the plane recorded as the earliest time the record can exist. The
recorded start keeps the bound when the host reports no creation time, and the
reader's staleness guard stays on the recorded start. It changes no wording the
operator reads and it lands no new supplier; it amends the identity facts of
[ADR 0144](./0144-on-the-herdr-core-host-the-plane-derives-the-agent-session-record-path.md)
with a fact the host already reports.

## Context

ADR 0144 picks the record by the Agent type, the checkout the Agent runs in, and
the start time the plane already recorded: a record that began before the
recorded start cannot be the run's. The plane records the start when the host
confirms it: the plane asks the host to start the run, and only when that answer
comes back does the handoff's start time exist. The runtime opens its session
record when it boots, inside that answer's round trip, before the plane writes
the start time.

So on the herdr-core host the record the runtime opens for the run begins
before the start the plane records for it. Measured on 2026-11-14 against
`hc` 0.1.x and pi 1.5.2 on this machine
([the verification record](../verification/agent-host-herdr-core.md)): the
host's terminal record says the terminal was created at 12:58:37.509Z, the pi
record file it booted stands stamped 12:58:37.660Z, and the plane recorded the
run's start at 12:58:39.722Z. A bound of "the record began at or after the
recorded start" rejects the run's own record, the derivation answers
unavailable, the settle takes the terminal capture with the fail-open `unknown`
cause of ADR 0017, the completed turn records no workflow transition, and a
settled turn on an operator-decides position offers no merge row. The race is
systematic on this host: the host always confirms the start after the record
exists.

## Decision

**The host's own time stands in for the plane's.** The herdr-core terminal
record's creation time is the earliest time the record can exist, and it bounds
both the record's file stamp and the record's own start time in its header. The
order is strict on the host's own facts: the plane claims the run, the host
starts it, the host creates the terminal, the runtime boots, the runtime opens
the record, the turn ends, and the plane settles. No tolerance is needed: the
record is opened after the terminal exists, on the host's own clock.

**The recorded start keeps its bound when the host reports none.** A host
without a creation time, or an old host record without the field, gives the
derivation no earlier bound: the recorded start of ADR 0144 stands, and the
derivation's answer for that run is exactly what it is today. The fix changes
nothing for a host that carries no fact.

**The reader's staleness guard stays on the recorded start.** The per-kind
reader still rejects a turn end earlier than the start the plane recorded,
because a turn end is always after the recorded start: the guard tests a turn's
time, not the record's identity. Only the identity's bound moves.

## Considered options

- **A fixed tolerance on ADR 0144's bound.** Rejected: a tolerance guesses the
  host's round trip, and a host whose round trip runs longer than the tolerance
  admits a record the run did not open. The host's own creation time needs no
  guess.
- **The newest record in the directory.** Rejected: ADR 0144 is a lookup in the
  open, never a guess, and newest is a rank, not an identity: it accepts a
  stale record when the runtime reopens one, and it breaks on a second
  terminal in the same checkout.
- **Record the start before the host's start call.** Rejected: the plane's
  pre-call time is the plane's fact, and the plane's clock can stand before the
  host's. The host's creation time is the host's own statement of when the run
  began on the host, and the plane already reads the record that carries it.
- **Ask herdr-core to report the session record.** Still rejected, for the
  reasons ADR 0144 gave. This decision is the same lookup on one more fact the
  host already reports, and it keeps the ask open.

## Consequences

- ADR 0144's identity facts are now the Agent type, the checkout, and a bound:
  the host's terminal creation time when the host reports one, the recorded
  start when it does not. The verification record names the bound and the
  measurement that found the race.
- A host that reports its creation time late, or in another unit, changes the
  bound's meaning. The read is one number in the host's record, and a host
  without the number degrades to ADR 0144's bound: today's behavior, one line
  in the run's record, and the settle's answer is unchanged.
- The settle of a herdr-core-launched Agent now reads the Agent's own record in
  the case the measurement found. The flow ADR 0144 recorded as unmeasured is
  measured on this machine (2026-11-14, `hc` 0.1.x, pi 1.5.2), and the other
  hosts and runtimes stay unmeasured, as the record states.
