/**
 * The desktop notification of a standing warning or error fact (ADR 0080).
 *
 * The module tests build the shared attention service with a fake command
 * runner and an injectable platform, and assert the exact command per
 * sender branch, the standing-fact rule, the config gate, and the failed
 * send's degrade. The app harness tests drive the real app with a fake
 * runner and isolated state: a warning or error fact that lands on the
 * Message line spawns the notification command, an identical standing fact
 * spawns none, a different fact resets the rule, and a config-off run
 * spawns none.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttentionService, DESKTOP_NOTIFICATION_APP_NAME } from "../src/attention.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/runner.ts";
import { openFactoryState } from "../src/state.ts";
import { awaitFrame, HEIGHT, messageRowOf, press, settle, WIDTH, withApp } from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { agentListJson, FakeRunner, type RecordedCommand } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import { cleanupStateFixtures } from "./state-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "factory-attention-"));
afterEach(() => {
	cleanupStateFixtures();
	rmSync(home, { recursive: true, force: true });
});

/** Let a fire-and-forget send settle through the fake runner. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The notification commands a runner recorded, whatever the platform. */
function notificationCalls(runner: FakeRunner): RecordedCommand[] {
	return runner.calls.filter(
		(call) =>
			call.command === "notify-send" ||
			call.command === "osascript" ||
			call.command === "powershell",
	);
}

/** A config the service reads live, beside the service that reads it. */
function makeService(
	platform: string,
	options: {
		config?: FactoryConfig;
		runner?: CommandRunner;
		logger?: Record<string, string[]>;
	} = {},
) {
	const config: FactoryConfig = { ...BASE_CONFIG, ...(options.config ?? {}) };
	const runner = (options.runner ?? new FakeRunner()) as CommandRunner;
	const log = options.logger ?? { warn: [] as string[] };
	const logger = {
		level: "info" as const,
		debug: (message: string) => void message,
		info: (message: string) => void message,
		warn: (message: string) => log.warn.push(message),
		error: (message: string) => void message,
	};
	return {
		config,
		runner,
		log,
		service: new AttentionService(() => config, runner, { platform, logger }),
	};
}

/** The failing-handoff stubs: the handoff dies on its workspace list. */
function failingHandoffRunner(): FakeRunner {
	const runner = new FakeRunner();
	const path = join(home, "src", "billing");
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
	runner.set("herdr", ["workspace", "list"], {
		code: 1,
		stderr: "error: the daemon is down\n",
	});
	return runner;
}

describe("the desktop notification's per-platform send", () => {
	test("Linux: notify-send with the app name, the fixed title, and the full text", () => {
		const { service, runner } = makeService("linux");
		const text = "the handoff of #42 failed: the daemon is down";
		service.notify({ severity: "warning", text });
		void flush();
		const calls = (runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("notify-send");
		expect(calls[0].args).toEqual([
			"--app-name",
			DESKTOP_NOTIFICATION_APP_NAME,
			"-u",
			"normal",
			"Factory: warning",
			text,
		]);
	});

	test("Linux: an error sends a critical urgency under the error title", () => {
		const { service, runner } = makeService("linux");
		const text = "the daemon is down";
		service.notify({ severity: "error", text });
		void flush();
		const calls = (runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("notify-send");
		expect(calls[0].args).toEqual([
			"--app-name",
			DESKTOP_NOTIFICATION_APP_NAME,
			"-u",
			"critical",
			"Factory: error",
			text,
		]);
	});

	test("macOS: the built-in osascript notification, the full text as the body", () => {
		const { service, runner } = makeService("darwin");
		const text = "the handoff of #42 failed: the daemon is down";
		service.notify({ severity: "warning", text });
		void flush();
		const calls = (runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("osascript");
		expect(calls[0].args).toEqual([
			"-e",
			`display notification "${text}" with title "Factory: warning"`,
		]);
	});

	test("macOS: a quote in the fact's text is the AppleScript escape, still one argv element", () => {
		const { service, runner } = makeService("darwin");
		service.notify({ severity: "error", text: `it said "no" and stopped` });
		void flush();
		const calls = (runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual([
			"-e",
			`display notification "it said ""no"" and stopped" with title "Factory: error"`,
		]);
	});

	test("Windows: the static balloon tip with the severity's icon and timeout", () => {
		// The warning announces and clears on its own, the few seconds the
		// plane allows a warning to hold the desktop.
		const warning = makeService("win32");
		warning.service.notify({ severity: "warning", text: "the merge of #7 is blocked" });
		void flush();
		let calls = (warning.runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("powershell");
		expect(calls[0].args).toEqual([
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-Command",
			`$w = New-Object -ComObject WScript.Shell; ` +
				`[void]$w.Popup('the merge of #7 is blocked', 5, 'Factory: warning', 2)`,
		]);

		// The error stands: timeout 0, the sticky window that waits for the
		// operator's own close.
		const error = makeService("win32");
		error.service.notify({ severity: "error", text: "the agent is missing" });
		void flush();
		calls = (error.runner as FakeRunner).calls;
		expect(calls).toHaveLength(1);
		expect(calls[0].args.at(-1)).toBe(
			`$w = New-Object -ComObject WScript.Shell; ` +
				`[void]$w.Popup('the agent is missing', 0, 'Factory: error', 1)`,
		);
	});

	test("Windows: an apostrophe in the fact's text is the PowerShell escape", () => {
		const { service, runner } = makeService("win32");
		service.notify({ severity: "warning", text: "the Agent's pane is gone" });
		void flush();
		const calls = (runner as FakeRunner).calls;
		expect(calls[0].args.at(-1)).toContain("the Agent''s pane is gone");
	});
});

describe("the standing-fact rule", () => {
	test("the identical fact standing sends nothing, and a different fact resets it", async () => {
		const { service, runner } = makeService("linux");
		const fact = { severity: "warning" as const, text: "observation cycle failed" };

		service.notify(fact);
		await flush();
		service.notify(fact);
		await flush();
		service.notify(fact);
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(1);

		// A different fact takes the line: it sends, and it resets the memory.
		service.notify({ severity: "warning", text: "a different fact" });
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(2);

		// The first fact stands again: it notifies again.
		service.notify(fact);
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(3);
		const last = notificationCalls(runner as FakeRunner).at(-1);
		expect(last?.args.join(" ")).toContain("observation cycle failed");
	});

	test("the same text under a different severity is a different fact", async () => {
		const { service, runner } = makeService("linux");
		service.notify({ severity: "warning", text: "the merge is blocked" });
		await flush();
		service.notify({ severity: "error", text: "the merge is blocked" });
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(2);
	});

	test("the rule is the second guard: a fact that repeats per cycle sends once", async () => {
		const { service, runner } = makeService("linux");
		for (let cycle = 0; cycle < 10; cycle += 1) {
			service.notify({ severity: "warning", text: "the failing observation cycle" });
			await flush();
		}
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(1);
	});
});

describe("the desktop-notification config gate", () => {
	test("a config-off run sends nothing, and the memory does not prime", async () => {
		const { service, runner, config } = makeService("linux");
		config.desktopNotification = false;
		service.notify({ severity: "warning", text: "a fact" });
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(0);

		// The gate flips and the same fact stands: it sends, unprimed.
		config.desktopNotification = true;
		service.notify({ severity: "warning", text: "a fact" });
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(1);
	});

	test("the default config sends", async () => {
		const { service, runner } = makeService("linux");
		expect(BASE_CONFIG.desktopNotification).toBe(true);
		service.notify({ severity: "error", text: "a fact" });
		await flush();
		expect(notificationCalls(runner as FakeRunner)).toHaveLength(1);
	});
});

describe("the failed send", () => {
	test("a nonzero exit leaves a developer log line and changes nothing else", async () => {
		const runner = new FakeRunner();
		runner.set(
			"notify-send",
			["--app-name", DESKTOP_NOTIFICATION_APP_NAME, "-u", "normal", "Factory: warning", "a fact"],
			{ code: 1, stderr: "Error: no display\n" },
		);
		const { service, log } = makeService("linux", { runner });
		service.notify({ severity: "warning", text: "a fact" });
		await flush();
		expect(log.warn).toHaveLength(1);
		expect(log.warn[0]).toContain("desktop notification not sent");
		expect(log.warn[0]).toContain("no display");

		// The standing-fact rule does not retry a send it already made: the
		// broken stack does not flood, and the plane's work is untouched.
		service.notify({ severity: "warning", text: "a fact" });
		await flush();
		expect(notificationCalls(runner)).toHaveLength(1);
		expect(log.warn).toHaveLength(1);
	});

	test("a spawn error is caught the same way", async () => {
		const failing: CommandRunner = {
			run: (
				_command: string,
				_args: readonly string[],
				_options?: CommandOptions,
			): Promise<CommandResult> => Promise.reject(new Error("spawn ENOENT")),
			listModels: () => Promise.resolve({ ok: false, reason: "no model list" }),
		};
		const { service, log } = makeService("linux", { runner: failing });
		service.notify({ severity: "error", text: "a fact" });
		await flush();
		expect(log.warn).toHaveLength(1);
		expect(log.warn[0]).toContain("desktop notification not sent");
	});
});

describe("the terminal bell's ring", () => {
	test("rings through the service, gated by attention-bell read at the ring", () => {
		const { service, config } = makeService("linux");
		const writes: string[] = [];
		const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: Uint8Array | string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
		try {
			config.attentionBell = true;
			service.ring();
			expect(writes).toEqual(["\u0007"]);
			config.attentionBell = false;
			service.ring();
			expect(writes).toEqual(["\u0007"]);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("the Message line's fact to the desktop", () => {
	test("the refresh's own facts send no notification", async () => {
		// The only fact the manual refresh writes is its Working line, and the
		// result of a clean refresh stands on the line as nothing at all:
		// neither is a standing warning or error fact, so the desktop stays
		// quiet.
		const state = openFactoryState(join(home, "state.sqlite"));
		const empty = {
			status: "success" as const,
			fetchedAt: "2026-10-01T10:00:00.000Z",
			tickets: [],
		};
		const source = new FakeSource("tickets", "test", empty);
		const runner = new FakeRunner();
		// The observation loop's own read stays hermetic: a readable agent
		// list, so its only fact is the one with no state change at all.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		try {
			await withApp(
				async (setup) => {
					// The boot's own refresh runs first; settle it, so the manual
					// refresh the key starts is the one the test drives.
					const deadline = Date.now() + 4000;
					while (source.calls < 1) {
						if (Date.now() >= deadline) throw new Error("timed out: the initial refresh to start");
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
					source.settle(empty);
					// The `r` control writes the refresh's Working line...
					await press(setup, "r", "the refresh's working line", (f) =>
						f.includes("refreshing 1 sources"),
					);
					expect(notificationCalls(runner)).toHaveLength(0);
					// ...and the clean result leaves no standing fact at all.
					source.settle(empty);
					await awaitFrame(setup, (f) => !f.includes("refreshing"), "the working line to clear");
					expect(notificationCalls(runner)).toHaveLength(0);
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a warning fact sends one notification, the identical standing fact none", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				const calls = notificationCalls(runner);
				expect(calls).toHaveLength(1);
				expect(calls[0].args.join(" ")).toContain("Factory: warning");
				expect(calls[0].args.join(" ")).toContain("no Ticket sources exist");
				// The same fact stands again: no second send.
				setup.mockInput.pressKey("r");
				await settle(setup);
				expect(notificationCalls(runner)).toHaveLength(1);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("an error fact sends, a different fact resets the rule, and the warning stands again", async () => {
		const runner = failingHandoffRunner();
		await withApp(
			async (setup) => {
				// The warning stands, and it notifies once.
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(notificationCalls(runner)).toHaveLength(1);
				// The failing handoff's error takes the line: a different fact,
				// and it notifies.
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).includes("the daemon is down"),
				);
				const afterError = notificationCalls(runner);
				expect(afterError.length).toBeGreaterThan(1);
				expect(afterError.at(-1)?.args.join(" ")).toContain("Factory: error");
				expect(afterError.at(-1)?.args.join(" ")).toContain("the daemon is down");
				// The warning fact stands again after a different one: it notifies again.
				setup.mockInput.pressKey("r");
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).includes("no Ticket sources exist"),
					"the warning to stand again",
				);
				const afterWarning = notificationCalls(runner);
				expect(afterWarning.length).toBe(afterError.length + 1);
				expect(afterWarning.at(-1)?.args.join(" ")).toContain("Factory: warning");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the notification carries the full text the line truncates", async () => {
		const line = `error: the daemon refused the request after the outage. ${"x".repeat(240)}`;
		const runner = new FakeRunner();
		const path = join(home, "src", "billing");
		runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/billing.git\n",
		});
		runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${line}\n` });
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error", (f) => messageRowOf(f).startsWith("Error: "));
				const frame = await settle(setup);
				// The line cuts at the terminal edge...
				expect(messageRowOf(frame).length).toBeLessThanOrEqual(WIDTH);
				// ...and the notification carries the whole fact.
				const calls = notificationCalls(runner);
				const sent = calls.find((call) => call.args.join(" ").includes("the daemon refused"));
				expect(sent?.args.join(" ")).toContain(line);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("a config-off run writes the fact and spawns no notification", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(messageRowOf(await settle(setup)).trim()).toBe("Warning: no Ticket sources exist");
				expect(notificationCalls(runner)).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			{
				config: { ...BASE_CONFIG, desktopNotification: false },
				runner,
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});
});
