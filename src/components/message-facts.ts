/** The Message line's facts: what kind of message is visible, and why. */
import { useCallback, useMemo, useRef, useState } from "react";

import { type MessageFacts, selectMessage } from "./messages.ts";

/**
 * The working, operation, and source-health facts behind the Message line,
 * with the writers the shell dispatches through. The display value (prefix
 * and truncation) stays with the shell, which knows the terminal width.
 */
export function useMessageFacts(sourceHealth: string | undefined) {
	const [facts, setFacts] = useState<MessageFacts>({});
	// The kind of the visible working fact: a manual refresh settles on its
	// own, and an in-flight handoff owns its Working until it settles.
	const workingKindRef = useRef<"refresh" | "other" | null>(null);

	const working = useCallback((text: string, kind: "refresh" | "other" = "other") => {
		workingKindRef.current = kind;
		// A new operation replaces the outcome the last one left on the line
		// with its own Working progress. Source health is not an operation:
		// it survives so it can return when the progress clears.
		setFacts((current) => ({ working: text, operation: undefined }));
	}, []);

	const warning = useCallback((text: string) => {
		workingKindRef.current = null;
		setFacts((current) => ({
			...current,
			working: undefined,
			operation: { severity: "warning", text },
		}));
	}, []);

	const error = useCallback((text: string) => {
		workingKindRef.current = null;
		setFacts((current) => ({
			...current,
			working: undefined,
			operation: { severity: "error", text },
		}));
	}, []);

	const clearOperation = useCallback(() => {
		workingKindRef.current = null;
		setFacts((current) => ({ ...current, working: undefined, operation: undefined }));
	}, []);

	const clearWorking = useCallback(() => {
		workingKindRef.current = null;
		setFacts((current) => ({ ...current, working: undefined }));
	}, []);

	// A settled refresh clears its own Working line only: an in-flight
	// handoff keeps the Working it wrote itself.
	const clearRefreshWorking = useCallback(() => {
		if (workingKindRef.current !== "refresh") return;
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
		clearRefreshWorking,
	};
}
