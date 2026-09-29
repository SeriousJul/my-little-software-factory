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
	tickets in auto-handoff mode.
- `src/state.ts`: SQLite migrations, source reconciliation, work cycles,
	completion traces, completion decisions, handoff attempts, the Auto-handoff
	mode, and the process lease.
- `src/workflow.ts`: the workflow machine's transition (ADR 0027). A completed
	turn fires the task type's transition once: the plane writes the label facts
	on the ticket and its fixing pull request, and the machine converges every
	surface to the transition's facts.
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
	Groups (ADR 0058).
- `src/handoff.ts`: the handoff. Resolves the repository, runs the pinned
	command sequence through herdr, starts the agent, and sends the prompt.
- `src/consultation.ts`: the Consultation rules that need no terminal. The input
	and snapshot bounds, the per-Repository operation queue, the live checkout
	safety check, the Replacement context bounds, the Agent interaction key
	translation and its ordered input queue, and the Stale Agent output warning.
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
- `packages/mlsf/bin.mjs`: the short-name alias launcher. It reads the main
	package's own bin and re-execs it under Node with the operator's arguments, so
	`npx mlsf` and `npx my-little-software-factory` are one command. It adds no
	decision of its own; what it owns is how the run ends - the child's exit code
	forwarded, and a child the signal killed ending the launcher by that signal
	like the shipped bin. `test/alias-launcher.test.ts` pins it under Node.
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
	the release build's, `test/release-workflow.test.ts` the workflow's side of
	the asset names and the version smokes, and `test/alias-launcher.test.ts` the
	alias launcher's.
	The seam is the rendered terminal frame and the recorded command sequence.
	No test touches a real herdr session or a real git repository.
