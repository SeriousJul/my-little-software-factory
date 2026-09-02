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

import {
	createChildProcessRunner,
	errorMessage,
	MODEL_LIST_COMMANDS,
	parsePiModelList,
	supportsModelList,
} from "../src/runner.ts";

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

describe("the Model list of an agent kind (ADR 0010)", () => {
	/** The header plus data rows of a real `pi --list-models` table. */
	function piTable(...rows: string[]): string {
		return [
			"provider  model                     context   max-out  thinking  images",
			...rows,
		].join("\n");
	}

	test("the pi kind queries pi's own CLI", () => {
		expect(MODEL_LIST_COMMANDS.pi).toEqual(["pi", "--list-models"]);
		expect(supportsModelList("pi")).toBe(true);
		// A kind with no list command keeps the free-text Model row: no agent CLI
		// runs for it.
		expect(supportsModelList("codex")).toBe(false);
		expect(supportsModelList("claude")).toBe(false);
		expect(supportsModelList("custom-cli")).toBe(false);
	});

	test("the table parses to whole provider-and-model values", () => {
		const list = parsePiModelList(
			piTable(
				"anthropic  claude-sonnet-4-5          200000  16384    true      true",
				"github-copilot  gpt-4o                    128000  16384    true      true",
				"opencodego  grok-4                      256000  999999   false     true",
				"openai-codex  gpt-5.1-codex             400000  128000   true      false",
			),
		);
		expect(list).toEqual({
			ok: true,
			models: [
				"anthropic/claude-sonnet-4-5",
				"github-copilot/gpt-4o",
				"opencodego/grok-4",
				"openai-codex/gpt-5.1-codex",
			],
		});
	});

	test("the values keep the order the CLI reported them in", () => {
		const list = parsePiModelList(
			piTable("zed  a  1  1  true  true", "alpha  b  1  1  true  true"),
		);
		expect(list.ok && list.models).toEqual(["zed/a", "alpha/b"]);
	});

	test("a provider name that carries spaces still parses", () => {
		const list = parsePiModelList(
			"provider  model  context  max-out  thinking  images\nmy  corp  model-x  1  1  true  true",
		);
		expect(list).toEqual({ ok: true, models: ["my  corp/model-x"] });
	});

	test("a header-only table is an empty list, not a failure", () => {
		expect(parsePiModelList("provider  model  context  max-out  thinking  images\n")).toEqual({
			ok: true,
			models: [],
		});
	});

	test("a line before the table does not hide the list", () => {
		// A tool manager announces the version it selected on the same stream
		// before the table lands, so the noise cannot be read as a row.
		const list = parsePiModelList(
			[
				"mise ~/.config/mise/config.toml tools: pi@0.84.4",
				"provider  model  context  max-out  thinking  images",
				"anthropic  claude-sonnet-4-5  200000  16384  true  true",
			].join("\n"),
		);
		expect(list).toEqual({ ok: true, models: ["anthropic/claude-sonnet-4-5"] });
	});

	test("a model id that carries a slash keeps its own provider", () => {
		// The value form is what pi's --model option takes, so a GGUF repo path
		// in the model column must not be mistaken for the provider.
		const list = parsePiModelList(
			"provider  model  context  max-out  thinking  images\nllama-server=http://127.0.0.1:8080  AtomicChat/DeepSeek-V4:IQ1_M_XL  131.1K  131.1K  yes  no",
		);
		expect(list).toEqual({
			ok: true,
			models: ["llama-server=http://127.0.0.1:8080/AtomicChat/DeepSeek-V4:IQ1_M_XL"],
		});
	});

	test("a table with no header row fails with a readable reason", () => {
		const list = parsePiModelList("anthropic  claude-sonnet-4-5  200000  16384  true  true");
		expect(list.ok).toBe(false);
		if (list.ok) throw new Error("expected a failure");
		expect(list.reason).toContain("pi --list-models");
		expect(list.reason).toContain("header");
	});

	test("a short row fails the table instead of guessing a model", () => {
		const list = parsePiModelList(
			"provider  model  context  max-out  thinking  images\nshort  row",
		);
		expect(list.ok).toBe(false);
		if (list.ok) throw new Error("expected a failure");
		expect(list.reason).toContain("columns");
	});

	test("empty output fails the table: an agent that answers nothing is not a list", () => {
		expect(parsePiModelList("  \n").ok).toBe(false);
	});

	test("the real runner reports an unknown kind without running a command", async () => {
		// Nothing spawns: an unmapped kind has no command to run.
		const list = await createChildProcessRunner().listModels("no-such-kind");
		expect(list).toEqual({
			ok: false,
			reason: 'the agent kind "no-such-kind" has no model list command',
		});
	});
});

describe("errorMessage", () => {
	test("a thrown error becomes one readable line", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("raw")).toBe("raw");
	});
});
