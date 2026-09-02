/** The Consultation list, ordered by attention and recent activity. */
import { createElement } from "@opentui/react";
import type { Consultation } from "../state.ts";
import { usePaneGeometry, windowOf } from "./geometry.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ConsultationListProps {
	consultations: readonly Consultation[];
	selectedIndex: number;
	focused: boolean;
	reservedRows: number;
	emptyMessage?: string;
}

const STATE_WIDTH = 20;

export function ConsultationList({
	consultations,
	selectedIndex,
	focused,
	reservedRows,
	emptyMessage,
}: ConsultationListProps) {
	const geometry = usePaneGeometry("list", reservedRows);
	const visible = windowOf(
		consultations,
		selectedIndex - geometry.visibleRows + 1,
		geometry.visibleRows,
	);
	return createElement(
		"box",
		{
			title: focused ? "❯ Consultations" : "  Consultations",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			style: {
				width: geometry.paneCols,
				flexGrow: 0,
				flexShrink: 0,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...(visible.length === 0
			? [
					createElement(
						"text",
						{ key: "empty", fg: COLORS.dim },
						truncateToWidth(emptyMessage ?? "no Consultations", geometry.usableCols),
					),
				]
			: visible.map((consultation) =>
					createElement(
						"text",
						{ key: consultation.id },
						...row(
							consultation,
							consultation.id === consultations[selectedIndex]?.id,
							geometry.usableCols,
						),
					),
				)),
	);
}

function row(consultation: Consultation, selected: boolean, width: number) {
	const marker = selected ? "❯ " : "  ";
	const state = consultation.state;
	const identity = consultation.typeName;
	const repo = consultation.repository.displayName;
	const start = consultation.createdAt.slice(11, 16);
	const prefix = `${marker}${padToWidth(state, STATE_WIDTH)} `;
	const suffix = ` ${repo} ${start}`;
	const available = Math.max(1, width - widthOf(prefix) - widthOf(suffix));
	return [
		createElement("span", { fg: selected ? COLORS.textBright : COLORS.dim }, prefix),
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.text },
			truncateToWidth(identity, available),
		),
		createElement(
			"span",
			{ fg: COLORS.dim },
			truncateToWidth(suffix, Math.max(0, width - widthOf(prefix) - available)),
		),
	];
}
