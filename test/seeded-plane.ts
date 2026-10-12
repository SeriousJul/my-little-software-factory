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
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
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
	/**
	 * The `[repos]` mapping the plane's config carries: the checkout paths
	 * relative to the plane's home, absolute paths standing as given. The
	 * directories the mapping names are made, the way the plane makes its home.
	 */
	repos?: Record<string, string>;
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
	/**
	 * The Grouping axis of the Ticket section. A named standing writes it; a
	 * standing that names no axis leaves the file's own answer standing - the
	 * fresh file's seeded split (ADR 0066) where the plane opens a new file,
	 * and the stored axis where the standing wraps one. The default standing,
	 * the sample rows with no sources named, stands flat, the list the
	 * no-state plane drew.
	 */
	groupingAxis?: GroupingAxis;
	/**
	 * The state file already open on the standing's home, in place of the one
	 * the plane opens: the boot that reopens a file the earlier run left.
	 */
	existing?: FactoryState;
	/** The state file's path, in place of the one beside the plane's home. */
	statePath?: string;
	/**
	 * The Repositories the plane stands initialized: the identity to the
	 * settings hash that made the init commit, the commit standing as named.
	 */
	repositoryInits?: Record<string, string>;
	/** The clock the state file writes from. The default is the machine clock. */
	now?: () => number;
	/** The egress double the plane runs on. The default is the FakeRunner. */
	runner?: (fake: FakeRunner) => CommandRunner;
	/** The per-case Command runner answers, run over the FakeRunner. */
	commands?: (fake: FakeRunner, home: string) => void;
	/**
	 * The state's own fetch of the standing's rows. The default stands it
	 * through the state module, the way the suites' own fixtures did before
	 * the plane. A suite that drives its first fetch from a loading boot -
	 * the frame suites that watch the loading line - holds it, and the state
	 * stands without the source rows the fetch would have written.
	 */
	applyFetch?: boolean;
	/**
	 * The preparation of the plane once its home exists, for the standing that
	 * needs the home's own paths before it can name itself: the checkout the
	 * suite builds, the config file the suite writes verbatim, the source the
	 * suite binds over its own runner. The answers stand beside the standing's
	 * own fields, over them where they name one. A standing that builds the
	 * home for its own sake names nothing and returns undefined.
	 */
	prepare?: (home: string) => Promise<
		| {
				config?: Partial<FactoryConfig>;
				/** The config file text written to the plane's config path. */
				configFileText?: string;
				/** The bound source doubles, in place of the plane's FakeSources. */
				boundSources?: readonly TicketSource[];
		  }
		| undefined
	>;
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
	sources: readonly TicketSource[];
	/**
	 * Settle every bound source's first fetch with the snapshot it stands
	 * on: the App's boot read answers, the source health stands healthy, and
	 * the list rule answers the rows actionable. A suite that drives its
	 * first read of a source on its own settles that one itself, and this
	 * call stands beside it.
	 */
	settleFirstFetch(): void;
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

/**
 * One fetched row as the resting Ticket row it stands for: the open state, no
 * Handoff, and the list facts the open row wears. A standing that wants a
 * live row names the handoff and the state beside it.
 */
export function ticketOf(fetched: FetchedTicket, over: Partial<Ticket> = {}): Ticket {
	return {
		identity: fetched.identity,
		title: fetched.title,
		repository: fetched.repository.displayName,
		repositoryRef: fetched.repository,
		state: "open",
		handoff: null,
		workCycle: 1,
		description: fetched.description,
		sourceKind: fetched.sourceKind,
		externalKey: fetched.externalKey,
		sourceState: fetched.sourceState,
		url: fetched.url,
		labels: [...fetched.labels],
		externalUpdatedAt: fetched.externalUpdatedAt,
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: true,
		listActionable: true,
		handoffRecoveryRequired: false,
		handoffCount: 0,
		failedStartStreak: 0,
		lastCompletion: null,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		nameCollision: null,
		...over,
	};
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
/**
 * The checkout mapping the standing's config and repos stand over the home:
 * a relative path stands under the home, an absolute path stands as given.
 */
function reposFor(standing: SeededPlaneStanding, home: string): Record<string, string> {
	return {
		...(standing.config?.repos ?? {}),
		...Object.fromEntries(
			Object.entries(standing.repos ?? {}).map(([repo, path]) => [
				repo,
				path.startsWith("/") ? path : join(home, path),
			]),
		),
	};
}

/**
 * The preparation the standing names, run once the home exists so it can
 * name paths under it and write its own config file over the plane's.
 */
async function preparedStanding(
	standing: SeededPlaneStanding,
	home: string,
): Promise<{
	config?: Partial<FactoryConfig>;
	configFileText?: string;
	boundSources?: readonly TicketSource[];
}> {
	if (standing.prepare === undefined) return {};
	return (await standing.prepare(home)) ?? {};
}

/**
 * The standing's rows into a fresh state, through the state module's own
 * calls, the way an operator's own fetch and acts would have written them.
 */
function seedSourceRows(state: FactoryState, sources: readonly SeededSource[]): void {
	for (const source of sources) {
		const outcome: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-01-01T00:01:00Z",
			tickets: source.tickets.map(fetchedOf),
		};
		state.sourceFact.applyFetch({ name: source.config.name, kind: source.config.kind }, outcome);
	}
	for (const row of sources.flatMap((source) => source.tickets)) seedTicket(state, row);
}

function seedMutes(state: FactoryState, muted: readonly string[]): void {
	for (const name of muted) {
		const result = state.sourceFact.setSourceMuted(name, true);
		if (!result.ok) throw new Error(`cannot seed the mute for ${name}: ${result.reason}`);
	}
}

function enqueueHandoffWork(
	state: FactoryState,
	seed: Extract<WorkQueueSeed, { kind: "handoff" }>,
): void {
	const result = state.workQueue.enqueueWork({
		ticketIdentity: seed.ticketIdentity,
		...(seed.routeFromIdentity === undefined ? {} : { routeFromIdentity: seed.routeFromIdentity }),
		origin: seed.origin,
		choice: seed.choice,
		previousMessage: seed.previousMessage,
		...(seed.automatic === undefined ? {} : { automatic: seed.automatic }),
	});
	if (!result.ok)
		throw new Error(`cannot seed the queue row for ${seed.ticketIdentity}: ${result.reason}`);
}

function enqueuePlaneActionWork(
	state: FactoryState,
	seed: Extract<WorkQueueSeed, { kind: "plane-action" }>,
): void {
	const result = state.workQueue.enqueuePlaneActionWork({
		ticketIdentity: seed.ticketIdentity,
		...(seed.routeFromIdentity === undefined ? {} : { routeFromIdentity: seed.routeFromIdentity }),
		origin: seed.origin,
		taskType: seed.taskType,
		...(seed.automatic === undefined ? {} : { automatic: seed.automatic }),
	});
	if (!result.ok)
		throw new Error(`cannot seed the action row for ${seed.ticketIdentity}: ${result.reason}`);
}

function seedQueue(state: FactoryState, queue: readonly WorkQueueSeed[]): void {
	for (const seed of queue) {
		if (seed.kind === "handoff") enqueueHandoffWork(state, seed);
		else enqueuePlaneActionWork(state, seed);
	}
}

/** The checkout directories the config maps, on disk for the plane's git reads. */
function checkoutDirs(config: FactoryConfig): string[] {
	const checkouts: string[] = [];
	for (const path of new Set(Object.values(config.repos))) {
		mkdirSync(path, { recursive: true });
		checkouts.push(path);
	}
	return checkouts;
}

/**
 * The FakeRunner the frame suites ran on: no agent in the list, the
 * standing's commands and runner standing over it where they name their own.
 */
function defaultFakeRunner(): FakeRunner {
	const fakeRunner = new FakeRunner();
	fakeRunner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
	return fakeRunner;
}

/**
 * The plane's config: the base, the standing's sources and config, the
 * preparation's, and the checkout mapping where it maps one.
 */
function configFor(
	standing: SeededPlaneStanding,
	repos: Record<string, string>,
	sources: readonly SeededSource[],
	preparedConfig?: Partial<FactoryConfig>,
): FactoryConfig {
	return {
		...BASE_CONFIG,
		sources: sources.map((source) => source.config),
		...standing.config,
		...preparedConfig,
		...(Object.keys(repos).length > 0 ? { repos } : {}),
	};
}

function stateFor(standing: SeededPlaneStanding, home: string): FactoryState {
	return (
		standing.existing ??
		openFactoryState(standing.statePath ?? join(home, "state.sqlite"), standing.now)
	);
}

/**
 * The axis the standing names stands; where it names none, the file's own
 * answer stands: the fresh file's seeded split (ADR 0066), or the axis a
 * wrapped file holds. The default standing names the flat axis: the list
 * the no-state plane drew, the standing those frames were written against.
 */
function applyGroupingAxis(state: FactoryState, standing: SeededPlaneStanding): void {
	const axis = standing.groupingAxis ?? (standing.sources === undefined ? "none" : undefined);
	if (axis !== undefined) state.grouping.setGroupingAxis("tickets", axis);
}

/**
 * The source rows a wrapped state already holds stand: re-applying a
 * standing's snapshot would clear a membership the state's own fetch
 * wrote, and re-seeding a handoff would owe the state a second cycle. A
 * fresh state takes the standing's rows through the state module's own
 * calls, the way an operator's own fetch and acts would have written them.
 */
function seedRowsIfFresh(
	state: FactoryState,
	standing: SeededPlaneStanding,
	sources: readonly SeededSource[],
): void {
	if (standing.existing === undefined && standing.applyFetch !== false) {
		seedSourceRows(state, sources);
	}
}

export async function plane(standing: SeededPlaneStanding = {}): Promise<SeededPlane> {
	const sources = standing.sources ?? defaultSources();
	const home = mkdtempSync(join(tmpdir(), "factory-seeded-plane-"));
	const repos = reposFor(standing, home);
	const prepared = await preparedStanding(standing, home);
	const config = configFor(standing, repos, sources, prepared.config);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, prepared.configFileText ?? configToToml(config));
	const state = stateFor(standing, home);
	applyGroupingAxis(state, standing);
	state.sourceFact.initializeSources(
		config.sources.map((source) => ({ name: source.name, kind: source.kind })),
	);
	seedRowsIfFresh(state, standing, sources);
	for (const [identity, settingsHash] of Object.entries(standing.repositoryInits ?? {})) {
		state.repositoryInit.setRepositoryInitFact(identity, settingsHash, "init-commit");
	}
	seedMutes(state, standing.mutedSources ?? []);
	for (const seed of standing.consultations ?? []) seedConsultation(state, seed);
	seedQueue(state, standing.queue ?? []);
	if (standing.autoHandoffMode === true) state.handoff.setAutoHandoffMode(true);
	if (standing.queuePaused === true) state.workQueue.setQueuePaused(true);
	// The checkout the config maps a repository to: a directory on disk the
	// plane's own git reads can land in. The answers themselves are the
	// runner's, named by the case.
	const checkouts = checkoutDirs(config);
	const fakeRunner = defaultFakeRunner();
	standing.commands?.(fakeRunner, home);
	const runner = standing.runner?.(fakeRunner) ?? fakeRunner;
	const fakeDoubles: readonly FakeSource[] = sources.map(
		(source) =>
			new FakeSource(source.config.name, source.config.kind, {
				status: "success",
				fetchedAt: "2026-01-01T00:01:00Z",
				tickets: source.tickets.map(fetchedOf),
			}),
	);
	const sourceDoubles: readonly TicketSource[] = prepared.boundSources ?? fakeDoubles;
	const registrationsEntry: PlaneRegistration = {
		plane: {
			state,
			config,
			configPath,
			home,
			runner,
			fakeRunner,
			sources: sourceDoubles,
			settleFirstFetch: () => {
				for (const double of fakeDoubles) double.settleCurrent();
			},
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
	const opened = await plane(standing);
	try {
		return await body(opened);
	} finally {
		opened.close();
	}
}
