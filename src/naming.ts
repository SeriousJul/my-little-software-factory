/**
 * Naming for handoff artifacts: the git branch a worktree takes and the
 * herdr name an agent starts under.
 *
 * Both derive from the ticket title through one slug, so the ticket's work
 * is recognizable in git and in herdr by the same words. One ticket owns
 * one branch, while its agent name is stable only until a handoff needs it
 * and its own earlier agent still holds it: that handoff takes the same
 * slug with its work cycle, so the name keeps naming the ticket. The
 * candidates one handoff may ask for are built together, and no candidate
 * repeats an earlier one (see ticketAgentNames).
 */

import type { Ticket } from "./domain/ticket.ts";

/**
 * Reduce a title to a slug: lowercase, runs of non-alphanumerics collapse
 * to one hyphen, no leading or trailing hyphen.
 *
 * A title with no alphanumerics yields "ticket", so a name is never empty.
 */
export function titleSlug(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "ticket" : slug;
}

/**
 * The ticket id a factory branch carries: the source-visible external key,
 * shaped to a git-ref-safe word.
 *
 * The normalization is the branch's contract, so the branch a worktree
 * creates and the link that reads the branch back agree on it (ADR 0042).
 */
export function ticketBranchKey(externalKey: string): string {
	// A stable provider identity can contain ':' or other ref-invalid bytes.
	// The source-visible external key is safe after this narrow normalization.
	return externalKey.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

/**
 * The branch a worktree handoff creates: `factory/<ticket id>-<title slug>`.
 * One ticket owns one branch; a second ticket never shares the first's.
 */
export function branchNameFor(ticket: Ticket): string {
	return `factory/${ticketBranchKey(ticket.externalKey)}-${titleSlug(ticket.title)}`;
}

/**
 * The prefix every factory branch of one ticket carries: `factory/<ticket
 * id>-`.
 *
 * A branch match on the prefix, not the full branch name, so a title the
 * upstream source changes cannot sever the link (ADR 0042).
 */
export function ticketBranchPrefix(externalKey: string): string {
	return `factory/${ticketBranchKey(externalKey)}-`;
}

/**
 * The herdr name an agent starts under: the title slug, shaped to herdr's
 * agent name rule `[a-z][a-z0-9_-]{0,31}`.
 *
 * A slug that starts with a digit gets a "t-" prefix (the name must start
 * with a letter), and the result is cut to 32 characters on a safe boundary
 * so the cut never leaves a trailing hyphen.
 */
export function agentNameFor(title: string): string {
	return herdrAgentName(titleSlug(title), "");
}

/**
 * The herdr name of a handoff whose stable name is still held by the
 * ticket's own leftover agent: the same slug, with the work cycle the
 * handoff belongs to. The name says which cycle started the agent, and a
 * name the earlier cycle left behind can never block it.
 *
 * When two handoffs of one ticket meet that collision, the handoff's ordinal
 * in the ticket (its handoff count plus one, across every cycle) tells them
 * apart: that count only grows, so no two handoffs of one ticket share it.
 */
export function cycleAgentName(title: string, workCycle: number, ordinal?: number): string {
	const cycle = `-c${workCycle}`;
	return herdrAgentName(titleSlug(title), ordinal === undefined ? cycle : `${cycle}-${ordinal}`);
}

/**
 * The herdr agent names one handoff of a ticket asks for, in preference
 * order: the stable name, then the name of its work cycle, then that name
 * with the handoff's ordinal in the ticket.
 *
 * No candidate repeats an earlier one. The 32-character cut can rebuild the
 * stable name out of a slug whose tail already spells `-c<cycle>`, and a
 * handoff that asked herdr twice for one name would only fail twice, so the
 * repeat is dropped here instead of being left for the caller to notice.
 * Two names are always left to ask for: a cycle name and its ordinal name
 * never meet, because one ends in `-c<n>` and the other in `-c<n>-<m>`.
 */
export function ticketAgentNames(title: string, workCycle: number, ordinal: number): string[] {
	const candidates = [
		agentNameFor(title),
		cycleAgentName(title, workCycle),
		cycleAgentName(title, workCycle, ordinal),
	];
	return candidates.filter((name, index) => candidates.indexOf(name) === index);
}

/**
 * A herdr agent name from a slug and a suffix.
 *
 * The suffix always survives: the slug gives up its tail to the 32-character
 * limit first, so a cut name still says which cycle and which handoff of the
 * ticket it belongs to. The cut alone does not keep two names of one ticket
 * apart: a slug that ends in its own suffix rebuilds the name above it. The
 * candidates of one handoff are checked against each other instead (see
 * ticketAgentNames).
 */
function herdrAgentName(slug: string, suffix: string): string {
	// The maximum length of a herdr agent name: `[a-z][a-z0-9_-]{0,31}`.
	const maxLength = 32;
	const prefix = /^[a-z]/.test(slug) ? "" : "t-";
	const budget = Math.max(1, maxLength - prefix.length - suffix.length);
	// A slug that gives the whole budget to the suffix keeps one letter, so
	// the name never passes the limit.
	const base = slug.slice(0, budget).replace(/-+$/, "") || "t";
	return `${prefix}${base}${suffix}`;
}

/** The stable short identity used in Herdr names and private branches. */
export function shortStableIdentity(id: string): string {
	const clean = id.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return (clean.slice(0, 8) || "unknown").padEnd(8, "0");
}

/** A private worktree branch for a Consultation. It never contains input. */
export function consultationBranchName(id: string, typeName: string): string {
	const type =
		typeName
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "consultation";
	return `factory/consultation-${shortStableIdentity(id)}-${type}`.slice(0, 100).replace(/-+$/, "");
}

/** A short, stable Herdr Agent name for a Consultation. */
export function consultationAgentName(id: string): string {
	return `consultation-${shortStableIdentity(id)}`;
}

/**
 * The identity of the live agent that herdr lists in a pane a ticket's
 * handoff recorded, read from the names alone.
 *
 * - `own`: the live agent runs under the name the ticket's handoff expects,
 *   so it is the ticket's own agent.
 * - `foreign`: the live agent runs under any other name. Herdr hands the id
 *   of a closed pane out again, so a stale pane id can name a pane a
 *   different agent owns - a Consultation's agent among them. The live agent
 *   is not the ticket's own.
 * - `unverifiable`: either name is unknown to the reader. The live name is
 *   absent on an older herdr, and the expected name is empty when the ticket
 *   holds neither a recorded name nor a title to derive one from.
 */
export type HandoffAgentIdentity = "own" | "foreign" | "unverifiable";

/**
 * Whether the live agent in the pane a ticket's handoff recorded is the
 * ticket's own agent, by the names.
 *
 * The handoff records the name it started the agent under, and the fallback
 * is the stable name the handoff asked for first, so the expected name is
 * always a name the ticket's own agent runs under. The live agent runs under
 * the name herdr gave it at start, so the same name is its own agent, and
 * any other name is a different agent herdr placed in a reused pane id.
 */
export function identifyHandoffAgentName(
	liveName: string | undefined,
	expectedName: string,
): HandoffAgentIdentity {
	if (liveName === undefined || liveName === "") return "unverifiable";
	if (expectedName === "") return "unverifiable";
	return liveName === expectedName ? "own" : "foreign";
}
