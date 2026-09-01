/** Message facts and the pure priority selector for the Message line. */
import { prefixForSeverity } from "./theme.ts";

export type MessageSeverity = "working" | "warning" | "error";

export interface MessageFact {
	severity: MessageSeverity;
	text: string;
}

/** Facts stay separate so a covered source warning can return later. */
export interface MessageFacts {
	working?: string;
	operation?: { severity: "warning" | "error"; text: string };
	sourceHealth?: string;
}

export function selectMessage(facts: MessageFacts): MessageFact | null {
	if (facts.operation?.severity === "error")
		return { severity: "error", text: facts.operation.text };
	if (facts.working !== undefined) return { severity: "working", text: facts.working };
	if (facts.operation?.severity === "warning")
		return { severity: "warning", text: facts.operation.text };
	if (facts.sourceHealth !== undefined) return { severity: "warning", text: facts.sourceHealth };
	return null;
}

export function formatMessage(fact: MessageFact): string {
	return `${prefixForSeverity(fact.severity)} ${fact.text}`;
}
