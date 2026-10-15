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
import type { StandingFacts } from "../src/components/controls.ts";
import { frameText, launchConsultationDraft, waitFor } from "./app-harness.ts";

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
const BASE_STANDING: StandingFacts = {
	sourceCount: 1,
	refreshingSourceCount: 0,
	handoffActive: false,
	messageRecorded: false,
	consultationTypesConfigured: true,
	interactionExitKey: "f12",
	queuePaused: false,
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
			standing: BASE_STANDING,
			message: null,
			onCopy: () => undefined,
			onLaunch,
			onClose: () => undefined,
			onDiscard: () => undefined,
			onEmergencyExit: () => undefined,
			// The plane-level keys resolve to the catalogue's controls; the
			// launcher's own frame is what this suite measures (issue #319).
			onQueuePause: () => undefined,
			onAutoHandoff: () => undefined,
		}),
		{ width: 100, height: 24 },
	);
	await setup.flush();
	return { setup, onLaunch };
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
			// The draft holds the input, so the typed input is the empty text: the
			// route stands on the draft's own value.
			await launchConsultationDraft(setup, "");
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
			await launchConsultationDraft(setup, "review the design");
			expect(onLaunch).toHaveBeenCalledWith("grill", repositories[0], "review the design");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("refuses empty initial input on the visible action, and launches nothing", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			// The draft's input stays empty: the route types nothing into it and
			// runs the visible action on its empty value.
			await launchConsultationDraft(setup, "");
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
			// The draft holds the oversized input, so the route types nothing
			// into it and runs the visible action on the draft's own value.
			await launchConsultationDraft(setup, "");
			const frame = await waitFor(setup, { shows: `initial input is ${bytes} UTF-8 bytes` });
			expect(frameText(frame)).toContain(`UTF-8 bytes: ${bytes}/65536`);
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});
});
