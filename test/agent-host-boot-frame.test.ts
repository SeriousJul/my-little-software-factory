/**
 * The Agent host boot statement on the Message line (issue #408, ADR 0141).
 *
 * The boot states the host it resolved and the fact that resolved it once, on
 * the Message line beside the Plane boot record entry it wrote for the same
 * resolution. This suite stands the ways the boot reaches that line: a run
 * resolved from the environment mark, and a run resolved from the operator's
 * config. The line is the lowest fact it holds: it stands while the plane is
 * quiet, and every other fact the plane states covers it.
 *
 * The frame stands at 140 columns: the longest boot line, the herdr-core
 * mark's, wears its prefix at 133 display columns, so no line the boot
 * states is cut at the edge, and the row states the whole statement.
 */

import { describe, expect, test } from "bun:test";

import { agentHostBootLine } from "../src/agent-host.ts";
import { messageRowOf, pressControl, settle, waitSourceHealthy, withApp } from "./app-harness.ts";
import type { FakeSource } from "./fake-source.ts";
import { callsReached, plane } from "./plane.ts";

const WIDTH = 140;
const HEIGHT = 40;

describe("the Agent host boot statement (issue #408)", () => {
	test("a run resolved from the herdr mark states it on the Message line", async () => {
		const planeRecord = await plane({
			agentHostEnv: { herdrEnv: "1" },
		});
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				// The line is the boot statement with its info prefix, whole
				// at the frame's width.
				expect(messageRowOf(frame).trim()).toBe(
					`Info: ${agentHostBootLine({ host: "herdr", fact: "herdr-mark" })}`,
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("a run resolved from the config states it on the Message line", async () => {
		const planeRecord = await plane({
			config: { agentHost: "herdr-core" },
		});
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				expect(messageRowOf(frame).trim()).toBe(
					`Info: ${agentHostBootLine({ host: "herdr-core", fact: "config" })}`,
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("a fact stated after the boot covers the line, and the statement returns when it clears", async () => {
		const planeRecord = await plane({
			agentHostEnv: { hcTerminalId: "t1" },
		});
		const source = planeRecord.sources[0] as FakeSource;
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				const boot = await settle(setup);
				expect(messageRowOf(boot).trim()).toBe(
					`Info: ${agentHostBootLine({ host: "herdr-core", fact: "herdr-core-mark" })}`,
				);
				// A refresh covers the line with its progress...
				await pressControl(setup, "refresh", { shows: "refreshing 1 sources" });
				await callsReached(source, 2);
				// ...and the statement returns when the refresh settles.
				source.settleCurrent();
				const back = await settle(setup);
				expect(messageRowOf(back).trim()).toBe(
					`Info: ${agentHostBootLine({ host: "herdr-core", fact: "herdr-core-mark" })}`,
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});
});
