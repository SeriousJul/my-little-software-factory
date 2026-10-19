import { describe, expect, test } from "bun:test";

import {
	createHerdrIdentityReporter,
	HERDR_IDENTITY_AGENT,
	HERDR_IDENTITY_SOURCE,
	HERDR_IDENTITY_TIMEOUT_MS,
	herdrIdentityFromEnv,
} from "../src/herdr-identity.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";

/**
 * The runner the reporter's reports go through: it records every command as
 * one space-joined line and answers with one canned result.
 */
class FakeIdentityRunner implements CommandRunner {
	commands: string[] = [];
	timeouts: Array<number | undefined> = [];
	result: CommandResult = { code: 0, stdout: "", stderr: "" };

	run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
		this.commands.push([command, ...args].join(" "));
		this.timeouts.push(options?.timeoutMs);
		return Promise.resolve(this.result);
	}

	listModels(kind: string): Promise<ModelListResult> {
		return Promise.resolve({ ok: false, reason: `the fake holds no model list for ${kind}` });
	}
}

/** One turn of the microtask queue, so a fire-and-forget report settles. */
async function settle(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

describe("the pane the plane reports from", () => {
	test("the variables herdr sets on a pane's processes name the target", () => {
		const target = herdrIdentityFromEnv({
			HERDR_ENV: "1",
			HERDR_BIN_PATH: "/usr/bin/herdr",
			HERDR_PANE_ID: "w1B6:p2",
		});
		expect(target).toEqual({ binPath: "/usr/bin/herdr", paneId: "w1B6:p2" });
	});

	test("outside herdr the plane reports nothing", () => {
		expect(herdrIdentityFromEnv({})).toBeNull();
		expect(herdrIdentityFromEnv({ HERDR_ENV: "0" })).toBeNull();
	});

	test("a partial pane environment stands inert", () => {
		expect(herdrIdentityFromEnv({ HERDR_ENV: "1" })).toBeNull();
		expect(herdrIdentityFromEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "/usr/bin/herdr" })).toBeNull();
		expect(herdrIdentityFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1B6:p2" })).toBeNull();
		expect(herdrIdentityFromEnv({ HERDR_ENV: "1", HERDR_BIN_PATH: "" })).toBeNull();
		expect(herdrIdentityFromEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "" })).toBeNull();
	});
});

describe("the reporter the plane runs in its own pane", () => {
	test("outside herdr the reporter stands inert", () => {
		const runner = new FakeIdentityRunner();
		const reporter = createHerdrIdentityReporter({
			env: {},
			runner,
			now: () => 1_000,
			log: () => {},
		});
		reporter.release();
		expect(runner.commands).toEqual([]);
	});

	test("the creation is the report, before the plane's first frame", () => {
		const runner = new FakeIdentityRunner();
		createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "/usr/bin/herdr", HERDR_PANE_ID: "w1B6:p2" },
			runner,
			now: () => 2_000,
			log: () => {},
		});
		expect(runner.commands).toEqual([
			"/usr/bin/herdr pane report-agent w1B6:p2 --source factory --agent factory --state idle --seq 2000",
		]);
	});

	test("the report's source uses no herdr prefix and stands as one name beside the agent", () => {
		expect(HERDR_IDENTITY_SOURCE).not.toStartWith("herdr:");
		expect(HERDR_IDENTITY_SOURCE).toBe(HERDR_IDENTITY_AGENT);
	});

	test("the report asks the runner for its short budget, not the handoff's ten minutes", () => {
		const runner = new FakeIdentityRunner();
		createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner,
			now: () => 1,
			log: () => {},
		});
		expect(runner.timeouts).toEqual([HERDR_IDENTITY_TIMEOUT_MS]);

		const custom = new FakeIdentityRunner();
		createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner: custom,
			now: () => 1,
			log: () => {},
			timeoutMs: 123,
		});
		expect(custom.timeouts).toEqual([123]);
	});

	test("release gives the pane back under the same name the report claimed", () => {
		const runner = new FakeIdentityRunner();
		const reporter = createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "/usr/bin/herdr", HERDR_PANE_ID: "w1B6:p2" },
			runner,
			now: () => 3_000,
			log: () => {},
		});
		reporter.release();
		expect(runner.commands).toEqual([
			"/usr/bin/herdr pane report-agent w1B6:p2 --source factory --agent factory --state idle --seq 3000",
			"/usr/bin/herdr pane release-agent w1B6:p2 --source factory --agent factory --seq 3000",
		]);
	});

	test("the report sequence reads the clock", () => {
		const runner = new FakeIdentityRunner();
		createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner,
			now: () => 42,
			log: () => {},
		});
		expect(runner.commands).toEqual([
			"herdr pane report-agent p1 --source factory --agent factory --state idle --seq 42",
		]);
	});

	test("the release carries the sequence the clock reads at the release, ahead of the boot's", () => {
		const runner = new FakeIdentityRunner();
		let now = 1_000;
		const reporter = createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner,
			now: () => now,
			log: () => {},
		});
		now = 2_000;
		reporter.release();
		expect(runner.commands[0]).toBe(
			"herdr pane report-agent p1 --source factory --agent factory --state idle --seq 1000",
		);
		expect(runner.commands[1]).toBe(
			"herdr pane release-agent p1 --source factory --agent factory --seq 2000",
		);
	});

	test("a refused report is a line, not a failure of the run", async () => {
		const runner = new FakeIdentityRunner();
		runner.result = { code: 127, stdout: "", stderr: "herdr not found in PATH" };
		const lines: string[] = [];
		const reporter = createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner,
			now: () => 1,
			log: (line) => {
				lines.push(line);
			},
		});
		await settle();
		reporter.release();
		await settle();
		expect(lines).toEqual([
			"herdr identity: herdr not found in PATH",
			"herdr identity: herdr not found in PATH",
		]);
	});

	test("an answered report logs nothing", async () => {
		const runner = new FakeIdentityRunner();
		const lines: string[] = [];
		createHerdrIdentityReporter({
			env: { HERDR_ENV: "1", HERDR_BIN_PATH: "herdr", HERDR_PANE_ID: "p1" },
			runner,
			now: () => 1,
			log: (line) => {
				lines.push(line);
			},
		});
		await settle();
		expect(lines).toEqual([]);
	});
});
