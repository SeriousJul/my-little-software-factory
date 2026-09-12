/**
 * The Handoff dispatch module: one seat for handoffs and environment changes.
 *
 * The module owns the durable claim and settle, the handoff queue, Close
 * cleanup, leftover clearing, and the name knowledge needed by handoff work.
 * It has no React dependency. The App crosses this interface for operator
 * actions and the observation loop crosses the same interface for automatic
 * work.
 */
import type { FactoryConfig } from "./config.ts";
import type { EnvironmentKind, LeftoverEnvironment, Ticket, TicketState } from "./domain/ticket.ts";
import {
	type CloseCleanupOptions,
	closeCleanupReach,
	closeHandoffEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffStoredWorkspace,
	handOffTicket,
	type NameCollision,
	type OwnNameKnowledge,
} from "./handoff.ts";
import type { RepositoryMapping } from "./repo.ts";
import { type CommandRunner, errorMessage } from "./runner.ts";
import type { FactoryState, HandoffClaim, HandoffOrigin } from "./state.ts";

/** A renderer callback must not strand a durable claim or the dispatch seat. */
function safeReport(report: () => void): void {
	try {
		report();
	} catch {
		// Reporting is best effort. The durable operation still needs to settle.
	}
}

/** The stored handles of the handoff whose environment a cleanup ends. */
export interface StoredHandoffFacts {
	handoffId: string;
	environment: EnvironmentKind;
	tabId: string | null;
	workspaceId: string | null;
}

/** The Handoff request crossing the dispatch seam. */
export interface HandoffIntent {
	origin: HandoffOrigin;
	ticketIdentity: string;
	choice: HandoffChoice;
	previousMessage: string;
	/**
	 * The result of the handoff's own start, reported once when the claimed
	 * handoff settles: `{ ok: true }` when the agent is live, `{ ok: false,
	 * reason }` when it never started. The claim says the dispatch took the
	 * work; only the start says the agent runs, so a route's decision waits for
	 * this. An intent that records nothing on a start omits it.
	 */
	onStarted?: (started: DispatchResult) => void;
}

/**
 * Whether dispatch accepted the intent: it claimed the Handoff and will run
 * it, now or behind the Handoff already in flight. A refused claim leaves the
 * ticket where it was and says why, and no start follows. Whether the Agent
 * actually started arrives later, on the intent's `onStarted`.
 */
export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * The Message and projection callbacks the module may call.
 *
 * The callbacks are the module's one reporting channel. They carry no React
 * types, and tests replace every one with an in-memory recorder, so a module
 * test reads the same text the operator reads. The module reports what its own
 * work leaves behind: the Handoff's progress line, the outcome it settles, and
 * the queued handoff the drain refused. The two answers an operator action
 * waits on - a Close cleanup's failure and the Clear action's guard - come back
 * as that action's result instead, so one fact never reaches the Message line
 * twice.
 */
export interface HandoffDispatchReports {
	working: (text: string) => void;
	warning: (text: string) => void;
	error: (text: string) => void;
	clearWorking: () => void;
	refresh: () => void;
}

/**
 * The Message line one Handoff outcome leaves, and the channel it belongs on.
 *
 * One function owns the wording of a handoff's end, for both callers that
 * report one: the dispatch module, and the App's no-state test projection. A
 * failed outcome is an error; a clean one with something to say is a warning; a
 * clean one with nothing to say leaves no line at all. The parts keep the order
 * the operator reads: the reason the handoff did not finish, the name it could
 * not take, the mapping write that failed, and the note the repository
 * resolution bent with.
 */
export async function reportHandoffOutcome(
	outcome: HandoffOutcome,
	reports: Pick<HandoffDispatchReports, "clearWorking" | "warning" | "error">,
	persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>,
): Promise<void> {
	const persistWarning =
		outcome.notes?.mappingToWrite === undefined || persistMapping === undefined
			? undefined
			: await persistMapping(outcome.notes.mappingToWrite);
	const nameWarning =
		outcome.collision !== undefined && outcome.collision.startedAs !== null
			? `a leftover agent still holds the herdr name ${outcome.collision.stableName}; this agent started as ${outcome.collision.startedAs}`
			: undefined;
	const lines = [
		...(outcome.status === "ok" ? [] : [outcome.reason]),
		...(nameWarning === undefined ? [] : [nameWarning]),
		...(persistWarning === undefined ? [] : [persistWarning]),
		...(outcome.status === "ok" && outcome.notes?.warning !== undefined
			? [outcome.notes.warning]
			: []),
	];
	reports.clearWorking();
	if (outcome.status !== "ok") reports.error(lines.join("; "));
	else if (lines.length > 0) reports.warning(lines.join("; "));
}

/** Dependencies of the Handoff dispatch module. */
export interface HandoffDispatchOptions extends HandoffDispatchReports {
	state: FactoryState;
	runner: CommandRunner;
	/** The current config. A queued handoff reads it when it starts. */
	config: () => FactoryConfig;
	home: string;
	/**
	 * The herdr workspace the control plane itself runs in, or null outside
	 * herdr. A Close cleanup that removes a workspace returns herdr's focus
	 * there, because the operator worked the close from the control plane.
	 */
	controlPlaneWorkspaceId?: string | null;
	/** Persist a repository mapping discovered during handoff, if one is found. */
	persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
}

/**
 * The small interface shared by operator and observation callers.
 *
 * A dispatch result answers only whether the claim was accepted. The optional
 * intent report answers later whether an agent actually started.
 */
export interface HandoffDispatch {
	/** Every Handoff origin: open, workflow, restart, observation loop. */
	dispatch(intent: HandoffIntent): Promise<DispatchResult>;
	/**
	 * The Close cleanup of one ended cycle. Returns the failure reason, or
	 * undefined. `end` stays on the seam so manual and observation callers share
	 * the same operation shape; the caller owns the wording of the answer.
	 */
	closeCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		end: "closed" | "abandoned",
	): Promise<string | undefined>;
	/**
	 * The Clear action, in one queue item. The returned list contains the
	 * environments herdr could not remove. Guard refusals are reported as
	 * warnings by the module and return an empty list because no cleanup ran.
	 */
	clearLeftover(identity: string, force: boolean): Promise<readonly string[]>;
	/** True while a Handoff holds the seat. The catalogue fact and the route edit guard. */
	handoffActive(): boolean;
}

/** Build one Handoff dispatch module for one durable state database. */
export function createHandoffDispatch(options: HandoffDispatchOptions): HandoffDispatch {
	return new HandoffDispatchModule(options);
}

/** The seat, the queues, and the work of one durable state database. */
class HandoffDispatchModule implements HandoffDispatch {
	private readonly state: FactoryState;
	private readonly runner: CommandRunner;
	private readonly config: () => FactoryConfig;
	private readonly home: string;
	private readonly controlPlaneWorkspaceId: string | null | undefined;
	private readonly reports: HandoffDispatchReports;
	private readonly persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;

	/** True while external handoff work holds the seat. */
	private inFlight = false;
	/** True while one cleanup is executing. */
	private clearing = false;
	/** True from the moment any cleanup queues until the cleanup queue drains. */
	private cleanupQueued = false;
	private cleanupQueue: QueuedCleanup[] = [];
	private handoffQueue: QueuedHandoff[] = [];

	constructor(options: HandoffDispatchOptions) {
		this.state = options.state;
		this.runner = options.runner;
		this.config = options.config;
		this.home = options.home;
		this.controlPlaneWorkspaceId = options.controlPlaneWorkspaceId;
		this.persistMapping = options.persistMapping;
		this.reports = {
			working: (text) => safeReport(() => options.working(text)),
			warning: (text) => safeReport(() => options.warning(text)),
			error: (text) => safeReport(() => options.error(text)),
			clearWorking: () => safeReport(options.clearWorking),
			refresh: () => safeReport(options.refresh),
		};
	}

	handoffActive(): boolean {
		return this.inFlight;
	}

	dispatch(intent: HandoffIntent): Promise<DispatchResult> {
		const config = this.config();
		const ticket = this.state
			.visibleTickets(config.taskRules, config.defaultTaskType)
			.find((candidate) => candidate.identity === intent.ticketIdentity);
		if (ticket === undefined)
			return Promise.resolve({ ok: false, reason: "the ticket no longer exists" });

		const claim = this.state.claimHandoff(intent.ticketIdentity, intent.choice, intent.origin);
		if (!claim.ok) return Promise.resolve({ ok: false, reason: claim.reason });
		this.runClaimedHandoff(
			ticket,
			intent.choice,
			intent.origin,
			claim.claim,
			intent.previousMessage,
			intent.onStarted,
		);
		return Promise.resolve({ ok: true });
	}

	closeCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		_end: "closed" | "abandoned",
	): Promise<string | undefined> {
		return this.queueCleanup(async () => {
			const failure = await this.settleCloseCleanup(identity, handoff);
			this.reports.refresh();
			return failure;
		});
	}

	clearLeftover(identity: string, force: boolean): Promise<readonly string[]> {
		if (this.inFlight)
			return Promise.resolve(
				this.refuseClear(
					`a handoff is in flight: wait for it to settle before you clear the leftover environment of ticket ${identity}`,
				),
			);
		if (this.cleanupQueued)
			return Promise.resolve(
				this.refuseClear(
					`a leftover clear is already in flight: wait for it to settle before you clear ticket ${identity} again`,
				),
			);

		const leftovers = this.state.leftoverEnvironments(identity);
		if (leftovers.length === 0) {
			// The fact is gone from the ticket, and the projection may still draw
			// it: refresh, so the marker and its control leave with it.
			this.reports.refresh();
			return Promise.resolve(
				this.refuseClear(`no leftover environment is recorded for ticket ${identity}`),
			);
		}

		const live =
			this.state.ticketState(identity) === "open"
				? null
				: (this.state.latestHandoff(identity) ?? null);
		const atRisk = live === null ? null : (liveHandleAtRisk(leftovers, live) ?? null);
		if (atRisk !== null)
			return Promise.resolve(
				this.refuseClear(
					`the agent of ticket ${identity} runs in ${atRisk.text}: close its work cycle before you clear that ${atRisk.what}`,
				),
			);

		// One queue item owns the whole retry loop: herdr cannot be asked to take
		// one environment of a ticket away and a handoff start in the next.
		return this.queueCleanup(async () => {
			const failures: string[] = [];
			for (const leftover of leftovers) {
				const failure = await this.settleCloseCleanup(
					identity,
					{
						handoffId: leftover.handoffId,
						environment: leftover.environment,
						tabId: leftover.tabId,
						workspaceId: leftover.workspaceId,
					},
					{ force },
				);
				if (failure !== undefined) failures.push(failure);
			}
			return failures;
		})
			.then((failures) => {
				if (failures.length === 0)
					this.reports.warning(`cleared the leftover environment of ticket ${identity}`);
				else
					this.reports.error(
						`ticket ${identity} still holds a leftover environment: ${failures.join("; ")}`,
					);
				return failures;
			})
			.catch((error): readonly string[] => {
				const reason = errorMessage(error);
				this.reports.error(`clearing the leftover environment failed: ${reason}`);
				return [reason];
			})
			.finally(() => this.reports.refresh());
	}

	/** Report one guard that stopped the Clear action before it reached herdr. */
	private refuseClear(reason: string): readonly string[] {
		this.reports.warning(reason);
		return [];
	}

	/** True when either a handoff or a queued environment change owns the seat. */
	private seatHeld(): boolean {
		return this.inFlight || this.cleanupQueued;
	}

	private nameKnowledgeFor(identity: string): OwnNameKnowledge {
		const handles = this.state.handoffHandles(identity);
		return {
			ownPaneIds: handles.paneIds,
			ownWorkspaceIds: handles.workspaceIds,
			leftoverKnown: this.state.leftoverEnvironment(identity) !== null,
		};
	}

	private recordNameCollision(identity: string, collision: NameCollision): void {
		if (!collision.own) return;
		this.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			paneId: collision.holder?.paneId ?? null,
			reason: `the leftover agent still holds the herdr name ${collision.stableName}: ${collision.reason}`,
		});
	}

	private runClaimedHandoff(
		ticket: Ticket,
		choice: HandoffChoice,
		origin: HandoffOrigin,
		claim: HandoffClaim,
		previousMessage: string,
		onStarted?: (started: DispatchResult) => void,
	): void {
		let reported = false;
		const reportStarted = (started: DispatchResult): void => {
			if (reported) return;
			reported = true;
			if (onStarted !== undefined) safeReport(() => onStarted(started));
		};

		if (this.seatHeld()) {
			this.handoffQueue.push({
				ticket,
				choice,
				origin,
				claim,
				previousMessage,
				onStarted: reportStarted,
			});
			return;
		}

		this.inFlight = true;
		this.reports.working(`handing off "${ticket.title}"...`);
		const onStage = (stage: string) => this.state.advanceHandoffAttempt(claim.attemptId, stage);
		const names = this.nameKnowledgeFor(ticket.identity);
		const run =
			origin === "open"
				? handOffTicket(ticket, choice, {
						config: this.config(),
						runner: this.runner,
						home: this.home,
						onStage,
						names,
					})
				: handOffStoredWorkspace({
						ticket,
						choice,
						config: this.config(),
						runner: this.runner,
						home: this.home,
						workspaceId: ticket.handoff?.workspaceId ?? null,
						environment: ticket.handoff?.environment ?? this.config().defaultEnvironment,
						previousTabId: ticket.handoff?.tabId ?? null,
						previousMessage,
						onStage,
						names,
					});

		void run
			.then((outcome) => this.finishHandoff(ticket.identity, claim, outcome, reportStarted))
			.catch((error) => this.failHandoff(claim, reportStarted, error));
	}

	private failHandoff(
		claim: HandoffClaim,
		reportStarted: (started: DispatchResult) => void,
		error: unknown,
	): void {
		const reason = errorMessage(error);
		this.state.settleHandoff(claim.attemptId, false, reason);
		this.reports.refresh();
		this.reports.clearWorking();
		this.reports.error(`handoff failed: ${reason}`);
		reportStarted({ ok: false, reason });
		this.inFlight = false;
		this.drainCleanupQueue();
	}

	private async finishHandoff(
		identity: string,
		claim: HandoffClaim,
		outcome: HandoffOutcome,
		reportStarted: (started: DispatchResult) => void,
	): Promise<void> {
		if (outcome.collision !== undefined) this.recordNameCollision(identity, outcome.collision);
		if (outcome.ownCollision !== undefined)
			this.recordNameCollision(identity, outcome.ownCollision);

		this.state.settleHandoff(
			claim.attemptId,
			outcome.status !== "failed",
			outcome.status === "failed" ? outcome.reason : undefined,
			outcome.status === "failed"
				? undefined
				: {
						paneId: outcome.agent.paneId,
						tabId: outcome.agent.tabId,
						workspaceId: outcome.agent.workspaceId,
						agentName: outcome.agent.name,
					},
		);
		this.reports.refresh();
		await reportHandoffOutcome(outcome, this.reports, this.persistMapping);
		reportStarted(
			outcome.status === "failed" ? { ok: false, reason: outcome.reason } : { ok: true },
		);
		this.inFlight = false;
		this.drainCleanupQueue();
	}

	/** Start the next queued cleanup only when the handoff seat is free. */
	private drainCleanupQueue(): void {
		if (this.inFlight || this.clearing) return;
		const cleanup = this.cleanupQueue.shift();
		if (cleanup === undefined) {
			this.cleanupQueued = false;
			this.drainHandoffQueue();
			return;
		}
		this.clearing = true;
		// The item settles its own caller, and the drain follows on the next
		// microtask: a cleanup that failed reaches the caller's Message line
		// before the next handoff writes its Working line over the slot.
		void cleanup.run().finally(() => {
			this.clearing = false;
			this.drainCleanupQueue();
		});
	}

	/** Queue one environment change and reserve the seat for it immediately. */
	private queueCleanup<Result>(work: () => Promise<Result>): Promise<Result> {
		this.cleanupQueued = true;
		const queued = new Promise<Result>((resolve, reject) => {
			this.cleanupQueue.push({
				// `async` is the load-bearing part: it turns a throw of `work`,
				// synchronous or not, into a rejection of the caller's promise,
				// so `run` itself never rejects and the drain's `finally` always
				// releases the seat. Without it a thrown cleanup would leave
				// `clearing` true, and every later handoff and cleanup would wait
				// on a seat nobody holds.
				run: async () => {
					try {
						resolve(await work());
					} catch (error) {
						reject(error);
					}
				},
			});
		});
		this.drainCleanupQueue();
		return queued;
	}

	/**
	 * Start the claimed handoffs the seat held back, in claim order.
	 *
	 * Every queued handoff re-checks the ticket's durable state before it runs:
	 * the claim passed when the queue formed, and the ticket may have moved on
	 * since. A ticket that moved on settles its claim as failed and the queue
	 * keeps draining, so a later item still starts when the seat frees.
	 */
	private drainHandoffQueue(): void {
		for (;;) {
			if (this.seatHeld()) return;
			const next = this.handoffQueue.shift();
			if (next === undefined) return;
			const currentState = this.state.ticketState(next.ticket.identity);
			if (currentState === undefined || !handoffAllowsState(next.origin, currentState)) {
				// One fact, said once: what the ticket is now. A ticket the state no
				// longer holds is the harder case, and the state it moved to is the
				// one the operator and the attempt both record.
				const movedOn =
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`;
				this.state.settleHandoff(next.claim.attemptId, false, movedOn);
				this.reports.refresh();
				this.reports.warning(`queued handoff for "${next.ticket.title}" was not run: ${movedOn}`);
				// The route the claim was for never started: its caller decides
				// nothing on the turn it came from.
				next.onStarted({ ok: false, reason: "the queued handoff was not run" });
				continue;
			}
			// The fresh projection when the ticket is visible, else the claim's
			// snapshot: the handoff runs on the ticket it claimed.
			const snapshot =
				this.state
					.visibleTickets(this.config().taskRules, this.config().defaultTaskType)
					.find((candidate) => candidate.identity === next.ticket.identity) ?? next.ticket;
			this.runClaimedHandoff(
				snapshot,
				next.choice,
				next.origin,
				next.claim,
				next.previousMessage,
				next.onStarted,
			);
		}
	}

	private async settleCloseCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		options: CloseCleanupOptions = {},
	): Promise<string | undefined> {
		try {
			const failure = await closeHandoffEnvironment(
				{
					environment: handoff.environment,
					tabId: handoff.tabId,
					workspaceId: handoff.workspaceId,
				},
				this.runner,
				{ ...options, controlPlaneWorkspaceId: this.controlPlaneWorkspaceId },
			);
			if (failure === undefined) {
				const reach = closeCleanupReach(handoff);
				this.state.clearLeftoverEnvironments(
					identity,
					reach.scope === "workspace"
						? { workspaceId: reach.workspaceId }
						: reach.scope === "tab"
							? { tabId: reach.tabId }
							: { handoffId: handoff.handoffId },
				);
				return undefined;
			}
			this.state.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: handoff.handoffId,
				reason: failure,
			});
			return failure;
		} catch (error) {
			const reason = `the close cleanup did not run: ${errorMessage(error)}`;
			this.state.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: handoff.handoffId,
				reason,
			});
			return reason;
		}
	}
}

interface QueuedCleanup {
	/** Run one environment change and settle its caller. Never rejects. */
	run: () => Promise<void>;
}

interface QueuedHandoff {
	ticket: Ticket;
	choice: HandoffChoice;
	origin: HandoffOrigin;
	claim: HandoffClaim;
	previousMessage: string;
	onStarted: (started: DispatchResult) => void;
}

/** A queued handoff may start only from the state its origin claims. */
function handoffAllowsState(origin: HandoffOrigin, state: TicketState): boolean {
	switch (origin) {
		case "open":
			return state === "open";
		case "workflow":
			return state === "awaiting";
		case "restart":
			return state === "handed-off" || state === "running";
	}
}

/** The handle a clear would end that the ticket's own live agent runs on. */
function liveHandleAtRisk(
	leftovers: readonly LeftoverEnvironment[],
	live: { paneId: string | null; tabId: string | null; workspaceId: string | null },
): { text: string; what: string } | null {
	for (const leftover of leftovers) {
		if (
			leftover.environment === "worktree" &&
			live.workspaceId !== null &&
			leftover.workspaceId === live.workspaceId
		)
			return { text: `herdr workspace ${live.workspaceId}`, what: "workspace" };
		if (live.tabId !== null && leftover.tabId === live.tabId)
			return { text: `herdr tab ${live.tabId}`, what: "tab" };
		if (live.paneId !== null && leftover.paneId === live.paneId)
			return { text: `herdr pane ${live.paneId}`, what: "pane" };
	}
	return null;
}
