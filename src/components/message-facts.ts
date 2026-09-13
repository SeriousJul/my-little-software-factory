/** The Message line's facts: what kind of message is visible, and why. */
import { useCallback, useMemo, useRef, useState } from "react";

import { type MessageFact, type MessageFacts, selectMessage } from "./messages.ts";

/**
 * Which operation owns a progress line.
 *
 * The owner is the operation's own identity, never its kind. Only one refresh
 * and one Handoff run at a time, so their names are enough for them, but any
 * number of Consultation operations run at once - one per Repository - so each
 * carries the Consultation it works on. Each owner clears the progress it
 * wrote when it settles: a Handoff's completion must not erase a refresh the
 * operator started while it ran, a settled refresh must not erase the Handoff
 * it covers, and the settle of one Consultation operation must not erase the
 * progress of the one still running beside it.
 */
export type WorkingOwner = "refresh" | "handoff" | `consultation:${string}`;

/** The progress owner of one Consultation operation. */
export const consultationProgressOwner = (consultationId: string): WorkingOwner =>
	`consultation:${consultationId}`;

/**
 * Whose progress line a call may clear.
 *
 * `none` names a caller that writes no progress line of its own: an action
 * that ends the outcome it left on the Message line and leaves whatever
 * progress is running alone.
 */
export type ProgressOwner = WorkingOwner | "none";

/**
 * The working, operation, and source-health facts behind the Message line,
 * with the writers the shell dispatches through. The display value (prefix
 * and truncation) stays with the shell, which knows the terminal width.
 */
export function useMessageFacts(sourceHealth: string | undefined) {
	const [facts, setFacts] = useState<MessageFacts>({});
	// The progress lines of the operations that are running right now, oldest
	// first. One Message line shows the last one written, and a settle returns
	// the line to whichever operation still runs.
	const workingLines = useRef(new Map<WorkingOwner, string>());

	/** The line a settle leaves on the Message line: the next runner's, if any. */
	const visibleWorking = useCallback((): string | undefined => {
		const entries = [...workingLines.current.values()];
		return entries.at(-1);
	}, []);

	const dropWorking = useCallback((owner: WorkingOwner) => {
		if (!workingLines.current.has(owner)) return false;
		workingLines.current.delete(owner);
		return true;
	}, []);

	/**
	 * Write one operation's progress line.
	 *
	 * A new operation replaces the outcome the last one left on the line with
	 * its own Working progress, and the covered operation's own line returns
	 * when it settles. Source health is not an operation: it survives so it can
	 * return when the progress clears.
	 */
	const working = useCallback((text: string, owner: WorkingOwner) => {
		// Rewrite the owner's entry last, so it is the line the Message shows.
		workingLines.current.delete(owner);
		workingLines.current.set(owner, text);
		setFacts((current) => ({ ...current, working: text, operation: undefined }));
	}, []);

	/**
	 * State what a control did, when it did it and there is nothing to warn about.
	 *
	 * A result is not a refusal and not progress, so it holds its own slot and
	 * wears its own prefix: the line an operator reads after a control that ran
	 * must not say `Warning:` about a copy that took.
	 */
	const news = useCallback(
		(text: string) =>
			setFacts((current) => ({
				...current,
				operation: undefined,
				notice: undefined,
				news: text,
			})),
		[],
	);

	/**
	 * Answer a control the app will decide without the operator.
	 *
	 * A notice is not progress: it holds its own slot, below the facts an
	 * operation writes, and the next fact of any kind, or the end of the
	 * progress line it waits behind, takes the line back. It can never pin
	 * the Message line.
	 */
	const notice = useCallback(
		(text: string) =>
			setFacts((current) => ({ ...current, operation: undefined, news: undefined, notice: text })),
		[],
	);

	// An outcome never destroys the active progress: the selector ranks the
	// facts, so a Warning written during a refresh waits behind its Working
	// line and appears when the refresh settles (user story 51). Only a new
	// operation, which writes its own Working, replaces an outcome.
	const warning = useCallback(
		(text: string) =>
			setFacts((current) => ({
				...current,
				operation: { severity: "warning", text },
				news: undefined,
				notice: undefined,
			})),
		[],
	);

	const error = useCallback(
		(text: string) =>
			setFacts((current) => ({
				...current,
				operation: { severity: "error", text },
				news: undefined,
				notice: undefined,
			})),
		[],
	);

	/**
	 * End one operation: its outcome, and only the progress line it owns.
	 *
	 * A clean success clears its own `Working:` line and reveals any source
	 * health still under it. The progress of an operation still running is
	 * never erased: a Handoff that settles while a Consultation runs returns
	 * the line to that Consultation rather than leaving it blank (user
	 * story 16), and so does the notice that answers the operator's last
	 * control.
	 */
	const clearOperation = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			setFacts((current) => ({
				...current,
				operation: undefined,
				news: undefined,
				notice: undefined,
				working: owned ? visibleWorking() : current.working,
			}));
		},
		[dropWorking, visibleWorking],
	);

	/** End one operation's progress line, and only that one. */
	const clearWorking = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			if (!owned) return;
			setFacts((current) => ({
				...current,
				working: visibleWorking(),
				notice: undefined,
			}));
		},
		[dropWorking, visibleWorking],
	);

	/** End progress while preserving the outcome it uncovered. */
	const clearProgress = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			if (!owned) return;
			setFacts((current) => ({ ...current, working: visibleWorking() }));
		},
		[dropWorking, visibleWorking],
	);

	const message = useMemo(() => selectMessage({ ...facts, sourceHealth }), [facts, sourceHealth]);

	/**
	 * Report the result of a control that ran, routed by the severity the
	 * control named.
	 *
	 * A copy that took is news; a copy the terminal refused is a warning the
	 * operator must keep. The control states which in the fact it reports, and
	 * the shell writes the matching slot, so a surface never has to choose the
	 * channel its result belongs on.
	 */
	const report = useCallback(
		(fact: MessageFact) => {
			if (fact.severity === "info") news(fact.text);
			else if (fact.severity === "warning") warning(fact.text);
			else error(fact.text);
		},
		[news, warning, error],
	);

	return {
		message,
		working,
		news,
		notice,
		warning,
		error,
		report,
		clearOperation,
		clearWorking,
		clearProgress,
	};
}
