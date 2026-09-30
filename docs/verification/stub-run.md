# The Stub run verification

Status: the automated checks pass. The unit layer measures the world's
answers to the plane's own command shapes, the closed surface, the merge
semantics, the auto score rule, the world CLI, the stub runner wrapper, the
seeded configuration, and the startup argument. The human walk - the real TUI
over the real herdr with real agents, from the ready-for-agent issue through
the gated merge across the two repositories - has not been run, so it stands
as incomplete, not as a pass.

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it
is not silently dropped.

See [ADR 0073](../adr/0073-the-stub-run-serves-github-from-the-command-runner-seam.md)
for the decision, [issue #178](https://github.com/SeriousJul/my-little-software-factory/issues/178)
for the requirement, and [the seed script](../../scripts/stub-seed.ts) for the
repeatable walk's entry.

## What it was measured on

| Piece | Value |
| --- | --- |
| Runtime, host and test children both | Bun 1.4.2 (Linux x64) |
| Test layer | `bun test` on the unit layer: isolated temp directories, the real production modules (ticket sources, security sources, the merge action, the label writes, the config loader) driven through the stub runner over a world file, and a fake runner standing for the real binaries the stub passes through |
| World file | the seed document of [src/stub/seed.ts](../../src/stub/seed.ts), two repositories (alpha and beta) with their scenario issues, their linked draft pull requests, their merge gate facts, and one security feed item of each kind |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The sources fetch from the world | `test/stub-world.test.ts` ("the sources read the world"): the issue and pull request sources and the three security sources fetch through the real source modules over a stub-backed runner, and the draft pull requests list none, so the scenario issues stand uncovered | Passed |
| An undrafted pull request enters the list with its head branch and closing references | the same file, after a world mutation: the fetch lists one pull request with the head branch and draft attributes the projection reads | Passed |
| The run sees the world file's edits between turns | the same file ("the run reads the world file on every command"): the gate flip the world CLI makes stands for the run's next merge answer, a hand edit of the file stands for the run's next search, and a label write after a CLI edit keeps the edit in the file | Passed |
| The auto score posts once, on the first comment read of a verdictless pull request | "the verdict read and the auto score": the first read posts the configured score, the second read adds none, the world-level and per-pull-request overrides both ways post nothing or post as set, and a manual verdict stands over the rule | Passed |
| The label writes land on the world and persist | "the label writes": the issue and pull request edits add and remove labels, a number that names no item fails with the resolve error and no refusal, and an unknown shape is refused and recorded | Passed |
| The merge runs the GitHub semantics | "the merge": the failing gate refuses with the gate's reason, a clean merge closes the linked issues and persists both facts, the merged record read answers merged, a re-merge is refused, and the blocked comment posts on the pull request | Passed |
| The plane action's merge run runs the real code path | "the plane action's merge run": `runMergePullRequest` over the world settles blocked with the gate's reason and the blocked comment, then merged with the fresh read's idempotency fact, on a real Ticket from a real source config | Passed |
| The closed surface stays closed | "the closed surface": every command shape the suite issues - the five source fetches, the comments and reviews reads, the pull request record reads, the issue and pull request edits, the merge, the blocked comment, and the auth token - meets no refusal, and no command but `gh` reaches the real runner; a drifted search document, an unknown qualifier, and an unknown command are refused and recorded | Passed |
| The world CLI edits the file between turns | "the world cli": add issue, add pull request, undraft a pull request, set labels, add a comment on a pull request and an issue, set the merge gate, set the auto score world-level and on the per-pull-request `owner/name:N` target, reset to the seed, and each failure line (unknown verb, missing file, a number collision, a bad auto score target, a pull request that names no draft) | Passed |
| The seed script recreates the run | run once in a throwaway directory: it wipes the target, creates the two local checkouts as git repositories with a first commit and no origin, and writes the world file and the configuration. The world CLI then edits and resets the written file | Passed |
| The stub configuration loads with no auth | "the stub configuration": `loadConfigFile` takes the rendered config; its five sources name no auth, both repositories point at the seeded checkouts, the separate state and log files stand, the workflow machine and its task types resolve, and the merge action names the registry's method | Passed |
| The startup wiring takes the world flag | `test/startup.test.ts`: `--config` and `--world` parse together or alone, a missing value or a repeated flag is the usage line, and the run decision carries the world path the boot loads | Passed |
| A hand-edited file with a bad item fails at load | "the world file": a bad issue field, a bad pull request field, a bad merge gate fact, and a bad security list each fail the load with a readable error, at the file, not later in an answer | Passed |

## The scenario walk (incomplete)

The acceptance layer is the human walk: the operator seeds the run, starts it
with the world flag, and plays the flow with a real agent under the real TUI.
It stands as a checklist, every item incomplete until it is run. The items are
the issue's user stories in walk order, and each names the fact the walk
measures.

| Step | The fact the walk measures | Status |
| --- | --- | --- |
| Seed | `bun run stub:seed` recreates the checkouts, the world file, and the configuration in the operator's state directory | Incomplete |
| Start | `bun src/factory.ts --config <stub>/config.toml --world <stub>/world.json` boots the real TUI; the note names the world file; the stub state and log files stand apart from the development ones | Incomplete |
| Ticket section | the seeded issues stand in the list with the multi-repository grouping and the per-repository group order; the draft pull requests cover none of them | Incomplete |
| Implement handoff | the operator confirms the handoff, a real worktree is cut on the local checkout, a real agent runs under the Live view, and the turn settles to awaiting with the Transition's label writes on the world | Incomplete |
| Review position | the world CLI's undraft verb sets the seed pull request's draft fact to false, the run's next search picks it up, and the undrafted linked pull request enters the list at the review position with the suggested review task; the review handoff runs with a real agent | Incomplete |
| Score Judgment | the world posts the configured score on the first comment read and the Judgment fires in one settle; with the rule off, the no-score settle and the re-fire route run through the Decision modal; a hand-added score comment walks the below-threshold branch to needs-work | Incomplete |
| Gated merge | the failing gate walks the blocked merge outcome, the blocked comment, and the return to needs-work; the gate flip made by the world CLI stands for the run's next merge answer and ends the rework loop in a clean merge that resolves the ready-to-ship position without an agent | Incomplete |
| Close | the merged pull request closes its linked issue; both tickets leave the list | Incomplete |
| Security states | the three feed items stand in their security states with their resolve task types, and the same-type hold stands | Incomplete |
| Parallel seats | two parallel agents run side by side; the Parallel limit, the Queue wait, and the top-up stand | Incomplete |
| Pauses | the Queue pause and the Dispatch pause hold the Work queue and refuse the dispatch | Incomplete |
| Consultation | the Consultation type runs with its trivial prompt; the Session view and the close verification run with a real agent | Incomplete |
| Missing and recovery | killing an agent in herdr meets the Missing modal; the restart and the abandon run; the Recovery panel recovers a Consultation whose agent was lost | Incomplete |
| Dirty close | the close of a handoff meets the dirty worktree path and takes the force close; the Leftover environment and the close verification run | Incomplete |
| Persistence | a plane write stands in the world file after the run exits; a restart finds the world where the walk left it | Incomplete |

## Not measured

| Check | Why it could not run | Recorded as |
| --- | --- | --- |
| The whole scenario walk, every row above | the walk drives the real TUI against the real herdr with real agents on the operator's desktop; the contributor instructions keep the automated suite at the unit layer with no desktop control | Incomplete, with the checklist above as the acceptance target |
| The screen-reader path of the surfaces the walk touches | not verified in this branch's scope | Incomplete |
