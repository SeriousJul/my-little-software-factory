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
| The failed Handoff start holds the branch and the draft it made (issue #296, ADR 0076 as amended): a start that settles `failed` after the Pull request open's push closes no draft, deletes no remote branch, and keeps the local branch it created, while its herdr environment still goes; a start that fails before the push still removes the local branch it created, and a raise after the push - in the open's own source read or in the prompt render - answers the way a tagged refusal does and carries the handover; the next Handoff of that Ticket takes the reuse path - the worktree is asked for by branch, herdr answers `worktree_not_found` because the checkout went and the branch stayed, the worktree is created on the standing branch with no create from the Worktree base, no second hold commit lands, and no `branch -D` runs - and the standing draft is read by its head branch and reused, so one Ticket wears at most one Fixing pull request across any number of failed starts; the retry's create meets the leftover worktree directory and the plane moves it aside (ADR 0062); a standing remote branch with no local copy is fetched and reused, never built again; a draft create that exhausts its retry window leaves the branch standing on both sides with no draft on it, and the next Handoff reuses the branch and opens the first draft on it, all of it measured on one stateful world that answers each start from the state the other left and holds the branch, remote branch, worktree, and draft facts; and the cycle end still closes a draft the Ticket wears and never a pull request the machine has published | `test/handoff.test.ts`, `test/pull-request.test.ts` | Passed - the unit layer only, on the fake command runner; no real remote and no herdr session ran, and the world's `worktree open` answer is read from herdr v0.9.1 rather than run |
| The fixing pull request is derived from source facts - the pull request that closes the ticket, or, in the same repository, the one whose head branch carries the ticket's factory branch prefix - the newest non-draft is what the machine acts on, and no pull request found is a visible fact with no retry | `test/workflow-transition.test.ts`, `test/auto-mode.test.ts` | Passed |
| A completed turn on a security item writes the transition's facts on the open pull request whose head branch carries the item's factory branch prefix, derives the position from them, and parses no pull request body | `test/workflow-transition.test.ts` | Passed |
| An `open` ticket with an open fixing pull request, a draft among them, leaves the ticket list and the section counts, whatever its source kind; the in-flight states stay listed whatever pull requests exist; a ticket whose fixing pull request closed unmerged re-enters on the next refresh | `test/fixing-pull-request.test.ts` | Passed |
| The standing draft a failed Pull request open leaves on the factory branch covers nothing: the default Pull request source policy fetches no unlabeled draft, so the covered rule has no row to read and the ticket keeps its place in the list for the next start; the one draft the policy does fetch, a `needs-work` draft, does cover (issue #296, ADR 0042, ADR 0076) | `test/stub-world.test.ts`, `test/fixing-pull-request.test.ts`, `test/ticket-source.test.ts` | Passed |
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
| The seat a settling turn frees goes to that turn's own next step (ADR 0094): the cycle asks the continuation before the Work queue's pickup, and the automatic route row enters ahead of the standing open-ticket or restart row. The fresh-work keeps the empty-queue gate, a cycle that asked a continuation asks no fresh work, and a continuation already standing holds the next one out. The dev-run miss runs as one flow at `max-parallel-agents = 1`: a running turn on one pull request, a standing open-ticket item on a second, the first turn settling and its seat being free, and the review that turn derives taking it while the open ticket's item waits. The row this record first measured - a manual row holds the continuation - is retired by ADR 0100 | `test/observation.test.ts`, `test/state.test.ts`, `test/auto-handoff-chain.test.ts` | Passed - the unit layer only; the same chain on a real host stays Incomplete below |
| The owed continuation outranks every standing queue row (ADR 0100): its row enters at the head, ahead of a row the operator staged as it is ahead of a fresh-work row, and a continuation already standing keeps its place at the head. The rank is the row's place in the queue's order, and the continuation already standing is a Workflow route row of either staging - the row the operator's own route decision left there included (issue #230). The queue's depth is no gate over the continuation, so a queue of fresh work alone lets the walk reach the one-item-per-ticket rule and its refusal line. The dev-run miss on PR #215 runs as one flow at `max-parallel-agents = 1`: a running rework on one pull request, the operator's staged row on a fresh ticket, the rework settling and its seat being free, and the review the rework derives taking the seat while the operator's row waits | `test/observation.test.ts`, `test/state/workQueue.test.ts`, `test/top-up.test.ts`, `test/auto-handoff-chain.test.ts` | Passed - the unit layer only; the same chain on a real host stays Incomplete below |
| Each hold the automatic walks take names itself in the plane's record (issue #223): Auto-handoff mode off, the queue pause, the Dispatch pause, a continuation already standing, a row the operator staged, and a row already in the queue each state their own line, once for as long as the fact stands and again when the fact changes, never once per poll - a cycle that asks a continuation runs no fresh-work walk (ADR 0051), and the row that walk waits behind keeps its silence across the skip, because the skip is not the row leaving (issue #223 review) - the held continuation names the staging of the row it waits behind, so an operator's row is never stated as a continuation, and names that row in parentheses, so the record answers which owed start the hold blocked and a later hold behind a different row states itself again; and the pace gate holds on a standing Workflow route row of either staging (issue #230); the queue's lines name the staging - `automatic` for the row a walk added, `operator-staged` for the row the operator's ask left; the one-item-per-ticket refusal reaches the file on both start channels beside the Message line it has always reached, once for the row that stands and again for a new row - the standing fact is the row the ticket names and not its enqueue time, and the record's entry is dropped when the row leaves the queue or a new row for that ticket lands, and swept by the pickup pass the cycle asks for on every poll, so an entry never outlives its row whatever aggregate's write took the row out - and every refusal line wears the one shape `refused: "<title>" (<fact>)`, which is also the shape a merge run already in flight refuses a re-ask with (ADR 0104) - once for the run that stands, the run's mark being the standing fact from its claim to its settle - and the refused claim states itself once for the fact that stands as the standing-row refusal does - the claim gates answer the same way every cycle the walks re-ask one position, so a refused claim states itself once and again when the fact moves, where the fact is its reason beside the attempt ledger it stood on, so a claim that settled outside the dispatch and a refusal behind a later claim read as the new fact they are even with no claim through the dispatch, and the two start channels keep their own fact - a settled turn's gated Next step reaches the file beside the Message line it has always reached, in the record's own naming and once for the standing hold on both outlets - and every line the suite reads back carries the level the configuration reference states for it, the hold lines, the mode lines, and the queue lines at `info` and every refusal, the session-only mode line, and the refused pause line at `warn`, and the configuration reference's line texts are held to the code that writes them; and the mode flip and the queue pause and resume each leave one line at the key under the `mode:` and `queue:` prefixes, a mode write the state file refused stating the session-only line instead, and a plane with no state file stating the same limit rather than a move no run will read back - read at the key with its level - and a queue pause the state file refuses leaving its `warn` line beside the mode's, the brake staying where it stood. The replayed miss on PR #215 reads end to end in the record: the staged row, the hold the fresh walk took, and the continuation the settled turn owed with the path that started it | `test/top-up.test.ts`, `test/queue-staging.test.ts`, `test/observation.test.ts`, `test/handoff-dispatch.test.ts`, `test/plane-action-merge.test.ts`, `test/auto-handoff-chain.test.ts`, `test/auto-mode.test.ts`, `test/work-queue-frame.test.ts`, `test/record-lines-doc.test.ts` | Passed - the unit layer only, on the `log` seam; no run's log file was read |
| A Handoff start that began and reached no Agent leaves its own line in the record (issue #295): `handoff start failed: "<title>" (<reason>)`, naming the Ticket and the reason its attempt's own row stores, read out of the settle's answer rather than a second copy of the reason; one line per attempt, never one per observation cycle - the cadence is walked at the observation seam, where the automatic ask enqueues the row, the cycle's pickup runs the start and herdr refuses it, the Attempt hold then holds the walk's re-ask across the cycles that follow, and the source's re-read lets the next attempt state itself again - and a second attempt at the same Ticket states itself again; the pre-start gate refusal keeps its `handoff refused:` line and the two prefixes never answer for one another; the Ticket's name is one shared rule the dispatch, the observation cycle, the App, and the boot all read, and a suite refuses a second copy of it; and the boot states the same line for the claim a previous run left unsettled (ADR 0041), so reading the record for one Ticket answers how many starts the factory made and why each one ended | `test/handoff-dispatch.test.ts`, `test/auto-handoff-chain.test.ts`, `test/state/handoff.test.ts`, `test/startup.test.ts`, `test/attempt-record.test.ts`, `test/record-name.test.ts`, `test/record-lines-doc.test.ts` | Passed - the unit layer only, on the `log` seam, except the boot line, which the suite reads back off the plane's own file logger |
| The failed Handoff start holds its automatic re-ask, and the Handoff limit counts every attempt (ADR 0077 as extended by ADR 0101, issue #217): the Ticket's newest Handoff attempt that settled `failed` holds the top-up's ask of that Ticket at the one ask step all four walks share, the ask returns only once every active source has re-read the Ticket after the attempt's outcome landed - one stale source out of several keeps the hold - a read landing at the attempt's own instant is the release, the wait is measured from the outcome's time and not the claim's, the held re-ask is silent on the Message line (one refusal line, not one per cycle), the loop's own order runs at the observation seam (the ask enqueues, the pickup's start fails, the next cycle's ask is held), an attempt still in flight holds nothing, a Ticket with no active source holds nothing, any failed start sets the hold and the operator's own handoff passes it at the dispatch seam and clears it with the start it reached, the count the limit reads follows the attempt ledger, the newest-attempt index reaches a v27 state file, and both start channels answer from the one shared rule over their own attempt tables and the one `hasUnrefreshedActiveMembershipSince` query | `test/attempt-hold.test.ts`, `test/observation.test.ts`, `test/state/handoff.test.ts`, `test/handoff-dispatch.test.ts` | Passed - the unit layer only; the development install re-run stays Incomplete below |
| The read the Attempt hold adds to the cycle is bounded (ADR 0101): the newest-attempt read stands behind `attempts_ticket_latest`, and the source half is the cycle-end gate's own query | Measured on the real schema with 20,001 `handoff_attempts` rows for one Ticket: 200 of the hold's reads cost 490 ms (2.45 ms each) with the index dropped, and 4.4 ms (0.022 ms each) with it; the `COUNT(*)` the Handoff limit reads costs 0.27 ms per Ticket at the same rows | Passed - measured on the real schema, not on the live run |
| The Failed-start park holds a Ticket whose Handoff starts keep failing, and the park states itself (issue #298, ADR 0106): the run is the Ticket's newest Handoff attempts read back until one settled otherwise or is still in flight, and its boundary is the claim order and not the claim's time - two claims stamped in one millisecond are told apart by which was claimed first, and an attempt still in flight ends the run; the park stands at half the Handoff limit and the limit is untouched - it still counts every attempt and still ends the work cycle above the park; the gate stands in the one ask step all four automatic walks share, holds the automatic adds only, and the operator's own handoff passes it at the dispatch seam and ends the run with the start it reached, with no second act; the fact states itself once for as long as it stands - the record names the hold in the walk-hold voice and names the Ticket the walk reached, and the Message line states the standing warning with the run's count, which the Desktop notification carries - and a cycle that reads the Ticket and finds the park gone retires the report, so the ignore, the source mute, and a start that reached its Agent each let the next run of failures state itself again; the row wears `failed starts` beside the `handoff limit` marker and the detail states the run beside the limit's count, both off the projection's one read; and the run's two partial indexes reach a v28 file, and a file that carries one of the two gains the other | `test/failed-start-park.test.ts`, `test/state/handoff.test.ts`, `test/observation.test.ts`, `test/top-up.test.ts`, `test/ticket-facts.test.ts`, `test/auto-mode.test.ts`, `test/handoff-dispatch.test.ts`, `test/desktop-notification.test.ts`, `test/record-lines-doc.test.ts` | Passed - the unit layer only, on the `log` and status seams and the app harness's fake runner; the screen-reader path for the new row marker and detail line is not verified - no assistive technology ran against either - and the terminal walks were not re-run by hand on the park's paint |
| The read the park adds to the cycle is bounded (issue #298, ADR 0106): the run is one statement per chunk of Tickets, joined into the read the projection already makes for the Handoff limit's count, and the automatic ask reads it for the one candidate it reached | Measured on the real schema with 201 Tickets, one of them carrying 9,363 attempts: the batched read over all 201 identities costs 2.6 ms with only `attempts_ticket_latest` behind it and 1.6 ms with the two v29 partial indexes (the median of 25 runs each); the `COUNT(*)` the Handoff limit reads costs 0.5 ms on the same file | Passed - measured on the real schema, not on the live run |
| A config that still carries the deleted `auto-advance` fails at load with the error that names what replaced it, on a transition and on a branch, and the one-shot migration does not take the key. The ticket asked for the parser's plain unknown-key error; ADR 0092 records the named error as a deliberate change to that acceptance. `deriveNextStep` takes the projection read the state makes (`ticketProjection`), never an array a caller builds, and a read that holds no row answers `position-offers-no-task` for every step; a settle whose label write failed states the failure on the Message line beside the settle that produced it | `test/config.test.ts`, `test/next-step.test.ts`, `test/observation.test.ts` | Passed |
| A pre-machine config is rewritten at load: rules become states, expressible edges become transitions, the shipped parking state and the seed transitions come over with the clean templates, and every dropped edge is named in the report | `test/config-migration.test.ts` | Passed |
| The migration backs the old file up, writes its report, keeps the file's mode, validates the rewrite before it writes, and stops the load with the file unchanged on any failure | `test/config-migration.test.ts` | Passed |
| After the migration the loader is strict: a pre-machine key is one readable config error that points at the backup | `test/config-migration.test.ts`, `test/config.test.ts` | Passed |
| The shipped Default configuration and the development config carry the machine, its transitions, and templates that name no workflow label | `test/config.test.ts`, `test/configuration-docs.test.ts` | Passed |
| The task type's action form: exactly one of a template and an action, the registry the one home of the names and methods, the profile keys refused on the action form, and the shipped Default's merge taking the action form | `test/plane-action-merge.test.ts`, `test/config.test.ts` | Passed |
| The merge's fresh read settles an already merged pull request, a refused merge blocks with the source's reason and its comment posts before the outcome stands, and the outcome fires the task type's transition on the attempt's record | `test/plane-action-merge.test.ts` | Passed |
| The merge start enters the Work queue from the Decision screen's confirm and the auto top-up's add, the queue pause holds the item standing, the route settles to open without a work cycle, and the Handoff limit counts the attempts beside the handoffs and holds the top-up's ask at the cap | `test/plane-action-merge.test.ts` | Passed |
| Every workflow-origin merge ask closes the settled turn's environment at the ask, the confirm's and the auto top-up's alike, and the close is the ask's whole act on the environment: the worktree workspace goes with `herdr workspace close`, the live-worktree tab with `herdr tab close`, no other herdr command stands, and a dropped item still had its close (ADR 0046, ADR 0099) | `test/plane-action-merge.test.ts` | Passed - the unit layer only; no herdr session ran, and the herdr commands are read from the fake runner |
| The pickup's walk runs the plane action's item when it reaches it, whatever the cap bounds: a full cap holds it only behind a seats-bound item the walk breaks at, the way it holds every item behind. The claim is the row's removal, taken before the run, so two pickups that read the queue together run the merge once and the attempt row stands once | `test/plane-action-merge.test.ts` | Passed |
| The claim also takes the run's mark, held until the run settles, and the plane action's ask reads it: an ask for a Ticket whose merge is already running is refused before the enqueue, and the merge command and the attempt row each stand once. The Work queue row is gone at that point, so the queue's one-item rule cannot reach this, and the run's fresh read cannot either, because the source still answers the pull request open while the merge lands (ADR 0104) | `test/plane-action-merge.test.ts` | Passed - the unit layer only; the live double ask on PR #224 was read from the development log and the state file, and the walk below has not been re-run on the mark |
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
| The failed Handoff start's hold on the live development run (issue #217): one failing Ticket's `handoff_attempts` count stays flat between source refreshes, and its Handoff limit count reaches the cap the attempts it made | Restart the development install against one Ticket whose start keeps failing, and read its attempt count and the Message line over several refresh intervals | Incomplete - no development run was restarted; this change was measured at the unit layer only |
| The record lines this change adds (issue #223) reach the log file a running plane writes, and a reviewer reading that file can tell a held run from a broken one | Start the development install with a `[logging]` table at `level = "info"`, hold the automatic walks at each gate in turn, and read `factory.log` | Incomplete - every line here was measured on the `log` seam in the suite; no log file on a running plane was read |
| The `handoff start failed:` line (issue #295) reaches the log file a running plane writes, and a reviewer reading that file can count a Ticket's starts and their endings | Start the development install with a `[logging]` table at `level = "info"` - the `handoff started:` lines the endings stand beside are `info`, so `warn` would hold the endings and none of the starts - let one Handoff start fail, and read `factory.log` | Incomplete - the dispatch's line was measured on the `log` seam in the suite; the boot's line was measured on the plane's own file logger at a real state file; no running plane's log file was read |
| The migrated config behaves on the operator's own machine, with their comments and custom task types gone through the report | Start an existing install after the upgrade and read the report and the start note | Incomplete |
