/**
 * The Ticket section's Groups, through the real app flow (issue #159).
 *
 * Every test boots the App at a fixed terminal size against a real state file,
 * a fake command runner, and fake sources, then presses keys or clicks and
 * reads frames. What an operator sees - the rows on screen, the counts a header
 * carries, the Message line, the Action bar hint, the cursor's row, and the
 * refusal a key answers with - is the assertion. No test reaches for a private
 * helper or the shape of an intermediate list.
 *
 * The fixture spreads six tickets over two Repositories and two Ticket feeds,
 * one row for each fact an axis reads: an open ticket, a Review-labeled ticket,
 * a ticket on a parking State, a ticket no State matches, and, when the test
 * asks for it, a held turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { GroupingAxis } from "../src/domain/grouping.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { repositoryInitSettingsHash } from "../src/repo-init.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	type AppSetup,
	actionBarRowOf,
	awaitFrame,
	detailPaneText,
	frameText,
	listHalfOf,
	markerRowOf,
	messageRowOf,
	mouseClick,
	press,
	pressArrow,
	rowsOf,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import { callsReached } from "./state-fixture.ts";

let home = "";
const opened: FactoryState[] = [];

beforeEach(() => {
	home = join(tmpdir(), `factory-groups-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	for (const state of opened.splice(0)) state.close();
	rmSync(home, { recursive: true, force: true });
});

const BILLING = "acme/billing";
const FACTORY = "acme/factory";

/** One issue on one Repository, with the labels the machine reads. */
function issue(
	number: number,
	title: string,
	repository: string,
	labels: string[],
	externalUpdatedAt = "2026-08-31T10:00:00Z",
): FetchedTicket {
	return {
		identity: `github:github.com:I_${number}`,
		sourceKind: "github-issue",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/${repository}/issues/${number}`,
		title,
		description: `The description of ${title}.`,
		labels,
		externalUpdatedAt,
		repository: {
			identity: `github.com/${repository}`,
			displayName: repository,
			cloneUrl: `https://github.com/${repository}.git`,
		},
		attributes: {},
	};
}

/** The fixture's six tickets, one per fact an axis can read. */
function tickets(): FetchedTicket[] {
	return [
		issue(1, "Webhook retry", FACTORY, ["ready-for-agent"]),
		// The Review-labeled ticket stands on both feeds, and its `triage`
		// listing is the newer one, so the row's facts - and its Group on the
		// `source` axis - come from `triage`.
		issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-08-31T10:00:00Z"),
		issue(3, "Legacy import", BILLING, ["hold"]),
		issue(4, "Unlabeled work", BILLING, []),
		issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
	];
}

const ZETA = "acme/zeta";

/**
 * The width test's list: the crowd on acme/factory, with the rest of the list
 * on a Repository whose name sorts after it, so the held Group owns the
 * window's first row whatever rule stands the Groups (ADR 0071).
 */
function crowdFirst(extra: number): FetchedTicket[] {
	const crowd = Array.from({ length: extra }, (_unused, index) =>
		issue(100 + index, `Crowd ticket ${index + 1}`, FACTORY, ["ready-for-agent"]),
	);
	return [
		issue(1, "Webhook retry", FACTORY, ["ready-for-agent"]),
		issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-08-31T10:00:00Z"),
		issue(3, "Legacy import", ZETA, ["hold"]),
		issue(4, "Unlabeled work", ZETA, []),
		issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
		...crowd,
	];
}

const ISSUES = { name: "issues", kind: "github-issues" };
const TRIAGE = { name: "triage", kind: "github-issues" };

const success = (listed: FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: listed,
});

/** The listing the second feed reports: only the Review ticket. */
function triageListing(): FetchedTicket[] {
	return [issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")];
}

/**
 * The config the grouping frames run on.
 *
 * Its States name the positions the `position` axis groups by, and the third
 * offers no task, so the parked ticket reads `parked` on the `task` axis and
 * `on-hold` on the `position` axis. The unlabeled ticket matches no State, so
 * the fallback task stands and its position falls to `unmatched`.
 */
const groupConfig: FactoryConfig = {
	...BASE_CONFIG,
	agentPollIntervalSeconds: 60,
	maxParallelAgents: 4,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: [FACTORY, BILLING],
			host: "github.com",
		},
		{
			name: "triage",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: [FACTORY],
			host: "github.com",
		},
	],
	workflowStates: [
		{
			name: "ready-for-agent",
			taskType: "implement",
			match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
		},
		{
			name: "awaiting-review",
			taskType: "review",
			match: { sourceKind: "github-issue", labelsAny: ["needs-review"] },
		},
		{
			name: "on-hold",
			match: { sourceKind: "github-issue", labelsAny: ["hold"] },
		},
	],
};

/**
 * One state with the fixture listed on both feeds.
 *
 * `hold` moves the fifth ticket through a Handoff into a held turn (ADR 0016),
 * which is the fact a collapsed header carries as its held count. It is off by
 * default: a held turn also arms the Dispatch pause, and the pause's warning
 * outranks every notice on the Message line, which would hide the axis's own
 * statement from the frames that check it.
 */
function groupedState(
	hold = false,
	listed: FetchedTicket[] = tickets(),
	axis?: GroupingAxis,
	init = true,
): { state: FactoryState; sources: FakeSource[] } {
	const state = openFactoryState(join(home, "state.sqlite"));
	state.sourceFact.initializeSources([ISSUES, TRIAGE]);
	// The axis a restart reads back from the state file (ADR 0058), so a frame
	// can boot on a split instead of stepping the cycle with presses.
	if (axis !== undefined) state.grouping.setGroupingAxis("tickets", axis);
	// The groups' fixtures stand initialized (ADR 0075) by default, so the init
	// marker stays out of the grouping's own frame and the one-time note stays
	// out of the Message line: these tests are the grouping's, and the marker
	// and the note have their own tests below. A boot that asks for an
	// uninitialized repository skips the seed and lets the marker and the note
	// stand.
	if (init) {
		const initHash = repositoryInitSettingsHash(groupConfig.workflowStates, groupConfig.taskTypes);
		const seeded = new Set<string>();
		for (const ticket of listed) {
			if (seeded.has(ticket.repository.identity)) continue;
			seeded.add(ticket.repository.identity);
			state.repositoryInit.setRepositoryInitFact(
				ticket.repository.identity,
				initHash,
				"init-commit",
			);
		}
	}
	state.sourceFact.applyFetch(ISSUES, success(listed));
	state.sourceFact.applyFetch(TRIAGE, success(triageListing()));
	if (hold) {
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_5",
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-5",
			tabId: "tab-5",
			workspaceId: "ws-5",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: "github:github.com:I_5",
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The turn failed.",
			turnLog: [{ kind: "text", text: "The turn failed." }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "failed",
		});
	}
	return {
		state,
		sources: [
			new FakeSource("issues", "github-issues", success(listed)),
			new FakeSource("triage", "github-issues", success(triageListing())),
		],
	};
}

/** The state file path a fixture opened on, so a restart test can reopen it. */
function stateFile(): string {
	return join(home, "state.sqlite");
}

/** Boot the real app on the grouped fixture and hand the test its handle. */
async function bootGrouped(
	body: (setup: AppSetup, fixture: { state: FactoryState; sources: FakeSource[] }) => Promise<void>,
	options: {
		size?: readonly [number, number];
		hold?: boolean;
		state?: FactoryState;
		/** The listing the `issues` feed reports, for a Group with a crowd. */
		list?: FetchedTicket[];
		/** The axis to seed in the state file, so the frame boots on the split. */
		axis?: GroupingAxis;
		/** Stand the repositories uninitialized, so the marker and the note stand. */
		uninit?: boolean;
	} = {},
): Promise<void> {
	const listed = options.list ?? tickets();
	const made =
		options.state === undefined
			? groupedState(options.hold === true, listed, options.axis, options.uninit !== true)
			: null;
	const fixture = made ?? { state: options.state as FactoryState, sources: [] };
	const sources =
		fixture.sources.length > 0
			? fixture.sources
			: [
					new FakeSource("issues", "github-issues", success(listed)),
					new FakeSource("triage", "github-issues", success(triageListing())),
				];
	if (made !== null) opened.push(fixture.state);
	const size = options.size ?? [WIDTH, 34];
	try {
		await withApp(
			async (setup) => {
				sources[0].settle(success(listed));
				sources[1].settle(success(triageListing()));
				await awaitFrame(setup, (frame) => frame.includes("❯ Tickets"), "the ticket list");
				await body(setup, { state: fixture.state, sources });
			},
			size[0],
			size[1],
			{
				state: fixture.state,
				config: groupConfig,
				home,
				runner: emptyAgentRunner(),
				sources,
			},
		);
	} finally {
		if (made !== null) opened.splice(opened.indexOf(fixture.state), 1);
	}
}

/**
 * Press Tab, the axis control, and wait for the frame the press must leave.
 *
 * A key sent into a surface whose update chain is still in flight can be
 * dropped, and the plane's own notice can wait behind an operation fact, so
 * the wait retries the press a few times before it fails the test on the
 * frame deadline.
 */
async function pressTab(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	const deadline = Date.now() + 4000;
	for (let tryNumber = 0; tryNumber < 8; tryNumber += 1) {
		await settle(setup);
		setup.mockInput.pressTab();
		try {
			return await awaitFrame(setup, predicate, what, 350);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("timed out")) throw error;
			if (Date.now() >= deadline) throw error;
			await sleep(30);
		}
	}
	throw new Error(`Tab never left ${what}`);
}

/**
 * The Ticket list's own rows, top to bottom, as the operator reads them.
 *
 * The list is the box between its top border, which carries its title, and its
 * bottom one. Each terminal row is cut at the pane divider, so the detail pane
 * beside it never enters the read.
 */
function listRows(frame: string): string[] {
	const rows = rowsOf(frame);
	const top = rows.findIndex((row) => /─\s*(❯\s+)?Tickets─/.test(row));
	if (top < 0) return [];
	const out: string[] = [];
	for (const row of rows.slice(top + 1)) {
		if (row.startsWith("└")) break;
		const half = listHalfOf(row).replace(/[│┌┐└┘─]/g, " ");
		out.push(half.replace(/\s+/g, " ").trim());
	}
	return out.filter((row) => row.trim() !== "" && !/^(❯ )?Tickets\s*$/.test(row));
}

/** The Group headers inside the Ticket list, in frame order, without the marker. */
function headers(frame: string): string[] {
	return listRows(frame)
		.filter((row) => /^[▾▸] \S/.test(row) || /^❯ [▾▸] \S/.test(row))
		.map((row) => row.replace(/^❯ /, ""));
}

/**
 * The Ticket list's rows as the terminal holds them, gaps and all.
 *
 * `listRows` folds the runs of spaces that carry a row's layout away; these
 * narrow-frame tests must read them, because a header that overflows its pane
 * splits its counts over two rows, and only the exact cells show that.
 */
function listPaneRows(frame: string): string[] {
	const rows = rowsOf(frame);
	const top = rows.findIndex((row) => /─\s*(❯\s+)?Tickets─/u.test(row));
	if (top < 0) return [];
	const out: string[] = [];
	for (const row of rows.slice(top + 1)) {
		if (row.startsWith("└")) break;
		out.push(listHalfOf(row).replace(/[│┌┐└┘─]/gu, " "));
	}
	return out;
}

/** Whether any Ticket list row holds the pattern, gaps and all. */
function paneHolds(frame: string, pattern: RegExp): boolean {
	return listPaneRows(frame).some((row) => pattern.test(row));
}

/**
 * The Ticket list's rows with the air kept: one entry per window row, the box's
 * own padding trimmed away, and a blank row read as `""`.
 *
 * `listRows` folds the blank rows out, so it cannot show the row that parts two
 * Groups. The Grouping axis puts that air in front of every header but the
 * first, and only these exact rows say so.
 */
function airRows(frame: string): string[] {
	const rows = listPaneRows(frame).map((row) => row.trimEnd());
	const first = rows.findIndex((row) => row !== "");
	if (first < 0) return [];
	let last = rows.length - 1;
	while (last > first && rows[last] === "") last -= 1;
	return rows.slice(first, last + 1);
}

/** The ticket rows inside the Ticket list, in frame order. */
function ticketRows(frame: string): string[] {
	return listRows(frame).filter((row) => !/^[❯ ]*[▾▸] \S/.test(row));
}

/**
 * Refresh the sources and settle each one's next fetch with `listings`.
 *
 * A fake source resolves a fetch only when the test settles it, so the wait
 * runs on the call the press started: the refresh lands, the snapshot returns,
 * and the list re-reads.
 */
async function refreshWith(
	setup: AppSetup,
	fixture: { sources: FakeSource[] },
	listings: (FetchedTicket[] | null)[],
): Promise<void> {
	const wanted = fixture.sources.map((source) => source.calls + 1);
	await press(setup, "r", "the refresh", (f) => messageRowOf(f).includes("refreshing"));
	for (const [index, source] of fixture.sources.entries()) {
		const next = listings[index];
		if (next === null) continue;
		await callsReached(source, wanted[index]);
		source.settle(success(next));
	}
	await settle(setup);
}

/** The Section header line of the Ticket section. */
function sectionHeader(frame: string): string {
	return (
		rowsOf(frame)
			.find((row) => /[▾▸] Tickets/.test(row))
			?.replace(/\s+/g, " ") ?? ""
	);
}

describe("the Ticket section's Groups", () => {
	// ADR 0066: a fresh state file seeds the repository split, so a newly
	// configured plane comes up grouped before any press.
	test("a freshly configured plane comes up grouped by repository", async () => {
		await bootGrouped(async (setup) => {
			const frame = await settle(setup);
			// The fresh state file seeds the repository split (ADR 0066): the
			// headers stand before any press, and the runs stand in the order the
			// axis names them (ADR 0071): alphabetical, with the value's own word.
			expect(headers(frame)).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
			// The bar names the split the list wears once the cursor rests on a
			// ticket row, the way a press would have named it.
			const onTicket = await pressArrow(setup, "down", "a ticket row", (f) =>
				(rowsOf(f)[markerRowOf(f)] ?? "").includes("Legacy import"),
			);
			expect(actionBarRowOf(onTicket)).toContain("Tab Group: repository");
		});
	});

	test("the flat list is the list today's plane draws, with no header", async () => {
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				// Every ticket shows, no header stands above any run, and the bar
				// states no axis: `none` is the list exactly as it was (story 46).
				// The cursor rests on the list's first row, so the check reads a row
				// the marker does not touch.
				expect(ticketRows(frame)).toContain("[open] [review] Deploy gate acme/factory");
				expect(headers(frame)).toEqual([]);
				expect(actionBarRowOf(frame)).not.toContain("Tab Group");
			},
			{ axis: "none" },
		);
	});

	test("Tab cycles the axis, states it on the Message line, and names it in the bar", async () => {
		await bootGrouped(
			async (setup) => {
				const grouped = await pressTab(
					setup,
					"the repository axis",
					(frame) => headers(frame).length === 2,
				);
				expect(messageRowOf(grouped)).toContain("Ticket list grouped by repository");
				expect(actionBarRowOf(grouped)).toContain("Tab Group: repository");
				// The whole ladder, in the fixed order, back to the flat list:
				// none, repository, source, task, state, position, none (story 4).
				for (const word of ["source", "task", "state", "position"] as const) {
					const frame = await pressTab(setup, `the ${word} axis`, (f) =>
						messageRowOf(f).includes(`grouped by ${word}`),
					);
					expect(actionBarRowOf(frame)).toContain(`Tab Group: ${word}`);
				}
				const flat = await pressTab(setup, "the flat list", (f) =>
					messageRowOf(f).includes("Ticket list grouping off: the flat list"),
				);
				expect(headers(flat)).toEqual([]);
				expect(actionBarRowOf(flat)).not.toContain("Tab Group");
			},
			{ axis: "none" },
		);
	});

	test("Tab cycles the axis from the Ticket detail too, and names it in the bar", async () => {
		await bootGrouped(
			async (setup) => {
				await focusDetailRow(setup);
				const grouped = await pressTab(
					setup,
					"the repository axis from the detail",
					(frame) => headers(frame).length === 2,
				);
				expect(messageRowOf(grouped)).toContain("Ticket list grouped by repository");
				// The detail mode's bar names the axis in effect as the list's
				// does, and the fold keeps its `Space` key there too (story 5).
				expect(actionBarRowOf(grouped)).toContain("Tab Group: repository");
				await press(setup, "h", "the list", (f) => f.includes("❯ Tickets"));
			},
			{ size: [WIDTH + 30, 34], axis: "none" },
		);
	});

	test("the repository axis puts one Repository's tickets under one header", async () => {
		await bootGrouped(
			async (setup) => {
				const frame = await pressTab(
					setup,
					"the repository Groups",
					(f) => headers(f).length === 2,
				);
				// The runs stand in the order the axis names them (ADR 0071):
				// alphabetical, with no run special. The order inside a Group is the
				// flat list's order, untouched.
				expect(headers(frame)).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
				expect(frame).toContain("Legacy import");
			},
			{ axis: "none" },
		);
	});

	test("the source axis lists a two-feed ticket once, under its own facts' source", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository axis", (f) => headers(f).length === 2);
				const frame = await pressTab(setup, "the source axis", (f) =>
					/Group: source/.test(actionBarRowOf(f)),
				);
				// The ticket two feeds list appears once, under the source its row's
				// facts come from (story 13). The Group stands by its lowest ticket
				// number in the open band (ADR 0065), so the feed that holds the lower
				// numbers stands first.
				const listed = ticketRows(frame).filter((row) => row.includes("Deploy gate"));
				expect(listed).toHaveLength(1);
				expect(headers(frame)).toEqual(["▾ issues 4", "▾ triage 1"]);
			},
			{ axis: "none" },
		);
	});

	test("the task axis groups by the badge rule, and parked is a Group of its own", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "repository", (f) => headers(f).length === 2);
				await pressTab(setup, "source", (f) => /Group: source/.test(actionBarRowOf(f)));
				const frame = await pressTab(setup, "the task axis", (f) =>
					/Group: task/.test(actionBarRowOf(f)),
				);
				// The badge's own words head the runs, and the ticket on the parking
				// State stands in `parked` where it is hidden rather than lost
				// (stories 15 and 16). The runs stand alphabetically (ADR 0071).
				expect(headers(frame)).toEqual(["▾ implement 3", "▾ parked 1", "▾ review 1"]);
			},
			{ axis: "none" },
		);
	});

	test("the state axis groups on the state fact, not the badge a row wears", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "repository", (f) => headers(f).length === 2);
				await pressTab(setup, "source", (f) => /Group: source/.test(actionBarRowOf(f)));
				await pressTab(setup, "task", (f) => /Group: task/.test(actionBarRowOf(f)));
				const frame = await pressTab(setup, "the state axis", (f) =>
					/Group: state/.test(actionBarRowOf(f)),
				);
				// The held turn sits with `awaiting`, and the runs stand in the
				// Workflow's own order of its states, whatever ticket any run holds
				// (ADR 0071).
				expect(headers(frame)).toEqual(["▾ open 4", "▾ awaiting 1 held 1"]);
			},
			{ hold: true, axis: "none" },
		);
	});

	test("the position axis files a ticket no State matches under unmatched", async () => {
		await bootGrouped(
			async (setup) => {
				for (const word of ["repository", "source", "task", "state"] as const) {
					await pressTab(setup, word, (f) => new RegExp(`Group: ${word}`).test(actionBarRowOf(f)));
				}
				const frame = await pressTab(setup, "the position axis", (f) =>
					/Group: position/.test(actionBarRowOf(f)),
				);
				// The runs stand in the Workflow's own order of its positions with
				// `unmatched` last (ADR 0071), whatever ticket any run holds.
				expect(headers(frame)).toEqual([
					"▾ ready-for-agent 2",
					"▾ awaiting-review 1",
					"▾ on-hold 1",
					"▾ unmatched 1",
				]);
				// Exactly one blank row parts each pair of Groups and none stands
				// above the first, so four headers leave three blanks between them.
				expect(airRows(frame).filter((row) => row === "")).toHaveLength(3);
			},
			{ size: [WIDTH, 40], axis: "none" },
		);
	});

	test("Space on a Group header folds that Group, and Space again opens it", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "up", "the header under the cursor", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				const onHeader = setup.captureCharFrame();
				// The bar names the key the fold will run (issue #170). At the
				// measured width the move's hint stands where the toggle's hint
				// gave way (ADR 0071): the toggle's one meaning still runs on
				// the header, and the guide names it.
				expect(actionBarRowOf(onHeader)).toContain("Space Fold group");
				expect(actionBarRowOf(onHeader)).toContain("+ Move up");
				// The fold: the Group's rows leave, its header stays and turns.
				const folded = await press(setup, "space", "the fold", (f) => /▸ acme\/factory/.test(f));
				expect(ticketRows(folded).some((row) => row.includes("Webhook retry"))).toBe(false);
				expect(headers(folded)).toContain("▸ acme/factory 3");
				// The Section header's counts stand: a fold hides rows, not facts.
				expect(sectionHeader(folded)).toContain("open: 5");
				// The cursor rests on the header, and the detail kept its ticket.
				expect(rowsOf(folded)[markerRowOf(folded)]).toContain("▸ acme/factory");
				expect(detailPaneText(folded)).toContain("The description of Webhook retry.");
				const opened = await press(setup, "space", "the fold back", (f) =>
					/▾ acme\/factory/.test(f),
				);
				expect(ticketRows(opened).some((row) => row.includes("Webhook retry"))).toBe(true);
				// No fold leaves a Message line: the routine move stays quiet
				// (issue #170, user story 17).
				expect(messageRowOf(setup.captureCharFrame())).not.toContain("Group");
			},
			{ axis: "none" },
		);
	});

	// Issue #170: `x` drops its second meaning. On a Group header row it runs
	// the Section toggle, the one meaning it holds on every row, and the fold
	// the operator made stands where it was made.
	test("x on a Group header runs the Section toggle, its one meaning", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "up", "the header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				// The fold stands first, so the collapse shows the header stays.
				await press(setup, "space", "the fold", (f) => /▸ acme\/factory/.test(f));
				const collapsed = await press(setup, "x", "the Section collapse", (f) =>
					/▸ Tickets/.test(f),
				);
				expect(headers(collapsed)).toEqual([]);
				// The Section back on the header the cursor retained, and the
				// fold the operator made still stands on it.
				const back = await press(setup, "x", "the Section back", (f) => /▾ Tickets/.test(f));
				expect(headers(back)).toEqual(["▾ acme/billing 2", "▸ acme/factory 3"]);
			},
			{ axis: "none" },
		);
	});

	// Issue #170: `Space` answers only on a Group header row. On a ticket row
	// - and in the flat list, where no header stands at all - it refuses in
	// the catalogue's own words on the Message line, and moves nothing.
	test("Space off a Group header row is refused in the catalogue's words", async () => {
		await bootGrouped(
			async (setup) => {
				// The flat list holds no Group header at all (issue #170,
				// user story 13).
				await settle(setup);
				setup.mockInput.pressKey(" ");
				const refusedFlat = await awaitFrame(
					setup,
					(f) => messageRowOf(f).includes("no Group header is under the cursor"),
					"the refusal in the flat list",
				);
				expect(headers(refusedFlat)).toEqual([]);
				// On a ticket row of the grouped list the refusal says the same
				// thing, and the row under the cursor never moves.
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const rowBefore = setup.captureCharFrame();
				const refused = await press(setup, "space", "the refusal on a ticket row", (f) =>
					messageRowOf(f).includes("no Group header is under the cursor"),
				);
				expect(rowsOf(refused)[markerRowOf(refused)]).toBe(
					rowsOf(rowBefore)[markerRowOf(rowBefore)],
				);
			},
			{ axis: "none" },
		);
	});

	test("a collapsed header carries its held count, so an owed decision stays named", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "up", "the header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				const folded = await press(setup, "space", "the fold", (f) => /▸ acme\/factory/.test(f));
				expect(headers(folded)).toContain("▸ acme/factory 3 held 1");
				// The fold carries its glyph, not a color: the no-color frame
				// would lose nothing (story 27, ADR 0059).
				expect(sectionHeader(folded)).toContain("held: 1");
			},
			{ hold: true, axis: "none" },
		);
	});

	test("a click on a Group header folds it and lands the cursor there", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const before = setup.captureCharFrame();
				const headerRow = rowIndexOf(before, /▾ acme\/factory/);
				expect(headerRow).toBeGreaterThan(0);
				await mouseClick(setup, 4, headerRow);
				const folded = await awaitFrame(setup, (f) => /▸ acme\/factory/.test(f), "the fold");
				// The cursor moved to the header the click folded (story 34).
				expect(rowsOf(folded)[markerRowOf(folded)]).toContain("▸ acme/factory");
				expect(ticketRows(folded).some((row) => row.includes("Webhook retry"))).toBe(false);
			},
			{ axis: "none" },
		);
	});

	test("x anywhere else in the Ticket section still folds the Section", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("x Section");
				const collapsed = await press(setup, "x", "the Section collapse", (f) =>
					/▸ Tickets/.test(f),
				);
				expect(headers(collapsed)).toEqual([]);
				await press(setup, "x", "the Section back", (f) => /▾ Tickets/.test(f));
				// The Groups return as the operator left them: the axis and the
				// folds are the run's own facts, not the frame's.
				expect(headers(setup.captureCharFrame())).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
			},
			{ axis: "none" },
		);
	});

	test("every Ticket control refuses a Group header, and the detail holds its ticket", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const held = detailPaneText(setup.captureCharFrame());
				expect(held).toContain("Webhook retry");
				await pressArrow(setup, "up", "the header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				// The pane did not blank out under the operator (story 40).
				expect(detailPaneText(setup.captureCharFrame())).toContain("Webhook retry");
				for (const key of ["w", "g", "e"] as const) {
					const refused = await press(setup, key, "the refusal", (f) =>
						messageRowOf(f).includes("no Ticket is selected"),
					);
					expect(messageRowOf(refused)).toContain("no Ticket is selected");
				}
				// Enter answers the same way: the catalogue resolved the key to the
				// section's Hand off, and its words are the plane's own.
				const enter = await press(setup, "return", "the Enter refusal", (f) =>
					messageRowOf(f).includes("no Ticket is selected"),
				);
				expect(enter).toBeTruthy();
			},
			{ axis: "none" },
		);
	});

	test("page, home, and end walk headers and rows alike", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await press(setup, "end", "the last row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Held turn"),
				);
				const home = await press(setup, "home", "the first row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				// Home lands on a Group header: the walk is one rule for both kinds
				// of row (story 41).
				expect(home).toBeTruthy();
			},
			{ axis: "none" },
		);
	});

	test("the cursor keeps its ticket across an axis change", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "down", "the second row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Deploy gate"),
				);
				const moved = await pressTab(setup, "the source axis", (f) =>
					/Group: source/.test(actionBarRowOf(f)),
				);
				expect(rowsOf(moved)[markerRowOf(moved)]).toContain("Deploy gate");
			},
			{ axis: "none" },
		);
	});

	test("a fold changes no count, no mode cell, and no queue fact", async () => {
		await bootGrouped(
			async (setup) => {
				const before = await settle(setup);
				const counts = sectionHeader(before);
				const mode = rowsOf(before)[0];
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "up", "the header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				const folded = await press(setup, "space", "the fold", (f) => /▸ acme\/factory/.test(f));
				expect(sectionHeader(folded)).toBe(counts);
				expect(rowsOf(folded)[0]).toBe(mode);
			},
			{ hold: true, axis: "none" },
		);
	});

	test("each header and the air above the next Group cost a window row", async () => {
		await bootGrouped(
			async (setup) => {
				const flat = await settle(setup);
				// The flat list fills the pane with tickets alone: no header, no air.
				expect(ticketRows(flat)).toHaveLength(5);
				expect(airRows(flat).some((row) => row === "")).toBe(false);
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const frame = await settle(setup);
				// The same window now spends two rows on headers and one more on the
				// air that parts them, so three fewer tickets stand on screen (story 65).
				expect(headers(frame)).toHaveLength(2);
				expect(ticketRows(frame)).toHaveLength(3);
				await press(setup, "end", "the last row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Held turn"),
				);
				const slid = setup.captureCharFrame();
				// The window slid: the leading header left the pane.
				expect(listRows(slid)).not.toContain("▾ acme/billing 2");
				expect(listRows(slid).at(-1)).toContain("Held turn");
			},
			{ size: [WIDTH, 27], axis: "none" },
		);
	});

	test("one blank row parts each Group, and none stands above the first", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const frame = await settle(setup);
				// The list opens on its first header: the air belongs to the Group it
				// parts, so the first Group has none above it.
				expect(airRows(frame)[0]).toContain("▾ acme/billing");
				// One blank row, then the next Group's header, then its own rows.
				const factoryAt = airRows(frame).findIndex((row) => row.includes("▾ acme/factory"));
				expect(airRows(frame)[factoryAt - 1]).toBe("");
				expect(airRows(frame)[factoryAt - 2]).toContain("Unlabeled work");
				expect(airRows(frame)[factoryAt]).toContain("▾ acme/factory");
				// Exactly one blank stands between the two Groups, and none elsewhere.
				expect(airRows(frame).filter((row) => row === "")).toHaveLength(1);
			},
			{ axis: "none" },
		);
	});

	test("the cursor steps over the blank row and never rests on it", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				// The walk starts at the top of the list, the first Group's header.
				await press(setup, "home", "the first row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				// Down through the first Group's rows, one press per row.
				await pressArrow(setup, "down", "the second row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Legacy import"),
				);
				await pressArrow(setup, "down", "the Group's last row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Unlabeled work"),
				);
				// The next Down crosses the blank row and lands on the Group header
				// under it: one press still moves the cursor to the next row it can hold.
				const onHeader = await pressArrow(setup, "down", "the next Group's header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				expect(actionBarRowOf(onHeader)).toContain("Space Fold group");
				// The step back crosses the same air the other way.
				await pressArrow(setup, "up", "the row above the air", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Unlabeled work"),
				);
				// The list's last row is a ticket, so the edge lands on a word too.
				const end = await press(setup, "end", "the last row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Held turn"),
				);
				expect(markerRowOf(end)).toBeGreaterThan(0);
			},
			{ axis: "none" },
		);
	});

	test("a click on the blank row takes the Group it parts, and folds nothing", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const before = await settle(setup);
				const airRow = rowIndexOf(before, /▾ acme\/factory/) - 1;
				// The click aims at the air itself, not at a word the row might hold.
				expect(
					listHalfOf(rowsOf(before)[airRow] ?? "")
						.replace(/[│┌┐└┘─]/gu, " ")
						.trim(),
				).toBe("");
				await mouseClick(setup, 4, airRow);
				// The air holds no cursor, so the click takes the Group it parts.
				const landed = await awaitFrame(
					setup,
					(f) => (rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
					"the Group the air parts",
				);
				expect(actionBarRowOf(landed)).toContain("Space Fold group");
				// And the Group stays open: a click on air folds nothing.
				expect(headers(landed)).toContain("▾ acme/factory 3");
				expect(ticketRows(landed).some((row) => row.includes("Deploy gate"))).toBe(true);
			},
			{ axis: "none" },
		);
	});

	test("a frame of nothing but Group headers still reads its counts", async () => {
		await bootGrouped(
			async (setup) => {
				// The task axis makes three Groups, and the short window holds
				// three rows. Folding all three leaves the pane nothing but
				// headers, each with the count it hides (story 66).
				await pressTab(setup, "repository", (f) => /Group: repository/.test(actionBarRowOf(f)));
				await pressTab(setup, "source", (f) => /Group: source/.test(actionBarRowOf(f)));
				await pressTab(setup, "the task Groups", (f) => /Group: task/.test(actionBarRowOf(f)));
				for (const value of ["implement", "review", "parked"]) {
					const before = setup.captureCharFrame();
					await mouseClick(setup, 4, rowIndexOf(before, new RegExp(`▾ ${value}`)));
					await awaitFrame(setup, (f) => f.includes(`▸ ${value}`), `the ${value} fold`);
				}
				const frame = setup.captureCharFrame();
				expect(ticketRows(frame)).toEqual([]);
				expect(headers(frame)).toEqual(["▸ implement 3", "▸ parked 1", "▸ review 1"]);
			},
			{ size: [WIDTH, 27], axis: "none" },
		);
	});

	// The plane's minimum width is where a Group header's fixed cells spend the
	// whole budget: 40 columns leave the list pane 20 cells and its text area 16.
	// The marker column costs 4 of them and `  11  held 1` costs 12, so the value
	// is the field that must give up its last cell. A header that overflowed its
	// pane would wrap onto a second window row, split the held count across two
	// rows, and cost the window a ticket row, which works against ADR 0059
	// (user stories 65 and 66). The axis comes from the state file, so the frame
	// holds the split before any press can step past it.
	test("a Group header at the minimum width drops its value before it wraps", async () => {
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				// The factory Group owns the window's first row, and the billing
				// Group's header stands below the fold the window draws.
				const header = listPaneRows(frame).filter((row) => /[▾▸]/u.test(row));
				expect(header).toHaveLength(1);
				expect(header[0]).toContain("11  held 1");
				// The frame is the grid it booted on: no row pushed content into the
				// row under it.
				expect(rowsOf(frame).every((row) => widthOf(row) === 40)).toBe(true);
				// The header cost one window row, so its tickets still stand below it.
				expect(ticketRows(frame).length).toBeGreaterThan(1);
				// The case the counts exist for: folded, the header still carries
				// both counts whole, in its one row and with the fold on its glyph.
				const folded = await press(setup, "space", "the fold", (f) => paneHolds(f, /▸/u));
				const foldedHeader = listPaneRows(folded).filter((row) => row.includes("▸"));
				expect(foldedHeader).toHaveLength(1);
				expect(foldedHeader[0]).toContain("11  held 1");
				expect(rowsOf(folded).every((row) => widthOf(row) === 40)).toBe(true);
			},
			{ size: [40, 27], hold: true, list: crowdFirst(8), axis: "repository" },
		);
	});

	/**
	 * A count so wide the header cannot pay for the value and both counts.
	 *
	 * The same budget, one rung further: `  101  held 1` costs 13 cells against
	 * the 12 the marker column leaves. The rule the pane states for its ticket
	 * rows, a field is dropped and never wrapped, then takes the ticket count off
	 * the line and keeps the held count, because the held count is the fact the
	 * fold owes (ADR 0059).
	 */
	test("a Group header too narrow for both counts keeps the held count", async () => {
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				const header = listPaneRows(frame).filter((row) => /[▾▸]/u.test(row));
				expect(header).toHaveLength(1);
				expect(header[0]).toContain("held 1");
				expect(header[0]).not.toContain("101");
				expect(rowsOf(frame).every((row) => widthOf(row) === 40)).toBe(true);
				// The value word takes the cells the dropped count left, cut to its
				// tail: the header still names its Group, and the held count still
				// stands beside it in the same row.
				expect(header[0]).toContain("…ory");
			},
			{ size: [40, 27], hold: true, list: crowdFirst(98), axis: "repository" },
		);
	});

	test("an empty grouped list names the axis in its message", async () => {
		const state = openFactoryState(stateFile());
		opened.push(state);
		// The fresh file boots grouped by repository (ADR 0066): the press the
		// test makes must start from the flat list to land on the repository
		// split it checks.
		state.grouping.setGroupingAxis("tickets", "none");
		const issues = new FakeSource("issues", "github-issues", success([]));
		const triage = new FakeSource("triage", "github-issues", success([]));
		await withApp(
			async (setup) => {
				issues.settle(success([]));
				triage.settle(success([]));
				await awaitFrame(setup, (f) => f.includes("no tickets"), "the empty list");
				const frame = await pressTab(setup, "the repository axis", (f) =>
					/Group: repository/.test(actionBarRowOf(f)),
				);
				// The empty pane names the axis the operator is reading, in the
				// one row the list holds (story 9).
				expect(frameText(frame)).toContain(
					"no tickets match the configured sources - grouped by repository",
				);
			},
			160,
			34,
			{ state, config: groupConfig, home, runner: emptyAgentRunner(), sources: [issues, triage] },
		);
	});

	test("the axis survives a restart on the same state file, and the folds do not", async () => {
		// Seed the flat list, the way a pre-ADR 0066 file did, so the press
		// writes the axis the restart must find.
		const first = groupedState(false, tickets(), "none");
		opened.push(first.state);
		await withApp(
			async (setup) => {
				first.sources[0].settle(success(tickets()));
				first.sources[1].settle(success(triageListing()));
				await awaitFrame(setup, (f) => f.includes("❯ Tickets"), "the ticket list");
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await pressArrow(setup, "up", "the header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				await press(setup, "space", "the fold", (f) => /▸ acme\/factory/.test(f));
			},
			WIDTH,
			34,
			{
				state: first.state,
				config: groupConfig,
				home,
				runner: emptyAgentRunner(),
				sources: first.sources,
			},
		);
		expect(first.state.grouping.groupingAxis("tickets")).toBe("repository");
		first.state.close();
		opened.splice(opened.indexOf(first.state), 1);

		// A second boot on the same file: the axis stands where the operator
		// left it (story 49), and every Group is open again (story 53).
		const second = openFactoryState(stateFile());
		opened.push(second);
		expect(second.grouping.groupingAxis("tickets")).toBe("repository");
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				expect(headers(frame)).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
				expect(frame).not.toContain("▸ acme/billing");
			},
			{ state: second },
		);
	});

	test("a state file that will not take the write reports it, and the view changes", async () => {
		// Seed the flat list, so the press's repository split is the one the
		// refused write would have stored.
		const fixture = groupedState(false, tickets(), "none");
		opened.push(fixture.state);
		const refusing = fixture.state.grouping as unknown as { setGroupingAxis: () => void };
		refusing.setGroupingAxis = () => {
			throw new Error("read-only file system");
		};
		await withApp(
			async (setup) => {
				fixture.sources[0].settle(success(tickets()));
				fixture.sources[1].settle(success(triageListing()));
				await awaitFrame(setup, (f) => f.includes("❯ Tickets"), "the ticket list");
				const told = await pressTab(setup, "the refused write", (f) =>
					messageRowOf(f).includes("the grouping axis did not save"),
				);
				expect(messageRowOf(told)).toContain("read-only file system");
				// The view still moved: the headers stand for this run.
				expect(headers(told)).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
			},
			WIDTH,
			34,
			{
				state: fixture.state,
				config: groupConfig,
				home,
				runner: emptyAgentRunner(),
				sources: fixture.sources,
			},
		);
	});

	test("a plane with no state file keeps the axis for the run", async () => {
		await withApp(
			async (setup) => {
				// A plane with no state file holds no stored row, so it starts
				// flat, the way a file with no row reads (ADR 0058): the press
				// is the operator's own, and its choice keeps for the run with
				// nothing written. The window is tall enough for the whole split,
				// air included, so the first Group's header is on screen.
				const grouped = await pressTab(setup, "the repository axis", (f) =>
					messageRowOf(f).includes("grouped by repository"),
				);
				expect(grouped).toContain("▾ acme/portal");
				expect(headers(grouped).length).toBeGreaterThan(1);
			},
			WIDTH,
			40,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	// Story 29 and ADR 0059: the plane stops reading a feed the operator
	// deleted, its open tickets leave the list, and its in-flight tickets stay
	// with the source fact they were listed on. The Group for a Removed source
	// therefore stands while that work does.
	test("a Removed source keeps its Group while its in-flight ticket does", async () => {
		const state = openFactoryState(stateFile());
		opened.push(state);
		state.sourceFact.initializeSources([ISSUES, TRIAGE]);
		state.sourceFact.applyFetch(
			ISSUES,
			success([issue(1, "Webhook retry", FACTORY, ["ready-for-agent"])]),
		);
		state.sourceFact.applyFetch(
			TRIAGE,
			success([issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")]),
		);
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_2",
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "review",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		// The operator deletes the feed from the Config file: the plane stops
		// reading it, and the membership turns Removed on the state.
		state.sourceFact.initializeSources([ISSUES]);

		const issues = new FakeSource("issues", "github-issues", success([]));
		await withApp(
			async (setup) => {
				issues.settle(success([issue(1, "Webhook retry", FACTORY, ["ready-for-agent"])]));
				await awaitFrame(setup, (f) => f.includes("❯ Tickets"), "the ticket list");
				await pressTab(setup, "the source axis", (f) =>
					messageRowOf(f).includes("grouped by source"),
				);
				const frame = setup.captureCharFrame();
				// The in-flight ticket stands under its Removed feed's header,
				// and the healthy feed holds its own run.
				expect(headers(frame)).toEqual(["▾ issues 1", "▾ triage 1"]);
				expect(listRows(frame).some((row) => row.includes("Deploy gate"))).toBe(true);
			},
			WIDTH,
			34,
			{
				state,
				config: { ...groupConfig, sources: [groupConfig.sources[0]] },
				home,
				runner: emptyAgentRunner(),
				sources: [issues],
			},
		);
	});

	test("a fold never opens itself, and a gone value leaves no ghost header", async () => {
		await bootGrouped(
			async (setup, fixture) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				// Fold the billing run.
				await mouseClick(setup, 4, rowIndexOf(setup.captureCharFrame(), /▾ acme\/billing/));
				await awaitFrame(setup, (f) => f.includes("▸ acme/billing"), "the fold");
				// A refresh brings a healthy ticket into the folded Group: the fold
				// the operator made stays shut, and the header's count follows the
				// rows behind it (story 35).
				await refreshWith(setup, fixture, [
					[
						issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z"),
						issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
						issue(1, "Webhook retry", BILLING, ["ready-for-agent"]),
						issue(3, "Legacy import", BILLING, ["hold"]),
						issue(4, "Unlabeled work", BILLING, []),
					],
					[issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")],
				]);
				const moved = await awaitFrame(
					setup,
					(f) => headers(f).some((row) => row.startsWith("▸ acme/billing 3")),
					"the folded Group's new count",
				);
				// The Groups stand by their lowest ticket number in the open band
				// (ADR 0065): the billing run now holds #1, so it leads.
				expect(headers(moved)).toEqual(["▸ acme/billing 3", "▾ acme/factory 2"]);

				// The last billing ticket leaves the list, and its header leaves with
				// it: a stale fold costs nothing (story 64).
				await refreshWith(setup, fixture, [
					[
						issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z"),
						issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
					],
					[issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")],
				]);
				await awaitFrame(setup, (f) => headers(f).length === 1, "the gone value");
				expect(headers(setup.captureCharFrame())).toEqual(["▾ acme/factory 2"]);
			},
			{ axis: "none" },
		);
	});

	// A collapsed Ticket section draws no Group header, so `x` keeps the
	// Section toggle there, `Space` has no header to answer, and the Ticket
	// controls keep working on the ticket the detail pane shows (issue #159,
	// issue #170).
	test("a collapsed Ticket section keeps x the Section toggle", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				// The cursor stands on a Group header: the fold owns `Space` there.
				await press(setup, "home", "the first row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("Space Fold group");
				await press(setup, "space", "the fold", (f) => /▸ acme\/billing/.test(f));
				// Step down onto a ticket row, then collapse the Section: its headers
				// leave the frame, so `x` expands the Section back rather than
				// folding a header nobody can see.
				await pressArrow(setup, "down", "the next header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/factory"),
				);
				await pressArrow(setup, "down", "a ticket row", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("Webhook retry"),
				);
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("x Section");
				await press(setup, "x", "the Section collapse", (f) => /▸ Tickets/.test(f));
				const collapsed = await settle(setup);
				expect(actionBarRowOf(collapsed)).toContain("x Section");
				expect(actionBarRowOf(collapsed)).not.toContain("Fold group");
				// With no header on screen `Space` refuses in the catalogue's
				// words and moves nothing (issue #170).
				setup.mockInput.pressKey(" ");
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).includes("no Group header is under the cursor"),
					"the Space refusal in the collapsed section",
				);
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("x Section");
				// The Ticket controls keep working on the ticket the pane shows: the
				// one the cursor stood on when the Section closed.
				expect(detailPaneText(collapsed)).toContain("Webhook retry");
				expect(actionBarRowOf(collapsed)).toContain("Enter Hand off");
				await press(setup, "x", "the Section back", (f) => /▾ Tickets/.test(f));
				expect(headers(setup.captureCharFrame())).toContain("▸ acme/billing 2");
			},
			{ axis: "none" },
		);
	});

	// Story 54 and ADR 0058: the folds are the run's, keyed by the axis as well
	// as the value, so an axis the operator visits twice comes back as it was
	// left, and a fold on one axis never shuts a Group of another.
	test("an axis visited twice comes back with its own folds", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await mouseClick(setup, 4, rowIndexOf(setup.captureCharFrame(), /▾ acme\/billing/));
				await awaitFrame(setup, (f) => f.includes("▸ acme/billing"), "the fold");
				// Leave grouping and return: the fold the operator made stands.
				await pressTab(setup, "off grouping", (f) => headers(f).length === 0);
				await pressTab(setup, "back to repository", (f) => headers(f).length === 2);
				expect(headers(setup.captureCharFrame())).toEqual(["▸ acme/billing 2", "▾ acme/factory 3"]);
				// A fold made on another axis is that axis's own: the state axis,
				// reached by one more press, starts with every Group open.
				await pressTab(setup, "source", (f) => /Group: source/.test(actionBarRowOf(f)));
				await pressTab(setup, "task", (f) => /Group: task/.test(actionBarRowOf(f)));
				expect(headers(setup.captureCharFrame()).every((row) => row.startsWith("▾"))).toBe(true);
			},
			{ axis: "none" },
		);
	});

	// Story 43: a ticket that leaves the list moves the cursor to the row
	// nearest the one it held, the way a refresh already did - and the rows
	// behind a fold count for that rule only while the fold is open.
	test("a ticket that leaves the list leaves the cursor on the nearest row", async () => {
		await bootGrouped(
			async (setup, fixture) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				// The cursor takes the row the ticket holds, the billing Group's first.
				await mouseClick(setup, 4, rowIndexOf(setup.captureCharFrame(), /Legacy import/));
				await awaitFrame(
					setup,
					(f) => (rowsOf(f)[markerRowOf(f)] ?? "").includes("Legacy import"),
					"the row the ticket holds",
				);
				await refreshWith(setup, fixture, [
					[
						issue(1, "Webhook retry", FACTORY, ["ready-for-agent"]),
						issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z"),
						issue(4, "Unlabeled work", BILLING, []),
						issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
					],
					[issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")],
				]);
				const after = await awaitFrame(
					setup,
					(f) => !ticketRows(f).some((row) => row.includes("Legacy import")),
					"the re-read list",
				);
				// The cursor took the row nearest the one it held: the billing
				// Group's remaining ticket, the one row below it.
				expect(rowsOf(after)[markerRowOf(after)]).toContain("Unlabeled work");
			},
			{ axis: "none" },
		);
	});

	// Story 67: grouping is the operator's view, not the frame's: a resize
	// keeps the axis and every fold where they stand.
	test("a resize keeps the axis and the folds", async () => {
		await bootGrouped(
			async (setup) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				await mouseClick(setup, 4, rowIndexOf(setup.captureCharFrame(), /▾ acme\/factory/));
				await awaitFrame(setup, (f) => f.includes("▸ acme/factory"), "the fold");
				setup.resize(96, 30);
				const narrow = await settle(setup);
				setup.resize(WIDTH, 34);
				const wide = await settle(setup);
				expect(headers(narrow)).toEqual(["▾ acme/billing 2", "▸ acme/factory 3"]);
				expect(headers(wide)).toEqual(["▾ acme/billing 2", "▸ acme/factory 3"]);
				expect(messageRowOf(wide)).toContain("grouped by repository");
			},
			{ axis: "none" },
		);
	});

	test("a press in a collapsed Ticket section still records the axis", async () => {
		await bootGrouped(
			async (setup) => {
				await press(setup, "x", "the Section collapse", (f) => /▸ Tickets/.test(f));
				const frame = await pressTab(setup, "the axis", (f) =>
					messageRowOf(f).includes("grouped by repository"),
				);
				expect(actionBarRowOf(frame)).toContain("Tab Group: repository");
				await press(setup, "x", "the Section back", (f) => /▾ Tickets/.test(f));
				expect(headers(setup.captureCharFrame()).length).toBe(2);
			},
			{ axis: "none" },
		);
	});

	// The operator's complaint this fix answers: the Groups jumped between
	// refreshes because they stood by the attention band and the second rank
	// of the tickets they held, and both are facts the refresh changes. A
	// Group's slot moves only on a press of the operator's own (ADR 0071).
	test("a Group's slot does not move when the tickets' facts change", async () => {
		await bootGrouped(
			async (setup, fixture) => {
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				const before = groupOrderWords(setup.captureCharFrame());
				// The refresh moves ticket #1 into acme/billing: the membership and
				// every attention fact the old order read all change at once.
				await refreshWith(setup, fixture, [
					[
						issue(1, "Webhook retry", BILLING, ["ready-for-agent"]),
						issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z"),
						issue(3, "Legacy import", BILLING, ["hold"]),
						issue(4, "Unlabeled work", BILLING, []),
						issue(5, "Held turn", FACTORY, ["ready-for-agent"]),
					],
					[issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")],
				]);
				const frame = await awaitFrame(
					setup,
					(f) => headers(f).some((row) => row.includes("acme/billing 3")),
					"the refreshed Groups",
				);
				expect(groupOrderWords(frame)).toEqual(before);
			},
			{ axis: "none" },
		);
	});

	// The `position` axis drifts the same way on a label change: the ticket
	// moves between positions, and the old order followed the ticket's number
	// rather than the Workflow's own order of its positions.
	test("the position axis keeps the Workflow's own order of its positions", async () => {
		// The on-hold run holds the smallest ticket number, so the order the old
		// rule read by the tickets' facts puts it first, and the Workflow's own
		// order of its positions puts it third (ADR 0071).
		const drifted = [
			issue(1, "Webhook retry", BILLING, ["hold"]),
			issue(2, "Deploy gate", FACTORY, ["needs-review"]),
			issue(3, "Legacy import", BILLING, ["ready-for-agent"]),
			issue(4, "Unlabeled work", BILLING, []),
		];
		await bootGrouped(
			async (setup, fixture) => {
				for (const word of ["repository", "source", "task", "state"] as const) {
					await pressTab(setup, word, (f) => new RegExp(`Group: ${word}`).test(actionBarRowOf(f)));
				}
				const frame = await pressTab(setup, "the position axis", (f) =>
					/Group: position/.test(actionBarRowOf(f)),
				);
				// The runs stand in the config's [[states]] order with `unmatched`
				// last, whatever ticket number any run holds (ADR 0071).
				expect(groupOrderWords(frame)).toEqual([
					"ready-for-agent",
					"awaiting-review",
					"on-hold",
					"unmatched",
				]);
				// A label change moves ticket #1 into the ready-for-agent position
				// and the unlabeled work leaves the feed: the surviving runs keep
				// their slots.
				await refreshWith(setup, fixture, [
					[
						issue(1, "Webhook retry", BILLING, ["ready-for-agent"]),
						issue(2, "Deploy gate", FACTORY, ["needs-review"]),
						issue(3, "Legacy import", BILLING, ["ready-for-agent"]),
					],
					[issue(2, "Deploy gate", FACTORY, ["needs-review"], "2026-09-02T09:00:00Z")],
				]);
				const moved = await awaitFrame(
					setup,
					(f) => headers(f).some((row) => row.includes("ready-for-agent 2")),
					"the refreshed positions",
				);
				expect(groupOrderWords(moved)).toEqual(["ready-for-agent", "awaiting-review"]);
			},
			{ axis: "none", list: drifted },
		);
	});
});

/** The Group values in one frame's list, top to bottom: the operator's read of the order. */
function groupOrderWords(frame: string): string[] {
	return headers(frame).map((row) =>
		row
			.replace(/^▾ /u, "")
			.replace(/^▸ /u, "")
			.replace(/\s\d+.*$/u, ""),
	);
}

/** Focus the Ticket detail, where the same keys answer from the other pane. */
async function focusDetailRow(setup: AppSetup): Promise<void> {
	await pressArrow(setup, "right", "the detail pane", (f) => f.includes("❯ Detail"));
	await sleep(20);
}

/** The frame row index of the first row whose text matches, or -1. */
function rowIndexOf(frame: string, needle: RegExp): number {
	return rowsOf(frame).findIndex((row) => needle.test(row));
}

/**
 * The frame row index of the first Ticket list row whose own half matches.
 *
 * `rowIndexOf` reads whole terminal rows, and the Detail pane beside the list
 * carries the selected ticket's title on its own rows: a click aimed at a list
 * row can land on the pane's row instead. This read keeps the list's half.
 */
function listRowFrameIndex(frame: string, needle: RegExp): number {
	const rows = rowsOf(frame);
	const top = rows.findIndex((row) => /─\s*(❯\s+)?Tickets─/.test(row));
	if (top < 0) return -1;
	for (let index = top + 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (row === undefined) break;
		if (row.startsWith("└")) return -1;
		if (needle.test(listHalfOf(row).replace(/[│┌┐└┘─]/g, " "))) return index;
	}
	return -1;
}

/**
 * The operator's order of the Groups (ADR 0071), through the real app flow:
 * the move a press makes, the refusal an edge answers with, the order a
 * restart reads back, and the slot a Group the filter hides keeps.
 */
describe("the operator's Group order (ADR 0071)", () => {
	test("a Group under the cursor moves to its visible neighbor, and the cursor stays on it", async () => {
		await bootGrouped(
			async (setup) => {
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				// Up on the first Group is an edge: no move, and the Message line
				// says so in the queue's own words.
				const first = await press(setup, "+", "the edge refusal", (f) =>
					messageRowOf(f).includes("the group is first in the list"),
				);
				expect(groupOrderWords(first)).toEqual(["acme/billing", "acme/factory"]);
				// Down trades the two Groups, and the cursor lands on the Group
				// the move ran on, ready for the next press.
				await press(
					setup,
					"-",
					"the move down",
					(f) => groupOrderWords(f).join() === "acme/factory,acme/billing",
				);
				const moved = setup.captureCharFrame();
				expect(groupOrderWords(moved)).toEqual(["acme/factory", "acme/billing"]);
				expect(rowsOf(moved)[markerRowOf(moved)]).toContain("▾ acme/billing");
				// `=` is the unshifted `+`: the same move up, the same words, the
				// cursor still on the Group it moved.
				await press(
					setup,
					"=",
					"the move by the unshifted plus",
					(f) => groupOrderWords(f).join() === "acme/billing,acme/factory",
				);
				const shifted = setup.captureCharFrame();
				expect(rowsOf(shifted)[markerRowOf(shifted)]).toContain("▾ acme/billing");
			},
			{ axis: "repository" },
		);
	});

	test("at the edge of the list the press runs no move, and the Message line says so", async () => {
		await bootGrouped(
			async (setup) => {
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				const first = await press(setup, "+", "the edge refusal", (f) =>
					messageRowOf(f).includes("the group is first in the list"),
				);
				expect(groupOrderWords(first)).toEqual(["acme/billing", "acme/factory"]);
				// Down runs the one move the list holds, and lands on the
				// Group now at the other edge.
				await press(
					setup,
					"-",
					"the move down",
					(f) => groupOrderWords(f).join() === "acme/factory,acme/billing",
				);
				const last = await press(setup, "-", "the edge refusal", (f) =>
					messageRowOf(f).includes("the group is last in the list"),
				);
				expect(groupOrderWords(last)).toEqual(["acme/factory", "acme/billing"]);
			},
			{ axis: "repository" },
		);
	});

	test("each axis keeps its own order", async () => {
		await bootGrouped(
			async (setup) => {
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				await press(
					setup,
					"-",
					"the repository move",
					(f) => groupOrderWords(f).join() === "acme/factory,acme/billing",
				);
				// The cycle on to the task axis: its Groups stand in the
				// default order the axis names, unmarked by the repository move.
				await pressTab(setup, "the source axis", (f) => /Group: source/.test(actionBarRowOf(f)));
				await pressTab(setup, "the task axis", (f) => /Group: task/.test(actionBarRowOf(f)));
				expect(groupOrderWords(setup.captureCharFrame())).toEqual([
					"implement",
					"parked",
					"review",
				]);
				// The task axis takes its own move.
				await press(setup, "home", "the task's first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("implement"),
				);
				await press(
					setup,
					"-",
					"the task move",
					(f) => groupOrderWords(f).join() === "parked,implement,review",
				);
				// The cycle back to the repository: its order stands as the
				// operator left it.
				await pressTab(setup, "the state axis", (f) =>
					messageRowOf(f).includes("grouped by state"),
				);
				await pressTab(setup, "the position axis", (f) =>
					messageRowOf(f).includes("grouped by position"),
				);
				await pressTab(setup, "the flat list", (f) => messageRowOf(f).includes("grouping off"));
				await pressTab(setup, "the repository Groups", (f) => headers(f).length === 2);
				expect(groupOrderWords(setup.captureCharFrame())).toEqual(["acme/factory", "acme/billing"]);
			},
			{ axis: "repository" },
		);
	});

	test("the move stands after a restart on the same state file", async () => {
		const first = groupedState(false, tickets(), "repository");
		opened.push(first.state);
		await withApp(
			async (setup) => {
				first.sources[0].settle(success(tickets()));
				first.sources[1].settle(success(triageListing()));
				await awaitFrame(setup, (f) => f.includes("❯ Tickets"), "the ticket list");
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				await press(
					setup,
					"-",
					"the move",
					(f) => groupOrderWords(f).join() === "acme/factory,acme/billing",
				);
				expect(first.state.grouping.groupOrder("tickets", "repository")).toEqual([
					"acme/factory",
					"acme/billing",
				]);
			},
			WIDTH,
			34,
			{
				state: first.state,
				config: groupConfig,
				home,
				runner: emptyAgentRunner(),
				sources: first.sources,
			},
		);
		first.state.close();
		opened.splice(opened.indexOf(first.state), 1);

		const second = openFactoryState(stateFile());
		opened.push(second);
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				expect(groupOrderWords(frame)).toEqual(["acme/factory", "acme/billing"]);
			},
			{ state: second },
		);
	});

	test("a state file that will not take the move reports it, and the view changes", async () => {
		const fixture = groupedState(false, tickets(), "repository");
		opened.push(fixture.state);
		const refusing = fixture.state.grouping as unknown as { setGroupOrder: () => void };
		refusing.setGroupOrder = () => {
			throw new Error("read-only file system");
		};
		await withApp(
			async (setup) => {
				fixture.sources[0].settle(success(tickets()));
				fixture.sources[1].settle(success(triageListing()));
				await awaitFrame(setup, (f) => f.includes("❯ Tickets"), "the ticket list");
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				const told = await press(setup, "-", "the refused move", (f) =>
					messageRowOf(f).includes("the group order did not save"),
				);
				expect(messageRowOf(told)).toContain("read-only file system");
				// The view still moved: the order stands for this run.
				expect(groupOrderWords(told)).toEqual(["acme/factory", "acme/billing"]);
			},
			WIDTH,
			34,
			{
				state: fixture.state,
				config: groupConfig,
				home,
				runner: emptyAgentRunner(),
				sources: fixture.sources,
			},
		);
	});

	test("a plane with no state file keeps the move for the run", async () => {
		await withApp(
			async (setup) => {
				await pressTab(setup, "the repository axis", (f) =>
					messageRowOf(f).includes("grouped by repository"),
				);
				const words = groupOrderWords(setup.captureCharFrame());
				expect(words.length).toBeGreaterThan(1);
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes(words[0]),
				);
				await press(setup, "-", "the move", (f) => groupOrderWords(f)[0] === words[1]);
				// The cycle back to the split: the order the press wrote stands,
				// with nothing to have written it.
				for (let step = 0; step < 5; step += 1) {
					await pressTab(setup, "the cycle on", (f) => f.includes("❯ Tickets"));
				}
				await pressTab(setup, "the repository axis again", (f) =>
					messageRowOf(f).includes("grouped by repository"),
				);
				expect(groupOrderWords(setup.captureCharFrame())[0]).toBe(words[1]);
			},
			WIDTH,
			40,
			{
				config: BASE_CONFIG,
				runner: emptyAgentRunner(),
				initialTickets: SAMPLE_TICKETS,
			},
		);
	});

	test("a Group the filter hides keeps its slot in the order", async () => {
		await bootGrouped(
			async (setup) => {
				await press(setup, "home", "the first header", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("▾ acme/billing"),
				);
				await press(
					setup,
					"-",
					"the move",
					(f) => groupOrderWords(f).join() === "acme/factory,acme/billing",
				);
				// Every ticket the billing Group holds goes ignored: the rows
				// leave the active view, and the Group leaves with them.
				await mouseClick(setup, 4, listRowFrameIndex(setup.captureCharFrame(), /Legacy import/));
				// The row leaves the active view: the header's count drops to one.
				await press(setup, "i", "the ignore", (f) => /▾ acme\/billing\s+1/.test(f));
				await mouseClick(setup, 4, listRowFrameIndex(setup.captureCharFrame(), /Unlabeled work/));
				const hidden = await press(setup, "i", "the ignore", (f) => headers(f).length === 1);
				expect(groupOrderWords(hidden)).toEqual(["acme/factory"]);
				// The filter back through `all` - past the muted view, the
				// cycle's new rung (ADR 0070) - and the Group stands in the slot
				// the move wrote, with its rows back.
				await press(
					setup,
					"f",
					"the ignored view",
					(f) => headers(f).length === 1 && f.includes("▾ acme/billing"),
				);
				await press(setup, "f", "the muted view", (f) => headers(f).length === 0);
				const all = await press(setup, "f", "the whole list", (f) => headers(f).length === 2);
				expect(groupOrderWords(all)).toEqual(["acme/factory", "acme/billing"]);
			},
			{ axis: "repository" },
		);
	});
});

/**
 * The init marker and the one-time note, through the real app flow (ADR 0075).
 *
 * A repository the operator has not initialized wears `uninit` on its Group
 * header under the repository axis, and a repository whose settings changed
 * since its fact wears `drift`. At first sight of one, the Message line says
 * so once. The grouping's own tests stand their repositories initialized and
 * keep these two behaviors out of their frames; these tests boot them
 * uninitialized and read exactly what the operator must see.
 */
describe("the init marker and the one-time note (ADR 0075)", () => {
	test("an uninitialized repository wears uninit on its header, and the note stands once", async () => {
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				// Both repositories stand uninitialized, so both headers wear the
				// marker, after the count the header always keeps.
				expect(headers(frame).sort()).toEqual([
					"▾ acme/billing 2 uninit",
					"▾ acme/factory 3 uninit",
				]);
				// The one-time note names every repository that stands uninit, in
				// the order the list names them, on the Message line.
				const message = messageRowOf(frame);
				expect(message).toContain("Not initialized:");
				expect(message).toContain("acme/factory (uninit)");
				expect(message).toContain("acme/billing (uninit)");
				expect(message).toContain("Press i on one of their Group headers");
			},
			{ axis: "repository", uninit: true },
		);
	});

	test("an initialized repository wears no marker, and a drifted one wears drift", async () => {
		const state = openFactoryState(stateFile());
		state.sourceFact.initializeSources([ISSUES, TRIAGE]);
		state.grouping.setGroupingAxis("tickets", "repository");
		state.sourceFact.applyFetch(ISSUES, success(tickets()));
		state.sourceFact.applyFetch(TRIAGE, success(triageListing()));
		const hash = repositoryInitSettingsHash(groupConfig.workflowStates, groupConfig.taskTypes);
		// billing stands initialized at the current settings: no marker.
		state.repositoryInit.setRepositoryInitFact(`github.com/${BILLING}`, hash, "init-commit");
		// factory stands initialized at a changed settings: the drift.
		state.repositoryInit.setRepositoryInitFact(
			`github.com/${FACTORY}`,
			"a-different-hash",
			"init-commit",
		);
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				expect(headers(frame).sort()).toEqual(["▾ acme/billing 2", "▾ acme/factory 3 drift"]);
				// The note names only the drifted repository, never the one that
				// stands initialized.
				const message = messageRowOf(frame);
				expect(message).toContain("acme/factory (drift)");
				expect(message).not.toContain("acme/billing");
			},
			{ state },
		);
	});

	test("every repository stands initialized, so no note stands at first sight", async () => {
		const state = openFactoryState(stateFile());
		state.sourceFact.initializeSources([ISSUES, TRIAGE]);
		state.grouping.setGroupingAxis("tickets", "repository");
		state.sourceFact.applyFetch(ISSUES, success(tickets()));
		state.sourceFact.applyFetch(TRIAGE, success(triageListing()));
		const hash = repositoryInitSettingsHash(groupConfig.workflowStates, groupConfig.taskTypes);
		state.repositoryInit.setRepositoryInitFact(`github.com/${BILLING}`, hash, "init-commit");
		state.repositoryInit.setRepositoryInitFact(`github.com/${FACTORY}`, hash, "init-commit");
		await bootGrouped(
			async (setup) => {
				const frame = await settle(setup);
				// Neither repository stands uninit or in drift: no marker, no note.
				expect(headers(frame).sort()).toEqual(["▾ acme/billing 2", "▾ acme/factory 3"]);
				expect(messageRowOf(frame)).not.toContain("Not initialized:");
			},
			{ state },
		);
	});
});
