# Priority verification

Status: the automated checks pass. The live link is not verified: the suite
runs the GitHub source against the fake runner, and it asserts the query
text and the response shapes, but it never sends a request. A refresh
against a real GitHub host is not measured by the suite. The rank pass of
the waiting routes is measured by inspection, not by a test.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a
pass, and it is not silently dropped.

See [ADR 0022](../adr/0022-the-ticket-priority-is-a-fact-of-the-ticket-identity.md)
for the rank and its one ordering rule, and
[ADR 0023](../adr/0023-a-pull-request-inherits-priority-through-the-issues-it-closes.md)
for the pull request inheritance through the issues it closes.

## What is verified automatically

Every check below runs in `bun test`.

| Requirement | Checked by | Result |
| --- | --- | --- |
| The rank chain: the Priority override beats the ticket's own label, `off` forces the ticket unranked, the best own label wins, a duplicate label takes the rank of its first occurrence, a label that is not in the list gives no rank, a missing or empty list ranks no ticket, and an override the list dropped names no rank but states its label | `test/priority.test.ts` | Passed |
| The inheritance rule: the pull request takes the highest effective rank of the issues it closes, the referenced issue's own override beats its labels, a tie at the best rank names the lowest issue number, the pull request's own override, own label, and own `off` all beat the inherited rank, and a pull request that closes only unranked issues stays unranked | `test/priority.test.ts` | Passed |
| The state layer: a live ticket, a last known ticket, and a Referenced issue fact each supply the pull request's rank, the live snapshot beats the stored fact for the same issue, a Priority override set on the referenced ticket travels through the inheritance, a refresh that changes the references changes the rank, and an orphaned fact persists harmlessly | `test/priority.test.ts` | Passed |
| The source: the search query reads `closingIssuesReferences` (the query text is asserted verbatim), a covered reference takes the live ticket's labels, the uncovered references are read directly in batches of at most 250 per request (a snapshot of 300 references is chunked), and a failed direct read never fails the source: the previous facts stay, and the outcome carries one warning line | `test/ticket-source.test.ts` | Passed |
| The one comparator: a ranked ticket comes before an unranked one, the better rank comes first, and a shared rank falls back to the newest external update, then the ticket identity | `test/priority.test.ts` | Passed |
| The ticket list comes back in the priority order, an inherited rank included | `test/priority.test.ts` | Passed |
| The open auto-handoff dispatch walks the tickets in the list's priority order, so a freed parallel slot starts the highest-ranked open ticket first | the dispatch consumes the list's order; the order itself is the row above | Measured by inspection |
| The Priority override is factory state on the ticket identity: it stores and reads back, it clears to the default, it survives a work cycle close and a reopen, and it beats every source fact in the projection | `test/priority.test.ts` | Passed |
| The detail pane: an inherited rank names the issue that supplied it (`Priority: critical (issue #12)`), the override states `set by you`, the own label states `its own label`, and `off` and the unranked ticket state plainly | `test/ticket-detail.test.ts`, `test/priority-frame.test.ts` | Passed |
| The config section: a `[priority]` labels list is read, and a missing section, a section that is not a table, an unknown key, a value that is not a list, and an empty label each warn and start with no ranking | `test/priority.test.ts` | Passed |

## What is not verified

| Requirement | How it can be measured | Result |
| --- | --- | --- |
| The waiting routes read in priority order: `ticketsByState` with a Priority label list runs the rank pass, and the rank pass reads the pull request's inherited rank from its Issue references | No test drives the rank pass with a label list. The comparator it sorts with is the tested row above, and the call site was reviewed. Add a test that holds two waiting routes of different ranks, one of them an inherited pull request rank, and asserts the pickup order | Incomplete |
| The live refresh against a real GitHub host: the real query against the real 500,000 possible-node budget (the limit that broke the nested label read in issue #65), the real closing list GitHub computes from the body, and the real direct-read answers | Run the real app against the operator's real config and watch one real pull request take the rank of one real issue it closes | Incomplete |

## Notes

- The 13 skipped tests are the frame and theme tests (the held turn through the real app flow, the ticket scroll frames, the shared presentation ink, and the theme inheritance frames). They are skipped on purpose in commit a1af1e0, under issues #103 and #104. None of them touches the priority chain, so the skips leave no gap in this record.
- The suite asserts the source's query text and the GraphQL response shapes, and it never sends a request. That is why the live link is the one link of the chain no test measures.
- Measured on 2026-09-19 on Bun 1.4.0: `bun run lint` passed, `bun run typecheck` passed, `bun test` ran 1465 tests across 66 files with 1452 pass, 13 skip, and 0 fail.
