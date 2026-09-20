import { describe, expect, test } from "vitest";

import { type RefreshClock, RefreshCoordinator } from "../src/refresh.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome, LiveTicket, TicketSource } from "../src/ticket-source.ts";
import { issueTicket, success } from "./state-fixture.ts";

const EMPTY: FetchOutcome = { status: "success", fetchedAt: "2026-01-01T00:00:00Z", tickets: [] };
const RATE_LIMITED: FetchOutcome = { status: "failed", reason: "GitHub rate limit exceeded" };

class ControlledSource implements TicketSource {
	readonly name: string;
	readonly kind = "github-issues";
	readonly refreshIntervalMs: number;
	calls = 0;
	/** The live tickets the coordinator passed to the last fetch. */
	lastKnown: readonly LiveTicket[] = [];
	private resolvers: Array<(outcome: FetchOutcome) => void> = [];

	constructor(name: string, refreshIntervalMs: number) {
		this.name = name;
		this.refreshIntervalMs = refreshIntervalMs;
	}

	fetch(knownLiveTickets: readonly LiveTicket[] = []): Promise<FetchOutcome> {
		this.lastKnown = knownLiveTickets;
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

	test("passes the live tickets and their labels to the fetch (ADR 0023)", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("issues", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		// A fresh state holds no live tickets yet.
		expect(source.lastKnown).toEqual([]);
		// The first refresh lists one ticket: it is live from here on.
		source.settle(success([issueTicket("github:github.com:I_5")]));
		await turns();
		clock.fireOldest();
		await turns();
		expect(source.calls).toBe(2);
		expect(source.lastKnown).toEqual([
			{ identity: "github:github.com:I_5", labels: ["ready-for-agent"] },
		]);
		coordinator.stop();
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

	test("refreshNow pulls the next fetch forward and leaves one schedule behind", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("issues", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(source.calls).toBe(1);
		source.settle(EMPTY);
		await turns();
		expect(clock.pending).toBe(1);

		// The triggered fetch cancels the pending interval and starts at once.
		expect(coordinator.refreshNow(source.name)).toBe(true);
		await turns();
		expect(source.calls).toBe(2);
		expect(clock.pending).toBe(0);
		// A source that is fetching keeps its in-flight fetch, and a name no
		// source holds starts nothing.
		expect(coordinator.refreshNow(source.name)).toBe(false);
		expect(coordinator.refreshNow("absent")).toBe(false);
		// The fetch's own completion reschedules the one interval, so the
		// cancellation left no duplicate behind.
		source.settle(EMPTY);
		await turns();
		expect(clock.pending).toBe(1);
		expect(clock.delays).toEqual([60_000, 60_000]);
		coordinator.stop();
		expect(clock.pending).toBe(0);
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

describe("refreshAndWait", () => {
	test("it waits for the source's own fetch to settle", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("pulls", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(source.calls).toBe(1);

		// The fire's wait joins the fetch the coordinator already owns: it
		// settles when that fetch does, and it never starts a second one.
		let settled = false;
		const waiting = coordinator.refreshAndWait(source.name).then(() => {
			settled = true;
		});
		await turns();
		expect(settled).toBe(false);
		expect(source.calls).toBe(1);
		source.settle(EMPTY);
		await waiting;
		expect(settled).toBe(true);
		coordinator.stop();
		state.close();
	});

	test("it pulls the next fetch forward and waits on it", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("pulls", 60_000);
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		source.settle(EMPTY);
		await turns();
		expect(source.calls).toBe(1);

		const waiting = coordinator.refreshAndWait(source.name);
		await turns();
		// The wait starts its own fetch and cancels the pending interval.
		expect(source.calls).toBe(2);
		expect(clock.pending).toBe(0);
		source.settle(EMPTY);
		await waiting;
		// The fetch's own completion leaves exactly one schedule behind.
		expect(clock.pending).toBe(1);
		coordinator.stop();
		state.close();
	});

	test("an unknown or stopped source resolves without fetching", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource("pulls", 60_000);
		const coordinator = new RefreshCoordinator([source], state, () => undefined, new FakeClock());
		coordinator.start();
		await turns();
		source.settle(EMPTY);
		await turns();
		coordinator.stop();
		const calls = source.calls;
		// A name no source holds, and a stopped coordinator, both settle at
		// once: a transition fire never waits on a fetch that will not run.
		await coordinator.refreshAndWait("absent");
		await coordinator.refreshAndWait(source.name);
		expect(source.calls).toBe(calls);
		state.close();
	});
});
