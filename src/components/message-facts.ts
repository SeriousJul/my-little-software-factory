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
export type WorkingKind = "refresh" | "handoff" | "other";

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

	const working = useCallback((text: string, kind: WorkingKind = "other") => {
		workingKindRef.current = kind;
		// A new operation replaces the outcome the last one left on the line
		// with its own Working progress. Source health is not an operation:
		// it survives so it can return when the progress clears.
		setFacts(() => ({ working: text, operation: undefined }));
	}, []);

	// An outcome never destroys the active progress: the selector ranks the
	// facts, so a Warning written during a refresh waits behind its Working
	// line and appears when the refresh settles (user story 51). Only a new
	// operation, which writes its own Working, replaces an outcome.
	const warning = useCallback(
		(text: string) =>
			setFacts((current) => ({ ...current, operation: { severity: "warning", text } })),
		[],
	);

	const error = useCallback(
		(text: string) =>
			setFacts((current) => ({ ...current, operation: { severity: "error", text } })),
		[],
	);

	/** End one operation's progress and its outcome together. */
	const clearOperation = useCallback(() => {
		workingKindRef.current = null;
		setFacts((current) => ({ ...current, working: undefined, operation: undefined }));
	}, []);

	/** End one operation's progress line, and only that one. */
	const clearWorking = useCallback((kind: WorkingKind) => {
		if (workingKindRef.current !== kind) return;
		workingKindRef.current = null;
		setFacts((current) => ({ ...current, working: undefined }));
	}, []);

	const message = useMemo(() => selectMessage({ ...facts, sourceHealth }), [facts, sourceHealth]);

	return {
		message,
		working,
		warning,
		error,
		clearOperation,
		clearWorking,
	};
}
