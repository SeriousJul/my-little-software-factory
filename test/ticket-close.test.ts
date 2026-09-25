/**
 * The Ticket Close dialog's facts (ADR 0031).
 *
 * The dialog is the operator's warning before a close runs, so its body is
 * the contract: who is alive, what the Close cleanup ends, what it leaves, and
 * what the record will hold. These read the facts the shell renders and the
 * gallery shows, so the review of the panel and the screen the operator meets
 * come from one definition and cannot drift.
 */
import { describe, expect, test } from "bun:test";

import { ticketCloseDialog } from "../src/components/ticket-close.ts";
import type { ENVIRONMENT_KINDS, Ticket, TicketState } from "../src/domain/ticket.ts";

/** The ticket one dialog state renders: a handoff of the named environment. */
function ticket(state: TicketState, environment: (typeof ENVIRONMENT_KINDS)[number]): Ticket {
	return {
		identity: "github:github.com:I_5",
		title: "Persist source facts",
		repository: "acme/factory",
		repositoryRef: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		state,
		handoff:
			state === "open"
				? null
				: {
						agentType: "pi",
						environment,
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
						attemptId: "attempt-1",
						paneId: "pane-1",
						tabId: "tab-1",
						workspaceId: "ws-1",
						herdrName: "persist-source-facts",
					},
		workCycle: 2,
		handoffCount: 1,
		lastCompletion: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: true,
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		leftover: null,
	};
}

describe("the Ticket Close dialog", () => {
	test("the title names the Ticket the close works on", () => {
		expect(ticketCloseDialog(ticket("running", "worktree")).title).toBe(
			"Close: Persist source facts",
		);
	});

	test("a working Agent names the worktree removal, the branch, and no record", () => {
		const dialog = ticketCloseDialog(ticket("running", "worktree"));
		expect(dialog.bodyLines[0]).toBe("The Agent is working.");
		expect(dialog.bodyLines).toContain(
			"Close removes the worktree checkout; a dirty checkout stays as a leftover.",
		);
		expect(dialog.bodyLines).toContain(
			"The git branch stays, and the Ticket returns to open in its next cycle.",
		);
		// An unsettled turn leaves no record, and the dialog says so first.
		expect(dialog.bodyLines).toContain("No completion record is written: the turn never settled.");
		expect(dialog.bodyLines).not.toContain("The closed decision lands on the settled turn.");
	});

	test("a started Agent the poll has not seen says so", () => {
		expect(ticketCloseDialog(ticket("handed-off", "worktree")).bodyLines[0]).toBe(
			"The Agent has started, and its work is not seen yet.",
		);
	});

	test("the live-worktree environment names the tab and what stays", () => {
		const dialog = ticketCloseDialog(ticket("running", "live-worktree"));
		expect(dialog.bodyLines).toContain(
			"Close closes the Agent's herdr tab, and keeps the checkout and the workspace.",
		);
		// A tab close cannot refuse on a dirty checkout: that fact belongs to
		// the other Environment, and the dialog does not borrow it.
		expect(dialog.bodyLines.join(" ")).not.toContain("dirty checkout");
	});

	test("an awaiting ticket names the settled turn and the decision it records", () => {
		const dialog = ticketCloseDialog(ticket("awaiting", "worktree"));
		expect(dialog.bodyLines[0]).toBe("The turn has settled, and no Agent works.");
		expect(dialog.bodyLines).toContain("The closed decision lands on the settled turn.");
		expect(dialog.bodyLines).not.toContain(
			"No completion record is written: the turn never settled.",
		);
	});

	test("the observation's marker carries the first line, and the state stands alone", () => {
		// A missing Agent is the case the Close exists as the way out of: the
		// dialog says the pane is gone, not that an Agent works.
		expect(ticketCloseDialog(ticket("running", "worktree"), "missing").bodyLines[0]).toBe(
			"Herdr no longer lists the Agent's pane.",
		);
		expect(ticketCloseDialog(ticket("running", "worktree"), "blocked").bodyLines[0]).toBe(
			"The Agent works, and waits for input.",
		);
		// No observation yet: the state alone names who is alive.
		expect(ticketCloseDialog(ticket("running", "worktree"), null).bodyLines[0]).toBe(
			"The Agent is working.",
		);
	});

	test("Close leads the rows, and Cancel leaves the work the dialog found", () => {
		const inFlight = ticketCloseDialog(ticket("running", "worktree"));
		expect(inFlight.actions.map((row) => row.key)).toEqual(["close", "cancel"]);
		expect(inFlight.actions[0].detail).toBe("end the work cycle; the ticket returns to open");
		expect(inFlight.actions[1].detail).toBe("keep the Agent and its work running");
		// The settled turn is undecided, not running: Cancel keeps that fact.
		expect(ticketCloseDialog(ticket("awaiting", "worktree")).actions[1].detail).toBe(
			"keep the turn undecided",
		);
		// A pane herdr no longer lists is no Agent to keep running: the row states
		// the same fact the body's first line states, or the two contradict.
		expect(ticketCloseDialog(ticket("running", "worktree"), "missing").actions[1].detail).toBe(
			"keep the cycle, and its missing pane",
		);
		// A blocked Agent still holds its pane, so the running wording stands.
		expect(ticketCloseDialog(ticket("running", "worktree"), "blocked").actions[1].detail).toBe(
			"keep the Agent and its work running",
		);
	});
});
