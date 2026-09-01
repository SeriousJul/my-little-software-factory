/**
 * A ticket source whose fetches stay in flight until the test settles
 * them. A test boots the app, waits for the behavior it wants, and then
 * settles the fetches to drive the state forward. No test in the suite can
 * race a source clock through it.
 */
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";

export class FakeSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs = 60_000;
	calls = 0;
	private resolvers: Array<() => void> = [];
	private next: FetchOutcome;

	constructor(name: string, kind: string, next: FetchOutcome) {
		this.name = name;
		this.kind = kind;
		this.next = next;
	}

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise<FetchOutcome>((resolve) => {
			this.resolvers.push(() => resolve(this.next));
		});
	}

	/** Settle every in-flight fetch with the given outcome. */
	settle(outcome: FetchOutcome): void {
		this.next = outcome;
		for (const resolve of this.resolvers.splice(0)) resolve();
	}
}
