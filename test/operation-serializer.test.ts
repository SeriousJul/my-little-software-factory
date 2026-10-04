/**
 * The operation serializer, read through its interface (issue #203).
 *
 * The serializer is a concurrency control, so its test names the concurrency
 * fact it owns: work on one Repository is serialized, and work on another never
 * waits behind it.
 */
import { describe, expect, test } from "bun:test";
import { serializeRepositoryOperation } from "../src/operation-serializer.ts";

describe("the operation serializer", () => {
	test("serializes operations for one repository and does not block another", async () => {
		const queues = new Map<string, Promise<void>>();
		const events: string[] = [];
		let release!: () => void;
		const first = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("first-start");
			await new Promise<void>((resolve) => (release = resolve));
			events.push("first-end");
		});
		const second = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("second");
		});
		const other = serializeRepositoryOperation(queues, "github.com/acme/other", async () => {
			events.push("other");
		});
		await other;
		expect(events).toEqual(["first-start", "other"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first-start", "other", "first-end", "second"]);
	});

	test("holds a second live safety check until the first Agent creation settles", async () => {
		const queues = new Map<string, Promise<void>>();
		const events: string[] = [];
		let release!: () => void;
		const first = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("first safety");
			await new Promise<void>((resolve) => (release = resolve));
			events.push("first Agent creation");
		});
		const second = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("second safety");
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual(["first safety"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first safety", "first Agent creation", "second safety"]);
	});

	test("reads one Repository under either spelling of its identity", async () => {
		// The queue key is the canonical identity: an identity the operator wrote
		// with the API's casing and the canonical one hold the same lock.
		const queues = new Map<string, Promise<void>>();
		const events: string[] = [];
		let release!: () => void;
		const first = serializeRepositoryOperation(queues, "GitHub.com/Acme/Factory", async () => {
			events.push("first");
			await new Promise<void>((resolve) => (release = resolve));
		});
		const second = serializeRepositoryOperation(queues, "github.com/acme/factory", async () => {
			events.push("second");
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(events).toEqual(["first"]);
		release();
		await Promise.all([first, second]);
		expect(events).toEqual(["first", "second"]);
	});
});
