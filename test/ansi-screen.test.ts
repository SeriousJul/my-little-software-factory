/**
 * The ANSI screen renderer's tests (issue #203).
 *
 * They stood in the Consultation rules' test file, which tests none of this
 * module. They read `renderAnsiScreen` through its own interface: the spans the
 * renderer answers for one bounded grid.
 */
import { describe, expect, test } from "bun:test";
import { renderAnsiScreen } from "../src/components/ansi-screen.ts";

describe("ANSI screen renderer", () => {
	const texts = (line: ReturnType<typeof renderAnsiScreen>[number]) =>
		line.map((span) => span.text);

	test("renders SGR colors and attributes as spans without control bytes", () => {
		const lines = renderAnsiScreen("\u001b[31mred\u001b[0mp", 5);
		expect(lines).toHaveLength(1);
		const spans = lines[0];
		expect(spans[0]).toMatchObject({ text: "red", style: { fg: "#cd3131" } });
		expect(spans[1].text).toBe("p ");
		expect(spans[1].style.fg).toBeUndefined();
		for (const span of spans) expect(/\p{Cc}/u.test(span.text)).toBe(false);
	});

	test("positions text with cursor movement inside the bounded grid", () => {
		const lines = renderAnsiScreen("A\u001b[1;5HB", 5);
		expect(lines).toHaveLength(1);
		// CUP 1;5 is row 1, column 5: B lands after A and three blanks.
		expect(texts(lines[0]).join("")).toBe("A   B");
	});

	test("skips OSC and unknown CSI sequences instead of leaking them", () => {
		const lines = renderAnsiScreen("\u001b]0;title\u0007\u001b[?25lx", 4);
		expect(lines).toHaveLength(1);
		expect(texts(lines[0]).join("")).toBe("x   ");
	});

	test("treats a wide character as two cells", () => {
		const lines = renderAnsiScreen("a😀b", 4);
		expect(lines).toHaveLength(1);
		expect(texts(lines[0]).join("")).toBe("a😀b");
	});

	test("erases with EL and ED", () => {
		// EL mode 0 erases from the cursor to the end of the line.
		const el = renderAnsiScreen("abcd\u001b[K", 8);
		expect(texts(el[0]).join("")).toBe("abcd    ");
		// EL mode 2 erases the whole line.
		const whole = renderAnsiScreen("abcd\u001b[2K", 8);
		expect(texts(whole[0]).join("")).toBe("        ");
		// ED mode 2 clears the screen; new output starts at the origin.
		const screen = renderAnsiScreen("a\nb\u001b[2Jc", 4);
		expect(screen).toHaveLength(1);
		expect(texts(screen[0]).join("")).toBe("c   ");
	});

	test("bounds the grid to the maximum row count", () => {
		const lines = renderAnsiScreen("a\n".repeat(10), 4, 3);
		expect(lines).toHaveLength(3);
		for (const line of lines)
			expect(line.reduce((total, span) => total + span.text.length, 0)).toBeLessThanOrEqual(4);
	});

	test("ignores invalid SGR parameters instead of applying them", () => {
		const lines = renderAnsiScreen("\u001b[999mx", 4);
		expect(texts(lines[0]).join("")).toBe("x   ");
		expect(lines[0][0].style.fg).toBeUndefined();
	});
});
