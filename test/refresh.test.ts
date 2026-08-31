import { describe, expect, test } from "vitest";

import { type RefreshClock, RefreshCoordinator } from "../src/refresh.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";

const EMPTY: FetchOutcome = { status: "success", fetchedAt: "2026-01-01T00:00:00Z", tickets: [] };
const RATE_LIMITED: FetchOutcome = { status: "failed", reason: "GitHub rate limit exceeded" };

class ControlledSource implements TicketSource {
	readonly name: string;
	readonly kind = "github-issues";
	readonly refreshIntervalMs: number;
	calls = 0;
	private resolvers: Array<(outcome: FetchOutcome) => void> = [];

	constructor(name: string, refreshIntervalMs: number) {
		this.name = name;
		this.refreshIntervalMs = refreshIntervalMs;
	}

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise((resolve) => this.resolvers.push(resolve));
	}

	/** Settle every in-flight fetch. */
	settle(outcome: FetchOutcome): void {
		for (const resolve of this.resolvers.splice(0)) resolve(outcome);
	}
}

class FakeClock implements RefreshClock {
	readonly delays: number[] = [];
	private nextId = 1;
	private readonly live = new Map<number, { delay: number; callback: () => void }>();

	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
		const id = this.nextId++;
		this.live.set(id, { delay: milliseconds, callback });
		this.delays.push(milliseconds);
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		this.live.delete(Number(handle));
	}

	/** Fire the oldest pending timer. */
	fireOldest(): void {
		const [id, timer] = [...this.live.entries()][0] ?? [];
		if (timer === undefined) return;
		this.live.delete(id);
		timer.callback();
	}

	get pending(): number {
		return this.live.size;
	}
}

async function turns(): Promise<void> {
	// Drain every pending microtask before continuing the test.
	await new Promise((resolve) => setImmediate(resolve));
	await Promise.resolve();
}

describe("RefreshCoordinator", () => {
	test("starts immediately, skips duplicate manual work, and schedules only after settlement", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("issues", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(source.calls).toBe(1);
		expect(coordinator.isFetching(source.name)).toBe(true);

		coordinator.refreshAll();
		coordinator.refreshAll();
		expect(source.calls).toBe(1);

		source.settle(EMPTY);
		await turns();
		expect(coordinator.isFetching(source.name)).toBe(false);
		expect(clock.delays).toEqual([60_000]);
		clock.fireOldest();
		await turns();
		expect(source.calls).toBe(2);
		coordinator.stop();
		expect(clock.pending).toBe(0);
		state.close();
	});

	test("a slow in-flight source never blocks a fast source", async () => {
		const state = openFactoryState(":memory:");
		const slow = new ControlledSource("slow", 60_000);
		const fast = new ControlledSource("fast", 10_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([slow, fast], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(slow.calls).toBe(1);
		expect(fast.calls).toBe(1);

		// The fast source settles and schedules its own next fetch...
		fast.settle(EMPTY);
		await turns();
		expect(clock.delays).toEqual([10_000]);

		// ...whose timer fires a new fast fetch while the slow one is still in flight.
		clock.fireOldest();
		await turns();
		expect(fast.calls).toBe(2);
		expect(coordinator.isFetching("fast")).toBe(true);
		expect(coordinator.isFetching("slow")).toBe(true);

		// The slow source settles as a failure and schedules its own retry interval.
		slow.settle(RATE_LIMITED);
		await turns();
		expect(clock.delays).toEqual([10_000, 60_000]);
		expect(coordinator.isFetching("slow")).toBe(false);
		expect(state.sourceHealths()).toContainEqual({
			name: "slow",
			kind: "github-issues",
			health: "stale",
			error: "GitHub rate limit exceeded",
		});

		// The slow source's retry timer is independent of the fast source's.
		clock.fireOldest();
		await turns();
		expect(slow.calls).toBe(2);
		coordinator.stop();
		expect(clock.pending).toBe(0);
		state.close();
	});

	test("retries after a failed outcome", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("issues", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		source.settle(RATE_LIMITED);
		await turns();
		expect(state.sourceHealths()).toEqual([
			{
				name: "issues",
				kind: "github-issues",
				health: "stale",
				error: "GitHub rate limit exceeded",
			},
		]);
		// A failed outcome does not stop the source: the next refresh is scheduled.
		expect(clock.delays).toEqual([60_000]);
		clock.fireOldest();
		await turns();
		expect(source.calls).toBe(2);
		coordinator.stop();
		state.close();
	});

	test("an unexpected rejection settles as a failed outcome and keeps scheduling", async () => {
		const state = openFactoryState(":memory:");
		const broken: TicketSource = {
			name: "broken",
			kind: "github-issues",
			refreshIntervalMs: 60_000,
			fetch: () => Promise.reject(new Error("adapter defect")),
		};
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([broken], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(state.sourceHealths()).toEqual([
			{
				name: "broken",
				kind: "github-issues",
				health: "stale",
				error: "unexpected source failure: adapter defect",
			},
		]);
		expect(clock.delays).toEqual([60_000]);

		// The retry fires, fails the same way, and schedules the next attempt.
		clock.fireOldest();
		await turns();
		expect(clock.delays).toEqual([60_000, 60_000]);
		coordinator.stop();
		expect(clock.pending).toBe(0);
		state.close();
	});
});
