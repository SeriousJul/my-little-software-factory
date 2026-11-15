/**
 * The name a record line gives a Ticket (issue #295 review), and the name one
 * gives a Consultation (issue #315, ADR 0109).
 *
 * Every line the plane writes to its record names the Ticket it speaks of the
 * same way: the row's title in quotes, or the identity when the read holds no
 * row for it. Three surfaces read that name - the Handoff dispatch's queue,
 * start, and refusal lines, the observation cycle's walk and hold lines, and
 * the boot's line for a claim a previous run left unsettled - and one Ticket
 * has to wear one name across them, or a reader cannot follow that Ticket's
 * record from the run that started it to the boot that states how the start
 * ended. The Consultation's wait, refusal, and hold lines wear the same one
 * name as its start line, so the checkout record reads one record per
 * Consultation the way it reads one per Ticket.
 *
 * The input is the Ticket's own row, or its absence, never the visible list: a
 * covered Ticket is held out of the list while its own queued start still
 * names it (ADR 0042). A surface that holds the projection names from the
 * projection's row for the identity, the way the boot's line and the checkout
 * record do (ADR 0093); a surface that acts on one identity asks the ticket
 * work cycle's scoped read for that row (ADR 0151). Both inputs stand behind
 * this one rule, so one Ticket wears one name across the record, and a line
 * never reads a name the read did not answer.
 */

/**
 * The name one Ticket wears in the plane's record: its row's title in quotes,
 * or `ticket <identity>` when the read holds no row for it - the Ticket the
 * sources stopped listing, or the one a previous run's attempt names and this
 * run has fetched nothing about yet.
 */
export function recordTicketName(
	row: { title: string } | null | undefined,
	identity: string,
): string {
	return row === null || row === undefined ? `ticket ${identity}` : `"${row.title}"`;
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
