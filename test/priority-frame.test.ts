/**
 * The Priority control frames (ADR 0022): the bump and clear keys driven
 * through the real app against a real temporary state, asserting only what
 * an operator can see - the Message line, the detail's Priority fact, and
 * the rank digit on the list row.
 *
 * The ticket carries a label that is not in the Priority list, so it rests
 * unranked and clearing returns it to `none`, not to a label rank.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";
import {
	awaitFrame,
	crossToConsultations,
	detailPaneText,
	frameText,
	HEIGHT,
	messageRowOf,
	press,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-priority-frame-"));
	paths.push(dir);
	return openFactoryState(join(dir, "state.sqlite"));
}

/** A source whose fetches stay in flight until the test settles them. */
class FakeSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs = 60_000;
	calls = 0;
	private resolvers: Array<() => void> = [];
	private next: FetchOutcome;

	constructor(name: string, kind: string, next: FetchOutcome) {
		this.name = name;
		this.kind = kind;
		this.next = next;
	}

	fetch(): Promise<FetchOutcome> {
		this.calls += 1;
		return new Promise<FetchOutcome>((resolve) => {
			this.resolvers.push(() => resolve(this.next));
		});
	}

	settle(outcome: FetchOutcome): void {
		this.next = outcome;
		for (const resolve of this.resolvers.splice(0)) resolve();
	}
}

function ticket(
	identity = "github:github.com:I_5",
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Add a webhook retry policy",
		description: "Webhooks dropped during the outage were never redelivered.",
		// Not in the Priority list: the ticket rests unranked.
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

const success = (tickets: FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets,
});

const RANKS = ["critical", "high", "low"];

const priorityConfig: FactoryConfig = {
	...BASE_CONFIG,
	priority: { labels: RANKS },
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
};

describe("the Priority bump and clear (ADR 0022)", () => {
	test("walks the rank up and down, with a no-op at each end, and clears to default", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					await awaitFrame(setup, (f) => f.includes("loading tickets..."), "the loading state");
					source.settle(success([ticket()]));
					const shown = await awaitFrame(
						setup,
						(f) => f.includes("Add a webhook retry policy"),
						"the ticket",
					);
					// Unranked to start: the detail reads none, the row has no digit.
					expect(detailPaneText(shown)).toContain("Priority: none");
					expect(frameText(shown)).not.toContain("[open] 1");

					// `=` from unranked takes the lowest rank.
					let frame = await press(setup, "=", "the first bump", (f) =>
						messageRowOf(f).includes("priority set to low"),
					);
					expect(detailPaneText(frame)).toContain("Priority: low (set by you)");
					expect(frameText(frame)).toContain("[open] 3");

					frame = await press(setup, "=", "the second bump", (f) =>
						messageRowOf(f).includes("priority raised to high"),
					);
					expect(detailPaneText(frame)).toContain("Priority: high (set by you)");
					expect(frameText(frame)).toContain("[open] 2");

					frame = await press(setup, "=", "the third bump", (f) =>
						messageRowOf(f).includes("priority raised to critical"),
					);
					expect(detailPaneText(frame)).toContain("Priority: critical (set by you)");
					expect(frameText(frame)).toContain("[open] 1");

					// `=` at the top is a no-op that states its reason.
					frame = await press(setup, "=", "the ceiling no-op", (f) =>
						messageRowOf(f).includes("already at the highest priority"),
					);
					expect(detailPaneText(frame)).toContain("Priority: critical (set by you)");

					frame = await press(setup, "-", "the first lower", (f) =>
						messageRowOf(f).includes("priority lowered to high"),
					);
					expect(detailPaneText(frame)).toContain("Priority: high (set by you)");

					frame = await press(setup, "-", "the second lower", (f) =>
						messageRowOf(f).includes("priority lowered to low"),
					);
					expect(detailPaneText(frame)).toContain("Priority: low (set by you)");

					// `-` from the lowest rank takes off.
					frame = await press(setup, "-", "off", (f) =>
						messageRowOf(f).includes("priority set to off"),
					);
					expect(detailPaneText(frame)).toContain("Priority: off (set by you)");

					// `-` at the floor is a no-op.
					frame = await press(setup, "-", "the floor no-op", (f) =>
						messageRowOf(f).includes("already unranked"),
					);
					expect(detailPaneText(frame)).toContain("Priority: off (set by you)");

					// Backspace gives the override its default back.
					frame = await press(setup, "backspace", "the clear", (f) =>
						messageRowOf(f).includes("priority cleared to default"),
					);
					expect(detailPaneText(frame)).toContain("Priority: none");
				},
				WIDTH,
				HEIGHT,
				{ config: priorityConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("is accepted from the detail pane the way it is from the list", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					await awaitFrame(setup, (f) => f.includes("loading tickets..."), "the loading state");
					source.settle(success([ticket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// Move the cursor to the detail pane, then bump from there.
					await press(setup, "l", "the detail to take focus", (f) => f.includes("❯ Detail"));
					const frame = await press(setup, "=", "the bump from the detail", (f) =>
						messageRowOf(f).includes("priority set to low"),
					);
					expect(detailPaneText(frame)).toContain("Priority: low (set by you)");
					await settle(setup);
				},
				WIDTH,
				HEIGHT,
				{ config: priorityConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("refuses in the Consultation section with the section reason", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([ticket()]));
		try {
			await withApp(
				async (setup) => {
					await awaitFrame(setup, (f) => f.includes("loading tickets..."), "the loading state");
					source.settle(success([ticket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					await crossToConsultations(setup);
					const refused = await press(setup, "=", "the refused bump", (f) =>
						messageRowOf(f).includes("this control is available only in the Ticket section"),
					);
					expect(refused).toContain("this control is available only in the Ticket section");
				},
				WIDTH,
				HEIGHT,
				{ config: priorityConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});
});
