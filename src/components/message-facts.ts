/** The Message line's facts: what kind of message is visible, and why. */
import { useCallback, useMemo, useRef, useState } from "react";

import { type MessageFacts, selectMessage } from "./messages.ts";

/**
 * Which operation owns a progress line.
 *
 * Only one operation of a kind runs at a time, and each clears the progress
 * it wrote when it settles. A Handoff's completion must not erase a refresh
 * the operator started while it ran, and a settled refresh must not erase
 * the Handoff it covers.
 */
export type WorkingKind = "refresh" | "handoff";

/**
 * Whose progress line a call may clear.
 *
 * `none` names a caller that writes no progress line of its own: an action
 * that ends the outcome it left on the Message line and leaves whatever
 * progress is running alone.
 */
export type ProgressOwner = WorkingKind | "none";

/**
 * The working, operation, and source-health facts behind the Message line,
 * with the writers the shell dispatches through. The display value (prefix
 * and truncation) stays with the shell, which knows the terminal width.
 */
export function useMessageFacts(sourceHealth: string | undefined) {
	const [facts, setFacts] = useState<MessageFacts>({});
	// The kind of the visible working fact, so a settle clears its own
	// progress and no one else's.
	const workingKindRef = useRef<WorkingKind | null>(null);

	/** Whether the progress line named by a caller is the visible one. */
	const takesWorking = useCallback((owner: ProgressOwner): boolean => {
		if (workingKindRef.current === null || workingKindRef.current !== owner) return false;
		workingKindRef.current = null;
		return true;
	}, []);

	// A new operation replaces the outcome the last one left on the line with
	// its own Working progress. Source health is not an operation: it
	// survives so it can return when the progress clears.
	const working = useCallback((text: string, kind: WorkingKind) => {
		workingKindRef.current = kind;
		setFacts((current) => ({ ...current, working: text, operation: undefined }));
	}, []);

	/**
	 * Answer a control the app will decide without the operator.
	 *
	 * A notice is not progress: it holds its own slot, below the facts an
	 * operation writes, and the next fact of any kind, or the end of the
	 * progress line it waits behind, takes the line back. It can never pin
	 * the Message line.
	 */
	const notice = useCallback(
		(text: string) => setFacts((current) => ({ ...current, operation: undefined, notice: text })),
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
				notice: undefined,
			})),
		[],
	);

	const error = useCallback(
		(text: string) =>
			setFacts((current) => ({
				...current,
				operation: { severity: "error", text },
				notice: undefined,
			})),
		[],
	);

	/**
	 * End one operation: its outcome, and only the progress line it owns.
	 *
	 * A clean success clears its own `Working:` line and reveals any source
	 * health still under it. The progress of an operation still running,
	 * which is a different owner, stays on the line, and so does the notice
	 * that answers the operator's last control.
	 */
	const clearOperation = useCallback(
		(owner: ProgressOwner) => {
			const ownsProgress = takesWorking(owner);
			setFacts((current) => ({
				...current,
				operation: undefined,
				notice: undefined,
				working: ownsProgress ? undefined : current.working,
			}));
		},
		[takesWorking],
	);

	/** End one operation's progress line, and only that one. */
	const clearWorking = useCallback(
		(owner: ProgressOwner) => {
			if (!takesWorking(owner)) return;
			setFacts((current) => ({ ...current, working: undefined, notice: undefined }));
		},
		[takesWorking],
	);

	const message = useMemo(() => selectMessage({ ...facts, sourceHealth }), [facts, sourceHealth]);

	return {
		message,
		working,
		notice,
		warning,
		error,
		clearOperation,
		clearWorking,
	};
}
