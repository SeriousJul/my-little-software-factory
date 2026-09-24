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
- `src/ticket-source.ts`: the ticket-source seam and built-in GitHub Issues
	and Pull Requests adapters.
- `src/refresh.ts`: independent source refresh scheduling.
- `src/observation.ts`: the herdr observation loop. Polls the agent list,
	reads the settled agent's last message, marks blocked and missing agents,
	reclaims an agent that outlived its work cycle, settles turns into
	`awaiting`, applies the automatic completion rule, and dispatches open
	tickets in auto-handoff mode.
- `src/state.ts`: SQLite migrations, source reconciliation, work cycles,
	completion traces, completion decisions, handoff attempts, the Auto-handoff
	mode, and the process lease.
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
- `src/domain/`: the Ticket type and its state machine, the agent-side facts
	every Agent type shares (the standard Thinking level set), and the handoff
	environment kinds.
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
- `scripts/build-binary.ts`: the release build. `bun run build <target> --out
	<dir>` compiles one prebuilt binary with `bun build --compile`, installs the
	target's OpenTUI native cores first - the step that makes them resolvable to
	the bundler, which is why a Linux artifact carries both libc variants -
	stamps the package version into the binary, and names the asset through the
	shared `assetFileName` the installer reads.
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
- `test/`: the test suite.
	The seam is the rendered terminal frame and the recorded command sequence.
	No test touches a real herdr session or a real git repository.
