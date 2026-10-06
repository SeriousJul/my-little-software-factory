/**
 * The name a record line gives a Ticket (issue #295 review), and the name one
 * gives a Consultation (issue #315, ADR 0109).
 *
 * Every line the plane writes to its record names the Ticket it speaks of the
 * same way: the projection's title in quotes, or the identity when the
 * projection holds no row for it. Three surfaces read that name - the Handoff
 * dispatch's queue, start, and refusal lines, the observation cycle's walk and
 * hold lines, and the boot's line for a claim a previous run left unsettled -
 * and one Ticket has to wear one name across them, or a reader cannot follow
 * that Ticket's record from the run that started it to the boot that states how
 * the start ended. The Consultation's wait, refusal, and hold lines wear the
 * same one name as its start line, so the checkout record reads one record per
 * Consultation the way it reads one per Ticket.
 *
 * The read is the projection, never the visible list: a covered Ticket is held
 * out of the list while its own queued start still names it (ADR 0042).
 *
 * The caller hands over the projection read it already holds, the way the Next
 * step derivation does (ADR 0093), so the name always comes from rows the state
 * actually ran, and a loop that names several Tickets names them out of one
 * read instead of one read per Ticket.
 */

import type { TicketProjection } from "../state/ticket-work-cycle.ts";

/**
 * The name one Ticket wears in the plane's record: its projection title in
 * quotes, or `ticket <identity>` when the projection holds no row for it - the
 * Ticket the sources stopped listing, or the one a previous run's attempt names
 * and this run has fetched nothing about yet.
 */
export function recordTicketName(projection: TicketProjection, identity: string): string {
	const title = projection.rowFor(identity)?.title;
	return title === undefined ? `ticket ${identity}` : `"${title}"`;
}

/**
 * The name one Consultation wears in the plane's record (issue #315, ADR 0109):
 * its Consultation type in quotes beside the identity prefix every other
 * Consultation line names it by - the start line's own shape - and `consultation
 * <prefix>` when the line holds no type to name it by.
 */
export function recordConsultationName(typeName: string | null | undefined, id: string): string {
	return typeName !== undefined && typeName !== null && typeName !== ""
		? `"${typeName}" ${id.slice(0, 8)}`
		: `consultation ${id.slice(0, 8)}`;
}
