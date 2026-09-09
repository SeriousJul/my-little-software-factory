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
	restoreControlPlaneFocus,
} from "./handoff.ts";
import { consultationAgentName } from "./naming.ts";
import { HerdrAgentReader, matchConsultationAgent } from "./observation.ts";
import { type RepositoryMapping, type ResolvedRepository, resolveRepository } from "./repo.ts";
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
	/** The durable Consultation projection changed. */
	onConsultationsChanged: () => void;
	/** A live checkout needs the view to show its one-shot confirmation panel. */
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
	/**
	 * The workspace the control plane runs in, when it runs inside herdr.
	 *
	 * A workspace close moves herdr's focus off the closed workspace, so the
	 * cleanup returns it here: the operator worked the close from the control
	 * plane. Outside herdr there is none, and herdr's own choice stands.
	 */
	controlPlaneWorkspaceId?: string | null;
	textBatchBytes?: number;
}

export interface ConsultationCreateInput {
	typeName: string;
	repository: ConsultationRepositoryOption;
	initialInput: string;
	replacementOf?: string | null;
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
	private readonly controlPlaneWorkspaceId: string | null;
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
		this.controlPlaneWorkspaceId = options.controlPlaneWorkspaceId ?? null;
		this.inputQueue = new ConsultationInputQueue(this.runner, options.textBatchBytes);
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
		this.status("info", `opening Consultation ${consultation.id.slice(0, 8)}...`);
		return this.runOpening(consultation).finally(() => {
			this.openingOperations.delete(consultation.id);
		});
	}

	recover(consultation: Consultation): Promise<void> {
		const current = this.state.consultation(consultation.id);
		if (current === undefined || !this.state.canRecoverConsultationOpening(current.id))
			return Promise.resolve();
		if (current.paneId === null && current.sessionId === null) {
			this.status("info", `recovering Consultation ${current.id.slice(0, 8)}...`);
			return this.launch(current);
		}
		if (!this.claimOpening(current.id)) {
			this.status("info", "Consultation opening is already in progress");
			return Promise.resolve();
		}
		this.status("info", `verifying Consultation ${current.id.slice(0, 8)} Agent...`);
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
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
			.finally(() => this.openingOperations.delete(current.id));
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
					this.status("info", `sending response to Consultation ${latest.id.slice(0, 8)}...`);
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
		this.status("info", `closing Consultation ${current.id.slice(0, 8)}...`);
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				await this.runClose(current, operation);
			},
		).finally(() => {
			this.closeOperations.delete(current.id);
		});
	}

	private async runClose(current: Consultation, operation: CloseOperation): Promise<void> {
		// Cancelled before it reached the head of the queue: the operator forced
		// this record closed, so herdr is left alone.
		if (operation.cancelled) return;
		try {
			const refreshed = this.state.consultation(current.id) ?? current;
			const output =
				refreshed.paneId === null
					? null
					: await new HerdrAgentReader(this.runner).readPane(
							refreshed.paneId,
							this.config().completionMessageLines,
						);
			if (operation.cancelled) return;
			// The last lines the control plane can still read become a partial
			// snapshot, so the history does not end with the opening prompt.
			if (output !== null) this.state.captureConsultationPartial(current.id, output);
			const latest = this.state.consultation(current.id) ?? refreshed;
			const resources = latest.resources.filter((item) => item.owned && !item.confirmedClosed);
			const plan = await this.planCloseCleanup(latest, resources);
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
				if (operation.cancelled) return;
				// A closed workspace moves herdr's focus (a linked worktree
				// removal lands on the repository's parent, a closed workspace
				// on a neighbor): return it to the control plane, where the
				// operator worked the close. A tab or pane close keeps the
				// workspace, so herdr's focus stands.
				if (plan.command[0] === "workspace")
					await restoreControlPlaneFocus(this.runner, this.controlPlaneWorkspaceId);
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
	 * Approve a live checkout conflict once, and continue the launch.
	 *
	 * The override is one-shot and durable: it belongs to this opening, so a
	 * later launch of another Consultation is checked again.
	 */
	confirmSafetyConflict(consultation: Consultation): void {
		this.state.setConsultationLiveConflictOverride(consultation.id);
		const current = this.state.consultation(consultation.id);
		if (current !== undefined) void this.launch(current);
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
						this.status("info", `Consultation ${current.id.slice(0, 8)}: ${stage}`);
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
						if (
							safety.conflicts.length > 0 &&
							this.state.consultation(current.id)?.liveConflictOverride !== true
						)
							return { status: "conflict", safety };
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
