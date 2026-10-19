# ADR 0138: The suite entry stands under a spin watch

Status: accepted
Date: 2026-10-19
Records the decision that the `bun run test` entry runs the suite's `bun
test` command under a reader that samples the run's own processes, takes
down a process that stands in a spin (issue #403), and ends the run red.
ADR 0105's push gate is unchanged in what it measures: its one full `bun
run test` is the same command, and that command now stands under the
watch. The gate gains one red the run can end with, and the report
distinguishes it from a test failure.

## Context

The full suite can end in a state no check of the tree can reach: a test
worker of the run spins its JS thread at full CPU with the event loop
starved. Issue #403 measured the state on a 32-core machine: one `bun
test --test-worker` process at about 100 percent of a core for 19 to 25
minutes, making no voluntary context switches, one dead child unreaped
beside it, while the rest of the run had finished. The runner's 60-second
per-test budget is a timer on the worker's own event loop, and a starved
loop cannot fire it: the spin outlives every deadline of the run, and the
run cannot end on its own. The only exit an operator has is to find the
spinning process in the process table and kill it by hand.

The fix that closed the measured trigger - the tmux check's client calls
run as asynchronous children, so a client that stops answering stands the
check's own deadline up instead of starving the worker's event loop -
removes the spin the two process-table captures stood in. It removes one
measured trigger, not the shape of the failure: any synchronous stretch
of a worker that loses its event loop to a child it waits on stands the
same way, and a full suite run on a many-core machine stands that
stretch open for minutes before anyone happens to look.

A reader of the process table sees the state the captures stood in: a
thread that spins inside one synchronous call holds its CPU share at
about one over every beat and makes no voluntary context switches in the
window, and a healthy process - one busy through a whole heavy file
included - turns its event loop between its bursts of work, and every
turn it takes on a timer or a pipe is a voluntary switch. The signature
the measured spin wore is the signature the watch reads.

## Decision

**The `bun run test` entry runs the suite under the watch.**
`scripts/test-spin-watch.ts` runs the same `bun test` command the entry
always ran, streams the same output, and stands a reader beside it. The
reader samples the run's own processes on a beat: the run's `bun test`
parent - so a run that stands no worker child, a single-file parallel run
whose tests run in the parent, stands in its sight - and the parent's
test workers, matched on the `--test-worker` argument of each child's
argument list. The kernel joins a process's command line with NUL bytes,
and a spaced word of that byte string never matches the arguments it
holds, so the match stands on the argument list the NUL split gives
back.

The CPU share the reader reads over a beat stands on the kernel's clock
ticks, and the ticks per second the kernel reports is not a constant
every Linux kernel agrees on. The watch reads the machine's own value
before it computes a share (`sysconf(_SC_CLK_TCK)` through a one-line
helper it compiles once, in the user's cache, the way
`scripts/crash-guard.sh` builds its library), and the report it prints
names which value stood: the read, or the assumed 100 when the read
stands nowhere.

**A process that wears the signature across the whole window is taken
down with its report, and the run ends red.** A full CPU share held on
every beat of the window, and the process making no voluntary context
switches in it. The report stands the process's pid, the per-beat CPU
share, the switches the window held, and the dead children the process
had left unreaped. A run pulled out of a spin is not a green run: the
run ends red, and the red run names the state the spin stood in instead
of the silence a hang leaves. When the run ends, the watch prints the
set of processes it held in its sight over the run, so a green run names
the run it watched instead of standing silent.

**The watch reads only the run's own parent and the parent's
children.** A run standing beside another run on the same machine cannot
trip it, and the run's grandchildren - a check's own tmux server and
pane, a stub a test spawns - stand outside it: the spin measured in issue
#403 stood in the worker's own thread, beside the child the worker had
lost the exit of. The watch stands only where it can read the
processes' `/proc` entries (Linux); elsewhere it passes the run through
untouched, with the same exit code.

The watch's logic stands beside its end-to-end test
(`test/spin-watch.test.ts`): the parsing stands on the shapes the
process table holds, and the end-to-end half stands the watch beside a
stub command whose child spins at full CPU and makes no voluntary
switches, and asserts the watch takes the child down and ends the run
red.

## Considered options

- **Leave the runner's per-test budget as the only guard.** Rejected:
  the budget is a timer on the worker's own event loop, and a starved
  loop cannot fire it. The measured spin outlived the runner's 60
  seconds for over twenty minutes.
- **Take a process down on CPU share alone.** Rejected: a healthy
  process can hold a full core through one heavy synchronous stretch.
  The switch half of the signature is what separates a spin from work:
  the stretch yields to its event loop between its turns, and the spin
  makes none.
- **Read every process on the machine.** Rejected: the watch's one job
  is the run it stands beside, and a run standing beside another run
  must not trip it. The parent and the parent's children are the
  processes the run stands in, and they are what it reads.
- **Pin the clock ticks at 100 and record the assumption.** Rejected:
  the value is not a constant every kernel agrees on, and a share
  computed against the wrong value can stand off the floor the spin must
  clear without the watch saying so. Reading the kernel's own value
  costs one compiled one-line helper, and the report names which value
  stood either way.
- **Stand the watch in the pre-push hook or in CI by hand.** Rejected:
  the watch is a property of the `bun run test` entry, and the entry is
  what the gate and CI run. The command carries its own guard, and a
  checkout that runs the command gets the guard with it.

## Consequences

The push gate's one full `bun run test` (ADR 0105) stands under the
watch, on this machine and on CI alike: the command it runs is the
watched entry. The gate gains one red the run can end with: a spin taken
down with its report. The report distinguishes that red from a test
failure, and a red run without the report stands on the tree the same
way it always did.

The run's output gains one line at the end of every watched run: the set
of processes the watch held in its sight, the clock ticks per second it
stood on, and whether a spin stood. The commands page carries the line,
and the end-to-end test reads it back.

The run's grandchildren stand outside the watch, and a `bun test` run
outside the entry - the inner loop's `bun test <file>`, a hand-run
suite - stands under no watch at all. The commands page names both
limits beside the guard.

When the watch takes the run's `bun test` parent down, the parent's
worker children stand orphaned: whether a `bun test` worker exits when
its parent dies stands unmeasured, and the verification record names
the limit. The measured spin stood in a worker the watch takes down
itself, so the risk stands low.

The child's exit code passes through the entry unchanged: the watch
normalizes nothing, and the one code it writes itself is the 1 of a
run it pulled out of a spin. A run that ends non-zero on the tree ends
non-zero through the entry, and a green run ends 0.

A machine without a C compiler gets the assumed tick value, named in the
report: with the assumed value, a spin on a kernel that reports more
ticks still stands over the floor, and one on a kernel that reports
fewer stands under it and is missed. The read is what keeps the share
honest on any kernel, and its absence is stated in the report instead of
assumed in the record.

The watch is the runner's companion, not a new test layer: it runs the
same command, streams the same output, and reports the same exit code
when no spin stands. Its one new power is the red it pulls on a run it
pulled out of a spin, and the report it prints is the evidence the red
stands on.
