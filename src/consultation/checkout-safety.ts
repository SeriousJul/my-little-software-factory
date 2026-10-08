/**
 * The Checkout safety module: what the plane checks about a Repository before
 * it opens a Consultation on it.
 *
 * The Repository catalog, the explicit mapping check, and the Live checkout
 * conflict set are one concept - the safety facts a checkout carries - and they
 * have one owner here. The launcher lists only what the catalog and the mapping
 * check return; the launch reads the conflict set before it starts an Agent
 * (issue #203).
 */
import type { FactoryConfig } from "../config.ts";
import type { RepositoryRef, Ticket } from "../domain/ticket.ts";
import { inFlightState } from "../domain/ticket.ts";
import { fileExists } from "../fs.ts";
import type { HerdrAgent } from "../herdr.ts";
import { expandHome, lookupRepositoryMapping, matchesRepository, realPathOf } from "../repo.ts";
import type { CommandRunner } from "../runner.ts";
import type { Consultation } from "../state/consultation-record.ts";

/** A Repository catalog contains only known identities and configured paths. */
export interface ConsultationRepositoryOption extends RepositoryRef {
	path: string;
}

export function consultationRepositoryCatalog(
	config: FactoryConfig,
	tickets: readonly Pick<Ticket, "repositoryRef">[] = [],
): ConsultationRepositoryOption[] {
	const options = new Map<string, ConsultationRepositoryOption>();
	for (const [identity, path] of Object.entries(config.repos)) {
		const normalized = identity.toLowerCase().startsWith("github.com/")
			? identity
			: `github.com/${identity}`;
		const displayName = normalized.slice("github.com/".length);
		options.set(normalized.toLowerCase(), {
			identity: normalized.toLowerCase(),
			displayName,
			cloneUrl: `https://github.com/${displayName}.git`,
			path,
		});
	}
	for (const ticket of tickets) {
		const ref = ticket.repositoryRef;
		const key = ref.identity.toLowerCase();
		if (!options.has(key) && ticket.repositoryRef.identity !== "") {
			const shortIdentity = key.startsWith("github.com/") ? key.slice("github.com/".length) : key;
			options.set(key, {
				...ref,
				identity: key,
				// The mapping lookup is case-insensitive: the config key is the
				// operator's string, the identity is canonical lowercase.
				path: lookupRepositoryMapping(config.repos, [key, shortIdentity]) ?? "",
			});
		}
	}
	return [...options.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Verify explicit launcher mappings before showing them. A visible Ticket
 * Repository without a mapping remains eligible: launch resolves it through
 * the normal convention and sibling-clone rules.
 */
export async function validateConsultationRepositoryOptions(
	options: readonly ConsultationRepositoryOption[],
	runner: CommandRunner,
	home: string,
): Promise<ConsultationRepositoryOption[]> {
	const verified = await Promise.all(
		options.map(async (option) => {
			// An empty path means this identity came from a visible Ticket. It is
			// not an unchecked path. The serialized launch resolves it normally.
			if (option.path === "") return option;
			const path = expandHome(option.path, home);
			if (!(await fileExists(path))) return undefined;
			const git = await runner.run("git", ["-C", path, "rev-parse", "--git-dir"]);
			if (git.code !== 0) return undefined;
			const remote = await runner.run("git", ["-C", path, "remote", "get-url", "origin"]);
			if (remote.code !== 0 || !matchesRepository(remote.stdout.trim() || null, option.identity))
				return undefined;
			return { ...option, path: await realPathOf(path) };
		}),
	);
	return verified.filter((option): option is ConsultationRepositoryOption => option !== undefined);
}

/** A safety fact shown before a live-worktree launch. */
export interface LiveCheckoutSafety {
	dirty: boolean;
	warning?: string;
	conflicts: CheckoutConflict[];
}

export interface CheckoutConflict {
	kind: "ticket" | "consultation" | "herdr-agent";
	identity: string;
	label: string;
}

/**
 * Check a live checkout without making changes. One conflict is reported per
 * underlying Agent: an Agent whose pane belongs to a counted open Consultation
 * or a counted running ticket handoff is reported under that Consultation's
 * or ticket's identity, never again as a bare Herdr Agent. The caller decides
 * whether the checkout's confirmed set covers the reported identities. Dirty
 * state is a warning, not a block.
 */
export async function inspectLiveCheckout(fields: {
	checkout: string;
	runner: CommandRunner;
	tickets: readonly Ticket[];
	consultations: readonly Consultation[];
	agents: readonly HerdrAgent[];
}): Promise<LiveCheckoutSafety> {
	const { checkout, runner, tickets, consultations, agents } = fields;
	if (!(await fileExists(checkout))) return { dirty: false, conflicts: [] };
	const status = await runner.run("git", [
		"-C",
		checkout,
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	if (status.code !== 0)
		throw new Error(
			`cannot inspect live checkout: ${status.stderr.trim() || `exit code ${status.code}`}`,
		);
	const dirty = status.stdout.trim() !== "";
	const conflicts: CheckoutConflict[] = [];
	/**
	 * Panes already counted as a conflict. Their Agents get one panel line under
	 * the Consultation's or ticket's identity, not a second bare Herdr Agent
	 * line for the same underlying Agent.
	 */
	const countedPanes = new Set<string>();
	const target = await realPathOf(checkout);
	// Ticket conflicts compare the resolved checkout, not the repository
	// identity: a worktree handoff of the same repository does not share
	// this live checkout, and a different mapping of the same repository
	// does.
	await ticketCheckoutConflicts({ target, tickets, agents, countedPanes, conflicts });
	await consultationCheckoutConflicts({
		checkout,
		target,
		consultations,
		agents,
		countedPanes,
		conflicts,
	});
	return {
		dirty,
		...(dirty ? { warning: "the live checkout has uncommitted changes" } : {}),
		conflicts: uniqueConflicts(conflicts),
	};
}

/** The in-flight tickets whose Agent works in the live checkout itself. */
async function ticketCheckoutConflicts(fields: {
	target: string;
	tickets: readonly Ticket[];
	agents: readonly HerdrAgent[];
	countedPanes: Set<string>;
	conflicts: CheckoutConflict[];
}): Promise<void> {
	const { target, tickets, agents, countedPanes, conflicts } = fields;
	for (const ticket of tickets) {
		if (ticket.handoff === null || !inFlightState(ticket.state)) continue;
		if (ticket.handoff.paneId === null) continue;
		const agent = agents.find((candidate) => candidate.paneId === ticket.handoff?.paneId);
		if (agent === undefined) continue;
		const agentCheckout =
			agent.checkoutPath === undefined ? null : await realPathOf(agent.checkoutPath);
		if (agentCheckout !== null) {
			if (agentCheckout !== target) continue;
		} else if (ticket.handoff.environment !== "live-worktree") continue;
		// An unknown checkout of a live-worktree handoff cannot be proven
		// separate: keep it a conflict instead of sharing a shared checkout.
		countedPanes.add(agent.paneId);
		conflicts.push({
			kind: "ticket",
			identity: ticket.identity,
			label: `Ticket ${ticket.identity}`,
		});
	}
}

/** The Consultations and bare Agents whose panes work in the live checkout. */
async function consultationCheckoutConflicts(fields: {
	checkout: string;
	target: string;
	consultations: readonly Consultation[];
	agents: readonly HerdrAgent[];
	countedPanes: Set<string>;
	conflicts: CheckoutConflict[];
}): Promise<void> {
	const { checkout, target, consultations, agents, countedPanes, conflicts } = fields;
	for (const consultation of consultations) {
		if (
			consultation.state !== "working" &&
			consultation.state !== "opening" &&
			consultation.state !== "awaiting-response"
		)
			continue;
		if (
			consultation.repository.path !== checkout &&
			(await realPathOf(consultation.repository.path)) !== target
		)
			continue;
		if (
			consultation.paneId !== null &&
			agents.some((agent) => agent.paneId === consultation.paneId)
		) {
			countedPanes.add(consultation.paneId);
			conflicts.push({
				kind: "consultation",
				identity: consultation.id,
				label: `Consultation ${consultation.id.slice(0, 8)}`,
			});
		}
	}
	for (const agent of agents) {
		// One panel line per underlying Agent: a pane counted above stays named
		// by the Consultation or ticket that owns it.
		if (countedPanes.has(agent.paneId)) continue;
		if (agent.checkoutPath === undefined || (await realPathOf(agent.checkoutPath)) !== target)
			continue;
		conflicts.push({
			kind: "herdr-agent",
			identity: agent.paneId,
			label: `Herdr Agent ${agent.agent} (${agent.paneId})`,
		});
	}
}

function uniqueConflicts(conflicts: readonly CheckoutConflict[]): CheckoutConflict[] {
	const seen = new Set<string>();
	return conflicts.filter((conflict) => {
		const key = `${conflict.kind}:${conflict.identity}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
