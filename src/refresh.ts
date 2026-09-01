/** Per-source refresh scheduling. A slow source never overlaps itself. */
import type { FactoryState, SourceDefinition } from "./state.ts";
import type { TicketSource } from "./ticket-source.ts";

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
	private readonly changed: () => void;
	private readonly clock: RefreshClock;

	constructor(
		sources: readonly TicketSource[],
		state: FactoryState,
		changed: () => void,
		clock: RefreshClock = SYSTEM_CLOCK,
	) {
		this.sources = sources;
		this.state = state;
		this.changed = changed;
		this.clock = clock;
	}

	start(): void {
		this.state.initializeSources(this.sources.map(sourceDefinition));
		this.changed();
		this.refreshAll();
	}

	refreshAll(): void {
		for (const source of this.sources) this.refresh(source);
	}

	refresh(source: TicketSource): void {
		if (this.stopped || this.inFlight.has(source.name)) return;
		this.inFlight.add(source.name);
		void Promise.resolve()
			.then(() => source.fetch())
			// A fetch can outlive the coordinator: the shutdown window between
			// stop() and the state closing must not touch either.
			.then((outcome) => {
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), outcome);
			})
			.catch((error) => {
				if (this.stopped) return;
				this.state.applyFetch(sourceDefinition(source), {
					status: "failed",
					reason: `unexpected source failure: ${error instanceof Error ? error.message : String(error)}`,
				});
			})
			.finally(() => {
				this.inFlight.delete(source.name);
				if (this.stopped) return;
				this.changed();
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
