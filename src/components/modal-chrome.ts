/**
 * The chrome every modal and overlay shares: its surface, its box, its
 * action rows, and its scrollbar.
 *
 * One shape for all of them, because the rules are the same everywhere:
 *
 * - The Message line and the Action bar own the surface's last two rows, at
 *   every terminal size and in every surface, so the operator reads the same
 *   Message the base frame shows. A box never paints on either row.
 * - The box pays for those rows by giving up its margin first and its
 *   padding second. An action row is the only way out of a modal, so an
 *   action row is the last thing to go.
 * - A surface that cannot show its own rows shows the size message instead.
 *   A clipped modal is a broken pane, and a broken pane is not an answer to
 *   a small terminal (user story 71).
 * - A surface is handed no more rows than its box holds. OpenTUI lays a child
 *   out wherever the flex puts it rather than clipping it to the box, so a
 *   body that overflowed would paint through the border and the bar: every
 *   surface counts its rows against `contentRows` and drops the rest.
 */
import { createElement } from "@opentui/react";
import { Fragment, type ReactElement, useEffect, useState } from "react";

import { ActionBar } from "./action-bar.ts";
import type { ControlContext, InteractionMode } from "./controls.ts";
import { maxScrollOf } from "./geometry.ts";
import { type MessageFact, messageRowElement } from "./messages.ts";
import { controlInk } from "./shared/presentation.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { paint } from "./theme.ts";

/** The smallest terminal width the control plane draws its panes at. */
const MIN_TERMINAL_WIDTH = 40;
/**
 * The smallest terminal height the control plane draws its panes at.
 *
 * Both Main sections start expanded, and each must shrink to its usable
 * minimum instead of disappearing: a section costs one header row, and its
 * box costs two border rows and two padding rows around its three minimum
 * content rows. The two sections cost sixteen body rows, and the permanent
 * Message line, Action bar, and mode line add three more: nineteen rows is
 * the shortest terminal that holds both sections at their minimum.
 */
const MIN_TERMINAL_HEIGHT = 19;
/** The row every surface's Message line owns. */
const MESSAGE_ROWS = 1;
/** The row every surface with a bar owns. */
const BAR_ROWS = 1;
/** The modal chrome: one border on each side. */
const BORDERS = 2;
/** The padding cells a box keeps when it can pay for them, per side. */
const PADDING = 1;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
export const MARKER_WIDTH = 2;
/** One confirmable action, with its label and an optional detail. */
export interface ActionRow {
	key: string;
	label: string;
	detail?: string;
	/** The row starts a Handoff whose settings `e` edits before it starts. */
	editable?: boolean;
}

/**
 * The border title of the Decision modal, in its own prefix.
 *
 * The prefix is the chrome's: the modal opened on an `awaiting` ticket and
 * the Live view that settles under an open screen both name their box this
 * way, so the two paths into the decision end at one screen with one name
 * (ADR 0040).
 */
export function decisionTitle(title: string): string {
	return `Decision: ${title}`;
}

/**
 * The border title of the Live view in its streaming sub-mode.
 *
 * A turn settling for the operator re-titles the same box to
 * `decisionTitle` in place: one screen, one name per sub-mode, the prefix
 * the shared chrome owns in both.
 */
export function liveTitle(title: string): string {
	return `Live: ${title}`;
}

/** The pane's border title over the agent's streaming terminal (ADR 0039). */
export const AGENT_VIEW_PANE = "Agent view";
/** The pane's border title over the settled turn's log (ADR 0039). */
export const TURN_LOG_PANE = "Turn log";

/**
 * The one Body a modal box can hold.
 *
 * The box is the chrome's, and a surface cannot hand it a box of its own: it
 * hands the chrome its rows in the stated places. The rows above the pane
 * stand under the box's border (the context row), the pane holds one body by
 * itself - the Turn log, or the Agent view - under its own border and title,
 * and the rows below the pane are the region's: the held cause row and the
 * rows the operator confirms (ADR 0039). A surface with no long body holds
 * no pane and puts every row below, the way the Missing modal and the
 * action panels do: the pane is opt-in, and no surface is forced to draw an
 * empty one.
 */
export interface ModalBody {
	/** The rows above the pane, under the box's border. */
	above: ReactElement[];
	/** The Body pane, when the surface holds one. */
	pane?: {
		/** The body's name: the title the pane's border carries. */
		title: string;
		/** The rows the pane's border holds, in order, windowed to its rows. */
		rows: ReactElement[];
		/** The pane's padding cells per side: 1 with its full chrome, 0 where the layout has yielded it. */
		vpad: 0 | 1;
		/** The pane's outer height, border and padding included: the rows the layout reserved it. */
		height: number;
	};
	/** The rows below the pane: the held cause row, then the region's rows. */
	below: ReactElement[];
	/** The rows the box must hold to be itself, pane's floor included. */
	minRows: number;
}

/** Whether the terminal is below the minimum useful size. */
export function belowMinimum(width: number, height: number): boolean {
	return width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT;
}

/** The size message the compact frame and every held-back surface show. */
export const TOO_SMALL_TEXT = `Terminal too small: minimum ${MIN_TERMINAL_WIDTH} columns by ${MIN_TERMINAL_HEIGHT} rows`;

export interface ModalFrame {
	/** The box's outer width, border included. */
	boxWidth: number;
	/** The box's outer height, border included. */
	boxHeight: number;
	/** The padding cells per side the box can pay for: 0 or 1. */
	padding: number;
	/** Text columns inside the border and padding. */
	contentWidth: number;
	/** Rows inside the border and padding that the surface's body may take. */
	contentRows: number;
	/** The rows the surface's Action bar owns. */
	barRows: number;
	/** The rows its Message line owns: 0 only where there is no room for it. */
	messageRows: number;
	/** The rows the box is laid out within: every row but those two. */
	regionRows: number;
}

/**
 * The box one modal gets at a terminal size.
 *
 * `margin` is the cell gap between the box and the terminal edge, and
 * `scale` is the pop-in progress, so the layout follows the box the frame is
 * actually drawing rather than the one it is growing into.
 *
 * The surface lays its box out in the rows above its own bottom rows, and
 * centers it there. The box keeps `margin` rows below what is left over on
 * its top, so it can sit on the Message line but never on a row the surface
 * owns: a border and a bar can never share a row, at any size and for any
 * margin. Below that the box gives up its padding, and a box that cannot
 * even hold its borders is not drawn at all.
 */
export function modalFrame(
	width: number,
	height: number,
	options: {
		margin?: number;
		maxWidth?: number;
		maxHeight?: number;
		/** The rows the surface's content takes when nothing is taken away from
		 *  it. The box is sized to this, capped by the room the terminal offers,
		 *  so a two-line message does not claim the whole frame. */
		rows?: number;
		/** The rows the surface must keep to be itself: the last rows it would
		 *  rather lose. A box that cannot hold them together with its padding
		 *  gives the padding up instead. Defaults to `rows`. */
		minRows?: number;
		scale?: number;
	} = {},
): ModalFrame {
	const margin = options.margin ?? 1;
	const scale = options.scale ?? 1;
	// Every surface owns its last two rows the same way: the Message line and
	// the Action bar, whether or not that bar has a control to name yet.
	const barRows = BAR_ROWS;
	// The Message line gives way before the Action bar does, as it does in the
	// base frame: the bar is the only control a held-back surface still offers.
	const messageRows = height > barRows ? MESSAGE_ROWS : 0;
	const regionRows = Math.max(0, height - barRows - messageRows);
	// Half the region's leftover rows fall below the box, so the box keeps its
	// margin from the region's top edge and may close up on its bottom edge,
	// which is the Message line's row. A border can never reach a row the
	// surface owns.
	const room = Math.max(0, regionRows - Math.max(0, 2 * margin - 1));
	const boxWidth = Math.max(
		1,
		Math.round(Math.min(width - margin * 2, options.maxWidth ?? Number.MAX_SAFE_INTEGER) * scale),
	);
	// What the box holds inside its border: every row its content wants, or
	// everything the terminal has room for.
	const asked = options.rows === undefined ? undefined : options.rows + BORDERS;
	const floor = (options.minRows ?? options.rows ?? 0) + BORDERS;
	const cap = Math.min(
		room,
		options.maxHeight ?? Number.MAX_SAFE_INTEGER,
		asked === undefined ? Number.MAX_SAFE_INTEGER : asked + 2 * PADDING,
	);
	// Padding yields last. A box that can hold the rows it must keep with its
	// padding keeps the padding, and the rows above that are the surface's own
	// scroll problem; a box that cannot hold them with the padding gives the
	// padding up, and a box that cannot hold one row at all is not drawn.
	const padding =
		(asked === undefined || room >= floor + 2 * PADDING) &&
		cap >= BORDERS + 2 * PADDING + 1 &&
		boxWidth >= BORDERS + 2 * PADDING + 3
			? PADDING
			: 0;
	const boxHeight = Math.max(1, Math.round(Math.min(cap, (asked ?? cap) + 2 * padding) * scale));
	return {
		boxWidth,
		boxHeight,
		padding,
		contentWidth: Math.max(1, boxWidth - BORDERS - 2 * padding),
		contentRows: Math.max(0, boxHeight - BORDERS - 2 * padding),
		barRows,
		messageRows,
		regionRows,
	};
}

interface ModalSurfaceProps {
	frame: ModalFrame;
	/**
	 * The terminal's columns, handed down by the surface that measured them.
	 *
	 * The chrome never asks the renderer: every `useTerminalDimensions` call
	 * adds a real `resize` listener, and a surface stacked above the base
	 * frame would otherwise cost three per overlay and cross Node's
	 * ten-listener limit on an ordinary operator path.
	 */
	width: number;
	title: string;
	/** The one Body the box holds: its rows, and the pane within them. */
	body: ModalBody;
	/** The Message fact the surface's Message line shows. */
	message: MessageFact | null;
	/** The catalogue bar this surface owns, if it owns one. */
	bar?: { mode: InteractionMode; context: ControlContext; rangeIndicator?: string };
	opacity?: number;
	zIndex?: number;
}

/**
 * The full-screen surface, the bordered box on it, and the two rows the
 * surface owns below the box: its Message line and its Action bar.
 *
 * The rows are laid out, not painted over: the box gets the region above
 * them, so it cannot reach either row at any size. Below the rows the
 * surface needs, the box stands down and the size message takes the region:
 * the operator reads why nothing is there, and the surface's own keys still
 * close it.
 */
export function ModalSurface({
	frame,
	width,
	title,
	body,
	message,
	bar,
	opacity,
	zIndex = 10,
}: ModalSurfaceProps) {
	const held = frame.contentRows < body.minRows || frame.boxHeight < 2;
	return createElement(
		"box",
		{ style: overlaySurfaceStyle(zIndex) },
		createElement(
			"box",
			{
				key: "region",
				style: {
					flexGrow: 1,
					flexShrink: 0,
					width: "100%",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					overflow: "hidden",
				},
			},
			// Below the rows a surface needs, the box stands down and states its
			// size: a clipped pane is not an answer to a small terminal. The
			// notice is handed no more lines than the region holds, so it cannot
			// reach the Message line or the bar either.
			held
				? sizeNoticeElement(width, frame.regionRows)
				: createElement(
						"box",
						{
							border: true,
							// The box and the pane paint one ink: the control ink's
							// indicator. No surface states a border color, so the
							// no-color presentation and the inherited theme reach
							// every border at once (ADR 0040).
							borderColor: controlInk().indicator.fg ?? undefined,
							title: truncateToWidth(title, frame.contentWidth),
							padding: frame.padding,
							style: {
								width: frame.boxWidth,
								height: frame.boxHeight,
								flexDirection: "column",
								overflow: "hidden",
								opacity,
							},
						},
						...body.above,
						...(body.pane !== undefined ? [paneElement(body.pane, frame.contentWidth)] : []),
						...body.below,
					),
		),
		messageLineRow(message, width, frame),
		bar === undefined
			? emptyRowElement()
			: createElement(ActionBar, {
					mode: bar.mode,
					context: bar.context,
					width,
					rangeIndicator: bar.rangeIndicator,
				}),
	);
}

/** The pop-in: a short fade with the box growing to its final size. */
const POP_MS = 120;
const POP_TICK_MS = 16;
/** The box's size at the pop-in's start, of its final size. */
const POP_START = 0.94;

/**
 * The modal pop-in's progress, shared by every surface the chrome owns.
 *
 * A self-driven progress keeps it deterministic in the test renderer, where
 * the animation engine never ticks. One hook per opening: a surface that
 * switches sub-modes under the operator keeps the one it opened with, so
 * the switch is in place, without a second pop-in (ADR 0040).
 */
export function useModalPopScale(): { pop: number; scale: number } {
	const [pop, setPop] = useState(0);
	useEffect(() => {
		const startedAt = performance.now();
		const id = setInterval(() => {
			const t = Math.min(1, (performance.now() - startedAt) / POP_MS);
			setPop(1 - (1 - t) ** 3);
			if (t >= 1) clearInterval(id);
		}, POP_TICK_MS);
		return () => clearInterval(id);
	}, []);
	return { pop, scale: POP_START + (1 - POP_START) * pop };
}

/**
 * The Body pane the box holds: one body by itself, under its own border and
 * title (ADR 0039).
 *
 * The pane's rows and its height are the ones the caller's layout reserved:
 * the layout has decided the pane's chrome, so the pane draws it - its
 * border, its padding, and its height - without re-deciding it. The region
 * below stays pinned to the box's floor, whatever the body's length.
 */
function paneElement(pane: NonNullable<ModalBody["pane"]>, width: number): ReactElement {
	return createElement(
		"box",
		{
			border: true,
			borderColor: controlInk().indicator.fg ?? undefined,
			title: truncateToWidth(pane.title, Math.max(1, width - BORDERS - 2 * pane.vpad)),
			padding: pane.vpad,
			style: {
				width,
				height: pane.height,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...pane.rows,
	);
}

/** The bar's row on a surface that names no control on it yet. */
function emptyRowElement(): ReactElement {
	return createElement("text", { style: { width: "100%", height: 1 } }, "");
}

/**
 * The surface's own Message line, or nothing when it has no room for it.
 *
 * A surface shorter than its bottom rows keeps the bar and drops the Message
 * line, so the last row stays the bar's at one row of height too.
 */
function messageLineRow(
	message: MessageFact | null,
	width: number,
	frame: ModalFrame,
): ReactElement | null {
	if (frame.messageRows === 0) return null;
	return messageRowElement(message, width);
}

/**
 * The full-screen surface every modal and overlay paints on.
 *
 * The surface is the ink's own surface role, so the ink a surface paints on it
 * is the ink that pair was derived against: the theme's panel surface under
 * its own text. A surface the theme or the no-color presentation resolves to
 * the terminal default paints no background at all, so the terminal's own
 * default shows through.
 */
function overlaySurfaceStyle(zIndex: number): Record<string, unknown> {
	const surface = controlInk().surface;
	return {
		position: "absolute",
		top: 0,
		left: 0,
		width: "100%",
		height: "100%",
		zIndex,
		backgroundColor: surface.on === "default" ? undefined : surface.on,
		flexDirection: "column",
	};
}

/** The lines a held-back surface paints in place of its own content. */
function sizeNoticeLines(): readonly { text: string; fg: string | undefined }[] {
	const ink = controlInk();
	return [
		{ text: TOO_SMALL_TEXT, fg: ink.warning.fg ?? undefined },
		{ text: "This surface cannot be drawn here: Esc closes it.", fg: ink.detail.fg ?? undefined },
	];
}

/**
 * The notice a surface that cannot draw itself paints instead: the size it
 * needs and the key that closes it.
 *
 * Each line is a row of its own height. The surface centers its children, so
 * a row without a stated height would be laid out over the rows the Action
 * bar owns.
 */
function sizeNoticeElement(width: number, rows: number): ReactElement {
	return createElement(
		Fragment,
		{},
		...sizeNoticeLines()
			.slice(0, Math.max(0, rows))
			.map((line, index) =>
				createElement(
					"text",
					{
						key: `too-small-${index}`,
						fg: line.fg,
						style: { width: "100%", height: 1 },
					},
					padToWidth(truncateToWidth(line.text, width), width),
				),
			),
	);
}

/**
 * The proportional scrollbar rows for a window.
 *
 * The thumb is `visibleRows * visibleRows / lineCount` tall, and its top
 * slides over the rows the track holds.
 */
export function scrollbarRows(
	lineCount: number,
	visibleRows: number,
	scroll: number,
): ReadonlySet<number> {
	const thumbHeight = Math.max(1, Math.ceil((visibleRows * visibleRows) / lineCount));
	const travel = Math.max(0, visibleRows - thumbHeight);
	const maxScroll = maxScrollOf(lineCount, visibleRows);
	const start = maxScroll === 0 ? 0 : Math.round((scroll / maxScroll) * travel);
	return new Set(Array.from({ length: thumbHeight }, (_, index) => start + index));
}

/** One colored piece of a body row. */
export interface BodySpan {
	text: string;
	fg?: string;
	/** The emphasis the old palette carried in a brighter text color. */
	bold?: boolean;
}
/**
 * One body row as spans, with a dim track and a bold thumb when it scrolls.
 *
 * The scrollbar sits in the row's last column. Without the pad, the thumb
 * and track float behind short lines: a block in the middle of the row reads
 * as an artifact.
 */
export function bodyRowSpans(
	parts: readonly BodySpan[],
	width: number,
	thumb: boolean | undefined,
): ReactElement[] {
	const spans: ReactElement[] =
		parts.length === 0
			? [createElement("span", { key: "blank" }, "")]
			: parts.map((span, index) =>
					span.bold
						? createElement(
								"b",
								{ key: `part-${index}`, fg: span.fg },
								truncateToWidth(span.text, width),
							)
						: createElement(
								"span",
								{ key: `part-${index}`, fg: span.fg },
								truncateToWidth(span.text, width),
							),
				);
	if (thumb !== undefined) {
		let used = 0;
		for (const span of parts) used += widthOf(span.text);
		const pad = Math.max(0, width - used);
		if (pad > 0) spans.push(createElement("span", { key: "pad" }, " ".repeat(pad)));
		spans.push(
			thumb
				? createElement("b", { key: "bar", fg: paint("text") }, "█")
				: createElement("span", { key: "bar", fg: paint("subtext0") }, "│"),
		);
	}
	return spans;
}
