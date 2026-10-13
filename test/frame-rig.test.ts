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
 * resolves whatever it advertises. A control off the bar owns no painted
 * hint and fails the resolution instead of pressing a key the bar names for
 * another control, and the bar's dynamic label wordings agree with the
 * catalogue's `barLabel` functions on the samples that cover their branches.
 *
 * The rig's keys flow from the control catalogue and the painted bar, never
 * from a literal this suite picks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { controlById } from "../src/components/controls.ts";
import {
	type AppSetup,
	actionBarRowOf,
	allControls,
	BAR_LABEL_WORDINGS,
	barControlIds,
	displayOnlyKeyLabels,
	frameText,
	HEIGHT,
	hintWordings,
	messageRowOf,
	namedWhat,
	parseBarText,
	pressControl,
	resolveControl,
	settle,
	surfaceFamily,
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
				/the bar paints no hint that belongs to it/,
			);
		}, toOpenTicket);
	});

	test("a control off the bar fails where its key collides with a painted hint", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			// The bar paints "Enter Decide" for the control that decides; a
			// different control that answers to Enter owns no painted hint and
			// fails the resolution instead of pressing that key for it. On the
			// row the frame stands on, the handoff's own hint is packed out of
			// the bar, so the handoff control fails here too.
			for (const id of [
				"confirm-action",
				"confirm-choice",
				"consultation-respond",
				"live-goto",
				"queue-force-dispatch",
				"handoff",
				"queue-jump",
			]) {
				expect(() => resolveControl(setup, id)).toThrow(`cannot press "${id}"`);
			}
		});
	});

	test("a control the frame's surface does not run fails on a hint its section paints", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			// The bar stands on the ticket section: the hint it paints for "g" and
			// "Delete" belongs to the ticket's control, so the same-named hint
			// painted for the other sections' controls owns none of it here.
			expect(surfaceFamily(setup.captureCharFrame())).toBe("ticket");
			for (const id of ["consultation-goto", "consultation-close", "queue-remove", "queue-list"]) {
				expect(() => resolveControl(setup, id)).toThrow(`cannot press "${id}"`);
			}
		}, undefined);
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
			const open = await pressControl(setup, "override", { opens: "Override" });
			// The panel is a full-screen surface of its own: the frame names it by
			// its title, so the rig resolves the panel's controls against the
			// panel's modes, not the section the panel stands over.
			expect(surfaceFamily(open)).toBe("override");
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
			// The guide is a full-screen surface: the frame names it by its title,
			// and the close resolves against the guide's modes, not the section's.
			expect(surfaceFamily(open)).toBe("guide");
			const closed = await pressControl(setup, "guide-close", { closes: "Key guide" });
			expect(frameText(closed)).not.toContain("Key guide");
			expect(surfaceFamily(closed)).toBe("ticket");
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
				/the bar paints no hint that belongs to it/,
			);
		}, toOpenTicket);
	});
});

describe("the frame rig's bar wordings", () => {
	/**
	 * The samples that cover the branches of each `barLabel` the rig carries:
	 * one sample per branch the function can take, so the pin reads back every
	 * wording the bar can paint. A `barLabel` that gains a branch the samples
	 * do not cover fails the pin until its sample row grows.
	 */
	const SAMPLES: Record<string, readonly unknown[]> = {
		"ticket-ignore": [{ selectedTicket: undefined }, { selectedTicket: { ignored: true } }],
		"ticket-mute": [
			{ selectedTicket: undefined },
			{ selectedTicket: { muted: true, memberships: [{ sourceName: "issues" }] } },
			{ selectedTicket: { muted: false, memberships: [] } },
		],
		"ticket-filter": [{ ticketListFilter: "active" }, { ticketListFilter: "all" }],
		"group-axis": [{ groupingAxis: "none" }, { groupingAxis: "repository" }],
		"group-fold": [{ selectedGroupHeader: null }, { selectedGroupHeader: { collapsed: true } }],
		"group-move-up": [{}],
		"group-move-down": [{}],
		"queue-pause": [{ queuePaused: true }, { queuePaused: false }],
		"select-repository": [{ pendingCount: 0 }, { pendingCount: 2 }],
	};

	test("every wording the catalogue's barLabels produce is one the rig reads", () => {
		for (const control of allControls()) {
			if (control.barLabel === undefined) continue;
			for (const sample of SAMPLES[control.id] ?? [{}]) {
				const painted = control.barLabel(sample as never);
				if (painted === undefined) continue;
				expect(
					hintWordings(control).some((wording) => painted.startsWith(wording)),
					`the bar paints "${painted}" for ${control.id}, and the rig's wordings read it back`,
				).toBe(true);
			}
		}
	});

	test("every wording the rig carries is one the catalogue's barLabels produce", () => {
		for (const [id, wordings] of Object.entries(BAR_LABEL_WORDINGS)) {
			const control = controlById(id);
			expect(
				control.barLabel !== undefined,
				`${id} carries wordings the rig reads for a barLabel the catalogue gives it none`,
			).toBe(true);
			for (const wording of wordings) {
				const produced = (SAMPLES[id] ?? []).some((sample) =>
					control.barLabel?.(sample as never)?.startsWith(wording),
				);
				expect(
					produced,
					`the rig carries "${wording}" for ${id}, and a catalogue branch paints it`,
				).toBe(true);
			}
		}
	});
});

describe("the frame rig's keyless hints", () => {
	test("a display-only hint parses keyless, and a key label parses its tokens", () => {
		// The text row's display-only hints claim no key: the focused field owns
		// the key the label names. The rig reads the hint and carries no tokens
		// for it, instead of splitting the label's letters into keys.
		const hints = parseBarText("Type Edit  Backspace Delete  Del Close", null);
		expect(hints.map((h) => [h.key, h.label, h.keyless, h.tokens])).toEqual([
			["Type", "Edit", true, []],
			["Backspace", "Delete", true, []],
			["Del", "Close", false, ["Del"]],
		]);
	});

	test("the rig's keyless labels are the catalogue's display-only labels", () => {
		// The set is closed on the catalogue's own fact: a bar control that
		// claims no key in every mode it paints in. The catalogue's display-only
		// bar hints today are the text row's Type and Backspace; a display-only
		// label the catalogue adds lands in the set, and a label it also paints
		// beside a real key never does.
		expect([...displayOnlyKeyLabels()].sort()).toEqual(["Backspace", "Type"]);
	});
});

describe("the frame rig names its timeouts", () => {
	test("a wait stands named for the press that sent it", () => {
		expect(namedWhat('the surface "Key guide" to open', 'the control "help"')).toBe(
			'the surface "Key guide" to open, after the control "help"',
		);
		expect(namedWhat("the cursor to move", undefined)).toBe("the cursor to move");
	});

	test("a timeout on a press names the control in its message", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			// The press lands, the surface it opens never shows the named text, and
			// the deadline fails the wait: the message names the outcome, the
			// surface the outcome names, and the control whose press the wait
			// stood behind.
			await expect(
				pressControl(setup, "help", { opens: "a surface the plane never paints" }),
			).rejects.toThrow(/a surface the plane never paints" to open, after the control "help"/);
		}, toOpenTicket);
	});
});
