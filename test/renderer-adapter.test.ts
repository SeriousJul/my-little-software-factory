/**
 * The renderer adapter's repaint policy (issue #421, ADR 0145).
 *
 * The policy is a function of the frame's facts, and these tests feed it
 * the fact combinations without a terminal: no force fact answers the
 * diff, and any force fact answers a full rewrite. The adapter's frame side
 * is driven on a stand-in renderer that keeps the events the adapter reads
 * and the frame callback it installs. The test reads the rewrite scope the
 * policy applied through the adapter's own interface, and it reads the
 * private full-repaint request the policy set, so it proves the private
 * stands only where the policy answers full.
 *
 * The frame rig keeps asserting the painted frames the plane paints on the
 * test renderer, which boots no adapter: the rig is the plane's test seam,
 * not the entry's. The rewrite bytes a frame performs on a live terminal
 * stand on the terminal walk, recorded in the verification record beside
 * the renderer version and the terminal it ran on.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CliRenderEvents, type CliRenderer } from "@opentui/core";

import {
	installRepaintPolicy,
	type RepaintFrameFacts,
	type RepaintPolicyHandle,
	type RepaintPolicyOptions,
	repaintScope,
} from "../src/renderer-adapter.ts";

/**
 * The stand-in for the renderer's frame side: the events the adapter reads
 * and the frame callback it installs.
 *
 * Its render path keeps the installed renderer's (0.5.11) behavior the
 * policy stands on: the frame callback runs before the paint, and the
 * paint reads the full-repaint request and clears it, so the frame the
 * policy forced is the only frame the request stands for.
 */
class FakeRenderer extends EventEmitter {
	/** The frame callback the adapter installs. */
	frameCallback: ((deltaTime: number) => Promise<void>) | null = null;
	/** The renderer's private full-repaint request, as the policy sets it. */
	forceFullRepaintRequested = false;
	/** Whether the last frame ran the full rewrite. */
	lastFrameFull = false;

	setFrameCallback(callback: (deltaTime: number) => Promise<void>): void {
		this.frameCallback = callback;
	}

	/** Run one frame: the adapter's frame callback, then the render path. */
	async frame(): Promise<void> {
		await this.frameCallback?.(16);
		this.lastFrameFull = this.forceFullRepaintRequested;
		this.forceFullRepaintRequested = false;
	}
}

/** Stand the policy on a stand-in renderer and keep both sides readable. */
function standPolicy(options: RepaintPolicyOptions = {}): {
	fake: FakeRenderer;
	handle: RepaintPolicyHandle;
} {
	const fake = new FakeRenderer();
	const handle = installRepaintPolicy(fake as unknown as CliRenderer, options);
	return { fake, handle };
}

describe("the policy's answer on the frame's facts", () => {
	const quiet: RepaintFrameFacts = {
		resized: false,
		capabilityAnswer: false,
		outsidePaint: false,
		byteLoss: false,
		blanketForce: false,
	};

	test("answers the diff when no force fact stands", () => {
		expect(repaintScope(quiet)).toBe("diff");
	});

	const forceFacts: [name: string, fact: Partial<RepaintFrameFacts>][] = [
		["the terminal resize", { resized: true }],
		["the capability answer", { capabilityAnswer: true }],
		["an outside write that could paint a cell", { outsidePaint: true }],
		["the byte-loss signal", { byteLoss: true }],
		["the blanket force", { blanketForce: true }],
	];

	for (const [name, fact] of forceFacts) {
		test(`answers the full rewrite when ${name} stands`, () => {
			expect(repaintScope({ ...quiet, ...fact })).toBe("full");
		});
	}

	test("answers the full rewrite on a combination of force facts", () => {
		expect(repaintScope({ ...quiet, resized: true, outsidePaint: true, blanketForce: true })).toBe(
			"full",
		);
	});
});

describe("the adapter's frame side", () => {
	test("runs the diff and sets no full-rewrite request when no force fact stands", async () => {
		const { fake, handle } = standPolicy();
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
		expect(fake.lastFrameFull).toBe(false);
	});

	test("stands the blanket force on every frame the entry passes it", async () => {
		const { fake, handle } = standPolicy({ blanketForce: () => true });
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
	});

	test("forces the frame after a terminal resize and no frame after it", async () => {
		const { fake, handle } = standPolicy();
		fake.emit(CliRenderEvents.RESIZE, 200, 50);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
		expect(fake.lastFrameFull).toBe(false);
	});

	test("forces the frame after the renderer's capability answer", async () => {
		const { fake, handle } = standPolicy();
		fake.emit(CliRenderEvents.CAPABILITIES);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
	});

	test("forces the frame on the external output the renderer detects", async () => {
		const { fake, handle } = standPolicy();
		fake.emit(CliRenderEvents.EXTERNAL_OUTPUT);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
	});

	test("forces the frame on an outside write that could paint a cell", async () => {
		const { fake, handle } = standPolicy();
		handle.reportOutsideTerminalWrite({ kind: "paint" });
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
	});

	test("reads the plane's bell as the fact it is: it paints no cell, so it forces no rewrite", async () => {
		const { fake, handle } = standPolicy();
		handle.reportOutsideTerminalWrite({ kind: "bell" });
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
		expect(fake.lastFrameFull).toBe(false);
	});

	test("forces the frame the byte-loss signal stands on, and the diff when it clears", async () => {
		let signal = false;
		const { fake, handle } = standPolicy({ byteLossSignal: () => signal });
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
		signal = true;
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
		signal = false;
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("diff");
		expect(fake.lastFrameFull).toBe(false);
	});

	test("forces the frame when the resize stands beside the bell", async () => {
		const { fake, handle } = standPolicy();
		fake.emit(CliRenderEvents.RESIZE, 200, 50);
		handle.reportOutsideTerminalWrite({ kind: "bell" });
		await fake.frame();
		expect(handle.lastRewriteScope).toBe("full");
		expect(fake.lastFrameFull).toBe(true);
	});
});
