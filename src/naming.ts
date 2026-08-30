/**
 * Naming for handoff artifacts: the git branch a worktree takes and the
 * herdr name an agent starts under.
 *
 * Both derive from the ticket title through one slug, so the ticket's work
 * is recognizable in git and in herdr by the same words.
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
 * The branch a worktree handoff creates: `factory/<ticket id>-<title slug>`.
 * One ticket owns one branch; a second ticket never shares the first's.
 */
export function branchNameFor(ticket: Ticket): string {
	return `factory/${ticket.id}-${titleSlug(ticket.title)}`;
}

/**
 * The herdr name an agent starts under: the title slug, shaped to herdr's
 * agent name rule `[a-z][a-z0-9_-]{0,31}`.
 *
 * A slug that starts with a digit gets a "t-" prefix (the name must start
 * with a letter), and the result is cut to 32 characters on a safe boundary
 * so the cut never leaves a trailing hyphen.
 */
export function agentNameFor(ticket: Ticket): string {
	let name = titleSlug(ticket.title);
	if (!/^[a-z]/.test(name)) {
		name = `t-${name}`;
	}
	if (name.length > 32) {
		name = name.slice(0, 32).replace(/-+$/, "");
	}
	return name;
}
