/**
 * The runner tests: the real runner against small limits.
 *
 * These tests run real commands through the real child process, because the
 * failure mapping (a missing program, a timeout, a buffer overflow) is the
 * contract. The limits are the only difference from production: the timeout
 * and the buffer are small, so a sleep of ten seconds proves the timeout and
 * one hundred kilobytes prove the buffer without waiting ten minutes.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { renderSettingArgs } from "../src/handoff.ts";
import {
	createChildProcessRunner,
	errorMessage,
	MODEL_LIST_COMMANDS,
	MODEL_LIST_TIMEOUT_MS,
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

	test("the pi kind queries pi's own CLI and reads its own table", () => {
		expect(MODEL_LIST_COMMANDS.pi?.argv).toEqual(["pi", "--list-models"]);
		// The reader travels with the command: a kind's entry answers for both
		// halves, so a second kind cannot be read by pi's parser by accident.
		expect(
			MODEL_LIST_COMMANDS.pi?.parse(
				piTable("anthropic  claude-sonnet-4-5  200000  16384    true      true"),
			),
		).toEqual({
			ok: true,
			models: ["anthropic/claude-sonnet-4-5"],
		});
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

	test("a row whose value carries whitespace fails the whole table", () => {
		// A provider printed across two cells is a layout this reader does not
		// know, and its value could never reach the agent as one argument cell.
		// The list is refused rather than half-offered: ADR 0010 rules out a
		// partial list, and a value with a space in it is a value the panel's
		// type-ahead cannot type either.
		const list = parsePiModelList(
			"provider  model  context  max-out  thinking  images\nmy  corp  model-x  1  1  true  true",
		);
		expect(list.ok).toBe(false);
		if (list.ok) throw new Error("expected a failure");
		expect(list.reason).toContain("whitespace");
		expect(list.reason).toContain("my  corp/model-x");
	});

	test("every value the parser offers is one argument cell", () => {
		// The offer contract, end to end: the panel puts a parsed value on the
		// Model row, the fit check compares that same string, and the start
		// command carries it to the agent. A value that splits into two cells is
		// a model nobody chose.
		const list = parsePiModelList(
			piTable(
				"anthropic  claude-sonnet-4-5  200000  16384  true  true",
				"llama.cpp  Qwen2.5-Coder/qwen3-tts-1.7b-base-GGUF  131.1K  131.1K  yes  no",
				"llama-server=http://127.0.0.1:8080  AtomicChat/DeepSeek-V4:IQ1_M_XL  131.1K  131.1K  yes  no",
			),
		);
		if (!list.ok) throw new Error(`expected a list, got: ${list.reason}`);
		expect(list.models).toHaveLength(3);
		for (const model of list.models) {
			expect(renderSettingArgs("--model {value}", model)).toEqual(["--model", model]);
		}
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

/**
 * The real query path, against a stand-in agent CLI on PATH.
 *
 * Every other test hands the flow a fake runner, so the fake answers the query
 * and the real path runs nothing. This is the one place where a wrong argv, a
 * table read from the wrong stream, an ignored exit code, or a budget that
 * never expires could ship silently, so these tests spawn a real program that
 * prints a pinned table and pin what the runner does with it.
 */
describe("the real runner's Model list query", () => {
	let dir = "";
	let savedPath = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "factory-runner-pi-"));
		savedPath = process.env.PATH ?? "";
		// libuv resolves a bare program name through this process's PATH, so
		// putting the stub first is what makes `pi` resolve to it.
		process.env.PATH = `${dir}:${savedPath}`;
	});

	afterEach(() => {
		process.env.PATH = savedPath;
		rmSync(dir, { recursive: true, force: true });
	});

	/** Write the stand-in `pi` the query spawns. */
	function stubPi(script: string): void {
		const path = join(dir, "pi");
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
	}

	test("the query runs the kind's own command and reads the table it prints", async () => {
		// The stub prints its own argv into the model column, so the value the
		// parser returns is the proof of the command that ran.
		stubPi(
			[
				"printf 'provider  model  context  max-out  thinking  images\\n'",
				"printf 'pinned  %s  1  1  true  true\\n' \"$*\"",
			].join("\n"),
		);

		expect(await createChildProcessRunner().listModels("pi")).toEqual({
			ok: true,
			models: ["pinned/--list-models"],
		});
	});

	test("the query reads the table from stdout, not stderr", async () => {
		stubPi(
			[
				"printf 'provider  model  context  max-out  thinking  images\\n'",
				"echo 'noise  row  1  1  true  true' >&2",
				"printf 'anthropic  claude-sonnet-4-5  1  1  true  true\\n'",
			].join("\n"),
		);

		expect(await createChildProcessRunner().listModels("pi")).toEqual({
			ok: true,
			models: ["anthropic/claude-sonnet-4-5"],
		});
	});

	test("a non-zero exit is a failure that carries the command's own reason", async () => {
		stubPi("echo 'pi: no provider is configured' >&2\nexit 3");

		const list = await createChildProcessRunner().listModels("pi");
		expect(list.ok).toBe(false);
		if (list.ok) throw new Error("expected a failure");
		expect(list.reason).toContain("pi --list-models failed");
		expect(list.reason).toContain("pi: no provider is configured");
	});

	test("a query that passes its budget fails instead of holding the caller", async () => {
		stubPi("sleep 30");

		const list = await createChildProcessRunner({ modelListTimeoutMs: 500 }).listModels("pi");
		expect(list.ok).toBe(false);
		if (list.ok) throw new Error("expected a failure");
		expect(list.reason).toContain("pi --list-models failed");
		expect(list.reason).toContain("timed out after 0.5s");
	});

	test("the query budget is a query budget, not the handoff's", () => {
		// The query now sits on boot, before any output, and on every handoff.
		// Ten minutes is the clone budget; a lookup the agent answers in half a
		// second must fail in seconds when it does not answer at all.
		expect(MODEL_LIST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
	});
});

describe("errorMessage", () => {
	test("a thrown error becomes one readable line", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("raw")).toBe("raw");
	});
});
