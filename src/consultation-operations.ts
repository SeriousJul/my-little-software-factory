/**
 * Consultation lifecycle operations.
 *
 * The control plane owns the Consultation screens, but this module owns every
 * external lifecycle change. It keeps the operation queue and the interrupted
 * opening guard private so launch, recovery, response, and close operations
 * cannot race on one Repository.
 */
import { randomUUID } from "node:crypto";

import type { FactoryConfig } from "./config.ts";
import {
	type AgentInputEvent,
	ConsultationInputQueue,
	type ConsultationRepositoryOption,
	inspectLiveCheckout,
	type LiveCheckoutSafety,
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
import { consultationAgentName } from "./naming.ts";
import { HerdrAgentReader, matchConsultationAgent } from "./observation.ts";
import { type RepositoryMapping, type ResolvedRepository, resolveRepository } from "./repo.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";
import type { Consultation, ConsultationResource, FactoryState } from "./state.ts";

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

/** The small interface of the Consultation lifecycle module. */
export interface ConsultationOperationsInterface {
	/** Create a durable opening record without starting external work. */
	create(input: ConsultationCreateInput): Consultation | undefined;
	/** Start an existing opening record. */
	launch(consultation: Consultation): Promise<void>;
	/** Recover an interrupted opening or verify its surviving Agent. */
	recover(consultation: Consultation): Promise<void>;
	/** Create and start a linked Replacement Consultation. */
	replace(replaced: Consultation, input: ConsultationReplacementInput): Consultation | undefined;
	/** Build the bounded context shown in the replacement launcher. */
	replacementInput(consultationId: string): string;
	/** Deliver a validated response draft to an awaiting Consultation. */
	respond(consultation: Consultation, draft: string): Promise<void>;
	/** Close owned resources and finish the Consultation when cleanup is confirmed. */
	close(consultation: Consultation): Promise<void>;
	/** Close the record while retaining every unconfirmed owned resource. */
	forceClose(consultation: Consultation): void;
	/** Delete closed local history. */
	delete(consultation: Consultation): boolean;
	/** Confirm a live checkout conflict once, then continue the launch. */
	confirmSafetyConflict(consultation: Consultation): void;
	/** Record whether the latest Agent output read was stale. */
	recordOutputRead(consultationId: string, output: string | null): void;
	/** Queue one Agent terminal input event. */
	enqueue(
		paneId: string,
		event: AgentInputEvent,
	): Promise<ReturnType<CommandRunner["run"]> extends Promise<infer Result> ? Result : never>;
	/** Flush terminal input before the control plane takes keyboard ownership. */
	flush(): Promise<void>;
	/** Explicit aliases used by the view adapter. */
	enqueueInput(
		paneId: string,
		event: AgentInputEvent,
	): Promise<ReturnType<CommandRunner["run"]> extends Promise<infer Result> ? Result : never>;
	flushInput(): Promise<void>;
}

interface LaunchConflict {
	status: "conflict";
	safety: LiveCheckoutSafety;
}

type LaunchOutcome = ConsultationHandoffOutcome | LaunchConflict;

const STALE_OUTPUT_WARNING = "Stale Agent output";
const WORKTREE_REMAIN = "retained after close: worktree and branch remain";

export function createConsultationOperations(
	options: ConsultationOperationsOptions,
): ConsultationOperations {
	return new ConsultationOperations(options);
}

export class ConsultationOperations implements ConsultationOperationsInterface {
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

	replace(replaced: Consultation, input: ConsultationReplacementInput): Consultation | undefined {
		const replacement = this.create({
			...input,
			initialInput: input.initialInput ?? this.state.replacementInput(replaced.id),
			replacementOf: replaced.id,
		});
		if (replacement !== undefined) void this.launch(replacement);
		return replacement;
	}

	respond(consultation: Consultation, draft: string): Promise<void> {
		const validation = validateResponseInput(draft);
		if (validation !== undefined) {
			this.status("error", validation);
			return Promise.resolve();
		}
		const current = this.state.consultation(consultation.id) ?? consultation;
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				const latest = this.state.consultation(current.id) ?? current;
				this.state.setConsultationDraft(latest.id, draft);
				const pending = this.state.beginConsultationResponse(
					latest.id,
					draft,
					latest.latestSequence,
				);
				if (pending === undefined) {
					this.status(
						"warning",
						"a response delivery is already pending or the Consultation changed; inspect the Agent before retrying",
					);
					return;
				}
				this.status("info", `sending response to Consultation ${latest.id.slice(0, 8)}...`);
				try {
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
					this.state.cancelConsultationResponse(latest.id, pending.id);
					this.callbacks.onConsultationsChanged();
					this.status("error", `response failed: ${errorMessage(error)}`);
				}
			},
		);
	}

	close(consultation: Consultation): Promise<void> {
		const current = this.state.consultation(consultation.id) ?? consultation;
		if (current.state === "closed") return Promise.resolve();
		const started = current.state === "closing" || this.state.beginConsultationClose(current.id);
		if (!started) {
			this.status("warning", "Consultation is already closing or closed");
			return Promise.resolve();
		}
		if (current.paneId !== null && !current.resources.some((item) => item.kind === "pane"))
			this.state.recordConsultationResource(current.id, {
				kind: "pane",
				resourceId: current.paneId,
				owned: true,
				details: "Recovered Consultation Agent pane",
			});
		this.callbacks.onConsultationsChanged();
		this.status("info", `closing Consultation ${current.id.slice(0, 8)}...`);
		return serializeRepositoryOperation(
			this.operationQueues,
			current.repository.identity,
			async () => {
				try {
					const output =
						current.paneId === null
							? null
							: await new HerdrAgentReader(this.runner).readPane(
									current.paneId,
									this.config().completionMessageLines,
								);
					if (output !== null) this.state.captureConsultationPartial(current.id, output);
					const refreshed = this.state.consultation(current.id) ?? current;
					const resources = refreshed.resources.filter(
						(item) => item.owned && !item.confirmedClosed,
					);
					const workspace = resources.find((item) => item.kind === "workspace");
					const tab = resources.find((item) => item.kind === "tab");
					const pane = resources.find((item) => item.kind === "pane");
					const agent = resources.find((item) => item.kind === "agent");
					const worktrees = resources.filter((item) => item.kind === "worktree");
					const markWorktreesRetained = () => {
						for (const resource of worktrees)
							this.state.markConsultationResourceShared(
								current.id,
								resource.kind,
								resource.resourceId,
								WORKTREE_REMAIN,
							);
					};
					let command: readonly string[] | undefined;
					let closes: ConsultationResource[] = [];
					const workspaceId = workspace?.resourceId ?? current.workspaceId;
					if (workspaceId !== null && pane !== undefined) {
						const topology = await workspaceTopology(
							this.runner,
							workspaceId,
							pane.resourceId,
							tab?.resourceId ?? current.tabId,
						);
						if (!topology.known)
							throw new Error("could not verify the Consultation workspace topology");
						if (topology.workspaceExclusive && workspace !== undefined) {
							command = ["workspace", "close", workspace.resourceId];
							closes = resources.filter((item) => item.kind !== "worktree");
							markWorktreesRetained();
						} else if (topology.ownedTabExclusive && tab !== undefined) {
							command = ["tab", "close", tab.resourceId];
							closes = [tab, pane, ...(agent === undefined ? [] : [agent])];
							if (workspace !== undefined)
								this.state.markConsultationResourceShared(
									current.id,
									"workspace",
									workspace.resourceId,
								);
							markWorktreesRetained();
						} else {
							command = ["pane", "close", pane.resourceId];
							closes = [pane, ...(agent === undefined ? [] : [agent])];
							if (workspace !== undefined)
								this.state.markConsultationResourceShared(
									current.id,
									"workspace",
									workspace.resourceId,
								);
							if (tab !== undefined)
								this.state.markConsultationResourceShared(current.id, "tab", tab.resourceId);
							markWorktreesRetained();
						}
					} else if (pane !== undefined) {
						command = ["pane", "close", pane.resourceId];
						closes = [pane, ...(agent === undefined ? [] : [agent])];
					}
					if (command !== undefined) {
						const result = await this.runner.run("herdr", command);
						if (result.code !== 0) throw new Error(commandFailureText(result));
						for (const resource of closes)
							this.state.markConsultationResourceClosed(
								current.id,
								resource.kind,
								resource.resourceId,
							);
					}
					this.state.finishConsultationClose(current.id);
					this.callbacks.onConsultationsChanged();
					this.status("info", `Consultation ${current.id.slice(0, 8)} closed`);
				} catch (error) {
					this.state.recordConsultationCloseFailure(current.id, errorMessage(error));
					this.callbacks.onConsultationsChanged();
					this.status("error", `Consultation close needs recovery: ${errorMessage(error)}`);
				}
			},
		);
	}

	forceClose(consultation: Consultation): void {
		const current = this.state.consultation(consultation.id) ?? consultation;
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

	confirmSafetyConflict(consultation: Consultation): void {
		this.state.setConsultationLiveConflictOverride(consultation.id);
		const current = this.state.consultation(consultation.id);
		if (current !== undefined) void this.launch(current);
	}

	replacementInput(consultationId: string): string {
		return this.state.replacementInput(consultationId);
	}

	recordOutputRead(consultationId: string, output: string | null): void {
		const current = this.state.consultation(consultationId);
		if (current === undefined) return;
		const stale = output === null;
		if (stale && current.warning !== STALE_OUTPUT_WARNING) {
			this.state.setConsultationWarning(consultationId, STALE_OUTPUT_WARNING);
			this.callbacks.onConsultationsChanged();
		} else if (!stale && current.warning === STALE_OUTPUT_WARNING) {
			this.state.setConsultationWarning(consultationId, null);
			this.callbacks.onConsultationsChanged();
		}
	}

	enqueue(paneId: string, event: AgentInputEvent): ReturnType<CommandRunner["run"]> {
		return this.inputQueue.enqueue(paneId, event);
	}

	flush(): Promise<void> {
		return this.inputQueue.flush();
	}

	enqueueInput(paneId: string, event: AgentInputEvent): ReturnType<CommandRunner["run"]> {
		return this.enqueue(paneId, event);
	}

	flushInput(): Promise<void> {
		return this.flush();
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
				async (): Promise<LaunchOutcome> => {
					const current = this.state.consultation(consultation.id) ?? consultation;
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
						const resolution = await resolveConsultationRepository(
							current,
							this.config(),
							this.runner,
							this.home,
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

async function resolveConsultationRepository(
	consultation: Consultation,
	config: FactoryConfig,
	runner: CommandRunner,
	home: string,
): Promise<{ ok: true; repository: ResolvedRepository } | { ok: false; reason: string }> {
	return resolveRepository(
		{
			identity: consultation.repository.identity,
			displayName: consultation.repository.displayName,
			cloneUrl: consultation.repository.cloneUrl,
		},
		config,
		{ runner, home },
	);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
