---
title: Shape
description: The module map of the source tree, for agents working in this repository.
---

# Shape

- `src/factory.ts`: the entry module. Wires the startup: checks the Bun
	version, answers `--version` before anything boots, runs the startup
	decisions, prints the lines the result carries, and either exits or boots
	the renderer and mounts the app. Once the renderer exists it wires the
	shutdown the startup module decides.
- `src/version.ts`: the version the plane reports. A compiled binary carries
	the value the release build stamped with `--define`; a source run reads
	the repository's package.json (ADR 0056).
- `src/shipped-default.ts`: the one read of the shipped Default configuration.
	It imports the file, so a compiled binary reads the copy the build
	embedded and a source run reads the repository file, and the seed stays
	verbatim either way (ADR 0056).
- `src/startup.ts`: the startup decisions. Parses the arguments, loads and
	validates the config at the path that decision settled, checks the
	config's model values against what the agent runtimes report, and opens
	the state. A startup failure is a value
	(the operator-facing lines and the exit status), so a test reads it
	without a process. It also owns the shutdown install: which process endings
	close the state and give the lease back.
- `src/runtime.ts`: the Bun version gate, re-exported from
	`src/runtime-support.mjs`, the plain-JS helper the bin wrapper can load on
	the runtimes it refuses.
- `src/config.ts`: config types, strict startup validation, state path
	resolution, and atomic TOML write-back.
- `src/config-migration.ts`: the one-shot config migration to the workflow
	machine (ADR 0027). A pre-machine config is rewritten at load: rules become
	states, expressible edges become transitions, and the file is backed up and
	reported before the rewrite; load stops with the file unchanged on any
	failure.
- `src/ticket-source.ts`: the ticket-source seam and built-in GitHub Issues
	and Pull Requests adapters.
- `src/security-source.ts`: the built-in GitHub security ticket sources
	(issue #73). The three kinds - security advisories, Dependabot alerts, and
	secret scanning - read the repository security feeds as `gh api` REST calls,
	one call set per configured repository.
- `src/refresh.ts`: independent source refresh scheduling.
- `src/observation.ts`: the herdr observation loop. Polls the agent list,
	reads the settled agent's last message, marks blocked and missing agents,
	reclaims an agent that outlived its work cycle, settles turns into
	`awaiting`, applies the automatic completion rule, and dispatches open
	tickets in auto-handoff mode. The auto top-up's gate rules live in
	`src/domain/top-up.ts`; the loop keeps the walk and the reads, asks each rule
	in the order the waits are stated, and takes a fact it cannot read off the row
	it holds as one batched read for the list it walks (issue #202 review).
- `src/state.ts`: the open seam of the state module (issue #202). It opens the
	SQLite file, composes the nine aggregates into the graph, and closes the
	file. It holds no rule of its own.
- `src/state/`: one module per aggregate, each with its own interface - its
	facts and its operations. `consultation-record.ts`, `grouping.ts`,
	`handoff.ts`, `lease.ts`, `plane-action.ts`, `repository-init.ts`,
	`source-fact.ts`, `ticket-work-cycle.ts`, and `work-queue.ts`. A caller
	reaches a fact or an operation only through the aggregate that owns it, and
	an aggregate reaches only the tables it owns; the boundary check in
	`test/state-architecture.test.ts` holds both rules. `tables.ts` names the
	owner of every table the file holds. `store.ts` owns the path, the connection,
	the clock, and the transaction, and hands each aggregate a scoped handle that
	refuses a statement naming a table its aggregate does not own; the handle is
	`private` on the module class, so no caller reaches another aggregate's handle,
	and the refusal reads the shape-changing statements too - `ALTER TABLE`, `DROP
	TABLE`, `CREATE TABLE`, and `CREATE INDEX ... ON <table>` name their table
	(ADR 0095); `schema.ts`
	owns the migration chain; `json.ts` holds the shared decode primitives;
	`graph.ts` composes the nine modules and lets them call each other through
	their interfaces; `batch.ts` chunks an identity list so a fact the observation
	loop reads for the whole list costs one statement per chunk, not one per row.
	The module's own plumbing - `store.ts`, `graph.ts`, `tables.ts`, `schema.ts`,
	`batch.ts`, `json.ts` - is importable only inside `src/state/`, and the check
	refuses a caller that imports it. A table's row shape stays inside the module
	that owns the table: no aggregate exports a `*Row` type, and the check refuses a
	caller that imports one. The file holds one write transaction at a
	time: the aggregate that owns an atomic fact opens it and calls the other
	aggregates inside it, and an operation the far side of a cross-aggregate call
	reaches never opens one; the check names a far-side method whose body it cannot
	read, so it cannot shrink to reading nothing and still pass.
- `src/workflow.ts`: the workflow machine's transition (ADR 0027). A completed
	turn fires the task type's transition once: the plane writes the label facts
	on the ticket and its fixing pull request, and the machine converges every
	surface to the transition's facts. The module also owns the Next step (ADR
	0092): the one derivation of the step a settled turn's Transition names, the
	gate that holds it, and the words that state that gate.
- `src/plane-action-registry.ts`: the plane action registry (ADR 0068): the one
	home of the names a task type in the action form may name, the settings those
	names take, and the read that answers whether a task type carries the action
	form at all. `src/plane-actions.ts` holds the run: the merge through the
	command runner and the fact it writes on the attempt's record. The registry is
	its own module because the config validation, the dispatch, the surfaces, and
	the workflow machine all read the names and none of them needs the run.
- `src/task-selection.ts`: ordered task-rule selection.
- `src/setting-resolution.ts`: the handoff setting chains (ADR 0009). The Task
	profile of each task type, and the agent, model, and thinking one handoff
	resolves to before an operator override replaces it.
- `src/setting-fit.ts`: the Setting fit module. It owns the static setting
	rule, the Model list check, and the one sentence for each unfit cause. Every
	startup, panel, Handoff, and Consultation path reads it.
- `src/model-settings.ts`: the Model list startup orchestration (ADR 0010).
	It checks determinate config values with one list query per Agent kind and
	warns when a list is unavailable.
- `src/herdr.ts`: the agent facts herdr reports, shared by every reader of an
	agent list: the observation loop, the Consultation operations, the app's
	mode line, and the Parallel limit seat count.
- `src/parallel.ts`: the shared Parallel limit seat count (ADR 0034), the one
	source the Work queue's pickup and the mode line read.
- `src/placement.ts`: the ticket placement on the chosen task's state
	(ADR 0045). A manual handoff whose final task type differs from the
	ticket's current suggestion writes the ticket's labels before the agent
	starts.
- `src/theme-source.ts`: the startup theme resolution the application runs
	(ADR 0024). The pure rules live in the shared theme module; this module owns
	the one place the resolution touches the machine: the in-herdr fact, the
	herdr config read, and the `NO_COLOR` presentation.
- `src/turn-log.ts`: the turn log and the turn end cause, read from the
	agent's session record (ADR 0008), not from the terminal.
- `src/domain/`: the Ticket type and its state machine, the agent-side facts
	every Agent type shares (the standard Thinking level set), the handoff
	environment kinds, and the Grouping axis that splits a section's list into
	Groups (ADR 0058). `ticket.ts` holds the gate rules the plane states in words:
	the Dispatch pause, the Same-type hold (ADR 0093), and the Handoff limit
	(`handoffLimitReached`). `top-up.ts` holds the auto top-up's gates (ADR 0051,
	ADR 0088, ADR 0094): the gates every automatic add reads, the row a
	continuation must not jump, the fresh-work cycle gate, the restart candidate,
	and the open ticket's row gate and its waits.
- `src/handoff.ts`: the handoff. One start module (`startHandoff`) every start
	path calls (issue #204): it runs the pre-flight in one order, resolves the
	repository, builds the environment the choice names through herdr, starts the
	agent, sends the prompt, and removes what the start created when the agent
	never starts. The Ticket caller and the Consultation caller state their facts
	and hand one request to it.
- `src/consultation/`: the Consultation rules that need no terminal, one module
	per concept (issue #203, ADR 0096). `response-draft.ts` owns the input limit,
	the emptiness rule, the size reason, the literal-text rule, and the bounded
	text rule a Replacement Consultation's recovery context is built with; the
	launcher, the Response editor, the Send action, and the Consultation record
	aggregate's recovery read all ask it, and none of them keeps a copy. The
	shared field's paste path is not one of its callers: it strips terminal
	sequences with `stripAnsiSequences` from `@opentui/core`, and ADR 0014 keeps
	that path in the shared control library (ADR 0096). `agent-input.ts` owns the
	Agent interaction key translation and its ordered input queue with its text
	batching bound.
	`checkout-safety.ts` owns the Repository catalog, the explicit mapping check,
	and the Live checkout conflict set. `warning-facts.ts` owns the Stale Agent
	output warning in both spellings and the warning a failed or aborted turn
	leaves. Each module's interface holds only its concept's rules.
- `src/text-bounds.ts`: the UTF-8 byte measure and the two cuts that hold a text
	to a byte bound. The Response draft rules and the Consultation record
	aggregate's snapshot bound both read them instead of each keeping a copy
	(issue #203 review).
- `src/operation-serializer.ts`: the per-Repository lock. Work on one Repository
	is serialized and work on another never waits behind it. It is a concurrency
	control, not a Consultation rule, so it stands outside `src/consultation/`.
- `src/consultation-operations.ts`: the Consultation lifecycle. Launch, recovery,
	response, close, Force-close, Replacement, deletion, the Stale Agent output
	fact, and the Agent input queue, behind one interface with its dependencies
	injected. The App renders the Consultation screens and forwards the
	operator's actions here; the tests drive the lifecycle through this seam,
	with a fake command runner and a real state file.
- `src/handoff-dispatch.ts`: the Handoff dispatch module (ADR 0012). The one
	seat a handoff or a herdr environment change holds, the handoff queue and
	its claim order, the durable claim and settle of every origin, the Close
	cleanup with the leftover fact it leaves, and the name fact of a leftover
	agent. It reports through plain callbacks,
	so a test drives it with the fake runner and an in-memory state, and the
	App and the observation loop cross the same interface.
- `src/repo.ts`: the repository resolution and the sibling clone.
- `src/naming.ts`: the branch names and the herdr agent names.
- `src/runner.ts`: the single egress for commands.
	Every external command goes through one `CommandRunner`, and the tests
	inject a fake that records the calls. The runner also answers the Model list
	query (ADR 0010): it maps an agent kind to the command that prints its list
	and the reader of the table that command prints, and it never throws.
- `src/binary-install.mjs`: the prebuilt binary's installer, in plain
	JavaScript because the published package runs it on Node (ADR 0056). The
	target the machine resolves to, the asset and checksum names, the
	target-keyed cache path under the data home (an empty or relative data home
	is no data home), the install note beside the binary, the download and its
	SHA-256 check, the two download bounds, the cold `--version` answer, and the
	whole run (`runInstaller`) live here, with the machine's facts, the fetch,
	the operator's terminal, and the child process taken as injected values.
	`test/installer.test.ts` pins them.
- `bin/factory-bin.mjs`: the published bin and nothing else - the machine's
	real facts, the entry guard that recognizes the path npm's bin shim was
	started through (both sides realpath'ed), the operator's terminal for the
	download note, and the process exits the run outcome asks for.
- `scripts/build-binary.ts`: the release build. `bun run build <target> --out
	<dir>` compiles one prebuilt binary with `bun build --compile`, checks that
	the tree holds exactly the OpenTUI native cores that target needs and adds the
	missing ones first - the step that makes them resolvable to the bundler,
	which is why a Linux artifact carries both libc variants and a build that
	found a foreign core would ship a different artifact under the release's name -
	stamps the package version into the binary, and names the asset through the
	shared `assetFileName` the installer reads.
- `scripts/generate-screenshots.ts`: the operation screenshot capture.
	`npm run screenshots` builds the fixture world - a config, a seeded state
	file, and stub executables for the world's external commands - runs the
	real control plane on a pseudo-terminal through the six screens the guides
	show, and writes the PNGs into `docs/operation/images/`. The drift test in
	the suite reruns it into a temporary tree and rejects any committed PNG that
	no longer matches the screen.
- `scripts/screenshot-fixture.ts`: the shared fixture world both the doc
	screenshots and the home page hero run on: the config, the seeded state,
	and the stub executables.
- `scripts/generate-herdr-hero.ts`: the home page hero's capture. It drives
	an isolated herdr - a fresh server in a temporary directory with its own
	socket and home - and renders the workspace with the same ANSI renderer as
	the doc screenshots. Refreshed by hand; it is outside the drift test.
- `scripts/generate-screen-font.ts` and `scripts/screen-font.ts`: the per-cell
	coverage bitmaps the screenshot renderer paints from, rasterized from the
	vendored terminal font by `npm run font`.
- `test/sample-tickets.ts`: deterministic data used by legacy frame tests only.
- `src/components/`: the app shell, the ticket list pane, the ticket detail
	pane, the native ticket detail viewport, the override panel, the decision
	and missing modals, the turn log and markdown rendering, the shared
	Action bar and control catalogue, the Key guide and Message view, the
	shared pane geometry, the shared palette, message facts, and
	display-width-aware text helpers.
- `src/components/ticket-close.ts`: the Ticket Close dialog's facts. The shell
	renders them and the gallery shows them, so the confirmation an operator
	reads and the example a review reads are one definition (ADR 0031).
- `test/`: the test suite. `test/installer.test.ts` holds the installer's
	decisions and the shipped bin's runs under Node, `test/build-binary.test.ts`
	the release build's, and `test/release-workflow.test.ts` the workflow's side
	of the asset names and the version smokes.
	The seam is the rendered terminal frame and the recorded command sequence.
	No test touches a real herdr session or a real git repository.
