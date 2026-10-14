/**
 * The frame rig owns the frame suites' input.
 *
 * A frame test names a control from the Control catalogue and one outcome from
 * the closed set; the rig resolves the key the Action bar painted for it, sends
 * only that key, and owns the wait, the flush, the key-ownership window, and the
 * one deadline. A surface that reaches the renderer's input by hand, or that keeps
 * a private press, open, close, or wait, is back to the baseline the rig replaces:
 * the operator learns the key twice, and the test drifts from the bar the plane
 * paints.
 *
 * The rule reads the source of the surfaces the rig owns and refuses the two ways
 * a surface can opt out: reaching the renderer's input or mouse directly, and
 * keeping a private press, open, close, or wait the rig should own. The owned set
 * grows one surface at a time as a migration lands, and it never shrinks: a
 * surface that drifts back to a hand-picked key fails this check and is migrated
 * again, not removed from the list.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * The frame surfaces the rig owns, one per migrated suite. A surface joins this
 * list the moment its tests press through the rig instead of the renderer, and it
 * never leaves. The rig's own suite is the exemplar that stands at the head of the
 * list: it presses only through `pressControl` and the escape list.
 */
const OWNED_SURFACES = [
	"test/action-bar.test.ts",
	"test/frame-rig.test.ts",
	"test/key-guide.test.ts",
	"test/main-view-frame.test.ts",
	"test/message-line.test.ts",
	"test/ticket-scroll-frame.test.ts",
	"test/theme-frame.test.ts",
	"test/work-queue-frame.test.ts",
	// The migration adds a surface here, one at a time, as its tests move to
	// `pressControl` and the closed set of outcomes.
];

/**
 * The rig's retired input surface. A suite that names one keeps a private press,
 * open, close, focus, or wait the rig should own. These are called, not merely
 * spelled, so a comment that explains the retired shape is not an offender.
 */
const RETIRED_SURFACE = [
	"press",
	"pressArrow",
	"pressScrollKey",
	"pressF1",
	"pressF2",
	"pressCtrlC",
	"pressEnter",
	"pressReturn",
	"pressQuiet",
	"pressEnterQuiet",
	"openPanel",
	"openGuide",
	"openMessageView",
	"openLauncher",
	"closeOverlay",
	"openSurface",
	"openConsultationPanel",
	"confirmPanel",
	"focusDetail",
	"focusList",
	"scrollDetailUntil",
	"crossToConsultations",
	"crossToTickets",
	"awaitFrame",
	"awaitFrameChecking",
	"keyHandlerListeners",
	"awaitNewKeyHandler",
	"awaitGoneKeyHandler",
	"baseKeyHandlers",
	"awaitBaseKeyHandlers",
] as const;

const retiredPatterns = RETIRED_SURFACE.map((name) => new RegExp(`\\b${name}\\s*\\(`, "u"));

describe("the frame rig owns the frame suites' input", () => {
	test("the owned set is a closed list of real suites", () => {
		expect(OWNED_SURFACES.length).toBeGreaterThan(0);
		expect(new Set(OWNED_SURFACES).size).toBe(OWNED_SURFACES.length);
		for (const file of OWNED_SURFACES) {
			expect(existsSync(file), `${file} must be a suite the rig owns`).toBe(true);
		}
	});

	test("an owned surface reaches no renderer input by hand", () => {
		// `mockInput` and `mockMouse` are the renderer's raw feeders, reached as
		// a property on the setup. A surface that reaches one sends a key the
		// rig did not resolve, or moves the mouse outside the rig's helpers, and
		// the bar the key came from is the surface's, not the plane's. The rule
		// matches the reach, the way the retired list matches calls: a comment
		// that spells the name does not offend.
		const offenders: string[] = [];
		for (const file of OWNED_SURFACES) {
			if (/\.[m]ockInput\b|\.[m]ockMouse\b/u.test(readFileSync(file, "utf8"))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("an owned surface keeps no private press, open, close, or wait", () => {
		// The retired surface is the rig's old input face: a raw key press, a hand
		// open or close of a panel or guide, a hand focus move, and a hand wait on
		// a key handler or a frame. A surface that calls one of them by name has
		// kept a private input path the rig should own, so this names it by file.
		const offenders: string[] = [];
		for (const file of OWNED_SURFACES) {
			const source = readFileSync(file, "utf8");
			if (retiredPatterns.some((pattern) => pattern.test(source))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
