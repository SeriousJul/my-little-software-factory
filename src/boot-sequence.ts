/**
 * The boot-sequence module (ADR 0155): the plane's boot order and the
 * teardown that reverses it.
 *
 * The plane's boot is not the declaration order of the shell's hook chain: it
 * is the sequence this module runs, in the order it owns. The shell calls the
 * module once at mount with the Plane boot record and its report sinks, and
 * the module runs the sequence: the state's boot read, the refresh
 * coordinator's start - the one-shot boot read under the held policy, and the
 * sources' first reads plus the polling schedule under the others - the
 * list's one move on the initial load's settle, the first Observation cycle
 * on the settle, and the polling schedule the first cycle stands behind. It
 * gives back the ordered start and the one teardown that reverses it: the
 * Observation coordinator stops, the refresh coordinator stops, its
 * initial-load-settled fact resolving on the stop, and the Handoff dispatch
 * and the Consultation operations stop behind them, in the one order the
 * module fixes, before the state file closes.
 *
 * The interface is small, and the sequence is deep: the record, the policy,
 * and the sinks in, and the ordered start and the one teardown out. The
 * Startup grace and the Agent wait stand inside the Observation cycle the
 * module starts: the module decides when the loop starts, and the cycle
 * keeps its grace window, its wake, and the polling interval it derives from
 * the config. The module stands the facts the shell paints and never paints:
 * it reports through the sinks, and the shell keeps the paint, the keys, and
 * the screen stack.
 */
import type { AgentHost } from "./agent-host.ts";
import type { AttentionService } from "./attention.ts";
import type { AppProps } from "./components/app.ts";
import type { ProgressOwner } from "./components/message-facts.ts";
import type { FactoryConfig } from "./config.ts";
import type { ConsultationOperations } from "./consultation-operations.ts";
import type { HandoffDispatch } from "./handoff-dispatch.ts";
import type { HerdrAgent } from "./herdr.ts";
import {
	MergedAgentReader,
	ObservationCoordinator,
	type ObservationReport,
	SESSION_TURN_LOGS,
} from "./observation.ts";
import { TICKET_SEAT_STATES } from "./parallel.ts";
import { type RefreshClock, RefreshCoordinator } from "./refresh.ts";
import type { ConsultationRecordAggregate } from "./state/consultation-record.ts";
import type { TicketWorkCycleAggregate } from "./state/ticket-work-cycle.ts";
import type { WorkQueueAggregate } from "./state/work-queue.ts";
import type { FetchOutcome, TicketSource } from "./ticket-source.ts";
import { fireTransition, refireRecordedSkips } from "./workflow.ts";

/** The status line the loops report onto (the shell's Status message). */
export interface BootStatus {
	kind: "info" | "warning" | "error";
	text: string;
}

/**
 * The shell's side of the sequence (ADR 0155): the report sinks the module
 * reports onto, the reads it stands the loops on, and the dispatch operations
 * whose stops the teardown runs. The module takes the facts the shell stands,
 * and it never reaches a pane or a key: a sequence that painted would own the
 * screen.
 */
export interface BootSequenceFields {
	/** The shell's live sources: the bound sources plus the config's unbound feeds. */
	sources: readonly TicketSource[];
	/** The one time seam of the run: the loops the module starts schedule on it. */
	clock: RefreshClock;
	/** The run's config, read at each use, so a runtime write-back stays visible. */
	config: () => FactoryConfig;
	/** The ticket list the state stands, re-read on the settle and the cycle's report. */
	replaceTickets: () => void;
	/** The Consultation list beside the ticket list. */
	replaceConsultations: () => void;
	/** The queue's brake the state holds (ADR 0052). */
	setQueuePaused: (value: boolean) => void;
	/** The warning the successful source read carries, onto the Message line (ADR 0023). */
	setFaultWarningMessage: (warning: string) => void;
	/** The status line the Observation cycle's events report onto. */
	setStatus: (next: BootStatus | null) => void;
	/** The stale-operation fact the herdr recovery clears (ADR 0131). */
	clearOperationMessage: (owner: ProgressOwner) => void;
	/** The manual refresh's progress line, cleared when the refresh it named settles. */
	clearWorkingMessage: (owner: ProgressOwner) => void;
	/** The roster the cycle's report names, into the screen state. */
	setAgents: (agents: readonly HerdrAgent[] | null) => void;
	/** The flash the Consultation attention puts on the plane's own standing. */
	setBell: (value: boolean) => void;
	/** The plane's out-of-band attention: the bell and the notification (ADR 0080). */
	attention: AttentionService;
	/** Re-read the ticket's sources when a cycle ends, so the ticket is re-verified. */
	refreshTicketSources: (identity: string) => void;
	/** Close the cycle end's draft when its cycle ends. */
	closeCycleEndDraft: (identity: string) => void;
	/** Pull the pull request sources fresh for the transition's fire. */
	refreshPullRequestSources: () => Promise<void>;
	/** The sources the operator's manual refresh started, by name: the line it clears. */
	manualRefreshPending: { current: Set<string> };
	/** The run's Handoff dispatch: the cycle's port, and the teardown stops it. */
	handoffDispatch: HandoffDispatch;
	/** The run's Consultation operations: the teardown stops them. */
	consultationOperations: ConsultationOperations;
}

/**
 * The run's boot sequence, and its reverse (ADR 0155). The start is the
 * ordered run of the module's sequence; the teardown stops the loops and the
 * dispatch operations in the reverse of the start, in the one order the
 * module fixes. The shell registers the teardown as the run's stop, and a
 * re-run of the shell's facts disposes the run without stopping the run's
 * dispatch operations, which outlive it.
 */
export interface BootSequence {
	/**
	 * The teardown the run's owner calls before the state closes: the
	 * Observation coordinator stops, the refresh coordinator stops, its
	 * initial-load-settled fact resolving on the stop, and the Handoff
	 * dispatch and the Consultation operations stop behind them. Safe to call
	 * twice: a second stop changes nothing.
	 */
	stop: () => void;
	/**
	 * Release one run of the sequence, the way the shell's re-run releases the
	 * run it replaces: the loops stop, the run's hold on the list disposes,
	 * and the run's dispatch operations stand on, the way the run's own stop
	 * stands on them. Safe to call twice.
	 */
	dispose: () => void;
	/** The refresh coordinator the run stands: the key handler's refresh now. */
	refresh: RefreshCoordinator;
	/** The Observation coordinator the run stands, or none under the held policy. */
	cycle: ObservationCoordinator | undefined;
}

/**
 * The names the plane's herdr-core Agents hold (issue #410, ADR 0142): the
 * in-flight Tickets' and Consultations' recorded names on the herdr-core
 * host. The merged poll's roster read is unscoped, and the per-Agent read
 * runs only over these names, so the poll never reads every terminal on the
 * machine.
 */
function coreTerminalNames(state: {
	ticketWorkCycle: TicketWorkCycleAggregate;
	consultationRecord: ConsultationRecordAggregate;
}): readonly string[] {
	const names: string[] = [];
	for (const ticket of state.ticketWorkCycle.ticketsByState(TICKET_SEAT_STATES))
		if (ticket.host === "herdr-core" && ticket.paneId !== null) names.push(ticket.paneId);
	// The set the Consultation close's own verification reads stands beside it:
	// a close marks its record `closing` before it verifies the Agent, so the
	// cycle keeps the closing Consultation's terminal in the list the close
	// reads (issue #410, ADR 0142).
	for (const consultation of state.consultationRecord.consultationsByState([
		"opening",
		"working",
		"awaiting-response",
		"closing",
	]))
		if (consultation.host === "herdr-core" && consultation.paneId !== null)
			names.push(consultation.paneId);
	return names;
}

/**
 * The module's hold on the list (ADR 0154, owned here beside the fact it
 * stands on): the load still stands, and the run that stands the load is
 * alive. The settle flips the flag and makes the one list move; the run's
 * release disposes the hold, so a settle that lands after it moves no list.
 */
interface ListHold {
	/** The load still stands: the per-settlement moves are suppressed. */
	loadStanding: boolean;
	/** Mark the run disposed: a settle that lands now moves no list. */
	dispose: () => void;
}

function holdListUntilSettle(
	initialLoadSettled: Promise<void>,
	replaceTickets: () => void,
	replaceConsultations: () => void,
): ListHold {
	let disposed = false;
	const hold: ListHold = {
		loadStanding: true,
		dispose: () => {
			disposed = true;
		},
	};
	void initialLoadSettled.then(() => {
		hold.loadStanding = false;
		if (disposed) return;
		replaceTickets();
		replaceConsultations();
	});
	return hold;
}

/** The queue's brake the state holds (ADR 0052): the boot read stands it where the operator left it. */
function queuePauseOf(state: { workQueue: WorkQueueAggregate }): boolean {
	return state.workQueue.queuePaused();
}

/**
 * The module's per-settlement work (ADR 0154, owned here beside the hold it
 * stands on): the warnings of the read surface while the load stands, and the
 * list, the consultations, and the observation loop wait on the settle, so
 * none of them moves on a partial snapshot.
 */
function settleSettlement(
	outcome: FetchOutcome | undefined,
	fields: BootSequenceFields,
	hold: ListHold,
	tick: () => void,
): void {
	// The warnings a successful source read carries surface while the load
	// stands as well: a warning is a fact of the read, not a move of the list
	// (ADR 0023, ADR 0118).
	if (outcome?.status === "success")
		for (const warning of outcome.warnings ?? []) fields.setFaultWarningMessage(warning);
	// While the load stands, the list, the consultations, and the observation
	// loop all wait on the settle (ADR 0154).
	if (hold.loadStanding) return;
	fields.replaceTickets();
	fields.replaceConsultations();
	// A fetch may have made a ticket actionable: let the observation loop
	// act on it now instead of on the next poll.
	tick();
}

/**
 * The manual refresh's settled hook (the `r` key): the names it started stand
 * pending, and the line clears when the last of them settles. A failure
 * clears it the way a success does.
 */
function settledHook(fields: BootSequenceFields) {
	return (sourceName: string): void => {
		if (!fields.manualRefreshPending.current.has(sourceName)) return;
		fields.manualRefreshPending.current.delete(sourceName);
		if (fields.manualRefreshPending.current.size === 0) fields.clearWorkingMessage("refresh");
	};
}

/**
 * The roster report the cycle applies (issue #422, ADR 0146): on the report
 * the plane already applied, the cycle writes nothing - no state write, no
 * paint; on a new one, it writes the facts the report names: the roster into
 * the screen state, and the lists where the report names the movement. The
 * poll's host answer the report records routes a wake wait to the host the
 * agent stands on (issue #410).
 */
function reportApplier(
	fields: BootSequenceFields,
	hostByReference: { current: Map<string, AgentHost> },
): (report: ObservationReport) => void {
	let lastAppliedReport: ObservationReport | null = null;
	return (report): void => {
		if (report === lastAppliedReport) return;
		lastAppliedReport = report;
		const hosts = new Map<string, AgentHost>();
		for (const agent of report.agents ?? []) {
			hosts.set(agent.paneId, agent.host);
			if (agent.name !== undefined) hosts.set(agent.name, agent.host);
		}
		hostByReference.current = hosts;
		fields.setAgents(report.agents);
		if (report.ticketsMoved) fields.replaceTickets();
		if (report.consultationsMoved) fields.replaceConsultations();
	};
}

/** The Consultation attention the plane puts on: the flash the shell keeps, and the bell the attention service rings (ADR 0080). */
function ringConsultationAttention(fields: BootSequenceFields): void {
	fields.setBell(true);
	setTimeout(() => fields.setBell(false), 250);
	fields.attention.ring();
}

/** The status line the Observation cycle reports onto, and the recovery fact that clears a stale operation line (ADR 0131). */
function reportCycleStatus(
	fields: BootSequenceFields,
	kind: "info" | "warning" | "error",
	text: string,
	topic: string | undefined,
): void {
	fields.setStatus({ kind, text });
	// The recovery topic is the structured signal a stale operation fact can clear.
	if (topic === "herdr-recovered") fields.clearOperationMessage("none");
}

/**
 * The Observation cycle the module starts (ADR 0155): the poll, the seats, and
 * the dispatch's tick. The module decides when the loop starts - the held
 * policy starts no cycle - and the cycle keeps its rules: the Startup grace,
 * the Agent wait, and the polling interval it derives from the config.
 */
function startCycle(
	record: AppProps,
	fields: BootSequenceFields,
	initialLoadSettled: Promise<void>,
): ObservationCoordinator {
	const { state, runner, sessionRecord, logger, agentHostResolution } = record;
	// The merged Agent reader (issue #410, ADR 0142): both hosts in one list,
	// and a wake wait routed to the host the last poll recorded for its name.
	const hostByReference = { current: new Map<string, AgentHost>() };
	const herdr = new MergedAgentReader({
		runner,
		runHost: agentHostResolution.host,
		coreNames: () => coreTerminalNames(state),
		hostOf: (reference) => hostByReference.current.get(reference) ?? agentHostResolution.host,
	});
	return new ObservationCoordinator({
		state,
		herdr,
		// The run's config, read at each cycle: a runtime write-back stays visible.
		config: fields.config,
		// The host the run resolved (issue #409): the starts the cycle asks for
		// run on the run's host, never on a host a previous handoff recorded.
		agentHost: agentHostResolution,
		// The Handoff dispatch module the cycle runs, through the narrow port
		// the cycle may cross.
		dispatch: fields.handoffDispatch,
		// The one time seam of the run: the state file, the refresh
		// coordinator, and the cycle answer from the same clock.
		clock: fields.clock,
		// The loop policy's poll: the named interval where the policy names
		// one, and the config's agent-poll-interval-seconds otherwise, and
		// the cycle derives it each cycle.
		pollIntervalMs: record.loopPolicy.kind === "polled" ? record.loopPolicy.intervalMs : undefined,
		onCycleEnd: (identity) => {
			fields.refreshTicketSources(identity);
			fields.closeCycleEndDraft(identity);
		},
		// The roster the report names (issue #422, ADR 0146): on the report
		// the plane already applied, the cycle writes nothing; on a new one,
		// it writes the facts the report names.
		onReport: reportApplier(fields, hostByReference),
		// The Consultation attention puts on the plane: the flash the shell
		// keeps, and the bell the attention service rings (ADR 0080).
		onConsultationAttention: () => ringConsultationAttention(fields),
		// The cycle's record lines: each hold its automatic walks take
		// (issue #223). The record's logger: the file logger in production,
		// and the no-op logger where the run keeps the loops silent.
		log: logger,
		// The settled turn's log: the session record's reader, supplied here
		// rather than constructed inside the cycle.
		turnLogs: SESSION_TURN_LOGS,
		// The derived session record path on the host that reports none
		// (ADR 0144): the per-kind table's lookup, supplied the way the
		// reader is.
		sessionRecord,
		// The plane's initial-load-settled fact (ADR 0154, owned beside the
		// sequence here): the cycle holds its first cycle until the load
		// settles, so the first probe lands on the roster the settled sources
		// make, not on an empty one.
		initialLoadSettled,
		// The status line the cycle's events report onto, and the recovery
		// fact that clears a stale operation line (ADR 0131).
		onStatus: (kind, text, topic) => reportCycleStatus(fields, kind, text, topic),
		// The transition fire of a completed settle (ADR 0027): pull the pull
		// request sources fresh, and fire the task type's transition through
		// the command runner.
		fireCompleted: async (ticket) => {
			return await fireTransition({
				config: fields.config(),
				state,
				runner,
				ticketIdentity: ticket.ticketIdentity,
				taskType: ticket.taskType,
				refresh: fields.refreshPullRequestSources,
			});
		},
		// The re-fire of the recorded skips (ADR 0042): a refresh that found
		// the fixing pull request re-fires the transition the ticket's newest
		// completion trace recorded as the skip.
		refireRecordedSkips: () =>
			refireRecordedSkips({
				config: fields.config(),
				state,
				runner,
				refresh: fields.refreshPullRequestSources,
			}),
	});
}

/**
 * Run the plane's boot sequence from the Plane boot record and the shell's
 * fields (ADR 0155): the state's boot read, the sources' first reads under
 * the policy's arm, the list's one move on the initial load's settle, the
 * first Observation cycle on the settle, and the polling schedule behind it.
 *
 * The module takes the shell's dispatch operations, whose stops the teardown
 * runs, and it hands the run's teardown back through the record's `onReady`,
 * the same handle the entry's shutdown installer and the frame rig read. The
 * loop policy names which loops the sequence starts: the held policy stands
 * the one-shot boot read and no Observation loop, and the others stand the
 * sources' first reads plus the polling schedule and the first cycle on the
 * settle. The callers see the face, never the order.
 */
export function startBootSequence(record: AppProps, fields: BootSequenceFields): BootSequence {
	const { state, loopPolicy, onReady } = record;

	// The state's boot read: a state may already hold tickets when the app
	// boots, and the list stands on the record the run booted from. The queue
	// pause is factory state (ADR 0052): a restart finds the brake where the
	// operator left it.
	fields.replaceTickets();
	fields.replaceConsultations();
	fields.setQueuePaused(queuePauseOf(state));

	// The refresh coordinator: the sources' first reads, and the polling
	// schedule under the policies that name one. It owns the load's fact: the
	// one promise the list's one move and the first Observation cycle wait
	// on, so the two share the settle and neither guesses at it (ADR 0154). A
	// run that stops settles the load, so a shutdown does not wait on a load
	// that will not finish. The hold and the cycle stand behind the
	// coordinator that owns the fact they wait on: the settlement callbacks
	// run only on a later tick, after both are assigned.
	let hold: ListHold;
	let cycle: ObservationCoordinator | undefined;
	const tick = (): void => {
		cycle?.tick();
	};
	const refresh = new RefreshCoordinator(
		fields.sources,
		state,
		(outcome) => settleSettlement(outcome, fields, hold, tick),
		{
			clock: fields.clock,
			settled: settledHook(fields),
			log: record.logger,
		},
	);
	hold = holdListUntilSettle(
		refresh.initialLoadSettled,
		fields.replaceTickets,
		fields.replaceConsultations,
	);

	// The Observation cycle: the first probe on the settle, and the polling
	// schedule behind it. The held policy stands no cycle at all: its frame
	// is deterministic, where nothing moves until a key press or a settle
	// does, and a frame test must not race a poll.
	if (loopPolicy.kind !== "held") cycle = startCycle(record, fields, refresh.initialLoadSettled);

	// The start per the policy: the held one-shot boot read, and the plane's
	// own refresh schedule under the others. The cycle's start stands behind
	// the schedule it waits on: under the settle it holds its first cycle,
	// and under the policies with no load to wait on it runs at once.
	if (loopPolicy.kind === "held") refresh.startOnce();
	else refresh.start();
	cycle?.start();

	// The one teardown that reverses the start: the loops stop, the run's
	// hold on the list disposes, and the dispatch operations stop behind
	// them, in the one order the module fixes, before the state closes. A
	// second stop changes nothing.
	let released = false;
	let tornDown = false;
	const dispose = (): void => {
		if (released) return;
		released = true;
		// Only the loops this run made. The dispatch operations outlive the
		// run: the shell's re-run replaces the run, and a stopped module is a
		// plane that starts nothing for the rest of the run.
		cycle?.stop();
		// The refresh coordinator's stop settles the load it owns, so the
		// probe the run held and the list move it held resolve on the stop
		// (ADR 0154), and the settle the load owed lands on no run.
		refresh.stop();
		hold.dispose();
	};
	const stop = (): void => {
		dispose();
		if (tornDown) return;
		tornDown = true;
		// The handoff dispatch is the one background loop that outlives the
		// state: its run settles asynchronously, so stop it before the owner
		// closes the state, or the settlement reads a closed database.
		fields.handoffDispatch.stop();
		// The Consultation operations settle the same way: an opening that
		// stands mid-flight at the stop runs its remaining commands but
		// settles nothing into the record the owner closes beside it
		// (issue #398).
		fields.consultationOperations.stop();
	};

	// The handle the run's owner reads on every ending that closes the state:
	// it stands on every branch, the held one included, and the owner's
	// shutdown ordering - stop before the state closes - is one rule.
	onReady({ stop });
	return { stop, dispose, refresh, cycle };
}
