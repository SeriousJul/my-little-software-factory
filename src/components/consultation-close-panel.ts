/**
 * The Consultation close panel's copy, in the module the panel and the
 * gallery's examples share.
 *
 * The panel's shape is selected by the record's state alone, so the copy
 * cannot state a fact the record denies: one state word per live Agent,
 * and the surviving resources the close keeps on each environment.
 */
import type { Consultation } from "../state.ts";
import type { ActionRow } from "./modal-chrome.ts";

/**
 * The close panel's copy, selected by the record's state.
 *
 * While the record is `closing`, the panel is the recovery: the cleanup
 * already ran and cannot be confirmed, so the rows offer the retry and the
 * force-close, never the plain close. While a close would stop a live Agent
 * - an `opening`, a `working`, or an `awaiting-response` Consultation - the
 * panel is the confirmation: its first line names the Agent that is alive,
 * and the body states what the close keeps, the worktree and branch on a
 * worktree Consultation and the checkout on a live one. A Consultation the
 * close runs on directly - `missing`, `failed`, `closed` - has no panel: it
 * has no Agent to stop and nothing to recover from.
 */
export function consultationClosePanel(consultation: Consultation):
	| {
			title: string;
			bodyLines: string[];
			actions: ActionRow[];
	  }
	| undefined {
	if (consultation.state === "closing")
		return {
			title: `Close Consultation ${consultation.id.slice(0, 8)}`,
			bodyLines: ["Cleanup is already in progress. Force-close records remaining resources."],
			actions: [
				{ key: "retry", label: "Retry", detail: "retry unconfirmed cleanup" },
				{ key: "force", label: "Force-close", detail: "record cleanup for later recovery" },
				{ key: "cancel", label: "Cancel", detail: "stay in closing state" },
			],
		};
	const line =
		consultation.state === "opening"
			? "The Agent is still opening"
			: consultation.state === "working"
				? "The Agent is working"
				: consultation.state === "awaiting-response"
					? "The Agent has answered and is waiting for your reply"
					: undefined;
	if (line === undefined) return undefined;
	const keeps =
		consultation.environment === "worktree"
			? {
					body: "Close stops the Agent. The worktree and branch stay.",
					detail: "stop the Agent; the work stays",
				}
			: {
					body: "Close stops the Agent. The checkout stays.",
					detail: "stop the Agent; the checkout stays",
				};
	return {
		title: `Close Consultation ${consultation.id.slice(0, 8)}?`,
		bodyLines: [line, keeps.body],
		actions: [
			{ key: "close", label: "Close", detail: keeps.detail },
			{ key: "cancel", label: "Cancel", detail: "keep the Consultation" },
		],
	};
}
