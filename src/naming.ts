/**
 * Naming for handoff artifacts: the git branch a worktree takes and the
 * herdr name an agent starts under.
 *
 * Both derive from the ticket title through one slug, so the ticket's work
 * is recognizable in git and in herdr by the same words. One ticket owns
 * one branch, while its agent name is stable only until a handoff needs it
 * and its own earlier agent still holds it: that handoff takes the same
 * slug with its work cycle, so the name keeps naming the ticket.
 *
 * The branch and the name do not share one uniqueness rule, because they do
 * not live in one space. A branch lives inside one repository, so the ticket
 * id the branch carries (see ticketBranchKey) keeps a ticket's siblings
 * apart. herdr holds one agent name space across every repository the plane
 * watches, so the title alone is not enough there: an issue and the pull
 * request opened for it carry one title, and a security advisory and its
 * Dependabot alert carry one title. The agent name carries the ticket's own
 * identity tag beside its slug (ADR 0098, issue #216), so no two Tickets
 * ask herdr for the same name.
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

/** The two facts a Ticket's herdr Agent name is built from. */
export interface TicketNameSource {
	identity: string;
	title: string;
}

/** The maximum length of a herdr agent name: `[a-z][a-z0-9_-]{0,31}`. */
const HERDR_NAME_MAX_LENGTH = 32;

/** The identity tag's width: the leading 24 bits of the digest, in hex. */
const IDENTITY_TAG_LENGTH = 6;

/**
 * FNV-1a, 32 bit.
 *
 * The digest is a pure function of the identity string, so a name is the same
 * in every run, on every machine, and across a version change. It guards no
 * secret and needs no cryptographic strength: the tag only has to keep two
 * Tickets apart.
 */
function fnv1a32(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * The tag that keeps two Tickets apart in herdr's one agent name space.
 *
 * A truncation of the identity is no help here: every Ticket of a GitHub
 * source starts its identity with the same words, so the leading characters
 * of two identities are equal - `shortStableIdentity` answers `githubgi` for
 * every one of them. The digest reads the whole identity instead.
 */
export function ticketNameTag(identity: string): string {
	return fnv1a32(identity).toString(16).padStart(8, "0").slice(0, IDENTITY_TAG_LENGTH);
}

/**
 * The herdr name an agent starts under: the title slug with the ticket's own
 * identity tag, shaped to herdr's agent name rule `[a-z][a-z0-9_-]{0,31}`.
 *
 * A slug that starts with a digit gets a "t-" prefix (the name must start
 * with a letter), and the result is cut to 32 characters on a safe boundary
 * so the cut never leaves a trailing hyphen.
 */
export function agentNameFor(ticket: TicketNameSource): string {
	return herdrAgentName(ticket, "");
}

/**
 * The herdr name of a handoff whose stable name is still held by the
 * ticket's own leftover agent: the same slug and identity tag, with the work
 * cycle the handoff belongs to. The name says which cycle started the agent,
 * and a name the earlier cycle left behind can never block it.
 *
 * When two handoffs of one ticket meet that collision, the handoff's ordinal
 * in the ticket (its handoff count plus one, across every cycle) tells them
 * apart: that count only grows, so no two handoffs of one ticket share it.
 */
export function cycleAgentName(
	ticket: TicketNameSource,
	workCycle: number,
	ordinal?: number,
): string {
	const cycle = `-c${workCycle}`;
	return herdrAgentName(ticket, ordinal === undefined ? cycle : `${cycle}-${ordinal}`);
}

/**
 * The herdr agent names one handoff of a ticket asks for, in preference
 * order: the stable name, then the name of its work cycle, then that name
 * with the handoff's ordinal in the ticket.
 *
 * The three never meet. Every one ends in the fixed-width identity tag, and
 * what follows the tag differs in shape each time: nothing, then `-c<n>`,
 * then `-c<n>-<m>`. The cut shortens the slug in front of the tag and never
 * touches the tag, so a slug whose tail spells out a suffix - the shape that
 * let a cut rebuild the stable name before the tag existed - cannot make two
 * candidates equal.
 */
export function ticketAgentNames(
	ticket: TicketNameSource,
	workCycle: number,
	ordinal: number,
): string[] {
	return [
		agentNameFor(ticket),
		cycleAgentName(ticket, workCycle),
		cycleAgentName(ticket, workCycle, ordinal),
	];
}

/**
 * A herdr agent name from a Ticket's slug, its identity tag, and the cycle
 * suffix of one handoff.
 *
 * The tag and the cycle suffix always survive: the slug gives up its tail to
 * the 32-character limit first, so a cut name still says which ticket it
 * belongs to, and which cycle and which handoff of that ticket started it.
 */
function herdrAgentName(ticket: TicketNameSource, cycleSuffix: string): string {
	const slug = titleSlug(ticket.title);
	const suffix = `-${ticketNameTag(ticket.identity)}${cycleSuffix}`;
	const prefix = /^[a-z]/.test(slug) ? "" : "t-";
	const budget = Math.max(1, HERDR_NAME_MAX_LENGTH - prefix.length - suffix.length);
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
