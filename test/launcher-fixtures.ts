/**
 * The Consultation launcher fixtures the field tests share.
 *
 * One mapped Repository whose checkout the runner verifies, and a config with
 * two Consultation types: enough for a form to hold a real value in every slot,
 * and nothing that can reach a real herdr, a real repository, or a real Agent.
 */
import type { FactoryConfig } from "../src/config.ts";
import { FakeRunner } from "./fake-runner.ts";

/** The identity the fixtures map, and the name the launcher shows for it. */
export const LAUNCHER_IDENTITY = "github.com/acme/repo";

/** A config with two Consultation types and one mapped Repository. */
export function launcherConfig(checkout: string): FactoryConfig {
	return {
		defaultAgent: "demo",
		defaultEnvironment: "live-worktree",
		defaultTaskType: "implement",
		agents: { demo: { kind: "demo" } },
		taskTypes: { implement: { template: "Implement {title}", autoClose: false } },
		consultationTypes: {
			grill: { agent: "demo", environment: "live-worktree", template: "/grill {input}" },
			design: { agent: "demo", environment: "live-worktree", template: "/design {input}" },
		},
		attentionBell: false,
		interactionExitKey: "f12",
		autoHandoff: false,
		maxParallelAgents: 2,
		agentPollIntervalSeconds: 60,
		completionMessageLines: 20,
		maxHandoffsPerTicket: 3,
		scroll: { speed: 2, acceleration: 0, maximumSpeed: 4 },
		workflows: [],
		repos: { [LAUNCHER_IDENTITY]: checkout },
		sources: [],
		taskRules: [],
	};
}

/** A runner that verifies the mapped checkout and holds no herdr agent. */
export function launcherRunner(checkout: string): FakeRunner {
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], { stdout: '{"agents":[]}' });
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/repo.git\n",
	});
	return runner;
}
