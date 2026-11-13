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
import type { AgentHost } from "../src/agent-host.ts";
import { ConsultationLauncher } from "../src/components/consultation-launcher.ts";
import type { StandingFacts } from "../src/components/controls.ts";
import {
	frameText,
	launchConsultationDraft,
	settle,
	tabUntilSlot,
	waitFor,
} from "./app-harness.ts";

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
	agentHost: { host: "herdr-core", fact: "default" },
};

async function launcher(
	draft?: { typeName: string; repositoryIdentity: string; input: string; host: AgentHost } | null,
	repositoriesOverride?: typeof repositories,
	over?: Partial<Pick<StandingFacts, "agentHost">>,
	width = 100,
) {
	const onLaunch = mock();
	const setup = await testRender(
		createElement(ConsultationLauncher, {
			types,
			repositories: repositoriesOverride ?? repositories,
			draft,
			standing: { ...BASE_STANDING, ...over },
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
		{ width, height: 24 },
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
				// The run stands on the herdr-core host (ADR 0141), so the host
				// row starts on it and the launch carries it.
				host: "herdr-core",
			},
			options,
		);
		try {
			expect(frameText(setup.captureCharFrame())).toContain("Repository acme/factory");
			// The draft holds the input, so the typed input is the empty text: the
			// route stands on the draft's own value.
			await launchConsultationDraft(setup, "");
			expect(onLaunch).toHaveBeenCalledWith("grill", options[1], "review the design", "herdr-core");
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
			expect(onLaunch).toHaveBeenCalledWith(
				"grill",
				repositories[0],
				"review the design",
				"herdr-core",
			);
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
			host: "herdr-core",
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

// The one line the host that the run cannot reach states, whatever surface
// asks it (issue #409, ADR 0142).
const HERDR_UNREACHABLE =
	"host herdr is unreachable from this run: the plane runs outside herdr, and no herdr server answers there";

describe("the Agent host row (issue #409)", () => {
	test("on a herdr run the row defaults to the run's host, and the launch reaches start on it", async () => {
		const { setup, onLaunch } = await launcher(null, undefined, {
			agentHost: { host: "herdr", fact: "default" },
		});
		try {
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Agent host herdr");
			await launchConsultationDraft(setup, "review the design");
			expect(onLaunch).toHaveBeenCalledWith("grill", repositories[0], "review the design", "herdr");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("on a herdr run the row cycles to herdr-core, and the launch reaches start on the cycled host", async () => {
		const { setup, onLaunch } = await launcher(null, undefined, {
			agentHost: { host: "herdr", fact: "default" },
		});
		try {
			await tabUntilSlot(setup, "❯ Agent host");
			setup.mockInput.pressArrow("right");
			const frame = await settle(setup);
			expect(frameText(frame)).toContain("Agent host herdr-core");
			// Both hosts answer on a herdr run, so the row states no refusal.
			expect(frameText(frame)).not.toContain("Error: Agent host:");
			await launchConsultationDraft(setup, "review the design");
			expect(onLaunch).toHaveBeenCalledWith(
				"grill",
				repositories[0],
				"review the design",
				"herdr-core",
			);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("on a herdr-core run the herdr host is refused on the row, and the launch states the same line", async () => {
		// The width stands wide enough for the host's one line to appear whole:
		// the row's note and the launch's action state the same words.
		const { setup, onLaunch } = await launcher(null, undefined, undefined, 220);
		try {
			await tabUntilSlot(setup, "❯ Agent host");
			setup.mockInput.pressArrow("right");
			const refused = await waitFor(setup, { shows: HERDR_UNREACHABLE });
			// The row states the refusal under itself, the way every refused
			// row does: a terminal that paints no color keeps the words.
			const text = frameText(refused);
			expect(text).toContain(`Error: Agent host: ${HERDR_UNREACHABLE}`);
			// The refusal stands on the visible action: the launch that the
			// operator tabs to states the line, and it launches nothing.
			await launchConsultationDraft(setup, "review the design");
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain(`Unavailable: Launch Consultation: ${HERDR_UNREACHABLE}`);
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("on a herdr-core run the row defaults to the run's host, and the launch reaches start on it", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Agent host herdr-core");
			await launchConsultationDraft(setup, "review the design");
			expect(onLaunch).toHaveBeenCalledWith(
				"grill",
				repositories[0],
				"review the design",
				"herdr-core",
			);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("a launcher seeded from a record takes the record's host, and states the refusal when the run cannot reach it", async () => {
		// The record the launcher replaces started on the herdr host. The run
		// resolves herdr-core, so the row stands on the record's host, states
		// the one line, and launches nothing.
		const { setup, onLaunch } = await launcher(
			{
				typeName: "grill",
				repositoryIdentity: repositories[0].identity,
				input: "review the design",
				host: "herdr",
			},
			undefined,
			undefined,
			220,
		);
		try {
			const frame = await waitFor(setup, { shows: HERDR_UNREACHABLE });
			const text = frameText(frame);
			expect(text).toContain("Agent host herdr");
			expect(text).toContain(`Error: Agent host: ${HERDR_UNREACHABLE}`);
			await launchConsultationDraft(setup, "");
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("on a herdr run a record's herdr-core host launches on the core", async () => {
		// The record the launcher replaces started on the core. The run stands
		// inside herdr, where both hosts answer, so the launch carries the
		// record's host to start.
		const { setup, onLaunch } = await launcher({
			typeName: "grill",
			repositoryIdentity: repositories[0].identity,
			input: "review the design",
			host: "herdr-core",
		});
		try {
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Agent host herdr-core");
			await launchConsultationDraft(setup, "");
			expect(onLaunch).toHaveBeenCalledWith(
				"grill",
				repositories[0],
				"review the design",
				"herdr-core",
			);
		} finally {
			await setup.renderer.destroy();
		}
	});
});
