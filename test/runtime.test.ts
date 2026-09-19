/**
 * Tests for the Bun version gate.
 *
 * The gate is pure logic over a version string, so it is tested directly.
 */
import { describe, expect, test } from "bun:test";

import {
	compareVersions,
	isSupportedBunVersion,
	MIN_BUN_VERSION,
	unsupportedBunVersionMessage,
} from "../src/runtime.ts";

describe("the bun version gate", () => {
	test("the requirement matches the OpenTUI native renderer floor", () => {
		expect(MIN_BUN_VERSION).toBe("1.3.0");
	});

	test("compareVersions orders dotted versions", () => {
		expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
		expect(compareVersions("1.4.0", "1.3.0")).toBe(1);
		expect(compareVersions("1.2.9", "1.3.0")).toBe(-1);
		expect(compareVersions("2.0.0", "1.3.0")).toBe(1);
		expect(compareVersions("1.2.99", "1.3.0")).toBe(-1);
	});

	test("compareVersions treats missing parts as zero", () => {
		expect(compareVersions("1.3", "1.3.0")).toBe(0);
		expect(compareVersions("1", "1.3.0")).toBe(-1);
	});

	test("isSupportedBunVersion accepts the floor and above", () => {
		expect(isSupportedBunVersion("1.3.0")).toBe(true);
		expect(isSupportedBunVersion("1.4.0")).toBe(true);
		expect(isSupportedBunVersion("2.1.2")).toBe(true);
	});

	test("isSupportedBunVersion rejects versions below the floor", () => {
		expect(isSupportedBunVersion("1.2.9")).toBe(false);
		expect(isSupportedBunVersion("1.0.0")).toBe(false);
		expect(isSupportedBunVersion("0.9.0")).toBe(false);
	});

	test("the failure message names the required version, the actual one, and the reason", () => {
		const message = unsupportedBunVersionMessage("1.0.0");
		expect(message).toContain("Bun 1.3.0 or newer");
		expect(message).toContain("Bun 1.0.0");
		expect(message).toContain("FFI");
		// The operator can act on it: no stack trace, no code path.
		expect(message).not.toContain("at ");
	});
});
