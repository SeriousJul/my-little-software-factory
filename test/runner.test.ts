/**
 * The runner tests: the real runner against small limits.
 *
 * These tests run real commands through the real child process, because the
 * failure mapping (a missing program, a timeout, a buffer overflow) is the
 * contract. The limits are the only difference from production: the timeout
 * and the buffer are small, so a sleep of ten seconds proves the timeout and
 * one hundred kilobytes prove the buffer without waiting ten minutes.
 */
import { describe, expect, test } from "vitest";

import { createChildProcessRunner, errorMessage } from "../src/runner.ts";

describe("createChildProcessRunner", () => {
	test("a command that finishes in time returns its output and status", async () => {
		const runner = createChildProcessRunner();
		const result = await runner.run("echo", ["hello", "world"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("hello world\n");
		expect(result.stderr).toBe("");
	});

	test("a non-zero exit is a result, not a failure", async () => {
		const runner = createChildProcessRunner();
		const result = await runner.run("false", []);
		expect(result.code).toBe(1);
	});

	test("a missing program is a failed command with a reason", async () => {
		const runner = createChildProcessRunner();
		const result = await runner.run("factory-no-such-program", []);
		expect(result.code).toBe(127);
		expect(result.stderr).toContain("not found in PATH");
	});

	test("a command that runs past the timeout is a timeout", async () => {
		const runner = createChildProcessRunner({ timeoutMs: 1000 });
		const result = await runner.run("sleep", ["10"]);
		expect(result.code).toBe(124);
		expect(result.stderr).toContain("timed out after 1s");
	});

	test("a command that overflows the buffer fails as output, not as a timeout", async () => {
		const runner = createChildProcessRunner({ timeoutMs: 30_000, maxBuffer: 1024 });
		const result = await runner.run("head", ["-c", "100000", "/dev/zero"]);
		expect(result.code).toBe(125);
		// The buffer failure must not read as a timeout: the operator fixes
		// output, not time.
		expect(result.stderr).toContain("output exceeded the 1024-byte buffer");
		expect(result.stderr).not.toContain("timed out");
	});
});

describe("errorMessage", () => {
	test("a thrown error becomes one readable line", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("raw")).toBe("raw");
	});
});
