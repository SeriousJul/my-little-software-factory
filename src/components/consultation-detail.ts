/** The live Agent view and Captured history for one Consultation. */
import { createElement } from "@opentui/react";
import type {
	Consultation,
	ConsultationResource,
	ConsultationSnapshot,
	ConsultationTurn,
} from "../state.ts";
import type { AnsiLine } from "./ansi-screen.ts";
import { windowOf } from "./geometry.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

export function consultationDetailLines(
	consultation: Consultation | undefined,
	turns: readonly ConsultationTurn[],
	snapshots: readonly ConsultationSnapshot[],
	width: number,
	liveOutput: string | null,
	replacementIds: readonly string[] = [],
	agentStatus: string | null = null,
	remainingResources: readonly ConsultationResource[] = [],
): Array<{ text: string; fg: string }> {
	if (consultation === undefined) return [{ text: "no Consultation selected", fg: COLORS.dim }];
	const lines: Array<{ text: string; fg: string }> = [];
	const push = (text: string, fg: string = COLORS.text) => {
		for (const line of wrapToWidth(text, width)) lines.push({ text: line, fg });
	};
	push(`${consultation.typeName} - ${consultation.repository.displayName}`, COLORS.textBright);
	push(`State: ${consultation.state}`);
	push(`Started: ${consultation.createdAt.slice(0, 16).replace("T", " ")}`);
	push(`Agent: ${consultation.agentType} (${consultation.agentName})`);
	if (agentStatus !== null)
		push(
			`Agent status: ${agentStatus}`,
			agentStatus === "blocked" || agentStatus === "unknown" ? COLORS.statusWarning : COLORS.dim,
		);
	if (consultation.warning !== null) push(`Warning: ${consultation.warning}`, COLORS.statusWarning);
	if (consultation.failure !== null) push(`Failure: ${consultation.failure}`, COLORS.statusError);
	if (consultation.closeResult !== null)
		push(`Close result: ${consultation.closeResult}`, COLORS.statusWarning);
	const unclosedResources = consultation.resources.filter(
		(resource) => resource.owned && !resource.confirmedClosed,
	);
	if (unclosedResources.length > 0) {
		push("Unclosed owned resources:", COLORS.statusWarning);
		for (const resource of unclosedResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, COLORS.statusWarning);
	}
	const retainedResources = consultation.resources.filter((resource) => !resource.owned);
	if (retainedResources.length > 0) {
		push("Retained shared resources:", COLORS.dim);
		for (const resource of retainedResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, COLORS.dim);
	}
	if (consultation.replacementOf !== null)
		push(`Replacement of: ${consultation.replacementOf.slice(0, 8)}`, COLORS.dim);
	if (replacementIds.length > 0)
		push(`Replaced by: ${replacementIds.map((id) => id.slice(0, 8)).join(", ")}`, COLORS.dim);
	if (remainingResources.length > 0) {
		push("Remaining resources (recover them in herdr):", COLORS.statusWarning);
		for (const resource of remainingResources)
			push(`${resource.kind} ${resource.resourceId} - ${resource.details}`, COLORS.statusWarning);
	}
	if (consultation.draft !== "")
		push(
			`Response draft${consultation.draftOld ? " (old - review before sending)" : ""}: ${consultation.draft}`,
			consultation.draftOld ? COLORS.statusWarning : COLORS.dim,
		);
	lines.push({ text: " ", fg: COLORS.dim });
	if (liveOutput !== null && consultation.state !== "closed") {
		push("Agent view:", COLORS.textBright);
		for (const line of liveOutput.split("\n")) push(line, COLORS.text);
	} else {
		push("Captured history:", COLORS.textBright);
		for (const turn of turns) {
			push(`Input ${turn.acceptedAt.slice(0, 16).replace("T", " ")}: ${turn.input}`, COLORS.text);
			const snapshot = snapshots.find((item) => item.turnId === turn.id);
			if (snapshot !== undefined) {
				push(snapshot.partial ? "Captured partial output:" : "Captured output:", COLORS.dim);
				for (const line of snapshot.text.split("\n")) push(line, COLORS.dim);
				if (snapshot.truncated) push("[start of snapshot removed]", COLORS.statusWarning);
			}
		}
		for (const snapshot of snapshots.filter((item) => item.partial)) {
			push(`Partial output ${snapshot.capturedAt.slice(0, 16).replace("T", " ")}:`, COLORS.dim);
			for (const line of snapshot.text.split("\n")) push(line, COLORS.dim);
			if (snapshot.truncated) push("[start of snapshot removed]", COLORS.statusWarning);
		}
	}
	return lines.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
}

interface ConsultationDetailProps {
	lines: readonly { text: string; fg: string }[];
	visibleRows: number;
	scroll: number;
	focused: boolean;
	compactHeading?: string;
	/** Sanitized cell output used only in Agent interaction mode. */
	ansiLines?: readonly AnsiLine[];
}

export function ConsultationDetail({
	lines,
	visibleRows,
	scroll,
	focused,
	compactHeading,
	ansiLines,
}: ConsultationDetailProps) {
	const content =
		ansiLines === undefined
			? windowOf(lines, scroll, visibleRows).map((line, index) =>
					createElement("text", { key: index, fg: line.fg }, line.text),
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
			title: compactHeading ?? (focused ? "❯ Agent view" : "  Agent view"),
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			style: { flexGrow: 1, flexShrink: 1, flexDirection: "column", overflow: "hidden" },
		},
		...content,
	);
}
