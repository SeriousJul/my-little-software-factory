/**
 * The Consultation recovery panel's copy, in the module the panel and the
 * gallery's examples share.
 *
 * The panel answers the Consultation states the operator cannot leave by
 * doing nothing: an `opening` the run interrupted, a `missing` Agent, and a
 * `failed` launch. Its rows name what that record can still do, so the panel
 * cannot state a choice the record denies: a record with a live Agent retries
 * its opening, and a record with no Agent is replaced or retired.
 *
 * A `closing` record needs no panel of its own: the close panel already
 * carries its Retry and Force-close rows, so the recovery control sends that
 * state to the close panel rather than drawing a second one. A `closed`
 * record answers nothing, and a live one reaches its Agent or its response.
 * Both are the catalogue's business, not this module's, so neither has copy
 * here.
 */
import type { Consultation } from "../state.ts";
import type { ActionRow } from "./modal-chrome.ts";

/**
 * The recovery panel's copy, selected by the record's state.
 *
 * `undefined` means the state opens no recovery panel: the record is closing,
 * closed, or live, and the control that asked states why.
 */
export function consultationRecoveryPanel(consultation: Consultation):
	| {
			title: string;
			bodyLines: string[];
			actions: ActionRow[];
	  }
	| undefined {
	if (consultation.state === "opening")
		return {
			title: `Recover Consultation ${consultation.id.slice(0, 8)}`,
			bodyLines: [
				"The Agent never finished opening.",
				"Recover retries the opening this run left behind. Close stops the Agent and closes the record.",
			],
			actions: [
				{ key: "recover", label: "Recover", detail: "retry the interrupted opening" },
				{ key: "close", label: "Close", detail: "stop the Agent; the close confirms" },
			],
		};
	if (consultation.state === "missing" || consultation.state === "failed") {
		const why =
			consultation.state === "missing"
				? "The Agent is gone from its pane."
				: "The launch failed before the Agent ran.";
		const reason = consultation.failure ?? consultation.warning;
		return {
			title: `Recover Consultation ${consultation.id.slice(0, 8)}`,
			bodyLines: [
				why,
				...(reason === null || reason === undefined ? [] : [reason]),
				"Replace opens the launcher on this record's context and links the new Consultation to it.",
				"Close retires this record. Its history stays with it.",
			],
			actions: [
				{
					key: "replace",
					label: "Replace",
					detail: "launch a linked Consultation here",
				},
				{ key: "close", label: "Close", detail: "close the record; nothing to stop" },
			],
		};
	}
	return undefined;
}
