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
 *
 * The rig's last pin is the issue's own: the bar packs its hints without
 * deduplicating, so it paints a hint's text once per on-bar owner. A painted
 * hint one control paints is a key the rig owns, and a hint the bar paints
 * twice is a finding about the bar the rig files instead of pressing
 * through. The surface read names the catalogue modes the frame stands on
 * from the frame's own markers, and the read names every catalogue control
 * that could paint a hint on the surface: on the Consultations surface the
 * remove pair stands as a hint the bar paints once and the read names for
 * two owners - the queue's removal runs every base mode and carries no
 * section marker - and the rig owns the key the one painted cell stands on,
 * the plane dispatching the key to the on-bar owner. The guard's throw is
 * pinned on the shape the Seeded plane stands not: a bar that paints a
 * hint's text twice.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { controlById } from "../src/components/controls.ts";
import { controlInk } from "../src/components/shared/presentation.ts";
import {
	type AppSetup,
	actionBarRowOf,
	allControls,
	BAR_LABEL_WORDINGS,
	barControlIds,
	barHintOwners,
	crossCursor,
	displayOnlyKeyLabels,
	frameText,
	guideKey,
	HEIGHT,
	hintWordings,
	messageRowOf,
	namedWhat,
	pageKey,
	parseBarText,
	pressControl,
	resolveControl,
	type SurfaceFamily,
	settle,
	sharedHintGuard,
	surfaceFamily,
	surfaceModes,
	toggleAutoHandoff,
	WIDTH,
	waitFor,
	waitSourceHealthy,
	withApp,
} from "./app-harness.ts";
import { type ConsultationSeed, plane, type WorkQueueSeed } from "./plane.ts";

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

/** Boot a plane with the standing it names, and the source standing healthy. */
async function withSeededPlane(
	body: (setup: AppSetup) => Promise<void>,
	standing: Parameters<typeof plane>[0],
): Promise<void> {
	const planeRecord = await plane(standing);
	await withApp(
		async (setup) => {
			planeRecord.settleFirstFetch();
			await waitSourceHealthy(planeRecord.state);
			await body(setup);
		},
		{ width: WIDTH, height: HEIGHT, plane: planeRecord },
	);
}

/** Walk the list from the top to the section that holds the focus marker. */
async function toSection(setup: AppSetup, section: SurfaceFamily): Promise<void> {
	for (let step = 0; step < 40 && surfaceFamily(setup.captureCharFrame()) !== section; step += 1) {
		await pressControl(setup, "move-list", { via: "j", quiet: true });
	}
	expect(surfaceFamily(setup.captureCharFrame())).toBe(section);
}

/** Stand on the Consultations section, its closed record under the cursor. */
async function toClosedConsultation(setup: AppSetup): Promise<void> {
	await toSection(setup, "consultation");
	await pressControl(setup, "history", { quiet: true });
}

/** The repository the consultation seeds name, one the plane can stand. */
const REPO_BILLING = {
	identity: "github.com/acme/billing",
	displayName: "acme/billing",
	cloneUrl: "https://github.com/acme/billing.git",
	path: "/tmp/billing",
};

const REVIEW_RECORD: ConsultationSeed = {
	typeName: "review",
	agentType: "pi",
	environment: "live-worktree",
	template: "plan",
	initialInput: "Check the billing service for the auth shim removal.",
	renderedOpeningPrompt: "Review the billing service.",
	repository: REPO_BILLING,
	agentName: "sample-agent",
};

const AWAITING_RECORD: ConsultationSeed = {
	...REVIEW_RECORD,
	agent: true,
	state: "awaiting-response",
};

const WORKING_RECORD: ConsultationSeed = { ...REVIEW_RECORD, agent: true, state: "working" };

const CLOSED_RECORD: ConsultationSeed = { ...REVIEW_RECORD, state: "closed" };

const HANDOFF_ROW: WorkQueueSeed = {
	kind: "handoff",
	ticketIdentity: "github:github.com:I_9",
	origin: "workflow",
	previousMessage: "End the work cycle",
	choice: {
		agentType: "pi",
		environment: "live-worktree",
		taskType: "review",
		model: "",
		thinking: "",
		contextWindow: "",
	},
};

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

	test("sends the page and jump keys the bar's hint names nowhere", async () => {
		await withHealthyPlane(async (setup) => {
			// The bar's hint names `↑↓/jk`, never the page or jump keys: they stand
			// on the escape list, and the key moves the cursor like the walk's do.
			await pageKey(setup, "end", { moved: "Ticket id in the a" });
			const frame = await pageKey(setup, "home", { moved: "Drop the legacy auth" });
			expect(frameText(frame)).toContain("Drop the legacy auth");
		}, toOpenTicket);
	});

	test("reaches the key the guide names where the bar paints none", async () => {
		const planeRecord = await plane({ runner: (fake) => fake, sources: [], groupingAxis: "none" });
		await withApp(
			async (setup) => {
				// The record is empty, so the bar leaves the Message hint off:
				// the guide still names m, and the catalogue's own key sends it.
				await guideKey(setup, "message", "m", {
					refuses: "no message has been recorded",
				});
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("guideKey refuses a key the guide names nowhere for the control", async () => {
		await withHealthyPlane(async (setup) => {
			await settle(setup);
			await expect(guideKey(setup, "help", "z")).rejects.toThrow(/the guide names F1, \? for it/);
		});
	});
});

describe("the frame rig's section walk", () => {
	test("crosses the cursor across the section boundary, and back", async () => {
		await withSeededPlane(
			async (setup) => {
				const across = await crossCursor(setup, "consultations");
				expect(frameText(across)).toContain("❯ Consultations");
				const back = await crossCursor(setup, "tickets");
				expect(frameText(back)).toContain("❯ Tickets");
			},
			{ standing: "open", consultations: [REVIEW_RECORD] },
		);
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

describe("the frame rig owns a painted hint one control paints (issue #387)", () => {
	test("the surface read names the catalogue modes from the frame's own markers", () => {
		const titled = (title: string, bar = ""): string => `┌─${title}─┐\n${bar}`;
		expect(surfaceModes(titled("Key guide"))).toEqual(["key-guide"]);
		expect(surfaceModes(titled("Message view", "j/k Scroll body  Esc/F2 Close"))).toEqual([
			"message-view",
		]);
		expect(
			surfaceModes(
				titled("Decision: any panel", "↑↓ Select action  Enter Confirm action  Esc Cancel"),
			),
		).toEqual(["decision-modal"]);
		expect(surfaceModes(titled("Live: any ticket"))).toEqual(["live-view"]);
		expect(surfaceModes(titled("Missing: any ticket", "j/k Scroll message  Esc Cancel"))).toEqual([
			"missing-modal",
		]);
		expect(
			surfaceModes(
				titled("Close: any ticket", "↑↓ Select action  Enter Confirm action  Esc Cancel"),
			),
		).toEqual(["action-panel"]);
		expect(
			surfaceModes(titled("Init a repository", "↑↓/jk Move  Enter Select  Esc Cancel")),
		).toEqual(["repository-select"]);
		expect(
			surfaceModes(
				titled("Init a repository", "↑↓ Select action  Enter Confirm action  Esc Cancel"),
			),
		).toEqual(["action-panel"]);
		expect(surfaceModes(titled("Consultation launcher"))).toEqual([
			"form-field",
			"form-selector",
			"form-action",
		]);
		expect(surfaceModes("┌─❯ Tickets\n↑↓/jk Move")).toEqual(["ticket-list"]);
		expect(surfaceModes("┌─❯ Consultations\n↑↓/jk Move")).toEqual(["consultation-list"]);
		expect(surfaceModes("┌─❯ Work queue\n↑↓/jk Move")).toEqual(["work-queue-list"]);
		expect(surfaceModes("┌─❯ Detail\n↑↓/jk Scroll  ←/h Tickets")).toEqual(["ticket-detail"]);
		expect(
			surfaceModes("┌─❯ Agent view\n↑↓/jk Scroll  + Promote  - Demote  Delete Remove"),
		).toEqual(["work-queue-detail"]);
		expect(surfaceModes("┌─❯ Session view\n↑↓/jk Scroll  f History  Delete Close")).toEqual([
			"consultation-detail",
			"consultation-interaction",
		]);
		expect(surfaceModes("┌─❯ Agent view\nj/k Scroll body  Esc Cancel")).toEqual([
			"consultation-detail",
			"consultation-interaction",
			"work-queue-detail",
		]);
		expect(surfaceModes("┌─Override\nType Edit")).toEqual([
			"override-list",
			"override-model",
			"override-text",
		]);
		// A panel that names no mode is split on the one hint only its mode paints.
		expect(
			surfaceModes("an unnamed panel\n↑↓ Select action  Enter Confirm action  Esc Cancel"),
		).toEqual(["action-panel"]);
		// A frame the rig names not stands for no modes: the read is permissive.
		expect(surfaceModes("an unnamed panel\nType Edit  Enter Submit")).toBeNull();
	});

	test("a Decision modal's bar is owned by the modal's controls alone", async () => {
		await withSeededPlane(
			async (setup) => {
				await pressControl(setup, "decide-completion", { opens: "Decision:" });
				expect(surfaceModes(setup.captureCharFrame())).toEqual(["decision-modal"]);
				const owners = barHintOwners(setup);
				expect(owners.get("↑↓ Select action")).toEqual(["select-action"]);
				expect(owners.get("Enter Confirm action")).toEqual(["confirm-action"]);
				expect(owners.get("Esc Cancel")).toEqual(["cancel-action"]);
				expect(owners.get("j/k Scroll body")).toEqual(["scroll-body"]);
				expect(owners.get("e Edit handoff")).toEqual(["edit-action"]);
				// The closed walk passes on the modal's own bar.
				barControlIds(setup);
				// The surfaces the modal's bar borrows wordings from own no hint on it: the
				// collision the permissive read measured is gone once the surface is named.
				for (const id of ["cancel", "close-form", "scroll-message", "guide-close"]) {
					expect(() => resolveControl(setup, id)).toThrow(/the bar paints no hint/);
				}
			},
			{ standing: "awaiting" },
		);
	});

	test("a focused ticket detail is owned by the ticket section's controls", async () => {
		await withSeededPlane(
			async (setup) => {
				await pressControl(setup, "detail", { moved: "detail" });
				expect(surfaceModes(setup.captureCharFrame())).toEqual(["ticket-detail"]);
				const owners = barHintOwners(setup);
				expect(owners.get("↑↓/jk Scroll")).toEqual(["scroll-detail"]);
				expect(owners.get("←/h Tickets")).toEqual(["tickets"]);
				expect(owners.get("g Goto")).toEqual(["ticket-goto"]);
				expect(owners.get("Delete Close")).toEqual(["ticket-close"]);
				barControlIds(setup);
				// The consultation section's controls run no mode the detail stands on.
				expect(() => resolveControl(setup, "consultation-goto")).toThrow(/the bar paints no hint/);
				expect(() => resolveControl(setup, "consultation-close")).toThrow(/the bar paints no hint/);
			},
			{ standing: "in-flight" },
		);
	});

	test("a focused consultation detail is owned by the consultation section's controls", async () => {
		await withSeededPlane(
			async (setup) => {
				await toSection(setup, "consultation");
				await pressControl(setup, "detail", { quiet: true });
				expect(surfaceModes(setup.captureCharFrame())).toEqual([
					"consultation-detail",
					"consultation-interaction",
				]);
				const owners = barHintOwners(setup);
				expect(owners.get("↑↓/jk Scroll")).toEqual(["scroll-detail"]);
				expect(owners.get("←/h List")).toEqual(["consultation-list"]);
				expect(owners.get("f History")).toEqual(["history"]);
				expect(owners.get("Delete Close")).toEqual(["consultation-close"]);
				expect(owners.get("g Goto")).toEqual(["consultation-goto"]);
				barControlIds(setup);
				// The ticket and the queue sections' controls own no hint of this bar.
				expect(() => resolveControl(setup, "ticket-goto")).toThrow(/the bar paints no hint/);
				expect(() => resolveControl(setup, "ticket-close")).toThrow(/the bar paints no hint/);
				expect(() => resolveControl(setup, "queue-remove")).toThrow(/the bar paints no hint/);
			},
			{ standing: "open", consultations: [REVIEW_RECORD] },
		);
	});

	test("a focused work queue detail is owned by the queue section's controls", async () => {
		await withSeededPlane(
			async (setup) => {
				await toSection(setup, "queue");
				await pressControl(setup, "detail", { quiet: true });
				expect(surfaceModes(setup.captureCharFrame())).toEqual(["work-queue-detail"]);
				const owners = barHintOwners(setup);
				expect(owners.get("↑↓/jk Scroll")).toEqual(["scroll-detail"]);
				expect(owners.get("←/h List")).toEqual(["queue-list"]);
				expect(owners.get("+ Promote")).toEqual(["queue-promote"]);
				expect(owners.get("- Demote")).toEqual(["queue-demote"]);
				// The hint the wide queue bar shared with the consultation section's removal:
				// the surface read lets the queue's removal own it alone.
				expect(owners.get("Delete Remove")).toEqual(["queue-remove"]);
				expect(owners.get("c Launch")).toEqual(["launch"]);
				barControlIds(setup);
				expect(() => resolveControl(setup, "consultation-delete")).toThrow(
					/the bar paints no hint/,
				);
				expect(() => resolveControl(setup, "consultation-close")).toThrow(/the bar paints no hint/);
			},
			{ standing: "open", queue: [HANDOFF_ROW] },
		);
	});

	test("an action panel's bar is owned by the panel's controls alone", async () => {
		await withSeededPlane(
			async (setup) => {
				// The selected ticket holds work in flight: the close is available, and it
				// opens the panel that asks for the decision.
				await pressControl(setup, "ticket-close", { opens: "Close:" });
				expect(surfaceModes(setup.captureCharFrame())).toEqual(["action-panel"]);
				const owners = barHintOwners(setup);
				expect(owners.get("↑↓ Select action")).toEqual(["select-action"]);
				expect(owners.get("j/k Scroll message")).toEqual(["scroll-message"]);
				expect(owners.get("Enter Confirm action")).toEqual(["confirm-action"]);
				expect(owners.get("Esc Cancel")).toEqual(["cancel-action"]);
				barControlIds(setup);
				// The modal and the form surfaces share the panel's wordings and own no hint on it.
				for (const id of ["cancel", "close-form", "scroll-body", "guide-close"]) {
					expect(() => resolveControl(setup, id)).toThrow(/the bar paints no hint/);
				}
			},
			{ standing: "awaiting" },
		);
	});

	test("the Message view's bar is owned by the view's controls alone", async () => {
		await withSeededPlane(
			async (setup) => {
				// Record a message the view can show: the close on the open ticket is refused,
				// and the refusal stands on the Message line for the view to read.
				await toOpenTicket(setup);
				await pressControl(setup, "ticket-close", {
					refuses: "no work is in flight to close",
				});
				await pressControl(setup, "message", { opens: "Message view", via: "m" });
				expect(surfaceModes(setup.captureCharFrame())).toEqual(["message-view"]);
				const owners = barHintOwners(setup);
				expect(owners.get("j/k Scroll body")).toEqual(["scroll-body"]);
				expect(owners.get("Esc/F2 Close")).toEqual(["message-close"]);
				barControlIds(setup);
				// The guide's close and the form's close share the view's wordings and own no hint on it.
				expect(() => resolveControl(setup, "guide-close")).toThrow(/the bar paints no hint/);
				expect(() => resolveControl(setup, "close-form")).toThrow(/the bar paints no hint/);
			},
			{ standing: "open" },
		);
	});

	test("the response editor's bar is owned by the form's controls alone", async () => {
		await withSeededPlane(
			async (setup) => {
				await toSection(setup, "consultation");
				await pressControl(setup, "detail", { quiet: true });
				await pressControl(setup, "consultation-respond", { quiet: true });
				// The editor stands on no marker the rig names: the surface read
				// is permissive, the last unnamed surface the plane paints. The
				// form's painted hints each resolve to one owner, so no press on
				// this frame reaches the co-owner guard.
				expect(surfaceModes(setup.captureCharFrame())).toBeNull();
				const owners = barHintOwners(setup);
				expect(owners.get("Tab Field")).toEqual(["move-field"]);
				expect(owners.get("Esc Close")).toEqual(["close-form"]);
				expect(owners.get("F1 Help")).toEqual(["help"]);
				expect(barControlIds(setup)).toEqual(["move-field", "close-form", "help"]);
				// The modal and the panel's cancels share the editor's Close
				// wording and own no hint on it: the guard's throw is the
				// collision's, and this frame stands none.
				expect(() => resolveControl(setup, "cancel")).toThrow(/the bar paints no hint/);
				expect(() => resolveControl(setup, "cancel-action")).toThrow(/the bar paints no hint/);
			},
			{ standing: "open", consultations: [AWAITING_RECORD] },
		);
	});

	test("the interaction input's bar is owned by the interaction's control alone", async () => {
		await withSeededPlane(
			async (setup) => {
				await toSection(setup, "consultation");
				await pressControl(setup, "detail", { quiet: true });
				await pressControl(setup, "consultation-interact", { quiet: true });
				// The input stands on the detail pane's marker: the read names
				// both detail modes, and the Agent input's bar paints its exit
				// alone, one owner.
				expect(surfaceModes(setup.captureCharFrame())).toEqual([
					"consultation-detail",
					"consultation-interaction",
					"work-queue-detail",
				]);
				const owners = barHintOwners(setup);
				expect(owners.get("F12 Exit interaction")).toEqual(["interact-exit"]);
				expect(barControlIds(setup)).toEqual(["interact-exit"]);
			},
			{ standing: "open", consultations: [WORKING_RECORD] },
		);
	});

	test("the Consultations remove pair: the bar paints the hint once, the read names both owners", async () => {
		// The queue's removal runs every base mode and carries no section
		// marker, and the read sees no availability: on the Consultations
		// surface it names the record removal's hint for both catalogue
		// controls, while the bar keeps the queue's removal off and paints the
		// one cell the rig owns. The list's bar stands its thirteen hints, the
		// Delete Remove cell among them, at 157 columns, the cut of its row,
		// and the frame stands at 170, thirteen columns past the cut.
		const planeRecord = await plane({ standing: "open", consultations: [CLOSED_RECORD] });
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await toClosedConsultation(setup);
				const frame = setup.captureCharFrame();
				expect(surfaceModes(frame)).toEqual(["consultation-list"]);
				const painted = parseBarText(actionBarRowOf(frame), null).filter(
					(hint) => hint.key === "Delete" && hint.label === "Remove",
				);
				expect(painted).toHaveLength(1);
				expect(barHintOwners(setup).get("Delete Remove")).toEqual([
					"queue-remove",
					"consultation-delete",
				]);
				// The walk records the read's owners and resolves each against the hint.
				barControlIds(setup);
				// The rig owns the key the one painted cell stands on, and the plane
				// runs the on-bar owner's act: the removal panel opens.
				expect(resolveControl(setup, "consultation-delete").key).toBe("Delete");
				await pressControl(setup, "consultation-delete", {
					opens: "Delete Consultation",
				});
			},
			{ width: 170, height: HEIGHT, plane: planeRecord },
		);
	});

	test("the Consultations remove pair stands the same on the detail frame", async () => {
		// The detail's bar stands the same thirteen hints, cutting at the same
		// 157 columns, and the frame stands at the same 170: the read names
		// the same pair for the one painted cell, and the rig owns the key.
		const planeRecord = await plane({ standing: "open", consultations: [CLOSED_RECORD] });
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await toClosedConsultation(setup);
				await pressControl(setup, "detail", { quiet: true });
				const frame = setup.captureCharFrame();
				expect(surfaceModes(frame)).toEqual(["consultation-detail", "consultation-interaction"]);
				const painted = parseBarText(actionBarRowOf(frame), null).filter(
					(hint) => hint.key === "Delete" && hint.label === "Remove",
				);
				expect(painted).toHaveLength(1);
				expect(barHintOwners(setup).get("Delete Remove")).toEqual([
					"queue-remove",
					"consultation-delete",
				]);
				barControlIds(setup);
				expect(resolveControl(setup, "consultation-delete").key).toBe("Delete");
			},
			{ width: 170, height: HEIGHT, plane: planeRecord },
		);
	});
});

describe("the frame rig cannot press a hint the bar paints twice (issue #387)", () => {
	test("a press of a hint the bar paints twice throws the co-owner error", async () => {
		// True sharing is readable off the screen: the bar packs the hint's
		// text once per on-bar owner without deduplicating, so the collision
		// the guard files stands as two painted cells of the same text. The
		// pin paints the text twice in the unavailable ink a hint a state
		// cannot run wears, on a frame that names no surface: the permissive
		// read names the scroll pair for the text, and the guard names the
		// co-owner beside the count it read off the screen.
		const setup = await testRender(
			createElement(
				"text",
				{ x: 0, y: HEIGHT - 1, style: { width: "100%", height: 1 } },
				createElement("span", { fg: controlInk().detail.fg ?? undefined }, "↑↓/jk Scroll"),
				createElement("span", {}, "  "),
				createElement("span", { fg: controlInk().detail.fg ?? undefined }, "↑↓/jk Scroll"),
			),
			{ width: WIDTH, height: HEIGHT },
		);
		try {
			await settle(setup);
			const modes = surfaceModes(setup.captureCharFrame());
			expect(modes).toBeNull();
			const hints = parseBarText(actionBarRowOf(setup.captureCharFrame()), null);
			expect(hints.filter((hint) => hint.key === "↑↓/jk" && hint.label === "Scroll")).toHaveLength(
				2,
			);
			// The press of either owner throws and names the other, a press
			// named with `via` included, because the guard reads the hint the
			// press would send, not the wording that chose it.
			const hint = hints[0];
			expect(() => sharedHintGuard(setup, controlById("scroll-detail"), hint, modes)).toThrow(
				`cannot press "scroll-detail": the bar paints the hint "↑↓/jk Scroll" 2 times`,
			);
			expect(() => sharedHintGuard(setup, controlById("guide-scroll"), hint, modes)).toThrow(
				`cannot press "guide-scroll": the bar paints the hint "↑↓/jk Scroll" 2 times`,
			);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the guard passes a hint the bar paints once, the read's second shape", async () => {
		// The shape the Consultations remove pair stands on the Seeded plane:
		// the bar paints the hint's text once, and the read names a second
		// catalogue control the bar keeps off. The off-bar control owns no
		// painted hint, so the guard passes and the press sends the key the
		// on-bar owner runs.
		const setup = await testRender(
			createElement(
				"text",
				{ x: 0, y: HEIGHT - 1, style: { width: "100%", height: 1 } },
				createElement("span", { fg: controlInk().detail.fg ?? undefined }, "↑↓/jk Scroll"),
			),
			{ width: WIDTH, height: HEIGHT },
		);
		try {
			await settle(setup);
			const modes = surfaceModes(setup.captureCharFrame());
			expect(modes).toBeNull();
			const hint = parseBarText(actionBarRowOf(setup.captureCharFrame()), null)[0];
			expect(hint.label).toBe("Scroll");
			// The permissive read names both scroll owners for the one painted
			// cell, and the guard still passes: the count off the screen is one.
			expect(() => sharedHintGuard(setup, controlById("scroll-detail"), hint, modes)).not.toThrow();
			expect(() => sharedHintGuard(setup, controlById("guide-scroll"), hint, modes)).not.toThrow();
		} finally {
			await setup.renderer.destroy();
		}
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
