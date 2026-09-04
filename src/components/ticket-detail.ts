/** The native, scrollable source and factory detail for the selected ticket. */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createElement, useRenderer } from "@opentui/react";
import {
	forwardRef,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";

import type { ScrollConfig } from "../config.ts";
import type { LeftoverEnvironment, Ticket } from "../domain/ticket.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { paneMouse } from "./pane-mouse.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS, STATE_COLORS, stateBadge, taskTypeColor, ticketTaskType } from "./theme.ts";

export interface DetailLine {
	text: string;
	fg: string;
}

export function detailLines(
	ticket: Ticket | undefined,
	usableCols: number,
	handoffLimit: number,
): DetailLine[] {
	if (ticket === undefined) return [{ text: "no ticket selected", fg: COLORS.dim }];
	const lines: DetailLine[] = [];
	const pushWrapped = (text: string, fg: string) => {
		for (const line of wrapToWidth(text, usableCols)) lines.push({ text: line, fg });
	};
	pushWrapped(ticket.title, COLORS.textBright);
	pushWrapped(ticket.repository, COLORS.text);
	lines.push({ text: stateBadge(ticket.state), fg: STATE_COLORS[ticket.state] });
	pushWrapped(`Agent: ${ticket.handoff?.agentType ?? "unassigned"}`, COLORS.text);
	if (ticket.handoff !== null) {
		pushWrapped(`Environment: ${ticket.handoff.environment}`, COLORS.text);
	}
	// One explicit task type line for every ticket: the open ticket's
	// suggestion, or the recorded handoff's task type. The label says which
	// fact it is, so routing never reads as history.
	const presentation = ticketTaskType(ticket);
	pushWrapped(
		`${ticket.state === "open" ? "Suggested" : "Handoff"} task type: ${presentation.value}`,
		taskTypeColor(presentation),
	);
	pushWrapped(`Handoffs: ${ticket.handoffCount}/${handoffLimit}`, COLORS.text);
	// A leftover environment is what a closed cycle still has running in
	// herdr. The detail names it, says when the control plane learned of it,
	// and says what the operator can do, so the ticket itself carries the
	// fact instead of a Message line that fades.
	const leftover = ticket.leftover;
	if (leftover !== null) {
		const at = leftover.at === "" ? "" : ` ${leftover.at.slice(0, 16).replace("T", " ")}`;
		// The warning color is the block's indent: the wrap drops leading
		// spaces, and a dim run would read on as one flat line with the rest
		// of the detail. The block is one warning the operator can act on.
		pushWrapped(
			`Leftover: ${leftoverWhere(leftover)} is still open for this ticket`,
			COLORS.statusWarning,
		);
		pushWrapped(`since${at}: ${leftover.reason}`, COLORS.statusWarning);
		pushWrapped("press w to clear it", COLORS.statusWarning);
	}
	if (ticket.lastCompletion !== null) {
		const completion = ticket.lastCompletion;
		// The date is the first minute of the stored completion time; the
		// decision is `pending` until one is made on the turn.
		const date = completion.completedAt.slice(0, 16).replace("T", " ");
		const decision = completion.decision ?? "pending";
		pushWrapped(
			`Last completion: ${date} ${completion.taskType} by ${completion.agentName} (${completion.agentType}) ${decision}`,
			COLORS.text,
		);
		for (const line of completion.message.split("\n")) {
			for (const wrapped of wrapToWidth(line, usableCols))
				lines.push({ text: wrapped, fg: COLORS.dim });
		}
	}
	pushWrapped(`Source kind: ${ticket.sourceKind}`, COLORS.text);
	pushWrapped(`External key: ${ticket.externalKey}`, COLORS.text);
	pushWrapped(`Source state: ${ticket.sourceState}`, COLORS.text);
	pushWrapped(`Source URL: ${ticket.url}`, COLORS.text);
	pushWrapped(`Labels: ${ticket.labels.join(", ") || "none"}`, COLORS.text);
	for (const membership of ticket.memberships) {
		pushWrapped(
			`Source ${membership.sourceName}: ${membership.health}`,
			membership.health === "stale" ? COLORS.statusWarning : COLORS.dim,
		);
	}
	if (ticket.handoffRecoveryRequired)
		pushWrapped("Handoff: recovery required", COLORS.statusWarning);
	lines.push({ text: " ", fg: COLORS.dim });
	pushWrapped(ticket.description, COLORS.dim);
	return lines.map((line) => ({ text: truncateToWidth(line.text, usableCols), fg: line.fg }));
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
		detailLines(ticket, detailTextCols(usableCols), handoffLimit).length,
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
	{ ticket, focused, active, reservedRows, handoffLimit, scroll, onFocus, scrollSlot },
	ref,
) {
	const geometry = usePaneGeometry("detail", reservedRows);
	// The renderer reports the frame it has laid out, which is when the scroll
	// box first knows its own content height and viewport.
	const renderer = useRenderer();
	// The scroll box owns the gutter; see `detailTextCols`.
	const textCols = detailTextCols(geometry.usableCols);
	const reserveGutter = textCols < geometry.usableCols;
	const lines = detailLines(ticket, textCols, handoffLimit);
	const hasOverflow = lines.length > geometry.visibleRows;
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
	// timer while the operator watches. This runs on mount only: a plain ticket
	// switch keeps its own start-at-top behavior.
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
			box.scrollTop = Math.min(live.top, maxScrollOf(box.scrollHeight, box.viewport.height));
			// The pass has run: a later frame must not drag the scroll back to
			// the offset the operator has since moved on from.
			scrollSlot.current = null;
		};
		renderer.once("frame", restore);
		return () => {
			renderer.removeListener("frame", restore);
		};
	}, [renderer, scrollSlot]);

	// Save the native offset when the pane unmounts, keyed by the identity it
	// showed, so a remount of another ticket starts at its own position.
	useEffect(() => {
		const box = scrollboxRef.current;
		return () => {
			const identity = identityRef.current;
			if (box === null || identity === undefined) return;
			scrollSlot.current = { identity, top: box.scrollTop };
		};
	}, [scrollSlot]);

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
			backgroundColor: hasOverflow ? COLORS.dim : "transparent",
			foregroundColor: hasOverflow ? COLORS.borderFocused : "transparent",
		},
	};

	return createElement(
		"scrollbox",
		{
			ref: scrollboxRef,
			id: "ticket-detail",
			title: focused ? "❯ Detail" : "  Detail",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			// A left click gives this scroll box OpenTUI's own focus, and a box
			// that holds it paints its border with focusedBorderColor instead of
			// borderColor. That focus outlives the app's pane focus, so the border
			// would stay blue on a deactivated pane. Pane focus is app state; both
			// border colors follow it.
			focusedBorderColor: focused ? COLORS.borderFocused : COLORS.border,
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
		...lines.map((line, index) =>
			createElement("text", { key: `detail-${index}`, fg: line.fg }, line.text),
		),
	);
});
