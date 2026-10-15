/**
 * The permanent Message line and the Message view behind it.
 *
 * The line sits between the panes and the Action bar in every frame, and the
 * frame never shifts for or against it. Facts stay separate behind it: an
 * operation error, a working, an operation warning, and the source-health
 * warning, in that priority. Messages truncate to the terminal width, and the
 * record behind them earns the m Message hint as soon as it holds a fact
 * (ADR 0119): the view is a near-fullscreen record of the run's facts, oldest
 * first, pinned to the newest, each entry wearing its datetime and its
 * severity chip. Progress lines never enter the record.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { padToWidth, truncateToWidth, widthOf } from "../src/components/text.ts";
import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { EnvironmentKind, FetchedTicket, Ticket } from "../src/domain/ticket.ts";
import type { CommandRunner } from "../src/runner.ts";
import {
	actionBarRowOf,
	fieldKey,
	frameText,
	frameUntil,
	guideKey,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	pageKey,
	pressControl,
	rgb,
	roleColor,
	rowsOf,
	spanColorAt,
	tabUntilSlot,
	toggleAutoHandoff,
	typeText,
	WIDTH,
	waitFor,
	waitSourceHealthy,
	withApp,
} from "./app-harness.ts";
import { DelayedRunner } from "./delayed-runner.ts";
import {
	fetchRateLimited,
	fetchSuccess,
	issueTicket,
	SAMPLE_TICKETS,
	ticketOf,
} from "./fact-fixtures.ts";
import {
	agentListJson,
	FakeRunner,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import {
	callsReached,
	issuesSourceConfig,
	type Plane,
	plane,
	seedAwaitingTurn,
	wrappedState,
} from "./plane.ts";

/** Stub the git answers for a checkout directory of one repository. */
function stubCheckoutInto(runner: FakeRunner, path: string, repository: string): void {
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repository}.git\n`,
	});
}

/** The failing-handoff stubs: the handoff dies on its workspace list. */
function failingHandoffCommands(fake: FakeRunner, home: string): void {
	const path = join(home, "src", "billing");
	stubCheckoutInto(fake, path, "github.com/acme/billing");
	fake.set("herdr", ["workspace", "list"], {
		code: 1,
		stderr: "error: the daemon is down\n",
	});
}

/** The one open billing Ticket the handoff-fault tests stand the plane on. */
const faultTicket: FetchedTicket = {
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

const faultSourceConfig: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing"],
	host: "github.com",
};

/**
 * The plane the handoff-fault tests stand on: the one open billing Ticket,
 * its repository mapped under the home, and the start's commands named by the
 * case. The start's fault is the plane's own fact (ADR 0118's split): the
 * error the machine operation left, and the queued start's warning the line
 * stands on.
 */
async function faultPlane(
	options: {
		runner?: (fake: FakeRunner) => CommandRunner;
		config?: Partial<FactoryConfig>;
		commands?: (fake: FakeRunner, home: string) => void;
	} = {},
): Promise<Plane> {
	return plane({
		groupingAxis: "none",
		sources: [{ config: faultSourceConfig, tickets: [ticketOf(faultTicket)] }],
		repos: { "github.com/acme/billing": "src/billing" },
		commands: options.commands ?? failingHandoffCommands,
		...(options.runner === undefined ? {} : { runner: options.runner }),
		...(options.config === undefined ? {} : { config: options.config }),
	});
}

/** The resting row of an in-flight handoff: settled with its herdr handles. */
function inFlightRow(fetched: FetchedTicket, environment: EnvironmentKind): Ticket {
	return ticketOf(fetched, {
		state: "handed-off",
		handoff: {
			agentType: "pi",
			environment,
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
			attemptId: "seeded",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			herdrName: null,
			startedAt: "2026-01-01T00:00:00Z",
		},
		handoffCount: 1,
	});
}

/** The close cleanup the in-flight row's close runs against, by failure. */
function closeCleanupCommands(fake: FakeRunner, stderr: string): void {
	fake.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], { code: 1, stderr });
}

/** The notification commands the runner recorded, whatever the platform. */
function notificationCalls(runner: FakeRunner): string[] {
	return runner.calls
		.filter(
			(call) =>
				call.command === "notify-send" ||
				call.command === "osascript" ||
				call.command === "powershell",
		)
		.map((call) => call.args.join(" "));
}

/** The history entries one chip wears in a Message view frame. */
function historyEntries(view: string, chip: "INFO" | "WARN" | "ERROR"): number {
	const face = new RegExp(`\\d{2}:\\d{2}:\\d{2} ${chip} `);
	return view.split("\n").filter((row) => face.test(row)).length;
}

/** The nineteen-cell datetime a history row leads with, in the row it wears. */
function historyTimeOf(row: string): string {
	const match = row.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	return match === null ? "" : match[0];
}

/** A handoff that fails on a deliberately long stderr line. */
const LONG_LINE = `error: the daemon refused the request after the outage. ${"x".repeat(240)}`;

function longLineHandoff(runner: FakeRunner, path: string, repository: string): void {
	stubCheckoutInto(runner, path, repository);
	runner.set("herdr", ["workspace", "list"], { code: 1, stderr: `${LONG_LINE}\n` });
}

/** The long-line fault as the plane's standing commands. */
function longLineCommands(fake: FakeRunner, home: string): void {
	longLineHandoff(fake, join(home, "src", "billing"), "github.com/acme/billing");
}

/** The drop line a failed start stands on, with its reason. */
const faultLine = (title: string, reason: string): string =>
	`Warning: queued handoff for "${title}" was not run: ${reason}`;

const WORKING_TICKET = {
	...SAMPLE_TICKETS[0],
	identity: "local:1",
	title: `Drop the legacy auth shim after the ${"m".repeat(140)} migration`,
};

/** The issues source config the stateful tests' standings carry. */
const issueSource = issuesSourceConfig;

describe("the permanent Message line", () => {
	test("never shifts the layout for or against it", async () => {
		const fake = new FakeRunner();
		const planeRecord = await plane({ runner: () => fake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				const before = await waitFor(setup, { quiet: true });
				expect(actionBarRowOf(before)).not.toContain("m Message");
				// An unavailable refresh explains itself on the line.
				await pressControl(setup, "refresh", { quiet: true });
				const frame = await waitFor(setup, { quiet: true });
				// The fact is recorded, so the Message hint lands on the row the bar
				// always wears: the layout never shifts for or against the line, and
				// the marker never moves for the hint or the fact it names.
				expect(markerRowOf(frame)).toBe(markerRowOf(before));
				expect(actionBarRowOf(frame)).toContain("m Message");
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
				// Changing auto-handoff is not an operation. It must not clear the
				// durable warning that the rejected refresh produced.
				await toggleAutoHandoff(setup, { quiet: true });
				expect(messageRowOf(await waitFor(setup, { quiet: true })).trim()).toBe(
					"Warning: no Ticket sources exist",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("wears the severity prefix, and only the line wears the color", async () => {
		// Warning.
		const fake = new FakeRunner();
		const planeRecord = await plane({ runner: () => fake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				const frame = await pressControl(setup, "refresh", { refuses: true });
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Warning: no Ticket sources exist");
				expect(spanColorAt(setup, row, "Warning:")).toEqual(rgb(roleColor("yellow")));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		// A refused refresh warns on the line. A source app needs state to
		// own the refresh coordinator at all.
		const refusedPlane = await plane({
			existing: wrappedState(),
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		await withApp(
			async (setup) => {
				// While the first fetch runs, a refresh is refused on the line.
				const frame = await pressControl(setup, "refresh", {
					refuses: "every Ticket source is already refreshing",
				});
				expect(messageRowOf(frame).trim()).toBe(
					"Warning: every Ticket source is already refreshing",
				);
				refusedPlane.settleFirstFetch();
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: refusedPlane,
				loopPolicy: { kind: "production" },
			},
		);

		// Working.
		const workingPlane = await plane({
			existing: wrappedState(),
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = workingPlane.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "Add a webhook retry policy" });
				// A manual refresh shows its working, and settles back to clear.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				const frame = await waitFor(setup, { quiet: true });
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe("Working: refreshing 1 sources");
				expect(spanColorAt(setup, row, "Working:")).toEqual(rgb(roleColor("blue")));
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { hides: "refreshing 1 sources" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: workingPlane,
				loopPolicy: { kind: "production" },
			},
		);

		// Error. A failed start stands on its queued drop's warning (ADR 0118's
		// fault split), so the standing Error the line wears is the close
		// cleanup herdr refused: the operator ends a worktree handoff and the
		// cleanup's own command fails.
		const errorPlane = await plane({
			groupingAxis: "none",
			sources: [{ config: issueSource, tickets: [inFlightRow(issueTicket(), "worktree")] }],
			// The clock sits past the startup grace, so the start is old, not a boot.
			now: () => Date.now() - 60_000,
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake) => closeCleanupCommands(fake, "error: the daemon is down\n"),
		});
		const errorSource = errorPlane.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				errorSource.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "missing" });
				await pressControl(setup, "ticket-close", { opens: "Close: Add a webhook retry policy" });
				await pressControl(setup, "confirm-action", { hides: "Close:" });
				const frame = await frameUntil(setup, "the error", (f) =>
					messageRowOf(f).startsWith("Error: "),
				);
				const row = rowsOf(frame).length - 2;
				expect(messageRowOf(frame).trim()).toBe(
					"Error: ticket github:github.com:I_5 closed; the close cleanup failed: error: the daemon is down",
				);
				expect(spanColorAt(setup, row, "Error:")).toEqual(rgb(roleColor("red")));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: errorPlane,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("lets an error cover its own working", async () => {
		// Every command call is delayed, so the start's working stands long
		// enough to read before the failure lands.
		const planeRecord = await faultPlane({
			runner: (fake) => new DelayedRunner(fake, 500, Number.POSITIVE_INFINITY),
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "Working: handing off" });
				// The failure lands after the delay: the error covers the working,
				// and the fault stands on the queued start's warning (ADR 0118's
				// split) beside the error the record holds.
				await waitFor(setup, { refuses: "queued handoff" });
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					faultLine("Retry policy for webhooks", "error: the daemon is down"),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("lets a manual refresh cover a stale source, and the warning return", async () => {
		const planeRecord = await plane({
			existing: wrappedState(),
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "Add a webhook retry policy" });
				// A failed refresh leaves the source stale: the line warns.
				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				source.settle(fetchRateLimited);
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
				// A new refresh covers the warning with its working.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 3);
				source.settle(fetchRateLimited);
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	/**
	 * The source warnings' channel: a refresh that absorbs a peripheral
	 * failure says so once, and the line carries the sentence. ADR 0050
	 * retired the referenced-issue read that first used it; the security
	 * sources still write it, when a repository has the feed's feature off
	 * (the reason the live case below carries).
	 */
	test("surfaces a source refresh's absorbed failure as one warning on the line", async () => {
		const planeRecord = await plane({
			existing: wrappedState(),
			sources: [
				{
					config: {
						name: "pulls",
						kind: "github-pull-requests",
						refreshIntervalSeconds: 60,
						repositories: ["acme/factory"],
						host: "github.com",
					},
					tickets: [ticketOf(issueTicket())],
				},
			],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// The first refresh settles cleanly.
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "Add a webhook retry policy" });
				// The next refresh absorbs one feed's failure: the source still
				// succeeds, and its one warning line surfaces on the line.
				await pressControl(setup, "refresh", { quiet: true });
				await callsReached(source, 2);
				const disabled = "Dependabot alerts are disabled for acme/factory";
				source.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [issueTicket()],
					warnings: [disabled],
				});
				const frame = await waitFor(setup, { refuses: "Dependabot alerts are disabled for" });
				expect(messageRowOf(frame).trim()).toBe(`Warning: ${disabled}`);
				source.settle(fetchSuccess([issueTicket()]));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	test("runs the facts in priority order, and covered warnings return", async () => {
		// Delay every command call: the handoff must stay in flight long
		// enough for its Working line to be read.
		const planeRecord = await faultPlane({
			runner: (fake) => new DelayedRunner(fake, 1200, Number.POSITIVE_INFINITY),
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				// The in-flight handoff's working.
				await pressControl(setup, "handoff", { shows: "Working: handing off" });
				// Its pickup fails: the item drops with the warning that names
				// the operation and the reason (ADR 0049), covering the working.
				await waitFor(setup, { refuses: "queued handoff" });
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					faultLine("Retry policy for webhooks", "error: the daemon is down"),
				);
				// A new operation replaces the error with its own working.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 2);
				source.settle(fetchRateLimited);
				// The refresh working cleared: the stale source's warning returns.
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
				// A second refresh: its working covers the stale health.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				// A refused refresh while that one runs: the refusal is an
				// operation Warning, and active progress outranks it
				// (user story 51), so the Working line stays.
				await pressControl(setup, "refresh", { quiet: true });
				await frameUntil(setup, "the refused refresh", (f) => {
					const row = messageRowOf(f);
					return row.includes("already refreshing") || row.includes("refreshing 1 sources");
				});
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe("Working: refreshing 1 sources");
				await callsReached(source, 3);
				source.settle(fetchRateLimited);
				// The progress clears with the refresh: the refusal returns,
				// and it outranks the source-health warning (story 52).
				await waitFor(setup, { refuses: "every Ticket source is already refreshing" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("leaves an in-flight refresh's progress to the refresh that owns it", async () => {
		const state = wrappedState();
		// The fixture Ticket ends its turn and awaits its decision, with the
		// herdr handles the decision's actions read from stored against it.
		seedAwaitingTurn(state, fetchSuccess([issueTicket()]));
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// The cycle-end draft close reads the branch's open pull requests:
		// the branch carries none, so the close says nothing, and the line
		// keeps the in-flight refresh's progress.
		runner.set(
			"gh",
			[
				"api",
				"--hostname",
				"github.com",
				`repos/acme/factory/pulls?state=open&head=${encodeURIComponent(
					"acme:factory/5-add-a-webhook-retry-policy",
				)}`,
			],
			{ stdout: "[]" },
		);
		const planeRecord = await plane({
			existing: state,
			runner: () => runner,
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// The boot fetch has to land before the test asks for its own.
				await callsReached(source, 1);
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "[awaiting]" });
				await waitFor(setup, { quiet: true });
				// A manual refresh is in flight, and its progress owns the line.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				// Close ends the decision's outcome. It writes no progress line of
				// its own, so it clears nothing another operation still runs.
				await pressControl(setup, "decide-completion", { shows: "Decision:" });
				await pressControl(setup, "confirm-action", { hides: "Decision:" });
				expect(messageRowOf(await waitFor(setup, { quiet: true })).trim()).toBe(
					"Working: refreshing 1 sources",
				);
				// The refresh settles, and only then does its line clear.
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { hides: "refreshing 1 sources" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("truncates to the terminal width, and offers the view once a fact is recorded", async () => {
		// The line is cut at the terminal edge, and the fact earns the hint.
		const planeRecord = await faultPlane({ commands: longLineCommands });
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				const frame = await waitFor(setup, { quiet: true });
				const expected = padToWidth(
					truncateToWidth(faultLine("Retry policy for webhooks", LONG_LINE), WIDTH),
					WIDTH,
				);
				expect(messageRowOf(frame)).toBe(expected);
				expect(actionBarRowOf(frame)).toContain("m Message");
				// The view holds the whole fact the line cut: the entry wraps the
				// text, and it leads with its datetime and its chip.
				const view = await pressControl(setup, "message", { opens: "Message view" });
				expect(view).toContain("the daemon refused the request after the outage");
				expect(view).toContain("ERROR");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		// A fact that fits on the line still earns the view: the record is the
		// point, not the cut.
		const fitFake = new FakeRunner();
		const fitPlane = await plane({ runner: () => fitFake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				await pressControl(setup, "refresh", { quiet: true });
				expect(actionBarRowOf(await waitFor(setup, { quiet: true }))).toContain("m Message");
				const view = await pressControl(setup, "message", { opens: "Message view" });
				expect(view).toContain("WARN");
				expect(view).toContain("no Ticket sources exist");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: fitPlane,
				loopPolicy: { kind: "held" },
			},
		);

		// No fact at all: the control refuses on the line, and the record stays
		// what the record is.
		const emptyFake = new FakeRunner();
		const emptyPlane = await plane({ runner: () => emptyFake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				await guideKey(setup, "message", "m", {
					refuses: "no message has been recorded yet",
				});
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: emptyPlane,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("F2 opens the view from inside a field, and the field keeps its work", async () => {
		const planeRecord = await faultPlane({
			commands: longLineCommands,
			config: {
				consultationTypes: {
					grill: { agent: "claude", environment: "live-worktree", template: "/grill {input}" },
				},
			},
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// A truncated fault on the line: the view has text to hold.
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				// The launcher's Draft field holds the keys, and F2 is the field mode's
				// own alias: the view opens from inside the field, not only from the
				// base panes.
				await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
				await tabUntilSlot(setup, "❯ Initial input");
				await typeText(setup, "draft before the view");
				fieldKey(setup, "home");
				fieldKey(setup, "shift+right");
				fieldKey(setup, "shift+right");
				const view = await pressControl(setup, "message", { via: "F2", opens: "Message view" });
				expect(view).toContain("the daemon refused the request after the outage");
				await pressControl(setup, "message-close", { closes: "Message view" });
				// The field kept the text, the caret, and the selection: asking to read
				// a Message changed nothing about the operator's work.
				typeText(setup, "q");
				await waitFor(setup, { shows: "qaft before the view" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the working is no fact, and the record shows the turn it covered", async () => {
		// The long title keeps the drop line from fitting any row: the cut the
		// line takes is what the record proves against. Every command call is
		// delayed, so the working stands long enough to read and the m press
		// lands while it runs.
		const planeRecord = await plane({
			groupingAxis: "none",
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/billing"],
						host: "github.com",
					},
					tickets: [WORKING_TICKET],
				},
			],
			repos: { "github.com/acme/billing": "src/billing" },
			commands: (fake, home) => {
				stubCheckoutInto(fake, join(home, "src", "billing"), "github.com/acme/billing");
				fake.set("herdr", ["workspace", "list"], {
					code: 1,
					stderr: "error: the daemon is down\n",
				});
			},
			runner: (fake) => new DelayedRunner(fake, 500, Number.POSITIVE_INFINITY),
		});
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				// The working is progress, not a fact: the record holds nothing
				// while it runs, so the refusal to open is the fact the record
				// gains in that window, and it waits behind the working line,
				// where a refusal ranks.
				await guideKey(setup, "message", "m", {
					refuses: "no message has been recorded",
				});
				await pressControl(setup, "handoff", { shows: "Working: handing off" });
				// The fault settles behind the working and takes the line from it.
				await waitFor(setup, { refuses: "queued handoff" });
				// The record holds the refusal, the error, and the drop warning,
				// and no Working line of the handoff: progress was never a fact.
				const view = await pressControl(setup, "message", { opens: "Message view" });
				expect(view).toContain("no message has been recorded yet");
				expect(view).toContain("the daemon is down");
				expect(view).not.toContain("handing off");
				// The record is oldest first: the refusal stands above the error.
				const rows = view.split("\n");
				const refusalRow = rows.findIndex((row) =>
					row.includes("no message has been recorded yet"),
				);
				const errorRow = rows.findIndex((row) => row.includes("the daemon is down"));
				expect(refusalRow).toBeGreaterThan(-1);
				expect(errorRow).toBeGreaterThan(refusalRow);
				// The view's own Message line carries the fault that landed - the
				// drop warning the fault stands on (ADR 0118's split), cut at the
				// long title - the way every surface's line does.
				expect(view).toContain("Warning: queued handoff");
				// And the base frame behind it says the same.
				await pressControl(setup, "message-close", { closes: "Message view" });
				expect(messageRowOf(await waitFor(setup, { quiet: true })).trim()).toContain(
					"Warning: queued handoff",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("states a plain notice, and lets a refusal take the line back", async () => {
		// The settled turn the factory decides: the awaiting Ticket the state
		// holds, the way the state module writes it.
		const state = wrappedState();
		seedAwaitingTurn(state, fetchSuccess([issueTicket()]));
		const planeRecord = await plane({
			existing: state,
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// The mode is factory state, not a config default (ADR 0036): the
				// operator's `a` key is the only way onto it.
				await toggleAutoHandoff(setup, { quiet: true });
				await waitFor(setup, { quiet: true }); // Enter on the settled turn belongs to the factory in auto mode. The
				// fact says so with the plain info the record wears: no operation
				// failed, so the line carries no warning's word.
				await pressControl(setup, "decide-completion", {
					shows: "the factory decides this ticket",
				});
				const notice = await waitFor(setup, { quiet: true });
				expect(messageRowOf(notice).trim()).toBe(
					"Info: auto-handoff is on: the factory decides this ticket",
				);
				expect(messageRowOf(notice)).not.toContain("Working:");
				expect(spanColorAt(setup, rowsOf(notice).length - 2, "Info:")).toEqual(
					rgb(roleColor("text")),
				);
				// The notice is a fact the record holds: the view shows it, beside
				// its chip.
				const view = await pressControl(setup, "message", { opens: "Message view" });
				expect(view).toContain("INFO");
				expect(view).toContain("the factory decides this ticket");
				// The row wears the roles decision 10 names (issue #331): the chip
				// paints the severity the Message line wears, and the datetime the
				// time's own subtext0.
				const rows = rowsOf(view);
				const infoRow = rows.findIndex((row) => row.includes("auto-handoff is on"));
				expect(infoRow).toBeGreaterThan(-1);
				expect(spanColorAt(setup, infoRow, "INFO")).toEqual(rgb(roleColor("text")));
				expect(spanColorAt(setup, infoRow, historyTimeOf(rows[infoRow]))).toEqual(
					rgb(roleColor("subtext0")),
				);
				await pressControl(setup, "message-close", { closes: "Message view" });
				// The notice must not pin the line: the boot read is still in
				// flight, so the refused refresh takes the line back, the way
				// every operation fact outranks a notice.
				const refused = await pressControl(setup, "refresh", {
					refuses: "every Ticket source is already refreshing",
				});
				expect(refused).not.toContain("auto-handoff is on");
				source.settle(fetchSuccess([issueTicket()]));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("wraps, scrolls with a range, and closes on Esc and F2", async () => {
		const line = `error: the daemon refused the request after the outage. ${"x".repeat(2000)}`;
		const planeRecord = await faultPlane({
			commands: (fake, home) => {
				stubCheckoutInto(fake, join(home, "src", "billing"), "github.com/acme/billing");
				fake.set("herdr", ["workspace", "list"], { code: 1, stderr: `${line}\n` });
			},
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				const frame = await pressControl(setup, "message", { opens: "Message view" });
				// The entry wraps to more rows than the pane shows: the bar's range
				// says so, and the view opens pinned to the newest row of the
				// record, the bottom of the record's one entry.
				const rangeOf = (f: string): number[] | null => {
					const match = f.match(/(\d+)-(\d+)\/(\d+)/);
					return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
				};
				const range = rangeOf(frame);
				expect(range).not.toBeNull();
				if (range === null) return;
				const [top, bottom, total] = range;
				const visible = bottom - top + 1;
				expect(bottom).toBe(total);
				// The gutter holds the scrollbar the record needs: the body's
				// last column, the pane's border and the box's border standing to
				// its right. Every row of the window wears the track, and the
				// thumb stands on the rows the position covers, the way the
				// Decision modal's turn log paints it.
				const trimmed = frame.split("\n").map((row) => row.trimEnd());
				const thumb = trimmed.filter((row) => row.endsWith("█ │ │")).length;
				const track = trimmed.filter((row) => row.endsWith("│ │ │")).length;
				expect(thumb + track).toBe(visible);
				expect(thumb).toBeGreaterThanOrEqual(1);
				// k steps up one row of the record, and j returns to the bottom.
				await pressControl(setup, "scroll-body", {
					via: "k",
					shows: `${top - 1}-${bottom - 1}/${total}`,
				});
				await pressControl(setup, "scroll-body", { via: "j", shows: `${top}-${bottom}/${total}` });
				// home takes the record's first row.
				const topFrame = await pageKey(setup, "home", { shows: `1-${visible}/${total}` });
				// The fault's entry leads with its chip where the record shows it:
				// the enqueue's notice leads the record, and the ERROR chip wears
				// the error's red beside the time's subtext0, the roles decision
				// 10 names (issue #331).
				const topRows = rowsOf(topFrame);
				const errorRow = topRows.findIndex((row) => row.includes("ERROR"));
				expect(errorRow).toBeGreaterThan(-1);
				expect(spanColorAt(setup, errorRow, "ERROR")).toEqual(rgb(roleColor("red")));
				expect(spanColorAt(setup, errorRow, historyTimeOf(topRows[errorRow]))).toEqual(
					rgb(roleColor("subtext0")),
				);
				// Esc closes; the error is back on the base line.
				await pressControl(setup, "message-close", { closes: "Message view" });
				expect(messageRowOf(await waitFor(setup, { quiet: true }))).toContain("the daemon refused");
				// F2 closes too.
				await pressControl(setup, "message", { opens: "Message view" });
				await pressControl(setup, "message-close", { via: "F2", closes: "Message view" });
				expect(messageRowOf(setup.captureCharFrame())).toContain("the daemon refused");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	/** The Close hint one bar of this width must name, or none when no key fits. */
	function closeBarWord(width: number): string {
		if (width >= 12) return "Esc/F2 Close";
		if (width >= 3) return "Esc";
		if (width === 2) return "F2";
		return "";
	}

	test("its bar names the Close control down to one whole key", async () => {
		const planeRecord = await faultPlane({ commands: longLineCommands });
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				await pressControl(setup, "message", { opens: "Message view" });
				// The view's Close owns the row's end cells, so a frame that
				// cannot hold the hint states one whole key instead. It never
				// states part of a key, and only falls silent where no key of
				// this control fits at all (user stories 66 and 73). The bar row is
				// the one inside the frame that states the Close's key, above the
				// frame's bottom border.
				const barRowOf = (rows: string[]) =>
					rows.find((row) => /Esc|F2|Close/.test(row))?.trim() ?? "";
				for (let width = 20; width >= 1; width -= 1) {
					setup.resize(width, 8);
					const rows = rowsOf(await waitFor(setup, { quiet: true }));
					for (const row of rows) expect(widthOf(row)).toBe(width);
					const bar = barRowOf(rows);
					const word = closeBarWord(width);
					if (word === "") expect(bar).toBe("");
					else expect(bar).toContain(word);
				}
				// The row is the surface's own again at a usable width.
				setup.resize(30, 8);
				await frameUntil(setup, "the view's full Close hint", (f) =>
					barRowOf(rowsOf(f)).includes("Esc/F2 Close"),
				);
				await pressControl(setup, "message-close", { closes: "Message view" });
				expect(actionBarRowOf(await waitFor(setup, { quiet: true }))).toContain("Help");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("hands the keys to the Key guide on F1 and ?", async () => {
		// F1.
		const planeRecord = await faultPlane({ commands: longLineCommands });
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				source.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(planeRecord.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				await pressControl(setup, "message", { opens: "Message view" });
				await guideKey(setup, "help", "F1", { opens: "Key guide - Ticket list" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Ticket list" });
				// The view closed with the guide: the base holds the truncated
				// fault line.
				expect(messageRowOf(await waitFor(setup, { quiet: true })).trim()).toBe(
					truncateToWidth(faultLine("Retry policy for webhooks", LONG_LINE), WIDTH),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		// Question mark.
		const guidePlane = await faultPlane({ commands: longLineCommands });
		const guideSource = guidePlane.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				guideSource.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(guidePlane.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				await pressControl(setup, "message", { opens: "Message view" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide - Ticket list" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Ticket list" });
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe(
					truncateToWidth(faultLine("Retry policy for webhooks", LONG_LINE), WIDTH),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: guidePlane,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("stays visible in the below-minimum frame, with the important line for errors", async () => {
		// Error: the compact frame keeps the line twice - the important one in
		// the box, the full one in the permanent row. The plane's standing
		// error is the close cleanup herdr refused, on the long stderr.
		const errorLine = `Error: ticket github:github.com:I_5 closed; the close cleanup failed: ${LONG_LINE}`;
		const errorPlane = await plane({
			groupingAxis: "none",
			sources: [{ config: issueSource, tickets: [inFlightRow(issueTicket(), "worktree")] }],
			// The clock sits past the startup grace, so the start is old, not a boot.
			now: () => Date.now() - 60_000,
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake) => closeCleanupCommands(fake, `${LONG_LINE}\n`),
		});
		const errorSource = errorPlane.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				errorSource.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "missing" });
				await pressControl(setup, "ticket-close", { opens: "Close: Add a webhook retry policy" });
				await pressControl(setup, "confirm-action", { hides: "Close:" });
				await frameUntil(setup, "the error", (f) => messageRowOf(f).startsWith("Error: "));
				setup.resize(25, 10);
				const rows = rowsOf(await waitFor(setup, { quiet: true }));
				expect(rows[1]).toContain("Terminal too small");
				expect(rows[2].trim()).toBe(truncateToWidth(errorLine, 23));
				expect(rows[8]).toBe(padToWidth(truncateToWidth(errorLine, 25), 25));
				expect(rows[9].trim()).toBe("? Help");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: errorPlane,
				loopPolicy: { kind: "production" },
			},
		);

		// Warning: no important line - warnings are not important below the
		// minimum, the permanent row carries them.
		const warnFake = new FakeRunner();
		const warnPlane = await plane({ runner: () => warnFake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				await pressControl(setup, "refresh", { quiet: true });
				setup.resize(25, 10);
				const rows = rowsOf(await waitFor(setup, { quiet: true }));
				expect(rows[1]).toContain("Terminal too small");
				expect(rows[2].trim()).toBe("");
				expect(rows[8]).toBe(
					padToWidth(truncateToWidth("Warning: no Ticket sources exist", 25), 25),
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: warnPlane,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("survives a resize across the minimum", async () => {
		// Warning round trip.
		const fake = new FakeRunner();
		const planeRecord = await plane({ runner: () => fake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				await pressControl(setup, "refresh", { quiet: true });
				setup.resize(30, 10);
				expect(messageRowOf(await waitFor(setup, { quiet: true }))).toBe(
					padToWidth(truncateToWidth("Warning: no Ticket sources exist", 30), 30),
				);
				setup.resize(WIDTH, HEIGHT);
				expect(messageRowOf(await waitFor(setup, { quiet: true }))).toContain(
					"no Ticket sources exist",
				);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		// Error round trip: the truncation and the hint return with the width.
		// The fault stands on the queued start's warning (ADR 0118's split),
		// and the line the resize travels is the drop's.
		const errLine = faultLine("Retry policy for webhooks", LONG_LINE);
		const errPlane = await faultPlane({ commands: longLineCommands });
		const errSource = errPlane.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				errSource.settle(fetchSuccess([faultTicket]));
				await waitSourceHealthy(errPlane.state);
				await pressControl(setup, "handoff", { shows: "the daemon refused" });
				setup.resize(30, 10);
				expect(messageRowOf(await waitFor(setup, { quiet: true }))).toBe(
					padToWidth(truncateToWidth(errLine, 30), 30),
				);
				setup.resize(WIDTH, HEIGHT);
				const frame = await waitFor(setup, { quiet: true });
				expect(messageRowOf(frame)).toBe(padToWidth(truncateToWidth(errLine, WIDTH), WIDTH));
				expect(actionBarRowOf(frame)).toContain("m Message");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: errPlane,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the queue's own words stand on the line, in the queue's own place", async () => {
		// The one-seat config runs the first start, and holds the second in
		// the Work queue while the seat stays full. The queue's lines are the
		// module's facts read back on the Message line: the enqueue's notice
		// says where the start waits, the queue's Delete says where it went,
		// and the pickup's notice says where it ran.
		const runner = new FakeRunner();
		const planeRecord = await plane({
			existing: wrappedState(),
			runner: () => runner,
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
			repos: { "github.com/acme/factory": "src/factory" },
			config: { maxParallelAgents: 1 },
		});
		const source = planeRecord.sources[0] as FakeSource;
		// The fake herdr answers every command with no body; the workspace
		// list the pickup asks needs its JSON, or the start fails on the
		// unreadable answer the queue line would not carry.
		stubCheckoutInto(runner, join(planeRecord.home, "src", "factory"), "github.com/acme/factory");
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.setDefault({ stdout: workspaceCreateJson("ws-1") });
		await withApp(
			async (setup) => {
				// Two open tickets: the first takes the seat, the second
				// waits behind it in the queue.
				const secondTicket = issueTicket("github:github.com:I_6", {
					title: "Keep tickets across starts",
				});
				source.settle(fetchSuccess([issueTicket(), secondTicket]));
				await frameUntil(setup, "the second ticket", (f) =>
					rowsOf(f).some((row) => row.includes("Keep tickets acro")),
				);
				await pressControl(setup, "handoff", { shows: "started from the Work queue" });
				// The queue takes the second start while the seat stays
				// full, and its notice stands on the line.
				await pressControl(setup, "move-list", { via: "↓", shows: "Keep tickets acro" });
				const queued = await pressControl(setup, "handoff", {
					shows: "is in the Work queue; it starts when a seat frees",
				});
				expect(frameText(queued)).toContain("waiting: 1");
				// The queue's Delete removes the item, and its own words
				// stand on the line.
				await pressControl(setup, "queue-jump", { quiet: true });
				await waitFor(setup, { shows: "❯ Work queue" });
				await guideKey(setup, "queue-remove", "Delete", { shows: "was removed" });
				const frame = await waitFor(setup, { quiet: true });
				expect(messageRowOf(frame)).toContain(
					`the waiting start for "Keep tickets across starts" was removed`,
				);
				expect(frameText(frame)).toContain("waiting: 0");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("records the source health at the change, stays silent while it stands, and names the recovery", async () => {
		const runner = new FakeRunner();
		// The observation loop's own read stays hermetic, the way the
		// notification's tests do: a readable agent list, so its only fact
		// is the one with no state change at all.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const planeRecord = await plane({
			existing: wrappedState(),
			runner: () => runner,
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// The boot's own refresh settles clean.
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { shows: "Add a webhook retry policy" });
				// A source that goes stale lands one warning entry and one
				// notification, at the change.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 2);
				source.settle(fetchRateLimited);
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
				const sent = notificationCalls(runner);
				expect(sent).toHaveLength(1);
				expect(sent[0]).toContain("issues: stale - GitHub rate limit exceeded");
				const changed = await pressControl(setup, "message", { opens: "Message view" });
				expect(historyEntries(changed, "WARN")).toBe(1);
				expect(historyEntries(changed, "INFO")).toBe(0);
				await pressControl(setup, "message-close", { closes: "Message view" });
				// The next refresh fails on the same standing fact: the source
				// stays stale, so no second entry and no second send.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 3);
				source.settle(fetchRateLimited);
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
				expect(notificationCalls(runner)).toHaveLength(1);
				const standing = await pressControl(setup, "message", { opens: "Message view" });
				expect(historyEntries(standing, "WARN")).toBe(1);
				expect(historyEntries(standing, "INFO")).toBe(0);
				await pressControl(setup, "message-close", { closes: "Message view" });
				// A clean refresh recovers the source: one info entry names
				// the recovery, and the info fact sends no notification.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 4);
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { hides: "issues: stale" });
				expect(notificationCalls(runner)).toHaveLength(1);
				const healed = await pressControl(setup, "message", { opens: "Message view" });
				expect(historyEntries(healed, "WARN")).toBe(1);
				expect(historyEntries(healed, "INFO")).toBe(1);
				expect(healed).toContain("issues: recovered");
				// The rows wear the roles decision 10 names (issue #331): the
				// WARN chip wears the warning's yellow, the INFO chip the line's
				// text, and both datetimes the time's subtext0.
				const rows = rowsOf(healed);
				const warnRow = rows.findIndex((row) => row.includes("issues: stale"));
				const infoRow = rows.findIndex((row) => row.includes("issues: recovered"));
				expect(warnRow).toBeGreaterThan(-1);
				expect(infoRow).toBeGreaterThan(warnRow);
				expect(spanColorAt(setup, warnRow, "WARN")).toEqual(rgb(roleColor("yellow")));
				expect(spanColorAt(setup, infoRow, "INFO")).toEqual(rgb(roleColor("text")));
				for (const row of [warnRow, infoRow]) {
					expect(spanColorAt(setup, row, historyTimeOf(rows[row]))).toEqual(
						rgb(roleColor("subtext0")),
					);
				}
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "production" },
			},
		);
	});

	test("is silent for scheduled refreshes, and warns on a failed fetch", async () => {
		const planeRecord = await plane({
			existing: wrappedState(),
			sources: [{ config: issueSource, tickets: [ticketOf(issueTicket())] }],
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				// The scheduled fetch runs silent: the list loads, the line stays clear.
				await waitFor(setup, { shows: "loading tickets..." });
				expect(messageRowOf(setup.captureCharFrame()).trim()).toBe("");
				// A failed fetch warns in the source's own words.
				source.settle(fetchRateLimited);
				await waitFor(setup, { refuses: "issues: stale - GitHub rate limit exceeded" });
				// A successful refresh heals the source and clears the line.
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 2);
				source.settle(fetchSuccess([issueTicket()]));
				await waitFor(setup, { hides: "issues: stale" });
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	// The no-color presentation of the history (issue #331, decision 10): the
	// chip, the datetime, and the text paint no color at all, and the level
	// still stands in its written word.
	test("NO_COLOR paints the history rows with no color, and the words keep standing", async () => {
		process.env.NO_COLOR = "1";
		try {
			const fake = new FakeRunner();
			const planeRecord = await plane({ runner: () => fake, sources: [], groupingAxis: "none" });
			await withApp(
				async (setup) => {
					// A refused refresh records its warning, and the view shows it.
					await pressControl(setup, "refresh", { quiet: true });
					const view = await pressControl(setup, "message", { opens: "Message view" });
					const rows = rowsOf(view);
					const row = rows.findIndex((row) => row.includes("no Ticket sources"));
					expect(row).toBeGreaterThan(-1);
					// Nothing in the row paints: the chip, the datetime, and the text
					// all wear the terminal's own default, the renderer's, not a
					// paint of the theme's roles.
					expect(spanColorAt(setup, row, "WARN")).toEqual([255, 255, 255]);
					expect(spanColorAt(setup, row, historyTimeOf(rows[row]))).toEqual([255, 255, 255]);
					expect(spanColorAt(setup, row, "no Ticket sources exist")).toEqual([255, 255, 255]);
				},
				{
					width: WIDTH,
					height: HEIGHT,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
		} finally {
			// The worker's environment is shared with the files that run
			// beside this one: a NO_COLOR left behind paints their frames
			// white for the rest of the run.
			delete process.env.NO_COLOR;
		}
	});
});
