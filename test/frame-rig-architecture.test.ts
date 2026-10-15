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
 * The rule reads the source of the surfaces the rig owns and refuses the ways
 * a surface can opt out: reaching the renderer's input or mouse directly, keeping
 * a private press, open, close, or wait, and waiting a frame fact the rig's
 * named outcomes already name, spelled as an inline containment read on the
 * rig's own wait. The owned set grows one surface at a time as a migration
 * lands, and it never shrinks: a surface that drifts back to a hand-picked key
 * fails this check and is migrated again, not removed from the list.
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
	"test/consultation-frame.test.ts",
	"test/consultation-launcher-editing.test.ts",
	"test/consultation-launcher.test.ts",
	"test/decision-modal.test.ts",
	"test/desktop-notification.test.ts",
	"test/frame-rig.test.ts",
	"test/app.test.ts",
	"test/auto-copy.test.ts",
	"test/auto-mode.test.ts",
	"test/fixing-pull-request.test.ts",
	"test/handoff-frame.test.ts",
	"test/herdr-view-frame.test.ts",
	"test/ignored-ticket.test.ts",
	"test/key-guide.test.ts",
	"test/live-view.test.ts",
	"test/main-view-frame.test.ts",
	"test/message-line.test.ts",
	"test/repo-init-stub.test.ts",
	"test/missing-modal.test.ts",
	"test/muted-source.test.ts",
	"test/override-panel.test.ts",
	"test/placement-panel.test.ts",
	"test/plane-action-merge.test.ts",
	"test/repository-select-panel.test.ts",
	"test/reserved-rows.test.ts",
	"test/resize-subscriptions.test.ts",
	"test/shared-controls.test.ts",
	"test/shared-presentation.test.ts",
	"test/shared-field-editing.test.ts",
	"test/shared-gallery.test.ts",
	"test/starting-face.test.ts",
	"test/source-frame.test.ts",
	"test/turn-end-cause-frame.test.ts",
	"test/ticket-grouping-frame.test.ts",
	"test/ticket-scroll-frame.test.ts",
	"test/theme-frame.test.ts",
	"test/work-queue-frame.test.ts",
	// The migration adds a surface here, one at a time, as its tests move to
	// `pressControl` and the closed set of outcomes.
	//
	// test/ticket-boot-order-frame.test.ts stands outside this list: it drives
	// no input at all. It boots the plane and reads the painted list on every
	// pass of the frame stream without sending a key, and the rig owns the
	// input face, so there is no path here for the rig to own. If the suite
	// starts pressing, it joins this list.
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

/**
 * One lexical state of the wait-side rule's source walk.
 *
 * The walk tracks strings and comments, the way the input-side rules read
 * calls rather than spellings: a `frameUntil(` inside a string or a comment
 * is not a site, and a quote inside a comment opens no string.
 */
interface LexState {
	str: string | null;
	esc: boolean;
	block: boolean;
	line: boolean;
}

/** The state over a line comment, which ends at the line end. */
function stepLineComment(state: LexState, c: string): void {
	if (c === "\n") state.line = false;
}

/** The state over a block comment, which ends at the close marker. */
function stepBlockComment(state: LexState, c: string, next: string | undefined): void {
	if (c === "*" && next === "/") state.block = false;
}

/** The state over a string, which ends at its own quote. */
function stepString(state: LexState, c: string): void {
	if (state.esc) {
		state.esc = false;
		return;
	}
	if (c === "\\") {
		state.esc = true;
		return;
	}
	if (c === state.str) state.str = null;
}

/** True at the quote characters that open a string. */
const isQuote = (c: string): boolean => c === '"' || c === "'" || c === "`";
/** The brackets that open a group. */
const OPEN_BRACKET = "({[";
/** The brackets that close a group. */
const CLOSE_BRACKET = ")}]";

/**
 * Advance the state over one character, which is code when it
 * returns true: a character a string or comment consumes is not.
 */
function stepCode(state: LexState, c: string, next: string | undefined): boolean {
	if (state.line) {
		stepLineComment(state, c);
		return false;
	}
	if (state.block) {
		stepBlockComment(state, c, next);
		return false;
	}
	if (state.str !== null) {
		stepString(state, c);
		return false;
	}
	if (c === "/" && next === "/") {
		state.line = true;
		return false;
	}
	if (c === "/" && next === "*") {
		state.block = true;
		return false;
	}
	if (isQuote(c)) {
		state.str = c;
		return false;
	}
	return true;
}

/** The code mask: true at each character that stands outside a string and comment. */
function codeMask(source: string): boolean[] {
	const mask: boolean[] = new Array<boolean>(source.length).fill(false);
	const state: LexState = { str: null, esc: false, block: false, line: false };
	for (let i = 0; i < source.length; i += 1) {
		mask[i] = stepCode(state, source[i], source[i + 1]);
	}
	return mask;
}

/** The code paren that closes the one at `open`, or -1 when the call is unbalanced. */
function closeParen(source: string, mask: boolean[], open: number): number {
	let depth = 0;
	for (let j = open; j < source.length; j += 1) {
		if (!mask[j]) continue;
		if (source[j] === "(") depth += 1;
		if (source[j] === ")") {
			depth -= 1;
			if (depth === 0) return j;
		}
	}
	return -1;
}

/** The top-level arguments of a call's parenthesized list. */
function topArgs(call: string): string[] {
	const mask = codeMask(call);
	const args: string[] = [];
	let depth = 0;
	let cur = "";
	for (let j = 0; j < call.length; j += 1) {
		const c = call[j];
		if (!mask[j]) {
			cur += c;
			continue;
		}
		if (OPEN_BRACKET.includes(c)) depth += 1;
		if (CLOSE_BRACKET.includes(c)) depth -= 1;
		if (c === "," && depth === 0) {
			args.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	args.push(cur);
	while (args.length > 0 && args.at(-1)?.trim() === "") args.pop();
	return args.map((a) => a.trim());
}

/**
 * The `frameUntil` sites of one surface: each with its line and its
 * top-level arguments, so the rule classifies the predicate the call
 * actually passes, not one spelled beside it.
 */
function frameUntilSites(source: string): { line: number; args: string[] }[] {
	const mask = codeMask(source);
	const needle = "frameUntil(";
	const sites: { line: number; args: string[] }[] = [];
	for (let i = 0; i + needle.length <= source.length; i += 1) {
		if (!mask[i] || !source.startsWith(needle, i)) continue;
		const before = source[i - 1];
		if (before !== undefined && /[\w$.]/u.test(before)) continue;
		const open = i + "frameUntil".length;
		const close = closeParen(source, mask, open);
		if (close === -1) {
			throw new Error(
				`unbalanced frameUntil call at line ${source.slice(0, i).split("\n").length}`,
			);
		}
		sites.push({
			line: source.slice(0, i).split("\n").length,
			args: topArgs(source.slice(open + 1, close)),
		});
		i = close;
	}
	return sites;
}

/** The arrow's body, if the predicate is an inline single-parameter arrow. */
function inlineArrowBody(
	predicate: string,
): { param: string; negated: boolean; body: string } | null {
	const t = predicate.trim();
	const mParen = t.match(/^\((\w+)(:\s*string)?\)\s*=>\s*([\s\S]*)$/);
	const mBare = t.match(/^(\w+)\s*=>\s*([\s\S]*)$/);
	const param = mParen ? mParen[1] : mBare ? mBare[1] : null;
	const bodyRaw = mParen ? mParen[3] : mBare ? mBare[2] : null;
	if (param === null || bodyRaw === null) return null;
	const body = bodyRaw.trim();
	const negated = body.startsWith("!");
	return { param, negated, body: negated ? body.slice(1).trim() : body };
}

/**
 * Classify a wait predicate against the rig's named outcomes.
 *
 * The predicate is absorbable when its body is exactly one containment read
 * on the frame it waits, `frameText(p).includes(text)` or `p.includes(text)`,
 * optionally negated: `shows` names the read and `hides` names its negation.
 * A stored predicate, a compound fact, and a read of the frame's rows name
 * facts no single outcome names, so they stand outside the rule.
 */
function classifyContainment(predicate: string): "shows" | "hides" | null {
	const arrow = inlineArrowBody(predicate);
	if (arrow === null) return null;
	const arg =
		containmentArg(arrow.body, `frameText(${arrow.param}).includes(`) ??
		containmentArg(arrow.body, `${arrow.param}.includes(`);
	if (arg === null || hasLogicalOperator(arg)) return null;
	return arrow.negated ? "hides" : "shows";
}

/** True when the expression holds a `&&` or `||` outside a string. */
function hasLogicalOperator(expr: string): boolean {
	const mask = codeMask(expr);
	for (let j = 0; j < expr.length; j += 1) {
		if (!mask[j]) continue;
		const c = expr[j];
		if (c === "&" && expr[j + 1] === "&") return true;
		if (c === "|" && expr[j + 1] === "|") return true;
	}
	return false;
}

/**
 * The argument the containment call reads: the body must be exactly
 * `prefixARG` with nothing after the call's close paren.
 */
function containmentArg(body: string, prefix: string): string | null {
	if (!body.startsWith(prefix)) return null;
	const open = prefix.length - 1;
	const mask = codeMask(body);
	let depth = 0;
	for (let j = open; j < body.length; j += 1) {
		if (!mask[j]) continue;
		const c = body[j];
		if (c === "(") depth += 1;
		if (c !== ")") continue;
		depth -= 1;
		if (depth !== 0) continue;
		if (body.slice(j + 1).trim() !== "") return null;
		return body.slice(open + 1, j);
	}
	return null;
}

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

	test("an owned surface waits no inline containment the named outcomes name", () => {
		// The rig's wait is `frameUntil`, and the outcomes that name a frame's
		// containment are `shows` and `hides`. A surface that waits an inline
		// arrow whose body is exactly a containment read on the frame - negated
		// or not - waits a fact a named outcome already names: the wait is
		// private to the surface, and the deadline error reads the arrow back
		// instead of the fact the outcome would name. The rule reads the
		// predicate argument of every `frameUntil` call the surface makes, so a
		// stored predicate, a compound fact, and a read of the frame's rows
		// stand outside it.
		const offenders: string[] = [];
		for (const file of OWNED_SURFACES) {
			for (const site of frameUntilSites(readFileSync(file, "utf8"))) {
				const outcome = classifyContainment(site.args.at(-1) ?? "");
				if (outcome !== null) {
					offenders.push(
						`${file}:${site.line} waits on an inline containment read; the ${outcome} outcome names the fact`,
					);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the wait-side rule reads a containment arrow and passes the fact no outcome names", () => {
		// The rule's two edges, pinned on predicates the rule itself classifies:
		// an inline arrow that reads the frame's containment is the offender,
		// negated or not, typed or not, and every wait on a fact no single
		// outcome names stands outside the rule.
		expect(classifyContainment(`(f) => f.includes("Decision:")`)).toBe("shows");
		expect(classifyContainment(`(f) => !f.includes("Missing:")`)).toBe("hides");
		expect(classifyContainment(`(frame: string) => frameText(frame).includes("Live:")`)).toBe(
			"shows",
		);
		expect(
			classifyContainment(`(f) => f.includes("Decision:") && f.includes("review")`),
		).toBeNull();
		expect(classifyContainment(`settled`)).toBeNull();
		expect(classifyContainment(`(f) => rowsOf(f).some((row) => row.includes("x"))`)).toBeNull();
	});
});
