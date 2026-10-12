/**
 * The frame rig's own suite: the interface a migrated frame test reaches.
 *
 * The rig resolves a control to the key the Action bar painted for it, sends
 * only that key, and owns the wait and the key-ownership window. This suite
 * boots the real app on the Seeded plane and pins, on one frame, that the rig
 * resolves every control the bar advertises, sends the key a press names with
 * `via`, waits on the closed set of outcomes, and keeps the controls the bar
 * never hints on its escape list. The closed catalogue walk proves the
 * resolution is not tuned to one bar: it reads the bar the plane paints and
 * resolves whatever it advertises.
 *
 * The rig's keys flow from the control catalogue and the painted bar, never
 * from a literal this suite picks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type AppSetup,
	actionBarRowOf,
	barControlIds,
	frameText,
	HEIGHT,
	messageRowOf,
	pressControl,
	resolveControl,
	settle,
	toggleAutoHandoff,
	WIDTH,
	waitFor,
	waitSourceHealthy,
	withApp,
} from "./app-harness.ts";
import { plane } from "./seeded-plane.ts";
import { cleanupStateFixtures } from "./state-fixture.ts";

afterEach(() => {
	cleanupStateFixtures();
});

/** Boot a plane whose source stands healthy, so the bar paints its full hints. */
async function withHealthyPlane(
	body: (setup: AppSetup) => Promise<void>,
	reach?: (setup: AppSetup) => Promise<void>,
): Promise<void> {
	const planeRecord = await plane({});
	await withApp(
		async (setup) => {
			planeRecord.settleFirstFetch();
			await waitSourceHealthy(planeRecord.state);
			if (reach !== undefined) await reach(setup);
			await body(setup);
		},
		{ width: WIDTH, height: HEIGHT, plane: planeRecord },
	);
}

/** Walk the marker from the top of the list to the open ticket, one press at a time. */
async function toOpenTicket(setup: AppSetup): Promise<void> {
	for (let step = 0; step < 3; step += 1) {
		await pressControl(setup, "move-list", { via: "j", quiet: true });
	}
}

describe("the frame rig's resolution", () => {
	test("resolves the base bar's controls to the keys it painted", async () => {
		await withHealthyPlane(async (setup) => {
			await toOpenTicket(setup);
			await settle(setup);
			const painted: [string, string][] = [
				["move-list", "↑"],
				["detail", "→"],
				["handoff", "Enter"],
				["ticket-goto", "g"],
				["ticket-close", "Delete"],
				["ticket-ignore", "i"],
				["section-toggle", "x"],
				["override", "e"],
				["refresh", "r"],
				["help", "?"],
			];
			for (const [id, key] of painted) {
				expect(resolveControl(setup, id).key).toBe(key);
			}
		}, toOpenTicket);
	});

	test("sends the token a press names with via, not the hint's first", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			expect(resolveControl(setup, "move-list", "j").key).toBe("j");
			expect(resolveControl(setup, "move-list", "k").key).toBe("k");
			expect(resolveControl(setup, "detail", "l").key).toBe("l");
			expect(() => resolveControl(setup, "move-list", "z")).toThrow(/not among its tokens/);
		}, toOpenTicket);
	});

	test("refuses a control the bar paints no hint for, and names the bar", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			// auto-handoff never stands on the base bar; the rig's escape list reaches it.
			expect(() => resolveControl(setup, "auto-handoff")).toThrow(
				/the bar paints no hint whose key the control answers to/,
			);
		}, toOpenTicket);
	});

	test("throws for a control the catalogue names nowhere", async () => {
		await withHealthyPlane(async (setup) => {
			expect(() => resolveControl(setup, "no-such-control")).toThrow(
				/the control catalogue names no such control/,
			);
		}, toOpenTicket);
	});

	test("resolves the Override panel's controls once it stands open", async () => {
		await withHealthyPlane(async (setup) => {
			await toOpenTicket(setup);
			await pressControl(setup, "override", { opens: "Override" });
			expect(resolveControl(setup, "cancel").key).toBe("Esc");
		}, toOpenTicket);
	});

	test("the closed walk: every control the bar paints resolves", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const ids = barControlIds(setup);
			for (const expected of [
				"move-list",
				"detail",
				"handoff",
				"ticket-goto",
				"ticket-close",
				"ticket-ignore",
				"section-toggle",
				"override",
				"refresh",
				"help",
			]) {
				expect(ids).toContain(expected);
			}
			expect(ids).not.toContain("auto-handoff");
			for (const id of ids) {
				resolveControl(setup, id);
			}
		}, toOpenTicket);
	});
});

describe("the frame rig's outcomes", () => {
	test("opens a surface, records its keys, and closes it back", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const open = await pressControl(setup, "help", { opens: "Key guide" });
			expect(frameText(open)).toContain("Key guide");
			const closed = await pressControl(setup, "guide-close", { closes: "Key guide" });
			expect(frameText(closed)).not.toContain("Key guide");
		}, toOpenTicket);
	});

	test("closes a mode the surface opened, not the base it re-created", async () => {
		await withHealthyPlane(async (setup) => {
			await toOpenTicket(setup);
			await pressControl(setup, "override", { opens: "Override" });
			const frame = await pressControl(setup, "cancel", { closes: "Override" });
			expect(actionBarRowOf(frame)).toContain("e Override");
		}, toOpenTicket);
	});

	test("states the catalogue's own refusal on the Message line", async () => {
		await withHealthyPlane(async (setup) => {
			await toOpenTicket(setup);
			const frame = await pressControl(setup, "ticket-close", {
				refuses: "no work is in flight to close",
			});
			expect(messageRowOf(frame)).toContain("no work is in flight to close");
		}, toOpenTicket);
	});

	test("shows and hides the frame's text", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const shown = await pressControl(setup, "help", { shows: "Key guide" });
			expect(frameText(shown)).toContain("Key guide");
			const hidden = await pressControl(setup, "guide-close", { hides: "Key guide" });
			expect(frameText(hidden)).not.toContain("Key guide");
		}, toOpenTicket);
	});

	test("waits for the cursor to reach the pane a press names", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const frame = await pressControl(setup, "detail", { moved: "detail" });
			expect(frameText(frame)).toContain("Retry policy");
		}, toOpenTicket);
	});

	test("settles the app to quiet after the input", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const frame = await pressControl(setup, "move-list", { via: "j", quiet: true });
			expect(typeof frame).toBe("string");
		}, toOpenTicket);
	});
});

describe("the frame rig's closed set", () => {
	test("a misspelled outcome is a rig error, not a quiet no-op", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const bogus = { settles: true } as never;
			await expect(pressControl(setup, "help", bogus)).rejects.toThrow(
				/the frame rig's outcomes are a closed set/,
			);
		}, toOpenTicket);
	});

	test("waitFor waits on outcomes without a press, and refuses opens", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const frame = await waitFor(setup, { quiet: true });
			expect(typeof frame).toBe("string");
			await expect(waitFor(setup, { opens: "Key guide" })).rejects.toThrow(
				/`opens` belongs to a press/,
			);
		}, toOpenTicket);
	});
});

describe("the frame rig's escape list", () => {
	test("reaches the auto-handoff toggle the bar never hints, by its catalogue key", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			const before = frameText(await settle(setup));
			const wasManual = before.includes("manual");
			const frame = await toggleAutoHandoff(setup, { quiet: true });
			const after = frameText(frame);
			// the header's mode cell flips between the two modes, and no other text does
			if (wasManual) {
				expect(after).toContain("auto");
				expect(after).not.toContain("manual");
			} else {
				expect(after).toContain("manual");
				expect(after).not.toContain("auto");
			}
		});
	});

	test("pressControl refuses the auto-handoff control: it is off the bar", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			await expect(pressControl(setup, "auto-handoff")).rejects.toThrow(
				/the bar paints no hint whose key the control answers to/,
			);
		}, toOpenTicket);
	});
});
