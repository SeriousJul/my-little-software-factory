import { describe, expect, test } from "vitest";

import { type RefreshClock, RefreshCoordinator } from "../src/refresh.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";

class ControlledSource implements TicketSource {
	readonly name = "issues";
	readonly kind = "github-issues";
	readonly refreshIntervalMs = 60_000;
	calls = 0;
	private resolve: ((outcome: FetchOutcome) => void) | undefined;

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	settle(outcome: FetchOutcome): void {
		this.resolve?.(outcome);
	}
}

class FakeClock implements RefreshClock {
	readonly delays: number[] = [];
	private callback: (() => void) | undefined;

	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
		this.callback = callback;
		this.delays.push(milliseconds);
		return 1 as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(): void {
		this.callback = undefined;
	}

	fire(): void {
		const callback = this.callback;
		this.callback = undefined;
		callback?.();
	}
}

async function turns(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("RefreshCoordinator", () => {
	test("starts immediately, skips duplicate manual work, and schedules only after settlement", async () => {
		const state = openFactoryState(":memory:");
		const source = new ControlledSource();
		const clock = new FakeClock();
		const coordinator = new RefreshCoordinator([source], state, () => undefined, clock);
		coordinator.start();
		await turns();
		expect(source.calls).toBe(1);
		expect(coordinator.isFetching(source.name)).toBe(true);

		coordinator.refreshAll();
		coordinator.refreshAll();
		expect(source.calls).toBe(1);

		source.settle({ status: "success", fetchedAt: "2026-01-01T00:00:00Z", tickets: [] });
		await turns();
		expect(coordinator.isFetching(source.name)).toBe(false);
		expect(clock.delays).toEqual([60_000]);
		clock.fire();
		await turns();
		expect(source.calls).toBe(2);
		coordinator.stop();
		state.close();
	});
});
