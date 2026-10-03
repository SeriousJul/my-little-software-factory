/**
 * The batch reads' shared shape (issue #202, ADR 0092).
 *
 * A projection that reads one Ticket at a time runs one statement per Ticket:
 * the observation loop pays it every cycle. A batch read runs one statement
 * over a chunk of identities instead, so the number of statements a read costs
 * follows the chunk count and not the Ticket count. The chunk stays well under
 * the parameter limit a single SQLite statement carries.
 */

/** The largest identity list one batch statement is built with. */
export const IDENTITY_CHUNK = 400;

/** The identities split into chunks a single statement can bind. */
export function identityChunks(identities: readonly string[]): readonly (readonly string[])[] {
	const chunks: (readonly string[])[] = [];
	for (let start = 0; start < identities.length; start += IDENTITY_CHUNK)
		chunks.push(identities.slice(start, start + IDENTITY_CHUNK));
	return chunks;
}

/** The `?` markers one chunk binds. */
export function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}
