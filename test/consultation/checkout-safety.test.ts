/**
 * The Checkout safety module, read through its interface (issue #203).
 *
 * The catalog and the mapping check are tested with the fake command runner,
 * the suite's stand-in for git, and a temporary directory as the checkout. No
 * test here runs a real git command.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckoutConflict,
	type ConsultationRepositoryOption,
	consultationRepositoryCatalog,
	inspectLiveCheckout,
	validateConsultationRepositoryOptions,
} from "../../src/consultation/checkout-safety.ts";
import type { Handoff, Ticket } from "../../src/domain/ticket.ts";
import type { HerdrAgent } from "../../src/herdr.ts";
import { expandHome, realPathOf } from "../../src/repo.ts";
import { BASE_CONFIG } from "../base-config.ts";
import { FakeRunner } from "../fake-runner.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function makeCheckout(): string {
	const directory = mkdtempSync(join(tmpdir(), "factory-checkout-"));
	directories.push(directory);
	return directory;
}

/** The ticket facts the conflict read uses; every other field stands empty. */
function ticketAt(
	paneId: string,
	state: Ticket["state"],
	environment: Handoff["environment"],
): Ticket {
	return {
		identity: `github:github.com:I_${paneId}`,
		title: "Hold the checkout",
		repository: "acme/factory",
		repositoryRef: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		state,
		handoff: {
			agentType: "pi",
			environment,
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
			attemptId: `attempt-${paneId}`,
			paneId,
			tabId: `tab-${paneId}`,
			workspaceId: `workspace-${paneId}`,
			herdrName: `factory-implement-${paneId}`,
		},
		workCycle: 2,
		handoffCount: 1,
		failedStartStreak: 0,
		lastCompletion: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: `#${paneId}`,
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/1",
		labels: [],
		externalUpdatedAt: "2026-09-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: false,
		handoffRecoveryRequired: false,
		leftover: null,
		nameCollision: null,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
	};
}

/** The Agent facts the conflict read uses, in one poll's shape. */
function agentIn(paneId: string, checkoutPath: string): HerdrAgent {
	return {
		paneId,
		tabId: `tab-${paneId}`,
		workspaceId: `workspace-${paneId}`,
		checkoutPath,
		agent: "pi",
		status: "working",
		sessionId: "",
	};
}

describe("the Checkout safety module's Repository catalog", () => {
	test("keeps a visible Ticket Repository without an explicit mapping", async () => {
		const visible = {
			repositoryRef: {
				identity: "github.com/acme/unmapped",
				displayName: "acme/unmapped",
				cloneUrl: "https://github.com/acme/unmapped.git",
			},
		};
		const catalog = consultationRepositoryCatalog({ ...BASE_CONFIG, repos: {} }, [visible]);
		expect(catalog).toEqual([
			expect.objectContaining({ identity: "github.com/acme/unmapped", path: "" }),
		]);
		expect(
			await validateConsultationRepositoryOptions(catalog, new FakeRunner(), homedir()),
		).toEqual(catalog);
	});

	test("a mapping key with other casing still maps a ticket Repository", () => {
		// The config key is the operator's string, here with the API's owner
		// casing; the ticket's identity is canonical lowercase. The catalog's
		// mapping lookup reads it case-insensitive.
		const visible = {
			repositoryRef: {
				identity: "gitlab.com/acme/billing",
				displayName: "acme/billing",
				cloneUrl: "https://gitlab.com/acme/billing.git",
			},
		};
		const catalog = consultationRepositoryCatalog(
			{ ...BASE_CONFIG, repos: { "GitLab.com/Acme/Billing": "/tmp/billing" } },
			[visible],
		);
		const gitlab = catalog.find((option) => option.identity === "gitlab.com/acme/billing");
		expect(gitlab).toBeDefined();
		if (gitlab !== undefined) expect(gitlab.path).toBe("/tmp/billing");
		// A different repository under the same name maps nothing.
		const unmapped = consultationRepositoryCatalog(
			{ ...BASE_CONFIG, repos: { "GitLab.com/Acme/Billings": "/tmp/billings" } },
			[visible],
		);
		const gitlabUnmapped = unmapped.find((option) => option.identity === "gitlab.com/acme/billing");
		if (gitlabUnmapped !== undefined) expect(gitlabUnmapped.path).toBe("");
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
		const path = makeCheckout();
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
		const good = makeCheckout();
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
		const path = makeCheckout();
		const options = await validateConsultationRepositoryOptions(
			[{ ...option, path }],
			verifiedRunner(path, "https://github.com/acme/other.git"),
			homedir(),
		);
		expect(options).toEqual([]);
	});
});

describe("the Checkout safety module's live checkout conflict set", () => {
	function statusRunner(checkout: string, status: string) {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], {
			stdout: status,
		});
		return runner;
	}

	test("names dirty state a warning and not a block", async () => {
		const checkout = makeCheckout();
		const safety = await inspectLiveCheckout(
			checkout,
			statusRunner(checkout, " M src/app.ts\n"),
			[],
			[],
			[],
		);
		expect(safety.dirty).toBe(true);
		expect(safety.warning).toBe("the live checkout has uncommitted changes");
		expect(safety.conflicts).toEqual([]);
	});

	test("names a live checkout conflict by the ticket that owns the Agent", async () => {
		const checkout = makeCheckout();
		const safety = await inspectLiveCheckout(
			checkout,
			statusRunner(checkout, ""),
			[ticketAt("pane-1", "running", "live-worktree")],
			[],
			[agentIn("pane-1", checkout)],
		);
		expect(safety.conflicts).toEqual([
			{
				kind: "ticket",
				identity: "github:github.com:I_pane-1",
				label: "Ticket github:github.com:I_pane-1",
			} satisfies CheckoutConflict,
		]);
	});

	test("reports one conflict per underlying Agent, never the same Agent twice", async () => {
		const checkout = makeCheckout();
		const safety = await inspectLiveCheckout(
			checkout,
			statusRunner(checkout, ""),
			[ticketAt("pane-1", "handed-off", "live-worktree")],
			[],
			[agentIn("pane-1", checkout), agentIn("pane-2", checkout)],
		);
		// The counted pane stays named by its ticket; only the bare Agent gets
		// its own line.
		expect(safety.conflicts.map((conflict) => conflict.kind)).toEqual(["ticket", "herdr-agent"]);
		expect(safety.conflicts[1].label).toBe("Herdr Agent pi (pane-2)");
	});

	test("leaves a checkout an Agent does not stand in out of the conflict set", async () => {
		const checkout = makeCheckout();
		const other = makeCheckout();
		const safety = await inspectLiveCheckout(
			checkout,
			statusRunner(checkout, ""),
			[ticketAt("pane-1", "running", "worktree")],
			[],
			[agentIn("pane-1", other)],
		);
		expect(safety.conflicts).toEqual([]);
	});
});
