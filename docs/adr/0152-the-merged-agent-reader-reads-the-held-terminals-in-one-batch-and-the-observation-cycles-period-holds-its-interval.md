# ADR 0152: The merged agent reader reads the held terminals in one batch, and the observation cycle's period holds its interval

Status: accepted
Date: 2026-11-14

Records that the merged agent reader's probe reads the plane's held terminal
rows in one concurrent batch: the roster read stands, and the record reads of
the roster's held rows run together, after the roster settles, instead of one
behind the next, on the herdr-core host where those reads are the probe's
per-terminal cost. And records that the observation coordinator schedules the
next cycle at the previous cycle's start plus the interval, clamped to now
when that instant is in the past, so the cycle's period holds its interval
even when a cycle runs long. The Agent reader's interface, the Agent wait's
wake, and the cycle's one report move none of them.

## Context

The operator watches the tickets, and the machine works them. The Observation
cycle is the plane's watch over the machine: on each period it probes the
Agents the host lists, settles the turns the probe shows ended, fires their
Transitions, and runs the Pickup that starts what the settled turns freed.

On the herdr host the probe is the one `herdr agent list` call ADR 0006
decided: one process carries every Agent, and the probe's cost stands off the
size of the in-flight set. On the herdr-core host the merged agent reader that
stands on the run's resolved host (ADR 0142) pays more: the roster there
carries no status word, so the probe runs one unscoped roster read and then
one record read per held terminal. The held terminals are bounded to the
plane's own: the recorded names of its in-flight Tickets and Consultations on
that host, read from the state's handoff facts, so the poll never reads every
terminal on the machine. Today those record reads run one behind the next, and
the probe's cost grows with the in-flight set, one process after the last.

The coordinator owns the loop's period, and it schedules the next cycle after
the previous one completes: the timer stands on the cycle's end, so the real
period is the interval plus the cycle's cost, the interval defaulting to five
seconds. On the herdr-core host the two costs meet and reinforce each other:
the slowest cycle is the one with the most Agents in flight, it is the probe
that reads the most terminals in a row, and it is the cycle that delays the
next probe the longest. The machine's busiest moment is the moment the plane
looks least often.

The cost lands where the operator reads it. An Agent that finished a while ago
still shows as working, because the probe that would settle it waited behind
the sequential reads and behind the period the overrun stole. A slot just
freed by a finished Agent stays unfilled for an extra period, because the
Pickup that would fill it runs on the late probe. And a terminal the roster
stops listing is corrected on the next probe: the Startup grace holds the
automatic Restart, and nothing moves the displayed state before that probe.
ADR 0084's Agent wait already carries the state-change latency: one wait per
in-flight working Agent, and the state match runs a cycle now. The period's
cost therefore shows only on what the wait does not watch: the Missing
agent's correction, and the staleness of the facts the wait holds no wake
over.

The depth is shallow on both sides, and both sides stand in the modules that
already own the facts. The record reads are independent of one another: each
stands on its roster row and on no other record read, so the serialization is
a choice of the implementation, not a fact of the work. The schedule rule
stands on the coordinator's own clock, beside the interval it already reads
each cycle. Neither deepening moves the Agent reader's interface: the same
rows, in the roster's order, the same failure semantics. The reader keeps its
one seam to the outside: the process spawning already runs through the command
runner, and a test counts the runner's commands.

## Decision

- The probe's core half reads all of the plane's held terminal rows in one
  concurrent batch. The roster read stands, and when it settles, the record
  reads of the roster's held rows are issued together and awaited together,
  instead of one behind the next. On the herdr-core host, which the run's
  host resolution names (ADR 0141, ADR 0142, ADR 0143, ADR 0144, ADR 0148),
  that half is the probe's per-terminal cost. On the herdr host the probe is
  the one list call that carries every Agent, and the half reads the
  terminals the run's own handoffs put on herdr-core, empty when none, so the
  batch is a no-op where the probe is one call.

- The Agent reader's interface moves nothing. The merged list carries the
  same rows, in the roster's order, and the failure semantics stand exactly
  as the reader reports them today: a roster the host does not answer is the
  probe's error on the herdr-core host, where the observation holds, and the
  stated gap beside the standing herdr half on the herdr host; a record that
  does not answer leaves the terminal present with an unknown status; a
  terminal the host lost drops its row, so the Missing marker reads it and no
  settled turn does.

- The coordinator schedules the next cycle at the previous cycle's start plus
  the interval, clamped to now when that instant is in the past, instead of
  at the previous cycle's end plus the interval. A probe that finishes early
  holds the period at exactly the interval, and a probe that runs past its
  slot runs the next cycle at the slow cycle's completion: the grid
  re-anchors on that cycle's own start, and the period returns to the
  interval the moment the probe keeps the pace again. A timer fire that meets
  a cycle already in flight runs no cycle of its own: it holds that in-flight
  cycle's start as the grid anchor.

- The first tick stands: the boot runs the first cycle immediately, and its
  next cycle stands at the boot's start plus the interval, the way it does
  today. The interval stands as it stands today: the loop policy's named
  interval where the policy names one, the config's poll setting otherwise,
  derived each cycle.

- ADR 0084's Agent wait moves nothing: the state match still runs a cycle
  now, beside the timer's grid, and the poll stays the single source of
  truth.

## Considered options

- Keep the sequential reads and schedule from the completion (status quo):
  the probe's cost grows with the in-flight set, one process after the last,
  and every late cycle steals its overrun from the next probe, so the
  machine's busiest moment is the moment the plane looks least often.
- Hold the period and keep the sequential reads: the period stops
  compounding, but the slowest cycle still pays the whole sequential run, and
  a run of long cycles now runs back to back, each paying that same run, so
  the operator's view of the machine lags by the whole run instead of by one
  process.
- Batch the reads and keep scheduling from the completion: the probe gets
  faster, but the period still stands on the probe's end, so a slow settle or
  a slow walk still delays the next probe by its overrun.
- Read each held terminal on its own cadence: it scatters the probe's one
  observation into many independent reads, breaks the standing ADR 0006 set
  so one call carries every Agent and the state transitions and the Parallel
  limit's count share one observation, and multiplies the processes the
  runner spawns.
- Ask the roster to carry the status words: the root cause of the per-terminal
  reads is the herdr-core roster's missing status word, and asking the host
  for one is a change on the host's side of the seam. The plane reads the
  records the host offers, and the batch makes those records cost the
  slowest, not the sum.

## Consequences

- The operator: on the herdr-core host, a finished Agent shows as settled on
  the next probe whatever the size of the in-flight set, a just-freed slot is
  filled by the Pickup on the next probe instead of the probe after, and a
  terminal the roster stopped listing is read as a Missing agent on the first
  probe after it left. On the herdr host the operator sees no change: the
  probe is the one list call it always was.
- The machine: the herdr-core probe pays the slowest of the concurrent record
  reads, not their sum, and the period holds its interval: a slow probe
  steals no time from the next probe, and the grid re-anchors at the pace the
  probe keeps. The Agent wait still runs a cycle now on the state match, and
  the poll stays the single source of truth.
- The test: the coordinator seam, the observation suite that drives the real
  coordinator end to end over the fake command runner on the virtual clock,
  pins the batch: one probe issues the roster read and the held terminal
  reads, the runner's command list counts them, the batch issues after the
  roster settles, and the rows come back in the roster's order. The suite
  pins the period on the virtual clock: a cycle longer than the interval runs
  its next cycle at its own completion, a shorter one at exactly start plus
  interval. The wake's pin still runs a cycle now on the state match, and the
  herdr host's one-list-call pin and the Missing agent's flow pins stand
  unchanged.
- This ADR is the deepening ADR 0151 named as separate: the herdr side of the
  work, one process per terminal the plane polls (the review's O2). The
  refresh a settle takes when the turn's source gives nothing (the review's
  O3) stays separate, and the sibling record ADR 0153 scopes it. These
  records land with the implementation, not with this ADR.
