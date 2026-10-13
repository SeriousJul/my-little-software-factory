/**
 * A ticket source whose fetches stay in flight until the test settles
 * them. A test boots the app, waits for the behavior it wants, and then
 * settles the fetches to drive the state forward. No test in the suite can
 * race a source clock through it.
 *
 * The auto form stamps a settled read from the clock the plane opened it
 * with, so the state the fetch writes and the clock the state reads stay
 * one clock: the settled read stands on the outcome the double holds,
 * re-stamped at the settle. The manual form settles on the outcome it
 * holds, as given.
 */
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";

export class FakeSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs = 60_000;
	calls = 0;
	private resolvers: Array<() => void> = [];
	private next: FetchOutcome;
	private autoSettle: boolean;
	private now: () => number;

	constructor(
		name: string,
		kind: string,
		next: FetchOutcome,
		/**
		 * The double the plane stands for each of its sources settles its reads
		 * on this shape: the outcome the double holds, and the clock it stamps a
		 * self-settled read with.
		 */
		settle: {
			autoSettle?: boolean;
			now?: () => number;
		} = {},
	) {
		this.name = name;
		this.kind = kind;
		this.next = next;
		this.autoSettle = settle.autoSettle ?? false;
		this.now = settle.now ?? (() => Date.now());
	}

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise<FetchOutcome>((resolve) => {
			this.resolvers.push(() => resolve(this.autoSettle ? this.restamp() : this.next));
		});
	}

	/** The outcome the auto form settles a read with: the standing's, on the plane's clock. */
	private restamp(): FetchOutcome {
		if (this.next.status !== "success") return this.next;
		return {
			...this.next,
			fetchedAt: new Date(this.now()).toISOString(),
		};
	}

	/** Settle every in-flight fetch with the given outcome. */
	settle(outcome: FetchOutcome): void {
		this.next = outcome;
		for (const resolve of this.resolvers.splice(0)) resolve();
	}

	/** Settle every in-flight fetch with the outcome the double stands on. */
	settleCurrent(): void {
		this.settle(this.next);
	}
}
