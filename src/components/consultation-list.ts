/** The Consultation list, ordered by attention and recent activity. */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { useRef } from "react";
import type { Consultation } from "../state.ts";
import { usePaneGeometry } from "./geometry.ts";
import { listMouse, listWindow } from "./list-pane.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ConsultationListProps {
	consultations: readonly Consultation[];
	selectedIndex: number;
	focused: boolean;
	reservedRows: number;
	emptyMessage?: string;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
	onSelect: (index: number) => void;
	onMove: (delta: number) => void;
}

const STATE_WIDTH = 20;

export function ConsultationList({
	consultations,
	selectedIndex,
	focused,
	reservedRows,
	emptyMessage,
	active = true,
	onFocus,
	onSelect,
	onMove,
}: ConsultationListProps) {
	const geometry = usePaneGeometry("list", reservedRows);
	const rootRef = useRef<BoxRenderable | null>(null);
	const { start, visible } = listWindow(consultations, selectedIndex, geometry.visibleRows);
	const handleMouse = listMouse({
		active: () => active,
		onFocus,
		onMove,
		onSelect,
		rootRef,
		start,
		visibleRows: visible.length,
		itemCount: consultations.length,
	});
	return createElement(
		"box",
		{
			ref: rootRef,
			onMouse: handleMouse,
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
