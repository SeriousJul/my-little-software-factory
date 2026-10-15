/**
 * The Task row's placement note (ADR 0045), through the real application flow.
 *
 * The panel the operator opens on a ticket wears the placement each offered
 * task type takes on that ticket: the feasible answer names the state the
 * ticket stands on after the write, the infeasible answer wears the warning
 * tone with the reason the confirm would refuse with, and the answer the
 * ticket's own suggestion gives stands plain. The evaluations the panel wears
 * are data the control plane computes, so the frame tests read the frame the
 * full app paints: a seeded ticket, the real machine, the panel opened on the
 * ticket, the row the operator selects.
 */
import { describe, expect, test } from "bun:test";

import { controlInk } from "../src/components/shared/presentation.ts";
import type { TicketSourceConfig, WorkflowState } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	frameText,
	pressControl,
	rgb,
	spanColors,
	WIDTH,
	waitSourceHealthy,
	withApp,
} from "./app-harness.ts";
import { fetchedTicket, ticketOf } from "./fact-fixtures.ts";
import type { FakeSource } from "./fake-source.ts";
import { type Plane, plane } from "./plane.ts";
import "./theme-isolation.ts";

const repoIdentity = "github.com/acme/factory";
const identity = "github:github.com:I_5";
const source: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

function fetched(): FetchedTicket {
	return fetchedTicket({ identity });
}

const success: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched()],
};

/**
 * A machine that offers review to an issue ticket: the ticket's suggestion is
 * implement on ready-for-agent, and the labels the placement writes move it
 * to ready-for-review.
 */
const issueMachine: WorkflowState[] = [
	{
		name: "ready-for-agent",
		taskType: "implement",
		match: { labelsAny: ["ready-for-agent"] },
	},
	{
		name: "ready-for-review",
		taskType: "review",
		match: { labelsAny: ["ready-for-review"] },
	},
];

interface Seeded {
	plane: Plane;
	src: FakeSource;
}

/** A seeded open ticket on the named machine, with the plane that matches it. */
async function seeded(machine: WorkflowState[] | null): Promise<Seeded> {
	// The frames assert the unsplit list: a fresh file opens grouped by
	// repository (ADR 0066), so the fixture holds the flat axis.
	const planeRecord = await plane({
		groupingAxis: "none",
		sources: [
			{
				config: source,
				tickets: [ticketOf(fetched())],
			},
		],
		repos: { [repoIdentity]: "checkout" },
		config: {
			...(machine === null ? {} : { workflowStates: machine }),
		},
	});
	return { plane: planeRecord, src: planeRecord.sources[0] as FakeSource };
}

/** The color one ink role paints in the ink the panel paints in. */
function tone(
	role: "warning" | "error" | "detail" | "text" | "focusedText" | "indicator",
): [number, number, number] {
	const foreground = controlInk()[role].fg;
	if (foreground === null) throw new Error(`the ink paints no ${role}`);
	return rgb(foreground);
}

describe("the Task row's placement note", () => {
	test("a task the ticket does not offer yet names the state the placement puts it on", async () => {
		const app = await seeded(issueMachine);
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await waitSourceHealthy(app.plane.state);
				await pressControl(setup, "override", { shows: "Override" });
				await pressControl(setup, "move-list", { via: "j", shows: "❯ Environment" });
				await pressControl(setup, "move-list", { via: "j", shows: "❯ Task type" });
				// The row opens on the ticket's suggestion, implement, and
				// cycles the full list: the operator reaches review in two
				// steps, and the note follows the selection.
				await pressControl(setup, "change-override", { via: "→", shows: "Task type fix" });
				const review = await pressControl(setup, "change-override", {
					via: "→",
					shows: "places the ticket on state ready-for-review",
				});
				expect(frameText(review)).toContain("places the ticket on state ready-for-review");
				// The note wears the detail tone, the same ink the panel's
				// other written facts wear.
				expect(spanColors(setup, "places the ticket on state ready-for-review")).toEqual([
					tone("detail"),
				]);
				// The feasible answer wears no warning: the value stands in
				// its plain tone, the note in the detail tone, and the word
				// the note writes carries no third, warning, paint.
				expect(spanColors(setup, "review")).toEqual([tone("focusedText"), tone("detail")]);
			},
			{
				width: WIDTH,
				height: 30,
				plane: app.plane,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
	});

	test("a task no state that matches the ticket offers wears the warning with the reason the confirm would refuse with", async () => {
		const app = await seeded(null);
		const reason =
			"task type review is not offered by any state that matches a github-issue ticket";
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await waitSourceHealthy(app.plane.state);
				await pressControl(setup, "override", { shows: "Override" });
				await pressControl(setup, "move-list", { via: "j", shows: "❯ Environment" });
				await pressControl(setup, "move-list", { via: "j", shows: "❯ Task type" });
				// The row opens on implement, the ticket's suggestion, and
				// cycles the full list: fix refuses on the first step, and the
				// wait stands on the review sentence itself.
				await pressControl(setup, "change-override", {
					via: "→",
					shows: "task type fix is not offered",
				});
				const review = await pressControl(setup, "change-override", {
					via: "→",
					shows: `Error: Task type: ${reason}`,
				});
				// The whole sentence stands, not a tone alone: a row that
				// carried its meaning on a tone alone would paint only the
				// first. The panel is wide enough to hold it.
				expect(frameText(review)).toContain(`Error: Task type: ${reason}`);
				expect(spanColors(setup, "not offered by any state")).toEqual([tone("error")]);
				// The value the row carries wears the warning tone beside
				// the reason it writes.
				expect(spanColors(setup, "review")).toEqual([tone("warning"), tone("error")]);
			},
			{ width: 220, height: 30, plane: app.plane, loopPolicy: { kind: "polled", intervalMs: 40 } },
		);
	});

	test("the task the ticket's suggestion offers stands plain, with no note and no warning", async () => {
		const app = await seeded(issueMachine);
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await waitSourceHealthy(app.plane.state);
				await pressControl(setup, "override", { shows: "Override" });
				await pressControl(setup, "move-list", { via: "j", shows: "❯ Environment" });
				const implement = await pressControl(setup, "move-list", {
					via: "j",
					shows: "❯ Task type",
				});
				// The panel opens on the ticket's suggestion: the row wears
				// no placement note, no infeasibility reason, and no warning
				// tone.
				expect(frameText(implement)).not.toContain("places the ticket on state");
				expect(frameText(implement)).not.toContain("Error: Task type:");
				expect(frameText(implement)).not.toContain("not offered by any state");
				expect(spanColors(setup, "implement")).toEqual([tone("focusedText")]);
			},
			{
				width: WIDTH,
				height: 30,
				plane: app.plane,
				loopPolicy: { kind: "polled", intervalMs: 40 },
			},
		);
	});
});
