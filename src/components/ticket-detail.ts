/** The native, scrollable source and factory detail for the selected ticket. */
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

import type { ScrollConfig } from "../config.ts";
import type { Ticket } from "../domain/ticket.ts";
import { usePaneGeometry } from "./geometry.ts";
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

interface TicketDetailProps {
	ticket: Ticket | undefined;
	focused: boolean;
	/** False while a modal owns all input above the panes. */
	active: boolean;
	reservedRows: number;
	handoffLimit: number;
	scroll: ScrollConfig;
	onFocus: () => void;
}

/**
 * The complete detail stays mounted in OpenTUI's native scroll box. The box
 * translates and culls the viewport itself, so a rapid input burst never
 * replaces a React-owned visible-row window.
 */
export const TicketDetail = forwardRef<TicketDetailHandle, TicketDetailProps>(function TicketDetail(
	{ ticket, focused, active, reservedRows, handoffLimit, scroll, onFocus },
	ref,
) {
	const geometry = usePaneGeometry("detail", reservedRows);
	// The scroll box owns the gutter. Keep it even when content fits so a
	// later overflow cannot reflow the text. At one inner text column, remove
	// it so the control never consumes the last readable cell.
	const reserveGutter = geometry.usableCols >= 2;
	const textCols = Math.max(1, geometry.usableCols - (reserveGutter ? 1 : 0));
	const lines = detailLines(ticket, textCols, handoffLimit);
	const hasOverflow = lines.length > geometry.visibleRows;
	const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
	const previousIdentity = useRef(ticket?.identity);
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

	const handleMouse = (event: MouseEvent) => {
		if (!activeRef.current) {
			// The native handler runs after this listener. A zero multiplier
			// keeps a wheel event below a modal inert.
			multiplierRef.current = 0;
			return;
		}
		if (event.type !== "scroll") {
			onFocus();
			return;
		}
		const direction = event.scroll?.direction;
		if (event.modifiers.shift || (direction !== "up" && direction !== "down")) {
			multiplierRef.current = 0;
			return;
		}
		onFocus();
		const box = scrollboxRef.current;
		if (box === null) return;
		const maxScroll = Math.max(0, box.scrollHeight - box.viewport.height);
		const canMove = direction === "up" ? box.scrollTop > 0 : box.scrollTop < maxScroll;
		const rows = wheelRows(scrollRef.current, burstRef.current, direction, Date.now(), canMove);
		// OpenTUI supplies the event delta. Convert the desired whole-row step
		// to its multiplier so terminals that report a larger delta stay sane.
		multiplierRef.current = rows / Math.max(1, event.scroll?.delta ?? 1);
	};

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
