/**
 * The Consultation launcher on its own, apart from the app that mounts it.
 *
 * The app-flow tests cover what the operator walks through; these pin the
 * launcher's own contract at its interface: a Launch needs a type, a
 * Repository, and input the Agent can actually take, and the launcher states a
 * refusal rather than opening work the factory would reject.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import { ConsultationLauncher } from "../src/components/consultation-launcher.ts";
import type { ControlContext } from "../src/components/controls.ts";
import { awaitFrame, frameText } from "./app-harness.ts";

const types = {
	grill: { agent: "pi", environment: "worktree" as const, template: "/grill {input}" },
};
const repositories = [
	{
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
		path: "/tmp/factory",
	},
];

/** The base control facts the launcher is mounted over: the list, idle. */
const BASE_CONTEXT: ControlContext = {
	mode: "ticket-list",
	listCanMove: false,
	detailCanScroll: false,
	sourceCount: 1,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageTruncated: false,
	consultationTypesConfigured: true,
};

async function launcher(
	draft?: { typeName: string; repositoryIdentity: string; input: string } | null,
	repositoriesOverride?: typeof repositories,
) {
	const onLaunch = mock();
	const setup = await testRender(
		createElement(ConsultationLauncher, {
			types,
			repositories: repositoriesOverride ?? repositories,
			draft,
			context: BASE_CONTEXT,
			message: null,
			onCopy: () => undefined,
			onLaunch,
			onClose: () => undefined,
			onDiscard: () => undefined,
			onEmergencyExit: () => undefined,
		}),
		{ width: 100, height: 24 },
	);
	await setup.flush();
	return { setup, onLaunch };
}

/** Tab `count` slots forward and wait for the frame to name the new one. */
async function tabUntil(
	setup: Awaited<ReturnType<typeof testRender>>,
	count: number,
	what: string,
): Promise<string> {
	for (let step = 0; step < count; step += 1) setup.mockInput.pressTab();
	return awaitFrame(setup, (f) => frameText(f).includes(what), `the focus on ${what}`);
}

/** Tab from the Type choice to the Draft field, waiting for each move. */
async function focusDraft(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
	await tabUntil(setup, 1, "❯ Repository");
	await tabUntil(setup, 1, "❯ Initial input");
}

/** Run the Launch action: Tab from the Draft field to it, then Enter. */
async function pressLaunch(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
	await tabUntil(setup, 1, "❯ Launch Consultation");
	setup.mockInput.pressEnter();
	await setup.flush();
}

describe("Consultation launcher Repository choice", () => {
	test("a draft Repository identity with other casing still selects its option", async () => {
		// A record an older plane stored keeps the API's owner casing; the
		// catalog identity is canonical lowercase. The choice still finds the
		// option, and the launch sends it.
		const options = [
			{
				identity: "github.com/acme/billing",
				displayName: "acme/billing",
				cloneUrl: "https://github.com/acme/billing.git",
				path: "/tmp/billing",
			},
			{
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
				path: "/tmp/factory",
			},
		];
		const { setup, onLaunch } = await launcher(
			{
				typeName: "grill",
				repositoryIdentity: "github.com/Acme/Factory",
				input: "review the design",
			},
			options,
		);
		try {
			expect(frameText(setup.captureCharFrame())).toContain("Repository acme/factory");
			await focusDraft(setup);
			await pressLaunch(setup);
			expect(onLaunch).toHaveBeenCalledWith("grill", options[1], "review the design");
		} finally {
			await setup.renderer.destroy();
		}
	});
});

describe("Consultation launcher input", () => {
	test("collects a type, Repository, and initial input before it launches", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Type grill");
			expect(frame).toContain("Repository acme/factory");
			await focusDraft(setup);
			await setup.mockInput.typeText("review the design");
			await pressLaunch(setup);
			expect(onLaunch).toHaveBeenCalledWith("grill", repositories[0], "review the design");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("refuses empty initial input on the visible action, and launches nothing", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			await focusDraft(setup);
			await pressLaunch(setup);
			await setup.flush();
			expect(onLaunch).not.toHaveBeenCalled();
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Unavailable: Launch Consultation: initial input cannot be empty");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("refuses oversized initial input with its byte count and limit", async () => {
		const bytes = 64 * 1024 + 1;
		const { setup, onLaunch } = await launcher({
			typeName: "grill",
			repositoryIdentity: repositories[0].identity,
			input: "a".repeat(bytes),
		});
		try {
			await focusDraft(setup);
			await pressLaunch(setup);
			const frame = await awaitFrame(
				setup,
				(candidate) => frameText(candidate).includes(`initial input is ${bytes} UTF-8 bytes`),
				"the oversized-input refusal",
			);
			expect(frameText(frame)).toContain(`UTF-8 bytes: ${bytes}/65536`);
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});
});
