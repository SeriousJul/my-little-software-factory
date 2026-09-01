/** Contextual controls and the small in-app key and message views. */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import type { Consultation } from "../state.ts";
import { truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

export type ActionView = "tickets" | "consultations";
export type ActionUtility = "guide" | "message";

export interface ActionContext {
	view: ActionView;
	focusedPane: "list" | "detail";
	selectedConsultation?: Consultation;
	status?: { kind: "info" | "warning" | "error"; text: string } | null;
	launcher: boolean;
	modal: boolean;
	responseEditor: boolean;
	interaction: boolean;
}

interface ActionHint {
	key: string;
	label: string;
	priority: number;
}

/** Draw one permanent, width-safe contextual Action bar. */
export function ActionBar({ context }: { context: ActionContext }) {
	const { width } = useTerminalDimensions();
	const hints = actionHints(context);
	const packed: string[] = [];
	let used = 0;
	for (const hint of hints.sort((left, right) => right.priority - left.priority)) {
		const text = `${hint.key} ${hint.label}`;
		const next = used === 0 ? widthOf(text) : used + 2 + widthOf(text);
		if (next > width) continue;
		packed.push(text);
		used = next;
	}
	const output = packed.reverse().join("  ");
	return createElement(
		"text",
		{ style: { width: "100%", height: 1, fg: COLORS.dim } },
		truncateToWidth(output, width),
	);
}

export function ActionGuide({
	context,
	utility,
	onClose,
	onMessage,
}: {
	context: ActionContext;
	utility: ActionUtility;
	onClose: () => void;
	onMessage: () => void;
}) {
	const { width, height } = useTerminalDimensions();
	const contentWidth = Math.max(1, Math.min(96, width - 6));
	const rows =
		utility === "guide"
			? guideRows(context)
			: [
					context.status === null || context.status === undefined
						? "no Message"
						: `${context.status.kind}: ${context.status.text}`,
					"",
					"Esc / F1 / ?  close",
				];
	const wrapped = rows.flatMap((row) => (row === "" ? [""] : wrapToWidth(row, contentWidth)));
	const visibleRows = Math.max(1, height - 7);
	const maxScroll = Math.max(0, wrapped.length - visibleRows);
	const [scroll, setScroll] = useState(0);
	useEffect(
		() => setScroll(utility === "message" ? 0 : (current) => Math.min(current, maxScroll)),
		[utility, maxScroll],
	);
	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		if (key.name === "escape" || key.name === "?" || key.name === "f1") onClose();
		else if (key.name === "f2" && utility === "guide") onMessage();
		else if (key.name === "m" && utility === "guide") onMessage();
		else if (key.name === "up" || key.name === "k")
			setScroll((current) => Math.max(0, current - 1));
		else if (key.name === "down" || key.name === "j")
			setScroll((current) => Math.min(maxScroll, current + 1));
	});
	const visible = wrapped.slice(scroll, scroll + visibleRows);
	return createElement(
		"box",
		{
			style: {
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 30,
				backgroundColor: COLORS.overlay,
				alignItems: "center",
				justifyContent: "center",
			},
		},
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title: utility === "guide" ? "Key guide" : "Message",
				padding: 1,
				style: {
					width: Math.max(1, Math.min(Math.max(1, width - 2), contentWidth + 4)),
					height: Math.max(1, Math.min(Math.max(1, height - 2), visible.length + 4)),
					flexDirection: "column",
				},
			},
			...visible.map((row, index) =>
				createElement(
					"text",
					{ key: index, fg: index === 0 ? COLORS.textBright : COLORS.text },
					truncateToWidth(row, contentWidth),
				),
			),
		),
	);
}

function actionHints(context: ActionContext): ActionHint[] {
	if (context.launcher || context.modal || context.responseEditor || context.interaction) {
		return [{ key: "Esc", label: "close", priority: 100 }];
	}
	if (context.view === "tickets") {
		return [
			{ key: "↑↓/jk", label: "move", priority: 90 },
			{ key: "Enter", label: "hand off", priority: 80 },
			{ key: "e", label: "override", priority: 70 },
			{ key: "v", label: "Consultations", priority: 60 },
			{ key: "c", label: "launch", priority: 50 },
			...(context.status === null || context.status === undefined
				? []
				: [{ key: "m", label: "message", priority: 45 }]),
			{ key: "r", label: "refresh", priority: 40 },
			{ key: "?", label: "help", priority: 30 },
			{ key: "q", label: "quit", priority: 20 },
		];
	}
	const selected = context.selectedConsultation;
	const hints: ActionHint[] = [
		{ key: "↑↓/jk", label: "move", priority: 90 },
		{ key: "c", label: "launch", priority: 70 },
		...(context.status === null || context.status === undefined
			? []
			: [{ key: "m", label: "message", priority: 65 }]),
		{ key: "f", label: "history", priority: 60 },
		{ key: "t", label: "Tickets", priority: 40 },
		{ key: "r", label: selected?.state === "failed" ? "retry" : "refresh", priority: 35 },
		{ key: "?", label: "help", priority: 30 },
		{ key: "q", label: "quit", priority: 20 },
	];
	if (selected?.state === "awaiting-response")
		hints.splice(1, 0, { key: "Enter", label: "respond", priority: 80 });
	else if (selected?.state === "working" && selected.paneId !== null)
		hints.splice(1, 0, { key: "Enter", label: "interact", priority: 80 });
	if (
		selected?.state === "opening" ||
		selected?.state === "working" ||
		selected?.state === "awaiting-response" ||
		selected?.state === "missing" ||
		selected?.state === "failed"
	)
		hints.splice(3, 0, { key: "x", label: "close", priority: 50 });
	if (selected?.state === "closed") hints.splice(3, 0, { key: "d", label: "delete", priority: 50 });
	return hints;
}

function guideRows(context: ActionContext): string[] {
	const rows = actionHints({
		...context,
		launcher: false,
		modal: false,
		responseEditor: false,
		interaction: false,
	})
		.sort((left, right) => right.priority - left.priority)
		.map((hint) => `${hint.key.padEnd(8)} ${hint.label}`);
	if (context.view === "consultations")
		rows.push(
			"",
			"Launcher: Tab fields, arrows choose, Shift+Enter newline",
			"Response: Enter submit, Shift+Enter newline, Esc keep draft",
			"Agent view: End follows output; interaction exits with configured key",
		);
	rows.push("", "Esc closes this guide. F2 or m opens the full Message view.");
	return rows;
}

export function actionBarElement(context: ActionContext): ReactElement {
	return createElement(ActionBar, { context });
}
