/**
 * Tests for the node version gate.
 *
 * The gate is pure logic over a version string, so it is tested directly.
 */
import { describe, expect, test } from "vitest";

import { compareVersions, isSupportedNodeVersion, MIN_NODE_VERSION } from "../src/runtime.ts";

describe("the node version gate", () => {
	test("the requirement matches the OpenTUI native renderer floor", () => {
		expect(MIN_NODE_VERSION).toBe("26.4.0");
	});

	test("compareVersions orders dotted versions", () => {
		expect(compareVersions("26.4.0", "26.4.0")).toBe(0);
		expect(compareVersions("26.5.0", "26.4.0")).toBe(1);
		expect(compareVersions("26.3.9", "26.4.0")).toBe(-1);
		expect(compareVersions("27.0.0", "26.4.0")).toBe(1);
		expect(compareVersions("25.99.99", "26.4.0")).toBe(-1);
	});

	test("compareVersions treats missing parts as zero", () => {
		expect(compareVersions("26.4", "26.4.0")).toBe(0);
		expect(compareVersions("26", "26.4.0")).toBe(-1);
	});

	test("isSupportedNodeVersion accepts the floor and above", () => {
		expect(isSupportedNodeVersion("26.4.0")).toBe(true);
		expect(isSupportedNodeVersion("26.5.0")).toBe(true);
		expect(isSupportedNodeVersion("27.1.2")).toBe(true);
	});

	test("isSupportedNodeVersion rejects versions below the floor", () => {
		expect(isSupportedNodeVersion("26.3.9")).toBe(false);
		expect(isSupportedNodeVersion("22.12.0")).toBe(false);
		expect(isSupportedNodeVersion("20.0.0")).toBe(false);
	});
});
