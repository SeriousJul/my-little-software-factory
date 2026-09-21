# Workflow machine verification

Status: the automated checks pass. The label write against a real GitHub host
is not verified, and neither is a re-run of the terminal walks on the shipped
machine.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [ADR 0027](../adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md)
for the machine, and [the label reference](../labels.md) for the labels it owns.

## What is verified automatically

These checks run in `npm test`. Every one drives a real SQLite state and a
fake command runner: no test reaches GitHub, a real herdr session, or a live
Agent.

| Requirement | Checked by | Result |
| --- | --- | --- |
| A ticket's position is the first matching state, a parking state suggests nothing, and no match takes the default task type | `test/task-selection.test.ts`, `test/observation.test.ts`, `test/app.test.ts` | Passed |
| The transition's judgments pick the branch, its facts and pins come from that branch, and a judgment that cannot be read fires nothing and says why | `test/workflow-transition.test.ts` | Passed |
| The review score is read from the settled turn's last message, and the threshold is the transition's own number | `test/workflow-transition.test.ts`, `test/config.test.ts` | Passed |
| A completed settle fires the transition through the command runner before the completion decision, in manual mode and in auto mode, and stores its outcome on the trace | `test/observation.test.ts`, `test/live-view.test.ts`, `test/state.test.ts` | Passed |
| The write converges each surface to the transition's facts, leaves a label outside the machine alone, is idempotent, and records a failed write as a fact that routes nothing | `test/workflow-transition.test.ts` | Passed |
| The fixing pull request is derived from source facts - the pull request that closes the ticket, or, in the same repository, the one whose head branch carries the ticket's factory branch prefix - the newest non-draft is what the machine acts on, and no pull request found is a visible fact with no retry | `test/workflow-transition.test.ts`, `test/auto-mode.test.ts` | Passed |
| A completed turn on a security item writes the transition's facts on the open pull request whose head branch carries the item's factory branch prefix, derives the position from them, and parses no pull request body | `test/workflow-transition.test.ts` | Passed |
| An `open` ticket with an open fixing pull request, a draft among them, leaves the ticket list and the section counts, whatever its source kind; the in-flight states stay listed whatever pull requests exist; a ticket whose fixing pull request closed unmerged re-enters on the next refresh | `test/fixing-pull-request.test.ts` | Passed |
| The auto-handoff's candidate set excludes a covered open ticket: its queued start is removed from the Work queue with the ticket's state left alone and a notice, and a start that meets it is refused as gone from the list | `test/handoff-dispatch.test.ts` | Passed |
| The pull request sources are pulled and settled before the fire judges them | `test/refresh.test.ts` | Passed |
| The default source list carries an open item before it holds any workflow label, so a fresh pull request can be labeled | `test/ticket-source.test.ts` | Passed |
| The decision modal states the written facts, the failed write, and the missing pull request above the rows that decide on them | `test/auto-mode.test.ts` | Passed |
| An auto-advance transition routes the derived position without the operator, in manual mode too, and every other completion closes in auto mode | `test/observation.test.ts`, `test/auto-mode.test.ts` | Passed |
| A pre-machine config is rewritten at load: rules become states, expressible edges become transitions, the shipped parking state and the seed transitions come over with the clean templates, and every dropped edge is named in the report | `test/config-migration.test.ts` | Passed |
| The migration backs the old file up, writes its report, keeps the file's mode, validates the rewrite before it writes, and stops the load with the file unchanged on any failure | `test/config-migration.test.ts` | Passed |
| After the migration the loader is strict: a pre-machine key is one readable config error that points at the backup | `test/config-migration.test.ts`, `test/config.test.ts` | Passed |
| The shipped Default configuration and the development config carry the machine, its transitions, and templates that name no workflow label | `test/config.test.ts`, `test/configuration-docs.test.ts` | Passed |

## What is not verified

| Requirement | How it would be measured | Result |
| --- | --- | --- |
| A real `gh issue edit` and `gh pr edit` land the labels on GitHub, with the account and scope the operator's `gh` holds | Run the plane against one real repository through one implement and one review cycle, and read the labels and the migration report afterwards | Incomplete |
| The score line the shipped review template asks for is what a real review agent's settled turn carries | Read the completion trace of a real review turn and confirm the score parses, and that a missing score parks the decision on the modal | Incomplete |
| A fresh pull request is in the list by the time the implement settle fires, on a real host with a real refresh | Time one real implement cycle: the fire's forced refresh must return the pull request the agent opened | Incomplete |
| The migrated config behaves on the operator's own machine, with their comments and custom task types gone through the report | Start an existing install after the upgrade and read the report and the start note | Incomplete |
