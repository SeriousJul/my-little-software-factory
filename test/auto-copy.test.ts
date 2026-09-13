/**
 * Auto copy: a mouse selection the operator drags over any surface is copied
 * to the system clipboard when the drag ends.
 *
 * The tests assert only external behavior - the text the renderer's OSC 52
 * write received, the painted frame, and the Message line - and never inspect
 * the renderer's selection internals. The clipboard write is one public method
 * on the booted renderer; each test patches it to record the text and to choose
 * success or refusal, so no injectable enters the app. The real system
 * clipboard is not verified by the suite; the test renderer stands in for it.
 */
import { describe, expect, test } from "vitest";

import {
	type AppSetup,
	awaitFrame,
	detailPaneText,
	frameText,
	markerRowOf,
	messageRowOf,
	mouseClick,
	mouseDrag,
	paneRow,
	settle,
	withApp,
} from "./app-harness.ts";

/** The one write the Auto copy path makes on a selection that ended with text. */
const COPY_REFUSED_TEXT = "The terminal refused the copied text";

/**
 * Patch the booted renderer's clipboard write so a test records the text Auto
 * copy hands it and chooses whether the terminal takes it.
 */
function recordClipboard(
	setup: AppSetup,
	accept: boolean,
): { writes: string[]; restore: () => void } {
	const writes: string[] = [];
	const renderer = setup.renderer;
	const original = renderer.copyToClipboardOSC52.bind(renderer);
	renderer.copyToClipboardOSC52 = ((text: string) => {
		writes.push(text);
		return accept;
	}) as typeof renderer.copyToClipboardOSC52;
	return {
		writes,
		restore: () => {
			renderer.copyToClipboardOSC52 = original;
		},
	};
}

/** The drag a test runs over the ticket detail's first content line. */
async function dragOverDetail(setup: AppSetup): Promise<void> {
	await mouseDrag(setup, [70, paneRow(2)], [100, paneRow(2)]);
	await settle(setup);
}

describe("Auto copy", () => {
	test("a drag over ticket detail text ends with the selected text on the clipboard", async () => {
		await withApp(async (setup) => {
			const clipboard = recordClipboard(setup, true);
			try {
				await dragOverDetail(setup);
				// A drag that ended with a selection makes exactly one write, and
				// the write carries the text the drag highlighted, not an empty
				// run a click that did not drag would leave.
				expect(clipboard.writes).toHaveLength(1);
				expect(clipboard.writes[0]).not.toBe("");
				// The written text is a run of the detail's own cells.
				expect(detailPaneText(setup.captureCharFrame())).toContain(clipboard.writes[0]);
			} finally {
				clipboard.restore();
			}
		});
	});

	test("a click that does not drag records no clipboard write", async () => {
		await withApp(async (setup) => {
			const clipboard = recordClipboard(setup, true);
			try {
				await mouseClick(setup, 70, paneRow(2));
				await settle(setup);
				expect(clipboard.writes).toHaveLength(0);
			} finally {
				clipboard.restore();
			}
		});
	});

	test("a copy the terminal refused warns on the Message line; a copy that takes is silent", async () => {
		await withApp(async (setup) => {
			const clipboard = recordClipboard(setup, false);
			try {
				await dragOverDetail(setup);
				expect(clipboard.writes).toHaveLength(1);
				// The refusal is the shared warning the field Copy control says,
				// carried on the Message line with its warning prefix.
				const warned = await awaitFrame(
					setup,
					(frame) => frameText(frame).includes(COPY_REFUSED_TEXT),
					"the refused-copy warning on the Message line",
				);
				expect(messageRowOf(warned)).toContain(`Warning: ${COPY_REFUSED_TEXT}`);
			} finally {
				clipboard.restore();
			}

			// A write the terminal takes leaves the Message line alone.
			await withApp(async (inner) => {
				const taken = recordClipboard(inner, true);
				try {
					await dragOverDetail(inner);
					expect(taken.writes).toHaveLength(1);
					const silent = await settle(inner);
					expect(frameText(silent)).not.toContain(COPY_REFUSED_TEXT);
					// No "copied" indicator: the Message line stays blank.
					expect(messageRowOf(silent).trim()).toBe("");
				} finally {
					taken.restore();
				}
			});
		});
	});

	test("a drag over a list row leaves the row selection as the press set it", async () => {
		await withApp(async (setup) => {
			const clipboard = recordClipboard(setup, true);
			try {
				// The press lands on one row and selects that Ticket. The drag
				// runs to a lower row, and the release must not fire a second
				// press that would move the selection to where it lifted off.
				const pressRow = paneRow(3);
				const releaseRow = paneRow(6);
				await mouseDrag(setup, [4, pressRow], [4, releaseRow]);
				const frame = await awaitFrame(
					setup,
					(frame) => markerRowOf(frame) === pressRow,
					"the selection to stay on the pressed row",
				);
				expect(markerRowOf(frame)).toBe(pressRow);
				// The release lifted off a different row, so if it had fired a
				// press the marker would sit there instead.
				expect(markerRowOf(frame)).not.toBe(releaseRow);
			} finally {
				clipboard.restore();
			}
		});
	});
});
