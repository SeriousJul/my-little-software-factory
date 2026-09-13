import { describe, expect, test } from "vitest";

import { listWindow } from "../src/components/list-pane.ts";

describe("shared list pane behavior", () => {
	test("keeps the selected row visible and clamps the window", () => {
		const items = ["a", "b", "c", "d", "e"];

		expect(listWindow(items, 0, 3)).toEqual({ start: 0, visible: ["a", "b", "c"] });
		expect(listWindow(items, 3, 3)).toEqual({ start: 1, visible: ["b", "c", "d"] });
		expect(listWindow(items, 99, 3)).toEqual({ start: 2, visible: ["c", "d", "e"] });
	});
});
