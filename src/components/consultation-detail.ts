/** The live Agent view and Captured history for one Consultation. */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { useRef } from "react";
import type {
	Consultation,
	ConsultationResource,
	ConsultationSnapshot,
	ConsultationTurn,
} from "../state.ts";
import type { AnsiLine } from "./ansi-screen.ts";
import { windowOf } from "./geometry.ts";
import { paneMouse } from "./pane-mouse.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** One detail line: the text, the color it paints, and the emphasis it wears. */
export interface ConsultationDetailLine {
	text: string;
	fg: string | undefined;
	/** The emphasis the old palette carried in a brighter text color. */
	bold?: boolean;
}

export function consultationDetailLines(
	consultation: Consultation | undefined,
	turns: readonly ConsultationTurn[],
	snapshots: readonly ConsultationSnapshot[],
	width: number,
	liveOutput: string | null,
	replacementIds: readonly string[] = [],
	agentStatus: string | null = null,
	remainingResources: readonly ConsultationResource[] = [],
): ConsultationDetailLine[] {
	if (consultation === undefined)
		return [{ text: "no Consultation selected", fg: paint("subtext0") }];
	const lines: ConsultationDetailLine[] = [];
	const push = (text: string, fg: string | undefined = paint("text"), bold?: boolean) => {
		for (const line of wrapToWidth(text, width))
			lines.push({ text: line, fg, ...(bold ? { bold: true } : {}) });
	};
	push(`${consultation.typeName} - ${consultation.repository.displayName}`, paint("text"), true);
	push(`State: ${consultation.state}`);
	push(`Started: ${consultation.createdAt.slice(0, 16).replace("T", " ")}`);
	push(`Agent: ${consultation.agentType} (${consultation.agentName})`);
	if (agentStatus !== null)
		push(
			`Agent status: ${agentStatus}`,
			agentStatus === "blocked" || agentStatus === "unknown" ? paint("yellow") : paint("subtext0"),
		);
	if (consultation.warning !== null) push(`Warning: ${consultation.warning}`, paint("yellow"));
	if (consultation.failure !== null) push(`Failure: ${consultation.failure}`, paint("red"));
	if (consultation.closeResult !== null)
		push(`Close result: ${consultation.closeResult}`, paint("yellow"));
	const unclosedResources = consultation.resources.filter(
		(resource) => resource.owned && !resource.confirmedClosed,
	);
	if (unclosedResources.length > 0) {
		push("Unclosed owned resources:", paint("yellow"));
		for (const resource of unclosedResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, paint("yellow"));
	}
	const retainedResources = consultation.resources.filter((resource) => !resource.owned);
	if (retainedResources.length > 0) {
		push("Retained shared resources:", paint("subtext0"));
		for (const resource of retainedResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, paint("subtext0"));
	}
	if (consultation.replacementOf !== null)
		push(`Replacement of: ${consultation.replacementOf.slice(0, 8)}`, paint("subtext0"));
	if (replacementIds.length > 0)
		push(
			`Replaced by: ${replacementIds.map((id) => id.slice(0, 8)).join(", ")}`,
			paint("subtext0"),
		);
	if (remainingResources.length > 0) {
		push("Remaining resources (recover them in herdr):", paint("yellow"));
		for (const resource of remainingResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, paint("yellow"));
	}
	if (consultation.draft !== "")
		push(
			`Response draft${consultation.draftOld ? " (old - review before sending)" : ""}: ${consultation.draft}`,
			consultation.draftOld ? paint("yellow") : paint("subtext0"),
		);
	lines.push({ text: " ", fg: paint("subtext0") });
	if (liveOutput !== null && consultation.state !== "closed") {
		push("Agent view:", paint("text"), true);
		for (const line of liveOutput.split("\n")) push(line);
	} else {
		push("Captured history:", paint("text"), true);
		for (const turn of turns) {
			push(`Input ${turn.acceptedAt.slice(0, 16).replace("T", " ")}: ${turn.input}`);
			const snapshot = snapshots.find((item) => item.turnId === turn.id);
			if (snapshot !== undefined) {
				push(snapshot.partial ? "Captured partial output:" : "Captured output:", paint("subtext0"));
				for (const line of snapshot.text.split("\n")) push(line, paint("subtext0"));
				if (snapshot.truncated) push("[start of snapshot removed]", paint("yellow"));
			}
		}
		for (const snapshot of snapshots.filter((item) => item.partial)) {
			push(
				`Partial output ${snapshot.capturedAt.slice(0, 16).replace("T", " ")}:`,
				paint("subtext0"),
			);
			for (const line of snapshot.text.split("\n")) push(line, paint("subtext0"));
			if (snapshot.truncated) push("[start of snapshot removed]", paint("yellow"));
		}
	}
	return lines.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
}

interface ConsultationDetailProps {
	lines: readonly ConsultationDetailLine[];
	visibleRows: number;
	scroll: number;
	focused: boolean;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
	onWheel: (delta: number) => void;
	/** Sanitized cell output used only in Agent interaction mode. */
	ansiLines?: readonly AnsiLine[];
}

export function ConsultationDetail({
	lines,
	visibleRows,
	scroll,
	focused,
	ansiLines,
	active = true,
	onFocus,
	onWheel,
}: ConsultationDetailProps) {
	const rootRef = useRef<BoxRenderable | null>(null);
	const handleMouse = paneMouse({
		active: () => active,
		onFocus,
		onWheel: (direction) => onWheel(direction === "up" ? -1 : 1),
	});
	const content =
		ansiLines === undefined
			? windowOf(lines, scroll, visibleRows).map((line, index) =>
					createElement(
						"text",
						{ key: index, fg: line.fg },
						line.bold ? createElement("b", undefined, line.text) : line.text,
					),
				)
			: windowOf(ansiLines, scroll, visibleRows).map((line, index) =>
					createElement(
						"text",
						{ key: index },
						...line.map((span, spanIndex) =>
							createElement(
								"span",
								{
									key: spanIndex,
									fg: span.style.fg,
									bg: span.style.bg,
									attributes: span.style.attributes,
								},
								span.text,
							),
						),
					),
				);
	return createElement(
		"box",
		{
			ref: rootRef,
			onMouse: handleMouse,
			title: focused ? "❯ Agent view" : "  Agent view",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			padding: 1,
			style: { flexGrow: 1, flexShrink: 1, flexDirection: "column", overflow: "hidden" },
		},
		...content,
	);
}
