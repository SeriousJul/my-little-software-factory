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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppProps } from "../src/components/app.ts";
import { controlInk } from "../src/components/shared/presentation.ts";
import type { FactoryConfig, WorkflowState } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	frameText,
	press,
	pressArrow,
	rgb,
	rowSelected,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import "./theme-isolation.ts";

const paths: string[] = [];
const openStates: FactoryState[] = [];
afterEach(() => {
	for (const state of openStates.splice(0)) state.close();
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const repoIdentity = "github.com/acme/factory";

function fetched(): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/5`,
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: `https://${repoIdentity}.git`,
		},
		attributes: {},
	};
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
	state: FactoryState;
	runner: FakeRunner;
	src: FakeSource;
	props: Partial<AppProps>;
}

/** A seeded open ticket on the named machine, with the app props that match it. */
function seeded(machine: WorkflowState[] | null): Seeded {
	const dir = mkdtempSync(join(tmpdir(), "factory-placement-panel-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	openStates.push(state);
	state.initializeSources([source]);
	state.applyFetch(source, success);
	const home = mkdtempSync(join(tmpdir(), "factory-placement-panel-home-"));
	paths.push(home);
	const repo = mkdtempSync(join(tmpdir(), "factory-placement-panel-repo-"));
	paths.push(repo);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config: FactoryConfig = {
		...BASE_CONFIG,
		repos: { [repoIdentity]: repo },
		...(machine === null ? {} : { workflowStates: machine }),
	};
	const runner = new FakeRunner();
	const src = new FakeSource("issues", "github-issues", success);
	return {
		state,
		runner,
		src,
		props: {
			config,
			state,
			runner,
			configPath,
			sources: [src],
			pollIntervalMs: 40,
		},
	};
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
		const app = seeded(issueMachine);
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await press(setup, "e", "the override panel", (f) => f.includes("Override"));
				await press(setup, "j", "the Environment row", (f) => rowSelected(f, "Environment"));
				await press(setup, "j", "the Task type row", (f) => rowSelected(f, "Task type"));
				// The row opens on the ticket's suggestion, implement, and
				// cycles the full list: the operator reaches review in two
				// steps, and the note follows the selection.
				await pressArrow(setup, "right", "the fix selection", (f) =>
					frameText(f).includes("Task type fix"),
				);
				const review = await pressArrow(setup, "right", "the review selection", (f) =>
					f.includes("places the ticket on state ready-for-review"),
				);
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
			WIDTH,
			30,
			app.props,
		);
	});

	test("a task no state that matches the ticket offers wears the warning with the reason the confirm would refuse with", async () => {
		const app = seeded(null);
		const reason =
			"task type review is not offered by any state that matches a github-issue ticket";
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await press(setup, "e", "the override panel", (f) => f.includes("Override"));
				await press(setup, "j", "the Environment row", (f) => rowSelected(f, "Environment"));
				await press(setup, "j", "the Task type row", (f) => rowSelected(f, "Task type"));
				// The row opens on implement, the ticket's suggestion, and
				// cycles the full list: fix refuses on the first step, and the
				// wait stands on the review sentence itself.
				await pressArrow(setup, "right", "the fix selection", (f) =>
					frameText(f).includes("task type fix is not offered"),
				);
				const review = await pressArrow(setup, "right", "the review selection", (f) =>
					f.includes(`Error: Task type: ${reason}`),
				);
				// The whole sentence stands, not a tone alone: a row that
				// carried its meaning on a tone alone would paint only the
				// first. The panel is wide enough to hold it.
				expect(frameText(review)).toContain(`Error: Task type: ${reason}`);
				expect(spanColors(setup, "not offered by any state")).toEqual([tone("error")]);
				// The value the row carries wears the warning tone beside
				// the reason it writes.
				expect(spanColors(setup, "review")).toEqual([tone("warning"), tone("error")]);
			},
			220,
			30,
			app.props,
		);
	});

	test("the task the ticket's suggestion offers stands plain, with no note and no warning", async () => {
		const app = seeded(issueMachine);
		await withApp(
			async (setup) => {
				// The source fetch the app opened on its mount is held by the fake
				// until the test settles it; the settle is what marks the source
				// healthy, and a healthy membership is what makes the ticket
				// actionable.
				app.src.settle(success);
				await press(setup, "e", "the override panel", (f) => f.includes("Override"));
				await press(setup, "j", "the Environment row", (f) => rowSelected(f, "Environment"));
				const implement = await press(setup, "j", "the Task type row", (f) =>
					rowSelected(f, "Task type"),
				);
				// The panel opens on the ticket's suggestion: the row wears
				// no placement note, no infeasibility reason, and no warning
				// tone.
				expect(frameText(implement)).not.toContain("places the ticket on state");
				expect(frameText(implement)).not.toContain("Error: Task type:");
				expect(frameText(implement)).not.toContain("not offered by any state");
				expect(spanColors(setup, "implement")).toEqual([tone("focusedText")]);
			},
			WIDTH,
			30,
			app.props,
		);
	});
});
