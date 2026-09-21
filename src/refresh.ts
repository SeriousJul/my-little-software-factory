/** Per-source refresh scheduling. A slow source never overlaps itself. */
import type { Logger } from "./logging.ts";
import type { FactoryState, SourceDefinition } from "./state.ts";
import type { FetchOutcome, TicketSource } from "./ticket-source.ts";

export interface RefreshClock {
	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const SYSTEM_CLOCK: RefreshClock = { setTimeout, clearTimeout };

export class RefreshCoordinator {
	private readonly inFlight = new Set<string>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The waiters on a source's in-flight fetch, by source name. */
	private readonly settling = new Map<string, Set<() => void>>();
	private stopped = false;
	private readonly sources: readonly TicketSource[];
	private readonly state: FactoryState;
	private readonly changed: (outcome?: FetchOutcome) => void;
	private readonly clock: RefreshClock;
	private readonly settled?: (sourceName: string) => void;
	private readonly log?: Logger;

	constructor(
		sources: readonly TicketSource[],
		state: FactoryState,
		changed: (outcome?: FetchOutcome) => void,
		clock: RefreshClock = SYSTEM_CLOCK,
		options: { settled?: (sourceName: string) => void; log?: Logger } = {},
	) {
		this.sources = sources;
		this.state = state;
		this.changed = changed;
		this.clock = clock;
		this.settled = options.settled;
		this.log = options.log;
	}

	start(): void {
		this.state.initializeSources(this.sources.map(sourceDefinition));
		this.changed();
		this.refreshAll();
	}

	/**
	 * Start every idle source and return the names this call started.
	 *
	 * The idle filter lives in `idleSources()` alone, so the count a manual
	 * refresh reports and the names it waits for can never disagree.
	 */
	refreshAll(): string[] {
		const idle = this.idleSources();
		for (const source of idle) this.refresh(source);
		return idle.map((source) => source.name);
	}

	/**
	 * Start one source's fetch now, ahead of its schedule. A source that is
	 * already fetching keeps its in-flight fetch. The pending timer is
	 * cancelled, and the fetch's own completion reschedules it, so a
	 * triggered refresh never leaves a duplicate schedule behind. Returns
	 * whether this call started a fetch.
	 */
	refreshNow(sourceName: string): boolean {
		if (this.stopped || this.inFlight.has(sourceName)) return false;
		const source = this.sources.find((candidate) => candidate.name === sourceName);
		if (source === undefined) return false;
		const timer = this.timers.get(sourceName);
		if (timer !== undefined) {
			this.clock.clearTimeout(timer);
			this.timers.delete(sourceName);
		}
		this.refresh(source);
		return true;
	}

	/** The sources a refresh can start: the ones not already fetching. */
	idleSources(): readonly TicketSource[] {
		return this.sources.filter((source) => !this.inFlight.has(source.name));
	}

	/**
	 * Refresh one source and wait for its fetch to settle (ADR 0027). The
	 * transition fire needs the pull request's labels fresh before it judges
	 * them, and the fire runs inside the observation cycle: this does not
	 * poll, it waits on the fetch the coordinator already owns. A source that
	 * is already fetching joins that fetch's settlement. A stopped or unknown
	 * source resolves without fetching.
	 */
	refreshAndWait(sourceName: string): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.sources.find((source) => source.name === sourceName) === undefined)
			return Promise.resolve();
		if (!this.inFlight.has(sourceName)) this.refreshNow(sourceName);
		return new Promise<void>((resolve) => {
			// The in-flight fetch owns the waiter set. No set means nothing is
			// fetching - a stop between the two checks - and a waiter must not
			// hang on a fetch that will never settle.
			const resolvers = this.settling.get(sourceName);
			if (resolvers === undefined) resolve();
			else resolvers.add(resolve);
		});
	}

	refresh(source: TicketSource): void {
		if (this.stopped || this.inFlight.has(source.name)) return;
		this.inFlight.add(source.name);
		// Every fetch owns a waiter set, so a `refreshAndWait` that joins an
		// in-flight fetch always has somewhere to register.
		this.settling.set(source.name, new Set());
		// The pull request source covers its Issue references against the
		// live tickets and reads the uncovered ones directly (ADR 0023).
		const known = this.state.liveTicketLabels();
		const startedAt = Date.now();
		let outcome: FetchOutcome;
		void Promise.resolve()
			.then(() => source.fetch(known))
			// A fetch can outlive the coordinator: the shutdown window between
			// stop() and the state closing must not touch either.
			.then((result) => {
				outcome = result;
				this.logRefresh(source.name, result, startedAt);
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), result);
			})
			.catch((error) => {
				outcome = {
					status: "failed",
					reason: `unexpected source failure: ${error instanceof Error ? error.message : String(error)}`,
				};
				this.logRefresh(source.name, outcome, startedAt);
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), outcome);
			})
			.finally(() => {
				this.inFlight.delete(source.name);
				// The waiters settle before the shutdown check: a stopped
				// coordinator still settles the fetch it started, and a waiter
				// stranded on a stopped fetch would hold the transition fire
				// open for nothing.
				const resolvers = this.settling.get(source.name);
				if (resolvers !== undefined) {
					this.settling.delete(source.name);
					for (const resolve of resolvers) resolve();
				}
				if (this.stopped) return;
				this.changed(outcome);
				this.settled?.(source.name);
				const timer = this.clock.setTimeout(() => this.refresh(source), source.refreshIntervalMs);
				this.timers.set(source.name, timer);
			});
	}

	/**
	 * The record line a settled fetch leaves: an info with the ticket count,
	 * a warn with the reason. A stopped coordinator still records: the run
	 * ended, and the fetch it started is part of the run's record.
	 */
	private logRefresh(
		sourceName: string,
		result: { status: "success"; tickets: unknown[] } | { status: "failed"; reason: string },
		startedAt: number,
	): void {
		if (this.log === undefined) return;
		const durationMs = Date.now() - startedAt;
		if (result.status === "success") {
			const tickets = result.tickets.length;
			this.log.info(
				`${sourceName}: refresh ok, ${tickets} ticket${tickets === 1 ? "" : "s"}, ${durationMs} ms`,
			);
			return;
		}
		this.log.warn(`${sourceName}: refresh failed after ${durationMs} ms: ${result.reason}`);
	}

	isFetching(sourceName: string): boolean {
		return this.inFlight.has(sourceName);
	}

	stop(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
		this.timers.clear();
	}
}

function sourceDefinition(source: TicketSource): SourceDefinition {
	return { name: source.name, kind: source.kind };
}
