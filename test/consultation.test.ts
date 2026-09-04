import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { renderAnsiScreen } from "../src/components/ansi-screen.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	boundedReplacementInput,
	CONSULTATION_INPUT_LIMIT,
	ConsultationInputQueue,
	type ConsultationRepositoryOption,
	consultationRepositoryCatalog,
	isLiteralText,
	serializeRepositoryOperation,
	translateAgentKey,
	validateConsultationInput,
	validateConsultationRepositoryOptions,
	validateResponseInput,
} from "../src/consultation.ts";
import { expandHome, realPathOf } from "../src/repo.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { FakeRunner } from "./fake-runner.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function makeState() {
	const directory = mkdtempSync(join(tmpdir(), "factory-consultation-"));
	directories.push(directory);
	return openFactoryState(join(directory, "state.sqlite"));
}

/** A file-backed state plus its path, for restart tests. */
function makeStateFile(): { state: FactoryState; path: string } {
	const directory = mkdtempSync(join(tmpdir(), "factory-consultation-"));
	directories.push(directory);
	const path = join(directory, "state.sqlite");
	return { state: openFactoryState(path), path };
}

function createConsultation(state: FactoryState, id = "consultation-1") {
	return state.createConsultation({
		id,
		typeName: "grill-with-docs",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		contextWindow: "",
		template: "/skill:grill-with-docs {input}",
		initialInput: "Review this repository",
		renderedOpeningPrompt: "/skill:grill-with-docs Review this repository",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
			path: "/tmp/factory",
		},
		agentName: "consultation-11111111",
		createdAt: "2026-09-01T00:00:00.000Z",
	});
}

describe("Consultation input and interaction rules", () => {
	test("limits input by UTF-8 bytes and preserves literal Unicode text", () => {
		expect(validateConsultationInput("😀", 4)).toBeUndefined();
		expect(validateConsultationInput("😀", 3)).toContain("4 UTF-8 bytes");
		expect(validateResponseInput("\n\tanswer")).toBeUndefined();
		expect(validateResponseInput("   ")).toBe("response cannot be empty");
		expect(isLiteralText("é😀\n\t")).toBe(true);
		expect(isLiteralText("safe\u001b[31m")).toBe(false);
	});

	test("refuses input over the 64 KiB default limit by UTF-8 bytes", () => {
		const atLimit = "a".repeat(64 * 1024);
		const overLimit = "a".repeat(64 * 1024 + 1);
		expect(CONSULTATION_INPUT_LIMIT).toBe(64 * 1024);
		expect(validateConsultationInput(atLimit)).toBeUndefined();
		expect(validateConsultationInput(overLimit)).toBe(
			`initial input is ${64 * 1024 + 1} UTF-8 bytes; the limit is ${64 * 1024}`,
		);
		// A multi-byte character straddling the limit is counted by bytes.
		expect(validateConsultationInput(`${"a".repeat(64 * 1024 - 4)}😀`)).toBeUndefined();
		expect(validateConsultationInput(`${"a".repeat(64 * 1024 - 3)}😀`)).toContain(
			"UTF-8 bytes; the limit",
		);
		expect(validateResponseInput(overLimit)).toContain("UTF-8 bytes; the limit");
	});

	test("maps semantic keys and lets AltGr text pass through", () => {
		expect(translateAgentKey({ name: "up" }, "f12")).toEqual({ kind: "key", key: "up" });
		expect(translateAgentKey({ name: "@", meta: true }, "f12")).toEqual({
			kind: "text",
			text: "@",
		});
		expect(translateAgentKey({ name: "f12" }, "f12")).toBeNull();
		expect(translateAgentKey({ name: "q", ctrl: true }, "f12")).toEqual({
			kind: "key",
			key: "ctrl+q",
		});
	});

	test("bounds replacement context even when the limit cuts through Unicode", () => {
		const result = boundedReplacementInput("😀".repeat(100), [{ input: "é".repeat(100) }], 40);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(40);
		expect(result).toContain("recovery context omitted");
	});
});

describe("Agent interaction input queue", () => {
	test("batches consecutive literal text into one send-text", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "hel" }),
			queue.enqueue("pane-1", { kind: "text", text: "lo" }),
		]);
		await queue.flush();
		expect(runner.commands()).toEqual(["herdr pane send-text pane-1 hello"]);
	});

	test("flushes literal text before a semantic key", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner);
		queue.enqueue("pane-1", { kind: "text", text: "hello" });
		await queue.enqueue("pane-1", { kind: "key", key: "enter" });
		await queue.flush();
		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 hello",
			"herdr pane send-keys pane-1 enter",
		]);
	});

	test("keeps UTF-8 batches within the byte bound without splitting characters", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner, 8);
		const text = "aé😀😀"; // 3 + 4 + 4 = 11 bytes
		queue.enqueue("pane-1", { kind: "text", text });
		await queue.flush();
		const parts = runner.commands().map((command) => command.split(" ").slice(4).join(" "));
		expect(parts.join("")).toBe(text);
		for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(8);
	});

	test("runs commands in enqueue order, never concurrently", async () => {
		const events: string[] = [];
		let active = 0;
		let peak = 0;
		const runner: CommandRunner = {
			run: async (_command, args) => {
				active += 1;
				peak = Math.max(peak, active);
				events.push(args.join(" "));
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			listModels: async () => ({ ok: false, reason: "no model list here" }),
		};
		const queue = new ConsultationInputQueue(runner);
		queue.enqueue("pane-1", { kind: "text", text: "one" });
		await queue.enqueue("pane-1", { kind: "key", key: "enter" });
		await queue.enqueue("pane-1", { kind: "key", key: "up" });
		await queue.flush();
		expect(events).toEqual([
			"pane send-text pane-1 one",
			"pane send-keys pane-1 enter",
			"pane send-keys pane-1 up",
		]);
		expect(peak).toBe(1);
	});

	test("flush waits until every queued command settles", async () => {
		let settled = 0;
		const runner: CommandRunner = {
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				settled += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			listModels: async () => ({ ok: false, reason: "no model list here" }),
		};
		const queue = new ConsultationInputQueue(runner);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "a" }),
			queue.enqueue("pane-1", { kind: "key", key: "enter" }),
		]);
		await queue.flush();
		expect(settled).toBe(2);
	});
});

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

describe("launcher repository validation", () => {
	test("keeps a visible Ticket Repository without an explicit mapping", async () => {
		const visible = {
			repositoryRef: {
				identity: "github.com/acme/unmapped",
				displayName: "acme/unmapped",
				cloneUrl: "https://github.com/acme/unmapped.git",
			},
		};
		const catalog = consultationRepositoryCatalog({ ...DEFAULT_CONFIG, repos: {} }, [visible]);
		expect(catalog).toEqual([
			expect.objectContaining({ identity: "github.com/acme/unmapped", path: "" }),
		]);
		expect(
			await validateConsultationRepositoryOptions(catalog, new FakeRunner(), homedir()),
		).toEqual(catalog);
	});

	const option: ConsultationRepositoryOption = {
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
		path: "/tmp/factory",
	};

	function verifiedRunner(path: string, remote = "https://github.com/acme/factory.git") {
		const runner = new FakeRunner();
		runner.set("git", ["-C", expandHome(path, homedir()), "rev-parse", "--git-dir"], {
			stdout: ".git\n",
		});
		runner.set("git", ["-C", expandHome(path, homedir()), "remote", "get-url", "origin"], {
			stdout: `${remote}\n`,
		});
		return runner;
	}

	test("keeps a verified mapping and resolves its canonical path", async () => {
		const path = mkdtempSync(join(tmpdir(), "factory-repo-"));
		directories.push(path);
		const options = await validateConsultationRepositoryOptions(
			[{ ...option, path }],
			verifiedRunner(path),
			homedir(),
		);
		expect(options).toHaveLength(1);
		expect(options[0].path).toBe(realpathSync(path));
		expect(await realPathOf(options[0].path)).toBe(realpathSync(path));
	});

	test("drops mappings that fail verification", async () => {
		const good = mkdtempSync(join(tmpdir(), "factory-repo-"));
		directories.push(good);
		const options = await validateConsultationRepositoryOptions(
			[
				{ ...option, path: good },
				{ ...option, path: join(good, "missing") },
			],
			verifiedRunner(good),
			homedir(),
		);
		expect(options.map((item) => item.path)).toEqual([realpathSync(good)]);
	});

	test("drops a checkout whose remote does not match", async () => {
		const path = mkdtempSync(join(tmpdir(), "factory-repo-"));
		directories.push(path);
		const options = await validateConsultationRepositoryOptions(
			[{ ...option, path }],
			verifiedRunner(path, "https://github.com/acme/other.git"),
			homedir(),
		);
		expect(options).toEqual([]);
	});
});

describe("durable Consultation lifecycle", () => {
	test("stores turns, snapshots, old drafts, partial output, and replacement context", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "workspace-1",
			sessionId: "session-1",
		});
		expect(state.consultation(consultation.id)?.state).toBe("working");
		expect(state.settleConsultationTurn(consultation.id, 1, "first answer", "idle")).toBe(true);
		state.setConsultationDraft(consultation.id, "draft response");
		// A response is a durable pending delivery until Herdr accepts it.
		const pending = state.beginConsultationResponse(consultation.id, "second question", 1);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		expect(state.consultation(consultation.id)?.state).toBe("awaiting-response");
		expect(state.consultationTurns(consultation.id)).toHaveLength(1);
		state.setConsultationDraft(consultation.id, "old draft", true);
		const turn = state.acceptConsultationResponse(consultation.id, pending.id);
		expect(turn).toMatchObject({ input: "second question", sequenceBaseline: 1 });
		// The Consultation is working after accepting its own second turn.
		expect(state.settleConsultationTurn(consultation.id, 2, "second answer", "blocked")).toBe(true);
		const stored = state.consultation(consultation.id);
		expect(stored).toMatchObject({ state: "awaiting-response", latestSequence: 2, draft: "" });
		expect(state.consultationSnapshots(consultation.id)).toHaveLength(2);
		expect(state.consultationTurns(consultation.id)).toHaveLength(2);
		expect(state.replacementInput(consultation.id)).toContain("Original input:");
		expect(state.replacementInput(consultation.id)).toContain(
			"Operator response:\nsecond question",
		);
		expect(state.replacementInput(consultation.id)).not.toContain(
			"Operator response:\nReview this repository",
		);
		state.captureConsultationPartial(consultation.id, "partial 😀 output");
		expect(state.consultationSnapshots(consultation.id).some((snapshot) => snapshot.partial)).toBe(
			true,
		);
		state.close();
	});

	test("keeps at most one pending response and accepts only its id", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "answer");
		const first = state.beginConsultationResponse(consultation.id, "a", 1);
		expect(first).toBeDefined();
		if (first === undefined) throw new Error("pending delivery missing");
		expect(state.beginConsultationResponse(consultation.id, "b", 1)).toBeUndefined();
		expect(state.acceptConsultationResponse(consultation.id, "some-other-id")).toBeUndefined();
		expect(state.pendingConsultationResponse(consultation.id)?.id).toBe(first.id);
		expect(state.acceptConsultationResponse(consultation.id, first.id)).toBeDefined();
		expect(state.pendingConsultationResponse(consultation.id)).toBeNull();
		expect(state.consultationTurns(consultation.id)).toHaveLength(2);
		state.close();
	});

	test("adopts the pending input when the Agent settles the turn externally", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "first answer");
		const pending = state.beginConsultationResponse(consultation.id, "second question", 1);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		expect(state.recordExternalConsultationTurn(consultation.id, 2)).toBe(true);
		const turns = state.consultationTurns(consultation.id);
		expect(turns).toHaveLength(2);
		expect(turns[1]).toMatchObject({ input: "second question", sequenceBaseline: 1 });
		expect(state.pendingConsultationResponse(consultation.id)).toBeNull();
		expect(state.consultation(consultation.id)?.state).toBe("working");
		// The delivery is consumed exactly once: a later accept is a no-op.
		expect(state.acceptConsultationResponse(consultation.id, pending.id)).toBeUndefined();
		state.close();
	});

	test("ignores an external turn for a consultation that does not exist", () => {
		const state = makeState();
		expect(state.recordExternalConsultationTurn("no-such-consultation", 1)).toBe(false);
		state.close();
	});

	test("ignores an external turn while the Agent works on a response", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "answer");
		const pending = state.beginConsultationResponse(consultation.id, "second question", 1);
		if (pending === undefined) throw new Error("pending delivery missing");
		state.acceptConsultationResponse(consultation.id, pending.id);
		expect(state.consultation(consultation.id)?.state).toBe("working");
		expect(state.recordExternalConsultationTurn(consultation.id, 2)).toBe(false);
		state.close();
	});

	test("preserves a draft when a pending delivery is rejected", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "answer");
		state.setConsultationDraft(consultation.id, "follow up");
		const pending = state.beginConsultationResponse(consultation.id, "follow up", 1);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		// The Consultation still waits for its response; no turn was committed.
		expect(state.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.consultationTurns(consultation.id)).toHaveLength(1);
		expect(state.cancelConsultationResponse(consultation.id, pending.id)).toBe(true);
		expect(state.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.pendingConsultationResponse(consultation.id)).toBeNull();
		expect(state.cancelConsultationResponse(consultation.id, pending.id)).toBe(false);
		state.close();
	});

	test("keeps a failed opening immutable and recoverable only while opening", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		expect(state.consultation(consultation.id)?.state).toBe("opening");
		expect(state.canRecoverConsultationOpening(consultation.id)).toBe(true);
		state.failConsultationOpening(consultation.id, "herdr refused the launch");
		expect(state.consultation(consultation.id)).toMatchObject({
			state: "failed",
			failure: "herdr refused the launch",
		});
		expect(state.canRecoverConsultationOpening(consultation.id)).toBe(false);
		// A failed record cannot resume work; only close-family moves remain.
		expect(state.setConsultationState(consultation.id, "opening")).toBe(false);
		expect(state.setConsultationState(consultation.id, "working")).toBe(false);
		expect(state.setConsultationState(consultation.id, "awaiting-response")).toBe(false);
		expect(state.setConsultationState(consultation.id, "closing")).toBe(true);
		state.close();
	});

	test("backs up a missing snapshot on a later successful read", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		// The first poll saw the Agent settle before any output was captured.
		expect(state.settleConsultationTurn(consultation.id, 1, null, "idle")).toBe(true);
		expect(state.consultationNeedsSnapshot(consultation.id)).toBe(true);
		expect(state.fillConsultationSnapshot(consultation.id, "late output")).toBe(true);
		expect(state.consultationNeedsSnapshot(consultation.id)).toBe(false);
		const snapshots = state.consultationSnapshots(consultation.id);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].text).toBe("late output");
		// A second backfill has nothing left to fill.
		expect(state.fillConsultationSnapshot(consultation.id, "again")).toBe(false);
		state.close();
	});

	test("records remaining resources on a forced close", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "workspace-1",
		});
		state.recordConsultationResource(consultation.id, {
			kind: "pane",
			resourceId: "pane-1",
			owned: true,
			details: "consultation pane",
		});
		state.recordConsultationResource(consultation.id, {
			kind: "worktree",
			resourceId: "worktree-1",
			owned: true,
			details: "/tmp/worktree-1",
		});
		state.beginConsultationClose(consultation.id);
		state.finishConsultationClose(
			consultation.id,
			"forced close; owned resources were not confirmed closed",
			true,
		);
		expect(state.consultation(consultation.id)?.state).toBe("closed");
		expect(state.consultationRemainingResources(consultation.id)).toMatchObject([
			{ kind: "pane", resourceId: "pane-1" },
			{ kind: "worktree", resourceId: "worktree-1" },
		]);
		// A normal close leaves no remaining resources.
		const other = createConsultation(state, "consultation-2");
		state.setConsultationAgent(other.id, { paneId: "pane-2" });
		state.recordConsultationResource(other.id, {
			kind: "pane",
			resourceId: "pane-2",
			owned: true,
			details: "consultation pane",
		});
		state.beginConsultationClose(other.id);
		state.finishConsultationClose(other.id);
		expect(state.consultation(other.id)?.state).toBe("closed");
		expect(state.consultationRemainingResources(other.id)).toEqual([]);
		state.close();
	});
});

describe("durable Consultation privacy", () => {
	test("stores settled output beyond the snapshot limit as a bounded tail", () => {
		const state = makeState();
		const consultation = createConsultation(state, "consultation-1");
		const id = consultation.id;
		state.setConsultationAgent(id, { paneId: "pane-11111111" });
		state.setConsultationState(id, "working");
		state.settleConsultationTurn(id, 1, "a".repeat(2 * 1024 * 1024), "idle");
		const [snapshot] = state.consultationSnapshots(id);
		expect(snapshot).toBeDefined();
		expect(snapshot.truncated).toBe(true);
		expect(Buffer.byteLength(snapshot.text, "utf8")).toBeLessThanOrEqual(1024 * 1024);
		expect(snapshot.text).toContain("…captured history truncated…");
		expect(snapshot.text.endsWith("a".repeat(1000))).toBe(true);
	});

	test("keeps the state file and its sidecars owner-only", () => {
		const { state, path } = makeStateFile();
		createConsultation(state);
		const mode = (file: string) => statSync(file).mode & 0o777;
		expect(mode(path)).toBe(0o600);
		expect(mode(dirname(path))).toBe(0o700);
		expect(mode(`${path}-wal`)).toBe(0o600);
		expect(mode(`${path}-shm`)).toBe(0o600);
	});

	test("deletion removes the history, truncates the WAL, and leaves no plaintext", () => {
		const { state, path } = makeStateFile();
		const marker = "UNIQUE-PLAINTEXT-MARKER-4f9c21";
		const id = "consultation-1";
		state.createConsultation({
			id,
			typeName: "grill-with-docs",
			agentType: "pi",
			environment: "worktree",
			model: "",
			thinking: "",
			contextWindow: "",
			template: "/skill:grill-with-docs {input}",
			initialInput: `Review ${marker}`,
			renderedOpeningPrompt: `/skill:grill-with-docs Review ${marker}`,
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
				path: "/tmp/factory",
			},
			agentName: "consultation-11111111",
			createdAt: "2026-09-01T00:00:00.000Z",
		});
		state.setConsultationAgent(id, { paneId: "pane-11111111" });
		state.setConsultationState(id, "working");
		state.settleConsultationTurn(id, 1, `settled ${marker}`, "idle");
		state.setConsultationState(id, "closing");
		state.finishConsultationClose(id);
		expect(state.consultation(id)).toBeDefined();
		state.deleteConsultation(id);
		expect(state.consultation(id)).toBeUndefined();
		// The checkpoint truncates the WAL: nothing of the history stays in it.
		expect(statSync(`${path}-wal`).size).toBe(0);
		// secure_delete zero-fills the released pages: no plaintext in the file.
		expect(readFileSync(path, "latin1")).not.toContain(marker);
		expect(readFileSync(`${path}-shm`, "latin1")).not.toContain(marker);
	});
});

describe("pending responses across restart and migration", () => {
	test("survives a restart and commits exactly one turn on recovery", () => {
		const { state, path } = makeStateFile();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "first answer");
		const pending = state.beginConsultationResponse(consultation.id, "unaccepted prompt", 1);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		state.close();
		// Reopen after a crash between the durable write and the Herdr call.
		const reopened = openFactoryState(path);
		expect(reopened.pendingConsultationResponse(consultation.id)).toMatchObject({
			input: "unaccepted prompt",
		});
		// No turn exists for the unaccepted prompt yet.
		expect(reopened.consultationTurns(consultation.id)).toHaveLength(1);
		expect(reopened.acceptConsultationResponse(consultation.id, pending.id)).toBeDefined();
		expect(reopened.consultationTurns(consultation.id)).toHaveLength(2);
		expect(reopened.pendingConsultationResponse(consultation.id)).toBeNull();
		expect(reopened.consultation(consultation.id)?.state).toBe("working");
		reopened.close();
	});

	test("migrates a v4 database to v5 and keeps the Consultation history", () => {
		const { state, path } = makeStateFile();
		const consultation = createConsultation(state);
		state.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.settleConsultationTurn(consultation.id, 1, "first answer", "idle");
		state.close();
		// Downgrade the record to the v4 shape.
		const db = new DatabaseSync(path);
		db.exec("DROP TABLE consultation_pending_responses");
		// The v6 and later columns go too: a v4 record has no leftover fact,
		// no trace settings, and no context window anywhere.
		db.exec(
			"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
				" ALTER TABLE handoffs DROP COLUMN herdr_name;",
		);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
		db.prepare("UPDATE schema_version SET version = 4").run();
		db.close();
		const reopened = openFactoryState(path);
		expect(reopened.consultation(consultation.id)?.state).toBe("awaiting-response");
		expect(reopened.consultationTurns(consultation.id)).toHaveLength(1);
		// The pending table is back and usable for the preserved history.
		expect(reopened.pendingConsultationResponse(consultation.id)).toBeNull();
		expect(reopened.beginConsultationResponse(consultation.id, "again", 1)).toBeDefined();
		reopened.close();
	});
});

describe("repository operation serialization", () => {
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
});
