# The select list opens the init for a repository with no ticket

Status: accepted.

The init (ADR 0075) opens from the Ticket list: group by repository and press
`i` on the repository's Group header. A repository the factory has never seen
carries no ticket and no source, so it never stands in the list, and its header
never appears. The operator who has just pointed the factory at a new
repository has no way to start the init. This is the bootstrap gap. We decided
the main view carries an `o` key that opens the repository select list. The
list reads the operator's GitHub account and the organizations the account
belongs to, in one GraphQL read on the ambient `gh` credentials. The list is a
searchable row of the shared decision region. Enter on a row resolves the
repository's local checkout from the `repos` table or the conventional path,
runs the init's plan, and opens the same confirmation panel the `i` path
opens. The plane never clones. A repository without a local checkout is
refused with the path the act needs.

## Considered Options

- An owner/name text entry, like the consultation's repository field. Rejected:
  the read needs a live identity to stand on, and the entry would accept a
  repository the operator does not own or a typo, only to fail the plan.
- The read on each repository's host. Rejected: the ambient credentials are
  one identity. The fixed host is `github.com`, the host the ambient `gh`
  identity stands on.
- A clone step beside the refusal. Rejected: a clone is its own act, with its
  own path choice and its own confirmation. The select list keeps to the
  bootstrap: it finds the repository, and it runs the init the operator
  already confirmed the shape of.

## Consequences

- The `o` key stands in the key guide, and the guide's Ticket section and the
  Control plane section carry its rows.
- The read is capped at the first 100 repositories of the account and of each
  of the first 20 organizations, in the API's order.
- The read runs once when the panel opens. The panel carries no refresh key.
- The list's movement is the ticket lists' movement: a step per row, a page
  per window, and the edge keys to the ends, on the shared region's window.
- The ambient identity is the identity the operator gave `gh`. The plane asks
  no credential of its own.
- The refusal names the expected checkout path, so the operator can `git clone`
  to it and press Enter again.
