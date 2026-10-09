/**
 * The Seeded plane: one deep fixture for the control plane's test suite.
 *
 * A test asks for the standing it wants in one call, and the module opens
 * the whole plane behind that interface: the state file seeded through the
 * state module, the config file, the home directory, the checkout
 * directories, the Command runner double, the Ticket source doubles, and the
 * props the App boots from. The test names the standing - "the sample
 * Tickets, one Consultation working, the flat Grouping axis" - and does not
 * name the aggregate calls, the directories, or the props shape that
 * produce it.
 *
 * The module sits above the seams the plane already has - the state
 * module's open seam, the Command runner seam, and the Ticket source seam -
 * and hands their composition to the caller at the highest seam the suite
 * already crosses: the App's boot record. The App's own interface is not
 * changed by this module; the record it returns is the record the App
 * takes.
 *
 * The module holds no rule of the plane. Where a standing needs a rule the
 * plane owns - the work cycle's state moves, the Handoff's claim and
 * settle, the turn's settle - it calls the state module's own
 * aggregates, so a standing the state module would never produce cannot be
 * seeded here.
 */

import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configToToml, type FactoryConfig, type TicketSourceConfig } from "../src/config.ts";
import type { GroupingAxis } from "../src/domain/grouping.ts";
import type { EnvironmentKind, FetchedTicket, Ticket } from "../src/domain/ticket.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import type { CommandRunner } from "../src/runner.ts";
import type {
	ConsultationRepository,
	ConsultationState,
} from "../src/state/consultation-record.ts";
import type { HandoffOrigin } from "../src/state/handoff.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

/**
 * One configured source and the Tickets it lists. The source config is what
 * the plane's config carries, and the tickets are what the source's first
 * fetch reports: the state module seeds its source facts and its Ticket
 * rows from them.
 */
export interface SeededSource {
	/** The source config the plane's config carries. */
	config: TicketSourceConfig;
	/** The tickets the source lists, as the list rule reads them. */
	tickets: readonly Ticket[];
}

/**
 * One Consultation record the standing seeds. The fields are the record's
 * own facts, the way `createConsultation` names them.
 */
export interface ConsultationSeed {
	id?: string;
	typeName: string;
	agentType: string;
	environment: EnvironmentKind;
	model?: string;
	thinking?: string;
	contextWindow?: string;
	template: string;
	initialInput: string;
	renderedOpeningPrompt: string;
	repository: ConsultationRepository;
	agentName: string;
	createdAt?: string;
	/** Records the Consultation Agent's herdr handles. */
	agent?: boolean;
	/** Records the Consultation's owned resource set. */
	resources?: boolean;
	/** The state the record holds beside the agent it seeded. */
	state?: ConsultationState;
	stateDetail?: string | null;
	/** The draft the record holds. */
	draft?: string;
}

/**
 * One Work queue row the standing seeds, in the words the queue's own
 * enqueue takes.
 */
export type WorkQueueSeed =
	| {
			kind: "handoff";
			ticketIdentity: string;
			origin: HandoffOrigin;
			choice: HandoffChoice;
			previousMessage: string;
			automatic?: boolean;
			routeFromIdentity?: string | null;
	  }
	| {
			kind: "plane-action";
			ticketIdentity: string;
			origin: HandoffOrigin;
			taskType: string;
			automatic?: boolean;
			routeFromIdentity?: string | null;
	  };

/**
 * The standing a test asks for. Every field is a fact of the plane, stated
 * in the plane's own vocabulary. Nothing here names an aggregate call.
 */
export interface SeededPlaneStanding {
	/**
	 * The sources of the plane and the tickets they list. The default is the
	 * one issues source that lists the sample tickets, so a suite that names
	 * no standing gets the standing the frame suites were written against.
	 */
	sources?: readonly SeededSource[];
	/** The config, as an override of the base config the suite shares. */
	config?: Partial<FactoryConfig>;
	/** The Consultation records the standing seeds. */
	consultations?: readonly ConsultationSeed[];
	/** The Work queue rows the standing seeds. */
	queue?: readonly WorkQueueSeed[];
	/** The sources the operator muted before the plane booted. */
	mutedSources?: readonly string[];
	/** The Auto-handoff mode the state file holds before the App mounts. */
	autoHandoffMode?: boolean;
	/** The Work queue's brake, where the operator left it. */
	queuePaused?: boolean;
	/** The Grouping axis of the Ticket section. The default is the flat axis. */
	groupingAxis?: GroupingAxis;
	/** The clock the state file writes from. The default is the machine clock. */
	now?: () => number;
	/** The egress double the plane runs on. The default is the FakeRunner. */
	runner?: (fake: FakeRunner) => CommandRunner;
	/** The per-case Command runner answers, run over the FakeRunner. */
	commands?: (fake: FakeRunner) => void;
}

/**
 * The whole plane, opened and seeded. The fields a caller reads are named by
 * what they are, not by how the module built them.
 */
export interface SeededPlane {
	/** The state file, seeded to the standing. */
	state: FactoryState;
	/** The config the plane runs under. */
	config: FactoryConfig;
	/** The config file the plane writes to, on disk beside the state. */
	configPath: string;
	/** The home directory the plane's paths live under. */
	home: string;
	/** The Command runner double the App runs on. */
	runner: CommandRunner;
	/** The FakeRunner the answers and the command record stand on. */
	fakeRunner: FakeRunner;
	/** The bound source doubles, in the config's source order. */
	sources: TicketSource[];
	/**
	 * Close the state file and remove the directories the plane made. Safe to
	 * call twice: the state's own close is idempotent, and the directories
	 * are gone after the first pass.
	 */
	close(): void;
}

/** The directories and state files every opened plane registers for cleanup. */
interface PlaneRegistration {
	plane: SeededPlane;
}
const registrations: PlaneRegistration[] = [];

/**
 * The plane's directories go when the test ends, however the test ends. The
 * state file closes first, so a background loop never reads a closed
 * database's neighbor: the close is idempotent, and a plane the test closed
 * on its own leaves nothing here to do.
 */
afterEach(() => {
	for (const { plane } of registrations.splice(0)) plane.close();
});

/** The one issues source the default standing lists its tickets on. */
function defaultSources(): readonly SeededSource[] {
	const repositories = [...new Set(SAMPLE_TICKETS.map((t) => t.repository))].sort();
	return [
		{
			config: {
				name: "issues",
				kind: "github-issues",
				refreshIntervalSeconds: 60,
				repositories,
				host: "github.com",
			},
			tickets: SAMPLE_TICKETS,
		},
	];
}

/** The fetched row the state module's source facts seed from one listed row. */
function fetchedOf(row: Ticket): FetchedTicket {
	return {
		identity: row.identity,
		sourceKind: row.sourceKind,
		externalKey: row.externalKey,
		sourceState: row.sourceState,
		url: row.url,
		title: row.title,
		description: row.description,
		labels: [...row.labels],
		externalUpdatedAt: row.externalUpdatedAt,
		repository: row.repositoryRef,
		attributes: {},
	};
}

/** The choice and the stored handles one row's Handoff stands on. */
function seedHandoff(state: FactoryState, row: Ticket): void {
	const handoff = row.handoff;
	if (handoff === null) return;
	const choice: HandoffChoice = {
		agentType: handoff.agentType,
		environment: handoff.environment,
		taskType: handoff.taskType,
		model: handoff.model,
		thinking: handoff.thinking,
		contextWindow: handoff.contextWindow,
	};
	const details = {
		paneId: handoff.paneId,
		tabId: handoff.tabId,
		workspaceId: handoff.workspaceId,
		agentName: handoff.herdrName,
	};
	const claimOf = (): string => {
		const claim = state.handoff.claimHandoff(row.identity, choice, "open");
		if (!claim.ok) throw new Error(`cannot seed the handoff for ${row.identity}: ${claim.reason}`);
		return claim.claim.attemptId;
	};
	const settle = (attemptId: string): void => {
		state.handoff.settleHandoff(attemptId, true, undefined, details);
	};
	const turnOf = (attemptId: string): void => {
		const last = row.lastCompletion;
		if (last === null) return;
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: row.identity,
			handoffId: attemptId,
			taskType: last.taskType,
			agentType: last.agentType,
			message: last.message,
			turnLog: last.turnLog,
			completedAt: last.completedAt,
			cause: last.cause,
			detail: last.detail,
			transition: last.transition,
		});
	};
	// The closed cycles the row's standing owes. A resting row owes all of its
	// handoffs; a live row owes every one but the handoff it still holds. Each
	// closed cycle ends with the close that opens the next claim's door.
	const closedCycles = row.state === "open" ? row.handoffCount : Math.max(0, row.handoffCount - 1);
	for (let cycle = 0; cycle < closedCycles; cycle += 1) {
		const attemptId = claimOf();
		settle(attemptId);
		if (row.state === "open" && cycle === closedCycles - 1) turnOf(attemptId);
		state.ticketWorkCycle.closeWorkCycle(row.identity);
	}
	if (row.state === "open") return;
	// The live handoff the row still holds.
	const attemptId = claimOf();
	settle(attemptId);
	if (row.state === "running") state.ticketWorkCycle.markTicketRunning(row.identity);
	if (row.state === "awaiting") turnOf(attemptId);
}

/** Seed one Ticket row's whole standing through the state module's own calls. */
function seedTicket(state: FactoryState, row: Ticket): void {
	seedHandoff(state, row);
	if (row.ignored) {
		const result = state.ticketWorkCycle.setTicketIgnored(row.identity, true);
		if (!result.ok) throw new Error(`cannot seed the ignore for ${row.identity}: ${result.reason}`);
	}
}

/** Seed one Consultation record and the standing it carries. */
function seedConsultation(state: FactoryState, seed: ConsultationSeed): void {
	const created = state.consultationRecord.createConsultation({
		...(seed.id === undefined ? {} : { id: seed.id }),
		typeName: seed.typeName,
		agentType: seed.agentType,
		environment: seed.environment,
		...(seed.model === undefined ? {} : { model: seed.model }),
		...(seed.thinking === undefined ? {} : { thinking: seed.thinking }),
		...(seed.contextWindow === undefined ? {} : { contextWindow: seed.contextWindow }),
		template: seed.template,
		initialInput: seed.initialInput,
		renderedOpeningPrompt: seed.renderedOpeningPrompt,
		repository: seed.repository,
		agentName: seed.agentName,
		...(seed.createdAt === undefined ? {} : { createdAt: seed.createdAt }),
	});
	const id = created.id;
	if (seed.agent === true) {
		const short = id.slice(0, 8);
		state.consultationRecord.setConsultationAgent(id, {
			paneId: `pane-${short}`,
			tabId: `tab-${short}`,
			workspaceId: `ws-${short}`,
			sessionId: `sess-${short}`,
		});
	}
	if (seed.resources === true) {
		const short = id.slice(0, 8);
		state.consultationRecord.recordConsultationResource(id, {
			kind: "workspace",
			resourceId: `ws-${short}`,
			owned: true,
			details: "Consultation worktree workspace",
		});
		state.consultationRecord.recordConsultationResource(id, {
			kind: "worktree",
			resourceId: `ws-${short}`,
			owned: true,
			details: `Consultation worktree checkout for the Consultation ${short}`,
		});
		state.consultationRecord.recordConsultationResource(id, {
			kind: "tab",
			resourceId: `tab-${short}`,
			owned: true,
			details: "Consultation worktree tab",
		});
		state.consultationRecord.recordConsultationResource(id, {
			kind: "pane",
			resourceId: `pane-${short}`,
			owned: true,
			details: "Consultation Agent pane",
		});
		state.consultationRecord.recordConsultationResource(id, {
			kind: "agent",
			resourceId: `consultation-${short}`,
			owned: true,
			details: `Agent hosted by pane pane-${short}`,
		});
	}
	if (seed.state !== undefined) {
		const moved = state.consultationRecord.setConsultationState(
			id,
			seed.state,
			seed.stateDetail === undefined ? undefined : seed.stateDetail,
		);
		if (!moved) throw new Error(`cannot seed the Consultation state for ${id}`);
	}
	if (seed.draft !== undefined) state.consultationRecord.setConsultationDraft(id, seed.draft);
}

/**
 * Open the whole plane for the standing. The state file, the config file,
 * the home and checkout directories, the runner double, and the source
 * doubles all come from here, and `close` takes them all back.
 */
export function plane(standing: SeededPlaneStanding = {}): SeededPlane {
	const sources = standing.sources ?? defaultSources();
	const config: FactoryConfig = {
		...BASE_CONFIG,
		sources: sources.map((source) => source.config),
		...standing.config,
	};
	const home = mkdtempSync(join(tmpdir(), "factory-seeded-plane-"));
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, configToToml(config));
	const state = openFactoryState(join(home, "state.sqlite"), standing.now);
	state.grouping.setGroupingAxis("tickets", standing.groupingAxis ?? "none");
	state.sourceFact.initializeSources(
		config.sources.map((source) => ({ name: source.name, kind: source.kind })),
	);
	for (const source of sources) {
		const outcome: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-01-01T00:01:00Z",
			tickets: source.tickets.map(fetchedOf),
		};
		state.sourceFact.applyFetch({ name: source.config.name, kind: source.config.kind }, outcome);
	}
	for (const row of sources.flatMap((source) => source.tickets)) seedTicket(state, row);
	for (const name of standing.mutedSources ?? []) {
		const result = state.sourceFact.setSourceMuted(name, true);
		if (!result.ok) throw new Error(`cannot seed the mute for ${name}: ${result.reason}`);
	}
	for (const seed of standing.consultations ?? []) seedConsultation(state, seed);
	for (const seed of standing.queue ?? []) {
		if (seed.kind === "handoff") {
			const result = state.workQueue.enqueueWork({
				ticketIdentity: seed.ticketIdentity,
				...(seed.routeFromIdentity === undefined
					? {}
					: { routeFromIdentity: seed.routeFromIdentity }),
				origin: seed.origin,
				choice: seed.choice,
				previousMessage: seed.previousMessage,
				...(seed.automatic === undefined ? {} : { automatic: seed.automatic }),
			});
			if (!result.ok)
				throw new Error(`cannot seed the queue row for ${seed.ticketIdentity}: ${result.reason}`);
		} else {
			const result = state.workQueue.enqueuePlaneActionWork({
				ticketIdentity: seed.ticketIdentity,
				...(seed.routeFromIdentity === undefined
					? {}
					: { routeFromIdentity: seed.routeFromIdentity }),
				origin: seed.origin,
				taskType: seed.taskType,
				...(seed.automatic === undefined ? {} : { automatic: seed.automatic }),
			});
			if (!result.ok)
				throw new Error(`cannot seed the action row for ${seed.ticketIdentity}: ${result.reason}`);
		}
	}
	if (standing.autoHandoffMode === true) state.handoff.setAutoHandoffMode(true);
	if (standing.queuePaused === true) state.workQueue.setQueuePaused(true);
	// The checkout the config maps a repository to: a directory on disk the
	// plane's own git reads can land in. The answers themselves are the
	// runner's, named by the case.
	const checkouts: string[] = [];
	for (const path of new Set(Object.values(config.repos))) {
		mkdirSync(path, { recursive: true });
		checkouts.push(path);
	}
	const fakeRunner = new FakeRunner();
	standing.commands?.(fakeRunner);
	const runner = standing.runner?.(fakeRunner) ?? fakeRunner;
	const sourceDoubles = sources.map(
		(source) =>
			new FakeSource(source.config.name, source.config.kind, {
				status: "success",
				fetchedAt: "2026-01-01T00:01:00Z",
				tickets: source.tickets.map(fetchedOf),
			}),
	);
	const registrationsEntry: PlaneRegistration = {
		plane: {
			state,
			config,
			configPath,
			home,
			runner,
			fakeRunner,
			sources: sourceDoubles,
			close: () => {
				state.close();
				rmSync(home, { recursive: true, force: true });
				for (const path of checkouts) rmSync(path, { recursive: true, force: true });
			},
		},
	};
	registrations.push(registrationsEntry);
	return registrationsEntry.plane;
}

/**
 * Open the plane for the standing, run `body` over it, and close the plane
 * however the body ends: the state file first, the directories after.
 */
export async function withPlane<T>(
	standing: SeededPlaneStanding,
	body: (plane: SeededPlane) => Promise<T>,
): Promise<T> {
	const opened = plane(standing);
	try {
		return await body(opened);
	} finally {
		opened.close();
	}
}
