/** The native, scrollable source and factory detail for the selected ticket. */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createElement, useRenderer } from "@opentui/react";
import {
	Fragment,
	forwardRef,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";

import type { ScrollConfig } from "../config.ts";
import { isHeldCompletion, type LeftoverEnvironment, type Ticket } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import { prioritySourceWord } from "../priority.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { paneMouse } from "./pane-mouse.ts";
import { ChoiceRow } from "./shared/choices.ts";
import { MARKER_WIDTH, turnEndCauseLine } from "./shared/presentation.ts";
import { Spinner } from "./shared/spinner.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import {
	BADGE_WIDTH,
	paint,
	STARTING_WORD,
	stateBadge,
	stateColor,
	taskTypeColor,
	ticketTaskType,
} from "./theme.ts";

export interface DetailLine {
	text: string;
	fg: string | undefined;
	/** The emphasis the old palette carried in a brighter text color. */
	bold?: boolean;
	/**
	 * The state line is the spinner face of the ticket's Starting window
	 * (ADR 0030). The pane renders the shared spinner control in the line's
	 * place, so the face the list row wears is the control itself here, and
	 * the text the line carries is unused.
	 */
	spinner?: boolean;
}

/**
 * The detail pane's content: the text lines, and the row the shared choice
 * row of the Priority override takes among them (ADR 0022).
 *
 * The choice row is a renderable, not a line of text: the scroll box lays it
 * out like the lines, and `rows` is what the Scroll control asks for, so the
 * control never promises a scroll the real ScrollBox does not have.
 */
export interface DetailContent {
	lines: DetailLine[];
	/** The line index the Priority override row is inserted after, or -1. */
	choiceIndex: number;
	/** The value the override row states, `default` for an unset override. */
	choiceValue: string;
	/** The rows the content takes, the choice row counted in. */
	rows: number;
}

/**
 * The Handoff settings the detail rows show: a resolved choice for the next
 * Handoff, or the choices a started Handoff was recorded with.
 */
type DetailChoice = Pick<
	HandoffChoice,
	"agentType" | "environment" | "model" | "thinking" | "contextWindow"
>;

/**
 * Pick the Handoff whose settings the rows show, with the Ticket state as the
 * switch. An open Ticket starts `suggestedChoice`, so that is what an open
 * Ticket shows: a close ends a work cycle and returns the ticket to `open`
 * while its last Handoff's record stays, and showing that record would state
 * settings Enter does not start. Every other state sits inside a cycle one
 * Handoff started, so it shows that Handoff's own recorded settings.
 */
function detailChoice(ticket: Ticket, suggestedChoice?: HandoffChoice): DetailChoice | undefined {
	return ticket.state === "open" ? suggestedChoice : (ticket.handoff ?? undefined);
}

/**
 * The fact row of the ticket's effective priority (ADR 0022): the rank's
 * label and where it comes from - the operator's override, or the ticket's
 * own label. An override that names no rank - `off`, or a label the config
 * list dropped - states its stored label in the Override row's own words,
 * so the fact line and the selector row agree on the stored fact. An
 * unranked ticket without one reads `none`.
 */
function priorityFact(ticket: Ticket): { text: string; fg: string | undefined } {
	if (ticket.priority.rank !== null) {
		const word = prioritySourceWord(ticket.priority);
		const label = ticket.priority.label ?? "none";
		return { text: word === null ? label : `${label} (${word})`, fg: paint("text") };
	}
	if (ticket.priority.label !== null)
		return { text: `${ticket.priority.label} (set by you)`, fg: paint("text") };
	return { text: "none", fg: paint("subtext0") };
}

export function detailContent(
	ticket: Ticket | undefined,
	usableCols: number,
	handoffLimit: number,
	suggestedChoice?: HandoffChoice,
	priorityOverride: string | null = null,
	starting: boolean = false,
): DetailContent {
	if (ticket === undefined)
		return {
			lines: [{ text: "no ticket selected", fg: paint("subtext0") }],
			choiceIndex: -1,
			choiceValue: "default",
			rows: 1,
		};
	const lines: DetailLine[] = [];
	// The index of the Priority fact row: the override's choice row is
	// inserted right after it.
	let choiceIndex = -1;
	const pushWrapped = (text: string, fg: string | undefined, bold?: boolean) => {
		for (const line of wrapToWidth(text, usableCols))
			lines.push({ text: line, fg, ...(bold ? { bold: true } : {}) });
	};
	pushWrapped(ticket.title, paint("text"), true);
	pushWrapped(ticket.repository, paint("text"));
	// The Starting window (ADR 0030) takes the state line's slot in place of
	// the badge, the same face the list row wears, so the list and the detail
	// never disagree. The `[handed-off]` badge is never drawn.
	if (starting) lines.push({ text: " ", fg: undefined, spinner: true });
	else lines.push({ text: stateBadge(ticket.state), fg: stateColor(ticket.state) });
	const choice = detailChoice(ticket, suggestedChoice);
	pushWrapped(`Agent: ${choice?.agentType ?? "unassigned"}`, paint("text"));
	if (choice !== undefined) {
		// The Environment rides beside the Agent, the way the override panel
		// orders its rows: where a Handoff runs, then what it runs with. The
		// same choice carries it, so an open Ticket shows the Environment Enter
		// starts in rather than the one a closed cycle happened to use.
		pushWrapped(`Environment: ${choice.environment}`, paint("text"));
		const left = (value: string) => (value === "" ? "left to agent" : value);
		// The three settings a Task profile carries, each dim when the
		// resolved choice leaves it to the Agent.
		for (const [label, value] of [
			["Model", choice.model],
			["Thinking", choice.thinking],
			["Context", choice.contextWindow],
		] as const) {
			pushWrapped(`${label}: ${left(value)}`, value === "" ? paint("subtext0") : paint("text"));
		}
	}
	// One explicit task type line for every ticket: the open ticket's
	// suggestion, or the recorded handoff's task type. The label says which
	// fact it is, so routing never reads as history.
	const presentation = ticketTaskType(ticket);
	pushWrapped(
		`${ticket.state === "open" ? "Suggested" : "Handoff"} task type: ${presentation.value}`,
		taskTypeColor(presentation),
	);
	pushWrapped(`Handoffs: ${ticket.handoffCount}/${handoffLimit}`, paint("text"));
	// The effective rank and where it comes from, beside the task type the
	// rank orders: the operator reads what the bump will move from (ADR 0022).
	const fact = priorityFact(ticket);
	choiceIndex = lines.length;
	// When the rank is inherited, the fact names the issue that supplied it:
	// `Priority: critical (issue #123)` (ADR 0023).
	lines.push({ text: `Priority: ${fact.text}`, fg: fact.fg });
	// A leftover environment is what a closed cycle still has running in
	// herdr. The detail names it, says when the control plane learned of it,
	// and says where its cleanup lives - in herdr, not in the control plane
	// (ADR 0032) - so the ticket itself carries the fact instead of a
	// Message line that fades.
	const leftover = ticket.leftover;
	if (leftover !== null) {
		const at = leftover.at === "" ? "" : ` ${leftover.at.slice(0, 16).replace("T", " ")}`;
		// The warning color is the block's indent: the wrap drops leading
		// spaces, and a dim run would read on as one flat line with the rest
		// of the detail. The block is one warning the operator can act on.
		pushWrapped(
			`Leftover: ${leftoverWhere(leftover)} is still open for this ticket`,
			paint("yellow"),
		);
		pushWrapped(`since${at}: ${leftover.reason}`, paint("yellow"));
		// The control plane keeps no clear for it; the Consultation detail
		// states the same pointer for its remaining resources.
		pushWrapped("its cleanup runs in herdr", paint("yellow"));
	}
	if (ticket.lastCompletion !== null) {
		const completion = ticket.lastCompletion;
		// The held-turn warning (ADR 0016): the turn ended without completing
		// and now blocks the automatic decisions. It stands above the
		// last-completion line, so the warning reads before the fact it
		// warns on, and it wears the warning color of the Leftover block above:
		// the turn needs the operator, and red stays reserved for a pane that
		// is gone. The last line states what the control plane refuses to do.
		// It only shows while the ticket rests in awaiting: a held turn whose
		// agent works again is retried, not held, and the pane says so without
		// a warning.
		if (ticket.state === "awaiting" && isHeldCompletion(ticket.lastCompletion)) {
			const causeLine = turnEndCauseLine(completion.cause, completion.detail);
			for (const wrapped of wrapToWidth(causeLine, usableCols))
				lines.push({ text: wrapped, fg: paint("yellow") });
			pushWrapped("no automatic decision runs on this turn", paint("yellow"));
		}
		// The date is the first minute of the stored completion time; the
		// decision is `pending` until one is made on the turn.
		const date = completion.completedAt.slice(0, 16).replace("T", " ");
		const decision = completion.decision ?? "pending";
		pushWrapped(
			`Last completion: ${date} ${completion.taskType} by ${completion.agentName} (${completion.agentType}) ${decision}`,
			paint("text"),
		);
		for (const line of completion.message.split("\n")) {
			for (const wrapped of wrapToWidth(line, usableCols))
				lines.push({ text: wrapped, fg: paint("subtext0") });
		}
	}
	pushWrapped(`Source kind: ${ticket.sourceKind}`, paint("text"));
	pushWrapped(`External key: ${ticket.externalKey}`, paint("text"));
	pushWrapped(`Source state: ${ticket.sourceState}`, paint("text"));
	pushWrapped(`Source URL: ${ticket.url}`, paint("text"));
	pushWrapped(`Labels: ${ticket.labels.join(", ") || "none"}`, paint("text"));
	for (const membership of ticket.memberships) {
		pushWrapped(
			`Source ${membership.sourceName}: ${membership.health}`,
			membership.health === "stale" ? paint("yellow") : paint("subtext0"),
		);
	}
	if (ticket.handoffRecoveryRequired) pushWrapped("Handoff: recovery required", paint("yellow"));
	lines.push({ text: " ", fg: paint("subtext0") });
	pushWrapped(ticket.description, paint("subtext0"));
	const truncated = lines.map((line) => ({
		text: truncateToWidth(line.text, usableCols),
		fg: line.fg,
		bold: line.bold,
		...(line.spinner === true ? { spinner: true } : {}),
	}));
	return {
		lines: truncated,
		choiceIndex,
		choiceValue: priorityOverride === null ? "default" : priorityOverride,
		rows: truncated.length + 1,
	};
}

export function detailLines(
	ticket: Ticket | undefined,
	usableCols: number,
	handoffLimit: number,
	suggestedChoice?: HandoffChoice,
	priorityOverride: string | null = null,
	starting: boolean = false,
): DetailLine[] {
	return detailContent(
		ticket,
		usableCols,
		handoffLimit,
		suggestedChoice,
		priorityOverride,
		starting,
	).lines;
}

/**
 * Where a leftover environment still lives, in the handles herdr gave it.
 *
 * The workspace is what the operator looks for in herdr; the pane is what
 * still holds the ticket's agent name, so a live one is worth naming.
 */
export function leftoverWhere(leftover: LeftoverEnvironment): string {
	const handles: string[] = [];
	if (leftover.workspaceId !== null) handles.push(`herdr workspace ${leftover.workspaceId}`);
	if (leftover.tabId !== null) handles.push(`tab ${leftover.tabId}`);
	if (leftover.paneId !== null) handles.push(`pane ${leftover.paneId}`);
	if (handles.length > 0) return handles.join(", ");
	return `the ${leftover.environment} environment of its last handoff`;
}

/** The pause after which a wheel burst starts with a precise base step. */
export const WHEEL_ACCELERATION_PAUSE_MS = 150;

type WheelDirection = "up" | "down";

/** Mutable wheel-burst history. Kept outside React so scrolling does not rerender detail rows. */
export interface WheelBurst {
	direction?: WheelDirection;
	lastAt?: number;
	intervals: number[];
}

/** Start an empty, precise wheel burst. */
export function newWheelBurst(): WheelBurst {
	return { intervals: [] };
}

/** Clear a burst when an edge, a direct position action, or a key breaks it. */
export function resetWheelBurst(burst: WheelBurst): void {
	burst.direction = undefined;
	burst.lastAt = undefined;
	burst.intervals = [];
}

/**
 * Resolve one wheel event to a whole-row movement.
 *
 * The first event after the fixed pause is the configured base speed. Later
 * events use the moving average of their frequency. This keeps slow wheels
 * precise and lets a tight trackpad or wheel burst approach the configured
 * maximum. A blocked event resets instead of banking speed for the next one.
 */
export function wheelRows(
	settings: ScrollConfig,
	burst: WheelBurst,
	direction: WheelDirection,
	now: number,
	canMove: boolean,
): number {
	if (!canMove) {
		resetWheelBurst(burst);
		return 0;
	}
	const isFirst =
		burst.direction !== direction ||
		burst.lastAt === undefined ||
		now - burst.lastAt > WHEEL_ACCELERATION_PAUSE_MS;
	if (isFirst) {
		burst.direction = direction;
		burst.lastAt = now;
		burst.intervals = [];
		return settings.speed;
	}

	const interval = Math.max(1, now - (burst.lastAt ?? now));
	burst.direction = direction;
	burst.lastAt = now;
	burst.intervals = [...burst.intervals.slice(-2), interval];
	if (settings.acceleration === 0 || settings.maximumSpeed === settings.speed) {
		return settings.speed;
	}
	const averageInterval =
		burst.intervals.reduce((sum, value) => sum + value, 0) / burst.intervals.length;
	// This is the same frequency-shaped curve OpenTUI uses for its native
	// acceleration. The Config values set the curve strength and the final cap.
	const multiplier = 1 + settings.acceleration * (Math.exp(100 / averageInterval / 3) - 1);
	return Math.min(
		settings.maximumSpeed,
		Math.max(settings.speed, Math.round(settings.speed * multiplier)),
	);
}

export interface TicketDetailHandle {
	moveBy(rows: number): void;
	movePage(direction: WheelDirection): void;
	toStart(): void;
	toEnd(): void;
}

/**
 * The columns the detail can draw text in, at one usable width.
 *
 * The scrollbar gutter is kept even when the content fits, so a later
 * overflow cannot reflow the text; at one inner text column it is dropped,
 * because the control must not consume the last readable cell. The rule
 * lives here once: `detailScrollRoom` measures with it and the pane draws
 * with it, so the shell can never promise a scroll the ScrollBox does not
 * have.
 */
function detailTextCols(usableCols: number): number {
	return Math.max(1, usableCols - (usableCols >= 2 ? 1 : 0));
}

/**
 * The rows the detail can still scroll, measured the way the pane measures
 * its own content.
 *
 * The app's Scroll control asks this instead of repeating the pane's
 * arithmetic: a copy of the gutter rule would let the control promise a
 * scroll the real ScrollBox does not have.
 */
export function detailScrollRoom(
	ticket: Ticket | undefined,
	usableCols: number,
	visibleRows: number,
	handoffLimit: number,
): number {
	return maxScrollOf(
		detailContent(ticket, detailTextCols(usableCols), handoffLimit).rows,
		visibleRows,
	);
}

interface TicketDetailProps {
	ticket: Ticket | undefined;
	focused: boolean;
	/** False while a modal owns all input above the panes. */
	active: boolean;
	reservedRows: number;
	handoffLimit: number;
	/**
	 * The ticket's stored Priority override (ADR 0022): a rank label name, or
	 * `off`, or null for the default. The override row states it.
	 */
	priorityOverride: string | null;
	/** The resolved choice for an open Ticket's suggested Task type. */
	suggestedChoice?: HandoffChoice;
	/**
	 * Whether the ticket's Starting window (ADR 0030) is open against the
	 * app's facts, with the failure marker already ruled out: the state line
	 * wears the spinner face the list row wears in place of the badge.
	 */
	starting: boolean;
	scroll: ScrollConfig;
	onFocus: () => void;
	/**
	 * The native offset a remount of the same ticket resumes from. The app
	 * unmounts this pane below the minimum size; the slot survives that round
	 * trip, and ScrollBox clamps a stale offset to the new viewport.
	 */
	scrollSlot: RefObject<{ identity: string; top: number } | null>;
}

/**
 * The complete detail stays mounted in OpenTUI's native scroll box. The box
 * translates and culls the viewport itself, so a rapid input burst never
 * replaces a React-owned visible-row window.
 */
export const TicketDetail = forwardRef<TicketDetailHandle, TicketDetailProps>(function TicketDetail(
	{
		ticket,
		focused,
		active,
		reservedRows,
		handoffLimit,
		priorityOverride,
		suggestedChoice,
		starting,
		scroll,
		onFocus,
		scrollSlot,
	},
	ref,
) {
	const geometry = usePaneGeometry("detail", reservedRows);
	// The renderer reports the frame it has laid out, which is when the scroll
	// box first knows its own content height and viewport.
	const renderer = useRenderer();
	// The scroll box owns the gutter; see `detailTextCols`.
	const textCols = detailTextCols(geometry.usableCols);
	const reserveGutter = textCols < geometry.usableCols;
	const content = detailContent(
		ticket,
		textCols,
		handoffLimit,
		suggestedChoice,
		priorityOverride,
		starting,
	);
	const lines = content.lines;
	const hasOverflow = content.rows > geometry.visibleRows;
	// The detail pane's Priority selector on the standard choice row (ADR
	// 0022): its value is the stored override, default when the ticket holds
	// none. The Select priority control steps it - the ranks in order, off,
	// and default - and each step writes the value it shows; the bump and
	// clear keys move the same value. It wears the pane's focus, because in
	// the detail pane it is the row the keys act on.
	const choiceRow =
		content.choiceIndex === -1
			? null
			: createElement(ChoiceRow, {
					label: "Override",
					value: content.choiceValue,
					focused: focused,
					labelWidth: Math.min(10, Math.max(1, textCols - MARKER_WIDTH - 1)),
					width: Math.max(
						1,
						textCols - MARKER_WIDTH - Math.min(10, Math.max(1, textCols - MARKER_WIDTH - 1)),
					),
				});
	const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
	const previousIdentity = useRef(ticket?.identity);
	// Always the identity the pane currently shows; the unmount cleanup reads
	// it so it never saves an offset under a switched identity.
	const identityRef = useRef(ticket?.identity);
	identityRef.current = ticket?.identity;
	const activeRef = useRef(active);
	const scrollRef = useRef(scroll);
	const burstRef = useRef<WheelBurst>(newWheelBurst());
	const multiplierRef = useRef(1);
	activeRef.current = active;
	scrollRef.current = scroll;

	// OpenTUI asks this object for a multiplier after our mouse handler has
	// resolved the Config policy. It then applies native viewport translation
	// and culling, without a React render for each moved row.
	const nativeAcceleration = useRef({
		tick: () => multiplierRef.current,
		reset: () => resetWheelBurst(burstRef.current),
	}).current;

	const resetBurst = useCallback(() => {
		resetWheelBurst(burstRef.current);
		multiplierRef.current = 1;
	}, []);
	const moveBy = useCallback(
		(rows: number) => {
			resetBurst();
			scrollboxRef.current?.scrollBy(rows);
		},
		[resetBurst],
	);
	const toStart = useCallback(() => {
		resetBurst();
		const box = scrollboxRef.current;
		if (box !== null) box.scrollTop = 0;
	}, [resetBurst]);
	const toEnd = useCallback(() => {
		resetBurst();
		const box = scrollboxRef.current;
		if (box !== null) box.scrollTop = box.scrollHeight;
	}, [resetBurst]);

	useImperativeHandle(
		ref,
		() => ({
			moveBy,
			movePage: (direction) => moveBy((geometry.visibleRows - 1) * (direction === "down" ? 1 : -1)),
			toStart,
			toEnd,
		}),
		[geometry.visibleRows, moveBy, toEnd, toStart],
	);

	// A different ticket always opens at its start. Replacing facts of the
	// same identity and a terminal resize leave the native offset in place;
	// ScrollBox clamps it when its content or viewport changes.
	useEffect(() => {
		if (previousIdentity.current !== ticket?.identity) {
			previousIdentity.current = ticket?.identity;
			toStart();
		}
	}, [ticket?.identity, toStart]);

	// A below-minimum resize unmounts the pane. On the next mount of the same
	// ticket, resume from the offset the unmount saved. That offset was taken at
	// another size, where the same body wrapped to a different number of rows,
	// so the pane compares it with what the new layout allows and takes the
	// nearer end. The renderer reports a frame once it has laid the tree out,
	// which is the first moment the box knows its own content height and
	// viewport, so the restore waits for that one pass instead of asking on a
	// timer while the operator watches.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the identity in the deps list is deliberate - the effect reads refs only, and it must re-run when a switch lands back on the retained ticket, not only on mount
	useEffect(() => {
		const box = scrollboxRef.current;
		const slot = scrollSlot.current;
		const identity = identityRef.current;
		if (box === null || slot === null || identity === undefined) return;
		if (slot.identity !== identity || slot.top === 0) return;
		const restore = () => {
			if (identityRef.current !== identity) return;
			const live = scrollSlot.current;
			if (live === null || live.identity !== identity) return;
			const max = maxScrollOf(box.scrollHeight, box.viewport.height);
			// A cross back through the other section can remount the pane before
			// the renderer has laid it out at its new size. Until the first frame
			// with real geometry, an offset would clamp to zero and be lost.
			if (max === 0) {
				renderer.once("frame", restore);
				return;
			}
			box.scrollTop = Math.min(live.top, max);
			// The pass has run: a later frame must not drag the scroll back to
			// the offset the operator has since moved on from.
			scrollSlot.current = null;
		};
		renderer.once("frame", restore);
		return () => {
			renderer.removeListener("frame", restore);
		};
		// The pane is one instance for the whole section, so the effect must
		// re-run when a switch lands on the retained ticket, not only on mount.
	}, [renderer, scrollSlot, ticket?.identity]);

	// The slot keeps the offset of the ticket the operator scrolled. A ticket
	// switch saves the offset the pane leaves behind, but a switch at top never
	// clobbers a scrolled offset: the cross into the other section walks
	// through the rest of the list, and the walked rows must not erase the
	// row the operator left behind. The identity change runs the previous
	// render's cleanup, so a plain switch saves the old identity and the true
	// unmount saves the current one.
	useEffect(() => {
		const box = scrollboxRef.current;
		return () => {
			const identity = ticket?.identity;
			if (box === null || identity === undefined) return;
			const top = box.scrollTop;
			const live = scrollSlot.current;
			if (live !== null && live.identity !== identity && top === 0) return;
			scrollSlot.current = { identity, top };
		};
	}, [scrollSlot, ticket?.identity]);

	// Slider track clicks stop propagation inside OpenTUI so they can start a
	// drag. Listen on the slider itself as well, which keeps pane focus in
	// agreement with a direct track or thumb action.
	useEffect(() => {
		const slider = scrollboxRef.current?.verticalScrollBar.slider;
		if (slider === undefined) return;
		slider.onMouse = () => {
			if (activeRef.current) onFocus();
		};
		return () => {
			slider.onMouse = undefined;
		};
	}, [onFocus]);

	const handleMouse = paneMouse({
		active: () => activeRef.current,
		onFocus,
		onWheel: (direction, event) => {
			const box = scrollboxRef.current;
			if (box === null) return;
			const maxScroll = Math.max(0, box.scrollHeight - box.viewport.height);
			const canMove = direction === "up" ? box.scrollTop > 0 : box.scrollTop < maxScroll;
			const rows = wheelRows(scrollRef.current, burstRef.current, direction, Date.now(), canMove);
			// OpenTUI supplies the event delta. Convert the desired whole-row
			// step to its multiplier so terminals that report a larger delta
			// stay sane.
			multiplierRef.current = rows / Math.max(1, event.scroll?.delta ?? 1);
		},
		onWheelBlocked: () => {
			// The native handler runs after this listener. A zero multiplier
			// keeps a blocked wheel turn inert: shifted, horizontal, or a
			// modal above the panes.
			multiplierRef.current = 0;
		},
	});

	const scrollbarOptions = {
		visible: reserveGutter,
		width: reserveGutter ? 1 : 0,
		showArrows: false,
		trackOptions: {
			// The native Slider paints its track with background color and its
			// thumb with foreground color. A fitting detail has a blank but still
			// reserved gutter.
			backgroundColor: hasOverflow ? (paint("subtext0") ?? "transparent") : "transparent",
			foregroundColor: hasOverflow ? (paint("accent") ?? "transparent") : "transparent",
		},
	};

	return createElement(
		"scrollbox",
		{
			ref: scrollboxRef,
			id: "ticket-detail",
			title: focused ? "❯ Detail" : "  Detail",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			// A left click gives this scroll box OpenTUI's own focus, and a box
			// that holds it paints its border with focusedBorderColor instead of
			// borderColor. That focus outlives the app's pane focus, so the border
			// would stay blue on a deactivated pane. Pane focus is app state; both
			// border colors follow it.
			focusedBorderColor: focused ? paint("accent") : paint("surface_dim"),
			// At normal widths the detail keeps one padding cell around text.
			// At tiny widths, yield right then left padding before the only text
			// column. The gutter has already yielded there.
			paddingTop: 1,
			paddingBottom: 1,
			paddingLeft: geometry.paneCols >= 4 ? 1 : 0,
			paddingRight: geometry.paneCols >= 5 ? 1 : 0,
			scrollX: false,
			scrollY: true,
			viewportCulling: true,
			scrollAcceleration: nativeAcceleration,
			verticalScrollbarOptions: scrollbarOptions,
			horizontalScrollbarOptions: { visible: false },
			onMouse: handleMouse,
			onKeyDown: (key: { preventDefault: () => void }) => key.preventDefault(),
			// ScrollBox itself must remain a row: its wrapper and native vertical
			// scrollbar are siblings. The content inside the wrapper is a column.
			style: { flexGrow: 1, flexShrink: 1, overflow: "hidden" },
		},
		...lines.flatMap((line, index) => [
			line.spinner === true
				? createElement(Spinner, {
						key: `detail-${index}`,
						word: STARTING_WORD,
						width: BADGE_WIDTH,
					})
				: createElement(
						"text",
						{ key: `detail-${index}`, fg: line.fg },
						line.bold ? createElement("b", undefined, line.text) : line.text,
					),
			...(index === content.choiceIndex && choiceRow !== null
				? [createElement(Fragment, { key: "priority-override" }, choiceRow)]
				: []),
		]),
	);
});
