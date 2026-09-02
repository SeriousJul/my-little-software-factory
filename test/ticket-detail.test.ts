/** Deterministic wheel-burst policy tests for the native Ticket detail viewport. */
import { describe, expect, test } from "vitest";
import {
	newWheelBurst,
	WHEEL_ACCELERATION_PAUSE_MS,
	wheelRows,
} from "../src/components/ticket-detail.ts";
import type { ScrollConfig } from "../src/config.ts";

const settings: ScrollConfig = { speed: 1, acceleration: 0.8, maximumSpeed: 6 };

describe("Ticket detail wheel acceleration", () => {
	test("starts precisely, accelerates during a burst, and caps speed", () => {
		const burst = newWheelBurst();
		expect(wheelRows(settings, burst, "down", 0, true)).toBe(1);
		expect(wheelRows(settings, burst, "down", 50, true)).toBeGreaterThan(1);
		for (let now = 55; now < 100; now += 5) {
			wheelRows(settings, burst, "down", now, true);
		}
		expect(wheelRows(settings, burst, "down", 105, true)).toBeLessThanOrEqual(6);
	});

	test("resets after a pause, reversal, or blocked movement", () => {
		const burst = newWheelBurst();
		expect(wheelRows(settings, burst, "down", 0, true)).toBe(1);
		expect(wheelRows(settings, burst, "down", 50, true)).toBeGreaterThan(1);
		expect(wheelRows(settings, burst, "down", 50 + WHEEL_ACCELERATION_PAUSE_MS + 1, true)).toBe(1);
		expect(wheelRows(settings, burst, "up", 250, true)).toBe(1);
		expect(wheelRows(settings, burst, "up", 260, false)).toBe(0);
		expect(wheelRows(settings, burst, "up", 270, true)).toBe(1);
	});

	test("keeps wheel movement linear when either Config limit disables acceleration", () => {
		for (const linear of [
			{ speed: 3, acceleration: 0, maximumSpeed: 8 },
			{ speed: 3, acceleration: 4, maximumSpeed: 3 },
		] satisfies ScrollConfig[]) {
			const burst = newWheelBurst();
			expect(wheelRows(linear, burst, "down", 0, true)).toBe(3);
			expect(wheelRows(linear, burst, "down", 1, true)).toBe(3);
			expect(wheelRows(linear, burst, "down", 2, true)).toBe(3);
		}
	});
});
