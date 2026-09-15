/** Per-source refresh scheduling. A slow source never overlaps itself. */
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
	private stopped = false;
	private readonly sources: readonly TicketSource[];
	private readonly state: FactoryState;
	private readonly changed: (outcome?: FetchOutcome) => void;
	private readonly clock: RefreshClock;
	private readonly settled?: (sourceName: string) => void;

	constructor(
		sources: readonly TicketSource[],
		state: FactoryState,
		changed: (outcome?: FetchOutcome) => void,
		clock: RefreshClock = SYSTEM_CLOCK,
		options: { settled?: (sourceName: string) => void } = {},
	) {
		this.sources = sources;
		this.state = state;
		this.changed = changed;
		this.clock = clock;
		this.settled = options.settled;
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

	refresh(source: TicketSource): void {
		if (this.stopped || this.inFlight.has(source.name)) return;
		this.inFlight.add(source.name);
		// The pull request source covers its Issue references against the
		// live tickets and reads the uncovered ones directly (ADR 0023).
		const known = this.state.liveTicketLabels();
		let outcome: FetchOutcome;
		void Promise.resolve()
			.then(() => source.fetch(known))
			// A fetch can outlive the coordinator: the shutdown window between
			// stop() and the state closing must not touch either.
			.then((result) => {
				outcome = result;
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), result);
			})
			.catch((error) => {
				outcome = {
					status: "failed",
					reason: `unexpected source failure: ${error instanceof Error ? error.message : String(error)}`,
				};
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), outcome);
			})
			.finally(() => {
				this.inFlight.delete(source.name);
				if (this.stopped) return;
				this.changed(outcome);
				this.settled?.(source.name);
				const timer = this.clock.setTimeout(() => this.refresh(source), source.refreshIntervalMs);
				this.timers.set(source.name, timer);
			});
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
