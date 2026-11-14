# ADR 0158: The frame rig derives the plane's key and hint facts once per setup

Status: accepted
Date: 2026-11-14

Records that the frame rig derives the plane's static key and hint facts once
per setup, at the rig's boot call, from the named world spec and the plane
record the call takes. The rig's key operations and its frame reads take the
facts from that table and re-derive nothing. A setup is the test's mounted
plane: under the warm rig pool of ADR 0157 it is per test, because ADR 0157
resets the plane's facts per test, and on the per-test cold boot of today it
is per test as well. The rig's interface stands unchanged: the boot call
keeps its shape, and the named key operations keep their names and their
named outcomes.

## Context

The operator sees nothing of this decision, and the cost it moves is the
machine's. Every key operation the frame rig drives - the press, the guide,
the page, the press-until, and the escape operations - and every frame it
reads to resolve one re-derives the plane's static key and hint facts: which
controls of the Control catalogue the plane paints, their key labels, the key
labels the frame paints, which hint each row or bar owns, the bar's hints,
the facts the shared-hint guard reads, and the display-only key labels. The
derivation walks the Control catalogue beside the plane's config record on
every operation, and the frame suites stand on the operations: the suite's
wall time stands on the rig's waits, about 3,000 wait sites polling every
10 ms, and the derivation pays beside them, on the machine's CPU. The
operator's share of the cost is the suite's wall time and the red a slow
machine widens in it, and the operator pays nothing of the plane's paint: the
production paint path, the shell's hint painting through the shared
presentation module, stands exactly as it stands.

The facts the rig re-derives are static per setup. They stand on facts that
change per setup - the config record, the standing, the world spec, the plane
record - and they do not change per press or per frame: a press that sends
the bar's key for a control does not repaint the catalogue, and a frame the
plane owes stands on the same controls the previous press resolved. The
census ADR 0128 counted for this seam stands in the thousands: 875 frame
waits and 1,888 hand-written wait descriptions behind the key operations
that pay the derivation, and the 193 key-ownership waits that stand on the
ownership read. One of the facts already stands on the deep side: the
display-only key labels are derived once from the catalogue's standing facts,
memoized, and the parser answers its per-hint read from that one derivation.
The memo is the pattern this record generalizes to the whole table: one
table, derived when the setup stands, read by every press and every frame.

The records that stand around this one are recorded on this tree and not yet
implemented, and their issues are open. ADR 0156 resolves the rig's waits on
the renderer's frame passes; the waits it deepens are the waits this record
moves the derivation beside. ADR 0157 keeps the test renderer and the App's
root mounted across a file's tests and resets the plane's facts per test;
the reset this record's table lifetime stands on is that reset. ADR 0128
deepened the rig's input face - the Control catalogue, the Action bar, the
named outcomes, and the one deadline - and left the derivation beside every
operation it named. This record moves the derivation from beside the
operation to the boot call the operation stands on, and it moves nothing in
the waits, the pool, or the renderer.

## Decision

- The table: the frame rig derives the table of the plane's static key and
  hint facts once per setup, at the rig's boot call, from the named world
  spec and the plane record the call already takes. The table's contents:
  which controls of the Control catalogue the plane paints, and the modes
  each runs in; each control's key labels, the frame's exit key read off the
  plane's config record among them; the key labels the frame's Action bar
  paints, and the hint each paints; which hint each control's rows or bar
  owns on each mode; the bar's hints, and the facts the shared-hint guard
  reads from them; and the display-only key labels, the labels the catalogue
  paints for a control that claims no key. The per-press and the per-frame
  paths read the table and derive nothing.

- A setup is the test's mounted plane, and the table is per setup. Under the
  warm rig pool of ADR 0157 a setup is per test, because ADR 0157 resets the
  plane's facts per test: the table derives per test, against that test's
  config record, standing, and world, and it is never shared across tests or
  across setups. Today, on the per-test cold boot, per setup means per test
  as well: the table the boot call derives stands for exactly the plane that
  call mounts, and a test that boots cold derives its table beside the cold
  boot.

- The named key operations keep their names, their fields, and their named
  outcomes, and their bodies read the table. The press resolves its control
  against the table's hints and reads its key-ownership facts and its
  shared-hint facts from the table. The guide reads the control's aliases
  from the table, the page resolves its keys against the table's bar facts,
  and the press-until re-sends on the table's read of the bar it paints. The
  escape operations read their keys from the table the same way the
  catalogue gave them before, and the immediate press and the key-ownership
  window stand as ADR 0128 left them.

- The frame reads the operations stand on keep their shape. The settle still
  settles the plane to a frame the plane owes, and the resolution of that
  frame reads the table: the bar's painted hints are matched against the
  table's hints, a hint's ownership is read off the table, and the
  shared-hint guard reads its co-owners from the table. The frame-dependent
  reads stay per frame: the surface the frame stands on, and the hints the
  frame's bar painted, are facts of the frame. What leaves the per-frame
  path is the catalogue derivation the path paid beside them.

- The display-only key labels already stand on the deep side, and this
  record generalizes their pattern to the whole table. They are derived once
  and memoized, and the parser answers its per-hint read from that one
  derivation. Generalizing the pattern means one table per setup, derived
  when the setup stands, instead of one memo per fact: the invalidation
  knowledge stands at the derivation, a setup change derives a new table
  rather than invalidating a cache per fact, and the locality of one table
  derived when the setup stands is kept instead of traded for a parallel
  derivation per fact, each standing beside the re-derivation it shadows.

- This decision is order-safe in both directions against ADR 0156 and ADR
  0157. Both are recorded on this tree and not yet implemented, and their
  issues are open. The table is derived at the rig's boot call against the
  record that call takes, and that call is the same call under today's
  per-test cold boot and under ADR 0157's warm pool: the table is per test
  either way, and ADR 0157's per-test reset of the plane's facts is the
  reset that re-derives it. The rig's key operations keep their names and
  their named outcomes, so ADR 0156's frame-pass resolution of the rig's
  waits applies to the same operations that now read the table: each record
  lands before or after the other, and the seams both deepen stand.

- The decision is test-side, and the rig's owned surface grows and never
  shrinks. It deepens the frame rig and the plane the frame suites drive
  through: the production paint path, the shell's hint painting through the
  shared presentation module, stands exactly as it stands, and no call site
  changes a line. The boot call keeps its shape, the frame suites' named
  operations, fields, and named outcomes stand as ADR 0128 left them, the
  architecture test's closed floor of owned suites stands, and the counter
  walk accepts the count as the table's pin joins the owned list.

## Considered options

- Keep the per-press re-derivation (status quo): every key operation the rig
  drives and every frame it reads pays the full derivation against the
  catalogue and the plane's config record, on a suite whose census ADR 0128
  counted in the thousands. The knowledge that the facts are static per
  setup stands nowhere, and each new key operation re-derives the table
  again beside the press it serves. Rejected: it keeps the per-operation
  derivation on the suite's dominant cost, and it spends the locality of one
  table derived when the setup stands.

- Memoize each fact separately, as the display-only labels already are: the
  invalidation knowledge scatters across one cache per fact, a setup change
  must invalidate every cache by hand, and the locality of one table derived
  when the setup stands is traded for a parallel derivation per fact, each
  still standing beside the re-derivation it shadows. Rejected: it
  generalizes the pattern in the direction that keeps the derivation beside
  the press.

- Derive the table once per file under the warm pool and share it across the
  file's tests: ADR 0157 resets the plane's facts per test, so a table
  shared across the file's tests reads the previous test's config record,
  standing, or world. The isolation breach costs more than the per-test
  derivation it saves, which is cheap next to the rig's waits: the suite's
  wall time stands on the waits, and a small table derived per test is a
  line behind them. Rejected: it spends the fresh-plane rule the suite stands
  on to save the cheapest of the costs this record moves.

- Move the table into the production shell and let the rig read production
  state: the table is the rig's resolution of which of the plane's facts its
  operations and frame reads use, and standing it in the production shell
  adds a test concern through the shell's interface. That is the same leak
  ADR 0157 refused for the pool: the production entry builds the App once
  per run and never reseeds a mounted one, and the rig's facts would come to
  stand on a field the App carries for the tests. Rejected: it spends the
  shell's interface on a fact that stands on the test seam.

## Consequences

- The operator sees nothing: the production paint path stands exactly as it
  stands, the shell's hint painting through the shared presentation module
  included, and the plane the operator runs paints its keys and hints the
  way it does. The operator's share of the decision is the frame suite's
  wall time and the CPU it spends, which the record moves from per
  operation to per setup.

- The machine: every key operation and every frame read pays the table's
  derivation once, at the setup's boot, and reads it after. On the per-test
  cold boot of today that is one derivation per test instead of one per
  press and per frame; under ADR 0157's warm pool it is one derivation per
  test, against the test's own facts, beside the warm renderer. The
  derivation cost stands beside the rig's waits on the machine's ledger,
  where the suite's wall time already stands, and the derivation is small
  next to the waits: it is the line behind them that this record moves.

- The test: the frame suites keep every pin. The same-frames pin stands,
  because the frames the rig paints and reads are identical with the table,
  so the pool and the cold boot cannot drift a suite's frames from the
  frames the rig reads. The named outcomes, the named key operations, the
  immediate press, and the key-ownership window stand as ADR 0128 left them,
  and the table's contents join the pins as values read against a fixed
  setup, with no terminal, no process, and no state file, the way the
  startup module's suite pins its decisions.

- The test: deleting the table returns the per-operation derivation to every
  key operation and every frame read, and the suite feels it as CPU on its
  dominant cost. The table is small and its deletion is not: the cost it
  saves is paid per press and per frame across the census ADR 0128 counted
  in the thousands, which is the shape of the deepening this record stands
  on.

- The glossary: the Frame rig entry gains the table: the rig derives the
  plane's key and hint facts once per setup, at its boot call, from the
  named world spec and the plane record, and its key operations and frame
  reads read them instead of re-deriving them. The entry lands with the
  implementation, not with this ADR.
