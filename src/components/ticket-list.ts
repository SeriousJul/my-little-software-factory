/**
 * The ticket list pane: one row per ticket, windowed to the pane height.
 *
 * Each row carries the ticket's marker, state badge, task type badge,
 * title, and repository, laid out on an exact budget of cells so a row
 * never overflows the pane. A blocked or missing agent shows its failure
 * in place of the state badge; a ticket at the handoff limit, or one whose
 * closed cycle still has an environment alive in herdr, or one the operator has
 * ignored (ADR 0060), wears its markers
 * as trailing text. Trailing markers are all or nothing: a row too narrow
 * to hold them beside a readable title drops every one of them, and the
 * detail pane keeps carrying the facts. The task type badge sits between the state badge and
 * the title at its natural width: complete or absent, never truncated.
 * When the terminal is narrow, the repository drops out before the title
 * does, so a row never wraps and the title stays readable. The window
 * slides so the selected ticket stays visible when the tickets overflow
 * the pane.
 *
 * Under a Grouping axis the pane draws the section's list rows instead: one row
 * per ticket, and one Group header above each run of rows that share one value
 * of the axis (issue #159). A header costs a window row and takes the cursor
 * exactly as a ticket row does, and a collapsed Group draws its header alone,
 * with the count and the held count the fold hides. A left click on a header
 * folds the Group it names. The header's words come from the shared grouping
 * module and its colors from the paint layer, so the fold needs no palette of
 * its own and no color alone carries it.
 */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { type ReactElement, useRef } from "react";

import { holdsDecision, type Ticket } from "../domain/ticket.ts";
import { usePaneGeometry } from "./geometry.ts";
import { listMouse, listWindow } from "./list-pane.ts";
import { groupHeaderSpans, type ListedRow } from "./shared/grouping.ts";
import { spinnerFace, useSpinnerFrame } from "./shared/spinner.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import {
	BADGE_WIDTH,
	failureBadge,
	heldBadge,
	markerColor,
	paint,
	queuedBadge,
	STARTING_WORD,
	stateBadge,
	stateColor,
	taskTypeBadge,
	taskTypeColor,
	ticketTaskType,
} from "./theme.ts";

const REPO_GAP = 1;
/** The marker a ticket at the handoff limit wears at the row's end. */
const LIMIT_TEXT = "handoff limit";
/** The marker a ticket with an environment still alive in herdr wears. */
const LEFTOVER_TEXT = "leftover";
/**
 * The marker an ignored ticket wears (ADR 0060). The fact is the written word,
 * so it stands in the no-color presentation and under an inherited Theme alike.
 */
const IGNORED_TEXT = "ignored";
const MARKER_GAP = 1;
/** Two cells: "❯ " when the row is selected, two spaces otherwise. */
const SELECTION_WIDTH = 2;
/** The row cells a dropped field still owes the title: one gap and one text cell. */
const TITLE_MINIMUM = 2;

interface TicketListProps {
	/**
	 * The list's rows: each ticket, and the Group header above each run the
	 * Grouping axis makes. The `none` axis holds the tickets alone, in the flat
	 * list's order, so the pane draws today's list with no header.
	 */
	rows: readonly ListedRow<Ticket>[];
	/** The cursor's place in that row list: it can rest on a Group header. */
	selectedIndex: number;
	focused: boolean;
	/** The box's exact height in cells, from the Main view's section layout. */
	height: number;
	emptyMessage?: string;
	/** The failure badge of a ticket from the last observation, or null. */
	markerOf: (ticket: Ticket) => "blocked" | "missing" | null;
	/** Whether the ticket has used up its handoffs: the limit marker. */
	limitReached: (ticket: Ticket) => boolean;
	/**
	 * Whether the ticket's Starting window (ADR 0030) is open against the
	 * app's facts: the row wears the spinner face in place of its state
	 * badge while it holds. A failure marker outranks it in the row.
	 */
	starting: (ticket: Ticket) => boolean;
	/**
	 * Whether the ticket's Queue wait (CONTEXT.md) holds against the app's
	 * facts: the row wears the `queued` badge in place of its state badge
	 * while it holds. A failure marker and the Starting window outrank it in
	 * the row the way they outrank the state badge.
	 */
	queueWait: (ticket: Ticket) => boolean;
	/** False while an overlay owns input above the panes. */
	active: boolean;
	onFocus: () => void;
	/** The cursor moves to one row of the list, by its place in the row list. */
	onSelect: (index: number) => void;
	onMove: (delta: number) => void;
}

export function TicketList({
	rows,
	selectedIndex,
	focused,
	height,
	emptyMessage,
	markerOf,
	limitReached,
	starting,
	queueWait,
	active,
	onFocus,
	onSelect,
	onMove,
}: TicketListProps) {
	const geometry = usePaneGeometry("list");
	// The Main view hands the box its exact height: two border rows and two
	// padding rows are chrome, and the rest is the window's room.
	const visibleRows = Math.max(1, height - 4);
	const rootRef = useRef<BoxRenderable | null>(null);

	// The window, the mouse hit test, and the cursor step all read the one row
	// list, so a Group header costs a window row exactly like a ticket does.
	const { start, visible } = listWindow(rows, selectedIndex, visibleRows);
	// The row wears the face as written text, not as a mounted control: the row
	// is one text renderable, and a text renderable takes no nested control, so
	// the face is the shared face's text at the shared frame, painted as one run
	// the way the state badge is painted. The frame comes from the shared
	// `useSpinnerFrame`, gated on whether a visible row wears it: a window that
	// is not on screen owes no motion, and the face stands on its first frame
	// the moment the window opens, so a frame snapshot read at the open holds.
	// The word, not the glyph, is the fact (ADR 0030).
	const faceFrame = useSpinnerFrame(
		visible.some((row) => row.kind === "item" && starting(row.item)),
	);
	const handleMouse = listMouse({
		active: () => active,
		onFocus,
		onMove,
		onSelect,
		rootRef,
		start,
		visibleRows: visible.length,
		itemCount: rows.length,
	});

	return createElement(
		"box",
		{
			ref: rootRef,
			title: focused ? "❯ Tickets" : "  Tickets",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			padding: 1,
			onMouse: handleMouse,
			style: {
				// An exact cell count from the shared geometry, not "50%":
				// OpenTUI rounds a percentage up on odd terminal widths, and
				// the rounded box would no longer match the geometry the
				// rows and the detail pane lay their text on.
				width: geometry.paneCols,
				height,
				flexGrow: 0,
				flexShrink: 0,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...(visible.length === 0 && emptyMessage !== undefined
			? [
					createElement(
						"text",
						{ key: "empty", fg: paint("subtext0") },
						truncateToWidth(emptyMessage, geometry.usableCols),
					),
				]
			: visible.map((row, offset) =>
					row.kind === "group"
						? createElement(
								"text",
								{ key: `group:${row.group.value}` },
								...groupHeaderSpans(
									row.group,
									start + offset === selectedIndex,
									geometry.usableCols,
								),
							)
						: createElement(
								"text",
								{ key: row.item.identity },
								...rowSpans(
									row.item,
									start + offset === selectedIndex,
									geometry.usableCols,
									markerOf(row.item),
									limitReached(row.item),
									starting(row.item),
									queueWait(row.item),
									faceFrame,
								),
							),
				)),
	);
}

/**
 * Build one row as spans on an exact cell budget.
 *
 * The selection marker and the state badge take their fixed widths, the
 * task type badge takes its natural width, the repository keeps its
 * natural width with one gap column, the title takes whatever is left, and
 * the row's trailing markers (the handoff limit, a leftover environment)
 * ride at its end. A field is dropped, never wrapped: the repository drops
 * first, the task type badge drops before the repository when its complete
 * text plus the title minimum would not fit, and the title always keeps its
 * gap plus one text cell.
 */
function rowSpans(
	ticket: Ticket,
	selected: boolean,
	usableCols: number,
	marker: "blocked" | "missing" | null,
	atLimit: boolean,
	starting: boolean,
	queueWait: boolean,
	faceFrame: number,
): ReactElement[] {
	const spans: ReactElement[] = [];
	let budget = usableCols;
	const trailing: { text: string; fg: string | undefined }[] = [];
	if (atLimit) trailing.push({ text: LIMIT_TEXT, fg: paint("yellow") });
	if (ticket.leftover !== null) trailing.push({ text: LEFTOVER_TEXT, fg: paint("yellow") });
	// The ignore rides the same lane: the state badge keeps its own slot, so an
	// ignored Ticket whose Agent works still reads `running` (ADR 0060).
	if (ticket.ignored) trailing.push({ text: IGNORED_TEXT, fg: paint("subtext0") });

	if (budget >= SELECTION_WIDTH) {
		// The selected row's marker and title wear bold: the emphasis the
		// old palette carried in a brighter text color.
		spans.push(
			selected
				? createElement("b", { fg: paint("text") }, "❯ ")
				: createElement("span", { fg: paint("subtext0") }, "  "),
		);
		budget -= SELECTION_WIDTH;
	}

	// The failure badge replaces the state badge: the agent blocked or the
	// pane gone stand out in the badge's own place. A held turn wears its
	// own badge in the state's place (ADR 0016): it is the fact the operator
	// must act on, and it outranks the resting state it rests in. It only
	// appears on an awaiting ticket: a held turn whose agent works again has
	// left awaiting and shows its state badge, never `held` over an agent that
	// is visibly working. The spinner face of the Starting window (ADR 0030)
	// takes the badge's slot while the window holds; a failure marker beats
	// it the way it beats the state badge, so a dead or blocked agent is
	// never hidden behind the motion.
	if (budget >= BADGE_WIDTH) {
		if (marker !== null)
			spans.push(createElement("span", { fg: markerColor(marker) }, failureBadge(marker)));
		else if (starting)
			spans.push(
				createElement(
					"span",
					{ fg: paint("subtext0") },
					spinnerFace(faceFrame, STARTING_WORD, BADGE_WIDTH),
				),
			);
		else if (holdsDecision(ticket))
			spans.push(createElement("span", { fg: paint("yellow") }, heldBadge()));
		else if (queueWait)
			// The Queue wait badge wears the open role: the ticket keeps its
			// open state while its start waits for a seat.
			spans.push(createElement("span", { fg: stateColor("open") }, queuedBadge()));
		else
			spans.push(createElement("span", { fg: stateColor(ticket.state) }, stateBadge(ticket.state)));
		budget -= BADGE_WIDTH;
	}

	// The task type badge sits between the state badge and the title. It is
	// complete or absent: a partial badge could read as another task type,
	// so the row must hold the whole badge, its gap, and the title minimum,
	// or the badge drops and the title keeps the cells.
	const presentation = ticketTaskType(ticket);
	const badgeWidth = widthOf(taskTypeBadge(presentation.value));
	if (budget >= badgeWidth + TITLE_MINIMUM) {
		spans.push(
			createElement("span", { fg: taskTypeColor(presentation) }, taskTypeBadge(presentation.value)),
		);
		budget -= badgeWidth;
	}

	const titleEl = (text: string): ReactElement =>
		createElement(selected ? "b" : "span", { fg: paint("text") }, text);
	const repoWidth = widthOf(ticket.repository);

	// The trailing markers keep their gaps and their text at the row's end,
	// and the title keeps its gap and one text cell for itself.
	const markersCost = trailing.reduce((sum, marker) => sum + MARKER_GAP + widthOf(marker.text), 0);
	if (trailing.length > 0 && budget >= markersCost + TITLE_MINIMUM) {
		const afterMarkers = budget - markersCost;
		const repoFits = afterMarkers >= REPO_GAP + repoWidth + TITLE_MINIMUM;
		let titleField = Math.max(0, afterMarkers - (repoFits ? REPO_GAP + repoWidth : 0));
		if (titleField >= 1) {
			spans.push(titleEl(" "));
			titleField -= 1;
		}
		if (titleField > 0) {
			spans.push(titleEl(padToWidth(truncateToWidth(ticket.title, titleField), titleField)));
		}
		if (repoFits) {
			spans.push(
				createElement(
					"span",
					{ fg: paint("subtext0") },
					`${" ".repeat(REPO_GAP)}${ticket.repository}`,
				),
			);
		}
		for (const marker of trailing) {
			spans.push(
				createElement("span", { fg: marker.fg }, `${" ".repeat(MARKER_GAP)}${marker.text}`),
			);
		}
		return spans;
	}

	// No trailing marker on this row: the title takes whatever the repository
	// leaves, and the repository drops when it would leave the title less
	// than a gap column and one text cell, so the title drops last.
	const repoFits = budget >= REPO_GAP + repoWidth + TITLE_MINIMUM;
	let titleField = Math.max(0, budget - (repoFits ? REPO_GAP + repoWidth : 0));
	if (titleField >= 1) {
		spans.push(titleEl(" "));
		titleField -= 1;
	}
	if (titleField > 0) {
		spans.push(titleEl(padToWidth(truncateToWidth(ticket.title, titleField), titleField)));
	}
	if (repoFits) {
		spans.push(
			createElement(
				"span",
				{ fg: paint("subtext0") },
				`${" ".repeat(REPO_GAP)}${ticket.repository}`,
			),
		);
	}

	return spans;
}
