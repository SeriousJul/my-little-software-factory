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

import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { AttentionService, DESKTOP_NOTIFICATION_APP_NAME } from "../src/attention.ts";
import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/runner.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import { awaitFrame, HEIGHT, messageRowOf, press, settle, waitSourceHealthy, WIDTH, withApp } from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner, type RecordedCommand } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { plane, ticketOf } from "./seeded-plane.ts";
import { success } from "./state-fixture.ts";

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

/**
 * The Failed-start park's fixtures (issue #298): one open Ticket whose two newest
 * Handoff attempts settled `failed`, and the source read that releases the Attempt
 * hold so the ask the park holds is the one that runs.
 */
const PARK_IDENTITY = "github:github.com:I_5";
const parkTicket: FetchedTicket = {
	identity: PARK_IDENTITY,
	sourceKind: "github-issue",
	externalKey: "#5",
	sourceState: "open",
	url: "https://github.com/acme/factory/issues/5",
	title: "Persist source facts",
	description: "Keep state independent from GitHub.",
	labels: ["ready-for-agent"],
	externalUpdatedAt: "2026-08-31T10:00:00Z",
	repository: {
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
	},
	attributes: {},
};
/** The read that lands the Ticket row, before the app mounts. */
const parkFetch: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [parkTicket],
};
/** The re-read after the failed starts: the Attempt hold's release. */
const parkRefresh: FetchOutcome = {
	status: "success",
	fetchedAt: new Date(Date.now() + 60_000).toISOString(),
	tickets: [parkTicket],
};
const parkChoice = {
	agentType: "pi",
	environment: "live-worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

/** The failing-handoff stubs: the handoff dies on its workspace list. */
function failingHandoffCommands(fake: FakeRunner, home: string): void {
	const path = join(home, "src", "billing");
	fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
	fake.set("herdr", ["workspace", "list"], {
		code: 1,
		stderr: "error: the daemon is down\n",
	});
}

/**
 * The one open Ticket the handoff-key tests stand the plane on: the first sample
 * row, under its own source with its repository mapped.
 */
const singleTicket: FetchedTicket = {
	identity: "github:github.com:I_1",
	sourceKind: "github-issue",
	externalKey: "#1",
	sourceState: "open",
	url: "https://github.com/acme/billing/issues/1",
	title: "Retry policy for webhooks",
	description:
		"Webhooks dropped during the outage were never redelivered. Add an exponential-backoff retry policy to the dispatcher, with a dead-letter queue for payloads that exhaust their retries.",
	labels: ["ready-for-agent"],
	externalUpdatedAt: "2026-08-31T10:00:00Z",
	repository: {
		identity: "github.com/acme/billing",
		displayName: "acme/billing",
		cloneUrl: "https://github.com/acme/billing.git",
	},
	attributes: {},
};
const singleTicketConfig: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing"],
	host: "github.com",
};

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
		const empty = {
			status: "success" as const,
			fetchedAt: "2026-10-01T10:00:00.000Z",
			tickets: [],
		};
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{
				config: {
					name: "tickets",
					kind: "github-issues",
					refreshIntervalSeconds: 60,
					repositories: [],
					host: "github.com",
				},
				tickets: [],
			}],
		});
		const source = planeRecord.sources[0] as FakeSource;
		const runner = planeRecord.fakeRunner;
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
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("a handoff fault sends its two facts, the error and the queued start", async () => {
		// The fault split (ADR 0118): the machine operation that failed is the
		// error fact, and the queued start that never ran is the warning fact;
		// each is a fact the plane met on its own, so each leaves the terminal.
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{ config: singleTicketConfig, tickets: [ticketOf(singleTicket)] }],
			repos: { "github.com/acme/billing": "src/billing" },
			commands: failingHandoffCommands,
		});
		const source = planeRecord.sources[0] as FakeSource;
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				source.settle(success([singleTicket]));
				await waitSourceHealthy(planeRecord.state);
				await press(setup, "return", "the fault", (f) =>
					messageRowOf(f).includes("the daemon is down"),
				);
				const calls = notificationCalls(runner);
				expect(calls).toHaveLength(2);
				expect(calls[0].args.join(" ")).toContain("Factory: error");
				expect(calls[0].args.join(" ")).toContain("the daemon is down");
				expect(calls[1].args.join(" ")).toContain("Factory: warning");
				expect(calls[1].args.join(" ")).toContain("was not run");
				expect(calls[1].args.join(" ")).toContain("the daemon is down");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("a line-only warning fact sends nothing and wakes no rule", async () => {
		// The fault split (ADR 0118): the answer to a key writes its line only.
		// It neither sends nor touches the standing-fact rule: the fault that
		// takes the line sends once, and the refusal that stands again sends
		// nothing. The refusal this plane meets is the refresh already in
		// flight: the boot's own read, held by the fake until the test settles
		// it.
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{ config: singleTicketConfig, tickets: [ticketOf(singleTicket)] }],
			repos: { "github.com/acme/billing": "src/billing" },
			commands: failingHandoffCommands,
		});
		const source = planeRecord.sources[0] as FakeSource;
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				// The refusal the key meets: line only, no send.
				await press(setup, "r", "the refusal", (f) =>
					messageRowOf(f).includes("every Ticket source is already refreshing"),
				);
				expect(notificationCalls(runner)).toHaveLength(0);
				// The failing handoff's fault takes the line: a different fact,
				// and it sends.
				source.settle(success([singleTicket]));
				await waitSourceHealthy(planeRecord.state);
				await press(setup, "return", "the fault", (f) =>
					messageRowOf(f).includes("the daemon is down"),
				);
				const afterError = notificationCalls(runner);
				expect(afterError.length).toBe(2);
				expect(afterError[0].args.join(" ")).toContain("Factory: error");
				expect(afterError.at(-1)?.args.join(" ")).toContain("Factory: warning");
				expect(afterError.at(-1)?.args.join(" ")).toContain("the daemon is down");
				// The refusal stands again after a different fact: still line only.
				// It is written under the working line its own refresh opens, and
				// the settle is what lifts the working line to reveal it.
				setup.mockInput.pressKey("r");
				await awaitFrame(setup, (f) => f.includes("refreshing"), "the refresh to start");
				setup.mockInput.pressKey("r");
				source.settle(success([singleTicket]));
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).includes("every Ticket source is already refreshing"),
					"the refusal to stand again",
				);
				expect(notificationCalls(runner)).toHaveLength(2);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the notification carries the full text the line truncates", async () => {
		const line = `error: the daemon refused the request after the outage. ${"x".repeat(240)}`;
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{ config: singleTicketConfig, tickets: [ticketOf(singleTicket)] }],
			repos: { "github.com/acme/billing": "src/billing" },
			commands: (fake, home) => {
				const path = join(home, "src", "billing");
				fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
				fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
					stdout: "https://github.com/acme/billing.git\n",
				});
				fake.set("herdr", ["workspace", "list"], { code: 1, stderr: `${line}\n` });
			},
		});
		const source = planeRecord.sources[0] as FakeSource;
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				source.settle(success([singleTicket]));
				await waitSourceHealthy(planeRecord.state);
				// The fault stands on the queued start's warning, which carries the
				// command's own reason after its prefix.
				await press(setup, "return", "the error", (f) =>
					messageRowOf(f).includes("the daemon refused"),
				);
				const frame = await settle(setup);
				// The line cuts at the terminal edge...
				expect(messageRowOf(frame).length).toBeLessThanOrEqual(WIDTH);
				// ...and the error notification carries the whole fact.
				const calls = notificationCalls(runner);
				const sent = calls.find((call) =>
					call.args.join(" ").includes("Factory: error") &&
					call.args.join(" ").includes("the daemon refused"),
				);
				expect(sent?.args.join(" ")).toContain(line);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("a config-off run writes the fact and spawns no notification", async () => {
		const planeRecord = await plane({
			groupingAxis: "none",
			config: { desktopNotification: false },
			sources: [],
		});
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				await press(setup, "r", "the warning", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(messageRowOf(await settle(setup)).trim()).toBe("Warning: no Ticket sources exist");
				expect(notificationCalls(runner)).toHaveLength(0);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the pre-flight's refusal reaches the desktop in the words the line shows", async () => {
		// Issue #204, story 4. The drift the issue measured was one bad choice
		// answering two ways, so the fact read away from the terminal was not the
		// fact read at the key. One pre-flight writes the reason; this test carries
		// that same reason from the Message line to the notification command.
		const planeRecord = await plane({
			groupingAxis: "none",
			config: { defaultAgent: "nope" },
			sources: [{ config: singleTicketConfig, tickets: [ticketOf(singleTicket)] }],
			repos: { "github.com/acme/billing": "src/billing" },
		});
		const source = planeRecord.sources[0] as FakeSource;
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				source.settle(success([singleTicket]));
				await waitSourceHealthy(planeRecord.state);
				await press(setup, "return", "the refusal", (f) =>
					messageRowOf(f).includes("unknown agent type: nope"),
				);
				const frame = await settle(setup);
				expect(messageRowOf(frame)).toContain("unknown agent type: nope");
				// The refusal stands on two facts: the claim's own error, and the
				// queued start that never ran, each carrying the reason.
				const calls = notificationCalls(runner);
				expect(calls).toHaveLength(2);
				expect(calls[0].args.join(" ")).toContain("Factory: error");
				expect(calls[0].args.join(" ")).toContain("unknown agent type: nope");
				expect(calls[1].args.join(" ")).toContain("Factory: warning");
				expect(calls[1].args.join(" ")).toContain("unknown agent type: nope");
				// A bad choice dies before the start starts an Agent: the handoff
				// ran no herdr step at all.
				expect(runner.calls.filter((call) => call.command === "herdr")).toHaveLength(0);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the Failed-start park's warning reaches the desktop in the words the line shows", async () => {
		// Issue #298, ADR 0106. The park holds the Top-up's automatic adds and states
		// itself as a standing warning, and the desktop is how the operator learns the
		// loop stopped without reading the terminal. The composition is what this pins:
		// the cycle's warning fact, the Message line's warning slot, and the send that
		// slot makes, with the park's own line - the run's count included - carried end
		// to end through the real app and the real observation loop.
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [{
				config: {
					name: "issues",
					kind: "github-issues",
					refreshIntervalSeconds: 60,
					repositories: ["acme/factory"],
					host: "github.com",
				},
				tickets: [ticketOf(parkTicket)],
			}],
			config: { maxHandoffsPerTicket: 4, agentPollIntervalSeconds: 60 },
		});
		// Two starts that reached no Agent at a Handoff limit of 4: the park's count,
		// and still one start short of the cap that ends the work cycle.
		for (let i = 0; i < 2; i += 1) {
			const claim = planeRecord.state.handoff.claimHandoff(PARK_IDENTITY, parkChoice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			planeRecord.state.handoff.settleHandoff(
				claim.claim.attemptId,
				false,
				"Preparing worktree: the worktree path already exists",
			);
		}
		// The mode is factory state (ADR 0036), and the park stands on the walk only
		// the mode runs.
		planeRecord.state.handoff.setAutoHandoffMode(true);

		const runner = planeRecord.fakeRunner;
		// The source re-reads the Ticket after its failed starts, so the Attempt hold
		// is released and the ask the park holds is the one that runs.
		const src = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				src.settle(parkRefresh);
				await waitSourceHealthy(planeRecord.state);
				await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("handoff failure park:"),
						"the park's standing warning",
					);
				await flush();
				const calls = notificationCalls(runner);
				expect(calls.at(-1)?.args.join(" ")).toContain("Factory: warning");
				expect(calls.at(-1)?.args.join(" ")).toContain(
					'handoff failure park: "Persist source facts" (2 Handoff starts in a row never reached an Agent)',
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 60_000 },
			},
		);
	});
});
