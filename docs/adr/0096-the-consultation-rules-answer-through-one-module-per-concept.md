# ADR 0096: The Consultation rules answer through one module per concept

**Status:** accepted
**Date:** 2026-10-04

## Context

`src/consultation.ts` was one 540-line module with 26 exports over six concepts
that share nothing: the Response draft's size and paste rules, the Agent
interaction key translation and its input queue, the Repository catalog and the
live checkout conflict set, the Consultation warning facts, the bounded text rule
a Replacement Consultation's recovery context is built with, and the
per-Repository operation lock. To read one rule a contributor read the whole
drawer, and its interface let any caller import any rule into any place.

The drawer already held rules with two owners:

- The bounded text rule stood twice. The copy the plane ran lived in the
  Consultation record aggregate, where it built the recovery text a Replacement
  Consultation carries; the exported and tested copy lived in the rules module
  and had no caller. The two already disagreed: the tested copy joined its
  sections with two newlines and took every turn, the running copy joined with
  one and skipped the opening turn. The rule test covered the copy the plane did
  not run.
- The input limit was named twice: once as `CONSULTATION_INPUT_LIMIT` in the
  rules module and once as the literal `64 * 1024` in the state module's
  `replacementInput`.
- The literal-text rule was written twice: in the rules module and again in the
  shared control library's paste path.
- Four exports had no caller at all: `unconfirmedOwnedResources`,
  `repositoryMatchesCheckout`, `CONSULTATION_SNAPSHOT_LIMIT`, and
  `boundedReplacementInput`, which only a test called.

Its test file mirrored the drawer: 976 lines, nine unrelated blocks, tests for
the Consultation record aggregate and the ANSI screen renderer - two modules that
live elsewhere - and a real state database opened to check a paste rule.

For the operator the cost was visible on one screen: the Response field states a
size reason, and the Send action refuses with the same rule read in a different
place. Where a rule has no single owner, the two places can state different facts
for one draft.

## Decision

**Each concept the Consultation rules name has one module and one narrow
interface, and the plane calls the rule through that interface.**

- **Four rule modules under `src/consultation/`, named for their concept.**
  `response-draft.ts` owns the input limit, the emptiness rule, the size reason,
  the literal-text rule, the paste sanitizing rule, and the bounded text rule.
  `agent-input.ts` owns the Agent interaction key translation, the ordered input
  queue, and its text batching bound. `checkout-safety.ts` owns the Repository
  catalog, the explicit mapping check, and the Live checkout conflict set.
  `warning-facts.ts` owns the Stale Agent output warning in both spellings and
  the warning a failed or aborted turn leaves.
- **The per-Repository lock leaves the Consultation rules.** It is a concurrency
  control and no Consultation rule reads it, so it stands at
  `src/operation-serializer.ts`. Keeping it inside the Consultation rules would
  let a reviewer read it as one.
- **Each interface holds only its concept's rules.** The Response draft interface
  takes the draft facts and answers the reason. The Agent input interface takes
  the key event and the exit key and answers the semantic event. The Checkout
  safety interface takes the config and the visible Tickets and answers the
  verified options; its conflict set takes the checkout, the records, and the
  Agent list. A paste rule cannot import a checkout rule.
- **The bounded text rule has one owner.** The Response draft module owns the
  join, the marker, and the bound. The Consultation record aggregate keeps the
  read of its own record and turns and calls the rule. The aggregate's copy is
  gone, so the recovery text the plane builds and the text a test asserts on come
  from the same place. The surviving rule is the one the plane ran: the opening
  turn needs no section of its own, because the original input already states it.
- **The input limit is named once.** The state module reads
  `CONSULTATION_INPUT_LIMIT` from the Response draft module instead of holding
  its own literal.
- **A rule shared by two paths is imported, not copied.** The Agent input module
  takes `isLiteralText` from the Response draft module. The shared control
  library keeps its own paste path untouched, as ADR 0014 puts it.
- **An export with no caller is removed.** `unconfirmedOwnedResources`,
  `repositoryMatchesCheckout`, and `CONSULTATION_SNAPSHOT_LIMIT` are gone with
  the second copy of the bounded text rule. A reviewer should be able to tell
  which rule the plane runs from the interface alone.
- **The split moves call sites, not rules.** No rule logic moved into a surface,
  and the shared control library gained none. The launcher, the Response editor,
  the app shell, and the Consultation operations read the rules through the new
  interfaces.
- **No behavior change and no wording change.** The operator sees the same field
  error, the same warning on the record, and the same conflict rows in the
  launcher. The frame tests that assert those facts are the check that the split
  changed nothing.

## Consequences

- A contributor reads one rule in one file. A change to a limit reaches every
  rule that reads it, because the limit has one name.
- A new Consultation rule goes into the module of its concept, or into a new
  module named for a new concept. Adding a rule to a drawer is no longer an
  option, because there is no drawer.
- A test file mirrors its module. `test/consultation/response-draft.test.ts`,
  `test/consultation/agent-input.test.ts`, `test/consultation/checkout-safety.test.ts`,
  `test/consultation/warning-facts.test.ts`, and `test/operation-serializer.test.ts`
  each hold one concept and assert it through that module's interface. The pure
  rule tests open no state database and run no real command; the Checkout safety
  module and the Agent input module use the fake command runner, the suite's
  second adapter at the CommandRunner seam.
- The tests that were in the wrong file moved to the file that tests the module:
  the ANSI screen renderer's tests to `test/ansi-screen.test.ts`, and the durable
  Consultation record tests to `test/state/consultationRecord.test.ts`, beside the
  other tests of that aggregate. `test/consultation.test.ts` is gone.
- The gallery shows the Response field in its over-limit state
  (`response-over-limit`), and `test/shared-gallery.test.ts` asserts that the
  field's size line and the Send action's refusal state one sentence, because the
  two now read one owner.
- The state module stays a caller of the rules, not an owner of them. A later
  change to a draft rule reaches the aggregate through the rule's interface; a
  change to a table does not.

## Considered alternatives

- **Keep one module and only move text into files.** Rejected: the interface
  would still answer all six concepts, so a caller could still import a checkout
  rule into a paste rule. The split's value is the interface, not the file count.
- **Put the four rule modules in `src/domain/`.** Rejected: `src/domain/` holds
  the Ticket facts every reader shares. These rules belong to the Consultation
  screens and the Consultation lifecycle, and none of them is a Ticket fact.
- **Move the draft validation into the shared control library.** Rejected: ADR
  0014 keeps editing, focus, labels, error presentation, and safe paste in the
  library and keeps domain validation, draft storage, and Agent operations with
  the screen. The Response draft module is the screen's domain validation.
- **Keep the per-Repository lock beside the rules it serializes.** Rejected: it
  is a concurrency control with no Consultation fact in it, and the issue names
  keeping it out as the point.
- **Keep the tested copy of the bounded text rule and make the state module call
  it.** Rejected as written: the tested copy was not the running copy, so adopting
  it would have changed the recovery text the operator sees. The split keeps the
  running rule and gives it the one owner.
