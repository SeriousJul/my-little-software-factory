# ADR 0103: The config write-back edits the sections the plane owns

Status: accepted
Date: 2026-10-04

Supersedes the sentence in `docs/configuration/index.md`: "Repository mappings
are the one section the control plane writes back ... The write-back rewrites
the whole config file, so the data round-trips and your comments in the file
do not." That sentence named one write-back path and stated the loss as an
accepted fact.

## Context

The control plane writes the operator's config file from two paths.

1. The repository mapping write. A Consultation or a handoff resolves a
   repository to a sibling clone, and the plane records that clone's path in
   the `[repos]` table (`src/components/app.ts`, `persistMapping`, handed to
   `src/consultation-operations.ts` and `src/handoff-dispatch.ts`).
2. The Repository init's source write. The init registers the ticket sources
   its generator produced (ADR 0075), and the plane appends them to the
   `[[sources]]` blocks.

Both paths called `persistConfig`, which serialized the whole `FactoryConfig`
with `configToToml` and renamed the result over the operator's file. A
`FactoryConfig` carries no comment, no blank-line layout, and no key order
from the file it was read from, so none of that can come back. The write was
atomic and correct as a data write. It was a full replacement of a file the
operator owns.

Measured on the development config through `loadConfigFile` and
`configToToml`: 26 comment lines in the original, 13 after the rewrite; 546
lines to 533; 19493 bytes to 18579. The `FactoryConfig` objects before and
after were deep-equal, a second rewrite was byte-identical to the first, and
the file mode was unchanged. So the loss was the operator's prose and layout,
not the plane's data.

That prose is not decoration. The comments in the development config carry
the reasoning behind a choice: what a task type's act does and which ADRs
decided it, why a state sits where it sits in match order, and why a flag is
set. They are the same reasoning this project writes into its ADRs, standing
where the operator keeps it.

Nothing told the operator the file had changed. The init's confirmation names
the commit and the labels it created, and no line named the config file. The
documentation stated the loss without giving the operator anything to do about
it.

The alternatives:

- **Keep the rewrite, and tell the operator.** Rejected: it fixes the surprise
  and not the loss. The operator would learn their comments are gone only
  after they are gone, and the only remedy is to keep a copy of their own file
  by hand.
- **Carry the comments through the load and the serialize, so the round trip
  preserves them.** Rejected: it makes the config parser a document-preserving
  one, and the plane would own the operator's layout - comment placement,
  blank lines, key order - as parsed state. That is a large surface to build
  and maintain for the two tables the plane actually writes.
- **Edit the sections the plane owns in place.** Chosen: the plane already
  knows exactly which regions it writes, and everything else in the file is
  the operator's.

## Decision

**The plane owns two regions of the operator's config file: the `[repos]`
table and the `[[sources]]` blocks.** A write-back edits those regions and
leaves every other byte, comments and blank-line layout included, where the
operator put it.

**One entry point covers both write-backs.** `writeConfigFile` in
`src/config-write.ts` is what the mapping write and the init's source write
call. `test/config-write-architecture.test.ts` refuses a third path that
writes the file its own way, so the two write-backs cannot grow into two
rules.

**The edit rules.**

- A mapping key the plane holds is written on the line that already names it,
  or appended inside the `[repos]` table. A key the file names and the plane
  does not is a line the operator wrote by hand since the load, and the plane
  leaves it. A comment the operator wrote beside a key the plane re-points
  stays on the rewritten line.
- A source the plane holds that no `[[sources]]` block names is appended as a
  new block after the last block the file holds. A block the file already
  names by source name stands byte-for-byte.
- Inside the two regions the plane's own copy is what stands, and the two
  regions answer an operator's mid-run edit differently. A `[repos]` key the
  plane holds is written from that copy, so an operator who re-points the key
  while the plane runs has the plane's value written back over theirs, with no
  line to say so. A `[[sources]]` block the plane holds is left byte-for-byte,
  so an operator who changes one leaves a file that no longer says what the
  plane holds: the check refuses the edit, and the rewrite is named. A deletion
  is undone the same way in both regions - the next write-back writes the key it
  holds again, and re-appends its own serialization of a source block it holds.
  `docs/configuration/index.md` states all four facts to the operator.
- A line the scan reads as standing inside a multiline string, and a line whose
  value runs past the end of its line - a multiline array, an inline table
  written across lines - are not lines the plane rewrites. The key such a line
  names counts as standing, so the plane never adds a second one beside it, and
  the verify step decides what follows: a value the plane does not need to change
  keeps the file in its edited form, and a value the plane must change falls back
  to the rewrite rather than corrupting the operator's prose. An inline table the
  operator wrote on one line is not such a line: it closes on its own line, so
  the plane rewrites it like any other key it holds and keeps the rest of the
  file.
- The plane never deletes a line it did not write. The one line it can drop is
  its own older writing: a top-level `sources = []` key, the form the plane's
  serializer used for an empty source list. A `[[sources]]` block cannot stand
  beside a key of that name - the file would not parse - so the edit drops the
  key and appends its blocks at the end of the file. `configToToml` no longer
  writes that key at all, so a file the plane wrote with no sources carries no
  `sources` key.
- A file whose lines end CRLF is edited the same way: every line the plane
  writes carries the file's own line ending.

**The edit is checked before it lands.** The patched text must parse, must
validate through the startup loader, and must carry every mapping and every
source the plane holds. A file the checker will not vouch for - a region the
scan cannot read, a source block with no name, an operator edit under the
plane that the section edit cannot carry - falls back to the full rewrite the
plane used before. The fallback is a named fact, not a silent one.

**The write is visible on the Message line.** `configWriteLine` words the
fact for both paths: the file the write landed on, and, for a full rewrite of
a file the operator already had, the plain statement that the comments in it
did not survive. A write that changes nothing writes nothing and says nothing.
An act that added nothing new to the file - the Repository init's re-init of a
repository whose sources already stand - hands the line no count to word, so it
says nothing for a write that edited nothing and words the full rewrite on its
own, without a count, when the checker refused the edit. No line ever reads
`registered 0 new sources`. Where the line is longer than the terminal, the
Message view on `F2` carries the whole fact. The desktop notification carries it
on the mapping path only: that fact rides a warning, and a warning fact is what
the plane sends to the desktop. The init's confirmation is a notice fact, and a
notice fact sends no notification (`src/components/message-facts.ts`).

**A write fact leads the line when it is the one the operator must read.** The
Message line is one row of the terminal's width, so what leads it is what reads,
and both write-backs answer that by the same rule. The mapping write-back answers
with a `ConfigWriteReport` (`src/config-write.ts`) that carries the mode the
write landed as, and one shared rule places that report in every report it
belongs to: `handoffReportLines` in `src/handoff.ts`, which
`reportHandoffOutcome` and the Consultation's own `finishOpening` both call, puts
a write that did not land, and a write that landed as a full `rewrite`, ahead of
the note the repository resolution bent with, and a write that landed as a
section edit behind it. A routine "saved the mapping" line never pushes the
sibling clone the plane made on the operator's disk off the visible row, and the
line that says the operator's whole file was replaced never trails it. The
Repository init's own confirmation is longer than the row, and
`writeFactWithConfirmation` places its write fact the same way: the section edit
trails the confirmation, the `rewrite` leads it.

**Only a file that is not there is a file to create.** A read that fails for
another reason - no permission, a directory where the file stands - is not
"nothing of the operator's stands here to lose", and the write reports it to
the caller instead of landing a fresh file over it.

**The file mode follows the config the file carries, and never widens the
lock the file carries.** The write asks for the mode the text it lands decides:
an owner-only file where a literal token stands in it, the ordinary mode
otherwise. The mode is read from the patched text, not from the caller's
in-memory config, so a literal token the operator wrote into the file while the
plane ran lands 0600 even when the plane's own copy holds no token. And the
write grants no permission the standing file does not already carry: it takes
the intersection of the two masks, so a config file the operator locked to 0600
stays 0600 through a write whose own text would have asked for the ordinary
mode. The plane cannot see why an operator locked the file, so it keeps the
lock; `writeMigrationFiles` keeps the same rule for a migration's writes.

**The load-time migration is outside this decision.** A config file from an
older install still migrates whole at load, with its backup and its report
beside the file. That act changes the file's schema, not one table of it.

## Consequences

- The operator's comments survive a repository init and a mapping write. On
  the development config the same edit that once dropped 13 comment lines now
  keeps all 26 of them: a mapping write adds 1 line to the file (546 lines to
  547) and a source append adds 6 (546 to 552), and every other line stands
  where the operator wrote it.
- `persistConfig` is gone. `writeConfigText` stays as the atomic disk step
  under `writeConfigFile`, and no surface reaches past the module for it.
- A repository init that registers no new source leaves the operator's file
  untouched, timestamp included, and its confirmation carries no write fact. A
  re-init whose sources already stand registers nothing, and its Message line
  names the commit, the labels, and the feeds it skipped. Before this decision it
  rewrote the file and said nothing about it.
- The plane appends one blank line between the operator's last line and what it
  appends, the same separator it writes inside a region it already holds, and the
  same separator between the two regions it writes at the end of a file that
  holds neither of them. A file whose own last line is blank carries that
  separator already, so the plane adds no second blank line.
- A config file the operator locked to 0600 keeps that lock through a write-back
  and through a migration. A file the plane creates takes the mode its own text
  asks for.
- The Message line names the config file on both write-backs. The init's
  confirmation carries the fact beside the commit and the labels.
- `test/config-write.test.ts` holds the edit and the fallback,
  `test/config-write-architecture.test.ts` holds the one-rule claim, and the
  init walk in `test/repo-init-stub.test.ts` and the sibling-clone walk in
  `test/handoff-frame.test.ts` read the file and the Message line through the
  real screens.
- The section scan tracks the multiline strings a config carries, so a line of
  a task type's prompt that reads like a table header cannot move an edit. A
  scan that got it wrong still has to pass the verify step, so the worst a
  wrong scan can do is send the write back to the full rewrite.
- An operator's mid-run edit of a line the plane owns is not a fact the plane
  reports. Re-point a mapping key and the plane writes its own value; delete a
  mapping key or a source block and the plane writes its own line again. The
  operator page states this, and no Message line does.
