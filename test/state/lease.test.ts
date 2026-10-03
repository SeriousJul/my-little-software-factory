/**
 * The lease aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openFactoryState } from "../../src/state.ts";
import { cleanup, statePath } from "./harness.ts";

afterEach(cleanup);

describe("the lease aggregate", () => {
	test("closing twice is not an error", () => {
		const path = statePath();
		// The shutdown signals and the process exit hook both close the state, so
		// a run reaches close() more than once. The second close does nothing
		// rather than reporting a connection it already dropped.
		const state = openFactoryState(path);
		state.lease.acquireLease();
		state.close();
		expect(() => state.close()).not.toThrow();
		// The lease is gone and the file is usable again.
		const next = openFactoryState(path);
		next.lease.acquireLease();
		next.close();
	});
});
