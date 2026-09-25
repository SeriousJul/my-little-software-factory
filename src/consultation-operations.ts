/**
 * Consultation lifecycle operations.
 *
 * The control plane owns the Consultation screens, but this module owns every
 * external lifecycle change. It keeps the operation queue, the interrupted
 * opening guard, and the live close private so launch, recovery, response, and
 * close operations cannot race on one Repository, and a Force-close ends a
 * cleanup instead of queueing another one behind it.
 */
import { randomUUID } from "node:crypto";

import type { FactoryConfig } from "./config.ts";
import {
	type AgentInputEvent,
	type CheckoutConflict,
	ConsultationInputQueue,
	type ConsultationRepositoryOption,
	inspectLiveCheckout,
	isStaleAgentOutputWarning,
	type LiveCheckoutSafety,
	STALE_AGENT_OUTPUT_WARNING,
	serializeRepositoryOperation,
	validateConsultationInput,
	validateResponseInput,
} from "./consultation.ts";
import type { Ticket } from "./domain/ticket.ts";
import {
	type ConsultationHandoffOutcome,
	checkConsultationStart,
	handOffConsultation,
	renderConsultationPrompt,
} from "./handoff.ts";
import type { HerdrAgent } from "./herdr.ts";
import { consultationAgentName } from "./naming.ts";
import { HerdrAgentReader, matchConsultationAgent } from "./observation.ts";
import {
	type RepositoryMapping,
	type ResolvedRepository,
	realPathOf,
	resolveRepository,
} from "./repo.ts";
import {
	type CommandResult,
	type CommandRunner,
	commandFailureText,
	errorMessage,
} from "./runner.ts";
import type {
	Consultation,
	ConsultationPendingResponse,
	ConsultationResource,
	FactoryState,
} from "./state.ts";

/**
 * The answer the Work queue's pickup gets from one Consultation pickup
 * (ADR 0034, issue #90).
 *
 * The answer stands at the seat. `started` means the record left `queued` and
 * holds its seat in `opening`, with its environment and Agent being built
 * behind the answer; `failed` means the pickup had nothing to start with, and
 * the record is `failed` with its reason; `moved` means the record had left the
 * queue's wait before the pickup ran. A start that fails after the seat - a
 * Setting fit refusal, a failed clone - leaves the same `failed` record and the
 * same Message line a direct launch leaves, and reports nothing more here:
 * the queue's item went with the claim.
 *
 * The caller removes the item on every answer: the item is the pointer to a
 * record in `queued` state, and no answer leaves the record waiting.
 */
export type ConsultationPickupOutcome =
	| { kind: "started" }
	| { kind: "failed" }
	| { kind: "moved" };

export interface ConsultationStatus {
	kind: "info" | "warning" | "error";
	text: string;
}

export interface ConsultationSafetyConflict {
	consultationId: string;
	safety: LiveCheckoutSafety;
}

export interface ConsultationOperationCallbacks {
	/** A human-facing progress, warning, or error message. */
	onStatus: (status: ConsultationStatus | null) => void;
	/**
	 * The progress of a running operation, apart from its outcome. `null` ends
	 * the progress `owner` wrote.
	 *
	 * The owner is the identity of the Consultation the operation works on, so
	 * two operations that run at the same time in different repositories own
	 * two lines and the settle of the earlier one cannot erase the later one's.
	 * The Main view shows the text on the Message line as Working progress.
	 */
	onProgress: (text: string | null, owner: string) => void;
	/** The durable Consultation projection changed. */
	onConsultationsChanged: () => void;
	/** A live checkout needs the view to show its confirmation panel. */
	onSafetyConflict: (conflict: ConsultationSafetyConflict) => void;
}

export interface ConsultationOperationsOptions {
	state: FactoryState;
	runner: CommandRunner;
	config: () => FactoryConfig;
	home: string;
	/** The live Ticket projection used by the checkout safety check. */
	tickets: () => readonly Ticket[];
	callbacks: ConsultationOperationCallbacks;
	/** Persist a sibling-clone mapping, when repository resolution creates one. */
	persistRepositoryMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
	textBatchBytes?: number;
}

export interface ConsultationCreateInput {
	typeName: string;
	repository: ConsultationRepositoryOption;
	initialInput: string;
	replacementOf?: string | null;
	/**
	 * Whether the submit could not take a Parallel limit seat (ADR 0034,
	 * issue #90). A `true` submit creates the record in `queued` state with
	 * its Work queue item, and starts nothing; the pickup starts it when a
	 * seat frees. A `false` submit creates the record in `opening` state, the
	 * way a direct launch has always done.
	 */
	queued?: boolean;
}

export type ConsultationReplacementInput = Omit<
	ConsultationCreateInput,
	"initialInput" | "replacementOf"
> & {
	initialInput?: string;
};

/**
 * One Consultation close the module has taken responsibility for.
 *
 * A Force-close sets `cancelled` on the live operation, and the cleanup
 * checks it before every external call: an operator who forced the record
 * closed must never find a workspace or pane closed behind that decision.
 */
interface CloseOperation {
	cancelled: boolean;
}

interface LaunchConflict {
	status: "conflict";
	safety: LiveCheckoutSafety;
}

type LaunchOutcome = ConsultationHandoffOutcome | LaunchConflict;

/** The herdr environment one close takes down, and what survives it. */
interface ClosePlan {
	/** The one cleanup command, or none when no owned environment remains. */
	command: readonly string[] | undefined;
	/** Resources the command confirmed closed. */
	closes: ConsultationResource[];
	/** Resources the operator keeps: shared, or a worktree that never closes. */
	retains: Array<{
		kind: ConsultationResource["kind"];
		resourceId: string;
		details?: string;
	}>;
}

const WORKTREE_REMAIN = "retained after close: worktree and branch remain";

export function createConsultationOperations(
	options: ConsultationOperationsOptions,
): ConsultationOperations {
	return new ConsultationOperations(options);
}

/** The Consultation lifecycle interface: one owner for every external change. */
export class ConsultationOperations {
	private readonly state: FactoryState;
	private readonly runner: CommandRunner;
	private readonly config: () => FactoryConfig;
	private readonly home: string;
	private readonly tickets: () => readonly Ticket[];
	private readonly callbacks: ConsultationOperationCallbacks;
	private readonly persistRepositoryMapping?: (
		mapping: RepositoryMapping,
	) => Promise<string | undefined>;
	private readonly operationQueues = new Map<string, Promise<void>>();
	private readonly openingOperations = new Set<string>();
	private readonly closeOperations = new Map<string, CloseOperation>();
	private readonly inputQueue: ConsultationInputQueue;

	constructor(options: ConsultationOperationsOptions) {
		this.state = options.state;
		this.runner = options.runner;
		this.config = options.config;
		this.home = options.home;
		this.tickets = options.tickets;
		this.callbacks = options.callbacks;
		this.persistRepositoryMapping = options.persistRepositoryMapping;
		this.inputQueue = new ConsultationInputQueue(this.runner, options.textBatchBytes);
	}

	/**
	 * The Consultation enqueue's hard check (ADR 0049): the type the ask names
	 * still exists, and the settings that type resolves to still fit.
	 *
	 * The Work queue is the single start channel, and every hard check runs at
	 * the enqueue: a Consultation the config cannot start never takes a row, and
	 * the reason stands on the Message line at the ask. The check reads the
	 * type's settings - the record's settings are the type's, both at the create
	 * below and at the pickup's re-read - and it is the same
	 * `checkConsultationStart` the start runs. The start runs it again on the
	 * record it picked up, because the fit answer is a runtime read and a queued
	 * record must answer to the config it starts under; that re-read is what
	 * leaves the `failed` record story 6 asks for when the config moved while
	 * the item waited. A refuse returns the reason; a pass returns nothing.
	 */
	async checkEnqueue(typeName: string): Promise<string | undefined> {
		const config = this.config();
		const type = config.consultationTypes[typeName];
		if (type === undefined) return `unknown Consultation type ${typeName}`;
		const check = await checkConsultationStart({
			consultation: {
				agentType: type.agent,
				environment: type.environment,
				model: type.model ?? "",
				thinking: type.thinking ?? "",
				contextWindow: type.contextWindow ?? "",
			},
			config,
			runner: this.runner,
		});
		return check.ok ? undefined : check.reason;
	}

	create(input: ConsultationCreateInput): Consultation | undefined {
		const type = this.config().consultationTypes[input.typeName];
		if (type === undefined) {
			this.status("error", `unknown Consultation type ${input.typeName}`);
			return undefined;
		}
		const validation = validateConsultationInput(input.initialInput);
		if (validation !== undefined) {
			this.status("error", validation);
			return undefined;
		}
		const id = randomUUID();
		const consultation = this.state.createConsultation({
			id,
			typeName: input.typeName,
			agentType: type.agent,
			environment: type.environment,
			model: type.model,
			thinking: type.thinking,
			contextWindow: type.contextWindow,
			template: type.template,
			initialInput: input.initialInput,
			renderedOpeningPrompt: renderConsultationPrompt(type.template, input.initialInput),
			repository: input.repository,
			replacementOf: input.replacementOf,
			agentName: consultationAgentName(id),
			// The submit the full cap kept from starting is born `queued` with
			// its Work queue item in the same write (ADR 0034, issue #90): no
			// environment and no agent until the pickup starts the record.
			initialState: input.queued === true ? "queued" : "opening",
		});
		this.callbacks.onConsultationsChanged();
		return consultation;
	}

	launch(consultation: Consultation): Promise<void> {
		if (!this.state.canRecoverConsultationOpening(consultation.id)) return Promise.resolve();
		if (!this.claimOpening(consultation.id)) {
			this.status("info", "Consultation opening is already in progress");
			return Promise.resolve();
		}
		this.progress(consultation.id, `opening Consultation ${consultation.id.slice(0, 8)}...`);
		return this.runOpening(consultation).finally(() => {
			this.openingOperations.delete(consultation.id);
			this.endProgress(consultation.id);
		});
	}

	recover(consultation: Consultation): Promise<void> {
		const current = this.state.consultation(consultation.id);
		if (current === undefined || !this.state.canRecoverConsultationOpening(current.id))
			return Promise.resolve();
		if (current.paneId === null && current.sessionId === null) {
			this.progress(current.id, `recovering Consultation ${current.id.slice(0, 8)}...`);
			return this.launch(current);
		}
		if (!this.claimOpening(current.id)) {
			this.status("info", "Consultation opening is already in progress");
			return Promise.resolve();
		}
		this.progress(current.id, `verifying Consultation ${current.id.slice(0, 8)} Agent...`);
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				// Recovery is another Consultation start. Re-check the stored
				// settings before reading Herdr, so a config change cannot let a
				// stale opening start trimmed.
				const fit = await checkConsultationStart({
					consultation: current,
					config: this.config(),
					runner: this.runner,
				});
				if (!fit.ok) return { kind: "fit-failed" as const, reason: fit.reason };
				const probe = await new HerdrAgentReader(this.runner).listAgents();
				if (probe.kind === "error") return { kind: "error" as const, reason: probe.reason };
				const agent = matchConsultationAgent(current, probe.agents);
				return agent === undefined || agent === "ambiguous"
					? {
							kind: "missing" as const,
							reason:
								agent === "ambiguous" ? "Agent session match is ambiguous" : "Agent is missing",
						}
					: { kind: "agent" as const, agent };
			},
		)
			.then((result) => {
				if (result.kind === "fit-failed") {
					this.state.failConsultationOpening(current.id, result.reason);
					this.callbacks.onConsultationsChanged();
					this.status("error", `Consultation ${current.id.slice(0, 8)} failed: ${result.reason}`);
					return;
				}
				if (result.kind === "error") {
					this.status("error", `cannot verify Consultation Agent: ${result.reason}`);
					return;
				}
				if (result.kind === "missing") {
					this.state.failConsultationOpening(current.id, result.reason);
					this.callbacks.onConsultationsChanged();
					this.status("error", `Consultation ${current.id.slice(0, 8)} failed: ${result.reason}`);
					return;
				}
				this.state.updateConsultationAgentHandles(current.id, {
					paneId: result.agent.paneId,
					tabId: result.agent.tabId,
					workspaceId: result.agent.workspaceId,
					sessionId: result.agent.stableSessionId ?? current.sessionId,
				});
				this.state.setConsultationAgent(current.id, {
					paneId: result.agent.paneId,
					tabId: result.agent.tabId,
					workspaceId: result.agent.workspaceId,
					sessionId: result.agent.stableSessionId ?? current.sessionId,
				});
				this.callbacks.onConsultationsChanged();
				this.status("info", `Consultation ${current.id.slice(0, 8)} reconnected`);
			})
			.catch((error) => {
				this.status("error", `cannot verify Consultation Agent: ${errorMessage(error)}`);
			})
			.finally(() => {
				this.openingOperations.delete(current.id);
				this.endProgress(current.id);
			});
	}

	/**
	 * Start one Consultation that is not started yet: the Work queue's pickup
	 * of a `queued` record when a seat frees (ADR 0034, issue #90), and the
	 * operator's start now of an `unscheduled` record, over the Parallel limit
	 * or under it (issue #91). Both run through this one seam: the cap is the
	 * scheduler's check, not the start's, and the seat move below is the claim
	 * in either case.
	 *
	 * The record already holds the operator's ask, and the start re-reads the
	 * Consultation type's settings from the config - the record waited for a
	 * seat or the operator's call, so the start runs on the type the config
	 * holds now, not on the settings the record captured at the enqueue -
	 * before it moves the record to `opening` and hands the record to the same
	 * opening pipeline a direct launch runs: the Setting fit check, the
	 * repository resolution, the environment, and the Agent.
	 *
	 * The claim is all the observation cycle waits for. The opening runs on
	 * behind the answer, the way a claimed handoff's start does: an external
	 * pipeline that can take as long as a cold clone must not hold every ticket
	 * poll with it. A start that fails after the claim leaves the record
	 * `failed` with its reason and its Message line, exactly as a failed launch
	 * does, and the queue's item went with the claim while one stood.
	 */
	pickup(consultationId: string): Promise<ConsultationPickupOutcome> {
		const current = this.state.consultation(consultationId);
		if (current === undefined || (current.state !== "queued" && current.state !== "unscheduled"))
			return Promise.resolve({ kind: "moved" });
		const type = this.config().consultationTypes[current.typeName];
		if (type === undefined) {
			// The type the record asks for is gone from the config: there is
			// nothing to start it with. The record becomes failed, as a start
			// that cannot fit does, and the queue's item leaves with it.
			this.state.setConsultationState(
				current.id,
				"failed",
				`unknown Consultation type ${current.typeName}`,
			);
			this.callbacks.onConsultationsChanged();
			this.status(
				"error",
				`Consultation ${current.id.slice(0, 8)} failed: unknown Consultation type ${current.typeName}`,
			);
			return Promise.resolve({ kind: "failed" });
		}
		this.state.updateConsultationTypeSettings(current.id, {
			agentType: type.agent,
			environment: type.environment,
			model: type.model ?? "",
			thinking: type.thinking ?? "",
			contextWindow: type.contextWindow ?? "",
			template: type.template,
			renderedOpeningPrompt: renderConsultationPrompt(type.template, current.initialInput),
		});
		// The atomic step is the seat: the record moves to `opening` only if it
		// is still `queued` or `unscheduled`, so a close or a delete that
		// raced the start wins the record and the start runs nothing.
		if (!this.state.beginConsultationStart(current.id)) {
			this.callbacks.onConsultationsChanged();
			return Promise.resolve({ kind: "moved" });
		}
		const refreshed = this.state.consultation(current.id);
		if (refreshed === undefined) {
			// The record went away between the move and the re-read.
			return Promise.resolve({ kind: "moved" });
		}
		// No await sits between the seat move and this call, so the record holds
		// no other opening operation: the launch always takes the job it is
		// handed, and reports its own outcome on the record and the Message line.
		void this.launch(refreshed);
		this.callbacks.onConsultationsChanged();
		return Promise.resolve({ kind: "started" });
	}

	/**
	 * Build the Replacement record of a Consultation the operator cannot continue.
	 *
	 * Only a missing or failed Consultation is replaced: the two Recovery
	 * required states the view offers `c` for. The new record carries the
	 * bounded recovery context, and the replaced record keeps its own state, so
	 * the failed work stays visible beside it. The view starts the replacement
	 * with `launch`, exactly as it starts a new Consultation.
	 */
	replace(replaced: Consultation, input: ConsultationReplacementInput): Consultation | undefined {
		const current = this.state.consultation(replaced.id) ?? replaced;
		if (current.state !== "missing" && current.state !== "failed") {
			this.status(
				"error",
				`a Replacement Consultation continues a missing or failed Consultation, not one that is ${current.state}`,
			);
			return undefined;
		}
		return this.create({
			...input,
			initialInput: input.initialInput ?? this.state.replacementInput(current.id),
			replacementOf: current.id,
		});
	}

	/** Persist an editable Response draft without accepting it for delivery. */
	saveDraft(consultation: Consultation, draft: string): void {
		this.state.setConsultationDraft(consultation.id, draft);
	}

	async respond(consultation: Consultation, draft: string): Promise<void> {
		const validation = validateResponseInput(draft);
		if (validation !== undefined) {
			this.status("error", validation);
			return;
		}

		let current: Consultation;
		try {
			current = this.state.consultation(consultation.id) ?? consultation;
		} catch (error) {
			this.status("error", `response failed: ${errorMessage(error)}`);
			return;
		}

		await serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				let latest: Consultation | undefined;
				let pending: ConsultationPendingResponse | undefined;
				let progressStarted = false;
				try {
					latest = this.state.consultation(current.id) ?? current;
					this.state.setConsultationDraft(latest.id, draft);
					pending = this.state.beginConsultationResponse(latest.id, draft, latest.latestSequence);
					if (pending === undefined) {
						this.status(
							"warning",
							"a response delivery is already pending or the Consultation changed; inspect the Agent before retrying",
						);
						return;
					}
					this.progress(current.id, `sending response to Consultation ${latest.id.slice(0, 8)}...`);
					progressStarted = true;
					const result = await this.runner.run("herdr", [
						"agent",
						"prompt",
						latest.agentName,
						draft,
					]);
					if (result.code !== 0) {
						this.state.cancelConsultationResponse(latest.id, pending.id);
						this.callbacks.onConsultationsChanged();
						this.status("error", `response failed: ${commandFailureText(result)}`);
						return;
					}
					const accepted = this.state.acceptConsultationResponse(latest.id, pending.id);
					this.callbacks.onConsultationsChanged();
					if (accepted === undefined) {
						this.status(
							"warning",
							"response was delivered; inspect the Agent output and the saved draft",
						);
					} else {
						this.callbacks.onStatus(null);
					}
				} catch (error) {
					if (latest !== undefined && pending !== undefined) {
						try {
							this.state.cancelConsultationResponse(latest.id, pending.id);
						} catch {}
					}
					try {
						this.callbacks.onConsultationsChanged();
					} catch {}
					this.status("error", `response failed: ${errorMessage(error)}`);
				} finally {
					if (progressStarted) this.endProgress(current.id);
				}
			},
		);
	}

	/**
	 * Take down the herdr environment a Consultation owns, and nothing else.
	 *
	 * The close holds its Repository queue for the whole cleanup, and a
	 * Force-close that runs while this one is queued or in flight cancels it:
	 * from that decision on, this cleanup issues no command at all.
	 */
	close(consultation: Consultation): Promise<void> {
		const current = this.state.consultation(consultation.id) ?? consultation;
		if (current.state === "closed") return Promise.resolve();
		if (this.closeOperations.has(current.id)) {
			this.status("warning", "Consultation close is already in progress");
			return Promise.resolve();
		}
		const started = current.state === "closing" || this.state.beginConsultationClose(current.id);
		if (!started) {
			this.status("warning", "Consultation is already closing or closed");
			return Promise.resolve();
		}
		// A Consultation recovered by handle can hold a pane the record never
		// registered: it is still the one this close takes down.
		if (current.paneId !== null && !current.resources.some((item) => item.kind === "pane"))
			this.state.recordConsultationResource(current.id, {
				kind: "pane",
				resourceId: current.paneId,
				owned: true,
				details: "Recovered Consultation Agent pane",
			});
		const operation: CloseOperation = { cancelled: false };
		this.closeOperations.set(current.id, operation);
		this.callbacks.onConsultationsChanged();
		this.progress(current.id, `closing Consultation ${current.id.slice(0, 8)}...`);
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				await this.runClose(current, operation);
			},
		).finally(() => {
			this.closeOperations.delete(current.id);
			this.endProgress(current.id);
		});
	}

	private async runClose(current: Consultation, operation: CloseOperation): Promise<void> {
		// Cancelled before it reached the head of the queue: the operator forced
		// this record closed, so herdr is left alone.
		if (operation.cancelled) return;
		try {
			const refreshed = this.state.consultation(current.id) ?? current;
			const owned = refreshed.resources.filter((item) => item.owned && !item.confirmedClosed);
			// The launch recorded no pane to take down: the record closes with no
			// command at all, and herdr is left alone.
			if (owned.find((item) => item.kind === "pane") === undefined) {
				this.state.finishConsultationClose(current.id);
				this.callbacks.onConsultationsChanged();
				this.status("info", `Consultation ${current.id.slice(0, 8)} closed`);
				return;
			}
			// Verify whose environment the stored handles still hold before the
			// close may take anything down: after a herdr restart, a pane or tab
			// id may be a reused id herdr gave another environment, and only the
			// Agent's own name or session says the handles are still its.
			const identity = await this.identifyCloseAgent(refreshed);
			// The shared guard: a Force-close that arrived while the probe ran
			// stops the cleanup here, before any resource is taken down.
			if (operation.cancelled) return;
			if (identity.kind === "none") {
				// An opening may still be booting its Agent: the close cannot tell
				// a missing Agent from a starting one, so it takes nothing down
				// and leaves the record for a retry or a Force-close. `current`
				// is the pre-close snapshot; the record is already `closing`.
				if (current.state === "opening")
					throw new Error(
						"the Agent is not visible, so the opening is unverified and the close cannot take down its environment",
					);
				// The Agent is gone, so there is nothing to stop: retire the
				// record and leave herdr untouched, the way the close of a record
				// with no Agent promises. The owned resources stay recorded as
				// remaining, so the operator sees what stands.
				this.state.finishConsultationClose(
					current.id,
					"closed without a command; its Agent is missing and its resources remain in herdr",
					true,
				);
				this.callbacks.onConsultationsChanged();
				this.status(
					"info",
					`Consultation ${current.id.slice(0, 8)} closed; its Agent is missing, so herdr was left untouched`,
				);
				return;
			}
			const agent = identity.agent;
			// Follow a matched Agent that moved: the close then addresses the
			// pane and tab the Agent holds, never the ones it left.
			if (
				agent.paneId !== refreshed.paneId ||
				(agent.tabId || null) !== refreshed.tabId ||
				(agent.workspaceId || null) !== refreshed.workspaceId ||
				(agent.stableSessionId !== undefined && agent.stableSessionId !== refreshed.sessionId)
			) {
				this.state.updateConsultationAgentHandles(current.id, {
					paneId: agent.paneId,
					tabId: agent.tabId || null,
					workspaceId: agent.workspaceId || null,
					sessionId: agent.stableSessionId ?? refreshed.sessionId,
				});
			}
			const latest = this.state.consultation(current.id) ?? refreshed;
			const output =
				latest.paneId === null
					? null
					: await new HerdrAgentReader(this.runner).readPane(
							latest.paneId,
							this.config().completionMessageLines,
						);
			if (operation.cancelled) return;
			// The last lines the control plane can still read become a partial
			// snapshot, so the history does not end with the opening prompt.
			if (output !== null) this.state.captureConsultationPartial(current.id, output);
			const settled = this.state.consultation(current.id) ?? latest;
			const plan = await this.planCloseCleanup(
				settled,
				settled.resources.filter((item) => item.owned && !item.confirmedClosed),
			);
			// The last check before the destructive call: a Force-close that ran
			// during the topology probe stops the cleanup here, not on the next
			// command.
			if (operation.cancelled) return;
			for (const retained of plan.retains)
				this.state.markConsultationResourceShared(
					current.id,
					retained.kind,
					retained.resourceId,
					retained.details,
				);
			// Retaining shared resources is durable work too. Do not let a
			// Force-close between the loop and the command produce a partial plan.
			if (operation.cancelled) return;
			if (plan.command !== undefined) {
				const result = await this.runner.run("herdr", plan.command);
				if (result.code !== 0) throw new Error(commandFailureText(result));
				// A close sends no focus command, whatever it takes down: the plane
				// never moves herdr's view on its own (ADR 0061), and a close of a
				// workspace the client is not viewing leaves that view alone.
				if (operation.cancelled) return;
				for (const resource of plan.closes)
					this.state.markConsultationResourceClosed(current.id, resource.kind, resource.resourceId);
			}
			if (operation.cancelled) return;
			this.state.finishConsultationClose(current.id);
			this.callbacks.onConsultationsChanged();
			this.status("info", `Consultation ${current.id.slice(0, 8)} closed`);
		} catch (error) {
			// A force-closed record needs no recovery warning: the operator
			// already accepted the resources that may remain.
			if (operation.cancelled) return;
			this.state.recordConsultationCloseFailure(current.id, errorMessage(error));
			this.callbacks.onConsultationsChanged();
			this.status("error", `Consultation close needs recovery: ${errorMessage(error)}`);
		}
	}

	/**
	 * Identify the Consultation's own Agent in herdr before the close may take
	 * anything down.
	 *
	 * The name the Agent runs under is the identity herdr enforces: it refuses
	 * to start a second Agent under a name a live Agent holds, so one named
	 * match is the Consultation's Agent. When this herdr version omits names, the
	 * check falls back to the stored session id, and then to the stored pane -
	 * the weak match the observation loop uses, never a bare pane or tab id:
	 * after a herdr restart that id may belong to another environment, and a
	 * close that took it down would take that environment with it.
	 */
	private async identifyCloseAgent(
		consultation: Consultation,
	): Promise<{ kind: "agent"; agent: HerdrAgent } | { kind: "none" }> {
		const probe = await new HerdrAgentReader(this.runner).listAgents();
		if (probe.kind === "error")
			throw new Error(`cannot verify the Consultation Agent's identity: ${probe.reason}`);
		const byName = probe.agents.filter((agent) => agent.name === consultation.agentName);
		if (byName.length === 1) {
			const agent = byName[0];
			if (
				agent.stableSessionId !== undefined &&
				consultation.sessionId !== null &&
				agent.stableSessionId !== consultation.sessionId
			)
				throw new Error("the Agent's session identity is ambiguous; the close needs recovery");
			return { kind: "agent", agent };
		}
		if (byName.length > 1)
			throw new Error("the Agent's name is held by more than one Agent; the close needs recovery");
		if (consultation.sessionId !== null) {
			const bySession = probe.agents.filter(
				(agent) => agent.stableSessionId === consultation.sessionId,
			);
			if (bySession.length === 1) return { kind: "agent", agent: bySession[0] };
			if (bySession.length > 1)
				throw new Error("the Agent's session identity is ambiguous; the close needs recovery");
		}
		const anyNamed = probe.agents.some((agent) => agent.name !== undefined);
		if (!anyNamed && consultation.paneId !== null) {
			const inStoredPane = probe.agents.find((agent) => agent.paneId === consultation.paneId);
			if (inStoredPane !== undefined) {
				// A contradicting session says the stored pane holds a foreign
				// Agent: the Consultation's own is not listed, so it is gone.
				if (
					consultation.sessionId !== null &&
					inStoredPane.stableSessionId !== undefined &&
					inStoredPane.stableSessionId !== consultation.sessionId
				)
					return { kind: "none" };
				return { kind: "agent", agent: inStoredPane };
			}
		}
		return { kind: "none" };
	}

	/**
	 * Choose the one command a close may issue, from what it owns alone.
	 *
	 * A worktree and its branch never close: the operator's work outlives the
	 * Consultation. An adopted workspace, and a tab that holds a foreign pane,
	 * belong to someone else: only what is inside them closes.
	 */
	private async planCloseCleanup(
		current: Consultation,
		resources: readonly ConsultationResource[],
	): Promise<ClosePlan> {
		const workspace = resources.find((item) => item.kind === "workspace");
		const tab = resources.find((item) => item.kind === "tab");
		const pane = resources.find((item) => item.kind === "pane");
		const agent = resources.find((item) => item.kind === "agent");
		const worktrees = resources
			.filter((item) => item.kind === "worktree")
			.map((item) => ({
				kind: item.kind,
				resourceId: item.resourceId,
				details: WORKTREE_REMAIN,
			}));
		const withAgent = (closes: ConsultationResource[]): ConsultationResource[] =>
			agent === undefined ? closes : [...closes, agent];
		const sharedWorkspace =
			workspace === undefined ? [] : [{ kind: workspace.kind, resourceId: workspace.resourceId }];
		const workspaceId = workspace?.resourceId ?? current.workspaceId;
		// Nothing to take down, so nothing is proved shared: the resources stay
		// recorded exactly as the launch left them.
		if (pane === undefined) return { command: undefined, closes: [], retains: [] };
		if (workspaceId === null)
			// No workspace handle to probe the topology of: the pane is still the
			// Consultation's own, and everything else stands as it is.
			return {
				command: ["pane", "close", pane.resourceId],
				closes: withAgent([pane]),
				retains: [],
			};
		const topology = await workspaceTopology(
			this.runner,
			workspaceId,
			pane.resourceId,
			tab?.resourceId ?? current.tabId,
		);
		if (!topology.known) throw new Error("could not verify the Consultation workspace topology");
		// Only an owned workspace may be closed whole: an adopted workspace
		// belongs to someone else even while it stands empty.
		if (topology.workspaceExclusive && workspace !== undefined)
			return {
				command: ["workspace", "close", workspace.resourceId],
				closes: resources.filter((item) => item.kind !== "worktree"),
				retains: worktrees,
			};
		if (topology.ownedTabExclusive && tab !== undefined)
			return {
				command: ["tab", "close", tab.resourceId],
				closes: withAgent([tab, pane]),
				retains: [...sharedWorkspace, ...worktrees],
			};
		// A foreign pane shares the owned tab: close the Consultation's pane
		// alone, and leave the tab and the workspace beside it.
		return {
			command: ["pane", "close", pane.resourceId],
			closes: withAgent([pane]),
			retains: [
				...sharedWorkspace,
				...(tab === undefined ? [] : [{ kind: tab.kind, resourceId: tab.resourceId }]),
				...worktrees,
			],
		};
	}

	/**
	 * Close the record, keep every resource, and stop any cleanup still queued.
	 *
	 * A Force-close answers a herdr that cannot confirm its work. It records
	 * what may remain and runs nothing: it never removes a worktree or a
	 * branch, so the operator's work survives.
	 */
	forceClose(consultation: Consultation): void {
		const current = this.state.consultation(consultation.id) ?? consultation;
		// The guard is shared with close: a pending or queued cleanup learns of
		// this decision before its next external call, so it stops there.
		const pending = this.closeOperations.get(current.id);
		if (pending !== undefined) pending.cancelled = true;
		// A closed record is never opened again by a Force-close: its resources
		// were confirmed or recorded as remaining when it closed.
		if (current.state === "closed") {
			this.status("warning", "Consultation cleanup has already finished");
			return;
		}
		if (current.state !== "closing" && !this.state.beginConsultationClose(current.id)) {
			this.status("warning", "Consultation cleanup has already finished");
			return;
		}
		this.state.finishConsultationClose(
			current.id,
			"force-closed by operator; owned resources may remain",
			true,
		);
		this.callbacks.onConsultationsChanged();
		this.status(
			"warning",
			`Consultation ${current.id.slice(0, 8)} force-closed; recovery resources remain recorded`,
		);
	}

	delete(consultation: Consultation): boolean {
		if (!this.state.deleteConsultation(consultation.id)) return false;
		this.callbacks.onConsultationsChanged();
		this.status(
			"info",
			`Consultation ${consultation.id.slice(0, 8)} deleted; backups may retain data`,
		);
		return true;
	}

	/**
	 * Schedule an `unscheduled` Consultation back into the Work queue (issue
	 * #91): the record returns to `queued` and waits at the queue's tail, with
	 * its pickup the only starter. The answer of the state's one write, so a
	 * record that left `unscheduled` behind the key says its own fact.
	 */
	schedule(consultation: Consultation): boolean {
		const result = this.state.scheduleConsultation(consultation.id);
		if (!result.ok) {
			this.status("error", result.reason);
			return false;
		}
		this.callbacks.onConsultationsChanged();
		this.status(
			"info",
			`Consultation ${consultation.id.slice(0, 8)} scheduled: it waits at the end of the Work queue`,
		);
		return true;
	}

	/**
	 * Approve the live checkout conflict set, and continue the launch.
	 *
	 * The confirmation belongs to the checkout, not to this opening. It stores
	 * the union of the checkout's previously confirmed identities and the
	 * panel's conflicts, before the Agent starts, so a crash after confirming
	 * never re-asks. A later launch into the checkout asks again only when a
	 * conflict identity appears that is not in the confirmed set, whatever
	 * Consultation opens it.
	 */
	async confirmSafetyConflict(
		consultation: Consultation,
		conflicts: readonly CheckoutConflict[],
	): Promise<void> {
		const current = this.state.consultation(consultation.id);
		if (current === undefined) return;
		const key = await realPathOf(current.repository.path);
		const confirmed = new Set(this.state.confirmedCheckoutConflicts(key));
		for (const conflict of conflicts) confirmed.add(conflict.identity);
		this.state.recordCheckoutConflictConfirmation(key, [...confirmed]);
		await this.launch(current);
	}

	replacementInput(consultationId: string): string {
		return this.state.replacementInput(consultationId);
	}

	/**
	 * Record the Stale Agent output of one display refresh.
	 *
	 * A failed read is the only thing that sets it, and a read that returns
	 * clears it again, whatever wrote it: the observation settles a turn
	 * without output through the same warning, and a later good read proves
	 * the view is current again.
	 */
	recordOutputRead(consultationId: string, output: string | null): void {
		const current = this.state.consultation(consultationId);
		if (current === undefined) return;
		if (output === null) {
			if (isStaleAgentOutputWarning(current.warning)) return;
			this.state.setConsultationWarning(consultationId, STALE_AGENT_OUTPUT_WARNING);
			this.callbacks.onConsultationsChanged();
			return;
		}
		if (!isStaleAgentOutputWarning(current.warning)) return;
		this.state.setConsultationWarning(consultationId, null);
		this.callbacks.onConsultationsChanged();
	}

	/** Queue one Agent terminal input event, in terminal order. */
	enqueue(paneId: string, event: AgentInputEvent): Promise<CommandResult> {
		return this.inputQueue.enqueue(paneId, event);
	}

	/** Settle queued input before the control plane takes keyboard ownership. */
	flush(): Promise<void> {
		return this.inputQueue.flush();
	}

	private claimOpening(id: string): boolean {
		if (this.openingOperations.has(id)) return false;
		this.openingOperations.add(id);
		return true;
	}

	private async runOpening(consultation: Consultation): Promise<void> {
		try {
			const outcome = await serializeRepositoryOperation(
				this.operationQueues,
				consultation.repository.identity,
				async (): Promise<LaunchOutcome | undefined> => {
					const current = this.state.consultation(consultation.id) ?? consultation;
					// A queued opening can outlive a close or Force-close. Do not start
					// an Agent after the operator has settled that record.
					if (current.state !== "opening") return undefined;
					const onStage = (stage: string) =>
						this.progress(current.id, `Consultation ${current.id.slice(0, 8)}: ${stage}`);
					const startCheck = await checkConsultationStart({
						consultation: current,
						config: this.config(),
						runner: this.runner,
					});
					if (!startCheck.ok) return { status: "failed", reason: startCheck.reason };
					let resolvedRepository: ResolvedRepository | undefined;
					if (current.environment === "live-worktree") {
						onStage("resolving-repository");
						const resolution = await resolveRepository(
							{
								identity: current.repository.identity,
								displayName: current.repository.displayName,
								cloneUrl: current.repository.cloneUrl,
							},
							this.config(),
							{ runner: this.runner, home: this.home },
						);
						if (!resolution.ok) return { status: "failed", reason: resolution.reason };
						resolvedRepository = resolution.repository;
						this.state.setConsultationRepositoryPath(current.id, resolvedRepository.path);
						onStage("checking-live-checkout-safety");
						const probe = await new HerdrAgentReader(this.runner).listAgents();
						if (probe.kind === "error")
							return {
								status: "failed",
								reason: `cannot verify live checkout safety: ${probe.reason}`,
							};
						const safety = await inspectLiveCheckout(
							resolvedRepository.path,
							this.runner,
							this.tickets(),
							this.state.consultations("open"),
							probe.agents,
						);
						if (safety.warning !== undefined)
							this.state.setConsultationWarning(current.id, safety.warning);
						// The safety question belongs to the checkout, not to this
						// opening: the launch asks again only when the current
						// conflict set holds an identity the checkout has not
						// confirmed, and a launch that proceeds stores the current
						// set, so a shrunken set is persisted and never re-asked.
						const key = await realPathOf(resolvedRepository.path);
						const confirmed = this.state.confirmedCheckoutConflicts(key);
						if (safety.conflicts.some((conflict) => !confirmed.includes(conflict.identity)))
							return { status: "conflict", safety };
						this.state.recordCheckoutConflictConfirmation(
							key,
							safety.conflicts.map((conflict) => conflict.identity),
						);
					}
					return handOffConsultation({
						consultation: current,
						config: this.config(),
						runner: this.runner,
						home: this.home,
						onStage,
						startCheck,
						resolvedRepository,
						onRepositoryResolved: (path) =>
							this.state.setConsultationRepositoryPath(current.id, path),
						onAgentStarted: (agent) => {
							this.state.recordConsultationAgentHandles(current.id, agent);
							this.state.recordConsultationResource(current.id, {
								kind: "pane",
								resourceId: agent.paneId,
								owned: true,
								details: "Consultation Agent pane",
							});
							this.state.recordConsultationResource(current.id, {
								kind: "agent",
								resourceId: current.agentName,
								owned: true,
								details: `Agent hosted by pane ${agent.paneId}`,
							});
						},
						onResource: (kind, resourceId, owned, details) =>
							this.state.recordConsultationResource(current.id, {
								kind,
								resourceId,
								owned,
								details: details ?? "",
							}),
					});
				},
			);
			if (outcome === undefined) return;
			if (outcome.status === "conflict") {
				this.callbacks.onSafetyConflict({
					consultationId: consultation.id,
					safety: outcome.safety,
				});
				this.status("warning", "live checkout conflict: explicit confirmation is required");
				this.callbacks.onConsultationsChanged();
				return;
			}
			await this.finishOpening(consultation, outcome);
		} catch (error) {
			this.state.failConsultationOpening(consultation.id, errorMessage(error));
			this.callbacks.onConsultationsChanged();
			this.status(
				"error",
				`Consultation ${consultation.id.slice(0, 8)} failed: ${errorMessage(error)}`,
			);
		}
	}

	private async finishOpening(
		consultation: Consultation,
		outcome: ConsultationHandoffOutcome,
	): Promise<void> {
		const mappingWarning =
			outcome.notes?.mappingToWrite === undefined || this.persistRepositoryMapping === undefined
				? undefined
				: await this.persistRepositoryMapping(outcome.notes.mappingToWrite);
		const lines = [
			...(outcome.status === "ok" ? [] : [outcome.reason]),
			...(outcome.status === "ok" && outcome.notes?.warning !== undefined
				? [outcome.notes.warning]
				: []),
			...(mappingWarning === undefined ? [] : [mappingWarning]),
			...(outcome.status === "ok" && outcome.notes?.worktreeBase !== undefined
				? [outcome.notes.worktreeBase]
				: []),
		];
		if (outcome.status === "failed") {
			this.state.failConsultationOpening(consultation.id, lines.join("; ") || outcome.reason);
			this.status(
				"error",
				`Consultation ${consultation.id.slice(0, 8)} failed: ${lines.join("; ")}`,
			);
		} else {
			this.state.setConsultationAgent(consultation.id, {
				paneId: outcome.agent.paneId,
				tabId: outcome.agent.tabId,
				workspaceId: outcome.agent.workspaceId,
				sessionId: outcome.agent.sessionId,
			});
			if (outcome.status === "prompt-failed") {
				this.state.setConsultationDraft(consultation.id, consultation.renderedOpeningPrompt);
				this.status("error", outcome.reason);
			} else if (lines.length > 0) this.status("warning", lines.join("; "));
		}
		const warning = this.state.consultation(consultation.id)?.warning;
		if (warning !== null && warning !== undefined) this.status("warning", warning);
		this.callbacks.onConsultationsChanged();
	}

	private status(kind: ConsultationStatus["kind"], text: string): void {
		this.callbacks.onStatus({ kind, text });
	}

	/**
	 * One step of a running operation: progress, not an outcome.
	 *
	 * The shell shows it on the Message line as Working progress under the
	 * Consultation's own owner, so a sibling operation in another repository
	 * keeps its line. An outcome the operator must read - a closed
	 * Consultation, a refused launch - is never a step: it goes through
	 * `status`, so it outranks nothing and survives the operation that ended.
	 */
	private progress(owner: string, text: string): void {
		this.callbacks.onProgress(text, owner);
	}

	/** End the progress line the settled operation owns, and only that one. */
	private endProgress(owner: string): void {
		this.callbacks.onProgress(null, owner);
	}
}

async function workspaceTopology(
	runner: CommandRunner,
	workspaceId: string,
	ownedPaneId: string | null,
	ownedTabId: string | null,
): Promise<{ known: boolean; workspaceExclusive: boolean; ownedTabExclusive: boolean }> {
	const [tabs, panes] = await Promise.all([
		runner.run("herdr", ["tab", "list", "--workspace", workspaceId]),
		runner.run("herdr", ["pane", "list", "--workspace", workspaceId]),
	]);
	if (tabs.code !== 0 || panes.code !== 0)
		return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
	try {
		const tabData = JSON.parse(tabs.stdout) as { result?: { tabs?: unknown } };
		const paneData = JSON.parse(panes.stdout) as { result?: { panes?: unknown } };
		if (!Array.isArray(tabData.result?.tabs) || !Array.isArray(paneData.result?.panes))
			return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
		if (
			!tabData.result.tabs.every((tab) => isRecordValue(tab) && typeof tab.tab_id === "string") ||
			!paneData.result.panes.every(
				(pane) =>
					isRecordValue(pane) &&
					typeof pane.pane_id === "string" &&
					typeof pane.tab_id === "string",
			)
		)
			return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
		const otherTabs = tabData.result.tabs.filter(
			(tab) => (tab as { tab_id: string }).tab_id !== ownedTabId,
		);
		const panesInOwnedTab = paneData.result.panes.filter(
			(pane) => (pane as { tab_id: string }).tab_id === ownedTabId,
		);
		const foreignPanesInOwnedTab = panesInOwnedTab.filter(
			(pane) => (pane as { pane_id: string }).pane_id !== ownedPaneId,
		);
		return {
			known: true,
			workspaceExclusive: otherTabs.length === 0 && foreignPanesInOwnedTab.length === 0,
			ownedTabExclusive: foreignPanesInOwnedTab.length === 0,
		};
	} catch {
		return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
	}
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
