/** A clickable header for one section of the Main view. */
import type { MouseEvent } from "@opentui/core";
import { createElement } from "@opentui/react";

import { padToWidth, truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

export type MainSection = "tickets" | "consultations";

interface SectionHeaderProps {
	section: MainSection;
	expanded: boolean;
	width: number;
	awaitingResponse?: number;
	recovery?: number;
	bell?: boolean;
	newOutput?: boolean;
	/** The Tickets section's held turns, held against automatic decisions. */
	held?: number;
	/** The held count rose since the last render: flash the header like a bell. */
	heldBell?: boolean;
	active: boolean;
	onExpand: () => void;
}

/**
 * Draw one row that can expand its section.
 *
 * The header is deliberately not a bordered box. The two section rows are part
 * of the Main frame, not extra panes, and their full-width row is also the
 * mouse target for the same action as `t` and `v`.
 */
export function SectionHeader({
	section,
	expanded,
	width,
	awaitingResponse = 0,
	recovery = 0,
	bell = false,
	newOutput = false,
	held = 0,
	heldBell = false,
	active,
	onExpand,
}: SectionHeaderProps) {
	const marker = expanded ? "▾ " : "▸ ";
	const name = section === "tickets" ? "Tickets" : "Consultations";
	// The counts answer for the collapsed section too: the header is the only
	// row a collapsed section shows. A narrow frame states them in the short
	// form rather than truncating the whole line mid-count.
	const counts =
		width >= 60
			? `awaiting response: ${awaitingResponse}  recovery: ${recovery}`
			: `awaiting ${awaitingResponse}  recovery ${recovery}`;
	// A held turn is a fact about the Ticket section, and its count answers
	// for the collapsed section the same way the Consultation counts do.
	const facts =
		section === "consultations"
			? `  ${counts}${bell ? "  !!!" : ""}${expanded && newOutput ? "  new output" : ""}`
			: held > 0
				? `  held: ${held}${heldBell ? "  !!!" : ""}`
				: "";
	const text = `${marker}${name}${facts}`;
	const handleMouse = (event: MouseEvent) => {
		if (active && event.type === "down" && event.button === 0) onExpand();
	};
	return createElement(
		"box",
		{
			onMouse: handleMouse,
			style: { width: "100%", height: 1, flexGrow: 0, flexShrink: 0 },
		},
		createElement(
			"text",
			{ style: { width: "100%", height: 1 }, fg: expanded ? COLORS.textBright : COLORS.dim },
			padToWidth(truncateToWidth(text, width), width),
		),
	);
}
