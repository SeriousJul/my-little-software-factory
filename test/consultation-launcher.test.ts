/** The Consultation launcher rejects invalid input before it can open work. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, test, vi } from "vitest";

import { ConsultationLauncher } from "../src/components/consultation-launcher.ts";
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

async function launcher(initialInput = "") {
	const onLaunch = vi.fn();
	const setup = await testRender(
		createElement(ConsultationLauncher, {
			types,
			repositories,
			initialInput,
			onLaunch,
			onCancel: () => undefined,
		}),
		{ width: 100, height: 20 },
	);
	await setup.flush();
	return { setup, onLaunch };
}

describe("Consultation launcher input", () => {
	test("collects a type, Repository, and initial input before it launches", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			const frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("Type grill");
			expect(frame).toContain("Repository acme/factory");
			setup.mockInput.pressTab();
			setup.mockInput.pressTab();
			setup.mockInput.typeText("review the design");
			setup.mockInput.pressEnter();
			await awaitFrame(setup, () => onLaunch.mock.calls.length === 1, "the launch callback");
			expect(onLaunch).toHaveBeenCalledWith("grill", repositories[0], "review the design");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("rejects empty initial input with a readable message", async () => {
		const { setup, onLaunch } = await launcher();
		try {
			setup.mockInput.pressEnter();
			const frame = await awaitFrame(
				setup,
				(candidate) => candidate.includes("initial input cannot be empty"),
				"the empty-input error",
			);
			expect(frame).toContain("Error:");
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("rejects oversized initial input with its byte count and limit", async () => {
		const bytes = 64 * 1024 + 1;
		const { setup, onLaunch } = await launcher("a".repeat(bytes));
		try {
			setup.mockInput.pressEnter();
			const frame = await awaitFrame(
				setup,
				(candidate) =>
					candidate.includes(`initial input is ${bytes} UTF-8 bytes; the limit is 65536`),
				"the oversized-input error",
			);
			expect(frame).toContain(`UTF-8 bytes: ${bytes}/65536`);
			expect(onLaunch).not.toHaveBeenCalled();
		} finally {
			await setup.renderer.destroy();
		}
	});
});
