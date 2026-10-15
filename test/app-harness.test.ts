/**
 * The shared frame harness's own contract (issue #366, ADR 0129).
 *
 * The harness's boot takes the boot fields the suites name, and a suite that
 * names no plane lands on the module's default standing: a real Seeded
 * plane, the sample tickets under one issues source, on a state file on
 * disk. The projection plane the old harness defaulted to - the in-memory
 * list, no loops, no teardown handle - is gone, and this suite pins that it
 * cannot return as a default: a boot without a named plane stands on a
 * state file the list rule seeded, and the loop it runs or holds is the
 * named policy, never an absence.
 *
 * What the check reads, stated: the state file's path off the plane record,
 * the painted frame, and the Command runner's record of the observation
 * poll. The suites that drive the painted surfaces are the frame suites,
 * one per surface; this one pins the seam they all boot from.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Ticket } from "../src/domain/ticket.ts";
import { frameUntil, waitFor, withApp } from "./app-harness.ts";
import { plane } from "./plane.ts";

/** The ticket the named plane stands on, beside the default standing's. */
const NAMED_TICKET: Ticket = {
	identity: "github:github.com:Named_1",
	title: "A named plane ticket",
	repository: "acme/named",
	repositoryRef: {
		identity: "github.com/acme/named",
		displayName: "acme/named",
		cloneUrl: "https://github.com/acme/named.git",
	},
	state: "open",
	handoff: null,
	workCycle: 1,
	description: "The ticket the named plane stands on.",
	sourceKind: "github-issue",
	externalKey: "#1",
	sourceState: "open",
	url: "https://github.com/acme/named/issues/1",
	labels: [],
	externalUpdatedAt: "2026-01-01T00:00:00Z",
	memberships: [],
	suggestedTaskType: "implement",
	matchedStateName: null,
	actionable: true,
	listActionable: true,
	handoffRecoveryRequired: false,
	handoffCount: 0,
	failedStartStreak: 0,
	lastCompletion: null,
	ignored: false,
	ignoredAt: null,
	muted: false,
	mutedAt: null,
	leftover: null,
	nameCollision: null,
};

/**
 * A sample ticket's row, read off the list. The row carries the ticket's
 * title, truncated to the list half of the default terminal width, and its
 * repository: `SAMPLE_TICKETS[0]` stands as "Retry policy for" beside
 * "acme/billing" at the harness's 120 columns.
 */
const SAMPLE_ROW = (frame: string) =>
	frame.includes("Retry policy for") && frame.includes("acme/billing");

describe("the shared frame harness boots the Seeded plane", () => {
	test("a boot that names no plane lands on the Seeded plane", async () => {
		// The state file stands on disk: the plane is a real state file the
		// list rule seeded, and the frame reads the list it produced. The
		// old default - the projection in memory - had no such file.
		await withApp(async (setup) => {
			expect(existsSync(setup.plane.state.path), "the plane's state file").toBe(true);
			const frame = await frameUntil(setup, "the sample list", SAMPLE_ROW);
			expect(SAMPLE_ROW(frame)).toBe(true);
		});
	});

	test("a boot that names no policy holds the loops", async () => {
		// The default policy is `held`: the deterministic frame, where
		// nothing moves until a key press or a settle does. The observation
		// poll is the loop the held policy holds, so the runner's record of
		// it is empty while the frame stands.
		await withApp(async (setup) => {
			await frameUntil(setup, "the sample list", SAMPLE_ROW);
			const polls = setup.plane.fakeRunner
				.commands()
				.filter((command) => command.startsWith("herdr agent list"));
			expect(polls).toEqual([]);
		});
	});

	test("a boot that names a poll interval runs the observation loop", async () => {
		// The rig names the interval, the way the old test-only slot used to,
		// through the named policy instead of a field the plane's interface
		// called test-only. The poll lands in the runner's record.
		await withApp(
			async (setup) => {
				await frameUntil(setup, "the observation poll", () =>
					setup.plane.fakeRunner
						.commands()
						.some((command) => command.startsWith("herdr agent list")),
				);
			},
			{ loopPolicy: { kind: "polled", intervalMs: 25 } },
		);
	});

	test("a plane that names a poll interval runs the loop the plane named", async () => {
		// The standing the plane named names the loop policy, and the harness
		// reads it off the plane's props, the way the App's own boot reads
		// them: a plane that stands a poll interval boots the poll, and a
		// policy named on the boot still stands over the plane's.
		const named = await plane({ pollIntervalMs: 25 });
		await withApp(
			async (setup) => {
				await frameUntil(setup, "the observation poll", () =>
					setup.plane.fakeRunner
						.commands()
						.some((command) => command.startsWith("herdr agent list")),
				);
			},
			{ plane: named },
		);
	});

	test("a boot that names a plane boots the plane it named", async () => {
		// The plane record the suite named is the one the app stands on: the
		// harness takes the record, it does not replace it, and the frame
		// reads the list the named plane's state file holds.
		const named = await plane({
			groupingAxis: "none",
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/named"],
						host: "github.com",
					},
					tickets: [NAMED_TICKET],
				},
			],
		});
		try {
			await withApp(
				async (setup) => {
					expect(setup.plane, "the plane record the boot takes").toBe(named);
					expect(setup.plane.state.path, "the named plane's state file").toBe(named.state.path);
					await waitFor(setup, { shows: "A named plane ticket" });
				},
				{ plane: named },
			);
		} finally {
			named.close();
		}
	});
});
