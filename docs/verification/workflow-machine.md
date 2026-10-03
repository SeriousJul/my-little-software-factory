# Workflow machine verification

Status: the automated checks pass. The label write against a real GitHub host
is not verified, and neither is a re-run of the terminal walks on the shipped
machine.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [ADR 0027](../adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md)
for the machine, and [the label reference](../development/labels.md) for the labels it owns.

## What is verified automatically

These checks run in `npm test`. Every one drives a real SQLite state and a
fake command runner: no test reaches GitHub, a real herdr session, or a live
Agent.

| Requirement | Checked by | Result |
| --- | --- | --- |
| A ticket's position is the first matching state, a parking state suggests nothing, and no match takes the default task type | `test/task-selection.test.ts`, `test/observation.test.ts`, `test/app.test.ts` | Passed |
| The transition's judgments pick the branch, its facts and pins come from that branch, and a judgment that cannot be read fires nothing and says why | `test/workflow-transition.test.ts` | Passed |
| The review score is read from the pull request's comments and its reviews, each timeline walked to its last page - the newest record that carries the template's fixed line, whatever markdown decoration that post wears around it, each read failing open on its own timeline - and the threshold is the transition's own number | `test/workflow-transition.test.ts`, `test/config.test.ts` | Passed |
| A completed settle fires the transition through the command runner before the completion decision, in manual mode and in auto mode, and stores its outcome on the trace | `test/observation.test.ts`, `test/live-view.test.ts`, `test/state.test.ts` | Passed |
| The write converges each surface to the transition's facts, leaves a label outside the machine alone, is idempotent, and records a failed write as a fact that routes nothing | `test/workflow-transition.test.ts` | Passed |
| The fired implement transition marks the draft the plane opened ready-for-review before the label write, a head with no commits ahead skips with the empty-pull-request reason and publishes nothing, a pull request opening task type reads its branch direct so a draft is not missed, and the re-fire sweep re-fires both the no-linked and the empty-pull-request skip with the same direct read (ADR 0076) | `test/workflow-transition.test.ts` | Passed |
| The fixing pull request is derived from source facts - the pull request that closes the ticket, or, in the same repository, the one whose head branch carries the ticket's factory branch prefix - the newest non-draft is what the machine acts on, and no pull request found is a visible fact with no retry | `test/workflow-transition.test.ts`, `test/auto-mode.test.ts` | Passed |
| A completed turn on a security item writes the transition's facts on the open pull request whose head branch carries the item's factory branch prefix, derives the position from them, and parses no pull request body | `test/workflow-transition.test.ts` | Passed |
| An `open` ticket with an open fixing pull request, a draft among them, leaves the ticket list and the section counts, whatever its source kind; the in-flight states stay listed whatever pull requests exist; a ticket whose fixing pull request closed unmerged re-enters on the next refresh | `test/fixing-pull-request.test.ts` | Passed |
| The auto-handoff's candidate set excludes a covered open ticket: its queued start is removed from the Work queue with the ticket's state left alone and a notice, and a start that meets it is refused as gone from the list | `test/handoff-dispatch.test.ts` | Passed |
| The pull request sources are pulled and settled before the fire judges them | `test/refresh.test.ts` | Passed |
| The default source list carries an open item before it holds any workflow label, so a fresh pull request can be labeled | `test/ticket-source.test.ts` | Passed |
| The decision modal states the written facts, the failed write, and the missing pull request above the rows that decide on them | `test/auto-mode.test.ts` | Passed |
| The Re-fire row stands on an outcome that fired no branch or failed its write, and a complete outcome shows none: the confirm refreshes the pull request sources, fires the turn's transition again, and swaps the re-fired outcome onto the trace only while it still records the outcome the operator acted on, the turn staying awaiting with no decision change (ADR 0054) | `test/auto-mode.test.ts`, `test/decision-modal.test.ts`, `test/state.test.ts` | Passed |
| A settled turn's Next step is derived once (ADR 0092): Auto-handoff mode routes it without the operator, the route enters the Work queue, a turn with no Next step closes its cycle, a step the Handoff limit holds degrades to close, and a step another gate holds rests in awaiting, stated on the Message line by the cycle that holds it in auto mode and on the Decision screen in manual mode. Manual mode runs no top-up, so every settled turn rests in awaiting for the operator. The in-manual-mode route this record first measured is retired (ADR 0051) | `test/observation.test.ts`, `test/auto-mode.test.ts` | Passed |
| The Next step derivation is measured at its own interface (ADR 0092): the three no-step cases (no fire, a failed label write, a landing on a parking state), each of the four gates on a real state row, the Handoff and Plane action channel choice, and the four gate lines both surfaces state. The automatic rule answers `hold` for a step a gate holds, so `route` names only a step the machine takes. The Decision screen states the Handoff limit line beside the row the operator's key still confirms. The parser names `operator-decides` for a config that still carries `no-auto-decision`, on the prompt form and on the action form | `test/next-step.test.ts`, `test/observation.test.ts`, `test/auto-mode.test.ts`, `test/config.test.ts` | Passed |
| A held Next step states itself where the mode that produces it has a reader (ADR 0092): the cycle reports the held step, the position it stands on when that is not the settled ticket, and the gate sentence on the Message line; one held turn reports once, cycle after cycle; a hold on the settled ticket's own position names one ticket; and manual mode reports no line, because the Decision screen is its surface | `test/observation.test.ts`, `test/auto-mode.test.ts` | Passed |
| The Same-type hold reads the ticket's newest turn (ADR 0093): the current cycle's settled turn when that cycle settled one, and the newest closed cycle otherwise. The open ticket's add is unchanged - its current cycle has settled no turn - measured by the hold still standing on a left-behind signal at both the derivation and the top-up's walks; a settled turn's Next step clears when the turn that just settled differs from the step, even with an older closed cycle of the step's own task type; a cycle that settled no turn still clears the hold; and the re-verify gate keeps its own closed-cycle read. The dev-run miss runs as one flow: a rework cycle the operator closed, a review whose `score-below-threshold` branch writes `needs-work`, and the top-up's continuation ask routing the rework with no keypress | `test/next-step.test.ts`, `test/state.test.ts`, `test/observation.test.ts`, `test/auto-handoff-chain.test.ts` | Passed - the unit layer only; the same pull request on a real host stays Incomplete below |
| The cross-ticket Handoff limit consequence (ADR 0092) runs to its end: the position at its limit holds the settled turn's step, the turn closes, the top-up re-dispatches the settled ticket as open work, each round spends one handoff of that ticket's own budget, and the loop ends at the settled ticket's own limit - the fresh walk holds it out, the queue stays empty across further cycles, and the ticket rests open owing its next start | `test/observation.test.ts` | Passed |
| The ADR 0092 acceptance chain runs as one flow (issue #208): an implement turn on an issue fires a transition whose facts are `pull-request-facts`, the write lands `ready-for-review` on the linked pull request, the derived review position stands on that pull request and the top-up routes it with no keypress, the review turn's `score-above-threshold` branch lands `ready-to-ship` on the same pull request, its Next step is the merge Plane action, and the enqueued item carries `automatic: true` and its attempt records `decision: "auto-merged"` with the merge command on the fake runner. The Agent start is the held hop: the seat count reads full, so the review item stands in the queue and the test settles its turn the way the loop's settle does | `test/auto-handoff-chain.test.ts` | Passed - the unit layer only; the same chain on a real host stays Incomplete below |
| A config that still carries the deleted `auto-advance` fails at load with the error that names what replaced it, on a transition and on a branch, and the one-shot migration does not take the key. The ticket asked for the parser's plain unknown-key error; ADR 0092 records the named error as a deliberate change to that acceptance. `deriveNextStep` takes the projection read the state makes (`ticketProjection`), never an array a caller builds, and a read that holds no row answers `position-offers-no-task` for every step; a settle whose label write failed states the failure on the Message line beside the settle that produced it | `test/config.test.ts`, `test/next-step.test.ts`, `test/observation.test.ts` | Passed |
| A pre-machine config is rewritten at load: rules become states, expressible edges become transitions, the shipped parking state and the seed transitions come over with the clean templates, and every dropped edge is named in the report | `test/config-migration.test.ts` | Passed |
| The migration backs the old file up, writes its report, keeps the file's mode, validates the rewrite before it writes, and stops the load with the file unchanged on any failure | `test/config-migration.test.ts` | Passed |
| After the migration the loader is strict: a pre-machine key is one readable config error that points at the backup | `test/config-migration.test.ts`, `test/config.test.ts` | Passed |
| The shipped Default configuration and the development config carry the machine, its transitions, and templates that name no workflow label | `test/config.test.ts`, `test/configuration-docs.test.ts` | Passed |
| The task type's action form: exactly one of a template and an action, the registry the one home of the names and methods, the profile keys refused on the action form, and the shipped Default's merge taking the action form | `test/plane-action-merge.test.ts`, `test/config.test.ts` | Passed |
| The merge's fresh read settles an already merged pull request, a refused merge blocks with the source's reason and its comment posts before the outcome stands, and the outcome fires the task type's transition on the attempt's record | `test/plane-action-merge.test.ts` | Passed |
| The merge start enters the Work queue from the Decision screen's confirm and the auto top-up's add, the queue pause holds the item standing, the route settles to open without a work cycle, and the Handoff limit counts the attempts beside the handoffs and holds the top-up's ask at the cap | `test/plane-action-merge.test.ts` | Passed |
| The pickup's walk runs the plane action's item when it reaches it, whatever the cap bounds: a full cap holds it only behind a seats-bound item the walk breaks at, the way it holds every item behind. The claim is the row's removal, taken before the run, so two pickups that read the queue together run the merge once and the attempt row stands once | `test/plane-action-merge.test.ts` | Passed |
| The pickup's drop of a plane action's item settles the waits it leaves: the item's ticket back to open without a work cycle, and the route's source it named open with its cycle counted once, the way the cancel settles the same row (ADR 0069) | `test/plane-action-merge.test.ts` | Passed |
| The decision's row names the action, its override key unavailable with the catalogue's reason, the outcome standing on the screen where the row stood, the Message line taking both outcomes without a bell, and the ticket detail showing the latest attempt | `test/plane-action-merge.test.ts` | Passed |
| The cancel of a plane action's row settles the row's ticket to open without a work cycle, and the route it named still ends the cycle with its decision word (ADR 0069) | `test/state.test.ts` | Passed - the pickup's drop of the same row settles the same waits, measured on `test/plane-action-merge.test.ts` |
| The migration moves the seeded merge template to the action form with a report line, and a customized merge template stays a prompt task type through it | `test/config-migration.test.ts`, `test/plane-action-merge.test.ts` | Passed |
| The plane action's ask from the top-up and the re-fired skip walk runs behind the walk's actionable, hold, and limit guards | `test/plane-action-merge.test.ts` | Passed - the limit hold measured on the top-up's ask; the guard standing is the walk's shared placement |

## The live development run walk (issue #148)

Tested version: commit `209af20` ("The live development config carries
the security machine, and the repository identity reads
case-insensitive"), run on the development machine through
`bun --watch src/factory.ts --config config/development.toml`, state file
`config/.factory-development.sqlite`, against the real GitHub host.
The process was restarted at 2026-09-22T14:12:50Z so that it ran this
commit: the previous process's file watcher no longer re-ran the process
on file changes, so the restart was manual (a SIGINT to the process,
then the same command in the plane's own pane). No test in this walk
reached a fake runner: every fact below was read from the live state
file or from GitHub.

The legacy pair: Dependabot alert #5 and pull request #97 in
SeriousJul/pi-extensions. The alert's completion trace recorded the skip
("no linked pull request was found for the ticket", decided
2026-09-21T18:42:08Z) before the fixing pull request derivation existed,
and pull request #97's head branch carries the alert's factory branch
prefix.

Observed, in order:

- The development config carries the three security states and the three
  `resolve-*` task types, and the plane started on it without a config
  error. The security items in the list offered their resolve task
  types: the walk read three `resolve-dependabot-alert` rows for the
  other pi-extensions alerts.
- On the first refresh after the restart, alert #5 left the ticket
  list: the open pull request #97 whose head branch carries the
  alert's factory branch prefix covered it (ADR 0042). The alert's
  membership stayed active and open in the state, withheld by the list
  rule only.
- The re-fire of the recorded skip wrote `ready-for-review` on pull
  request #97 through the pull request source's transition write,
  verified on GitHub (`gh pr view 97 --repo SeriousJul/pi-extensions
  --json labels`). The trace recorded the re-fired outcome in place of
  the skip: fired with no reason, the write added `ready-for-review`
  and removed nothing, the position derived as the pull request's own
  review position, and `refired` set.
- Pull request #97 ranked by inheritance from the alert through the
  branch link: the rank source read `inherited` from the alert. The
  rank it stood at was `low`, not `high`: the alert carries an operator
  priority override `low` set in the live state, which beats its
  `high` severity label and travels the link (ADR 0042). The criterion's
  `high` assumes the pull request ranked by its severity label. With the
  override in force, the pull request stood in the `low` band, behind
  the ranked tickets, not first in the ticket list, and offered
  `review` from its derived position.
  This walk is a dated record of the run, and the rule it measured is
  retired: the ticket priority, its rank inheritance, its operator
  override, and the ranked order are gone, and the Work queue's order is
  the only order (ADR 0050). The severity labels the walk names still
  stand as facts on the row; they order nothing. The branch link the walk
  reads still stands: the closing references remain the source fact the
  fixing-pull-request rule and the transition's linked-pull-request
  lookup read (ADR 0042, kept by ADR 0050).

Could not run:

- The criterion's rank `high` and "stands first in the ticket list" as
  written: the operator's `low` override on the alert stands in the
  live state, and clearing it is an operator action in the ticket
  detail. This walk did not take it; the rank inheritance mechanism
  itself was measured as above.

## The score read on the live development run (2026-09-24)

The operator's report was one ticket that sat in `awaiting` after its review
turn with no routing: "fix: repair the three SudokuGameV2 runtime bugs behind
the typecheck errors". Every fact here came from the live development state
file (`config/.factory-development.sqlite`) and from GitHub reads over `gh
api`; no test drove a fake runner to produce it. The walk names the line each
review posted, the reason each settle recorded, and the write each fire
attempted.

- The reported ticket is pull request #40 in `SeriousJul/seriousjul.github.io`.
  Its review turn's recorded outcome reads `fired` with `when:
  "score-above-threshold"` and with `writeFailure: "gh pr edit #40 failed:
  'ready-to-ship' not found"`. The score read took the posted verdict (the
  review of 2026-09-24T19:48:28Z, `**Score:** 90 / 100`) and the branch held:
  the routing stopped at the label write, because that repository holds no
  `ready-to-ship` label. The same shape stands on the earlier trace for pull
  request #37: `'ready-for-review' not found`. This is the missing label the
  label reference tells the operator to create, and the widened read changes
  nothing about it.
- The read's own misses are on this repository's pull request #157. Two review
  turns recorded the no-fire "the pull request carries no review score" while
  their reviews carried the verdict: the review of 2026-09-23T19:58:07Z posted
  `## Score: 83 / 100` and the review of 2026-09-23T22:07:40Z posted
  `# Score: 85 / 100`. The third review of the same pull request, the one of
  2026-09-23T23:19:31Z, posted `- **Score:** 95 / 100` and was routed. A
  survey of the verdicts posted on the three repositories the development
  machine works found the fixed line under a heading six times, and every one
  of them read as no score (ADR 0057).
- The widened read was measured against that survey: of the 108 posted lines
  that name a score, it takes 6 more verdicts than the line it replaced and
  drops none, and the prose lines the survey also holds (`The review score is
  91 of 100.`, `My score note stays at 74 / 100.`, the mutation-score counts
  in a review's table) still report nothing.
- The order GitHub answers in is measured on the live host, not assumed: the
  three reviews of pull request #157 and its three comments each came back
  oldest first, which is why the read now walks every page of its list.

## The score read on pi-extensions pull request #114 (2026-09-29)

The review turn on `SeriousJul/pi-extensions` pull request #114, "harden
edit and bash behavior for local models", posted its verdict under a
heading: `### 3. Score`, a blank line, then `**92 / 100** - spec-faithful,
well tested, verified green.`. The read took nothing, the settle recorded
the no-fire "the pull request carries no review score", and the ticket
rested in its awaiting state. The operator re-posted the verdict in the
template's fixed line, and the machine routed it on the re-fire. ADR 0063
widened the read to the two-line shape. Measured against the live records
of the pull request: the posted review now reads 92, and the prose guards
of the record above - `Score: 92 out of 100.`, `The review score is 91 of
100.`, `My score note stays at 74 / 100.`, and the mutation-score counts -
still report nothing.

## What is not verified

| Requirement | How it would be measured | Result |
| --- | --- | --- |
| A real `gh issue edit` and `gh pr edit` land the labels on GitHub, with the account and scope the operator's `gh` holds | Run the plane against one real repository through one implement and one review cycle, and read the labels and the migration report afterwards | Incomplete |
| The score line the shipped review template asks for is what a real review agent posts on the pull request, as a comment or a review, and the posted line parses | Run one real review cycle and confirm the posted line parses, and that a missing score parks the decision on the modal | Partially measured: the live run's posted verdicts (the record above) are what the read now parses; one real cycle on the widened read has not run |
| A fresh pull request is in the list by the time the implement settle fires, on a real host with a real refresh | Time one real implement cycle: the fire's forced refresh must return the pull request the agent opened | Incomplete |
| Auto-handoff mode runs the automatic merge its Next step derives (ADR 0092): a real review's own score squash-merges a real pull request with no keypress, and the review and rework loop runs unattended up to the Handoff limit | Run one real review cycle above the score threshold on one repository, and read the merge state, the Plane action record, and the Handoff count afterwards | Incomplete |
| The migrated config behaves on the operator's own machine, with their comments and custom task types gone through the report | Start an existing install after the upgrade and read the report and the start note | Incomplete |
