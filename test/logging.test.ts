/**
 * The file logger: level filtering, the line format, and size rotation
 * with the keep window.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, NOOP_LOGGER } from "../src/logging.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "factory-logging-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function linesOf(path: string): Promise<string[]> {
	return readFile(path, "utf8").then((text) => text.split("\n").filter((line) => line !== ""));
}

describe("createLogger", () => {
	test("off keeps no file and no line", async () => {
		const logger = createLogger({
			level: "off",
			file: join(dir, "factory.log"),
			maxSizeBytes: 1024,
			keep: 3,
		});
		logger.debug("a debug line");
		logger.info("an info line");
		logger.warn("a warn line");
		logger.error("an error line");
		await expect(stat(join(dir, "factory.log"))).rejects.toThrow();
	});

	test("the level filters the lines that pass", async () => {
		const file = join(dir, "factory.log");
		const logger = createLogger({ level: "warn", file, maxSizeBytes: 1024 * 1024, keep: 3 });
		logger.debug("no debug");
		logger.info("no info");
		logger.warn("a warn line");
		logger.error("an error line");
		const lines = await linesOf(file);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("a warn line");
		expect(lines[1]).toContain("an error line");
	});

	test("a line carries the ISO timestamp and the level label", async () => {
		const file = join(dir, "factory.log");
		const logger = createLogger({ level: "info", file, maxSizeBytes: 1024 * 1024, keep: 3 });
		const before = Date.now();
		logger.info("an info line");
		const lines = await linesOf(file);
		expect(lines).toHaveLength(1);
		const line = lines[0] as string;
		const timestamp = line.slice(0, line.indexOf(" "));
		expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
		expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before - 5000);
		expect(line).toMatch(/^.* INFO an info line$/u);
	});

	test("a missing parent directory is created", async () => {
		const file = join(dir, "deep", "nest", "factory.log");
		const logger = createLogger({ level: "info", file, maxSizeBytes: 1024 * 1024, keep: 3 });
		logger.info("a line");
		const lines = await linesOf(file);
		expect(lines).toHaveLength(1);
	});

	test("an empty file name keeps the no-op logger", () => {
		expect(createLogger({ level: "info", file: "", maxSizeBytes: 1024, keep: 3 })).toBe(
			NOOP_LOGGER,
		);
	});

	test("the current file rotates at its size, and the rotation keeps the window", async () => {
		const file = join(dir, "factory.log");
		const logger = createLogger({ level: "info", file, maxSizeBytes: 64, keep: 2 });
		// Fill the current file past its size, then write more.
		logger.info("a first line that is long enough to matter here");
		logger.info("a second line that pushes the file past the size now");
		logger.info("a third line that lands after the rotation has run");
		const names = (await readdir(dir)).sort();
		expect(names).toEqual(["factory.log", "factory.log.1", "factory.log.2"]);
		const current = await linesOf(file);
		expect(current).toHaveLength(1);
		expect(current[0]).toContain("a third line");
		const rotated = await linesOf(`${file}.1`);
		expect(rotated).toHaveLength(1);
		expect(rotated[0]).toContain("a second line");
	});

	test("the rotation drops the file that falls out of the keep window", async () => {
		const file = join(dir, "factory.log");
		const logger = createLogger({ level: "info", file, maxSizeBytes: 48, keep: 2 });
		logger.info("line one fills the current file to its size limit");
		logger.info("line two rotates one into the window and keeps going");
		logger.info("line three rotates again and drops the oldest file");
		logger.info("line four rotates a third time on the same small size");
		const names = (await readdir(dir)).sort();
		expect(names).toEqual(["factory.log", "factory.log.1", "factory.log.2"]);
	});

	test("a directory failure ends no line and throws nothing", async () => {
		// A path under a file: mkdir fails, and the plane must keep running.
		const blocker = join(dir, "blocker");
		await (await import("node:fs/promises")).writeFile(blocker, "not a directory\n");
		const logger = createLogger({
			level: "info",
			file: join(blocker, "factory.log"),
			maxSizeBytes: 1024,
			keep: 3,
		});
		expect(() => logger.info("a line the disk refuses")).not.toThrow();
	});

	test("the noop logger answers every level without a file", () => {
		expect(() => {
			NOOP_LOGGER.debug("d");
			NOOP_LOGGER.info("i");
			NOOP_LOGGER.warn("w");
			NOOP_LOGGER.error("e");
		}).not.toThrow();
		expect(NOOP_LOGGER.level).toBe("off");
	});
});
