/**
 * The Seeded plane (issue #362, ADR 0131): one deep module that opens the
 * whole control plane behind one interface.
 *
 * A test names the standing it wants and the module answers with the state
 * file, the config file, the home and checkout directories, the Command
 * runner double, the Ticket source doubles, the one clock the case moves,
 * and the props the App boots from. The standing spans three facts of the
 * plane, each named in the plane's own vocabulary:
 *
 * - the row standing: the sources of the plane and the tickets they list.
 *   The default is the one issues source that lists the sample tickets, so a
 *   suite that names no standing gets the standing the frame suites were
 *   written against;
 * - the standing of the default Ticket: one Ticket open, in flight, awaiting
 *   its decision, or through a closed cycle, beside stored handoffs the case
 *   names for other tickets;
 * - the standing of the factory: the Consultation records, the Work queue
 *   rows, the muted sources, the ignored tickets, the initialized
 *   Repositories, the Auto-handoff mode, and the queue brake the state file
 *   holds before the App mounts.
 *
 * The module sits above three seams the plane already has - the state
 * module's open seam, the Command runner seam, and the Ticket source seam -
 * and hands their composition to the caller at the App's props seam. It adds
 * no seam and holds no rule of the plane: a standing that needs the naming
 * rule, the work-cycle rule, or the Transition fire stands on the plane's
 * own modules, and the facts every suite shares come from the shared fact
 * module, so the suite's three default Tickets resolved to one before this
 * module stood.
 *
 * The state aggregate suites stand outside this module (ADR 0131): they test
 * the state file through the state module's per-aggregate interface, and a
 * fixture in front of that seam would hide it. The module suites take the
 * plane's parts and ignore its props.
 *
 * The clock the state file writes from defaults to the machine clock: the
 * App's own seat grace reads it (issue #87, ADR 0034), so a pinned default
 * would age every Handoff the plane settles at boot. A case that moves time
 * names the clock the state opens on, and the plane's source doubles stamp
 * their self-settled reads from that same clock, so the state and its
 * sources stand on one clock. The default stands on the machine clock beside
 * the spec's wall-clock-free standing; the verification record names the
 * cases the default clock reaches.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppProps } from "../src/components/app.ts";
import {
	configToToml,
	type FactoryConfig,
	type TicketSourceConfig,
	type TransitionOutcome,
} from "../src/config.ts";
import type { GroupingAxis } from "../src/domain/grouping.ts";
import type { EnvironmentKind, FetchedTicket, Ticket } from "../src/domain/ticket.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import { NOOP_LOGGER } from "../src/logging.ts";
import type { CommandRunner } from "../src/runner.ts";
import type {
	ConsultationRepository,
	ConsultationState,
} from "../src/state/consultation-record.ts";
import type { HandoffDetails, HandoffOrigin } from "../src/state/handoff.ts";
import type { SourceDefinition } from "../src/state/source-fact.ts";
import type { SettleTurnInput } from "../src/state/ticket-work-cycle.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";
import type { TurnEndCause, TurnLogEntry } from "../src/turn-log.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	DEFAULT_IDENTITY,
	DEFAULT_REPOSITORY,
	fetchedTicket,
	fetchSuccess,
	handoffChoice,
	SAMPLE_TICKETS,
	ticketOf,
} from "./fact-fixtures.ts";
import { emptyAgentRunner, type FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { holdPlaneClose } from "./plane-cleanup.ts";

// ---------------------------------------------------------------------------
// The standing a test asks for.
// ---------------------------------------------------------------------------

/** The standing where the work cycle of the default Ticket stands. */
export type PlaneStandingName = "open" | "in-flight" | "awaiting" | "closed-cycle";

/**
 * The one clock the plane opens its state file on. A case that ages a
 * stored Handoff past its startup grace moves the clock. The default is the
 * machine clock: the App's own seat grace reads it, so a pinned default
 * would age every Handoff the plane settles at boot.
 */
export interface PlaneClock {
	now(): number;
	advance(ms: number): void;
}

/**
 * One configured source and the tickets it lists. The source config is what
 * the plane's config carries, and the tickets are what the source's first
 * fetch reports: the state module seeds its source facts and its ticket rows
 * from them.
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
 * in the plane's own vocabulary; nothing here names an aggregate call or a
 * directory the case could stand for itself. A field is admitted only when
 * it names a fact of the plane (ADR 0131), so the interface stays small as
 * facts are added.
 */
export interface PlaneStanding {
	// The standing of the default Ticket, on the plane's own modules.
	/** Where the work cycle of the default Ticket stands. Default: open. */
	standing?: PlaneStandingName;
	/**
	 * The tickets the default source lists, in place of the sample set. The
	 * default Ticket's own row stands beside them, added when the standing
	 * names the work cycle.
	 */
	tickets?: readonly FetchedTicket[];
	/**
	 * The handoff of the standing, over the six-field choice the suite
	 * shares. Name only the environment, the task type, or the origin the
	 * case turns on.
	 */
	handoff?: Partial<HandoffChoice> & {
		origin?: HandoffOrigin;
		handles?: HandoffDetails;
	};
	/** The settled turn's facts, present when the standing has a turn. */
	turn?: {
		taskType?: string;
		message?: string;
		turnLog?: readonly TurnLogEntry[];
		cause?: TurnEndCause;
		transition?: TransitionOutcome | null;
	};
	/** A stored handoff beside the standing, for a ticket other than the default Ticket. */
	handoffs?: readonly PlaneTicketHandoff[];
	// The row standing of the plane.
	/**
	 * The sources of the plane and the tickets they list. The default is the
	 * one issues source that lists the sample tickets, so a suite that names
	 * no standing gets the standing the frame suites were written against.
	 */
	sources?: readonly SeededSource[];
	// The standing of the factory, in the state file.
	/** The Consultation records the standing seeds. */
	consultations?: readonly ConsultationSeed[];
	/** The Work queue rows the standing seeds. */
	queue?: readonly WorkQueueSeed[];
	/** The sources the operator muted before the plane booted. */
	mutedSources?: readonly string[];
	/** The tickets the operator ignored before the plane booted. */
	ignoredTickets?: readonly string[];
	/**
	 * The repositories the plane stands initialized: the repository to the
	 * settings hash that made the init commit, the commit standing as named.
	 * A repository that stands absent is not initialized; a hash that
	 * differs from the config's own hash stands the init drifted.
	 */
	repositoryInits?: Record<string, string>;
	// The config and the home.
	/** The config, as an override of the base config the suite shares. */
	config?: Partial<FactoryConfig>;
	/**
	 * The `[repos]` mapping the plane's config carries: the checkout paths
	 * relative to the plane's home, absolute paths standing as given. The
	 * directories the mapping names are made, the way the plane makes its home.
	 */
	repos?: Record<string, string>;
	/** The checkout on disk the default repository maps to. Default: empty. */
	checkout?: "none" | "empty" | "healthy";
	/**
	 * The home directory the plane stands in, in place of its own. The plane
	 * clears the directories it makes, the home the case names aside.
	 */
	home?: string;
	/**
	 * The state file already open on the standing's home, in place of the
	 * one the plane opens: the boot that reopens a file the earlier run
	 * left. The plane writes no axis on it where the standing names none:
	 * the state's own axis stands.
	 */
	existing?: FactoryState;
	/** The state file's path, in place of the one beside the plane's home. */
	statePath?: string;
	/**
	 * The preparation of the plane once its home exists, for the standing
	 * that needs the home's own paths before it can name itself: the
	 * checkout the suite builds, the config file the suite writes verbatim,
	 * the source the suite binds over its own runner. The answers stand
	 * beside the standing's own fields, over them where they name one.
	 */
	prepare?: (home: string) => Promise<
		| {
				config?: Partial<FactoryConfig>;
				/** The config file text written to the plane's config path. */
				configFileText?: string;
				/** The bound sources, in place of the plane's own doubles. */
				boundSources?: readonly TicketSource[];
		  }
		| undefined
	>;
	// The factory state the state file holds.
	/** The Auto-handoff mode the state file holds before the App mounts. */
	autoHandoffMode?: boolean;
	/** The Work queue brake the state file holds before the App mounts. */
	queuePaused?: boolean;
	/**
	 * The Grouping axis the plane settles on the state file's Ticket axis.
	 *
	 * The plane settles the flat axis on every fresh file it opens, sources
	 * named or not, so a frame that reads the unsplit list stands on it
	 * without naming it; a frame that wants a split names the axis it wants.
	 * A standing that wraps a state names the axis the plane writes on that
	 * state; where it names none, the state's own axis stands.
	 */
	groupingAxis?: GroupingAxis;
	// The time the plane stands on.
	/** The clock the state file writes from. The default is the machine clock. */
	now?: () => number;
	// The egress the plane runs on.
	/**
	 * The egress double the plane runs on, named against the plane's own
	 * FakeRunner. A case that stands a stub herdr world, or wraps one, names
	 * it here, against the paths the case itself holds for the home and the
	 * checkout. The default is the plane's own FakeRunner.
	 */
	runner?: (fake: FakeRunner) => CommandRunner;
	/** The per-case command runner answers, run over the plane's own FakeRunner. */
	commands?: (fake: FakeRunner, home: string) => void;
	// The Ticket source doubles.
	/**
	 * The settled reads of the standing's sources on the state file, before
	 * the App boots. The default stands them through the state module, the
	 * way the suites' own fixtures did before the plane. Hold them where the
	 * test drives the reads through the plane's source doubles itself - the
	 * frame suites that watch the loading line - and the state stands the
	 * sources' health without the ticket rows the settled reads would write.
	 */
	settledReads?: boolean;
	/**
	 * Whether the plane's own source doubles stamp their settled reads from
	 * the plane's clock ("auto"), the way a source that answers on the spot
	 * would, or settle them on the outcome they hold, as given ("manual").
	 * Both forms hold a read in flight until the test or the App's own read
	 * settles it. Default: manual, the double the suite has always stood.
	 */
	sourceSettlement?: "auto" | "manual";
	/**
	 * Ticket source doubles the App polls that the config does not list: a
	 * source the plane's state file has no fact of yet, the way a test adds
	 * a pull request feed beside the issue feed.
	 */
	extraSources?: readonly SourceDefinition[];
	/**
	 * The tickets a named unlisted source settles: the way a test stands a
	 * pull request feed with its own request on it next to the issue feed. A
	 * null entry stands the source initialized without a settled read, the
	 * state a test that settles its own double leaves behind before its first
	 * fetch lands.
	 */
	sourceTickets?: Record<string, readonly FetchedTicket[] | null>;
	/**
	 * The observation poll interval the App runs on, beside the held loop
	 * the default plane stands. The props hand the App the polled loop at
	 * the named interval; the default hands the held loop.
	 */
	pollIntervalMs?: number;
}

/**
 * A stored handoff of a ticket other than the default Ticket, claimed and
 * settled on the plane's own state module. The standing itself stands the
 * default Ticket; an entry stands one more ticket beside it.
 */
export interface PlaneTicketHandoff {
	/** The ticket the handoff stores for, listed by the plane's source. */
	ticket: string;
	/** The stored choice, over the six fields the suite shares. */
	choice?: Partial<HandoffChoice>;
	/** The origin the stored handoff took. Default: the open claim. */
	origin?: HandoffOrigin;
	/** The stored herdr handles. Default: the suite's pane, tab, and workspace. */
	handles?: HandoffDetails;
	/** Settle the turn of the stored handoff on these facts, when named. */
	turn?: {
		message?: string;
		turnLog?: readonly TurnLogEntry[];
		cause?: TurnEndCause;
		transition?: TransitionOutcome | null;
	};
}

/** The whole plane, opened and seeded to the standing. */
export interface Plane {
	/** The state file, seeded to the standing, on the plane's clock. */
	state: FactoryState;
	/** The config the plane runs under. */
	config: FactoryConfig;
	/** The config file the plane writes to, on disk beside the state. */
	configPath: string;
	/** The home directory the plane's paths live under. */
	home: string;
	/** The checkout the default repository maps to, or null on none. */
	checkout: string | null;
	/** The one clock the state file reads, handed back to the test. */
	clock: PlaneClock;
	/** The Command runner double the App runs on. */
	runner: CommandRunner;
	/** The FakeRunner the answers and the command record stand on. */
	fakeRunner: FakeRunner;
	/** The bound sources, in the config's source order: the plane's own doubles, or the prepared ones. */
	sources: readonly TicketSource[];
	/**
	 * The props the App boots from, beside the onReady the caller hands the
	 * App: the seam the frame suites cross. The loop policy stands at the
	 * standing's poll interval, the held loop on its absence.
	 */
	props: Omit<AppProps, "onReady">;
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

/** The source the plane's state file records the default Ticket under. */
export const planeIssuesRef: SourceDefinition = { name: "issues", kind: "github-issues" };

/**
 * The shared sample issues source the suite names in its standings: one
 * issue feed on the suite's sample repository, the cadence the suites share.
 */
export const issuesSourceConfig: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: [DEFAULT_REPOSITORY.displayName],
	host: "github.com",
};

/** The shared sample issues source config, by the name the suites name it. */
export const planeIssuesSource: TicketSourceConfig = issuesSourceConfig;

/** The config with the plane's one issue feed listed. */
export const issuesConfig: FactoryConfig = { ...BASE_CONFIG, sources: [issuesSourceConfig] };

// ---------------------------------------------------------------------------
// The plane's own directories and state files, cleaned up when the test ends.
// ---------------------------------------------------------------------------

/**
 * The plane's close goes to the run's preload, not to a module-scope hook of
 * this file: Bun evaluates this file once per run, and a module-scope
 * `afterEach` would bind to the one test file that first imports the plane,
 * leaking every plane the other files open. The preload's hook belongs to no
 * file, so it drains the register for every test of every file of the run.
 */

/** The sleep the plane's settles and waits run on. */
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open a fresh state database the suites wrap in the plane's standing,
 * registered for cleanup by the test's own end.
 *
 * The wrapper settles the flat axis on the file it opens, the list the
 * frame tests read: the stored axis stands through every boot that wraps
 * the state, and the plane's own settle settles the same list on the fresh
 * file it opens.
 */
export function wrappedState(axis: GroupingAxis = "none"): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-plane-state-"));
	const state = openFactoryState(join(dir, "state.sqlite"), () => Date.now());
	state.grouping.setGroupingAxis("tickets", axis);
	holdPlaneClose(() => {
		state.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return state;
}

/**
 * Reopen a state file through the plane's own seam, with its own clock
 * where the case names one: the same file the plane opened, not a second
 * world. The reopened state is the caller's to close.
 */
export function reopenState(path: string, now?: () => number): FactoryState {
	return openFactoryState(path, now);
}

// ---------------------------------------------------------------------------
// The standing's answers, on the plane's own modules.
// ---------------------------------------------------------------------------

/**
 * The one clock the plane opens its state file on: the value the case names
 * at boot, plus the moves the case makes on it afterwards.
 */
function planeClock(standing: PlaneStanding): PlaneClock {
	const offset = { ms: 0 };
	const base = standing.now ?? (() => Date.now());
	return {
		now: () => base() + offset.ms,
		advance: (ms) => {
			offset.ms += ms;
		},
	};
}

/** The home the plane stands in, and the checkout the standing asks for. */
function planeHome(standing: PlaneStanding): { home: string; checkout: string | null } {
	const home = standing.home ?? mkdtempSync(join(tmpdir(), "factory-plane-"));
	// A passed home may stand closed behind a previous plane: the plane makes
	// it again, the way the state module makes a state file's parent.
	mkdirSync(home, { recursive: true });
	if ((standing.checkout ?? "empty") === "none") return { home, checkout: null };
	// The plane's checkout stands under the display name, apart from the
	// resolution convention's last-segment path: a case that maps the
	// repository to it works that path through its runner, and a case that
	// maps nothing keeps the convention missing, the way the resolution's
	// clone path asks for it. The directory stands only when a repository
	// maps to it: a standing that maps nothing gives the checkout no disk.
	const checkout = join(home, "src", DEFAULT_REPOSITORY.displayName);
	return { home, checkout };
}

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

/** The sources the standing stands, over the default sample set. */
function sourcesOf(standing: PlaneStanding): readonly SeededSource[] {
	if (standing.sources !== undefined) return standing.sources;
	if (standing.tickets !== undefined)
		return [{ config: issuesSourceConfig, tickets: standing.tickets.map((row) => ticketOf(row)) }];
	return defaultSources();
}

/**
 * The default Ticket's row beside the standing's rows: the work-cycle
 * standing claims it, so it must be listed. The issues source it rides on is
 * the plane's own, added when the standing's sources name no issues source.
 */
function withDefaultTicket(rows: readonly SeededSource[]): readonly SeededSource[] {
	const listed = rows.some((source) =>
		source.tickets.some((row) => row.identity === DEFAULT_IDENTITY),
	);
	if (listed) return rows;
	const issues = rows.find((source) => source.config.name === planeIssuesRef.name);
	if (issues === undefined)
		return [...rows, { config: issuesSourceConfig, tickets: [ticketOf(fetchedTicket())] }];
	const withDefault = rows.map((source) =>
		source === issues
			? { ...source, tickets: [...source.tickets, ticketOf(fetchedTicket())] }
			: source,
	);
	return withDefault;
}

/** The row the state module's source facts seed from one listed ticket. */
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

/** The choice and the stored handles one row's handoff stands on. */
function seedRowHandoff(state: FactoryState, row: Ticket): void {
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

/** Seed one ticket row's whole standing through the state module's own calls. */
function seedTicket(state: FactoryState, row: Ticket): void {
	seedRowHandoff(state, row);
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

/** The one row a handoff seed enqueues, through the queue's own enqueue. */
function enqueueHandoffRow(
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

/** The one row an action seed enqueues, through the queue's own enqueue. */
function enqueueActionRow(
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

/** Seed the queue rows the standing names, through the queue's own enqueues. */
function seedQueue(state: FactoryState, queue: readonly WorkQueueSeed[]): void {
	for (const seed of queue) {
		if (seed.kind === "handoff") enqueueHandoffRow(state, seed);
		else enqueueActionRow(state, seed);
	}
}

/** Seed the mutes, the ignored tickets, and the repository inits. */
function seedOperatorState(
	state: FactoryState,
	muted: readonly string[] | undefined,
	ignored: readonly string[] | undefined,
	repositoryInits: Record<string, string> | undefined,
): void {
	for (const name of muted ?? []) {
		const result = state.sourceFact.setSourceMuted(name, true);
		if (!result.ok) throw new Error(`cannot seed the mute for ${name}: ${result.reason}`);
	}
	for (const identity of ignored ?? []) {
		const result = state.ticketWorkCycle.setTicketIgnored(identity, true);
		if (!result.ok) throw new Error(`cannot seed the ignore for ${identity}: ${result.reason}`);
	}
	for (const [repository, settingsHash] of Object.entries(repositoryInits ?? {})) {
		state.repositoryInit.setRepositoryInitFact(repository, settingsHash, "init-commit");
	}
}

/**
 * The standing's work cycle of the default Ticket, on the plane's own
 * modules. The row the standing claims is listed by the plane's issues
 * source; the closed cycle re-reads that source on the plane's clock, the
 * way the App's own re-read would stamp it.
 */
function seedStanding(
	state: FactoryState,
	standing: PlaneStanding,
	clock: PlaneClock,
	issuesRows: readonly Ticket[],
): void {
	const name = standing.standing ?? "open";
	if (name === "open") return;
	const source = planeIssuesRef;
	const handoff = standing.handoff ?? {};
	const choice = choiceOf(standing.handoff);
	const claim = state.handoff.claimHandoff(DEFAULT_IDENTITY, choice, handoff.origin ?? "open");
	if (!claim.ok) throw new Error(claim.reason);
	const attemptId = claim.claim.attemptId;
	state.handoff.settleHandoff(
		attemptId,
		true,
		undefined,
		handoff.handles ?? { paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" },
	);
	if (name === "in-flight") return;
	state.ticketWorkCycle.settleTurn(turnInputOf(standing.turn, choice, attemptId));
	if (name !== "closed-cycle") return;
	state.ticketWorkCycle.applyCompletionDecision({
		ticketIdentity: DEFAULT_IDENTITY,
		handoffId: attemptId,
		decision: "closed",
		decidedAt: new Date(clock.now()).toISOString(),
	});
	// The App re-reads the ticket's source when its cycle ends, after the
	// decision's time: the ticket is re-verified, and a later open claim of
	// it passes. The re-read stamps the plane's clock, so the fact is as new
	// as the decision it closes on.
	state.sourceFact.applyFetch(source, {
		status: "success",
		fetchedAt: new Date(clock.now()).toISOString(),
		tickets: issuesRows.map(fetchedOf),
	});
}

/** The six choice fields the standing names, over the choice the suite shares. */
function choiceOf(handoff: PlaneStanding["handoff"]): HandoffChoice {
	const over: Partial<HandoffChoice> = {};
	if (handoff?.agentType !== undefined) over.agentType = handoff.agentType;
	if (handoff?.environment !== undefined) over.environment = handoff.environment;
	if (handoff?.taskType !== undefined) over.taskType = handoff.taskType;
	if (handoff?.model !== undefined) over.model = handoff.model;
	if (handoff?.thinking !== undefined) over.thinking = handoff.thinking;
	if (handoff?.contextWindow !== undefined) over.contextWindow = handoff.contextWindow;
	return handoffChoice(over);
}

/**
 * The moment the suite's seeded turn completes: the canonical fact the
 * fixture holds, not a reading of the plane's clock. The clock still moves
 * the state's `now` and stamps the re-reads; the seeded turn stands on its
 * own moment beside it.
 */
const SEED_TURN_COMPLETED_AT = "2026-08-31T11:00:00Z";

/** The settled turn's input, the standing's own facts over the standing's word. */
function turnInputOf(
	turn: PlaneStanding["turn"],
	choice: HandoffChoice,
	attemptId: string,
): SettleTurnInput {
	const word = turn?.message ?? "The turn is done.";
	return {
		ticketIdentity: DEFAULT_IDENTITY,
		handoffId: attemptId,
		taskType: turn?.taskType ?? choice.taskType,
		agentType: choice.agentType,
		message: word,
		turnLog: [...(turn?.turnLog ?? [{ kind: "text", text: word }])],
		completedAt: SEED_TURN_COMPLETED_AT,
		...(turn?.cause === undefined ? {} : { cause: turn.cause }),
		...(turn?.transition === undefined ? {} : { transition: turn.transition }),
	};
}

/**
 * The stored handoffs beside the standing: one claim and one settle per
 * entry, on the plane's own state module, and the settled turn when the
 * entry names one.
 */
function seedTicketHandoffs(state: FactoryState, handoffs: readonly PlaneTicketHandoff[]): void {
	for (const entry of handoffs) {
		const choice = choiceOf({
			agentType: entry.choice?.agentType,
			environment: entry.choice?.environment,
			taskType: entry.choice?.taskType,
			model: entry.choice?.model,
			thinking: entry.choice?.thinking,
			contextWindow: entry.choice?.contextWindow,
		});
		const claim = state.handoff.claimHandoff(entry.ticket, choice, entry.origin ?? "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(
			claim.claim.attemptId,
			true,
			undefined,
			entry.handles ?? { paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" },
		);
		if (entry.turn === undefined) continue;
		const word = entry.turn.message ?? "The turn is done.";
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: entry.ticket,
			handoffId: claim.claim.attemptId,
			taskType: choice.taskType,
			agentType: choice.agentType,
			message: word,
			turnLog: [...(entry.turn.turnLog ?? [{ kind: "text", text: word }])],
			completedAt: SEED_TURN_COMPLETED_AT,
			...(entry.turn.cause === undefined ? {} : { cause: entry.turn.cause }),
			...(entry.turn.transition === undefined ? {} : { transition: entry.turn.transition }),
		});
	}
}

// ---------------------------------------------------------------------------
// The plane's home, config, state, and egress.
// ---------------------------------------------------------------------------

/**
 * The checkout mapping the standing's table stands over the home: a relative
 * path stands under the home, an absolute path stands as given.
 */
function reposOfTable(
	table: Record<string, string> | undefined,
	home: string,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(table ?? {}).map(([repository, path]) => [
			repository,
			path.startsWith("/") ? path : join(home, path),
		]),
	);
}

/** The preparation the standing names, run once the home exists. */
async function preparedStanding(
	standing: PlaneStanding,
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
 * The plane's config: the base, the standing's sources and config, the
 * preparation's, and the checkout mapping where the standing names the
 * checkout standing. The default repository's checkout path stands mapped
 * there; the named table stands over the mapping it does not name.
 */
function configFor(
	sources: readonly SeededSource[],
	standing: PlaneStanding,
	prepared: { config?: Partial<FactoryConfig> },
	dirs: { home: string; checkout: string | null },
): FactoryConfig {
	const planeRepos =
		standing.checkout !== undefined && dirs.checkout !== null
			? { [DEFAULT_REPOSITORY.identity]: dirs.checkout }
			: {};
	const named = reposOfTable(standing.repos, dirs.home);
	let repos = { ...planeRepos, ...(standing.config?.repos ?? {}) };
	if (Object.keys(named).length > 0) repos = { ...repos, ...named };
	return {
		...BASE_CONFIG,
		sources: sources.map((source) => source.config),
		...standing.config,
		...prepared.config,
		...(Object.keys(repos).length === 0 ? {} : { repos }),
	};
}

/** The plane's state: the file the standing opens in place of the plane's own. */
function stateOf(standing: PlaneStanding, home: string, clock: PlaneClock): FactoryState {
	if (standing.existing !== undefined) return standing.existing;
	return openFactoryState(standing.statePath ?? join(home, "state.sqlite"), clock.now);
}

/** The grouping axis the plane settles on the state file, where it writes one. */
function applyGroupingAxis(state: FactoryState, standing: PlaneStanding): void {
	// The plane settles the flat axis on every fresh file it opens, sources
	// named or not: the state module's own rule opens a fresh file grouped
	// by repository (ADR 0066), and the flat list the frame suites assert is
	// the list the fixture settles on the file it opens. A wrapped state
	// stands on the axis it holds, and the standing names the axis the plane
	// writes there.
	const axis = standing.groupingAxis ?? (standing.existing === undefined ? "none" : undefined);
	if (axis === undefined) return;
	state.grouping.setGroupingAxis("tickets", axis);
}

/** The snapshot a source double stands on before the App's first read settles it. */
const SNAPSHOT_STAMP = "2026-01-01T00:01:00Z";

/** The standing's rows into a fresh state, through the state module's own calls. */
function seedRows(
	state: FactoryState,
	sources: readonly SeededSource[],
	sourceTickets: Record<string, readonly FetchedTicket[] | null> | undefined,
): void {
	for (const source of sources) {
		const named = sourceTickets?.[source.config.name];
		if (named === null) continue;
		const tickets = named ?? source.tickets.map(fetchedOf);
		state.sourceFact.applyFetch(
			{ name: source.config.name, kind: source.config.kind },
			fetchSuccess(tickets),
		);
		// The standing's rows stand with their whole work: the named rows are
		// fetched facts, the standing's rows are the tickets the case wrote.
		const rows = named !== undefined ? tickets.map((fetched) => ticketOf(fetched)) : source.tickets;
		for (const row of rows) seedTicket(state, row);
	}
}

/** The standing's rows into a fresh state, and the operator facts beside them. */
function seedStandingFacts(
	state: FactoryState,
	standing: PlaneStanding,
	rows: readonly SeededSource[],
): void {
	const fresh = standing.existing === undefined && standing.settledReads !== false;
	if (fresh) seedRows(state, rows, standing.sourceTickets);
	seedOperatorState(
		state,
		standing.mutedSources,
		standing.ignoredTickets,
		standing.repositoryInits,
	);
	for (const seed of standing.consultations ?? []) seedConsultation(state, seed);
	seedQueue(state, standing.queue ?? []);
	if (standing.autoHandoffMode === true) state.handoff.setAutoHandoffMode(true);
	if (standing.queuePaused === true) state.workQueue.setQueuePaused(true);
}

/** The runner the plane serves: the case's where it names one, the table's beside it. */
function runnerFor(
	standing: PlaneStanding,
	fake: FakeRunner,
	home: string,
	checkout: string | null,
): CommandRunner {
	if (tableOwnsIt(standing) && (standing.checkout ?? "empty") === "healthy" && checkout !== null) {
		pinHealthyCheckout(fake, checkout);
	}
	if (standing.commands !== undefined) standing.commands(fake, home);
	return standing.runner?.(fake) ?? fake;
}

/** The source doubles: one per listed source, then the unlisted doubles beside them. */
function sourceDoublesOf(
	sources: readonly SeededSource[],
	options: {
		extraSources?: readonly SourceDefinition[];
		sourceTickets?: Record<string, readonly FetchedTicket[] | null>;
		autoSettle: boolean;
		clock: PlaneClock;
	},
): FakeSource[] {
	const listed = sources.map((source) => {
		const named = options.sourceTickets?.[source.config.name];
		// A null entry stands the source initialized without a settled read:
		// the state keeps the fact the test settles on its own double, and the
		// plane's own double holds the empty list it is never asked for.
		const tickets = named ?? source.tickets.map(fetchedOf);
		return new FakeSource(
			source.config.name,
			source.config.kind,
			{
				status: "success" as const,
				fetchedAt: SNAPSHOT_STAMP,
				tickets: named === null ? [] : [...tickets],
			},
			{
				autoSettle: options.autoSettle,
				now: options.clock.now,
			},
		);
	});
	// The doubles the config does not list: the state file has no fact of
	// them yet, so the plane seeds no fetch for them.
	const unlisted = (options.extraSources ?? []).map(
		(ref) =>
			new FakeSource(
				ref.name,
				ref.kind,
				{
					status: "success" as const,
					fetchedAt: SNAPSHOT_STAMP,
					tickets: [...(options.sourceTickets?.[ref.name] ?? [])],
				},
				{
					autoSettle: options.autoSettle,
					now: options.clock.now,
				},
			),
	);
	return [...listed, ...unlisted];
}

/** The two git answers a healthy checkout of the default repository gives. */
function pinHealthyCheckout(table: FakeRunner, checkout: string): void {
	table.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	table.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: `${DEFAULT_REPOSITORY.cloneUrl}\n`,
	});
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

// ---------------------------------------------------------------------------
// The plane itself.
// ---------------------------------------------------------------------------

/**
 * Open the whole plane on the standing the test names. The state file, the
 * config file, the home and checkout directories, the runner double, and
 * the source doubles all come from here, and `close` takes them all back.
 * The plane registers itself for cleanup at the test's own end, however the
 * test ends; reach for `withPlane` when the plane's lifetime is the test's.
 */
export async function plane(standing: PlaneStanding = {}): Promise<Plane> {
	const { home, checkout } = planeHome(standing);
	const clock = planeClock(standing);
	const prepared = await preparedStanding(standing, home);
	// The default Ticket's row stands beside the standing's rows only when the
	// standing names the work cycle: an empty or rows-only standing stands the
	// rows it names, no more, the standing the frame suites were written against.
	const namesWorkCycle =
		standing.standing !== undefined ||
		standing.handoff !== undefined ||
		standing.turn !== undefined;
	const rows = namesWorkCycle ? withDefaultTicket(sourcesOf(standing)) : sourcesOf(standing);
	const config = configFor(rows, standing, prepared, { home, checkout });
	const state = stateOf(standing, home, clock);
	applyGroupingAxis(state, standing);
	state.sourceFact.initializeSources(
		config.sources.map((source) => ({ name: source.name, kind: source.kind })),
	);

	seedStandingFacts(state, standing, rows);

	const created = checkoutDirs(config);
	const fake = emptyAgentRunner();
	const runner = runnerFor(standing, fake, home, checkout);

	const issues = rows.find((source) => source.config.name === planeIssuesRef.name);
	seedStanding(state, standing, clock, issues?.tickets ?? []);
	seedTicketHandoffs(state, standing.handoffs ?? []);

	const configPath = join(home, "config.toml");
	writeFileSync(configPath, prepared.configFileText ?? configToToml(config));
	const doubles = sourceDoublesOf(rows, {
		extraSources: standing.extraSources,
		sourceTickets: standing.sourceTickets,
		autoSettle: standing.sourceSettlement === "auto",
		clock,
	});
	const sources = prepared.boundSources ?? doubles;

	let closed = false;
	const record: Plane = {
		state,
		config,
		configPath,
		home,
		checkout,
		clock,
		runner,
		fakeRunner: fake,
		sources,
		props: {
			config,
			state,
			runner,
			home,
			configPath,
			sources,
			logger: NOOP_LOGGER,
			loopPolicy:
				standing.pollIntervalMs === undefined
					? { kind: "held" }
					: { kind: "polled", intervalMs: standing.pollIntervalMs },
		},
		settleFirstFetch() {
			for (const source of doubles) source.settleCurrent();
		},
		close() {
			if (closed) return;
			closed = true;
			state.close();
			const dirs = new Set<string>(created);
			if (checkout !== null) dirs.add(checkout);
			if (standing.home === undefined) dirs.add(home);
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		},
	};
	holdPlaneClose(record.close);
	return record;
}

/** The plane's own FakeRunner runs when the case names no runner of its own. */
function tableOwnsIt(standing: PlaneStanding): boolean {
	return standing.runner === undefined;
}

/**
 * Open the plane on the standing, run the body on it, and close the plane
 * however the body ends, the way the harness's `withApp` form closes its
 * terminal. The safe shape is the shape a test reaches for by default.
 */
export async function withPlane<T>(
	standing: PlaneStanding,
	body: (p: Plane) => Promise<T> | T,
): Promise<T> {
	const p = await plane(standing);
	try {
		return await body(p);
	} finally {
		p.close();
	}
}

// ---------------------------------------------------------------------------
// The app-level seeds the plane absorbs from the old state fixture (#362):
// the in-flight and awaiting turn seeds and the source-call wait. A test that
// boots the App on a plane but settles a source on its own double uses them
// on the plane's state, the way the fixture handed them out before.
// ---------------------------------------------------------------------------

/**
 * Move a fixture ticket through a clean handoff and store its herdr
 * handles.
 *
 * The row is in flight with a Pane behind it, which is what the missing modal
 * answers to once the observation finds no Agent in that Pane. The turn names
 * the ticket the outcome stands on where the case names none, so the seed and
 * the row cannot drift apart. The caller owns the state and closes it.
 */
export function seedInFlightTurn(
	state: FactoryState,
	outcome: FetchOutcome,
	identity?: string,
	environment: EnvironmentKind = "live-worktree",
): string {
	const named =
		identity ??
		(outcome.status === "success" ? outcome.tickets[0]?.identity : undefined) ??
		DEFAULT_IDENTITY;
	state.sourceFact.initializeSources([planeIssuesRef]);
	state.sourceFact.applyFetch(planeIssuesRef, outcome);
	const claim = state.handoff.claimHandoff(named, handoffChoice({ environment }), "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return claim.claim.attemptId;
}

/**
 * Move the fixture ticket through a clean handoff and a settled turn.
 *
 * The row ends awaiting its decision with the herdr handles stored, which is
 * what the decision modal and the observation loop read.
 */
export function seedAwaitingTurn(
	state: FactoryState,
	outcome: FetchOutcome,
	fields: {
		identity?: string;
		transition?: TransitionOutcome | null;
		environment?: EnvironmentKind;
	} = {},
): string {
	const { identity, transition, environment = "live-worktree" } = fields;
	const attemptId = seedInFlightTurn(state, outcome, identity, environment);
	const named =
		identity ??
		(outcome.status === "success" ? outcome.tickets[0]?.identity : undefined) ??
		DEFAULT_IDENTITY;
	state.ticketWorkCycle.settleTurn({
		ticketIdentity: named,
		handoffId: attemptId,
		taskType: "implement",
		agentType: "pi",
		message: "The turn is done.",
		turnLog: [{ kind: "text", text: "The turn is done." }],
		completedAt: SEED_TURN_COMPLETED_AT,
		...(transition === undefined ? {} : { transition }),
	});
	return attemptId;
}

/**
 * Wait until the source has started its `calls`-th fetch.
 *
 * A key press is dispatched on the next frame, so a test must not settle
 * before the refresh it started has actually called the source: an early
 * settle has no in-flight fetch to resolve and the refresh hangs forever.
 */
export async function callsReached(source: FakeSource, calls: number): Promise<void> {
	const deadline = Date.now() + 2000;
	for (;;) {
		if (source.calls >= calls) return;
		if (Date.now() >= deadline)
			throw new Error(`the source was called ${source.calls} times, wanted ${calls}`);
		await sleep(5);
	}
}
