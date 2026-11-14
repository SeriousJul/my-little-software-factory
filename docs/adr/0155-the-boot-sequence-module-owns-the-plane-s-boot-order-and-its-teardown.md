# ADR 0155: The boot-sequence module owns the plane's boot order and its teardown

Status: accepted
Date: 2026-11-14

Records that the plane's boot order, and the teardown that reverses it, live in
one deep module, the boot-sequence module. The module takes the Plane boot
record, the loop policy, and the shell's report sinks, and owns the sequence:
the state's boot read, the sources' first reads, the initial load's settle, the
first Observation cycle on that settle, and the polling schedule the first
cycle stands behind. It owns the one teardown that reverses the start, and the
shell calls the module once at mount, registers its teardown as the run's stop,
and keeps the paint, the keys, and the screen stack. This is the separate
record ADR 0154 named: that decision named the order the shell already runs and
did not move the mounts, and this decision moves the order into the module.

## Context

The operator launches the plane. The entry module reads the Plane boot record
from the startup module, names the production loop policy, and renders the
shell. The shell's teardown handle is what the entry's shutdown installer
reads before the state file closes, on every ending that closes the state. The
frame rig runs the same shell on the Seeded plane, and the Seeded plane names
the held loop policy, or the polled policy where the test names an interval.
Both callers stand on the same small face: the record, the policy, and the
handle.

The order the plane runs between its mount and its first settled frame is
ADR 0154's. The state's boot read stands the ticket list, the consultations,
and the queue pause on the record the run booted from. The refresh
coordinator takes the sources' first reads: under the held policy the
one-shot boot read, and under the others the first reads plus the polling
schedule. The initial-load-settled fact resolves when every configured source's
first fetch settles, success or failure, and the list moves once on the
settle. The first Observation cycle, the first herdr probe, runs on the
settle, and the polling schedule arms behind the first cycle. Under the held
policy the plane starts no Observation loop at all.

That order is an accident in the tree. The shell declares the sequence's steps
as separate stages in its hook chain, and the order the steps run is the order
the chain declares them: the Observation coordinator's start, the state's boot
read, and the refresh coordinator's start, one stage each, in the chain's
declaration order. A hook chain fixes an order by position, and it holds
nothing else: the order is shallow there, a byproduct of the declaration, with
no interface to pin it at. A stage inserted into the chain reorders the boot,
and the reorder lands before the first frame shows it. The teardown's reverse
order lives in a separate registration the shell keeps in agreement with the
start order by hand. The entry and the rig carry the rest of the knowledge:
the policy they name, the handle they hold, and the settle they drive.

The Plane boot record (ADR 0129) names the fields the boot stands on, not the
order the fields are stood in. ADR 0154 names the order the plane runs and
names its own limit: it holds the first probe and the first list move until
the initial load settles, and it does not move the mounts. It calls the
deepening that moves the boot order into its own module a separate record.
This record is that separate record.

## Decision

- The plane's boot order and the teardown that reverses it live in one deep
  module, the boot-sequence module. The module owns the sequence in full: the
  state's boot read, the refresh coordinator's start - the one-shot boot read
  under the held policy, and the sources' first reads plus the polling
  schedule under the others - the list's one move on the initial load's
  settle, the first Observation cycle on the settle, and the polling schedule
  the first cycle stands behind. It owns the teardown that reverses the start:
  the Observation coordinator stops, the refresh coordinator stops, its
  initial-load-settled fact resolving on the stop, and the Handoff dispatch
  and the Consultation operations stop behind them, in the one order the
  module fixes, before the state file closes.

- The module's interface is small, and the module is deep. It takes the Plane
  boot record, the loop policy, and the shell's report sinks: the writes that
  stand the ticket list, the consultation list, the queue pause, and the
  message and status lines the loops report onto. It takes the shell's
  dispatch operations, the Handoff dispatch and the Consultation operations,
  whose stops the teardown runs. It gives back the ordered start and the one
  teardown that reverses it. The sequence, its policy branches, and its
  corrections are the module's implementation: the callers' leverage is the
  interface, and the order's locality is the module's.

- The shell calls the module once at mount, and it keeps the paint, the keys,
  and the screen stack. The shell stands the report sinks the module reports
  to, it paints from them, and it dispatches the keys onto them. It registers
  the module's teardown as the run's stop, the same handle the entry's
  shutdown installer reads. The Startup grace and the Agent wait of ADR 0084
  stand inside the Observation cycle the module starts: the module decides
  when the loop starts, and the cycle keeps its grace window, its wake, and
  the polling interval it derives from the config.

- The frame rig stands on the same owned sequence. The Seeded plane names the
  loop policy, and the rig's named operations - the settle of the sources, the
  key it presses, the frame it reads - stand on the sequence the module owns.
  Under the held policy the Seeded plane runs the sequence's held branch: the
  boot read, the one-shot boot read, the settle, and no Observation loop. The
  rig names no order and the entry names no order: both name the policy and
  hold the handle, the way they do today.

- The module's seam is its interface: the record and the policy in, the
  ordered start and the teardown out. The test pins the sequence and its
  reverse at that seam without a process, a terminal, or a state file, the way
  the startup module's suite pins the boot decisions the module returns as
  values.

## Considered options

- Keep the order in the shell's hook chain and document it. The chain is where
  the steps stand today, and a note beside each stage states the intent the
  chain's order carries. It loses because the order is fixed by declaration
  position, and a stage inserted into the chain reorders the boot silently,
  before the first frame shows it. The teardown's reverse lives in a separate
  registration that the shell keeps in agreement by hand, and no test can pin
  the order at a seam the shell does not expose. The order's knowledge has no
  locality: it stands in the chain's declaration order, in a separate
  registration, and in the policy each caller names, and the boot's order
  stays shallow where it stands.

- Move only the start order into the module and leave the teardown with the
  shell. The start is the half the operator sees at launch, and the teardown
  is wiring the entry already reads through one handle. It loses because a
  boot order without its reverse is an order the machine can run but not
  undo: the start and the stop are two halves of one sequence, and splitting
  them puts the sequence's depth back in the shell, where the stop's order is
  re-derived from the start's by hand on every change.

- Run the sequence from the entry module, which runs the boot's steps in order
  before the shell mounts. The entry owns the order of the startup's steps,
  and the sequence is the boot's next steps. It loses because the sequence's
  steps report into the shell's sinks and run the shell's dispatch operations,
  which stand only once the shell is mounted, and the entry is not on the path
  the Seeded plane takes: the frame rig builds the record and drives the shell
  without the entry, so the order the rig pins would not be the order the
  entry owns. The entry keeps naming the policy and holding the handle.

- Fold the boot-sequence module into the startup module. The startup module
  owns the boot decisions the entry reads before the shell mounts, and the
  sequence is the boot's next decisions. It loses because the startup module's
  work ends where the record stands: it runs no loop, holds no sink, and its
  suite reads its decisions as values without a process. The sequence it would
  absorb runs against the mounted shell's sinks and its dispatch operations,
  and the module it would become would owe the startup module's suite a state
  file and the shell's suite a terminal. The record stands in the entry, the
  sequence runs beside the shell, and the two halves of the boot keep their
  two modules.

## Consequences

- The operator launches the plane, and the order the boot runs is the order
  the module owns: the list stands on the state's boot read, it moves once on
  the settle, the first probe lands on the settled roster, and the schedule
  arms behind the first cycle. The order is the module's fact now, not the
  shell's accident, and a reorganization of the shell's stages cannot move it.

- The machine runs one sequence and its reverse: the start from the record and
  the policy, the teardown that reverses it, and the policy's branches inside
  the module, so the held run's one-shot boot read and the polling run's
  schedule are one sequence with two arms. The Startup grace and the Agent
  wait stand inside the cycle the sequence starts, and the module does not
  touch the rules they run on.

- The test pins the sequence and its reverse at the module's seam, the record
  and the policy in and the ordered effects and the teardown out. The
  seeded-plane frame suites pin the same sequence through the frame rig, the
  refresh coordinator's suite pins the settle's fact on the owned sequence,
  and the Observation suite's pins over the pinned clock pin the first cycle
  on the settle. The deletion test is the test's argument: with the module
  deleted, the order's knowledge scatters back across the shell's hook chain,
  the entry's shutdown wiring, and the rig's policy naming, and no seam can
  pin it; the module is the one place it stands.

- The glossary gains the boot-sequence module: the deep module that takes the
  Plane boot record and the loop policy and owns the boot's ordered start and
  the teardown that reverses it, named beside the Plane boot and the loop
  policy it takes.
