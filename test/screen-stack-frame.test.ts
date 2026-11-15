/**
 * The screen stack through the frame rig (ADR 0150): while the operator
 * reads the screen above, the suspended screen runs nothing - its screen
 * read sends no command through the runner, the painted frame stands, and
 * its key wrapper leaves the key bus. Closing the screen above resumes the
 * screen beneath: the same wrapper comes back on the bus with the same
 * identity, the preserved facts paint back through the frame, and the
 * resumed screen's first tick moves the frame. The plane's loops run
 * through every transition, so their cadence is the only traffic the frame
 * admits while a screen stands.
 *
 * Each test asserts the painted frame, the runner's command list, and the
 * rig's four kept reads of the key bus. It names a control from the
 * catalogue and one outcome from the rig's closed set, and it reads no
 * record of the stack.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Setup } from "./app-harness.ts";
import {
	emergencyExit,
	frameText,
	frameUntil,
	guideKey,
	keyBase,
	leftKeyHandler,
	messageRowOf,
	pressControl,
	releaseKeys,
	rowsOf,
	settle,
	sleep,
	staleKeyClaim,
	tabUntilSlot,
	typeText,
	waitCommands,
	waitFor,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	ConsultationRunner,
	consultationAgentListJson,
	grillTypes,
	launcherWorld,
	seed,
	stubCheckout,
	stubPaneReadText,
	uid,
} from "./consultation-world.ts";
import { DEFAULT_TICKET_TITLE } from "./fact-fixtures.ts";
import { FakeRunner } from "./fake-runner.ts";
import {
	onePaneAgentList,
	READ,
	seededPlane,
	stubCheckoutInto,
	stubRouteStanding,
	twoPaneAgentList,
} from "./live-world.ts";
import { plane, wrappedState } from "./plane.ts";

/** Count the pane reads in a command list: the screens' own reads. */
const screenReads = (commands: string[]) =>
	commands.filter((command) => command.startsWith("herdr agent read")).length;

/** Count the pane reads of one pane: the reads a screen of that pane owes. */
const paneReads = (commands: string[], pane: string) =>
	commands.filter((command) => command.startsWith(`herdr agent read ${pane} `)).length;

/** Count the loop's agent polls in a command list. */
const agentListReads = (commands: string[]) =>
	commands.filter((command) => command === "herdr agent list").length;

/** The ticket's list row, by its title. */
function ticketRow(frame: string, title = DEFAULT_TICKET_TITLE): string {
	const rows = rowsOf(frame);
	const row =
		rows.find((line) => line.includes("❯") && line.includes(title.slice(0, 3))) ??
		rows.find((line) => line.includes(title));
	if (row === undefined) throw new Error(`no ticket row for ${title} in frame:\n${frame}`);
	return row;
}

/** The blank frame the destroyed renderer stands on: the exit's outcome. */
const destroyed = (setup: Setup) =>
	frameUntil(setup, "the renderer to destroy", (frame) => frame.trim() === "");

/** The seeded Consultation the close-panel test stands on. */
const CLOSE_ID = uid("6");

describe("the suspended screen runs nothing (ADR 0150)", () => {
	test("the Key guide over the running Live view: the stream stands, the view's read stops, and the resume's first tick moves", async () => {
		const planeRecord = await seededPlane();
		const fake = planeRecord.fakeRunner;
		fake.set("herdr", ["agent", "list"], { stdout: onePaneAgentList("working") });
		fake.set("herdr", [...READ("pane-1")], { stdout: "the layout math is fixed\n" });
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitFor(setup, { shows: DEFAULT_TICKET_TITLE });
				const base = keyBase(setup);
				await pressControl(setup, "live-view", { quiet: true });
				await waitFor(setup, { shows: "Live:" });
				await waitFor(setup, { shows: "the layout math is fixed" });
				// The pane answers every read with more lines than before, so
				// each of the view's one-second reads moves the frame it paints.
				fake.setSequence(
					"herdr",
					[...READ("pane-1")],
					[
						{ stdout: "the layout math is fixed\nthe first pass runs\n" },
						{ stdout: "the layout math is fixed\nthe first pass runs\nthe pass settles\n" },
					],
				);
				const liveWrapper = leftKeyHandler(setup, base);
				const liveFrame = setup.captureCharFrame();
				const liveCommands = fake.commands().length;
				await sleep(1100);
				expect(setup.captureCharFrame()).not.toBe(liveFrame);
				expect(fake.commands().length).toBeGreaterThan(liveCommands);
				// The guide opens over the view and suspends it: the view's
				// wrapper leaves the bus, and a window twice the stream's
				// period stands the frame and the command list.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				const guideWrapper = leftKeyHandler(setup, base);
				expect(guideWrapper).not.toBe(liveWrapper);
				await settle(setup);
				const frozen = setup.captureCharFrame();
				const frozenCommands = fake.commands().length;
				await sleep(2600);
				expect(setup.captureCharFrame()).toBe(frozen);
				expect(fake.commands().length).toBe(frozenCommands);
				// A key that lands on the suspended view's wrapper claims
				// nothing, the way the guard has always answered for an
				// undrawn surface.
				expect(staleKeyClaim(liveWrapper)).toBe(false);
				// Closing the guide resumes the view: the same wrapper stands
				// on the bus again, the stream stands on the lines it was
				// suspended on, and the view's first tick moves the frame.
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				expect(leftKeyHandler(setup, base)).toBe(liveWrapper);
				const resumed = await settle(setup);
				expect(frameText(resumed)).toContain("the layout math is fixed");
				const resumedCommands = fake.commands().length;
				await fake.set("herdr", [...READ("pane-1")], {
					stdout: "the second pass lands\n",
				});
				await waitFor(setup, { shows: "the second pass lands" });
				expect(fake.commands().length).toBeGreaterThan(resumedCommands);
				await guideKey(setup, "cancel-action", "Esc", { hides: "Live:" });
				await releaseKeys(setup, base, "the live view to release the keys");
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
		await planeRecord.close();
	});

	test("the close panel over the Consultation detail: the detail's read stands, and the resume stands on its lines", async () => {
		const state = wrappedState();
		const inner: { current: FakeRunner } = { current: new FakeRunner() };
		const planeRecord = await plane({
			existing: state,
			sources: [],
			config: { consultationTypes: grillTypes },
			repos: { "github.com/acme/factory": "src/factory" },
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				mkdirSync(checkout, { recursive: true });
				stubCheckout(fake, checkout);
				stubPaneReadText(fake, `pane-${CLOSE_ID.slice(0, 8)}`, "auth is split across two files\n");
			},
			runner: (fake) => {
				inner.current = fake;
				return new ConsultationRunner(fake, consultationAgentListJson([]));
			},
			agentHostEnv: { herdrEnv: "1" },
		});
		const checkout = join(planeRecord.home, "src", "factory");
		seed(state, CLOSE_ID, checkout);
		state.consultationRecord.beginConsultationClose(CLOSE_ID);
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					// The boot cursor stands in the Ticket section, which holds no
					// row here: the walk crosses to the Consultation section until
					// the closing Consultation's detail stands.
					let settled = await settle(setup);
					for (let step = 0; step < 8 && !settled.includes("State: closing"); step++) {
						await pressControl(setup, "move-list", { via: "↓", quiet: true });
						settled = await settle(setup, 50);
					}
					expect(settled).toContain("State: closing");
					const base = keyBase(setup);
					// The detail's read runs while the Main view is the
					// active screen, on the screen's own cadence.
					const readingCommands = inner.current.commands().length;
					await sleep(1100);
					expect(inner.current.commands().length).toBeGreaterThan(readingCommands);
					// Enter on the closing Consultation opens the close
					// panel, which suspends the Main view and its detail read.
					await pressControl(setup, "consultation-recovery", {
						opens: "Close Consultation",
					});
					const panelWrapper = leftKeyHandler(setup, base);
					await settle(setup);
					const frozen = setup.captureCharFrame();
					const frozenCommands = inner.current.commands().length;
					await sleep(2600);
					expect(setup.captureCharFrame()).toBe(frozen);
					expect(inner.current.commands().length).toBe(frozenCommands);
					// While the panel is active the bus holds exactly the
					// panel's wrapper beside the base: the suspended Main
					// view holds no subscription at all.
					expect(leftKeyHandler(setup, base)).toBe(panelWrapper);
					// Closing the panel resumes the Main view: it stands on
					// the same detail and its read runs again.
					await pressControl(setup, "cancel-action", {
						closes: "Close Consultation",
					});
					const resumed = await settle(setup);
					expect(frameText(resumed)).toContain("State: closing");
					expect(frameText(resumed)).toContain("auth is split across two files");
					const resumedCommands = inner.current.commands().length;
					await inner.current.set("herdr", [...READ(`pane-${CLOSE_ID.slice(0, 8)}`)], {
						stdout: "the cleanup answer lands\n",
					});
					await waitFor(setup, { shows: "the cleanup answer lands" });
					expect(inner.current.commands().length).toBeGreaterThan(resumedCommands);
					await releaseKeys(setup, base, "the close panel to release the keys");
				},
				{
					width: 120,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
		} finally {
			state.close();
		}
	});

	test("the Key guide over the launcher: the draft stands and the launcher's slot keeps its focus", async () => {
		const { state, plane: planeRecord } = await launcherWorld();
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					const base = keyBase(setup);
					await waitFor(setup, { shows: "acme/factory" });
					await guideKey(setup, "launch", "c", { opens: "Consultation launcher" });
					const launcherWrapper = leftKeyHandler(setup, base);
					// The draft goes in, and the launcher's focus stands on
					// the initial input's slot.
					await tabUntilSlot(setup, "❯ Initial input");
					await typeText(setup, "the plan");
					await settle(setup);
					const frozen = setup.captureCharFrame();
					const frozenCommands = planeRecord.fakeRunner.commands().length;
					// The guide opens over the launcher and suspends it:
					// nothing runs for the suspended launcher over the window.
					await pressControl(setup, "help", { via: "F1", opens: "Key guide" });
					const guideWrapper = leftKeyHandler(setup, base);
					expect(guideWrapper).not.toBe(launcherWrapper);
					await settle(setup);
					const over = setup.captureCharFrame();
					await sleep(1600);
					expect(setup.captureCharFrame()).toBe(over);
					expect(planeRecord.fakeRunner.commands().length).toBe(frozenCommands);
					// Closing the guide resumes the launcher: the same wrapper
					// stands on the bus, and the draft and the focus paint
					// back through the frame.
					await pressControl(setup, "guide-close", { closes: "Key guide" });
					expect(leftKeyHandler(setup, base)).toBe(launcherWrapper);
					const back = await settle(setup);
					expect(frameText(back)).toContain("the plan");
					expect(
						rowsOf(frameText(back)).some(
							(row) => row.includes("❯") && row.includes("Initial input"),
						),
					).toBe(true);
					// The resume stands on the exact frame the launcher was
					// suspended on: the draft and the focus, no pop-in.
					expect(setup.captureCharFrame()).toBe(frozen);
					// The launcher's bar merges the close and the help into one
					// hint while the field holds the focus, so the close goes out
					// on the guide's own named key.
					await guideKey(setup, "close-form", "Esc", { hides: "Consultation launcher" });
					await releaseKeys(setup, base, "the launcher to release the keys");
				},
				{
					width: 120,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
		} finally {
			state.close();
		}
	});

	test("the override over the Decision modal: the modal stands still, and the row under the cursor stands back", async () => {
		// The implement transition writes ready-for-review, so its Next step
		// is the review position on the ticket itself. The task type carries
		// the Operator-decides flag, so the machine decides nothing (ADR 0085)
		// and the turn rests awaiting with its decision unwritten: the modal
		// the operator opens stands on a decision that stays open.
		const planeRecord = await seededPlane({
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					operatorDecides: true,
					transition: {
						ticketFacts: ["ready-for-review"],
						pullRequestFacts: [],
					},
				},
			},
		});
		const fake = planeRecord.fakeRunner;
		fake.set("herdr", ["agent", "list"], { stdout: onePaneAgentList("working") });
		fake.set("herdr", [...READ("pane-1")], { stdout: "the implementer is finishing\n" });
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitFor(setup, { shows: DEFAULT_TICKET_TITLE });
				const base = keyBase(setup);
				// The loop settles the turn on its own cadence; the ticket
				// stands awaiting the operator's decision.
				fake.set("herdr", ["agent", "list"], {
					stdout: onePaneAgentList("done"),
				});
				await frameUntil(setup, "the awaiting ticket", (f) => ticketRow(f).includes("[awaiting]"));
				await pressControl(setup, "decide-completion", { opens: "Decision:" });
				const decisionWrapper = leftKeyHandler(setup, base);
				// The operator walks to the Handoff row and opens the
				// override over the modal.
				await guideKey(setup, "select-action", "↓", { quiet: true });
				await waitFor(setup, { shows: "❯ Goto" });
				await guideKey(setup, "select-action", "↓", { quiet: true });
				await waitFor(setup, { shows: "Handoff: review" });
				await settle(setup);
				const decisionFrame = setup.captureCharFrame();
				await pressControl(setup, "edit-action", { via: "e", opens: "Override" });
				const overrideWrapper = leftKeyHandler(setup, base);
				expect(overrideWrapper).not.toBe(decisionWrapper);
				await settle(setup);
				const frozen = setup.captureCharFrame();
				const frozenReads = screenReads(fake.commands());
				await sleep(1600);
				expect(setup.captureCharFrame()).toBe(frozen);
				expect(screenReads(fake.commands())).toBe(frozenReads);
				// A key that lands on the suspended modal's wrapper claims
				// nothing.
				expect(staleKeyClaim(decisionWrapper)).toBe(false);
				// Closing the override resumes the modal: the same wrapper
				// stands on the bus, and the row under the cursor stands
				// back on the same action.
				await pressControl(setup, "cancel", { closes: "Override" });
				expect(leftKeyHandler(setup, base)).toBe(decisionWrapper);
				const back = await settle(setup);
				expect(frameText(back)).toContain("Decision:");
				expect(frameText(back)).toContain("❯ Handoff: review");
				// The resume stands on the exact frame the modal was suspended
				// on: the same row under the cursor, no pop-in.
				expect(setup.captureCharFrame()).toBe(decisionFrame);
				await pressControl(setup, "cancel-action", { closes: "Decision:" });
				await releaseKeys(setup, base, "the decision modal to release the keys");
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		await planeRecord.close();
	});

	test("the guide over the Live view while the ticket routes away: the stale view closes instead of resuming, and the message written while away stands", async () => {
		const planeRecord = await seededPlane();
		planeRecord.state.handoff.setAutoHandoffMode(true);
		const fake = planeRecord.fakeRunner;
		fake.set("herdr", ["agent", "list"], { stdout: twoPaneAgentList("working", "working") });
		stubRouteStanding(fake, join(planeRecord.home, "src", "factory"));
		stubCheckoutInto(fake, planeRecord.home);
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitFor(setup, { shows: DEFAULT_TICKET_TITLE });
				const resting = await settle(setup);
				const restingMessage = messageRowOf(resting);
				const base = keyBase(setup);
				await pressControl(setup, "live-view", { quiet: true });
				await waitFor(setup, { shows: "Live:" });
				await waitFor(setup, { shows: "the implementer is finishing" });
				// The guide opens over the view. While the operator reads
				// it, the loop settles the turn and the machine routes the
				// ticket to its next work cycle.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				await settle(setup);
				const readsBefore = paneReads(fake.commands(), "pane-1");
				const pollsBefore = agentListReads(fake.commands());
				fake.set("herdr", ["agent", "list"], {
					stdout: twoPaneAgentList("done", "working"),
				});
				await waitCommands(
					() => fake.commands(),
					["gh issue edit #5 --repo github.com/acme/factory --add-label ready-for-review"],
					"the route's label write",
				);
				// The suspended view sent no read of its own pane while away,
				// and the loop kept its cadence through the transition.
				expect(paneReads(fake.commands(), "pane-1")).toBe(readsBefore);
				expect(agentListReads(fake.commands())).toBeGreaterThan(pollsBefore);
				// Closing the guide resumes the screen beneath: the ticket
				// left the work cycle the view stood on, so the view closes
				// instead of resuming, and the message the factory wrote
				// while the operator read the guide stands on the list.
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				const back = await waitFor(setup, { hides: "Live:" });
				expect(back).toContain(DEFAULT_TICKET_TITLE);
				expect(messageRowOf(back)).not.toBe(restingMessage);
				await releaseKeys(setup, base, "the list to release the keys");
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 20 },
			},
		);
		await planeRecord.close();
	});

	test("the emergency exit from the guide over the Live view: the suspended view holds no key that takes it", async () => {
		const planeRecord = await seededPlane();
		const fake = planeRecord.fakeRunner;
		fake.set("herdr", ["agent", "list"], { stdout: twoPaneAgentList("working", "working") });
		await withApp(
			async (setup) => {
				planeRecord.settleFirstFetch();
				await waitFor(setup, { shows: DEFAULT_TICKET_TITLE });
				const base = keyBase(setup);
				await pressControl(setup, "live-view", { quiet: true });
				await waitFor(setup, { shows: "Live:" });
				const liveWrapper = leftKeyHandler(setup, base);
				// The guide opens over the view and suspends it: the view's
				// wrapper leaves the key bus, and its stream read stops.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				const guideWrapper = leftKeyHandler(setup, base);
				expect(guideWrapper).not.toBe(liveWrapper);
				const frozenCommands = fake.commands().length;
				await sleep(1200);
				expect(fake.commands().length).toBe(frozenCommands);
				// The plane's one always-available key stands on the shell's
				// base subscription, which never leaves the bus: from the
				// screen above, the exit destroys the renderer, and the
				// suspended view holds no key that could take it.
				await emergencyExit(setup);
				await destroyed(setup);
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("the guide over the Message view: the round trip keeps the guide's mode and the base's place, never a second entry", async () => {
		// The herdr config names a theme the resolver does not know, so the
		// boot lands on the built-in default and writes its info notice to
		// the message history: the Message view opens on a history that is
		// not empty.
		const savedEnv = {
			herdrEnv: process.env.HERDR_ENV,
			herdrConfigPath: process.env.HERDR_CONFIG_PATH,
		};
		const dir = mkdtempSync(join(tmpdir(), "factory-stack-utility-"));
		process.env.HERDR_ENV = "1";
		process.env.HERDR_CONFIG_PATH = join(dir, "config.toml");
		writeFileSync(process.env.HERDR_CONFIG_PATH, '[theme]\nname = "vaporwave"\n');
		const planeRecord = await seededPlane();
		const fake = planeRecord.fakeRunner;
		fake.set("herdr", ["agent", "list"], { stdout: onePaneAgentList("working") });
		fake.set("herdr", [...READ("pane-1")], { stdout: "the layout math is fixed\n" });
		try {
			await withApp(
				async (setup) => {
					planeRecord.settleFirstFetch();
					await waitFor(setup, { shows: DEFAULT_TICKET_TITLE });
					const base = keyBase(setup);
					// The guide opens over the Main view and suspends it.
					await pressControl(setup, "help", { via: "?", opens: "Key guide" });
					const guideWrapper = leftKeyHandler(setup, base);
					await settle(setup);
					const guideFrame = setup.captureCharFrame();
					const frozenCommands = fake.commands().length;
					// The Message view opens over the guide: the one utility
					// slot holds one entry, so the view takes the top and the
					// guide leaves the stack, the Main view suspended beneath
					// the whole time. The boot notice stands in the view's
					// history.
					await pressControl(setup, "message", {
						via: "F2",
						opens: "Message view",
					});
					const messageWrapper = leftKeyHandler(setup, base);
					expect(messageWrapper).not.toBe(guideWrapper);
					const overFrame = await settle(setup);
					expect(frameText(overFrame)).toContain(
						`unknown theme name "vaporwave" in herdr's config`,
					);
					expect(overFrame).not.toBe(guideFrame);
					// While the operator reads the view, the closed guide and
					// the suspended Main view run nothing: over the window the
					// frame and the command list stand.
					await sleep(1600);
					expect(setup.captureCharFrame()).toBe(overFrame);
					expect(fake.commands().length).toBe(frozenCommands);
					// The guide opens again over the view: the same screen in
					// the mode the utility carried it in, one entry in the
					// stack, never a second. The slot re-attaches the guide's
					// own wrapper to the bus, the same identity it held before
					// the swap.
					await pressControl(setup, "help", { via: "?", opens: "Key guide" });
					expect(leftKeyHandler(setup, base)).toBe(guideWrapper);
					await settle(setup);
					// The screen stands on the exact frame it held before the
					// swap: the suspended base never ran, and the guide
					// repaints in the same mode over the same base, so the
					// return reads as a return, not a re-opening.
					expect(setup.captureCharFrame()).toBe(guideFrame);
					expect(fake.commands().length).toBe(frozenCommands);
					// Closing the guide resumes the Main view: the one utility
					// slot holds no suspended screen beneath the guide. The
					// list stands on its place, and the Message line shows the
					// factory's boot notice from the view's history, a fact of
					// the shell that the suspended base never lost.
					await pressControl(setup, "guide-close", { closes: "Key guide" });
					const listBack = await settle(setup);
					expect(frameText(listBack)).toContain(DEFAULT_TICKET_TITLE);
					expect(frameText(listBack)).toContain("using the built-in default catppuccin");
					await releaseKeys(setup, base, "the list to release the keys");
				},
				{
					width: 120,
					height: 30,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
			await planeRecord.close();
		} finally {
			// The sibling walks boot standalone: the process's theme env goes
			// back the way it stood.
			if (savedEnv.herdrEnv === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = savedEnv.herdrEnv;
			if (savedEnv.herdrConfigPath === undefined) delete process.env.HERDR_CONFIG_PATH;
			else process.env.HERDR_CONFIG_PATH = savedEnv.herdrConfigPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
